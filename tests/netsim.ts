/*
 * Headless online session: a GameServer and ClientCore instances joined by simulated links (in-order
 * delivery with latency, jitter and stalls) in virtual time. Used by the online tests and by
 * scripts/netcheck.ts (the ride-quality report).
 */
import { LANES, laneCenter } from '../src/config';
import { clamp } from '../src/core/math';
import { mulberry32, type Rng } from '../src/core/rng';
import { ClientCore } from '../src/online/clientCore';
import { GameServer, type Conn, type Peer } from '../src/online/gameServer';
import type { OnlineRules } from '../src/online/rules';
import type { Stimulus } from '../src/online/world';
import type { PhysicsId } from '../src/sim/physics';
import type { DriveInput } from '../src/sim/vehicle';
import { Sim } from '../src/sim/world';

export interface LinkSpec {
  /** One-way base delay, ms. */
  delay: number;
  /** Extra random delay 0..jitter, ms (delivery stays in order, like TCP). */
  jitter: number;
  /** Chance per message of a stall (everything behind it waits too), and its length, ms. */
  stallChance?: number;
  stallMs?: number;
}

type Msg = Uint8Array | string;

/** One direction of a connection. */
class Pipe {
  private readonly q: { at: number; data: Msg }[] = [];
  private last = 0;
  constructor(
    private readonly spec: LinkSpec,
    private readonly rng: Rng,
  ) {}
  push(now: number, data: Msg): void {
    let at = now + this.spec.delay + this.rng() * this.spec.jitter;
    if (this.spec.stallChance && this.rng() < this.spec.stallChance) at += this.spec.stallMs ?? 250;
    at = Math.max(at, this.last);
    this.last = at;
    // Copy binary data: senders reuse their buffers.
    this.q.push({ at, data: typeof data === 'string' ? data : data.slice() });
  }
  take(now: number, out: Msg[]): void {
    while (this.q.length > 0 && this.q[0].at <= now) out.push(this.q.shift()!.data);
  }
}

export interface BotOptions {
  /** Cruise speed, km/h. */
  kmh: number;
  /** Change lanes now and then to pass traffic (otherwise follow the lane and brake behind cars). */
  weave: boolean;
  /** Drive into traffic on purpose (collision consistency). */
  reckless?: boolean;
}

/** Simple driver: keeps a lane, brakes for the car ahead, changes lanes to pass. */
export class Bot {
  readonly input: DriveInput = { steer: 0, throttle: 0, brake: 0 };
  private lane = 1;
  private changeT = 0;
  constructor(
    private readonly sim: Sim,
    private readonly opt: BotOptions,
    private readonly rng: Rng,
  ) {}

  drive(dt: number): DriveInput {
    const p = this.sim.player;
    this.changeT -= dt;
    let gap = Infinity;
    let lead = 0;
    for (const c of this.sim.traffic.cars) {
      if (!c.active || c.s <= p.s || Math.abs(c.d - laneCenter(this.lane)) > 2.4) continue;
      const g = c.s - p.s;
      if (g < gap) {
        gap = g;
        lead = c.v;
      }
    }
    if (this.opt.weave && gap < 90 && this.changeT <= 0) {
      const options = [this.lane - 1, this.lane + 1].filter((l) => l >= 0 && l < LANES);
      this.lane = options[Math.floor(this.rng() * options.length)];
      this.changeT = 2.5;
    }
    this.input.steer = clamp((laneCenter(this.lane) - p.d) * 0.22 - p.psi * 11, -1, 1);
    const want = this.opt.reckless ? this.opt.kmh / 3.6 : gap < 80 ? Math.min(this.opt.kmh / 3.6, lead + (gap - 25) * 0.3) : this.opt.kmh / 3.6;
    this.input.throttle = p.vAlong < want - 0.5 ? 1 : 0;
    this.input.brake = p.vAlong > want + 2 ? 0.7 : 0;
    return this.input;
  }
}

