import { describe, expect, it } from 'vitest';
import { WALL_D } from '../src/config';
import { REVERSE_MAX, PlayerCar, type DriveInput } from '../src/sim/vehicle';
import { createCar } from '../src/sim/physics';
import { DriftCar } from '../src/sim/vehicleDrift';

const DT = 1 / 120;
const run = (car: PlayerCar, input: DriveInput, seconds: number, k = 0, each?: () => void) => {
  for (let i = 0; i < seconds / DT; i++) {
    car.step(DT, input, k);
    each?.();
  }
};
const kmh = (car: PlayerCar) => car.vAlong * 3.6;

describe('PlayerCar', () => {
  it('accelerates hard and tops out around 300 km/h', () => {
    const car = new PlayerCar();
    car.reset(0, 0, 0);
    run(car, { steer: 0, throttle: 1, brake: 0 }, 6);
    expect(kmh(car)).toBeGreaterThan(100);
    run(car, { steer: 0, throttle: 1, brake: 0 }, 60);
    expect(kmh(car)).toBeGreaterThan(270);
    expect(kmh(car)).toBeLessThan(330);
    expect(car.gear).toBe(6);
    expect(Math.abs(car.d)).toBeLessThan(1e-6);
  });

  it('changes lanes at 250 km/h without exceeding grip or spinning', () => {
    const car = new PlayerCar();
    car.reset(0, 0, 250 / 3.6);
    let maxLat = 0;
    let maxPsi = 0;
    const track = () => {
      maxLat = Math.max(maxLat, Math.abs(car.accLat));
      maxPsi = Math.max(maxPsi, Math.abs(car.psi));
    };
    run(car, { steer: 1, throttle: 0.5, brake: 0 }, 0.6, 0, track);
    run(car, { steer: -1, throttle: 0.5, brake: 0 }, 0.45, 0, track);
    run(car, { steer: 0, throttle: 0.5, brake: 0 }, 1, 0, track);
    expect(car.d).toBeGreaterThan(2.5);
    expect(maxLat).toBeLessThan(1.5 * 9.81);
    expect(maxPsi).toBeLessThan(0.15);
    expect(Math.abs(car.r)).toBeLessThan(0.005); // rotation dies out: stable, no spin
    expect(Number.isFinite(car.s)).toBe(true);
  });

  it('does not steer itself back along the road', () => {
    const car = new PlayerCar();
    car.reset(0, 0, 200 / 3.6);
    car.psi = 0.04;
    run(car, { steer: 0, throttle: 0.4, brake: 0 }, 2);
    expect(car.psi).toBeGreaterThan(0.035);
    expect(car.d).toBeGreaterThan(3);
  });

  it('needs the driver to steer through a curve, and a small input holds it', () => {
    const k = 1 / 1200;
    const free = new PlayerCar();
    free.reset(0, 0, 200 / 3.6);
    run(free, { steer: 0, throttle: 0.4, brake: 0 }, 3, k);
    expect(Math.abs(free.psi)).toBeGreaterThan(0.05);

    const held = new PlayerCar();
    held.reset(0, 0, 200 / 3.6);
    const input = { steer: 0, throttle: 0.4, brake: 0, analog: true };
    let maxD = 0;
    run(held, input, 10, k, () => {
      input.steer = Math.max(-1, Math.min(1, 0.15 - 0.3 * held.d - 12 * held.psi));
      maxD = Math.max(maxD, Math.abs(held.d));
    });
    expect(maxD).toBeLessThan(1);
  });

  it('keeps turning under full throttle (traction control)', () => {
    for (const speed of [80, 120]) {
      const coast = new PlayerCar();
      const power = new PlayerCar();
      coast.reset(0, 0, speed / 3.6);
      power.reset(0, 0, speed / 3.6);
      run(coast, { steer: 1, throttle: 0, brake: 0 }, 1);
      run(power, { steer: 1, throttle: 1, brake: 0 }, 1);
      const slip = Math.abs(Math.atan2(power.vy, power.vx));
      expect(slip).toBeLessThan(0.12); // no power oversteer pivot
      expect(power.d).toBeGreaterThan(coast.d * 0.95);
    }
  });

  it('brakes to a stop without going backwards; still holding the brake then engages reverse', () => {
    const car = new PlayerCar();
    car.reset(0, 0, 200 / 3.6);
    const s0 = car.s;
    const brake = { steer: 0, throttle: 0, brake: 1 };
    let steps = 0;
    while (car.vx > 0 && steps++ < 10 / DT) {
      car.step(DT, brake, 0);
      if (car.gear !== 0) expect(car.vx).toBeGreaterThanOrEqual(0);
    }
    expect(car.vx).toBe(0);
    expect(car.s - s0).toBeLessThan(200);
    run(car, brake, 3);
    expect(car.gear).toBe(0);
    expect(car.vx).toBeLessThan(-3);
    expect(car.vx).toBeGreaterThanOrEqual(-REVERSE_MAX);
    // Throttle stops it and, at a standstill, puts first gear back in.
    run(car, { steer: 0, throttle: 1, brake: 0 }, 3);
    expect(car.gear).toBeGreaterThan(0);
    expect(car.vx).toBeGreaterThan(2);
  });

  it('is held inside the barriers and reports the hit once', () => {
    const car = new PlayerCar();
    car.reset(0, 6, 180 / 3.6);
    let hits = 0;
    run(car, { steer: 1, throttle: 1, brake: 0 }, 3, 0, () => {
      if (car.wallHit) hits++;
      expect(car.d + car.halfExtentD()).toBeLessThanOrEqual(WALL_D + 1e-9);
    });
    expect(hits).toBe(1);
    expect(car.scrapeSide).toBe(1); // rubbing the right barrier (per-step contact flickers)
  });
});

