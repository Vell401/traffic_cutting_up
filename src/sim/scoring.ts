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

  constructor(private readonly events: Emitter<SimEvents>) {}

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
    for (const c of traffic.cars) {
      if (!c.active || c.crashed) continue;
      const ds = c.s - p.s;
      const alongside = Math.abs(ds) < pHalfLen + c.spec.len / 2 + 0.5;
      const gap = Math.abs(c.d - p.d) - c.spec.wid / 2 - pExt;
      if (alongside) {
        if (!c.ovl) {
          c.ovl = true;
          c.ovlSign = ds >= 0 ? 1 : -1;
          c.minGap = gap;
        } else if (gap < c.minGap) {
          c.minGap = gap;
        }
        if (gap < t.splitGap && !c.splitDone) {
          if (c.d < p.d) splitL = c;
          else splitR = c;
        }
      } else if (c.ovl) {
        c.ovl = false;
        const passed = (ds >= 0 ? 1 : -1) !== c.ovlSign;
        const relKmh = Math.abs(p.vAlong - c.v) * 3.6;
        if (passed && scoring && !c.hit && !p.onShoulder && c.minGap < t.nearGap && kmh >= t.minSpeedKmh && relKmh >= t.minRelKmh) {
          this.nearMiss(c, Math.max(0, c.minGap), kmh);
        }
        c.minGap = Infinity;
      }
    }
    if (splitL && splitR && scoring && kmh >= t.minSpeedKmh && !p.onShoulder) {
      splitL.splitDone = true;
      splitR.splitDone = true;
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

  private nearMiss(c: TrafficCar, gap: number, kmh: number): void {
    const t = scoreTune;
    this.bumpCombo();
    this.near++;
    const closeness = clamp(1 - gap / t.nearGap, 0, 1);
    const speedF = clamp(kmh / 150, 1, 2.2);
    const kindF = c.spec.truck ? t.truckFactor : 1;
    const points = Math.round((t.basePoints + t.closeBonus * Math.pow(closeness, 1.5)) * speedF * kindF * this.mult);
    this.score += points;
    this.events.emit('nearMiss', { points, gap, truck: c.spec.truck, combo: this.combo, mult: this.mult });
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
