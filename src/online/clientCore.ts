import { WALL_D, laneCenter, trafficTune } from '../config';
import { lerp, smoothstep } from '../core/math';
import { Emitter } from '../core/events';
import type { Rng } from '../core/rng';
import { Contacts, DRIVER_CRASH_SPEED, type Hit } from '../sim/contact';
import type { SimEvents } from '../sim/events';
import { carId, type CarId } from '../sim/cars';
import { createCar, type PhysicsId } from '../sim/physics';
import { Scoring } from '../sim/scoring';
import { TrafficCar } from '../sim/traffic';
import type { DriveInput, PlayerCar } from '../sim/vehicle';
import { VEHICLES } from '../sim/vehicles';
import type { RemoteDriver, Sim } from '../sim/world';
import {
  MAX_INPUT_BATCH,
  MSG_INPUT,
  MSG_SNAPSHOT,
  OWN_GHOST,
  REMOTE_BLINK_LEFT,
  REMOTE_BLINK_RIGHT,
  REMOTE_HORN,
  REMOTE_BRAKE,
  REMOTE_GHOST,
  Reader,
  Writer,
  inputFromQ,
  newSnapshot,
  quantizeInput,
  readSnapshot,
  type ClientMsg,
  type InputQ,
  type PlayerInfo,
  type ServerMsg,
  type SnapCar,
  type Snapshot,
} from './protocol';
import { PROTOCOL_VERSION, rulesHash, type OnlineRules } from './rules';

/** Input history kept for replays (8.5 s at 120 Hz). */
const HIST = 1024;
/** Corrections bigger than this are not smoothed: the car (or traffic car) is simply put there. */
const SNAP_S = 6;
const SNAP_D = 2.5;
/** Visual correction offsets decay at this rate, 1/s. */
const SMOOTH_RATE = 9;

/** Server state of one traffic car plus its prediction at the client's current step. */
interface NetCar {
  base: SnapCar;
  /** The car as predicted for the current step (contacts run against this). */
  pred: TrafficCar;
  /** Slot in sim.traffic.cars it is drawn with. */
  view: TrafficCar;
  /** Draw offset (smoothing a correction away). */
  es: number;
  ed: number;
  /** Step of the last contact with our car in the current prediction (0 = none). */
  contactSeq: number;
  seen: number;
  fresh: boolean;
}

interface NetDriver {
  id: number;
  flags: number;
  s: number;
  d: number;
  psi: number;
  vx: number;
  vy: number;
  r: number;
  steer: number;
  gear: number;
  es: number;
  ed: number;
  seen: number;
  remote: RemoteDriver;
  fresh: boolean;
  /**
   * The other car as we predict it, in our road frame: set from each snapshot, then moved along its
   * velocity step by step (replays included) and pushed by our contacts with it. Drawn from here.
   */
  pred: PlayerCar;
  /** When a contact with this driver was last shown (a long scrape is one bump). */
  contactShown: number;
}

export interface ClientStats {
  /** Round trip, ms (from pings). */
  rtt: number;
  /** Prediction horizon: steps the client runs ahead of the last confirmed one. */
  horizon: number;
  /** Server-side input queue depth of this driver. */
  queue: number;
  snapshots: number;
  /** Own car position corrections (prediction ≠ server), and the latest/largest size, m. */
  corrections: number;
  lastCorrection: number;
  maxCorrection: number;
  /** Steps replayed in total (one per pending input per snapshot). */
  replayed: number;
  bytesIn: number;
  bytesOut: number;
}

export interface ClientHooks {
  send(data: Uint8Array | string): void;
  /** The server moved our car (spawn, respawn, return): snap the camera. */
  onTeleport?(): void;
  onPlayers?(list: PlayerInfo[]): void;
  onFeed?(text: string): void;
  /** A message from the server's admin (shown big). */
  onAnnounce?(text: string): void;
  onWelcome?(msg: Extract<ServerMsg, { t: 'welcome' }>): void;
  onReject?(text: string): void;
  /** Randomness of predicted traffic contacts (a seeded one keeps headless test sessions repeatable). */
  rng?: Rng;
}

