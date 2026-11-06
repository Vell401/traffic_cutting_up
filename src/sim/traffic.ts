import { LANES, LANE_W, WALL_D, laneCenter, trafficTune } from '../config';
import { clamp, lerp, smoothstep } from '../core/math';
import { type Rng, range } from '../core/rng';
import type { Director } from './director';
import { VEHICLES, type VehicleSpec } from './vehicles';
import type { PlayerCar } from './vehicle';

export const MAX_TRAFFIC = 112;
/** Traffic lives in [player.s - BEHIND, player.s + AHEAD]; new cars appear far ahead, hidden by fog. */
const BEHIND = 220;
const AHEAD = 850;
const SPAWN_AHEAD_MIN = 680;
const GLASS = 0x0d1015;
const ALL_LANES = [0, 1, 2, 3];
const BOX_TRUCK = VEHICLES.find((v) => v.name === 'boxTruck')!;

export class TrafficCar {
  active = false;
  spec: VehicleSpec = VEHICLES[0];
  color = 0xffffff;
  /** Cabin glass or cargo box colour. */
  color2 = GLASS;

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

  // Scoring bookkeeping (owned by Scoring).
  hit = false;
  ovl = false;
  ovlSign = 0;
  minGap = Infinity;
  splitDone = false;

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

export class Traffic {
  readonly cars: TrafficCar[] = [];
  activeCount = 0;
  /** No traffic beyond this s (end of a finite track). */
  limitS = Infinity;
  /** Test panel switch: no new traffic while off. */
  enabled = true;

  // Results of the last leader/follower query (avoids allocations in the hot loop).
  private lGap = Infinity;
  private lV = 0;
  private fGap = Infinity;
  private fCar: TrafficCar | null = null;

  constructor(
    private readonly rng: Rng,
    readonly director: Director,
  ) {
    for (let i = 0; i < MAX_TRAFFIC; i++) this.cars.push(new TrafficCar(i));
  }

  targetCount(): number {
    return Math.min(MAX_TRAFFIC - 6, Math.round((this.director.density() * LANES * (BEHIND + AHEAD)) / 1000));
  }

  reset(p: PlayerCar): void {
    for (const c of this.cars) c.active = false;
    this.activeCount = 0;
    this.limitS = Infinity;
    if (!this.enabled) return;
    const target = this.targetCount();
    for (let i = 0; i < target * 6 && this.activeCount < target; i++) {
      const s = range(this.rng, p.s - BEHIND + 30, p.s + AHEAD - 30);
      if (Math.abs(s - p.s) < 45) continue;
      this.trySpawn(s, p, false);
    }
  }

  /** Remove cars near the player (respawn). */
  clearAround(s: number, radius: number): void {
    for (const c of this.cars) {
      if (c.active && Math.abs(c.s - s) < radius) this.deactivate(c);
    }
  }

  step(dt: number, p: PlayerCar): void {
    const rng = this.rng;
    for (const c of this.cars) {
      if (!c.active) continue;
      if (c.s < p.s - BEHIND || c.s > p.s + AHEAD + 60 || c.s > this.limitS || (c.crashed && c.crashT > 15)) this.deactivate(c);
    }

    if (this.enabled && this.activeCount < this.targetCount()) {
      // When we crawl, traffic overtakes us: feed it from behind as well.
      const behind = p.vAlong < 24 && rng() < 0.5;
      const s = behind ? p.s - BEHIND + range(rng, 5, 40) : p.s + range(rng, SPAWN_AHEAD_MIN, AHEAD);
      const pattern = behind ? 'single' : this.director.pattern();
      if (pattern === 'wall') this.spawnWall(s, p);
      else if (pattern === 'platoon') this.spawnPlatoon(s, p);
      else this.trySpawn(s, p, behind);
    }

    for (const c of this.cars) {
      if (!c.active) continue;
      c.prevS = c.s;
      c.prevD = c.d;
      c.prevYaw = c.yaw;
      if (c.crashed) this.stepCrashed(c, dt);
      else this.think(c, dt, p);
    }

    for (const c of this.cars) {
      if (!c.active || c.crashed) continue;
      c.v = Math.max(0, c.v + c.acc * dt);
      c.s += c.v * dt;
      c.yaw = Math.atan2((c.d - c.prevD) / dt, Math.max(c.v, 1));
    }
  }

