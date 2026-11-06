import type { Rng } from '../core/rng';
import { obbOverlap, type Contact, type OBB } from './collision';
import type { TrafficCar } from './traffic';
import type { PlayerCar } from './vehicle';

/** Closing speed between two drivers that counts as a crash (≈ 29 km/h), m/s; slower is a bump. */
export const DRIVER_CRASH_SPEED = 8;

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

  /**
   * Driver vs driver (online): overlap test, then both cars are pushed apart by mass and exchange an
   * impulse (a little bounce, off-centre hits spin them). Returns the closing speed along the contact
   * normal (m/s, 0 for a resting contact), or -1 without contact. The client's prediction calls it
   * with its own copy of the other car (`b`), so moving `b` only changes that copy.
   */
  collidePair(a: PlayerCar, b: PlayerCar): number {
    const ds = this.rel(b.s, a.s);
    if (Math.abs(ds) > 12) return -1;
    const A = this.boxA;
    A.x = 0;
    A.y = a.d;
    A.hx = a.tune.length / 2;
    A.hy = a.tune.width / 2;
    A.rot = a.psi;
    const B = this.boxB;
    B.x = ds;
    B.y = b.d;
    B.hx = b.tune.length / 2;
    B.hy = b.tune.width / 2;
    B.rot = b.psi;
    if (!obbOverlap(A, B, this.contact)) return -1;

    const n = this.contact;
    const m1 = a.tune.mass;
    const m2 = b.tune.mass;
    const w1 = m2 / (m1 + m2);
    const w2 = m1 / (m1 + m2);
    a.s -= n.nx * n.depth * w1;
    a.d -= n.ny * n.depth * w1;
    b.s += n.nx * n.depth * w2;
    b.d += n.ny * n.depth * w2;

    let aA = a.vAlong;
    let aL = a.vLat;
    let bA = b.vAlong;
    let bL = b.vLat;
    const rel = (aA - bA) * n.nx + (aL - bL) * n.ny;
    if (rel > 0) {
      const j = (1.3 * rel) / (1 / m1 + 1 / m2);
      aA -= (j * n.nx) / m1;
      aL -= (j * n.ny) / m1;
      bA += (j * n.nx) / m2;
      bL += (j * n.ny) / m2;
      // Contact point ≈ midway between the centres; the same torque turns both cars the same way.
      const rx = ds * 0.5;
      const ry = (b.d - a.d) * 0.5;
      const tq = rx * -j * n.ny - ry * -j * n.nx;
      a.r += tq / (m1 * a.tune.cgToFront * a.tune.cgToRear);
      b.r += tq / (m2 * b.tune.cgToFront * b.tune.cgToRear);
      a.setRoadVelocity(aA, aL);
      b.setRoadVelocity(bA, bL);
    }
    return Math.max(rel, 0);
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
