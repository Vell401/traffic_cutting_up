import { laneCenter } from '../config';
import { Emitter } from '../core/events';
import type { Rng } from '../core/rng';
import { obbOverlap, type Contact, type OBB } from './collision';
import type { SimEvents } from './events';
import { Road } from './road';
import { Scoring } from './scoring';
import { Traffic, type TrafficCar } from './traffic';
import { PlayerCar, type DriveInput } from './vehicle';

const START_S = 300;

/** Whole simulation: pure TS, no rendering. Stepped at a fixed rate by the game loop. */
export class Sim {
  readonly events = new Emitter<SimEvents>();
  readonly road: Road;
  readonly player = new PlayerCar();
  readonly traffic: Traffic;
  readonly score: Scoring;
  time = 0;

  private readonly boxA: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly boxB: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly contact: Contact = { nx: 0, ny: 0, depth: 0 };

  constructor(private readonly rng: Rng = Math.random) {
    this.road = new Road(rng);
    this.traffic = new Traffic(rng);
    this.score = new Scoring(this.events);
    this.player.reset(START_S, laneCenter(1), 100 / 3.6);
    this.road.ensure(START_S - 300, START_S + 1700);
    this.traffic.reset(this.player);
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
    p.step(dt, input, this.road.curvature(p.s));
    if (p.wallHit) {
      this.events.emit('wallHit', { speed: p.wallImpact });
      this.score.onWall();
    }
    this.traffic.step(dt, p);
    this.collide();
    this.score.step(dt, p, this.traffic);
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
