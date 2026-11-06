import type { Rng } from '../core/rng';
import { obbOverlap, type Contact, type OBB } from './collision';
import type { TrafficCar } from './traffic';
import type { PlayerCar } from './vehicle';

/** What happened in one car-vs-traffic contact. */
export interface Hit {
  car: TrafficCar;
  /** Closing speed along the contact normal, m/s (0 for a resting contact). */
  speed: number;
  /** First contact with this car (it just became a wreck). */
  first: boolean;
}

/**
 * Driver car vs traffic contacts in the road plane (x along, y across): separating-axis overlap, then an
 * impulse response. The traffic car turns into a wreck. Shared by single player, the online server and
 * the client's prediction (which may leave the traffic car alone and only move its own car).
 */
export class Contacts {
  /** Ring length (online): distances wrap. */
  ringLen = Infinity;

  private readonly boxA: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly boxB: OBB = { x: 0, y: 0, hx: 0, hy: 0, rot: 0 };
  private readonly contact: Contact = { nx: 0, ny: 0, depth: 0 };
  private readonly hit: Hit = { car: null as unknown as TrafficCar, speed: 0, first: false };

  constructor(private readonly rng: Rng) {}

  private rel(a: number, b: number): number {
    const x = a - b;
    const L = this.ringLen;
    return L === Infinity ? x : x - L * Math.round(x / L);
  }

  /**
   * Resolve every overlap between `p` and the active cars. `onHit` runs per contact (the Hit object is
   * reused). With `moveTraffic` false only the driver's car is changed (prediction replays).
   */
  collide(p: PlayerCar, cars: readonly TrafficCar[], onHit: ((h: Hit) => void) | null, moveTraffic = true): void {
    const A = this.boxA;
    A.x = 0;
    A.y = p.d;
    A.hx = p.tune.length / 2;
    A.hy = p.tune.width / 2;
    A.rot = p.psi;
    const B = this.boxB;
    for (const c of cars) {
      if (!c.active) continue;
      const ds = this.rel(c.s, p.s);
      if (Math.abs(ds) > 12) continue;
      B.x = ds;
      B.y = c.d;
      B.hx = c.spec.len / 2;
      B.hy = c.spec.wid / 2;
      B.rot = c.yaw;
      if (obbOverlap(A, B, this.contact)) {
        this.resolve(p, c, moveTraffic, onHit);
        A.y = p.d;
      }
    }
  }

  /** Impulse response. The hit car turns into a wreck. */
  private resolve(p: PlayerCar, c: TrafficCar, moveTraffic: boolean, onHit: ((h: Hit) => void) | null): void {
    const n = this.contact;
    const m1 = p.tune.mass;
    const m2 = c.spec.mass;
    const w1 = m2 / (m1 + m2);
    const w2 = m1 / (m1 + m2);

    p.s -= n.nx * n.depth * w1;
    p.d -= n.ny * n.depth * w1;
    if (moveTraffic) {
      c.s += n.nx * n.depth * w2;
      c.d += n.ny * n.depth * w2;
    }

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
      const rx = this.rel(c.s, p.s) * 0.5;
      const ry = (c.d - p.d) * 0.5;
      const Jx = -j * n.nx;
      const Jy = -j * n.ny;
      p.r += (rx * Jy - ry * Jx) / (m1 * p.tune.cgToFront * p.tune.cgToRear);
      p.setRoadVelocity(pA, pL);

      if (moveTraffic) {
        const Ic = (m2 * c.spec.len * c.spec.len) / 12;
        c.yawRate += (-rx * -Jy - -ry * -Jx) / Ic + (this.rng() - 0.5) * 0.4;
      }
    }

    const first = !c.hit;
    if (moveTraffic) {
      if (!c.crashed) {
        c.crashed = true;
        c.crashT = 0;
        c.laneT = -1;
      }
      c.v = Math.max(0, newCA);
      c.vd = newCL;
      c.hit = true;
    }
    if (onHit) {
      this.hit.car = c;
      this.hit.speed = Math.max(rel, 0);
      this.hit.first = first;
      onHit(this.hit);
    }
  }
}
