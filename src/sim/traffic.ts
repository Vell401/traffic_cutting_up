import { LANES, LANE_W, WALL_D, laneCenter, trafficTune } from '../config';
import { clamp, lerp, smoothstep } from '../core/math';
import { type Rng, range } from '../core/rng';
import type { Director } from './director';
import { VEHICLES, type VehicleSpec } from './vehicles';
import type { PlayerCar } from './vehicle';

/** Cars around one driver (and what a client draws). The server's pool holds this many per driver. */
export const MAX_TRAFFIC = 384;
/** Physical target limit exposed by the online admin, cars per km of lane. */
export const MAX_PER_KM = 80;
/** Traffic lives in [driver.s - BEHIND, driver.s + AHEAD]; new cars appear far ahead, hidden by fog. */
export const BEHIND = 220;
export const AHEAD = 850;
const SPAWN_AHEAD_MIN = 680;
/** A new car must not appear within this far behind another driver (or closer than SPAWN_AHEAD_MIN ahead). */
const SEEN_BEHIND = 200;
/** A wreck is cleared after CRASH_CLEAR s once nobody is within CLEAR_RADIUS of it, and never later than CRASH_MAX. */
const CRASH_CLEAR = 15;
const CLEAR_RADIUS = 150;
const CRASH_MAX = 60;
/** Leader/follower search horizon: beyond it the road counts as free (IDM barely reacts past ~300 m). */
const LOOK = 1200;
/** Longest vehicle's half length (search cut-off). */
const MAX_HALF_LEN = 7.5;
const GLASS = 0x0d1015;
const ALL_LANES = [0, 1, 2, 3];
const BOX_TRUCK = VEHICLES.find((v) => v.name === 'boxTruck')!;

export class TrafficCar {
  active = false;
  spec: VehicleSpec = VEHICLES[0];
  color = 0xffffff;
  /** Cabin glass or cargo box colour. */
  color2 = GLASS;
  /** Indexes into spec.colors / spec.cargoColors (-1 = glass): what the network sends instead of colours. */
  colorIdx = 0;
  color2Idx = -1;
  /** Bumped every time the slot is (re)used, so bookkeeping kept elsewhere can tell a new car from the old one. */
  gen = 0;
  /** Index in Traffic's s-sorted order (neighbour search), -1 when not in it. */
  ord = -1;
  /** Scratch distance for snapshot selection (avoids rebuilding a Map for every recipient). */
  snapshotDistance = 0;

  s = 0;
  d = 0;
  v = 0;
  v0 = 0;
  /** Heading relative to the road (lane changes, crashes). */
  yaw = 0;
  prevS = 0;
  prevD = 0;
  prevYaw = 0;

  lane = 0;
  targetLane = 0;
  /** Where in its lane the car keeps: offset from the lane centre, m (+ = right). */
  laneOff = 0;
  /** Lane change progress 0..1, or -1 when not changing. */
  laneT = -1;
  laneFromD = 0;
  /** -1 left, 1 right, 2 hazards, 0 off. */
  blink = 0;
  blinkT = 0;
  decisionT = 0;
  rude = false;
  /** IDM time headway (s); platoons drive closer than normal traffic. */
  tGap = 1.3;
  acc = 0;
  braking = false;

  crashed = false;
  crashT = 0;
  vd = 0;
  yawRate = 0;
  /** Hit by a driver: gives no more near misses. */
  hit = false;

  constructor(readonly id: number) {}
}

function idm(v: number, v0: number, gap: number, vLead: number, T: number): number {
  const t = trafficTune;
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), 4);
  if (gap === Infinity) return t.idmA * free;
  const sStar = t.idmS0 + Math.max(0, v * T + (v * (v - vLead)) / (2 * Math.sqrt(t.idmA * t.idmB)));
  const g = Math.max(gap, 0.1);
  return t.idmA * (free - (sStar / g) * (sStar / g));
}

/*
 * Traffic lives around drivers: each driver has a window [s - BEHIND, s + AHEAD] that is kept topped up
 * to the director's density, and a car is removed once it is in nobody's window. Single player has one
 * driver; the online server passes every driver on the ring, and a new car is only placed where no
 * other driver can see it appear.
 *
 * On a ring (ringLen finite) positions stay in [0, ringLen) and every distance takes the short way round.
 * Neighbour searches walk an s-sorted list instead of testing every car against every other car.
 */
