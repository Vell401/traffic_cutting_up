import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/sim/vehicle';
import { R34Car, r34Tune } from '../src/sim/vehicleR34';
import { legacyForward, steps } from './fixtures/r34ForwardLegacy';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('manual reverse pedal correction does not replace R34 physics', () => {
  it('limits the approved source change to mode-aware pedal routing, retaining the original solver', () => {
    const source = readFileSync(new URL('../src/sim/vehicleR34.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
      // main independently increased only these three defaults. Keep the original solver/source
      // guard without undoing that approved grip upgrade or recapturing a changed solver hash.
      .replace('gripFront: 1.22, gripRear: 1.07, longGrip: 1.10,', 'gripFront: 1.16, gripRear: .93, longGrip: 1.04,');
    // Previous full-source SHA: 7b3bb2f81a1ec6eb44174ee7c5397e09b33a9c22c3c7b9a641fcf819f37bf851.
    // The new SHA approves only the manual/automatic pedal distinction in step(); integrate(),
    // including tyres, steering rack, crank/wheel dynamics and chassis integration, is unchanged.
    expect(hash(source)).toBe('1ac42a32c5bc3f34025be13e922b76acbbc01043a96d62e840c828cd3628e909');
    const solverStart = source.indexOf('  private integrate(');
    expect(solverStart).toBeGreaterThan(0);
    expect(hash(source.slice(solverStart))).toBe('d3960c4f8f1775067798f5b14f4a84ac4a0ea22adb2dcea6f9ab63dc422a11b0');
  });

  // Keep numeric checkpoints from the original pre-change traces. Hashing rounded floats is not
  // portable: Node 22/24 differ by ~1 ulp near a rounding boundary (reproduced even on Windows).
  // Check the complete rewindable state at steering/handbrake/clutch/throttle/braking milestones
  // within 1e-6 absolute units; source/preset SHA guards above and frozenPhysics remain exact.
  for (const [manual, mode, expected] of [
    [false, 'keyboard', legacyForward.autoKeys],
    [false, 'gamepad', legacyForward.autoDirect],
    [false, 'mouse', legacyForward.autoDirect],
    [true, 'keyboard', legacyForward.manualKeys],
    [true, 'gamepad', legacyForward.manualDirect],
    [true, 'mouse', legacyForward.manualDirect],
  ] as const) {
    it(`retains the original ${manual ? 'manual' : 'automatic'} ${mode} forward trajectory`, () => {
      const car = new R34Car({ ...structuredClone(r34Tune), gripFront: 1.16, gripRear: .93, longGrip: 1.04 }); car.reset(0, 0, 25);
      expect(expected).toHaveLength(steps.length);
      let checkpoint = 0;
      for (let i = 0; i < 720; i++) {
        car.d = car.prevD = 0;
        const input: DriveInput = {
          steer: i < 120 ? 0 : i < 180 ? .7 : i < 240 ? -.5 : 0,
          throttle: i < 480 ? .7 : .15, brake: i >= 600 ? .2 : 0,
          clutch: i >= 300 && i < 330, boost: i >= 60 && i < 90,
          handbrake: i >= 240 && i < 252, manual,
          shift: manual ? i === 120 ? 1 : i === 400 ? -1 : 0 : 0,
          analog: mode !== 'keyboard', direct: mode === 'mouse',
        };
        car.step(1 / 120, input, 0);
        expect(car.gear).toBeGreaterThan(0);
        expect(car.throttle).toBe(input.throttle);
        expect(car.brake).toBe(input.brake);
        if (i === steps[checkpoint]) {
          const state = new Float64Array(car.stateSize); car.saveState(state);
          expect(expected[checkpoint]).toHaveLength(state.length);
          for (let j = 0; j < state.length; j++) {
            expect(Number.isFinite(state[j]), `step ${i}, state[${j}]`).toBe(true);
            expect(Math.abs(state[j] - expected[checkpoint][j]), `step ${i}, state[${j}]`).toBeLessThanOrEqual(1e-6);
          }
          checkpoint++;
        }
      }
      expect(checkpoint).toBe(steps.length);
      expect(car.speed).toBeGreaterThan(5);
    });
  }
});