/**
 * Client side of an online session, free of DOM and sockets so tests can run it headless.
 *
 * Prediction: our car runs ahead on our own inputs at once; every input is stored. A snapshot says which
 * input the server has applied last (ack) and what the car was like after it: the car is rewound to
 * that state and the newer inputs are replayed. The physics is the same code on both sides, so without
 * surprises the replay lands exactly where the prediction was.
 *
 * Traffic is predicted the same way: each snapshot carries the cars as they were at the ack, and the
 * client moves them forward (constant acceleration, lane changes on their curve) to the step it is at,
 * so our car meets them where the server will. Contacts are re-run against that prediction on every
 * replay; a car we hit is carried on as a wreck locally until the server's snapshots catch up with it.
 *
 * Whatever still jumps (others' decisions we could not know) is drawn with a decaying offset.
 */
export class ClientCore {
  readonly stats: ClientStats = {
    rtt: 0, horizon: 0, queue: 0, snapshots: 0, corrections: 0, lastCorrection: 0, maxCorrection: 0, replayed: 0, bytesIn: 0, bytesOut: 0,
  };
  id = 0;
  token = '';
  rules: OnlineRules | null = null;
  players: PlayerInfo[] = [];
  /** First snapshot received: the car is on the road and inputs flow. */
  ready = false;
  ghost = false;
  /** Seq of the last input produced (and stepped) locally. */
  seq = 0;
  ack = 0;

  private readonly L: number;
  private readonly dt: number;
  private epoch = -1;
  private sentSeq = 0;
  private readonly hist: InputQ[] = [];
  private readonly writer = new Writer(1024);
  private readonly snap: Snapshot = newSnapshot();
  private snapIndex = 0;
  private readonly cars = new Map<number, NetCar>();
  private readonly preds: TrafficCar[] = [];
  private readonly freeViews: TrafficCar[] = [];
  private readonly drivers = new Map<number, NetDriver>();
  private readonly contacts: Contacts;
  /** Cosmetic only: pass-by whooshes for the audio. Points come from the server. */
  private readonly cosmetic: Scoring;
  private readonly cosmeticEvents = new Emitter<SimEvents>();
  private readonly inp: DriveInput = { steer: 0, throttle: 0, brake: 0, analog: false };
  /** Our own contacts already shown (car id → generation), so a long scrape is one crash. */
  private readonly hitShown = new Map<number, number>();
  private lastLocalCrash = -1e9;
  private lastLocalBump = -1e9;
  private replaying = false;
  private pingT = 0;

  constructor(
    readonly sim: Sim,
    private readonly hooks: ClientHooks,
  ) {
    this.L = sim.road.ringLen;
    this.dt = 1 / 120;
    for (let i = 0; i < HIST; i++) this.hist.push({ steer: 0, throttle: 0, brake: 0, flags: 0 });
    this.contacts = new Contacts(hooks.rng ?? Math.random);
    this.contacts.ringLen = Infinity; // our car and the predictions share one unwrapped frame
    this.cosmetic = new Scoring(this.cosmeticEvents);
    this.cosmetic.grace = 0;
    this.cosmeticEvents.on('passBy', (e) => sim.events.emit('passBy', e));
    for (const c of sim.traffic.cars) {
      c.active = false;
      this.freeViews.push(c);
    }
    sim.traffic.activeCount = 0;
  }

  hello(name: string, physics: PhysicsId, car: CarId, token?: string, color?: number): void {
    // Inputs made while offline never reach the server: the next ones follow `seq`.
    this.sentSeq = this.seq;
    this.send({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name, physics, car, seq: this.seq, token, color });
  }

  requestRespawn(): void {
    this.send({ t: 'respawn' });
  }

  private send(msg: ClientMsg): void {
    const text = JSON.stringify(msg);
    this.stats.bytesOut += text.length;
    this.hooks.send(text);
  }

  // ----------------------------------------------------------------------- incoming