export class Traffic {
  readonly cars: TrafficCar[] = [];
  activeCount = 0;
  /** No traffic beyond this s (end of a finite track). */
  limitS = Infinity;
  /** Test panel switch: no new traffic while off. */
  enabled = true;
  /** Closed ring length (online); Infinity on an open road. */
  ringLen = Infinity;

  /** Drivers the traffic populates around and treats as obstacles (ghosts excepted). */
  private drivers: readonly PlayerCar[] = [];
  private readonly one: PlayerCar[] = [];
  /** Active cars sorted by s. */
  private readonly order: TrafficCar[] = [];
  private orderLen = 0;
  private windowCount = new Int32Array(1);

  // Results of the last leader/follower query (avoids allocations in the hot loop).
  private lGap = Infinity;
  private lV = 0;
  private fGap = Infinity;
  private fCar: TrafficCar | null = null;

  constructor(
    private readonly rng: Rng,
    readonly director: Director,
    capacity = MAX_TRAFFIC,
  ) {
    for (let i = 0; i < capacity; i++) this.cars.push(new TrafficCar(i));
  }

  /** Target number of cars in one driver's window. */
  targetCount(): number {
    return Math.min(MAX_TRAFFIC - 6, Math.round((this.director.density() * LANES * (BEHIND + AHEAD)) / 1000));
  }

  /** Grow on an admin limit change, retaining existing ids and cars. */
  reserve(capacity: number): void {
    for (let i = this.cars.length; i < capacity; i++) this.cars.push(new TrafficCar(i));
  }

  /** Signed distance from b to a along the road (the short way round on a ring). */
  rel(a: number, b: number): number {
    const x = a - b;
    const L = this.ringLen;
    return L === Infinity ? x : x - L * Math.round(x / L);
  }

  /** Position into [0, ringLen) on a ring; unchanged on an open road. */
  wrap(s: number): number {
    const L = this.ringLen;
    if (L === Infinity) return s;
    s %= L;
    return s < 0 ? s + L : s;
  }

  private use(who: PlayerCar | readonly PlayerCar[]): readonly PlayerCar[] {
    if (Array.isArray(who)) {
      this.drivers = who as readonly PlayerCar[];
    } else {
      this.one[0] = who as PlayerCar;
      this.one.length = 1;
      this.drivers = this.one;
    }
    return this.drivers;
  }

  /** Set the drivers without stepping (before populate() or a scripted spawn between steps). */
  setDrivers(who: PlayerCar | readonly PlayerCar[]): void {
    this.use(who);
  }

  /** Fresh population around the driver(s). */
  reset(who: PlayerCar | readonly PlayerCar[]): void {
    const drivers = this.use(who);
    for (const c of this.cars) {
      c.active = false;
      c.ord = -1;
    }
    this.orderLen = 0;
    this.activeCount = 0;
    this.limitS = Infinity;
    if (!this.enabled) return;
    for (const p of drivers) this.populate(p);
  }

  /** Fill one driver's window at once (start, or a driver joining an empty stretch of the ring). */
  populate(p: PlayerCar): void {
    if (!this.enabled) return;
    const target = this.targetCount();
    let have = 0;
    for (const c of this.cars) if (c.active && this.inWindow(c.s, p, 0)) have++;
    const others = this.drivers.length > 1;
    for (let i = 0; i < target * 6 && have < target; i++) {
      const s = range(this.rng, p.s - BEHIND + 30, p.s + AHEAD - 30);
      if (Math.abs(s - p.s) < 45) continue;
      if (others && this.seenByOthers(this.wrap(s), p)) continue;
      if (this.trySpawn(this.wrap(s), p, false)) have++;
    }
  }

  /** Remove cars near s (respawn). */
  clearAround(s: number, radius: number): void {
    for (const c of this.cars) {
      if (c.active && Math.abs(this.rel(c.s, s)) < radius) this.deactivate(c);
    }
  }

  private inWindow(s: number, p: PlayerCar, extra: number): boolean {
    const r = this.rel(s, p.s);
    return r >= -BEHIND && r <= AHEAD + extra;
  }

