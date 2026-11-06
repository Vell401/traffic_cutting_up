import { afterEach, describe, expect, it } from 'vitest';
import { WALL_D } from '../src/config';
import { PlayerCar, type DriveInput } from '../src/sim/vehicle';
import { DriftCar, driftTune } from '../src/sim/vehicleDrift';
import { MercedesCar, mercedesTune } from '../src/sim/vehicleMercedes';

const DT = 1 / 120;
const DEG = Math.PI / 180;
const kmh = (car: PlayerCar) => car.vAlong * 3.6;
/** Body slip angle, rad. */
const beta = (car: PlayerCar) => Math.atan2(car.vy, Math.max(car.vx, 1));

/**
 * Drives a car with the given input. On a straight road (k = 0) the barriers are the only thing that
 * depends on d, so long manoeuvres are re-centred (an open plane); `offset` keeps the true lateral travel.
 */
class Rig {
  offset = 0;
  constructor(readonly car: PlayerCar) {}

  get dTotal(): number {
    return this.offset + this.car.d;
  }

  run(input: DriveInput, seconds: number, each?: () => void, k = 0): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.car.step(DT, input, k);
      if (k === 0 && Math.abs(this.car.d) > 3) {
        this.offset += this.car.d;
        this.car.d = this.car.prevD = 0;
      }
      each?.();
    }
  }
}

const rig = (car: PlayerCar, speedKmh: number, gear?: number) => {
  car.reset(0, 0, speedKmh / 3.6);
  if (gear) car.gear = gear;
  return new Rig(car);
};

/** F: 90 km/h in 2nd, full right lock and full throttle for 0.6 s. Returns the peak body slip. */
const powerOversteer = (r: Rig, throttle = 1) => {
  let max = 0;
  r.run({ steer: 1, throttle, brake: 0 }, 0.6, () => (max = Math.max(max, Math.abs(beta(r.car)))));
  return max;
};

/** Seconds until |body slip| < limit (or Infinity), tracking the peak on the way. */
const settle = (r: Rig, input: DriveInput, limit: number, maxT = 3) => {
  let t = 0;
  let peak = 0;
  let done = Infinity;
  r.run(input, maxT, () => {
    t += DT;
    peak = Math.max(peak, Math.abs(beta(r.car)));
    if (done === Infinity && Math.abs(beta(r.car)) < limit) done = t;
  });
  return { t: done, peak };
};

const STATE = ['s', 'd', 'psi', 'vx', 'vy', 'r', 'steerIn', 'steerAngle', 'rpm', 'gear', 'accLong', 'accLat', 'omegaR', 'omegaF'] as const;
const finite = (c: DriftCar) => STATE.every((k) => Number.isFinite(c[k]));

