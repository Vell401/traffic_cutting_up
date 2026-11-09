import { LANES, LANE_W, laneCenter } from '../config';
import { Emitter } from '../core/events';
import { mulberry32, type Rng } from '../core/rng';
import { Contacts, DRIVER_CRASH_SPEED, type Hit } from '../sim/contact';
import { Director, type TrafficMode, type TrafficPreset } from '../sim/director';
import type { SimEvents } from '../sim/events';
import type { CarId } from '../sim/cars';
import { createCar, physicsId, type PhysicsId } from '../sim/physics';
import { getMap, isSpawnProtected, type MapDefinition, type MapId } from '../sim/maps';
import { Road } from '../sim/road';
import { Scoring } from '../sim/scoring';
import { AHEAD as TRAFFIC_AHEAD, BEHIND as TRAFFIC_BEHIND, MAX_PER_KM, MAX_TRAFFIC, Traffic, type TrafficCar } from '../sim/traffic';
import type { DriveInput, PlayerCar } from '../sim/vehicle';
import { VEHICLES } from '../sim/vehicles';
import {
  OWN_AWAY,
  OWN_GHOST,
  REMOTE_BRAKE,
  REMOTE_BLINK_LEFT,
  REMOTE_BLINK_RIGHT,
  REMOTE_HORN,
  REMOTE_GHOST,
  inputFromQ,
  writeCar,
  writeDriver,
  writeSnapshotHead,
  type InputQ,
  type PlayerInfo,
  type SnapshotOwn,
  type Writer,
} from './protocol';
import { DEFAULT_RULES, type OnlineRules } from './rules';
import { applyTuning, defaultTuning, validateTuning, type GlobalTuning } from '../sim/tuning';
import { createTyreFeedback, sampleTyreFeedback } from '../presentation/tyres';

/** Paint per driver slot. */
export const DRIVER_COLORS = [0x1f4fd8, 0xd8321f, 0x16a35a, 0xe0a812, 0x9b30d9, 0x14b8c4, 0xd9d9de, 0xff6a13];
/** Traffic modes follow time online: the director is advanced as if driving at this speed, m/s. */
const MODE_SPEED = 25;
const SPEC_INDEX = new Map(VEHICLES.map((v, i) => [v, i]));
const MAX_NAME = 16;

/**
 * Everything from outside that changes the world, stamped with the tick before which it was applied.
 * With the seed and the rules version this journal replays a session exactly.
 */
/** Settings the admin page changes while the session runs. */
export interface WorldConfig {
  /** Traffic on the ring at all (off clears it). */
  trafficOn?: boolean;
  /** Density variant: 1 normal, 2 dense. */
  traffic?: TrafficPreset;
  /** Difficulty 0..1 (density, rude drivers, harder modes). */
  intensity?: number;
  /** Hold one traffic mode, or 'auto' to let them change every kilometre or so. */
  mode?: TrafficMode | 'auto';
  /** Spawn density of modes as a factor of the base (normal = 1). */
  modeDensity?: Partial<Record<TrafficMode, number>>;
  /** Absolute targets, persisted without hidden density/difficulty multipliers. */
  densities?: Partial<Record<TrafficMode, number>>;
  /** One mode's absolute target in cars per km of lane (the admin page edits this). */
  modePerKm?: { mode: TrafficMode; perKm: number };
  maxPlayers?: number;
}

/** A traffic mode's spawn density as the admin page shows it. */
export interface ModeDensity {
  mode: TrafficMode;
  /** Cars per km of lane at the current preset and difficulty. */
  perKm: number;
  /** Factor of the base density. */
  scale: number;
}

/** Traffic as the admin page shows it. */
export interface TrafficState {
  on: boolean;
  preset: TrafficPreset;
  intensity: number;
  mode: TrafficMode;
  /** The mode is held by the admin (else it changes by itself). */
  held: boolean;
  cars: number;
  densities: ModeDensity[];
  /** Road around each driver kept topped up with traffic, km, and its lanes. */
  windowKm: number;
  lanes: number;
  maxPerKm: number;
  capacity: number;
}

export const TRAFFIC_MODES: readonly TrafficMode[] = ['normal', 'sparse', 'dense', 'trucks', 'walls', 'platoons'];

