import { describe, expect, it } from 'vitest';
import { createCar } from '../src/sim/physics';
import { R34Car, r34Tune } from '../src/sim/vehicleR34';

describe('replacement R34 direct steering is distinct from keyboard caster assistance', () => {
  it('keeps the real R34 wired to factory ID 2', () => {
    expect(createCar(2)).toBeInstanceOf(R34Car);
  });
  for (const speed of [0, 25, 45]) for (const mode of ['mouse', 'gamepad'] as const) {
    it(`${mode} commands actual road-wheel angle at ${speed} m/s, not a keyboard yaw demand`, () => {
      const car = new R34Car({ ...structuredClone(r34Tune), aeroDrag: 0, rollingRes: 0,
        engineBrakeNm: 0, gripFront: 0, gripRear: 0 });
      car.reset(0, 0, speed);
      car.vy = 3;
      for (let i = 0; i < 120; i++) {
        car.d = car.prevD = 0;
        car.step(1 / 120, { steer: .5, throttle: 0, brake: 0, analog: true, direct: mode === 'mouse' }, 0);
      }
      expect(car.steerAngle).toBeCloseTo(.5 * car.tune.maxSteerLow, 10);
      // Direct devices deliberately return to their commanded centre, even in a slide.
      for (let i = 0; i < 120; i++) {
        car.d = car.prevD = 0;
        car.step(1 / 120, { steer: 0, throttle: 0, brake: 0, analog: true, direct: mode === 'mouse' }, 0);
      }
      expect(car.steerAngle).toBe(0);
      expect(car.vx).toBeCloseTo(speed, 10);
      expect(car.vy).toBeCloseTo(3, 10);
    });
  }
});