export interface ClientSpec {
  name: string;
  physics: PhysicsId;
  up: LinkSpec;
  down: LinkSpec;
  /** Render frames per second (inputs are sent once per frame). */
  fps: number;
  bot: BotOptions;
}

export class NetClient {
  readonly sim: Sim;
  readonly core: ClientCore;
  readonly bot: Bot;
  conn: Conn | null = null;
  /** Server events this client received, by name. */
  readonly events = new Map<string, number>();
  localCrashes = 0;
  teleports = 0;
  paused = false;
  connected = true;
  private up: Pipe;
  private down: Pipe;
  private acc = 0;
  private nextFrame = 0;
  private readonly inbox: Msg[] = [];

  constructor(
    readonly spec: ClientSpec,
    private readonly net: NetSession,
    seed: number,
  ) {
    const rng = mulberry32(seed);
    this.sim = new Sim(rng, { online: true, physics: spec.physics });
    this.up = new Pipe(spec.up, rng);
    this.down = new Pipe(spec.down, rng);
    this.core = new ClientCore(this.sim, {
      send: (d) => {
        if (this.connected) this.up.push(net.now, d);
      },
      onTeleport: () => this.teleports++,
    });
    this.bot = new Bot(this.sim, spec.bot, rng);
    this.sim.events.on('crash', () => this.localCrashes++);
    for (const name of ['nearMiss', 'laneSplit', 'runEnd', 'comboEnd'] as const) {
      this.sim.events.on(name, () => this.events.set(name, (this.events.get(name) ?? 0) + 1));
    }
    this.open();
  }

  open(token?: string): void {
    const peer: Peer = {
      send: (d) => {
        if (this.connected) this.down.push(this.net.now, d);
      },
      close: () => {
        this.connected = false;
      },
      buffered: 0,
    };
    this.connected = true;
    this.conn = this.net.server.connect(peer);
    this.core.hello(this.spec.name, this.spec.physics, token);
  }

  /** Simulate a dropped socket. */
  drop(): void {
    this.connected = false;
    this.conn?.close();
    this.conn = null;
    this.core.disconnected();
  }

  /** Advance to virtual time `now` (ms). */
  update(now: number): void {
    // Server → client.
    this.inbox.length = 0;
    this.down.take(now, this.inbox);
    for (const m of this.inbox) this.core.receive(m, now);
    // Client → server.
    this.inbox.length = 0;
    this.up.take(now, this.inbox);
    for (const m of this.inbox) this.conn?.receive(m);

    if (now < this.nextFrame || this.paused) return;
    const frameMs = 1000 / this.spec.fps;
    this.nextFrame = (this.nextFrame || now) + frameMs;
    this.acc += frameMs / 1000;
    const step = 1 / 120;
    while (this.acc >= step) {
      this.core.step(this.bot.drive(step));
      this.acc -= step;
    }
    this.core.frame(frameMs / 1000, now);
  }
}

export class NetSession {
  readonly server: GameServer;
  readonly clients: NetClient[] = [];
  readonly journal: Stimulus[] = [];
  now = 0;
  private nextTick = 0;

  constructor(seed: number, rules: Partial<OnlineRules> = {}, record = false) {
    let n = 0;
    this.server = new GameServer({ seed, rules, token: () => `t${++n}`, journal: record ? (s) => this.journal.push(s) : undefined });
  }

  add(spec: ClientSpec): NetClient {
    const c = new NetClient(spec, this, 1000 + this.clients.length * 17);
    this.clients.push(c);
    return c;
  }

  /** Run for `seconds` of virtual time in 1 ms steps. */
  run(seconds: number, each?: (now: number) => void): void {
    const end = this.now + seconds * 1000;
    const tickMs = 1000 / this.server.world.rules.tickHz;
    while (this.now < end) {
      this.now += 1;
      while (this.nextTick <= this.now) {
        this.server.tick();
        this.nextTick += tickMs;
      }
      for (const c of this.clients) c.update(this.now);
      each?.(this.now);
    }
  }
}

export const link = (delay: number, jitter = 0, stallChance = 0): LinkSpec => ({ delay, jitter, stallChance, stallMs: 250 });