export type Stimulus =
  | { k: 'tuning'; t: number; value: GlobalTuning }
  | { k: 'join'; t: number; id: number; name: string; physics: PhysicsId; car?: CarId; color?: number }
  | { k: 'paint'; t: number; id: number; color: number }
  | { k: 'config'; t: number; cfg: WorldConfig }
  | { k: 'leave'; t: number; id: number }
  | { k: 'in'; t: number; id: number; seq: number; q: number[] }
  | { k: 'respawn'; t: number; id: number }
  | { k: 'resync'; t: number; id: number; seq: number };

export function cleanName(name: unknown, id: number): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME) : '';
  return s || `Driver ${id}`;
}

/** One driver on the server: the car, its own scoring and the queue of inputs waiting to be applied. */
export class Driver {
  readonly events = new Emitter<SimEvents>();
  readonly score: Scoring;
  readonly car: PlayerCar;
  /** Body model the others see (cosmetic, never simulated). */
  body: CarId = 1;
  state: 'active' | 'away' = 'away';
  /** Bumped whenever the server moves the car on its own (spawn, respawn, return): the client takes the state as is. */
  epoch = 0;
  /** Seq of the last input queued / applied (the ack sent back). */
  lastQueued = 0;
  ack = 0;
  /** Ticks in a row without an input to apply. */
  starve = 0;
  ghostT = 0;
  /** Inputs dropped for running too far ahead, malformed messages and the like. */
  violations = 0;
  /** Inputs applied in the current tick (0 while starving, 2 while catching up). */
  stepped = 0;
  /** Traffic cars this driver has hit (id → generation): hitting someone else's wreck still ends our run. */
  readonly hits = new Map<number, number>();
  /** Last applied input (others see the steering and brake lights). */
  readonly input: DriveInput = { steer: 0, throttle: 0, brake: 0, analog: false };

  private readonly qSteer: Int16Array;
  private readonly qThr: Uint8Array;
  private readonly qBrk: Uint8Array;
  private readonly qFlags: Uint16Array;
  private readonly qSeq: Uint32Array;
  private head = 0;
  private size = 0;

  constructor(
    readonly id: number,
    readonly name: string,
    readonly physics: PhysicsId,
    public color: number,
    /** Spawn place this driver owns (joins and respawns there). */
    readonly slot: number,
    capacity: number,
    ringLen: number,
  ) {
    this.car = createCar(physics);
    this.score = new Scoring(this.events);
    this.score.ringLen = ringLen;
    this.qSteer = new Int16Array(capacity);
    this.qThr = new Uint8Array(capacity);
    this.qBrk = new Uint8Array(capacity);
    this.qFlags = new Uint16Array(capacity);
    this.qSeq = new Uint32Array(capacity);
  }

  get queued(): number {
    return this.size;
  }

  push(seq: number, q: InputQ): void {
    const cap = this.qSeq.length;
    if (this.size === cap) {
      // Running ahead of real time (or the server stalled): the oldest input is skipped.
      this.head = (this.head + 1) % cap;
      this.size--;
      this.violations++;
    }
    const i = (this.head + this.size) % cap;
    this.qSteer[i] = q.steer;
    this.qThr[i] = q.throttle;
    this.qBrk[i] = q.brake;
    this.qFlags[i] = q.flags;
    this.qSeq[i] = seq;
    this.size++;
  }

  /** Take the oldest queued input into `input`; returns its seq. */
  pop(): number {
    const i = this.head;
    this.head = (this.head + 1) % this.qSeq.length;
    this.size--;
    inputFromQ({ steer: this.qSteer[i], throttle: this.qThr[i], brake: this.qBrk[i], flags: this.qFlags[i] }, this.input);
    return this.qSeq[i];
  }

  clearQueue(): void {
    this.head = 0;
    this.size = 0;
  }
}

/**
 * The authoritative online world: the ring, the shared traffic and every driver's car. Pure and
 * deterministic: the same seed and the same stimuli at the same ticks give the same session.
 *
 * Time contract: one step() is one 120 Hz tick. Each driver's inputs are numbered by the client (seq)
 * and applied strictly in order, one per tick. With none queued the car waits (the next ones are on
 * their way); with more than `inputHigh` queued it applies two per tick to catch up. So a driver's car
 * sees every input exactly once, and the client can predict it exactly.
 */
/** 12 km × 4 lanes × 80 cars/km, with margin; allocated only as higher densities are requested. */
const RING_TRAFFIC = 4096;
/** Ticks two drivers must stay apart before their next contact counts again (0.5 s). */
const PAIR_QUIET = 60;

