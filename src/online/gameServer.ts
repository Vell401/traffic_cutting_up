import { carId } from '../sim/cars';
import { physicsId } from '../sim/physics';
import type { SimEvents } from '../sim/events';
import {
  MSG_INPUT,
  Reader,
  Writer,
  readInputs,
  type ClientMsg,
  type InputQ,
  type PlayerInfo,
  type ServerMsg,
} from './protocol';
import { PROTOCOL_VERSION, rulesHash, type OnlineRules } from './rules';
import { OnlineWorld, type Driver, type Stimulus, type TrafficState, type WorldConfig } from './world';
import { currentTuning, validateTuning, type GlobalTuning } from '../sim/tuning';
import type { MapId } from '../sim/maps';

/** A connected socket, as the game server sees it (the Node entry point wraps `ws`). */
export interface Peer {
  send(data: Uint8Array | string): void;
  close(code: number, reason: string): void;
  /** Bytes queued in the socket and not yet sent. */
  readonly buffered: number;
  /** Client address (for the admin page and bans). */
  readonly addr?: string;
}

/** A driver as the admin page lists it. */
export interface AdminDriver {
  id: number;
  name: string;
  state: 'active' | 'away' | 'offline';
  physics: number;
  car: number;
  score: number;
  best: number;
  kmh: number;
  ghost: boolean;
  violations: number;
  queue: number;
  addr: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface ServerOptions {
  map?: MapId;
  seed: number;
  rules?: Partial<OnlineRules>;
  log?: (level: LogLevel, text: string) => void;
  journal?: (s: Stimulus) => void;
  /** Random token for reconnects. */
  token?: () => string;
  /** A driver's run ended (for the leaderboard). */
  onRun?: (dr: Driver, run: SimEvents['runEnd']) => void;
}

/** Skip snapshots to a socket with more than this queued (a slow link catches up instead of lagging further). */
const SEND_BACKLOG = 256 * 1024;
/** Drop a socket that stays this backed up. */
const SEND_LIMIT = 4 * 1024 * 1024;
/** Most messages a client may send per second (it sends ~60 input batches and a ping). */
const MSG_RATE = 400;
/** Malformed or out-of-contract messages tolerated before the socket is closed. */
const MAX_VIOLATIONS = 50;
/** A few inputs of frame/clock lead, not a fresh catch-up allowance on every message/socket. */
const INPUT_LEAD = 8;
/** A live transport (including one answering pings) must still complete hello promptly. */
const HELLO_SECONDS = 5;
/** Driver events forwarded to their client. */
const FORWARD: readonly (keyof SimEvents)[] = ['nearMiss', 'laneSplit', 'comboEnd', 'runEnd', 'crash', 'bump'];

interface Slot {
  driver: Driver;
  token: string;
  conn: Conn | null;
  /** Tick the connection was lost at (for the reconnect window). */
  offlineAt: number;
}

interface InputBudget {
  tick: number;
  wall: number;
  earned: number;
  credit: number;
}

export class Conn {
  slot: Slot | null = null;
  violations = 0;
  closed = false;
  readonly helloDeadline: number;
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    readonly peer: Peer,
    private readonly server: GameServer,
  ) {
    this.helloDeadline = server.world.tick + HELLO_SECONDS * server.world.rules.tickHz;
  }

  receive(data: Uint8Array | string): void {
    if (this.closed) return;
    const now = this.server.world.tick;
    if (!this.slot && now >= this.helloDeadline) {
      this.server.kick(this, 1008, 'hello timeout');
      return;
    }
    if (now - this.windowStart >= this.server.world.rules.tickHz) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > MSG_RATE) {
      this.server.kick(this, 1008, 'rate');
      return;
    }
    this.server.handle(this, data);
  }

  /** The socket closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.dropped(this);
  }
}

export interface ServerHealth {
  map: MapId;
  mapRevision: number;
  protocol: number;
  ringLen: number;
  tick: number;
  players: number;
  connections: number;
  traffic: number;
  stepAvgMs: number;
  stepMaxMs: number;
  snapshots: number;
  snapshotBytes: number;
  skipped: number;
  kicked: number;
  joins: number;
  drivers: { id: number; name: string; state: string; queue: number; violations: number }[];
}

/** Step time statistics over the current report window. */
interface StepStats {
  count: number;
  total: number;
  max: number;
}

/**
 * Online session host, without sockets or timers (the Node entry point owns those, tests drive it
 * directly): handshake, reconnects, input validation, the world tick, snapshot fan-out with
 * backpressure, events and housekeeping.
 */
