import { trafficTune } from '../config';
import type { Emitter } from '../core/events';
import { type Rng, range } from '../core/rng';
import type { SimEvents } from './events';
import { VEHICLES, type VehicleSpec } from './vehicles';

/*
 * Traffic director: decides what the road ahead looks like.
 *  - Difficulty ramps with the distance driven in the current run (and resets with it):
 *    denser traffic and more rude drivers the longer you survive.
 *  - The road cycles through traffic modes every ~1 km, each with its own spawn pattern.
 */
export type TrafficMode = 'normal' | 'sparse' | 'dense' | 'trucks' | 'walls' | 'platoons';

export const MODE_LABEL: Record<TrafficMode, string> = {
  normal: '',
  sparse: 'LIGHT TRAFFIC',
  dense: 'HEAVY TRAFFIC',
  trucks: 'TRUCK CONVOY',
  walls: 'ROADBLOCKS',
  platoons: 'PLATOONS',
};

const MODE_DENSITY: Record<TrafficMode, number> = {
  normal: 1,
  sparse: 0.55,
  dense: 1.45,
  trucks: 1.05,
  walls: 0.9,
  platoons: 1,
};

/** Run distance (m) at which difficulty peaks. */
export const RAMP_DIST = 8000;
const FIRST_MODE_LEN = 1000;

export type SpawnPattern = 'single' | 'wall' | 'platoon';

/** Traffic variants offered in the start menu. */
export type TrafficPreset = 1 | 2;

export interface TrafficPresetInfo {
  id: TrafficPreset;
  name: string;
  desc: string;
}

export const TRAFFIC_PRESETS: readonly TrafficPresetInfo[] = [
  { id: 1, name: 'Обычный', desc: 'Сбалансированный поток, режимы меняются каждый километр' },
  { id: 2, name: 'Плотный', desc: 'В ~1,7 раза больше машин, короче дистанции, чаще стенки и колонны' },
];

/** Dense preset: density multiplier and how much closer cars follow each other. */
const DENSE_DENSITY = 1.7;
const DENSE_GAP = 0.82;

export class Director {
  mode: TrafficMode = 'normal';
  /** Start-menu traffic variant. */
  preset: TrafficPreset = 1;
  /** 0..1, grows with the distance of the current run. */
  intensity = 0;
  runDist = 0;
  /** Relative spawn weight of each lane (a "hot" lane gets most of the traffic). */
  readonly laneBias = [1, 1, 1, 1];
  private modeLeft = FIRST_MODE_LEN;

  constructor(
    private readonly rng: Rng,
    private readonly events: Emitter<SimEvents>,
  ) {}

  resetRun(): void {
    this.runDist = 0;
    this.intensity = 0;
  }

  step(ds: number): void {
    if (ds <= 0) return;
    this.runDist += ds;
    this.intensity = Math.min(1, this.runDist / RAMP_DIST);
    this.modeLeft -= ds;
    if (this.modeLeft <= 0) this.nextMode();
  }

  /** Target cars per kilometre per lane right now. */
  density(): number {
    const k = this.preset === 2 ? DENSE_DENSITY : 1;
    return trafficTune.density * k * (0.75 + 0.6 * this.intensity) * MODE_DENSITY[this.mode];
  }

  /** IDM time headway for a newly spawned car. */
  timeGap(): number {
    return trafficTune.idmT * (this.preset === 2 ? DENSE_GAP : 1);
  }

  rudeShare(): number {
    return trafficTune.rudeShare * (1 + this.intensity);
  }

  pattern(): SpawnPattern {
    const r = this.rng();
    const dense = this.preset === 2;
    if (this.mode === 'walls' && r < (dense ? 0.5 : 0.4)) return 'wall';
    if (this.mode === 'platoons' && r < (dense ? 0.55 : 0.45)) return 'platoon';
    // Dense traffic bunches up everywhere: the odd platoon even outside platoon mode.
    if (dense && this.mode !== 'sparse' && r > 0.93) return 'platoon';
    return 'single';
  }

  /** Vehicle type for a single spawn: trucks are far more common in convoy mode and may use lane 1. */
  pickSpec(): VehicleSpec {
    const truckBoost = this.mode === 'trucks' ? 4 : 1;
    let total = 0;
    for (const v of VEHICLES) total += v.weight * (v.truck ? truckBoost : 1);
    let x = this.rng() * total;
    for (const v of VEHICLES) {
      x -= v.weight * (v.truck ? truckBoost : 1);
      if (x <= 0) return v;
    }
    return VEHICLES[0];
  }

  /** A passenger car (no trucks), for formations. */
  pickCar(): VehicleSpec {
    let spec = this.pickSpec();
    for (let i = 0; i < 8 && spec.truck; i++) spec = this.pickSpec();
    return spec.truck ? VEHICLES[0] : spec;
  }

  lanesFor(spec: VehicleSpec): readonly number[] {
    return spec.truck && this.mode === 'trucks' ? TRUCK_CONVOY_LANES : spec.lanes;
  }

  /** Lane among `lanes`, weighted by the current lane bias. */
  pickLane(lanes: readonly number[]): number {
    let total = 0;
    for (const l of lanes) total += this.laneBias[l];
    let x = this.rng() * total;
    for (const l of lanes) {
      x -= this.laneBias[l];
      if (x <= 0) return l;
    }
    return lanes[lanes.length - 1];
  }

  /** Force a mode (debugging and tests). */
  setMode(mode: TrafficMode, length = range(this.rng, 800, 1600)): void {
    this.mode = mode;
    this.modeLeft = length;
    const hot = Math.floor(this.rng() * this.laneBias.length);
    for (let l = 0; l < this.laneBias.length; l++) {
      this.laneBias[l] =
        mode === 'normal' || mode === 'walls' ? 1 : l === hot ? range(this.rng, 1.8, 2.8) : range(this.rng, 0.5, 1.1);
    }
    this.events.emit('trafficMode', { mode, label: MODE_LABEL[mode] });
  }

  private nextMode(): void {
    const t = this.intensity;
    const dense = this.preset === 2;
    const weights: [TrafficMode, number][] = [
      ['normal', 2.5],
      ['sparse', (1.2 - 0.6 * t) * (dense ? 0.35 : 1)],
      ['dense', 1 + 1.2 * t + (dense ? 0.8 : 0)],
      ['trucks', 1.1],
      ['walls', 0.8 + 1 * t + (dense ? 0.4 : 0)],
      ['platoons', 1 + (dense ? 0.5 : 0)],
    ];
    let total = 0;
    for (const [m, w] of weights) if (m !== this.mode) total += w;
    let x = this.rng() * total;
    let next: TrafficMode = 'normal';
    for (const [m, w] of weights) {
      if (m === this.mode) continue;
      x -= w;
      if (x <= 0) {
        next = m;
        break;
      }
    }
    this.setMode(next);
  }
}

const TRUCK_CONVOY_LANES = [1, 2, 3];
