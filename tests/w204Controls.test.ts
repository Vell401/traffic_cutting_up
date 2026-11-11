import { describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/sim/vehicle';
import { W204Car } from '../src/sim/vehicleW204';
import { MercedesCar } from '../src/sim/vehicleMercedes';
import { PorscheCar } from '../src/sim/vehiclePorsche';
import { DriftCar } from '../src/sim/vehicleDrift';

const DT = 1 / 120;
const run = (car: DriftCar, input: DriveInput, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    car.d = car.prevD = 0; // open plane: no barrier impulse may masquerade as recovery
    car.step(DT, input, 0);
  }
};

class UnassistedW204 extends W204Car {
  protected override assistedSteerAngle(_dt: number, _input: DriveInput, angle: number): number { return angle; }
}

const slide = (car: DriftCar, side: number) => {
  car.reset(0, 0, 25);
  car.gear = 2;
  car.vy = -side * 8;
  car.r = side * .7;
  return car;
};

describe('C63 controls', () => {
  it('retains automatic parking: holding S selects R and drives backwards, W stops and returns to first', () => {
    const car = new W204Car(); car.reset(0, 0, 0);
    run(car, { steer: 0, throttle: 0, brake: 1 }, 1.5);
    expect(car.gear).toBe(0);
    expect(car.vx).toBeLessThan(-3);
    run(car, { steer: 0, throttle: 1, brake: 0 }, 1);
    expect(car.gear).toBeGreaterThan(0);
    expect(car.vx).toBeGreaterThan(0);
  });

  for (const side of [-1, 1]) {
    it(`countersteers a ${side < 0 ? 'left' : 'right'} keyboard slide even with the keys released`, () => {
      const car = slide(new W204Car(), side);
      car.step(DT, { steer: 0, throttle: 0, brake: 0, espEnabled: false }, 0);
      expect(car.steerIn).toBe(0);
      expect(car.steerAngle * side).toBeLessThan(0);
      expect(Math.abs(car.steerAngle)).toBeLessThanOrEqual(car.tune.maxSteerLow * 4 * DT);
    });

    it(`reduces a ${side < 0 ? 'left' : 'right'} slide through tyre steering with ESP switched off`, () => {
      const car = slide(new W204Car(), side), raw = slide(new UnassistedW204(), side);
      const input = { steer: 0, throttle: 0, brake: 0, espEnabled: false, tractionControlEnabled: false };
      run(car, input, 1);
      run(raw, input, 1);
      expect(Math.abs(Math.atan2(car.vy, car.vx))).toBeLessThan(Math.abs(Math.atan2(raw.vy, raw.vx)));
      expect(Math.abs(car.r)).toBeLessThan(Math.abs(raw.r));
    });

    it(`catches a naturally initiated ${side < 0 ? 'left' : 'right'} handbrake slide with keyboard countersteer`, () => {
      const car = new W204Car(); car.reset(0, 0, 25); car.gear = 2;
      let peakSlip = 0, heldCountersteer = 0;
      for (let i = 0; i < 360; i++) {
        car.d = car.prevD = 0;
        car.step(DT, { steer: i < 90 ? side : 0, throttle: i < 90 ? 1 : 0, brake: 0,
          handbrake: i < 90, espEnabled: false, tractionControlEnabled: false }, 0);
        peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(car.vy, car.vx)));
        if (i < 90) heldCountersteer = Math.min(heldCountersteer, car.steerAngle * side);
      }
      expect(peakSlip).toBeGreaterThan(.2);
      expect(peakSlip).toBeLessThan(.7);
      // Assist can unwind into the slide even while the initiating direction is still held.
      expect(heldCountersteer).toBeLessThan(-.1);
      expect(Math.abs(Math.atan2(car.vy, car.vx))).toBeLessThan(.02);
      expect(Math.abs(car.r)).toBeLessThan(.03);
      expect(car.speed).toBeGreaterThan(10);
    });
  }

  for (const mode of [{ analog: true }, { analog: true, direct: true }, { direct: true }]) {
    it(`does not countersteer for a direct device (${JSON.stringify(mode)})`, () => {
      const car = slide(new W204Car(), 1);
      car.step(DT, { steer: 0, throttle: 0, brake: 0, ...mode }, 0);
      expect(car.steerAngle).toBe(0);
    });
  }

  it('does not steer towards the road heading, at a standstill, or in reverse', () => {
    const car = new W204Car(); car.reset(0, 0, 40); car.psi = .2;
    run(car, { steer: 0, throttle: .3, brake: 0 }, .5);
    expect(car.steerAngle).toBe(0);
    expect(car.psi).toBeCloseTo(.2, 12);
    car.reset(0, 0, 0); car.vy = .1;
    car.step(DT, { steer: 0, throttle: 0, brake: 0 }, 0);
    expect(car.steerAngle).toBe(0);
    car.reset(0, 0, -2); car.gear = 0; car.vy = 1;
    car.step(DT, { steer: 0, throttle: 0, brake: 0, manual: true }, 0);
    expect(car.steerAngle).toBe(0);
  });

  it('leaves the legacy sedan, A45 and Porsche keyboard steering untouched in a slide', () => {
    for (const car of [new DriftCar(), new MercedesCar(), new PorscheCar()]) {
      slide(car, 1);
      car.step(DT, { steer: 0, throttle: 0, brake: 0 }, 0);
      expect(car.steerAngle).toBe(0);
    }
  });

  it('replays an active countersteer exactly from the existing serialized state', () => {
    const car = slide(new W204Car(), 1);
    run(car, { steer: 0, throttle: .3, brake: 0, espEnabled: false }, .15);
    expect(car.steerAngle).toBeLessThan(0);
    const state = new Float64Array(car.stateSize); car.saveState(state);
    const restored = new W204Car(); restored.loadState(state);
    const input = { steer: 0, throttle: .3, brake: 0, espEnabled: false };
    run(car, input, 2); run(restored, input, 2);
    const a = new Float64Array(car.stateSize), b = new Float64Array(restored.stateSize);
    car.saveState(a); restored.saveState(b);
    expect([...b]).toEqual([...a]);
    expect([...a].every(Number.isFinite)).toBe(true);
  });
});