export class OnlineWorld {
  private readonly remoteTyres = createTyreFeedback();
  private readonly remoteWheelOmega = new Float64Array(4);
  readonly map: MapDefinition;
  // Drivers' s is never wrapped: a car's s counts the laps, so the client holds the very same number
  // (bit-exact prediction) and draws a continuous road. Traffic lives in [0, ringLen); every
  // comparison between the two goes through the ring-aware rel().
  readonly rules: OnlineRules;
  readonly road: Road;
  readonly traffic: Traffic;
  readonly director: Director;
  /** World-wide events (traffic mode changes). */
  readonly events = new Emitter<SimEvents>();
  readonly drivers: Driver[] = [];
  readonly ringLen: number;
  tick = 0;
  /** Receives every stimulus (session journal), or null. */
  journal: ((s: Stimulus) => void) | null = null;

  private readonly rng: Rng;
  private readonly contacts: Contacts;
  private readonly cars: PlayerCar[] = [];
  /** Last tick each pair of drivers (a.id·256 + b.id) touched. */
  private readonly pairContact = new Map<number, number>();
  private readonly awayTicks: number;
  private readonly stateBuf = new Float64Array(64);
  private readonly picks: TrafficCar[] = [];
  private nextId = 1;
  private modeHeld = false;

  constructor(
    readonly seed: number,
    rules: Partial<OnlineRules> = {},
    mapId: MapId = 'highway',
  ) {
    this.map = getMap(mapId);
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.rng = mulberry32(seed);
    this.road = new Road(this.rng, this.map.script);
    this.ringLen = this.road.ringLen;
    this.road.ensure(-200, this.ringLen + 200);
    this.director = new Director(this.rng, this.events);
    this.director.preset = this.rules.traffic;
    this.director.fixedIntensity = this.rules.intensity;
    this.director.resetRun();
    // Room for every driver's window, but never more than the whole ring holds.
    this.traffic = new Traffic(this.rng, this.director, Math.min(this.rules.maxPlayers * MAX_TRAFFIC, 480));
    this.traffic.ringLen = this.ringLen;
    this.contacts = new Contacts(this.rng);
    this.contacts.ringLen = this.ringLen;
    this.awayTicks = Math.round(this.rules.awaySeconds * this.rules.tickHz);
  }

  byId(id: number): Driver | undefined {
    return this.drivers.find((d) => d.id === id);
  }

  /** Add a driver; null when the server is full. */
  join(name: string, physics: PhysicsId, car: CarId = 1, color?: number): Driver | null {
    if (this.drivers.length >= this.rules.maxPlayers) return null;
    let id = this.nextId;
    while (this.byId(id)) id = (id % 250) + 1;
    this.nextId = (id % 250) + 1;
    const clean = cleanName(name, id);
    const paint = Number.isInteger(color) && color! >= 0 && color! <= 0xffffff ? color! : DRIVER_COLORS[(id - 1) % DRIVER_COLORS.length];
    this.journal?.({ k: 'join', t: this.tick, id, name: clean, physics, car, color: paint });
    let slot = 0;
    while (this.drivers.some((d) => d.slot === slot)) slot++;
    const dr = new Driver(id, clean, physicsId(physics), paint, slot, this.rules.inputMax, this.ringLen);
    let at = 0;
    while (at < this.drivers.length && this.drivers[at].id < id) at++;
    dr.body = car;
    this.drivers.splice(at, 0, dr);
    this.place(dr, 'join');
    return dr;
  }

  leave(id: number): void {
    const i = this.drivers.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.journal?.({ k: 'leave', t: this.tick, id });
    this.drivers.splice(i, 1);
    for (const key of this.pairContact.keys()) if (key >> 8 === id || (key & 255) === id) this.pairContact.delete(key);
  }

  paint(dr: Driver, color: number | undefined): void {
    if (!Number.isInteger(color) || color! < 0 || color! > 0xffffff || dr.color === color) return;
    dr.color = color!;
    this.journal?.({ k: 'paint', t: this.tick, id: dr.id, color: color! });
  }

