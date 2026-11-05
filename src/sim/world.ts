import { laneCenter } from '../config';
import { Emitter } from '../core/events';
import type { Rng } from '../core/rng';
import { obbOverlap, type Contact, type OBB } from './collision';
import { Director } from './director';
import type { SimEvents } from './events';
import { Road, type RoadScript } from './road';
import { Scoring } from './scoring';
import { Traffic, type TrafficCar } from './traffic';
import { PlayerCar, type DriveInput } from './vehicle';
import { clamp } from '../core/math';

const START_S = 300;
/** Showcase tracks start close to their beginning. */
const SHOWCASE_START_S = 60;
/** The car is brought to a stop this far before a finite track's end barrier. */
const END_STOP_GAP = 14;

export interface SimOptions {
  /** Start on a finite scripted track (test showcase) instead of the endless road. */
  track?: RoadScript;
}

/** Whole simulation: pure TS, no rendering. Stepped at a fixed rate by the game loop. */
export class Sim {
  readonly events = new Emitter<SimEvents>();
  road: Road;
  readonly player = new PlayerCar();
  readonly traffic: Traffic;
  readonly score: Scoring;
  readonly director: Director;
  time = 0;

  private readonly boxA: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly boxB: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly contact: Contact = { nx: 0, ny: 0, depth: 0 };

  /** The car has been stopped at the end of a finite track. */
  trackEnded = false;

  constructor(
    private readonly rng: Rng = Math.random,
    options: SimOptions = {},
  ) {
    this.road = new Road(rng, options.track);
    this.director = new Director(rng, this.events);
    this.traffic = new Traffic(rng, this.director);
    this.score = new Scoring(this.events);
    this.events.on('runEnd', () => this.director.resetRun());
    const start = options.track ? SHOWCASE_START_S : START_S;
    this.player.reset(start, laneCenter(1), (options.track ? 160 : 100) / 3.6);
    this.road.ensure(start - 300, start + 1700);
    this.traffic.reset(this.player);
  }

  /** Swap in a finite showcase track and put the car at its start. */
  loadTrack(script: RoadScript, kmh = 160): void {
    this.road = new Road(this.rng, script);
    this.road.ensure(0, SHOWCASE_START_S + 1700);
    this.player.reset(SHOWCASE_START_S, laneCenter(1), kmh / 3.6);
    this.trackEnded = false;
    this.traffic.reset(this.player);
    this.score.resetRun();
  }

  /** Put the car back on a lane at the current spot. Counts as the end of the run. */
  respawn(): void {
    const p = this.player;
    this.score.endRun();
    p.reset(p.s, laneCenter(1), 90 / 3.6);
    this.traffic.clearAround(p.s, 120);
  }

  step(dt: number, input: DriveInput): void {
    const p = this.player;
    this.time += dt;
    this.road.ensure(p.s - 300, p.s + 1700);
    const s0 = p.s;
    input = this.endOfTrack(input);
    p.step(dt, input, this.road.curvature(p.s));
    this.director.step(p.s - s0);
    if (p.wallHit) {
      this.events.emit('wallHit', { speed: p.wallImpact });
      this.score.onWall();
    }
    this.traffic.step(dt, p);
    this.collide();
    this.score.step(dt, p, this.traffic);
  }

  private readonly endInput: DriveInput = { steer: 0, throttle: 0, brake: 0 };

  /** Near the end of a finite track: take over the pedals and stop smoothly before the barrier. */
  private endOfTrack(input: DriveInput): DriveInput {
    const end = this.road.endS;
    if (end === Infinity) return input;
    const p = this.player;
    const left = end - END_STOP_GAP - p.s;
    this.traffic.limitS = end - 40;
    const v = Math.max(0, p.vAlong);
    if (left > 15 + (v * v) / (2 * 7)) return input;
    const need = (v * v) / (2 * Math.max(left, 0.5));
    this.endInput.steer = input.steer;
    this.endInput.analog = input.analog;
    this.endInput.throttle = 0;
    this.endInput.brake = left <= 0 ? 1 : clamp(need / (p.tune.brakeDecel * 0.9) + 0.15, 0, 1);
    if (!this.trackEnded && v < 0.5) {
      this.trackEnded = true;
      this.events.emit('trackEnd', {});
    }
    return this.endInput;
  }

  private collide(): void {
    const p = this.player;
    const A = this.boxA;
    A.x = 0;
    A.y = p.d;
    A.hx = p.tune.length / 2;
    A.hy = p.tune.width / 2;
    A.rot = p.psi;
    const B = this.boxB;
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      const ds = c.s - p.s;
      if (Math.abs(ds) > 12) continue;
      B.x = ds;
      B.y = c.d;
      B.hx = c.spec.len / 2;
      B.hy = c.spec.wid / 2;
      B.rot = c.yaw;
      if (obbOverlap(A, B, this.contact)) {
        this.resolve(c);
        A.y = p.d;
      }
    }
  }

  /** Impulse response in the road plane (x along, y across). The hit car turns into a wreck. */
  private resolve(c: TrafficCar): void {
    const p = this.player;
    const n = this.contact;
    const m1 = p.tune.mass;
    const m2 = c.spec.mass;
    const w1 = m2 / (m1 + m2);
    const w2 = m1 / (m1 + m2);

    p.s -= n.nx * n.depth * w1;
    p.d -= n.ny * n.depth * w1;
    c.s += n.nx * n.depth * w2;
    c.d += n.ny * n.depth * w2;

    let pA = p.vAlong;
    let pL = p.vLat;
    const cA = c.v;
    const cL = c.crashed ? c.vd : Math.tan(c.yaw) * c.v;
    const rel = (pA - cA) * n.nx + (pL - cL) * n.ny;
    let newCA = cA;
    let newCL = cL;

    if (rel > 0) {
      const j = (1.25 * rel) / (1 / m1 + 1 / m2);
      pA -= (j * n.nx) / m1;
      pL -= (j * n.ny) / m1;
      newCA = cA + (j * n.nx) / m2;
      newCL = cL + (j * n.ny) / m2;

      // Off-centre contact spins both cars. Contact point ≈ midway between the centres.
      const rx = (c.s - p.s) * 0.5;
      const ry = (c.d - p.d) * 0.5;
      const Jx = -j * n.nx;
      const Jy = -j * n.ny;
      p.r += (rx * Jy - ry * Jx) / (m1 * p.tune.cgToFront * p.tune.cgToRear);
      p.setRoadVelocity(pA, pL);

      const Ic = (m2 * c.spec.len * c.spec.len) / 12;
      c.yawRate += (-rx * -Jy - -ry * -Jx) / Ic + (this.rng() - 0.5) * 0.4;
    }

    if (!c.crashed) {
      c.crashed = true;
      c.crashT = 0;
      c.laneT = -1;
    }
    c.v = Math.max(0, newCA);
    c.vd = newCL;

    if (!c.hit) {
      c.hit = true;
      this.events.emit('crash', { speed: Math.max(rel, 0) });
      this.score.onCrash();
    }
  }
}
