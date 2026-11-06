import { describe, expect, it } from 'vitest';
import { IN_ALL, inputFromQ, quantizeInput, type InputQ } from '../src/online/protocol';
import { createCar } from '../src/sim/physics';
import type { DriveInput, PlayerCar } from '../src/sim/vehicle';

const DT = 1 / 120;
const run = (car: PlayerCar, inp: DriveInput, seconds: number) => {
  for (let i = 0; i < seconds * 120; i++) car.step(DT, inp, 0);
};
const kmh = (car: PlayerCar) => car.vAlong * 3.6;

describe('manual gearbox', () => {
  for (const physics of [1, 2, 3] as const) {
    describe(`physics ${physics}`, () => {
      it('holds the gear flat out and stops at the limiter (the automatic would shift up)', () => {
        const auto = createCar(physics);
        const man = createCar(physics);
        for (const c of [auto, man]) c.reset(0, 0, 40 / 3.6);
        const top2 = man.tune.gearTopKmh[1];
        man.gear = auto.gear = 2;
        run(auto, { steer: 0, throttle: 1, brake: 0 }, 8);
        run(man, { steer: 0, throttle: 1, brake: 0, manual: true }, 8);
        expect(auto.gear).toBeGreaterThan(2);
        expect(man.gear).toBe(2);
        expect(kmh(man)).toBeLessThan(top2 * 1.03);
        expect(man.rpm).toBeLessThanOrEqual(man.tune.redline * 1.03);
        expect(kmh(auto)).toBeGreaterThan(kmh(man));
      });

      it('shifts up and down on request, one gear per request', () => {
        const car = createCar(physics);
        car.reset(0, 0, 60 / 3.6);
        car.gear = 2;
        const inp: DriveInput = { steer: 0, throttle: 0.5, brake: 0, manual: true, shift: 1 };
        car.step(DT, inp, 0);
        expect(car.gear).toBe(3);
        expect(car.shiftT).toBeGreaterThan(0);
        inp.shift = 0;
        run(car, inp, 1);
        expect(car.gear).toBe(3);
        inp.shift = -1;
        car.step(DT, inp, 0);
        expect(car.gear).toBe(2);
        expect(car.shiftRefused).toBe(false);
      });

      it('refuses a downshift that would over-rev the engine', () => {
        const car = createCar(physics);
        const g = car.tune.gearTopKmh;
        const top = g.length;
        car.reset(0, 0, ((g[top - 2] + g[top - 1]) / 2 + 5) / 3.6);
        car.gear = top;
        run(car, { steer: 0, throttle: 0.6, brake: 0, manual: true }, 0.2);
        car.step(DT, { steer: 0, throttle: 0.6, brake: 0, manual: true, shift: -1 }, 0);
        expect(car.gear).toBe(top);
        expect(car.shiftRefused).toBe(true);
      });

      it('a gear far too high pulls weaker than the right one', () => {
        const low = createCar(physics);
        const high = createCar(physics);
        for (const c of [low, high]) c.reset(0, 0, 70 / 3.6);
        // The right gear: the first one that still has room above 110 km/h.
        low.gear = low.tune.gearTopKmh.findIndex((top) => top > 110) + 1;
        high.gear = high.tune.gearTopKmh.length;
        const inp: DriveInput = { steer: 0, throttle: 1, brake: 0, manual: true };
        run(low, inp, 1.5);
        run(high, inp, 1.5);
        expect(kmh(low)).toBeGreaterThan(kmh(high) + 3);
      });
    });
  }
});

describe('input flags', () => {
  it('gearbox mode, shift requests and turn signals survive quantization', () => {
    const q: InputQ = { steer: 0, throttle: 0, brake: 0, flags: 0 };
    const cases: DriveInput[] = [
      { steer: 0.2, throttle: 1, brake: 0, manual: true, shift: 1, blinker: 1 },
      { steer: -1, throttle: 0, brake: 1, manual: false, shift: -1, blinker: 2, analog: true },
      { steer: 0, throttle: 0.5, brake: 0, manual: true, shift: 0, blinker: 0 },
    ];
    for (const c of cases) {
      const back = inputFromQ(quantizeInput(c, q), { steer: 0, throttle: 0, brake: 0 });
      expect(back.manual).toBe(!!c.manual);
      expect(back.shift).toBe(c.shift);
      expect(back.blinker).toBe(c.blinker);
      expect(back.analog).toBe(!!c.analog);
      expect(q.flags & ~IN_ALL).toBe(0);
    }
  });
});