  receive(data: ArrayBuffer | Uint8Array | string, now: number): void {
    if (typeof data === 'string') {
      this.stats.bytesIn += data.length;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data) as ServerMsg;
      } catch {
        return;
      }
      this.onMessage(msg, now);
      return;
    }
    this.stats.bytesIn += data.byteLength;
    const r = new Reader(data);
    if (r.u8() !== MSG_SNAPSHOT) return;
    if (!readSnapshot(r, this.snap)) return;
    this.onSnapshot(this.snap);
  }

  private onMessage(msg: ServerMsg, now: number): void {
    const ev = this.sim.events;
    switch (msg.t) {
      case 'welcome':
        if (this.id !== 0 && this.id !== msg.id) this.forget();
        this.id = msg.id;
        this.token = msg.token;
        this.rules = msg.rules;
        this.players = msg.players;
        this.hooks.onWelcome?.(msg);
        this.hooks.onPlayers?.(msg.players);
        break;
      case 'reject':
        this.hooks.onReject?.(msg.text);
        break;
      case 'players':
        this.players = msg.list;
        for (const nd of this.drivers.values()) {
          const info = msg.list.find((p) => p.id === nd.id);
          if (info) {
            nd.remote.name = info.name;
            nd.remote.color = info.color;
            nd.remote.carId = carId(info.car);
          }
        }
        this.hooks.onPlayers?.(msg.list);
        break;
      case 'feed':
        this.hooks.onFeed?.(msg.text);
        break;
      case 'announce':
        this.hooks.onAnnounce?.(msg.text);
        break;
      case 'mode':
        ev.emit('trafficMode', { mode: msg.mode, label: msg.label });
        break;
      case 'pong': {
        const rtt = now - msg.c;
        this.stats.rtt = this.stats.rtt === 0 ? rtt : this.stats.rtt * 0.8 + rtt * 0.2;
        break;
      }
      case 'ev':
        this.onEvent(msg.name, msg.data, now);
        break;
    }
  }

  /** Scoring events decided by the server. Crashes and barrier hits are shown when predicted. */
  private onEvent(name: string, data: Record<string, unknown>, now: number): void {
    const ev = this.sim.events;
    if (name === 'crash') {
      // A crash we did not see coming (the prediction missed it): show it now.
      if (now - this.lastLocalCrash > 600 + this.stats.rtt) ev.emit('crash', data as SimEvents['crash']);
      return;
    }
    if (name === 'bump') {
      const quiet = 600 + this.stats.rtt;
      if (now - this.lastLocalBump > quiet && now - this.lastLocalCrash > quiet) ev.emit('bump', data as SimEvents['bump']);
      return;
    }
    if (name === 'nearMiss' || name === 'laneSplit' || name === 'comboEnd' || name === 'runEnd') {
      ev.emit(name, data as never);
    }
  }

  /** A different session (server restarted): drop everything tied to the old one. */
  private forget(): void {
    this.ready = false;
    this.epoch = -1;
    this.seq = this.sentSeq = this.ack = 0;
    for (const nc of this.cars.values()) this.releaseView(nc);
    this.cars.clear();
    for (const nd of this.drivers.values()) this.dropRemote(nd);
    this.drivers.clear();
  }

  private onSnapshot(sn: Snapshot): void {
    if (sn.ack > this.seq) return; // from a previous session of this slot
    const st = this.stats;
    st.snapshots++;
    st.queue = sn.queue;
    this.snapIndex++;
    const sim = this.sim;

    if (sn.physics !== sim.player.physicsId) sim.setPhysics(sn.physics as PhysicsId);
    const car = sim.player;
    if (sn.stateLen !== car.stateSize) return;
    this.ghost = (sn.flags & OWN_GHOST) !== 0;
    car.ghost = this.ghost;

    // Score as the server counts it (the combo bar runs down locally between snapshots).
    const sc = sim.score;
    Object.assign(sc, sn.score);

    const teleport = sn.epoch !== this.epoch || !this.ready || this.seq - sn.ack >= HIST;
    if (teleport && this.seq - sn.ack >= HIST) this.seq = sn.ack; // too far behind to replay: start over from the server
    const oldS = car.s;
    const oldD = car.d;
    const oldPsi = car.psi;

    // Rewind our car to the confirmed state. Its s is the server's very number (laps included), so the
    // replay computes bit for bit what the server will.
    car.loadState(sn.state, 0);
    this.ack = sn.ack;
    if (teleport) sim.road.ensure(car.s - 300, car.s + 1700);

    this.updateDrivers(sn);
    this.updateCars(sn, teleport);

    // Replay what the server has not applied yet, against the traffic predicted from this snapshot.
    this.replaying = true;
    for (let k = sn.ack + 1; k <= this.seq; k++) {
      this.stepCar(this.hist[k % HIST]);
      this.advanceCars();
      this.collideCars(k);
      this.advanceDrivers();
      this.collideDrivers();
      st.replayed++;
    }
    this.replaying = false;
    st.horizon = this.seq - sn.ack;

    for (const nc of this.cars.values()) this.drawCar(nc, true);
    this.drawDrivers(true);

    const vis = sim.visual;
    if (teleport) {
      this.epoch = sn.epoch;
      this.ready = true;
      vis.ds = vis.dd = vis.dpsi = 0;
      this.hitShown.clear();
      car.prevS = car.s;
      car.prevD = car.d;
      car.prevPsi = car.psi;
      this.hooks.onTeleport?.();
      return;
    }
    const es = oldS - car.s;
    const ed = oldD - car.d;
    const err = Math.hypot(es, ed);
    if (err > 1e-4 || Math.abs(oldPsi - car.psi) > 1e-5) {
      st.corrections++;
      st.lastCorrection = err;
      st.maxCorrection = Math.max(st.maxCorrection, err);
    }
    if (Math.abs(vis.ds + es) > SNAP_S || Math.abs(vis.dd + ed) > SNAP_D) {
      vis.ds = vis.dd = vis.dpsi = 0;
    } else {
      vis.ds += es;
      vis.dd += ed;
      vis.dpsi += oldPsi - car.psi;
    }
  }

  /** Multiple of the ring length that brings s nearest to ref. */
  private unwrapShift(s: number, ref: number): number {
    return this.L * Math.round((ref - s) / this.L);
  }

  // ----------------------------------------------------------------------- traffic

  private updateCars(sn: Snapshot, teleport: boolean): void {
    const car = this.sim.player;
    for (let i = 0; i < sn.carCount; i++) {
      const b = sn.cars[i];
      let nc = this.cars.get(b.id);
      if (nc && nc.base.gen !== b.gen) {
        this.releaseView(nc);
        this.cars.delete(b.id);
        nc = undefined;
      }
      if (!nc) {
        const view = this.freeViews.pop();
        if (!view) continue;
        nc = { base: { ...b }, pred: new TrafficCar(b.id), view, es: 0, ed: 0, contactSeq: 0, seen: 0, fresh: true };
        const spec = VEHICLES[b.spec] ?? VEHICLES[0];
        view.active = true;
        view.gen++;
        view.spec = spec;
        view.colorIdx = b.colorIdx;
        view.color = spec.colors[b.colorIdx] ?? spec.colors[0];
        view.color2Idx = b.color2Idx;
        view.color2 = b.color2Idx >= 0 ? (spec.cargoColors[b.color2Idx] ?? 0xd9dde2) : 0x0d1015;
        nc.pred.spec = spec;
        this.cars.set(b.id, nc);
        this.sim.traffic.activeCount++;
      } else {
        Object.assign(nc.base, b);
      }
      nc.seen = this.snapIndex;
    }
    for (const [id, nc] of this.cars) {
      if (nc.seen === this.snapIndex) continue;
      this.releaseView(nc);
      this.cars.delete(id);
    }
    // Every prediction restarts from the server's state at the ack.
    this.preds.length = 0;
    for (const nc of this.cars.values()) {
      const p = nc.pred;
      const b = nc.base;
      p.active = true;
      p.s = p.prevS = b.s + this.unwrapShift(b.s, car.s);
      p.d = p.prevD = b.d;
      p.v = b.v;
      p.acc = b.acc;
      p.yaw = p.prevYaw = b.yaw;
      p.yawRate = b.yawRate;
      p.vd = b.vd;
      p.laneT = b.laneT;
      p.targetLane = b.targetLane;
      p.laneFromD = b.laneFromD;
      p.laneOff = b.laneOff;
      p.blink = b.blink;
      p.braking = b.braking;
      p.crashed = b.crashed;
      p.crashT = 0;
      p.hit = false;
      nc.contactSeq = 0;
      if (teleport) nc.fresh = true;
      this.preds.push(p);
    }
  }

  private releaseView(nc: NetCar): void {
    nc.view.active = false;
    this.freeViews.push(nc.view);
    this.sim.traffic.activeCount--;
  }

  /** One step of the predicted traffic: constant acceleration, lane changes along their curve, wrecks slide. */
  private advanceCars(): void {
    const dt = this.dt;
    const traffic = this.sim.traffic;
    for (const c of this.preds) {
      c.prevS = c.s;
      c.prevD = c.d;
      c.prevYaw = c.yaw;
      if (c.crashed) {
        traffic.stepCrashed(c, dt);
        continue;
      }
      if (c.laneT >= 0) {
        c.laneT += dt / trafficTune.laneChangeTime;
        const toD = laneCenter(c.targetLane) + c.laneOff;
        if (c.laneT >= 1) {
          c.laneT = -1;
          c.d = toD;
          c.blink = 0;
        } else {
          c.d = lerp(c.laneFromD, toD, smoothstep(c.laneT));
        }
      }
      c.v = Math.max(0, c.v + c.acc * dt);
      c.s += c.v * dt;
      c.yaw = Math.atan2((c.d - c.prevD) / dt, Math.max(c.v, 1));
    }
  }

  private seqNow = 0;
  private readonly onContact = (h: Hit): void => {
    const nc = this.cars.get(h.car.id);
    if (nc) nc.contactSeq = this.seqNow;
    if (this.replaying) return;
    const shown = this.hitShown.get(h.car.id);
    if (nc && shown === nc.base.gen) return;
    if (nc) this.hitShown.set(h.car.id, nc.base.gen);
    this.lastLocalCrash = performance.now();
    this.sim.events.emit('crash', { speed: h.speed });
  };

  private collideCars(seq: number): void {
    if (this.ghost) return;
    this.seqNow = seq;
    this.contacts.collide(this.sim.player, this.preds, this.onContact, true);
  }

  /** Copy a prediction (plus its decaying correction offset) into the drawn car. */
  private drawCar(nc: NetCar, afterSnapshot: boolean): void {
    const p = nc.pred;
    const v = nc.view;
    if (afterSnapshot && !nc.fresh) {
      // The drawn car keeps its place; the jump to the new prediction is smoothed away.
      nc.es = v.s - p.s;
      nc.ed = v.d - p.d;
      if (Math.abs(nc.es) > SNAP_S || Math.abs(nc.ed) > SNAP_D) nc.es = nc.ed = 0;
      return;
    }
    v.prevS = nc.fresh ? p.s + nc.es : v.s;
    v.prevD = nc.fresh ? p.d + nc.ed : v.d;
    v.prevYaw = nc.fresh ? p.yaw : v.yaw;
    v.s = p.s + nc.es;
    v.d = p.d + nc.ed;
    v.yaw = p.yaw;
    v.v = p.v;
    v.braking = p.braking || p.acc < -1.2;
    v.blink = p.blink;
    v.crashed = p.crashed;
    v.lane = p.targetLane;
    nc.fresh = false;
  }

  // ----------------------------------------------------------------------- other drivers

  private updateDrivers(sn: Snapshot): void {
    const remotes = this.sim.remotes;
    for (let i = 0; i < sn.driverCount; i++) {
      const b = sn.drivers[i];
      let nd = this.drivers.get(b.id);
      if (!nd) {
        const info = this.players.find((p) => p.id === b.id);
        const remote: RemoteDriver = {
          id: b.id,
          name: info?.name ?? `#${b.id}`,
          color: info?.color ?? 0x888888,
          carId: carId(info?.car),
          car: createCar(info?.physics ?? 1),
          visible: true,
        };
        remotes.push(remote);
        nd = { ...b, es: 0, ed: 0, seen: 0, remote, fresh: true, pred: createCar(info?.physics ?? 1), contactShown: -1e9 };
        this.drivers.set(b.id, nd);
      } else {
        nd.flags = b.flags;
        nd.s = b.s;
        nd.d = b.d;
        nd.psi = b.psi;
        nd.vx = b.vx;
        nd.vy = b.vy;
        nd.r = b.r;
        nd.steer = b.steer;
        nd.gear = b.gear;
      }
      nd.seen = this.snapIndex;
      this.applyInfo(nd);
      // Prediction restarts from the server's state (same tick as our rewound car).
      const p = nd.pred;
      p.s = p.prevS = nd.s + this.unwrapShift(nd.s, this.sim.player.s);
      p.d = p.prevD = nd.d;
      p.psi = p.prevPsi = nd.psi;
      p.vx = nd.vx;
      p.vy = nd.vy;
      p.r = nd.r;
      p.ghost = (nd.flags & REMOTE_GHOST) !== 0;
    }
    for (const [id, nd] of this.drivers) {
      if (nd.seen === this.snapIndex) continue;
      this.dropRemote(nd);
      this.drivers.delete(id);
    }
  }

  /** Name, paint, body and physics from the player list (it may arrive after the first snapshot). */
  private applyInfo(nd: NetDriver): void {
    const info = this.players.find((p) => p.id === nd.id);
    if (!info) return;
    const r = nd.remote;
    r.name = info.name;
    r.color = info.color;
    r.carId = carId(info.car);
    if (r.car.physicsId !== info.physics) {
      r.car = createCar(info.physics);
      nd.pred = createCar(info.physics);
    }
  }

  /** One step of the other drivers as predicted: along their velocity, heading turning at half rate. */
  private advanceDrivers(): void {
    const dt = this.dt;
    const lim = WALL_D - 1;
    for (const nd of this.drivers.values()) {
      const p = nd.pred;
      const vA = p.vAlong;
      const vL = p.vLat;
      p.s += vA * dt;
      p.d = Math.max(-lim, Math.min(lim, p.d + vL * dt));
      p.psi += p.r * dt * 0.5;
    }
  }

  /** Our car against the others as predicted (the server does the same with the real ones). */
  private collideDrivers(): void {
    if (this.ghost) return;
    const me = this.sim.player;
    for (const nd of this.drivers.values()) {
      if (nd.pred.ghost) continue;
      const speed = this.contacts.collidePair(me, nd.pred);
      if (speed < 0 || this.replaying) continue;
      const now = performance.now();
      const quiet = now - nd.contactShown > 500;
      nd.contactShown = now;
      if (!quiet) continue;
      if (speed >= DRIVER_CRASH_SPEED) {
        this.lastLocalCrash = now;
        this.sim.events.emit('crash', { speed });
      } else {
        this.lastLocalBump = now;
        this.sim.events.emit('bump', { speed });
      }
    }
  }

  private dropRemote(nd: NetDriver): void {
    const i = this.sim.remotes.indexOf(nd.remote);
    if (i >= 0) this.sim.remotes.splice(i, 1);
  }

  /** Others are drawn where we predict them at our step (see NetDriver.pred). */
  private drawDrivers(afterSnapshot: boolean): void {
    for (const nd of this.drivers.values()) {
      const c = nd.remote.car;
      const p = nd.pred;
      const s = p.s;
      const d = p.d;
      const psi = p.psi;
      if (afterSnapshot && !nd.fresh) {
        nd.es = c.s - s;
        nd.ed = c.d - d;
        if (Math.abs(nd.es) > SNAP_S * 2 || Math.abs(nd.ed) > SNAP_D) nd.es = nd.ed = 0;
      }
      c.prevS = nd.fresh ? s : c.s;
      c.prevD = nd.fresh ? d : c.d;
      c.prevPsi = nd.fresh ? psi : c.psi;
      c.s = s + nd.es;
      c.d = d + nd.ed;
      c.psi = psi;
      c.vx = nd.vx;
      c.vy = nd.vy;
      c.r = nd.r;
      c.steerIn = nd.steer;
      c.brake = (nd.flags & REMOTE_BRAKE) !== 0 ? 1 : 0;
      c.gear = nd.gear || 1;
      c.ghost = (nd.flags & REMOTE_GHOST) !== 0;
      c.blinker = nd.flags & REMOTE_BLINK_LEFT ? 1 : nd.flags & REMOTE_BLINK_RIGHT ? 2 : 0;
      c.horn = (nd.flags & REMOTE_HORN) !== 0;
      c.wheelSpin += (nd.vx / 0.34) * this.dt;
      nd.remote.visible = true;
      nd.fresh = false;
    }
  }

  // ----------------------------------------------------------------------- stepping

  private stepCar(q: InputQ): void {
    const car = this.sim.player;
    inputFromQ(q, this.inp);
    car.step(this.dt, this.inp, this.sim.road.curvature(car.s));
  }

  /** One 120 Hz step of our car on a new input (call at the fixed rate while ready). */
  step(input: DriveInput): void {
    if (!this.ready) return;
    const sim = this.sim;
    const car = sim.player;
    this.seq++;
    const q = this.hist[this.seq % HIST];
    quantizeInput(input, q);
    sim.road.ensure(car.s - 300, car.s + 1700);
    this.stepCar(q);
    if (car.wallHit) sim.events.emit('wallHit', { speed: car.wallImpact });
    this.advanceCars();
    this.collideCars(this.seq);
    this.advanceDrivers();
    this.collideDrivers();
    for (const nc of this.cars.values()) this.drawCar(nc, false);
    this.drawDrivers(false);
    this.cosmetic.step(this.dt, car, sim.traffic);
    sim.time += this.dt;
    const sc = sim.score;
    if (sc.combo > 0) sc.comboT = Math.max(0, sc.comboT - this.dt);
    this.stats.horizon = this.seq - this.ack;
  }

  /** Per rendered frame: decay the correction offsets, send the inputs of this frame, ping now and then. */
  frame(dt: number, now: number): void {
    const k = Math.exp(-SMOOTH_RATE * dt);
    const vis = this.sim.visual;
    vis.ds *= k;
    vis.dd *= k;
    vis.dpsi *= k;
    for (const nc of this.cars.values()) {
      nc.es *= k;
      nc.ed *= k;
    }
    for (const nd of this.drivers.values()) {
      nd.es *= k;
      nd.ed *= k;
    }
    this.flush();
    if (now - this.pingT > 1000) {
      this.pingT = now;
      this.send({ t: 'ping', c: now });
    }
  }

  /** Send the inputs produced since the last call. */
  flush(): void {
    if (!this.ready) return;
    if (this.sentSeq < this.ack) this.sentSeq = this.ack;
    if (this.seq - this.sentSeq > HIST - 1) this.sentSeq = this.seq - (HIST - 1);
    while (this.sentSeq < this.seq) {
      const first = this.sentSeq + 1;
      const count = Math.min(MAX_INPUT_BATCH, this.seq - this.sentSeq);
      const w = this.writer.reset();
      w.u8(MSG_INPUT);
      w.u32(first);
      w.u8(count);
      for (let i = 0; i < count; i++) {
        const q = this.hist[(first + i) % HIST];
        w.i16(q.steer);
        w.u8(q.throttle);
        w.u8(q.brake);
        w.u16(q.flags);
      }
      const bytes = w.bytes();
      this.stats.bytesOut += bytes.byteLength;
      this.hooks.send(bytes);
      this.sentSeq += count;
    }
  }

  /** The connection dropped: inputs made while offline will never reach the server. */
  disconnected(): void {
    this.sentSeq = this.seq;
  }

  /** Remote drivers' info for the HUD (name tags). */
  get remoteCount(): number {
    return this.drivers.size;
  }
}

