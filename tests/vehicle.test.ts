import { describe, expect, it } from 'vitest';
import { WALL_D } from '../src/config';
import { PlayerCar, type DriveInput } from '../src/sim/vehicle';

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

  it('brakes to a stop without going backwards', () => {
    const car = new PlayerCar();
    car.reset(0, 0, 200 / 3.6);
    let s = 0;
    const s0 = car.s;
    run(car, { steer: 0, throttle: 0, brake: 1 }, 10, 0, () => {
      expect(car.vx).toBeGreaterThanOrEqual(0);
      s = car.s;
    });
    expect(car.vx).toBe(0);
    expect(s - s0).toBeLessThan(200);
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
    expect(car.wallSide).toBe(1);
  });
});
