import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultTuning } from '../src/sim/tuning';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** User boundary: only the three requested R34 grip defaults changed from 4d10523.
 * Freeze this checkpoint before the whole-project review and optimization phase.
 * Do not recapture these values merely to accommodate a review/performance edit. */
const files: Record<string, string> = {
  'src/config.ts': '4e428b7fac93dc9d1d9395051af4dc0923569455c87fee1aa4462ee86f89c743',
  'src/core/math.ts': 'de290ece969c80ca51bc14725f9d2edee9f0eb9b6e9915dfbc5ff18cf607acc1',
  'src/sim/vehicle.ts': 'e24c8be0aa3be355a3c1f92c9a63506f0d8ea877acfdad7607341788c95e2718',
  'src/sim/vehicleDrift.ts': '131e11f445b9b76d76890b2a794577efc1baf01effd5316f0793e5a68dff68ad',
  'src/sim/vehicleMercedes.ts': '3d584300c5ab160a71046d68135608a72f5c61aeba023f76bb6ce3e2ef674c94',
  'src/sim/vehiclePorsche.ts': 'f3297996ad65685ba59e0c57213463f06f2a3888a60c9ebc84dc6c770acaad82',
  'src/sim/vehicleW204.ts': 'baaf47bf28637cada440c6495a2d4b7c4c3588289deb83fef3c779e98149cdd0',
  'src/sim/vehicleR34.ts': '9570ef860b4fb031b6dfffbf3ec749b9cac819328197fa5f0ab6bf72bf06504e',
  'src/sim/contact.ts': 'c7916763c20d9e3e1cd86e5b2ad822e71abd7d66ff5f3770c07ad5957b234c19',
  'src/sim/r34/chronoTMeasy.ts': 'cadaa2e3ae1abf2b611780c7e1259853b940d9c8748810488d2f748d79a14077',
  'src/sim/r34/sketchbookSteering.ts': 'b252d5d1a34f62ccc7bd4697dad5173f45ee4283803549e3f48cf7004347fad8',
};

describe('vehicle physics is frozen after the specifically requested R34 grip increase', () => {
  it('retains all vehicle equations, shared contacts and the existing non-R34 configuration', () => {
    for (const [path, expected] of Object.entries(files)) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
      expect(hash(text), path).toBe(expected);
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
