import { scoreTune } from '../config';
import { clamp } from '../core/math';
import type { Emitter } from '../core/events';
import type { SimEvents } from './events';
import type { Traffic, TrafficCar } from './traffic';
import type { PlayerCar } from './vehicle';

/*
 * No Hesi style run scoring:
 *  - points for speed above a threshold and for passing cars with a tiny lateral gap (near miss);
 *  - every near miss extends the combo, the combo drives the multiplier, the combo times out;
 *  - touching a barrier kills the combo; hitting a car ends the run (score compared with best and reset).
 */
export class Scoring {
  /** Ring length when scoring on the online ring (distances wrap); Infinity on an open road. */
  ringLen = Infinity;
  score = 0;
  best = 0;
  combo = 0;
  comboT = 0;
  mult = 1;
  near = 0;
  runTime = 0;
  topKmh = 0;
  /** Seconds left in which contacts do not end the fresh run. */
  grace = 0;

  // Per traffic car bookkeeping, indexed by car id and reset when the slot's generation changes. It lives
  // here, not on the car, because online every driver scores the same cars on their own.
  private gen = new Int32Array(0);
  private ovl = new Uint8Array(0);
  private ovlSign = new Int8Array(0);
  private minGap = new Float64Array(0);
  private splitDone = new Uint8Array(0);

  constructor(private readonly events: Emitter<SimEvents>) {}

  private slots(n: number): void {
    if (this.gen.length >= n) return;
    this.gen = new Int32Array(n).fill(-1);
    this.ovl = new Uint8Array(n);
    this.ovlSign = new Int8Array(n);
    this.minGap = new Float64Array(n).fill(Infinity);
    this.splitDone = new Uint8Array(n);
  }

  private rel(a: number, b: number): number {
    const x = a - b;
    const L = this.ringLen;
    return L === Infinity ? x : x - L * Math.round(x / L);
  }

  resetRun(): void {
    this.score = 0;
    this.combo = 0;
    this.comboT = 0;
    this.mult = 1;
    this.near = 0;
    this.runTime = 0;
    this.topKmh = 0;
  }

  step(dt: number, p: PlayerCar, traffic: Traffic): void {
    const t = scoreTune;
    const kmh = p.vAlong * 3.6;
    this.runTime += dt;
    this.topKmh = Math.max(this.topKmh, kmh);
    if (this.grace > 0) this.grace -= dt;
    const scoring = this.grace <= 0;

    if (scoring && kmh > t.minSpeedKmh) {
      this.score += (kmh - t.minSpeedKmh) * t.speedPointsPerKmh * this.mult * dt;
    }

    if (this.combo > 0) {
      this.comboT -= dt * (kmh < t.minSpeedKmh ? 2 : 1);
      if (this.comboT <= 0) {
        this.combo = 0;
        this.comboT = 0;
        this.mult = 1;
        this.events.emit('comboEnd', { reason: 'timeout' });
      }
    }

    // Near misses: track the smallest lateral gap while a car is alongside, judge when it is left behind (or passes us).
    const pHalfLen = p.tune.length / 2;
    const pExt = p.halfExtentD();
    let splitL: TrafficCar | null = null;
    let splitR: TrafficCar | null = null;
    this.slots(traffic.cars.length);
    const { gen, ovl, ovlSign, minGap, splitDone } = this;
    for (const c of traffic.cars) {
      if (!c.active || c.crashed) continue;
      const i = c.id;
      if (gen[i] !== c.gen) {
        gen[i] = c.gen;
        ovl[i] = 0;
        ovlSign[i] = 0;
        minGap[i] = Infinity;
        splitDone[i] = 0;
      }
      const ds = this.rel(c.s, p.s);
      if (ds > 40 || ds < -40) {
        if (!ovl[i]) continue;
      }
      const alongside = Math.abs(ds) < pHalfLen + c.spec.len / 2 + 0.5;
      const gap = Math.abs(c.d - p.d) - c.spec.wid / 2 - pExt;
      if (alongside) {
        if (!ovl[i]) {
          ovl[i] = 1;
          ovlSign[i] = ds >= 0 ? 1 : -1;
          minGap[i] = gap;
        } else if (gap < minGap[i]) {
          minGap[i] = gap;
        }
        if (gap < t.splitGap && !splitDone[i]) {
          if (c.d < p.d) splitL = c;
          else splitR = c;
        }
      } else if (ovl[i]) {
        ovl[i] = 0;
        const passed = (ds >= 0 ? 1 : -1) !== ovlSign[i];
        const relKmh = Math.abs(p.vAlong - c.v) * 3.6;
        const mg = minGap[i];
        if (passed && !c.hit && mg < 2.5 && relKmh > 10) {
          this.events.emit('passBy', { side: c.d > p.d ? 1 : -1, gap: Math.max(0, mg), truck: c.spec.truck, relSpeed: relKmh / 3.6 });
        }
        if (passed && scoring && !c.hit && !p.onShoulder && mg < t.nearGap && kmh >= t.minSpeedKmh && relKmh >= t.minRelKmh) {
          this.nearMiss(c, Math.max(0, mg), kmh, c.d > p.d ? 1 : -1);
        }
        minGap[i] = Infinity;
      }
    }
    if (splitL && splitR && scoring && kmh >= t.minSpeedKmh && !p.onShoulder) {
      splitDone[splitL.id] = 1;
      splitDone[splitR.id] = 1;
      this.bumpCombo();
      const points = Math.round(t.splitPoints * clamp(kmh / 150, 1, 2.2) * this.mult);
      this.score += points;
      this.events.emit('laneSplit', { points, combo: this.combo, mult: this.mult });
    }
  }

  private bumpCombo(): void {
    const t = scoreTune;
    this.combo++;
    this.comboT = t.comboTime;
    this.mult = Math.min(1 + this.combo * t.multPerCombo, t.multMax);
  }

  private nearMiss(c: TrafficCar, gap: number, kmh: number, side: number): void {
    const t = scoreTune;
    this.bumpCombo();
    this.near++;
    const closeness = clamp(1 - gap / t.nearGap, 0, 1);
    const speedF = clamp(kmh / 150, 1, 2.2);
    const kindF = c.spec.truck ? t.truckFactor : 1;
    const points = Math.round((t.basePoints + t.closeBonus * Math.pow(closeness, 1.5)) * speedF * kindF * this.mult);
    this.score += points;
    this.events.emit('nearMiss', { points, gap, truck: c.spec.truck, combo: this.combo, mult: this.mult, side });
  }

  onWall(): void {
    if (this.combo > 0) {
      this.combo = 0;
      this.comboT = 0;
      this.mult = 1;
      this.events.emit('comboEnd', { reason: 'wall' });
    }
  }

  /** A car was hit. Returns true if this ended a run. */
  onCrash(): boolean {
    if (this.grace > 0) return false;
    this.endRun();
    return true;
  }

  endRun(): void {
    const score = Math.floor(this.score);
    const newBest = score > this.best;
    if (newBest) this.best = score;
    this.events.emit('runEnd', { score, best: this.best, newBest, time: this.runTime, near: this.near, topKmh: this.topKmh });
    this.resetRun();
    this.grace = scoreTune.runGrace;
  }
}