  /** Queue inputs [firstSeq, firstSeq + count). Old or repeated seqs are ignored; a gap is skipped over. */
  input(dr: Driver, firstSeq: number, qs: readonly InputQ[], count: number): void {
    if (this.journal) {
      const q: number[] = [];
      for (let i = 0; i < count; i++) q.push(qs[i].steer, qs[i].throttle, qs[i].brake, qs[i].flags);
      this.journal({ k: 'in', t: this.tick, id: dr.id, seq: firstSeq, q });
    }
    for (let i = 0; i < count; i++) {
      const seq = firstSeq + i;
      if (seq <= dr.lastQueued) continue;
      dr.lastQueued = seq;
      dr.push(seq, qs[i]);
    }
  }

  /**
   * A client (re)attached to this driver and numbers its inputs from `seq` on: drop what is queued,
   * count `seq` as applied, and have the client take the car's state as is (epoch).
   */
  resync(dr: Driver, seq: number, record = true): void {
    if (record) this.journal?.({ k: 'resync', t: this.tick, id: dr.id, seq });
    dr.clearQueue();
    dr.lastQueued = seq;
    dr.ack = seq;
    dr.epoch++;
  }

  /** R: back to the driver's spawn place; the run is over. */
  /**
   * Change traffic or the player limit while the session runs. Journalled like any other stimulus,
   * so a replay makes the same change on the same tick. Invalid values are ignored.
   */
  configure(cfg: WorldConfig): void {
    this.journal?.({ k: 'config', t: this.tick, cfg });
    const r = this.rules;
    if (cfg.maxPlayers !== undefined && Number.isInteger(cfg.maxPlayers) && cfg.maxPlayers >= 1 && cfg.maxPlayers <= 64) {
      r.maxPlayers = cfg.maxPlayers;
    }
    if (cfg.traffic === 1 || cfg.traffic === 2) this.director.preset = r.traffic = cfg.traffic;
    if (typeof cfg.intensity === 'number' && cfg.intensity >= 0 && cfg.intensity <= 1) {
      r.intensity = cfg.intensity;
      this.director.fixedIntensity = this.director.intensity = cfg.intensity;
    }
    const d = this.director;
    if (cfg.modeDensity) {
      for (const m of TRAFFIC_MODES) {
        const v = cfg.modeDensity[m];
        if (typeof v === 'number' && v >= 0 && v <= 6) d.modeDensity[m] = v;
      }
    }
    if (cfg.densities) {
      for (const m of TRAFFIC_MODES) {
        const v = cfg.densities[m];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PER_KM) d.modePerKm[m] = v;
      }
    }
    if (cfg.modePerKm && TRAFFIC_MODES.includes(cfg.modePerKm.mode) && Number.isFinite(cfg.modePerKm.perKm) && cfg.modePerKm.perKm >= 0 && cfg.modePerKm.perKm <= MAX_PER_KM) {
      const m = cfg.modePerKm.mode;
      d.modePerKm[m] = cfg.modePerKm.perKm;
    }
    if (cfg.mode === 'auto') {
      this.modeHeld = false;
      this.director.setMode(this.director.mode);
    } else if (cfg.mode && TRAFFIC_MODES.includes(cfg.mode)) {
      this.modeHeld = true;
      this.director.setMode(cfg.mode, Infinity);
    }
    if (cfg.trafficOn === false && this.traffic.enabled) {
      this.traffic.enabled = false;
      this.traffic.clearAround(0, Infinity);
    } else if (cfg.trafficOn === true) {
      this.traffic.enabled = true;
    }
    const peakDensity = Math.max(...TRAFFIC_MODES.map(m => d.densityOf(m)));
    const ringCapacity = Math.ceil(peakDensity * LANES * this.ringLen / 1000) + 64;
    this.traffic.reserve(Math.min(r.maxPlayers * MAX_TRAFFIC, RING_TRAFFIC, Math.max(480, ringCapacity)));
  }

  trafficState(): TrafficState {
    const d = this.director;
    return {
      on: this.traffic.enabled,
      preset: d.preset,
      intensity: d.fixedIntensity ?? d.intensity,
      mode: d.mode,
      held: this.modeHeld,
      cars: this.traffic.activeCount,
      densities: TRAFFIC_MODES.map((mode) => ({ mode, perKm: d.densityOf(mode), scale: d.modeDensity[mode] })),
      windowKm: (TRAFFIC_BEHIND + TRAFFIC_AHEAD) / 1000,
      lanes: LANES,
      maxPerKm: MAX_PER_KM,
      capacity: this.traffic.cars.length,
    };
  }

  setTuning(value: GlobalTuning): void {
    const tuning = validateTuning(value);
    this.journal?.({ k: 'tuning', t: this.tick, value: tuning });
    applyTuning(tuning);
    for (const dr of this.drivers) this.resync(dr, dr.lastQueued, false);
    const speed = tuning.traffic;
    for (const c of this.traffic.cars) {
      if (!c.active || c.crashed) continue;
      const unit = (((c.formation || c.id) * 2654435761) >>> 0) / 0xffffffff;
      if (c.wall) { c.v0 = (speed.wallMin + (speed.wallMax - speed.wallMin) * unit) / 3.6; continue; }
      const range = speed.lanes[c.lane];
      c.v0 = (range[0] + (range[1] - range[0]) * unit) / 3.6;
      if (c.spec.truck) c.v0 = Math.min(c.v0, (speed.truckMin + (speed.truckMax - speed.truckMin) * unit) / 3.6);
    }
  }

  respawn(dr: Driver): void {
    this.journal?.({ k: 'respawn', t: this.tick, id: dr.id });
    if (dr.state !== 'active') return;
    dr.score.endRun();
    this.place(dr, 'respawn');
  }

  step(): void {
    const dt = 1 / this.rules.tickHz;
    for (const dr of this.drivers) {
      dr.stepped = 0;
      if (dr.state === 'away') {
        if (dr.queued === 0) continue;
        this.place(dr, 'return');
      }
      const n = dr.queued;
      if (n === 0) {
        if (++dr.starve > this.awayTicks) this.goAway(dr);
        continue;
      }
      dr.starve = 0;
      const k = n > this.rules.inputHigh ? 2 : 1;
      for (let i = 0; i < k; i++) {
        dr.ack = dr.pop();
        const car = dr.car;
        car.step(dt, dr.input, this.road.curvature(car.s));
        if (car.wallHit) {
          dr.events.emit('wallHit', { speed: car.wallImpact });
          dr.score.onWall();
        }
        dr.stepped++;
      }
    }

    this.cars.length = 0;
    for (const dr of this.drivers) if (dr.state === 'active') this.cars.push(dr.car);
    this.traffic.step(dt, this.cars);
    this.director.step(MODE_SPEED * dt);

    for (const dr of this.drivers) {
      if (dr.stepped === 0) continue;
      const car = dr.car;
      if (!car.ghost) this.contacts.collide(car, this.traffic.cars, (h) => this.onHit(dr, h));
      for (let i = 0; i < dr.stepped; i++) dr.score.step(dt, car, this.traffic);
      if (car.ghost) this.updateGhost(dr, dt * dr.stepped);
    }

    // Drivers collide with each other; spawn-protected (ghost) and away cars pass through.
    const ds = this.drivers;
    for (let i = 0; i < ds.length; i++) {
      const a = ds[i];
      if (a.state !== 'active' || a.car.ghost) continue;
      for (let j = i + 1; j < ds.length; j++) {
        const b = ds[j];
        if (b.state !== 'active' || b.car.ghost) continue;
        const speed = this.contacts.collidePair(a.car, b.car);
        if (speed >= 0) this.onDriverContact(a, b, speed);
      }
    }
    this.tick++;
  }

  /**
   * A contact between two drivers. A hard hit (closing at DRIVER_CRASH_SPEED or more) ends both runs; a
   * softer one ends both combos. Cars that stay pressed together count as one contact until they
   * part for a while.
   */
  private onDriverContact(a: Driver, b: Driver, speed: number): void {
    const key = a.id * 256 + b.id;
    const last = this.pairContact.get(key);
    this.pairContact.set(key, this.tick);
    if (last !== undefined && this.tick - last < PAIR_QUIET) return;
    for (const dr of [a, b]) {
      if (speed >= DRIVER_CRASH_SPEED) {
        dr.events.emit('crash', { speed });
        dr.score.onCrash();
      } else {
        dr.events.emit('bump', { speed });
        dr.score.onWall();
      }
    }
  }

  private onHit(dr: Driver, h: Hit): void {
    const c = h.car;
    if (dr.hits.get(c.id) === c.gen) return;
    dr.hits.set(c.id, c.gen);
    dr.events.emit('crash', { speed: h.speed });
    dr.score.onCrash();
  }

  private updateGhost(dr: Driver, dt: number): void {
    dr.ghostT -= dt;
    // No scoring while passing through traffic.
    dr.score.grace = Math.max(dr.score.grace, 0.25);
    if (dr.ghostT <= 0 && !this.touchesTraffic(dr.car) && !this.onSpawnPad(dr.car) && !this.touchesDriver(dr)) dr.car.ghost = false;
  }

  /** Overlapping (or nearly) another driver's car: everyone spawns on one spot, so pulling away together is common. */
  private touchesDriver(dr: Driver): boolean {
    const p = dr.car;
    for (const o of this.drivers) {
      if (o === dr || o.state !== 'active') continue;
      const c = o.car;
      if (Math.abs(this.traffic.rel(c.s, p.s)) < (c.tune.length + p.tune.length) / 2 + 1.5 && Math.abs(c.d - p.d) < (c.tune.width + p.tune.width) / 2 + 0.4) {
        return true;
      }
    }
    return false;
  }

  /**
   * Still on the spawn pad: on the shoulder alongside the places (a little before and after). Cars
   * there stay ghosts, so pulling away never runs into someone parked on the next place.
   */
  private onSpawnPad(p: PlayerCar): boolean {
    return isSpawnProtected(this.map, p.s, p.d, this.ringLen);
  }

  private touchesTraffic(p: PlayerCar): boolean {
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      if (Math.abs(this.traffic.rel(c.s, p.s)) < c.spec.len / 2 + p.tune.length / 2 + 2 && Math.abs(c.d - p.d) < c.spec.wid / 2 + p.tune.width / 2 + 0.6) {
        return true;
      }
    }
    return false;
  }

  /** The lane with the most room around s (lane 1 on a tie). */
  private freeLane(s: number): number {
    let best = 1;
    let bestRoom = -1;
    for (const l of [1, 2, 0, 3]) {
      let room = 200;
      for (const c of this.traffic.cars) {
        if (!c.active || Math.abs(c.d - laneCenter(l)) > LANE_W * 0.8) continue;
        room = Math.min(room, Math.abs(this.traffic.rel(c.s, s)));
      }
      if (room > bestRoom + 1) {
        bestRoom = room;
        best = l;
      }
    }
    return Math.min(best, LANES - 1);
  }

  /**
   * Put a driver's car on the road. Joining and R: standing on the driver's own spawn place (the lap
   * nearest to where the car was, so s keeps counting laps). Back from away: right where the car was,
   * at 90 km/h on the freest lane. Ghosted for a few seconds either way.
   */
  private place(dr: Driver, how: 'join' | 'respawn' | 'return'): void {
    const car = dr.car;
    if (how === 'return') {
      car.reset(car.s, laneCenter(this.freeLane(car.s)), 90 / 3.6);
    } else {
      // Everyone spawns on the same spot; ghosts there, so nobody collides with anybody.
      const home = this.map.spawn.s;
      const lap = how === 'join' ? 0 : Math.round((car.s - home) / this.ringLen);
      car.reset(home + this.ringLen * lap, this.map.spawn.d, 0);
    }
    car.ghost = true;
    dr.ghostT = this.rules.ghostSeconds;
    dr.score.grace = Math.max(dr.score.grace, this.rules.ghostSeconds);
    dr.state = 'active';
    dr.starve = 0;
    dr.epoch++;
    // A stretch of the ring nobody drives yet is empty: fill this driver's window now.
    this.cars.length = 0;
    for (const o of this.drivers) if (o.state === 'active') this.cars.push(o.car);
    this.traffic.setDrivers(this.cars);
    this.traffic.populate(car);
  }

  private goAway(dr: Driver): void {
    dr.state = 'away';
    dr.car.ghost = true;
    dr.clearQueue();
    dr.starve = 0;
  }

  players(connected: (dr: Driver) => boolean): PlayerInfo[] {
    return this.drivers.map((dr) => ({
      id: dr.id,
      name: dr.name,
      color: dr.color,
      physics: dr.physics,
      car: dr.body,
      slot: dr.slot,
      score: Math.floor(dr.score.score),
      best: dr.score.best,
      state: !connected(dr) ? 'offline' : dr.state,
    }));
  }

  /** The snapshot for one driver: own car and score, the others, the traffic around the car. */
  writeSnapshot(dr: Driver, w: Writer): void {
    const car = dr.car;
    const own: SnapshotOwn = {
      tick: this.tick,
      ack: dr.ack,
      epoch: dr.epoch,
      queue: dr.queued,
      flags: (car.ghost ? OWN_GHOST : 0) | (dr.state === 'away' ? OWN_AWAY : 0),
      physics: dr.physics,
      state: this.stateBuf,
      stateLen: car.saveState(this.stateBuf),
      score: dr.score,
    };
    writeSnapshotHead(w, own);

    let nd = 0;
    for (const o of this.drivers) if (o !== dr && o.state === 'active') nd++;
    w.u8(nd);
    for (const o of this.drivers) {
      if (o === dr || o.state !== 'active') continue;
      const c = o.car;
      const flags =
        (c.ghost ? REMOTE_GHOST : 0) |
        (c.brake > 0.05 ? REMOTE_BRAKE : 0) |
        (c.blinker === 1 ? REMOTE_BLINK_LEFT : c.blinker === 2 ? REMOTE_BLINK_RIGHT : 0) |
        (c.horn ? REMOTE_HORN : 0);
      const feedback = sampleTyreFeedback(c, this.remoteTyres);
      for (let i = 0; i < 4; i++) this.remoteWheelOmega[i] = feedback.wheels[i].omega;
      writeDriver(w, o.id, flags, this.traffic.wrap(c.s), c.d, c.psi, c.vx, c.vy, c.r, c.steerAngle / 1.1, c.gear, this.remoteWheelOmega);
    }

    // Traffic in view, nearest first if there is more than a client draws.
    const picks = this.picks;
    picks.length = 0;
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      const r = this.traffic.rel(c.s, car.s);
      if (r < -this.rules.viewBehind || r > this.rules.viewAhead) continue;
      picks.push(c);
      c.snapshotDistance = Math.abs(r);
    }
    if (picks.length > MAX_TRAFFIC) {
      picks.sort((a, b) => a.snapshotDistance - b.snapshotDistance);
      picks.length = MAX_TRAFFIC;
    }
    w.u16(picks.length);
    for (const c of picks) writeCar(w, c, SPEC_INDEX.get(c.spec) ?? 0);
  }

  /** Hash of the whole simulated state (determinism checks). */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      // Mix the float's exact bits.
      f64[0] = v;
      for (let i = 0; i < 2; i++) {
        h ^= u32[i];
        h = Math.imul(h, 0x01000193);
      }
    };
    mix(this.tick);
    for (const dr of this.drivers) {
      mix(dr.id);
      mix(dr.ack);
      mix(dr.score.score);
      const n = dr.car.saveState(this.stateBuf);
      for (let i = 0; i < n; i++) mix(this.stateBuf[i]);
    }
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      mix(c.id);
      mix(c.s);
      mix(c.d);
      mix(c.v);
      mix(c.yaw);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/**
 * Rebuild a session from its seed, rules and journal (up to `endTick`). `prepare` repeats what was done
 * to the live world before its first tick (tests switch traffic off, say).
 */