  /** Would a car appearing at s pop into view of a driver other than `p`? */
  private seenByOthers(s: number, p: PlayerCar): boolean {
    for (const q of this.drivers) {
      if (q === p) continue;
      const r = this.rel(s, q.s);
      if (r > -SEEN_BEHIND && r < SPAWN_AHEAD_MIN - 20) return true;
    }
    return false;
  }

  step(dt: number, who: PlayerCar | readonly PlayerCar[]): void {
    const rng = this.rng;
    const drivers = this.use(who);
    const nd = drivers.length;
    if (this.windowCount.length < nd) this.windowCount = new Int32Array(nd);
    const counts = this.windowCount;
    counts.fill(0);
    for (const c of this.cars) {
      if (!c.active) continue;
      let seen = false;
      let near = false;
      for (let i = 0; i < nd; i++) {
        const r = this.rel(c.s, drivers[i].s);
        if (r >= -BEHIND && r <= AHEAD + 60) seen = true;
        if (Math.abs(r) < CLEAR_RADIUS) near = true;
      }
      const wreckGone = c.crashed && (c.crashT > CRASH_MAX || (c.crashT > CRASH_CLEAR && !near));
      if (!seen || c.s > this.limitS || wreckGone) {
        this.deactivate(c);
        continue;
      }
      for (let i = 0; i < nd; i++) if (this.inWindow(c.s, drivers[i], 60)) counts[i]++;
    }

    if (this.enabled) {
      for (let i = 0; i < nd; i++) {
        const p = drivers[i];
        if (counts[i] >= this.targetCount()) continue;
        // When we crawl, traffic overtakes us: feed it from behind as well.
        const behind = p.vAlong < 24 && rng() < 0.5;
        const s = this.wrap(behind ? p.s - BEHIND + range(rng, 5, 40) : p.s + range(rng, SPAWN_AHEAD_MIN, AHEAD));
        if (nd > 1 && this.seenByOthers(s, p)) continue;
        const pattern = behind ? 'single' : this.director.pattern();
        if (pattern === 'wall') this.spawnWall(s, p);
        else if (pattern === 'platoon') this.spawnPlatoon(s, p);
        else this.trySpawn(s, p, behind);
      }
    }

    this.sortOrder();
    for (const c of this.cars) {
      if (!c.active) continue;
      c.prevS = c.s;
      c.prevD = c.d;
      c.prevYaw = c.yaw;
      if (c.crashed) this.stepCrashed(c, dt);
      else this.think(c, dt);
    }

    const L = this.ringLen;
    for (const c of this.cars) {
      if (!c.active) continue;
      if (!c.crashed) {
        c.v = Math.max(0, c.v + c.acc * dt);
        c.s += c.v * dt;
        c.yaw = Math.atan2((c.d - c.prevD) / dt, Math.max(c.v, 1));
      }
      if (c.s >= L) {
        c.s -= L;
        c.prevS -= L;
      } else if (c.s < 0 && L !== Infinity) {
        // A collision pushed it back over the ring's seam.
        c.s += L;
        c.prevS += L;
      }
    }
  }

  /** Keep `order` = active cars sorted by s. Insertion sort: the order barely changes between steps. */
  private sortOrder(): void {
    const ord = this.order;
    let n = 0;
    for (let i = 0; i < this.orderLen; i++) {
      const c = ord[i];
      if (c.active) ord[n++] = c;
      else c.ord = -1;
    }
    for (const c of this.cars) {
      if (c.active && c.ord < 0) {
        c.ord = n;
        ord[n++] = c;
      }
    }
    ord.length = n;
    for (let i = 1; i < n; i++) {
      const c = ord[i];
      let j = i - 1;
      while (j >= 0 && ord[j].s > c.s) {
        ord[j + 1] = ord[j];
        j--;
      }
      ord[j + 1] = c;
    }
    for (let i = 0; i < n; i++) ord[i].ord = i;
    this.orderLen = n;
  }