describe('DriftCar (physics №2, V8 RWD)', () => {
  const keep = { ...driftTune, gearTopKmh: [...driftTune.gearTopKmh] };
  afterEach(() => Object.assign(driftTune, keep, { gearTopKmh: [...keep.gearTopKmh] }));

  it('A: accelerates like a 375 kW RWD saloon and tops out on aero in 7th', () => {
    const car = new DriftCar();
    const r = rig(car, 0);
    let t = 0;
    let t100 = 0;
    let t200 = 0;
    r.run({ steer: 0, throttle: 1, brake: 0 }, 60, () => {
      t += DT;
      if (!t100 && kmh(car) >= 100) t100 = t;
      if (!t200 && kmh(car) >= 200) t200 = t;
    });
    expect(t100).toBeGreaterThan(3.8);
    expect(t100).toBeLessThan(4.8);
    expect(t200 - t100).toBeGreaterThan(8);
    expect(t200 - t100).toBeLessThan(11);
    expect(kmh(car)).toBeGreaterThan(285);
    expect(kmh(car)).toBeLessThan(310);
    expect(car.gear).toBe(7);
    expect(car.rpm).toBeLessThan(driftTune.redline); // drag-limited, not on the limiter
    expect(Math.abs(car.d)).toBeLessThan(1e-6);
    expect(Math.abs(car.psi)).toBeLessThan(1e-9);
  });

  it('B: brakes 200→100 in about 3 s, straight, and stops without going backwards', () => {
    const car = new DriftCar();
    const r = rig(car, 200);
    let t = 0;
    let t100 = 0;
    let maxPsi = 0;
    // Until the car stops (holding the brake after that engages reverse, tested elsewhere).
    while (car.vx > 0 && t < 10) {
      r.run({ steer: 0, throttle: 0, brake: 1 }, DT);
      t += DT;
      if (!t100 && kmh(car) <= 100) t100 = t;
      maxPsi = Math.max(maxPsi, Math.abs(car.psi));
      expect(car.vx).toBeGreaterThanOrEqual(0);
    }
    expect(t100).toBeGreaterThan(2.6);
    expect(t100).toBeLessThan(3.6);
    expect(maxPsi).toBeLessThan(1 * DEG);
    expect(car.vx).toBe(0);
  });

  it('C: a 1200 m curve at 150 km/h needs a small input; without it the car runs wide (no auto-steer)', () => {
    const k = 1 / 1200;
    const free = rig(new DriftCar(), 150);
    free.run({ steer: 0, throttle: 0.3, brake: 0 }, 3, undefined, k);
    expect(Math.abs(free.car.psi)).toBeGreaterThan(0.05);
    expect(Math.abs(free.car.d)).toBeGreaterThan(2);

    const held = rig(new DriftCar(), 150);
    const input = { steer: 0, throttle: 0.3, brake: 0, analog: true };
    let maxD = 0;
    let sum = 0;
    let n = 0;
    held.run(
      input,
      10,
      () => {
        input.steer = Math.max(-1, Math.min(1, 0.1 - 0.3 * held.car.d - 12 * held.car.psi));
        maxD = Math.max(maxD, Math.abs(held.car.d));
        sum += Math.abs(input.steer);
        n++;
      },
      k,
    );
    expect(maxD).toBeLessThan(1);
    expect(sum / n).toBeLessThan(0.3);
  });

  it('C: keeps its heading on a straight road with the wheel centred', () => {
    const r = rig(new DriftCar(), 200);
    r.car.psi = 0.04;
    r.run({ steer: 0, throttle: 0.4, brake: 0 }, 2);
    expect(r.car.psi).toBeGreaterThan(0.035);
    expect(r.dTotal).toBeGreaterThan(3);
  });

  it('D: a 0.25 s keyboard tap at 220 km/h moves one lane and settles straight', () => {
    const r = rig(new DriftCar(), 220);
    let maxPsi = 0;
    const track = () => (maxPsi = Math.max(maxPsi, Math.abs(r.car.psi)));
    r.run({ steer: 1, throttle: 0.3, brake: 0 }, 0.25, track);
    r.run({ steer: 0, throttle: 0.3, brake: 0 }, 2, track);
    expect(r.dTotal).toBeGreaterThan(2.5);
    expect(r.dTotal).toBeLessThan(6);
    expect(Math.abs(r.car.psi)).toBeLessThan(2 * DEG);
    expect(Math.abs(r.car.r)).toBeLessThan(0.02);
    expect(maxPsi).toBeLessThan(10 * DEG);
  });

  it('E: holding full lock for 1 s at 220 km/h does not spin, and the slip dies after release', () => {
    const r = rig(new DriftCar(), 220);
    let maxB = 0;
    const track = () => (maxB = Math.max(maxB, Math.abs(beta(r.car))));
    r.run({ steer: 1, throttle: 0.5, brake: 0 }, 1, track);
    const atRelease = Math.abs(beta(r.car));
    expect(r.car.r).toBeGreaterThan(0.05); // still carving the turn it was asked for
    r.run({ steer: 0, throttle: 0.5, brake: 0 }, 2, track);
    expect(maxB).toBeLessThan(12 * DEG);
    expect(atRelease).toBeGreaterThan(1 * DEG);
    expect(Math.abs(beta(r.car))).toBeLessThan(0.5 * DEG);
    expect(Math.abs(r.car.r)).toBeLessThan(0.02);
    expect(kmh(r.car)).toBeGreaterThan(180);
  });

  it('F: full throttle in 2nd at 90 km/h steps the tail out 4–15°, unlike physics №1; lifting recovers', () => {
    const r = rig(new DriftCar(), 90, 2);
    let maxKappa = 0;
    let peak = 0;
    r.run({ steer: 1, throttle: 1, brake: 0 }, 0.6, () => {
      maxKappa = Math.max(maxKappa, (r.car as DriftCar).slipRear);
      peak = Math.max(peak, Math.abs(beta(r.car)));
    });
    expect(r.car.gear).toBe(2);
    const rec = settle(r, { steer: 0, throttle: 0, brake: 0 }, 2 * DEG);
    peak = Math.max(peak, rec.peak);

    // Same manoeuvre off throttle, and physics №1 flat out: both stay near the grip-turn slip.
    const coast = powerOversteer(rig(new DriftCar(), 90, 2), 0);
    const grip = powerOversteer(rig(new PlayerCar(), 90, 2));
    expect(peak).toBeGreaterThan(4 * DEG);
    expect(peak).toBeLessThan(15 * DEG);
    expect(maxKappa).toBeGreaterThan(driftTune.slipRatioPeak); // wheelspin is what eats the rear grip
    expect(rec.t).toBeLessThanOrEqual(1.5);
    expect(grip).toBeLessThan(3 * DEG);
    expect(coast).toBeLessThan(peak * 0.6);
  });

  it('G: countersteer kills the slide faster than a centred wheel, and the lock has room for it', () => {
    const neutral = rig(new DriftCar(), 90, 2);
    const counter = rig(new DriftCar(), 90, 2);
    powerOversteer(neutral);
    powerOversteer(counter);
    expect(counter.car.s).toBe(neutral.car.s);

    // Lock while sliding vs the lock the same speed allows when gripping.
    let csLock = 0;
    const tN = settle(neutral, { steer: 0, throttle: 0, brake: 0 }, 2 * DEG).t;
    let t = 0;
    let tC = Infinity;
    counter.run({ steer: -1, throttle: 0, brake: 0 }, 1.5, () => {
      t += DT;
      csLock = Math.max(csLock, -counter.car.steerAngle);
      if (tC === Infinity && Math.abs(beta(counter.car)) < 2 * DEG) tC = t;
    });
    const plain = rig(new DriftCar(), kmh(counter.car));
    plain.run({ steer: -1, throttle: 0, brake: 0 }, 0.5);
    expect(tC).toBeLessThan(tN * 0.8);
    expect(csLock).toBeGreaterThan(-plain.car.steerAngle * 1.2);
  });

  it('never turns the wheel by itself: centred input means a straight front wheel even mid-slide', () => {
    const r = rig(new DriftCar(), 90, 2);
    powerOversteer(r);
    r.run({ steer: 0, throttle: 0, brake: 0 }, 0.1); // key release ramp
    r.run({ steer: 0, throttle: 0, brake: 0 }, 1.5, () => expect(r.car.steerAngle).toBe(0));
  });

  it('H: lifting off mid-corner at 160 km/h tucks the nose in a little, no spin', () => {
    for (const steer of [0.6, 1]) {
      const r = rig(new DriftCar(), 160);
      const input = { steer, throttle: 0.5, brake: 0, analog: true };
      r.run(input, 3);
      const r0 = r.car.r;
      let maxR = 0;
      let maxB = 0;
      input.throttle = 0;
      r.run(input, 1.5, () => {
        maxR = Math.max(maxR, r.car.r);
        maxB = Math.max(maxB, Math.abs(beta(r.car)));
      });
      expect(maxR / r0).toBeGreaterThan(1.05);
      expect(maxR / r0).toBeLessThan(1.8);
      expect(maxB).toBeLessThan(8 * DEG);
      expect(r.car.r).toBeGreaterThan(0); // still turning the same way: no spin
    }
  });

  it('trail-braking rotates the car a little; ESP keeps it well short of a spin', () => {
    for (const v of [120, 180, 230]) {
      const r = rig(new DriftCar(), v);
      const input = { steer: 0.7, throttle: 0.3, brake: 0, analog: true };
      r.run(input, 1.5);
      const r0 = r.car.r;
      input.throttle = 0;
      input.brake = 1;
      let maxR = 0;
      let maxB = 0;
      r.run(input, 1.2, () => {
        maxR = Math.max(maxR, r.car.r);
        maxB = Math.max(maxB, Math.abs(beta(r.car)));
      });
      expect(maxR).toBeGreaterThan(r0);
      expect(maxB).toBeLessThan(10 * DEG);
    }
  });

  it('I: is deterministic', () => {
    const a = new DriftCar();
    const b = new DriftCar();
    a.reset(0, 0, 120 / 3.6);
    b.reset(0, 0, 120 / 3.6);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const inp = { steer: 0, throttle: 0, brake: 0, analog: false };
    for (let i = 0; i < 120 * 30; i++) {
      if (i % 25 === 0) {
        const x = rnd();
        inp.steer = x < 0.35 ? -1 : x < 0.7 ? 1 : x < 0.85 ? 0 : rnd() * 2 - 1;
        inp.analog = x >= 0.85;
        inp.throttle = rnd() < 0.6 ? 1 : rnd();
        inp.brake = rnd() < 0.15 ? 1 : 0;
      }
      const k = i % 1500 < 700 ? 1 / 1200 : 0;
      a.step(DT, inp, k);
      b.step(DT, inp, k);
    }
    for (const key of STATE) expect(Object.is(a[key], b[key])).toBe(true);
    expect(finite(a)).toBe(true);
  });

  it('I: four wheel speeds survive exact state continuation', () => {
    const a = rig(new DriftCar(), 90, 2).car as DriftCar;
    for (let i = 0; i < 180; i++) a.step(DT, { steer: 1, throttle: 1, brake: 0 }, 1 / 1500);
    const state = new Float64Array(a.stateSize);
    expect(a.saveState(state)).toBe(a.stateSize);
    const b = new DriftCar();
    expect(b.loadState(state)).toBe(b.stateSize);
    for (let i = 0; i < 240; i++) {
      const input = { steer: Math.sin(i * 0.03), throttle: i % 80 < 50 ? 1 : 0, brake: i % 80 >= 50 ? 0.4 : 0 };
      a.step(DT, input, 1 / 1500);
      b.step(DT, input, 1 / 1500);
    }
    const afterA = new Float64Array(a.stateSize);
    const afterB = new Float64Array(b.stateSize);
    a.saveState(afterA);
    b.saveState(afterB);
    expect([...afterB]).toEqual([...afterA]);
  });

  it('I: no NaN from a standstill, braking to zero and creeping around 2.5 m/s', () => {
    const car = new DriftCar();
    const r = rig(car, 0);
    const check = () => {
      expect(finite(car)).toBe(true);
      expect(car.vx).toBeGreaterThanOrEqual(0);
    };
    r.run({ steer: 1, throttle: 1, brake: 0 }, 5, check);
    for (let i = 0; i < 6 / DT && car.vx > 0; i++) r.run({ steer: -1, throttle: 0, brake: 1 }, DT, check);
    expect(car.vx).toBe(0);
    r.run({ steer: 0, throttle: 0, brake: 0 }, 1, check);
    for (let i = 0; i < 40; i++) {
      r.run({ steer: i % 2 ? 1 : -1, throttle: car.vx < 2.5 ? 0.2 : 0, brake: car.vx > 2.6 ? 0.3 : 0 }, 0.1, check);
    }
    expect(Math.abs(car.vx - 2.5)).toBeLessThan(1.5);
  });

  it('I: is held inside the barriers and reports the hit once', () => {
    const car = new DriftCar();
    car.reset(0, 6, 180 / 3.6);
    let hits = 0;
    for (let i = 0; i < 3 / DT; i++) {
      car.step(DT, { steer: 1, throttle: 1, brake: 0 }, 0);
      if (car.wallHit) hits++;
      expect(car.d + car.halfExtentD()).toBeLessThanOrEqual(WALL_D + 1e-9);
      expect(finite(car)).toBe(true);
    }
    expect(hits).toBe(1);
    expect(car.scrapeSide).toBe(1);
  });

  it('J: step() allocates nothing (source check) and is cheap', () => {
    const proto = DriftCar.prototype as unknown as Record<string, () => void>;
    const base = PlayerCar.prototype as unknown as Record<string, () => void>;
    const hot = ['step', 'substep', 'drivetrain', 'engineTorque', 'axleGrip', 'tire'].map((k) => proto[k]);
    hot.push(base.rampSteer, base.resolveWalls);
    for (const fn of hot) {
      const src = fn.toString();
      const body = src.slice(src.indexOf('{'));
      expect(body).not.toMatch(/\bnew\s|=>|\.\.\.|(?:[=(,:?]|\breturn)\s*[[{]/);
    }

    const car = new DriftCar();
    car.reset(0, 0, 0);
    const inp = { steer: 0, throttle: 1, brake: 0 };
    const n = 120 * 120;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      inp.steer = Math.sin(i * 0.01);
      car.step(DT, inp, 0);
      if (Math.abs(car.d) > 3) car.d = 0;
    }
    const us = ((performance.now() - t0) * 1000) / n;
    expect(us).toBeLessThan(25);
  });

  it('J: wheel slip does not ring at 120 Hz, even without substeps', () => {
    for (const substeps of [driftTune.substeps, 1]) {
      driftTune.substeps = substeps;
      const cases: [number, number, DriveInput][] = [
        [40, 1, { steer: 0, throttle: 1, brake: 0 }], // TC-limited wheelspin
        [90, 2, { steer: 0, throttle: 1, brake: 0 }], // power-limited, below the TC limit
        [90, 2, { steer: 1, throttle: 1, brake: 0 }], // wheelspin in a power slide
        [200, 0, { steer: 0, throttle: 0, brake: 1 }], // ABS / EBD
      ];
      for (const [v, gear, input] of cases) {
        const r = rig(new DriftCar(), v, gear || undefined);
        const car = r.car as DriftCar;
        r.run(input, 0.15);
        let prev = car.slipRear;
        let prevD = 0;
        let flips = 0;
        let jump = 0;
        r.run(input, 0.45, () => {
          const d = car.slipRear - prev;
          if (d * prevD < 0 && Math.abs(d) > 2e-4) flips++;
          jump = Math.max(jump, Math.abs(d));
          prevD = d;
          prev = car.slipRear;
        });
        expect(flips, `ringing at ${v} km/h, ${substeps} substeps`).toBeLessThanOrEqual(1);
        expect(jump).toBeLessThan(0.01);
      }
    }
  });
});

describe('MercedesCar (physics №3, AMG 4MATIC+)', () => {
  it('uses a separate AWD tune and builds speed through eight gears', () => {
    const car = new MercedesCar();
    expect(car.tune).toBe(mercedesTune);
    expect(car.physicsId).toBe(3);
    expect(car.tune.frontDrive).toBeGreaterThan(0);
    const r = rig(car, 0);
    let elapsed = 0;
    let t100 = 0;
    r.run({ steer: 0, throttle: 1, brake: 0 }, 30, () => {
      elapsed += DT;
      if (!t100 && kmh(car) >= 100) t100 = elapsed;
    });
    expect(t100).toBeGreaterThan(2.5);
    expect(t100).toBeLessThan(5.5);
    expect(kmh(car)).toBeGreaterThan(250);
    expect(car.gear).toBe(8);
    expect(finite(car)).toBe(true);
  });
});

describe('lifting off mid-corner (physics №2 and №3)', () => {
  for (const [name, make] of [
    ['V8 RWD', () => new DriftCar()],
    ['AMG 4MATIC+', () => new MercedesCar()],
  ] as const) {
    it(`${name}: the rear stays planted and the line tightens only a little`, () => {
      const r = rig(make(), 140);
      r.run({ steer: 0, throttle: 0.3, brake: 0 }, 1);
      r.run({ steer: 0.45, throttle: 0.45, brake: 0 }, 2);
      const onLine = r.car.r / r.car.vx;
      let tighter = 0;
      let rearSlip = 0;
      r.run({ steer: 0.45, throttle: 0, brake: 0 }, 1, () => {
        tighter = Math.max(tighter, r.car.r / r.car.vx / onLine);
        rearSlip = Math.max(rearSlip, Math.abs((r.car as DriftCar).slipAngleRear));
      });
      // Before the rear tyre retune the A45 tightened by half again and the rear slip angle doubled.
      expect(tighter).toBeLessThan(1.35);
      expect(rearSlip).toBeLessThan(1.5 * DEG);
    });

    it(`${name}: a lane change off the throttle ends pointing straight`, () => {
      const r = rig(make(), 180);
      r.run({ steer: 0, throttle: 0.3, brake: 0 }, 1);
      r.run({ steer: 0.55, throttle: 0, brake: 0 }, 0.3);
      r.run({ steer: -0.55, throttle: 0, brake: 0 }, 0.3);
      r.run({ steer: 0, throttle: 0, brake: 0 }, 1.6);
      expect(Math.abs(r.car.psi)).toBeLessThan(0.4 * DEG);
    });
  }
});