export class GameServer {
  readonly world: OnlineWorld;
  private readonly conns = new Set<Conn>();
  private readonly slots = new Map<number, Slot>();
  private readonly log: (level: LogLevel, text: string) => void;
  private readonly token: () => string;
  private readonly writer = new Writer(8192);
  private readonly inputs: InputQ[] = [];
  /** One respawn per simulation second; retained when a driver reconnects, without retaining departed drivers. */
  private readonly respawnReady = new WeakMap<Driver, number>();
  /** Driver-scoped so reconnect/resync/respawn cannot mint more simulation time. */
  private readonly inputBudgets = new WeakMap<Driver, InputBudget>();
  private lastPlayers = '';
  /** Totals for /health and the periodic log line. */
  readonly totals = { snapshots: 0, snapshotBytes: 0, skipped: 0, kicked: 0, joins: 0 };
  readonly steps: StepStats = { count: 0, total: 0, max: 0 };
  /** Last tick phase timings, including serialization/socket work (not just physics). */
  readonly timing = { simulationMs: 0, snapshotMs: 0, housekeepingMs: 0 };
  private readonly onRun: ServerOptions['onRun'] | null;
  /** Addresses the admin turned away, until (ms since epoch). */
  readonly bans = new Map<string, number>();
  tuning: GlobalTuning = currentTuning();

  constructor(opts: ServerOptions) {
    this.world = new OnlineWorld(opts.seed, opts.rules, opts.map);
    this.world.journal = opts.journal ?? null;
    this.log = opts.log ?? (() => {});
    this.token = opts.token ?? (() => globalThis.crypto.randomUUID());
    this.onRun = opts.onRun ?? null;
    this.world.events.on('trafficMode', (e) => this.broadcast({ t: 'mode', mode: e.mode, label: e.label }));
  }

  connect(peer: Peer): Conn {
    const c = new Conn(peer, this);
    if (!this.canConnect) {
      this.kick(c, 1013, 'connections');
      return c;
    }
    this.conns.add(c);
    return c;
  }

  /** Bound sockets independently of joined slots, leaving room for pending hellos/reconnects.
   * Clamp even malformed player limits so admission can never become unbounded. */
  get connectionLimit(): number {
    const max = this.world.rules.maxPlayers;
    return 16 + 2 * (Number.isFinite(max) ? Math.max(0, Math.min(64, Math.floor(max))) : 0);
  }

  get canConnect(): boolean {
    return this.conns.size < this.connectionLimit;
  }

