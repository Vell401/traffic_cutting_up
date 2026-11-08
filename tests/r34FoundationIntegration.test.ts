import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chrono from '../src/sim/r34/chronoTMeasy';
import { R34Car, r34Tune } from '../src/sim/vehicleR34';

afterEach(() => vi.restoreAllMocks());
describe('the external TMeasy core is the active R34 force foundation', () => {
  it('actually evaluates the imported core for loaded wheel contacts', () => {
    const probe = vi.spyOn(chrono, 'evaluateTMeasy');
    const car = new R34Car(structuredClone(r34Tune));
    car.reset(0, 0, 25);
    car.step(1 / 120, { steer: 1, throttle: 1, brake: 0 }, 0);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(probe.mock.calls.some(args => args[2] > 1000 && args[3] > 1000)).toBe(true);
  });

  it('cannot retain hidden custom tyre/yaw forces when the imported core returns zero', () => {
    vi.spyOn(chrono, 'evaluateTMeasy').mockReturnValue({ fx: 0, fy: 0, mz: 0, dfxDsx: 0 });
    const car = new R34Car({ ...structuredClone(r34Tune), aeroDrag: 0, rollingRes: 0, engineBrakeNm: 0 });
    car.reset(0, 0, 25);
    car.vy = -3; car.r = .2; car.psi = -.4;
    const before = [car.vAlong, car.vLat, car.r];
    for (let i = 0; i < 60; i++) {
      car.d = car.prevD = 0;
      car.step(1 / 120, { steer: 1, throttle: 1, brake: 0, boost: true }, 0);
    }
    expect(car.vAlong).toBeCloseTo(before[0], 8);
    expect(car.vLat).toBeCloseTo(before[1], 8);
    expect(car.r).toBeCloseTo(before[2], 10);
  });
});