  private think(c: TrafficCar, dt: number): void {
    const rng = this.rng;
    this.leader(c, c.d);
    let acc = idm(c.v, c.v0, this.lGap, this.lV, c.tGap);
    if (c.laneT >= 0) {
      this.leader(c, laneCenter(c.targetLane));
      acc = Math.min(acc, idm(c.v, c.v0, this.lGap, this.lV, c.tGap));
    }
    c.acc = clamp(acc, -9, trafficTune.idmA);
    c.braking = c.acc < -1.2;

    if (c.laneT >= 0) {
      c.laneT += dt / trafficTune.laneChangeTime;
      const toD = laneCenter(c.targetLane) + c.laneOff;
      if (c.laneT >= 0.5) c.lane = c.targetLane;
      if (c.laneT >= 1) {
        c.laneT = -1;
        c.blink = 0;
        c.d = toD;
        c.decisionT = range(rng, 3, 7);
      } else {
        c.d = lerp(c.laneFromD, toD, smoothstep(c.laneT));
      }
    } else if (c.blink !== 0) {
      c.blinkT -= dt;
      if (c.blinkT <= 0) {
        if (this.safeToChange(c, c.targetLane)) {
          c.laneT = 0;
          c.laneFromD = c.d;
          c.laneOff = this.pickLaneOffset(c.spec);
        } else {
          c.blink = 0;
          c.targetLane = c.lane;
          c.decisionT = range(rng, 1.5, 3);
        }
      }
    } else {
      c.decisionT -= dt;
      if (c.decisionT <= 0) {
        c.decisionT = range(rng, 1.5, 4);
        this.considerLaneChange(c, acc);
      }
    }
  }

  /** Simplified MOBIL: change lanes when the other lane lets us accelerate noticeably more and it is safe. */
  private considerLaneChange(c: TrafficCar, aCur: number): void {
    let bestLane = -1;
    let bestGain = 0.35;
    for (let dir = -1; dir <= 1; dir += 2) {
      const l = c.lane + dir;
      if (c.spec.lanes.indexOf(l) < 0) continue;
      this.leader(c, laneCenter(l));
      const aNew = idm(c.v, c.v0, this.lGap, this.lV, c.tGap);
      let gain = aNew - aCur;
      if (dir > 0) gain += 0.1;
      if (this.rng() < trafficTune.whim) gain += 0.6;
      if (gain > bestGain && this.safeToChange(c, l)) {
        bestGain = gain;
        bestLane = l;
      }
    }
    if (bestLane >= 0) {
      c.targetLane = bestLane;
      c.blink = bestLane > c.lane ? 1 : -1;
      c.blinkT = trafficTune.blinkerTime * range(this.rng, 0.8, 1.2);
    }
  }

  private safeToChange(c: TrafficCar, lane: number): boolean {
    const d = laneCenter(lane);
    const hl = c.spec.len / 2;
    this.leader(c, d);
    if (this.lGap < 6) return false;
    this.follower(c, d);
    if (this.fCar) {
      if (this.fGap < 4) return false;
      if (idm(this.fCar.v, this.fCar.v0, this.fGap, c.v, this.fCar.tGap) < -3.5) return false;
    }
    for (const p of this.drivers) {
      if (p.ghost || Math.abs(p.d - d) >= LANE_W * 0.9) continue;
      const ahead = this.rel(c.s, p.s);
      if (Math.abs(ahead) < hl + p.tune.length / 2 + 2) return false;
      // Fair play: polite drivers never cut in front of a fast-approaching player. Rude ones only check the car beside them.
      if (!c.rude && ahead > 0) {
        const gap = ahead - hl - p.tune.length / 2;
        const closing = Math.max(0, p.vAlong - c.v);
        if (gap < 12 + closing * 1.6) return false;
      }
    }
    return true;
  }

  /** Nearest obstacle ahead of `self` in the corridor around lateral offset d (drivers included). */
  private leader(self: TrafficCar, d: number): void {
    const hl = self.spec.len / 2;
    const hw = self.spec.wid / 2;
    let gap = Infinity;
    let lv = 0;
    const ord = this.order;
    const n = this.orderLen;
    const ring = this.ringLen !== Infinity;
    for (let k = 1; k < n; k++) {
      let j = self.ord + k;
      if (j >= n) {
        if (!ring) break;
        j -= n;
      }
      const o = ord[j];
      const ds = this.rel(o.s, self.s);
      // Past half the ring the distance turns negative: everything further on is behind.
      if (ds < 0 || ds > LOOK || ds - hl - MAX_HALF_LEN >= gap) break;
      if (ds === 0) continue;
      if (Math.abs(o.d - d) > hw + o.spec.wid / 2 + 0.3) continue;
      const g = ds - hl - o.spec.len / 2;
      if (g < gap) {
        gap = g;
        lv = o.v;
      }
    }
    for (const p of this.drivers) {
      if (p.ghost) continue;
      const ds = this.rel(p.s, self.s);
      if (ds > 0 && Math.abs(p.d - d) < hw + p.tune.width / 2 + 0.3) {
        const g = ds - hl - p.tune.length / 2;
        if (g < gap) {
          gap = g;
          lv = p.vAlong;
        }
      }
    }
    this.lGap = gap;
    this.lV = lv;
  }