  get playerCount(): number {
    return this.slots.size;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  // ----------------------------------------------------------------------- messages

  handle(conn: Conn, data: Uint8Array | string): void {
    if (typeof data !== 'string') {
      const slot = conn.slot;
      if (!slot || data.byteLength < 1) return this.violation(conn, 'binary before hello');
      const r = new Reader(data);
      if (r.u8() !== MSG_INPUT) return this.violation(conn, 'unknown binary');
      const batch = readInputs(r, this.inputs);
      if (!batch) return this.violation(conn, 'bad input');
      const dr = slot.driver;
      // Retransmitted/overlapping prefixes cost no time: world.input ignores them too.
      const fresh = Math.min(batch.count, Math.max(0, batch.firstSeq + batch.count - 1 - dr.lastQueued));
      if (fresh === 0) return;
      const budget = this.inputBudget(dr);
      // The clocks are alternatives, never additive. Wall time permits bounded catch-up after a
      // server stall; server ticks also work in deterministic/headless sessions. Neither seq gaps
      // nor repeated sockets earn credit. Cap idle savings at the existing queue capacity.
      const earned = Math.max(this.world.tick - budget.tick,
        Math.floor((performance.now() - budget.wall) * this.world.rules.tickHz / 1000));
      budget.credit = Math.min(this.world.rules.inputMax, budget.credit + Math.max(0, earned - budget.earned));
      budget.earned = Math.max(budget.earned, earned);
      if (fresh > budget.credit || fresh > this.world.rules.inputMax - dr.queued) {
        return this.violation(conn, 'input pacing');
      }
      budget.credit -= fresh;
      this.world.input(dr, batch.firstSeq, this.inputs, batch.count);
      return;
    }
    if (data.length > 2048) return this.violation(conn, 'long text');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data) as ClientMsg;
    } catch {
      return this.violation(conn, 'bad json');
    }
    if (!msg || typeof msg !== 'object') return this.violation(conn, 'bad json');
    switch (msg.t) {
      case 'hello':
        this.hello(conn, msg);
        break;
      case 'respawn':
        this.respawn(conn);
        break;
      case 'ping':
        if (typeof msg.c === 'number') this.send(conn, { t: 'pong', c: msg.c, tick: this.world.tick });
        break;
      default:
        this.violation(conn, 'unknown message');
    }
  }

  private inputBudget(dr: Driver): InputBudget {
    let budget = this.inputBudgets.get(dr);
    if (!budget) {
      budget = { tick: this.world.tick, wall: performance.now(), earned: 0,
        credit: Math.min(INPUT_LEAD, this.world.rules.inputMax) };
      this.inputBudgets.set(dr, budget);
    }
    return budget;
  }

  private respawn(conn: Conn): void {
    const slot = conn.slot;
    if (conn.closed || !slot || slot.conn !== conn || slot.driver.state !== 'active') return;
    const dr = slot.driver;
    if (this.world.tick < (this.respawnReady.get(dr) ?? 0) || conn.peer.buffered > SEND_BACKLOG) return;
    // Admit before endRun/reposition: even a valid-rate control flood otherwise fans a player list
    // out to the entire server for every message. Ignored requests do not extend the cooldown.
    this.respawnReady.set(dr, this.world.tick + this.world.rules.tickHz);
    this.world.respawn(dr);
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (conn.slot) return this.violation(conn, 'second hello');
    if (msg.v !== PROTOCOL_VERSION) return this.reject(conn, 'version', 'Версия игры не совпадает с сервером — обновите страницу');
    const map = this.world.map;
    // Missing map is accepted only for the default highway fixtures. Never for Miami.
    if ((msg.map === undefined ? 'highway' : msg.map) !== map.id) return this.reject(conn, 'map', 'Карта не совпадает с сервером — выберите другой сервер');
    if (msg.rules !== rulesHash(map.id)) return this.reject(conn, 'rules', 'Правила игры на сервере другие — обновите страницу');
    const addr = conn.peer.addr;
    const until = addr ? this.bans.get(addr) : undefined;
    if (until !== undefined) {
      if (until > Date.now()) return this.reject(conn, 'banned', `Администратор закрыл вам вход до ${new Date(until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК`);
      this.bans.delete(addr!);
    }
    const physics = physicsId(msg.physics);
    const car = carId(msg.car);

    // Reconnect: the slot (car, score, best) is kept for a while after a drop.
    let slot: Slot | undefined;
    if (typeof msg.token === 'string') {
      for (const s of this.slots.values()) if (s.token === msg.token) slot = s;
    }
    // A vehicle/physics change is a new run, not a cosmetic reconnect. Otherwise selecting
    // AMG/Porsche after R34 would keep simulating the previous chassis behind the new body.
    if (slot && slot.driver.physics !== physics) {
      if (slot.conn && slot.conn !== conn) this.kick(slot.conn, 4000, 'vehicle changed');
      this.removeDriver(slot);
      slot = undefined;
    }
    if (slot) {
      if (slot.conn && slot.conn !== conn) this.kick(slot.conn, 4000, 'replaced');
      slot.conn = conn;
      conn.slot = slot;
      // The body is cosmetic: a reload may come back in another car.
      slot.driver.body = car;
      this.world.paint(slot.driver, msg.color);
      this.log('info', `reconnect #${slot.driver.id} ${slot.driver.name}`);
    } else {
      const dr = this.world.join(typeof msg.name === 'string' ? msg.name : '', physics, car, msg.color);
      if (!dr) return this.reject(conn, 'full', `Сервер заполнен (${this.world.rules.maxPlayers} игроков)`);
      slot = { driver: dr, token: this.token(), conn, offlineAt: 0 };
      this.slots.set(dr.id, slot);
      conn.slot = slot;
      this.totals.joins++;
      for (const name of FORWARD) {
        dr.events.on(name, (data) => this.driverEvent(dr, name, data as unknown as Record<string, unknown>));
      }
      this.log('info', `join #${dr.id} ${dr.name} physics ${dr.physics} car ${dr.body}`);
      this.feed(`${dr.name} на трассе`);
    }
    const dr = slot.driver;
    this.world.resync(dr, typeof msg.seq === 'number' && msg.seq >= 0 ? Math.floor(msg.seq) : 0);
    this.inputBudget(dr);
    this.send(conn, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      map: map.id,
      mapRevision: map.revision,
      rulesHash: rulesHash(map.id),
      id: dr.id,
      token: slot.token,
      rules: this.world.rules,
      tick: this.world.tick,
      ringLen: this.world.ringLen,
      players: this.playerList(),
      tuning: this.tuning,
    });
    this.pushPlayers(true);
  }

  private driverEvent(dr: Driver, name: keyof SimEvents, data: Record<string, unknown>): void {
    const slot = this.slots.get(dr.id);
    if (slot?.conn) this.send(slot.conn, { t: 'ev', name, data });
    if (name === 'runEnd') {
      const e = data as unknown as SimEvents['runEnd'];
      this.onRun?.(dr, e);
      if (e.newBest && e.score >= 5000) this.feed(`${dr.name}: новый рекорд ${e.score.toLocaleString('ru-RU')}`);
      this.pushPlayers(true);
    }
  }

  /** Finalize only permanent departures; a dropped socket can still resume the same run. */
  private removeDriver(slot: Slot): void {
    const dr = slot.driver;
    if (this.slots.get(dr.id) !== slot) return;
    // Claim the removal before callbacks, so the same driver cannot be submitted twice.
    this.slots.delete(dr.id);
    this.world.leave(dr.id);
    const score = dr.score;
    // Crash/respawn already reset their run. Do not broadcast another empty runEnd.
    if (score.score > 0 || score.runTime > 0 || score.near > 0 || score.topKmh > 0) score.endRun();
  }

  private reject(conn: Conn, reason: Extract<ServerMsg, { t: 'reject' }>['reason'], text: string): void {
    this.send(conn, { t: 'reject', reason, text });
    this.kick(conn, 4001, reason);
  }

  private violation(conn: Conn, what: string): void {
    conn.violations++;
    if (conn.slot) conn.slot.driver.violations++;
    if (conn.violations === 1 || conn.violations % 10 === 0) this.log('warn', `violation (${what}) x${conn.violations}`);
    if (conn.violations > MAX_VIOLATIONS) this.kick(conn, 1008, 'violations');
  }

  kick(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    this.totals.kicked++;
    try {
      conn.peer.close(code, reason);
    } finally {
      conn.close();
    }
  }

  /** A socket is gone. Its driver keeps the slot for the reconnect window. */
  dropped(conn: Conn): void {
    this.conns.delete(conn);
    const slot = conn.slot;
    if (!slot || slot.conn !== conn) return;
    slot.conn = null;
    slot.offlineAt = this.world.tick;
    this.log('info', `drop #${slot.driver.id} ${slot.driver.name}`);
    this.pushPlayers(true);
  }

  private send(conn: Conn, msg: ServerMsg): void {
    if (!conn.closed) conn.peer.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const c of this.conns) if (c.slot && !c.closed) c.peer.send(text);
  }

  private feed(text: string): void {
    this.broadcast({ t: 'feed', text });
  }

  private playerList(): PlayerInfo[] {
    return this.world.players((dr) => !!this.slots.get(dr.id)?.conn);
  }

  /** Player list (names, scores) to everyone when it changed; scores are refreshed once a second. */
  private pushPlayers(force: boolean): void {
    const list = this.playerList();
    const text = JSON.stringify(list);
    if (!force && text === this.lastPlayers) return;
    this.lastPlayers = text;
    this.broadcast({ t: 'players', list });
  }

  // ----------------------------------------------------------------------- ticking

  /** One world tick, a staggered share of snapshots and housekeeping (once a second). */
  tick(now: () => number = () => 0): void {
    const w = this.world;
    const t0 = now();
    w.step();
    const ms = now() - t0;
    const st = this.steps;
    st.count++;
    st.total += ms;
    if (ms > st.max) st.max = ms;

    this.timing.simulationMs = ms;
    const t1 = now();
    for (const conn of this.conns) {
      if (!conn.slot && w.tick >= conn.helloDeadline) this.kick(conn, 1008, 'hello timeout');
    }
    this.sendSnapshots();
    const t2 = now();
    if (w.tick % w.rules.tickHz === 0) this.housekeeping();
    this.timing.snapshotMs = t2 - t1;
    this.timing.housekeepingMs = now() - t2;
  }

  private sendSnapshots(): void {
    for (const slot of this.slots.values()) {
      // Still 30 snapshots/s per driver; avoid a burst of 50 serializations every fourth tick.
      if (this.world.tick % this.world.rules.snapshotEvery !== slot.driver.id % this.world.rules.snapshotEvery) continue;
      const conn = slot.conn;
      if (!conn || conn.closed) continue;
      const backlog = conn.peer.buffered;
      if (backlog > SEND_LIMIT) {
        this.log('warn', `#${slot.driver.id} send backlog ${backlog} B: disconnecting`);
        this.kick(conn, 1013, 'backlog');
        continue;
      }
      if (backlog > SEND_BACKLOG) {
        this.totals.skipped++;
        continue;
      }
      const wr = this.writer.reset();
      this.world.writeSnapshot(slot.driver, wr);
      const bytes = wr.bytes();
      this.totals.snapshots++;
      this.totals.snapshotBytes += bytes.byteLength;
      conn.peer.send(bytes);
    }
  }

  private housekeeping(): void {
    const w = this.world;
    const limit = w.rules.reconnectSeconds * w.rules.tickHz;
    for (const [id, slot] of this.slots) {
      if (slot.conn || w.tick - slot.offlineAt < limit) continue;
      this.removeDriver(slot);
      this.log('info', `leave #${id} ${slot.driver.name}`);
      this.feed(`${slot.driver.name} уехал`);
    }
    this.pushPlayers(false);
  }

  // ----------------------------------------------------------------------- admin

  /** Drivers with what the admin page needs. */
  adminDrivers(): AdminDriver[] {
    return this.world.drivers.map((dr) => {
      const slot = this.slots.get(dr.id);
      return {
        id: dr.id,
        name: dr.name,
        state: slot?.conn ? dr.state : 'offline',
        physics: dr.physics,
        car: dr.body,
        score: Math.floor(dr.score.score),
        best: dr.score.best,
        kmh: Math.round(dr.car.vAlong * 3.6),
        ghost: dr.car.ghost,
        violations: dr.violations,
        queue: dr.queued,
        addr: slot?.conn?.peer.addr ?? '',
      };
    });
  }

  trafficState(): TrafficState {
    return this.world.trafficState();
  }

  /** Traffic or the player limit, from the admin page. */
  configure(cfg: WorldConfig): void {
    this.world.configure(cfg);
  }

  setTuning(value: GlobalTuning): void {
    this.tuning = validateTuning(value);
    // New epochs fence off prediction made using the old physical parameters.
    this.world.setTuning(this.tuning);
    this.broadcast({ t: 'tuning', tuning: this.tuning });
  }

  /**
   * Take a driver off the server now (no reconnect window); with `banMinutes` their address may not
   * join again for that long. Returns the name, or null for an unknown id.
   */
  kickDriver(id: number, banMinutes = 0): string | null {
    const slot = this.slots.get(id);
    if (!slot) return null;
    const name = slot.driver.name;
    const addr = slot.conn?.peer.addr;
    if (banMinutes > 0 && addr) this.bans.set(addr, Date.now() + banMinutes * 60_000);
    if (slot.conn) this.reject(slot.conn, 'kicked', banMinutes > 0 ? `Администратор отключил вас на ${banMinutes} мин` : 'Администратор отключил вас от сервера');
    this.removeDriver(slot);
    this.log('info', `admin kick #${id} ${name}${banMinutes > 0 ? ` (ban ${banMinutes} min${addr ? ` ${addr}` : ''})` : ''}`);
    this.feed(`${name} отключён администратором`);
    this.pushPlayers(true);
    return name;
  }

  /** A message from the admin: a banner on every connected screen (in the menu too) and a feed line. */
  announce(text: string): void {
    const msg = JSON.stringify({ t: 'announce', text } satisfies ServerMsg);
    for (const c of this.conns) if (!c.closed) c.peer.send(msg);
    this.feed(`Админ: ${text}`);
  }

  /** Close every socket (shutdown). */
  closeAll(text: string): void {
    this.feed(text);
    for (const c of [...this.conns]) this.kick(c, 1012, 'restart');
  }

  /** Numbers for /health and the periodic log line; resets the step window. */
  health(resetWindow: boolean): ServerHealth {
    const st = this.steps;
    const out: ServerHealth = {
      map: this.world.map.id,
      mapRevision: this.world.map.revision,
      protocol: PROTOCOL_VERSION,
      ringLen: this.world.ringLen,
      tick: this.world.tick,
      players: this.slots.size,
      connections: this.conns.size,
      traffic: this.world.traffic.activeCount,
      stepAvgMs: st.count ? +(st.total / st.count).toFixed(3) : 0,
      stepMaxMs: +st.max.toFixed(3),
      ...this.totals,
      drivers: this.world.drivers.map((d) => ({ id: d.id, name: d.name, state: d.state, queue: d.queued, violations: d.violations })),
    };
    if (resetWindow) {
      st.count = 0;
      st.total = 0;
      st.max = 0;
    }
    return out;
  }
}
