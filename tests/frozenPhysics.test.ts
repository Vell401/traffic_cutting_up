import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultTuning } from '../src/sim/tuning';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Preserve the main checkpoint's presets/equations, not whole-file comments or input plumbing.
 * Manual reverse and C63 keyboard-only rack aid are intentional additions, covered by gearbox /
 * w204Controls / input tests. The hashes below are retained from before those additions. */
const files: Record<string, string> = {
  'src/config.ts': 'c0770d60e5ddb2cce2a732cc01b5211d229234befc3f5e5b715d6119d52f14c8',
  'src/core/math.ts': 'de290ece969c80ca51bc14725f9d2edee9f0eb9b6e9915dfbc5ff18cf607acc1',
  'src/sim/vehicleDrift.ts': '131e11f445b9b76d76890b2a794577efc1baf01effd5316f0793e5a68dff68ad',
  'src/sim/vehicleMercedes.ts': '3d584300c5ab160a71046d68135608a72f5c61aeba023f76bb6ce3e2ef674c94',
  'src/sim/vehiclePorsche.ts': 'f3297996ad65685ba59e0c57213463f06f2a3888a60c9ebc84dc6c770acaad82',
  'src/sim/vehicleW204.ts': 'baaf47bf28637cada440c6495a2d4b7c4c3588289deb83fef3c779e98149cdd0',
  'src/sim/vehicleR34.ts': '9570ef860b4fb031b6dfffbf3ec749b9cac819328197fa5f0ab6bf72bf06504e',
  'src/sim/contact.ts': 'c7916763c20d9e3e1cd86e5b2ad822e71abd7d66ff5f3770c07ad5957b234c19',
  'src/sim/r34/chronoTMeasy.ts': 'cadaa2e3ae1abf2b611780c7e1259853b940d9c8748810488d2f748d79a14077',
  'src/sim/r34/sketchbookSteering.ts': 'b252d5d1a34f62ccc7bd4697dad5173f45ee4283803549e3f48cf7004347fad8',
};

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

/** Strip only the explicitly approved opt-in hook/pedal routing, never body forces or presets. */
function beforeControlFixes(path: string): string {
  let text = source(path);
  if (path.endsWith('/vehicleDrift.ts')) text = text
    .replace('this.assistedSteerAngle(dt, inp, this.steerIn * (this.steerIn > 0 ? lockRight : lockLeft))', 'this.steerIn * (this.steerIn > 0 ? lockRight : lockLeft)')
    .replace('  /** Only variants opting in may add keyboard rack assistance; direct devices retain full authority. */\n  protected assistedSteerAngle(_dt: number, _inp: DriveInput, angle: number): number {\n    return angle;\n  }\n\n', '');
  if (path.endsWith('/vehicleW204.ts')) text = text
    .replace('import { clamp, moveTo }', 'import { clamp }')
    .replace(/  protected override assistedSteerAngle\([\s\S]*?\n  }\n\n/, '');
  if (path.endsWith('/vehicleR34.ts')) text = text.replace(
    '    // Only automatic parking swaps pedals; a selected manual R uses the same W/S as forward gears.\n    const automaticReverse = this.gear === 0 && !this.manual;\n    this.throttle = clamp(automaticReverse ? inp.brake : inp.throttle, 0, 1);\n    this.brake = clamp(automaticReverse ? inp.throttle : inp.brake, 0, 1);',
    '    this.throttle = clamp(this.gear === 0 ? inp.brake : inp.throttle, 0, 1);\n    this.brake = clamp(this.gear === 0 ? inp.throttle : inp.brake, 0, 1);');
  return text;
}

describe('vehicle equations and presets remain frozen outside the requested control fixes', () => {
  it('retains all vehicle equations, shared contacts and the existing non-R34 configuration', () => {
    for (const [path, expected] of Object.entries(files)) {
      const text = beforeControlFixes(path);
      expect(hash(text), path).toBe(expected);
    }
  });

  it('retains the original base forward solver, steering, traction, boost and contact equations', () => {
    const text = source('src/sim/vehicle.ts');
    // Captured from origin/main (53648c9) and verified identical before integrating control fixes.
    for (const [start, end, expected] of [
      ['/** Reverse (gear 0):', '  /**\n   * Steering input ramp', 'cfa335348453b61d8add14a5cd805c4bb232c7ca29b0da6113b7e56442b91741'],
      ['  protected controls(', '  /**\n   * Manual gearbox request', 'b46be8390566645463a50fc0bfde0ae7de5efefa31dcc07dd9c5e79140805a34'],
      ['  protected rampSteer(', '', '31b6cb69703bf8e685316a0784ec14e588f72327d0680f6ab2df24eaccf0f140'],
    ]) {
      const a = text.indexOf(start), b = end ? text.indexOf(end, a) : text.length;
      expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeGreaterThan(a);
      expect(hash(text.slice(a, b)), start).toBe(expected);
    }
  });

  it('retains each shipped vehicle preset, including C63 and the new R34 grip values', () => {
    const expected: Record<string, string> = {
      '1': '69bacd43a311f9bd24b487795a949f11997e09cb365e0ceba92e928adef023eb',
      '2': '4b6ac26f54c7ddf2b38c70402aebd9ee88941be2572626a704b0730df7e02c46',
      '3': '4f9a6dded936a8a433be6df6dbdb3aac17e893304099ea7d6a021c7d34c5bb64',
      '4': 'b9ee089ee5c5afd3875d6898f2a3a8efbf0d7ac2e1af6aeb6b705a0fcc2446e3',
      '5': 'bd97e898b91110abb88331eb103b920ded6cf12ec787845fc164e6a45891f5b7',
    };
    const defaults = defaultTuning();
    for (const [id, value] of Object.entries(expected)) expect(hash(JSON.stringify(defaults.cars[id])), id).toBe(value);
  });
});