  private follower(self: TrafficCar, d: number): void {
    const hl = self.spec.len / 2;
    const hw = self.spec.wid / 2;
    let gap = Infinity;
    let car: TrafficCar | null = null;
    const ord = this.order;
    const n = this.orderLen;
    const ring = this.ringLen !== Infinity;
    for (let k = 1; k < n; k++) {
      let j = self.ord - k;
      if (j < 0) {
        if (!ring) break;
        j += n;
      }
      const o = ord[j];
      const ds = this.rel(self.s, o.s);
      // Past half the ring the distance turns negative: everything further on is behind.
      if (ds < 0 || ds > LOOK || ds - hl - MAX_HALF_LEN >= gap) break;
      if (ds === 0) continue;
      if (Math.abs(o.d - d) > hw + o.spec.wid / 2 + 0.3) continue;
      const g = ds - hl - o.spec.len / 2;
      if (g < gap) {
        gap = g;
        car = o;
      }
    }
    this.fGap = gap;
    this.fCar = car;
  }

  /** A wrecked car: slides to a stop, spins down, hazards on. Also run by client-side prediction. */
  stepCrashed(c: TrafficCar, dt: number): void {
    c.crashT += dt;
    c.v = Math.max(0, c.v - 6 * dt);
    c.vd *= Math.exp(-2.5 * dt);
    c.s += c.v * dt;
    c.d += c.vd * dt;
    c.yaw += c.yawRate * dt;
    c.yawRate *= Math.exp(-1.2 * dt);
    const hw = c.spec.wid / 2;
    if (Math.abs(c.d) + hw > WALL_D) {
      c.d = Math.sign(c.d) * (WALL_D - hw);
      c.vd = 0;
    }
    c.acc = -6;
    c.braking = true;
    c.blink = 2;
  }

  /** Is a lane free of other vehicles around s (± clearance beyond both cars' half lengths)? */
  private laneFree(lane: number, s: number, len: number, clearance: number): boolean {
    const d = laneCenter(lane);
    for (const o of this.cars) {
      if (!o.active) continue;
      if (Math.abs(o.d - d) < LANE_W * 0.9 && Math.abs(this.rel(o.s, s)) < (o.spec.len + len) / 2 + clearance) return false;
    }
    for (const p of this.drivers) {
      if (Math.abs(p.d - d) < LANE_W && Math.abs(this.rel(p.s, s)) < 40) return false;
    }
    return true;
  }

  private laneSpeed(lane: number, spec: VehicleSpec): number {
    const [lo, hi] = trafficTune.laneSpeedKmh[lane];
    let v0 = range(this.rng, lo, hi) / 3.6;
    if (spec.truck) v0 = Math.min(v0, range(this.rng, 80, 92) / 3.6);
    return v0;
  }

  /** Keep a formation's lanes until the player has had time to reach it. */
  private holdLanes(c: TrafficCar, p: PlayerCar): void {
    const closing = Math.max(3, p.vAlong - c.v);
    c.decisionT = Math.min(45, 6 + this.rel(c.s, p.s) / closing);
  }

  private trySpawn(s: number, p: PlayerCar, fromBehind: boolean): boolean {
    if (s > this.limitS) return false;
    const dir = this.director;
    const spec = dir.pickSpec();
    const lane = dir.pickLane(dir.lanesFor(spec));
    const clearance = Math.max(5, Math.min(22, 700 / Math.max(1, dir.density()) - spec.len));
    if (!this.laneFree(lane, s, spec.len, clearance)) return false;
    const v0 = this.laneSpeed(lane, spec);
    if (fromBehind && v0 < p.vAlong + 3) return false;
    return this.spawnAt(spec, s, lane, v0, laneCenter(lane) + this.pickLaneOffset(spec)) !== null;
  }