export function replay(seed: number, rules: Partial<OnlineRules>, journal: readonly Stimulus[], endTick: number, prepare?: (w: OnlineWorld) => void, mapId: MapId = 'highway'): OnlineWorld {
  applyTuning(defaultTuning());
  const w = new OnlineWorld(seed, rules, mapId);
  prepare?.(w);
  const q: InputQ[] = [];
  for (const rec of journal) {
    while (w.tick < rec.t) w.step();
    if (rec.k === 'tuning') {
      w.setTuning(rec.value);
    } else if (rec.k === 'join') {
      const dr = w.join(rec.name, rec.physics, rec.car ?? 1, rec.color);
      if (!dr || dr.id !== rec.id) throw new Error(`replay: join gave ${dr?.id} instead of ${rec.id}`);
    } else if (rec.k === 'leave') {
      w.leave(rec.id);
    } else if (rec.k === 'config') {
      w.configure(rec.cfg);
    } else {
      const dr = w.byId(rec.id);
      if (!dr) continue;
      if (rec.k === 'paint') {
        w.paint(dr, rec.color);
      } else if (rec.k === 'respawn') {
        w.respawn(dr);
      } else if (rec.k === 'resync') {
        w.resync(dr, rec.seq);
      } else {
        const n = rec.q.length / 4;
        for (let i = 0; i < n; i++) {
          q[i] = { steer: rec.q[i * 4], throttle: rec.q[i * 4 + 1], brake: rec.q[i * 4 + 2], flags: rec.q[i * 4 + 3] };
        }
        w.input(dr, rec.seq, q, n);
      }
    }
  }
  while (w.tick < endTick) w.step();
  return w;
}
