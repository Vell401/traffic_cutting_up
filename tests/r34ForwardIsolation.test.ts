import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/sim/vehicle';
import { R34Car, r34Tune } from '../src/sim/vehicleR34';

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

  // Captured BEFORE changing R34's pedal routing. Forward trajectories include steering, shifts,
  // throttle, service/handbraking, clutch and boost, with the complete rewindable physical state.
  for (const [manual, mode, expected] of [
    [false, 'keyboard', 'af4f2fc4b71b8d700373246f09c3d3279f5edfe55d4fa9ff3a482585c00d9be9'],
    [false, 'gamepad', 'd1002da4819b95a972298d60378710e2bcf488334941af6aff40f0f7faa1a307'],
    [false, 'mouse', 'd1002da4819b95a972298d60378710e2bcf488334941af6aff40f0f7faa1a307'],
    [true, 'keyboard', '43162d040b4f36ecd96dd74f3431ad3968ef6d8a49deaab9fcb7b089fd6a2bf7'],
    [true, 'gamepad', '57b94d80fbb04dea79d4af6e79170d270309ce1f1552d9f240b983b408585601'],
    [true, 'mouse', '57b94d80fbb04dea79d4af6e79170d270309ce1f1552d9f240b983b408585601'],
  ] as const) {
    it(`retains the original ${manual ? 'manual' : 'automatic'} ${mode} forward trajectory`, () => {
       const car = new R34Car({ ...structuredClone(r34Tune), gripFront: 1.16, gripRear: .93, longGrip: 1.04 }); car.reset(0, 0, 25);
      const samples: number[][] = [];
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
        if (i % 30 === 0) {
          const state = new Float64Array(car.stateSize); car.saveState(state);
          samples.push([...state].map(x => Math.round(x * 1e8) / 1e8));
        }
      }
      expect(hash(JSON.stringify(samples))).toBe(expected);
      expect(car.speed).toBeGreaterThan(5);
    });
  }
});