  /**
   * Where a car keeps in its lane: a third hug the left line, a third the right one, the rest drive
   * near the middle, each by its own amount (bigger cars have less room).
   */
  private pickLaneOffset(spec: VehicleSpec): number {
    const room = Math.max(0, (LANE_W - spec.wid) / 2 - 0.3);
    const r = this.rng();
    const amount = range(this.rng, 0.55, 1) * room;
    return r < 0.34 ? -amount : r < 0.68 ? amount : (amount - 0.775 * room) * 0.4;
  }

  /** Three vehicles abreast with one lane left open: thread the gap or go round. */
  spawnWall(s: number, p: PlayerCar): boolean {
    if (s > this.limitS) return false;
    const rng = this.rng;
    const gapLane = Math.floor(rng() * LANES);
    const lanes: number[] = [];
    for (let l = 0; l < LANES; l++) if (l !== gapLane) lanes.push(l);
    if (this.cars.length - this.activeCount < lanes.length) return false;
    for (const l of lanes) if (!this.laneFree(l, s, 15, 30)) return false;
    if (!this.laneFree(gapLane, s, 15, 25)) return false;
    const v0 = range(rng, 86, 100) / 3.6;
    for (const l of lanes) {
      const spec = l >= 2 && rng() < 0.3 ? BOX_TRUCK : this.director.pickCar();
      const c = this.spawnAt(spec, this.wrap(s + range(rng, -1.5, 1.5)), l, v0);
      if (!c) break;
      c.rude = false;
      this.holdLanes(c, p);
    }
    return true;
  }

  /** 3 to 5 cars nose to tail in one lane at the same speed. */
  spawnPlatoon(s: number, p: PlayerCar): boolean {
    if (s + 80 > this.limitS) return false;
    const rng = this.rng;
    const n = 3 + Math.floor(rng() * 3);
    if (this.cars.length - this.activeCount < n) return false;
    const lane = this.director.pickLane(ALL_LANES);
    const specs: VehicleSpec[] = [];
    const gaps: number[] = [];
    let span = 0;
    for (let i = 0; i < n; i++) {
      specs.push(this.director.pickCar());
      gaps.push(range(rng, 9, 14));
      span += specs[i].len + gaps[i];
    }
    if (!this.laneFree(lane, this.wrap(s + span / 2), span, 25)) return false;
    const v0 = this.laneSpeed(lane, specs[0]);
    let at = s;
    for (let i = 0; i < n; i++) {
      const c = this.spawnAt(specs[i], this.wrap(at + specs[i].len / 2), lane, v0);
      if (!c) break;
      c.tGap = 0.55;
      c.rude = false;
      this.holdLanes(c, p);
      at += specs[i].len + gaps[i];
    }
    return true;
  }

  /** Place a vehicle at (s, lane) driving at v0. Returns null when the pool is exhausted. */
  spawnAt(spec: VehicleSpec, s: number, lane: number, v0: number, d = laneCenter(lane)): TrafficCar | null {
    const rng = this.rng;
    let c: TrafficCar | null = null;
    for (const o of this.cars) {
      if (!o.active) {
        c = o;
        break;
      }
    }
    if (!c) return null;

    c.active = true;
    c.gen++;
    c.spec = spec;
    c.colorIdx = Math.floor(rng() * spec.colors.length);
    c.color = spec.colors[c.colorIdx];
    c.color2Idx = spec.truck ? Math.floor(rng() * spec.cargoColors.length) : -1;
    c.color2 = c.color2Idx >= 0 ? spec.cargoColors[c.color2Idx] : GLASS;
    c.s = c.prevS = s;
    c.d = c.prevD = d;
    c.yaw = c.prevYaw = 0;
    c.v = v0;
    c.v0 = v0;
    c.lane = c.targetLane = lane;
    c.laneOff = d - laneCenter(lane);
    c.laneT = -1;
    c.blink = 0;
    c.blinkT = 0;
    c.decisionT = range(rng, 1, 4);
    c.rude = rng() < this.director.rudeShare();
    c.tGap = this.director.timeGap();
    c.acc = 0;
    c.braking = false;
    c.crashed = false;
    c.crashT = 0;
    c.vd = 0;
    c.yawRate = 0;
    c.hit = false;
    this.activeCount++;
    return c;
  }

  private deactivate(c: TrafficCar): void {
    c.active = false;
    this.activeCount--;
  }
}