describe('legacy handbrake references, mouse steering and horn', () => {
  for (const id of [1, 2, 3, 4] as const) {
    it(`${id === 2 ? 'legacy V8 reference' : `physics ${id}`}: the handbrake slows the car and lets the rear swing out`, () => {
      // Preserve the old sedan's exact regression; R34's tyre-limited brake/lock/slide laws are
      // tested separately in r34Driving.test.ts and r34ForceAcceptance.test.ts, not against V8 constants.
      const reference = () => id === 2 ? new DriftCar() : createCar(id);
      const make = () => {
        const car = reference();
        car.reset(0, 0, 100 / 3.6);
        run(car, { steer: 0, throttle: 0.3, brake: 0 }, 0.5);
        return car;
      };
      const plain = make();
      const hb = make();
      let yawPlain = 0;
      let yawHb = 0;
      run(plain, { steer: 0.35, throttle: 0, brake: 0 }, 0.7, 0, () => (yawPlain = Math.max(yawPlain, Math.abs(plain.r))));
      run(hb, { steer: 0.35, throttle: 0, brake: 0, handbrake: true }, 0.7, 0, () => (yawHb = Math.max(yawHb, Math.abs(hb.r))));
      expect(hb.handbrake).toBe(true);
      expect(kmh(hb)).toBeLessThan(kmh(plain) - 8);
      expect(yawHb).toBeGreaterThan(yawPlain * 1.15);
      // Held at a standstill it stops the car.
      const stop = reference();
      stop.reset(0, 0, 8);
      run(stop, { steer: 0, throttle: 0, brake: 0, handbrake: true }, 3);
      expect(kmh(stop)).toBeLessThan(1);
    });

    it(`${id === 2 ? 'legacy V8 reference' : `physics ${id}`}: the mouse turns the wheels themselves, full lock at any speed`, () => {
      // The old speed-limited analog-lock comparison is not a law for the new physical
      // R34 rack. Its actual direct-input/factory contract is in r34Input.test.ts.
      const reference = () => id === 2 ? new DriftCar() : createCar(id);
      const keys = reference();
      const mouse = reference();
      keys.reset(0, 0, 200 / 3.6);
      mouse.reset(0, 0, 200 / 3.6);
      keys.step(DT, { steer: 0.5, throttle: 0, brake: 0, analog: true }, 0);
      mouse.step(DT, { steer: 0.5, throttle: 0, brake: 0, analog: true, direct: true }, 0);
      for (let i = 0; i < 30; i++) {
        keys.step(DT, { steer: 0.5, throttle: 0, brake: 0, analog: true }, 0);
        mouse.step(DT, { steer: 0.5, throttle: 0, brake: 0, analog: true, direct: true }, 0);
      }
      expect(mouse.steerAngle).toBeCloseTo(0.5 * mouse.tune.maxSteerLow, 3);
      expect(keys.steerAngle).toBeLessThan(mouse.steerAngle / 3);
    });
  }

  it('the horn is just a flag on the car', () => {
    const car = createCar(1);
    car.reset(0, 0, 20);
    car.step(DT, { steer: 0, throttle: 0, brake: 0, horn: true }, 0);
    expect(car.horn).toBe(true);
    car.step(DT, { steer: 0, throttle: 0, brake: 0 }, 0);
    expect(car.horn).toBe(false);
  });
});