  private think(c: TrafficCar, dt: number, p: PlayerCar): void {
    const rng = this.rng;
    this.leader(c, c.d, p);
    let acc = idm(c.v, c.v0, this.lGap, this.lV, c.tGap);
    if (c.laneT >= 0) {
      this.leader(c, laneCenter(c.targetLane), p);
      acc = Math.min(acc, idm(c.v, c.v0, this.lGap, this.lV, c.tGap));
    }
    c.acc = clamp(acc, -9, trafficTune.idmA);
    c.braking = c.acc < -1.2;

    if (c.laneT >= 0) {
      c.laneT += dt / trafficTune.laneChangeTime;
      const toD = laneCenter(c.targetLane);
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
        if (this.safeToChange(c, c.targetLane, p)) {
          c.laneT = 0;
          c.laneFromD = c.d;
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
        this.considerLaneChange(c, p, acc);
      }
    }
  }

  /** Simplified MOBIL: change lanes when the other lane lets us accelerate noticeably more and it is safe. */
  private considerLaneChange(c: TrafficCar, p: PlayerCar, aCur: number): void {
    let bestLane = -1;
    let bestGain = 0.35;
    for (let dir = -1; dir <= 1; dir += 2) {
      const l = c.lane + dir;
      if (c.spec.lanes.indexOf(l) < 0) continue;
      this.leader(c, laneCenter(l), p);
      const aNew = idm(c.v, c.v0, this.lGap, this.lV, c.tGap);
      let gain = aNew - aCur;
      if (dir > 0) gain += 0.1;
      if (this.rng() < trafficTune.whim) gain += 0.6;
      if (gain > bestGain && this.safeToChange(c, l, p)) {
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

  private safeToChange(c: TrafficCar, lane: number, p: PlayerCar): boolean {
    const d = laneCenter(lane);
    const hl = c.spec.len / 2;
    this.leader(c, d, p);
    if (this.lGap < 6) return false;
    this.follower(c, d);
    if (this.fCar) {
      if (this.fGap < 4) return false;
      if (idm(this.fCar.v, this.fCar.v0, this.fGap, c.v, this.fCar.tGap) < -3.5) return false;
    }
    const pInLane = Math.abs(p.d - d) < LANE_W * 0.9;
    if (pInLane && Math.abs(p.s - c.s) < hl + p.tune.length / 2 + 2) return false;
    // Fair play: polite drivers never cut in front of a fast-approaching player. Rude ones only check the car beside them.
    if (!c.rude && pInLane && p.s < c.s) {
      const gap = c.s - p.s - hl - p.tune.length / 2;
      const closing = Math.max(0, p.vAlong - c.v);
      if (gap < 12 + closing * 1.6) return false;
    }
    return true;
  }

  /** Nearest obstacle ahead of `self` in the corridor around lateral offset d (the player included). */
  private leader(self: TrafficCar, d: number, p: PlayerCar): void {
    const hl = self.spec.len / 2;
    const hw = self.spec.wid / 2;
    let gap = Infinity;
    let lv = 0;
    for (const o of this.cars) {
      if (!o.active || o === self || o.s <= self.s) continue;
      if (Math.abs(o.d - d) > hw + o.spec.wid / 2 + 0.3) continue;
      const g = o.s - self.s - hl - o.spec.len / 2;
      if (g < gap) {
        gap = g;
        lv = o.v;
      }
    }
    if (p.s > self.s && Math.abs(p.d - d) < hw + p.tune.width / 2 + 0.3) {
      const g = p.s - self.s - hl - p.tune.length / 2;
      if (g < gap) {
        gap = g;
        lv = p.vAlong;
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
    for (const o of this.cars) {
      if (!o.active || o === self || o.s >= self.s) continue;
      if (Math.abs(o.d - d) > hw + o.spec.wid / 2 + 0.3) continue;
      const g = self.s - o.s - hl - o.spec.len / 2;
      if (g < gap) {
        gap = g;
        car = o;
      }
    }
    this.fGap = gap;
    this.fCar = car;
  }

  private stepCrashed(c: TrafficCar, dt: number): void {
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
  private laneFree(lane: number, s: number, len: number, clearance: number, p: PlayerCar): boolean {
    const d = laneCenter(lane);
    for (const o of this.cars) {
      if (!o.active) continue;
      if (Math.abs(o.d - d) < LANE_W * 0.9 && Math.abs(o.s - s) < (o.spec.len + len) / 2 + clearance) return false;
    }
    return !(Math.abs(p.d - d) < LANE_W && Math.abs(p.s - s) < 40);
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
    c.decisionT = Math.min(45, 6 + (c.s - p.s) / closing);
  }

  private trySpawn(s: number, p: PlayerCar, fromBehind: boolean): boolean {
    if (s > this.limitS) return false;
    const dir = this.director;
    const spec = dir.pickSpec();
    const lane = dir.pickLane(dir.lanesFor(spec));
    if (!this.laneFree(lane, s, spec.len, 22, p)) return false;
    const v0 = this.laneSpeed(lane, spec);
    if (fromBehind && v0 < p.vAlong + 3) return false;
    return this.spawnAt(spec, s, lane, v0) !== null;
  }

  /** Three vehicles abreast with one lane left open: thread the gap or go round. */
  spawnWall(s: number, p: PlayerCar): boolean {
    if (s > this.limitS) return false;
    const rng = this.rng;
    const gapLane = Math.floor(rng() * LANES);
    const lanes: number[] = [];
    for (let l = 0; l < LANES; l++) if (l !== gapLane) lanes.push(l);
    if (MAX_TRAFFIC - this.activeCount < lanes.length) return false;
    for (const l of lanes) if (!this.laneFree(l, s, 15, 30, p)) return false;
    if (!this.laneFree(gapLane, s, 15, 25, p)) return false;
    const v0 = range(rng, 86, 100) / 3.6;
    for (const l of lanes) {
      const spec = l >= 2 && rng() < 0.3 ? BOX_TRUCK : this.director.pickCar();
      const c = this.spawnAt(spec, s + range(rng, -1.5, 1.5), l, v0);
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
    if (MAX_TRAFFIC - this.activeCount < n) return false;
    const lane = this.director.pickLane(ALL_LANES);
    const specs: VehicleSpec[] = [];
    const gaps: number[] = [];
    let span = 0;
    for (let i = 0; i < n; i++) {
      specs.push(this.director.pickCar());
      gaps.push(range(rng, 9, 14));
      span += specs[i].len + gaps[i];
    }
    if (!this.laneFree(lane, s + span / 2, span, 25, p)) return false;
    const v0 = this.laneSpeed(lane, specs[0]);
    let at = s;
    for (let i = 0; i < n; i++) {
      const c = this.spawnAt(specs[i], at + specs[i].len / 2, lane, v0);
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
    c.spec = spec;
    c.color = spec.colors[Math.floor(rng() * spec.colors.length)];
    c.color2 = spec.truck ? spec.cargoColors[Math.floor(rng() * spec.cargoColors.length)] : GLASS;
    c.s = c.prevS = s;
    c.d = c.prevD = d;
    c.yaw = c.prevYaw = 0;
    c.v = v0;
    c.v0 = v0;
    c.lane = c.targetLane = lane;
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
    c.ovl = false;
    c.ovlSign = 0;
    c.minGap = Infinity;
    c.splitDone = false;
    this.activeCount++;
    return c;
  }

  private deactivate(c: TrafficCar): void {
    c.active = false;
    this.activeCount--;
  }
}
