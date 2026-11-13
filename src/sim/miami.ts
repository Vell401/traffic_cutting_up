import type { CurveStep, RoadScript, SectionStep } from './road';

export const MIAMI_LEN = 12000;

export type MiamiDistrict = 'ocean-drive' | 'causeway' | 'marina' | 'downtown';

/** Districts use canonical lap distance, including before spawn and on negative laps. */
export function miamiDistrict(s: number): MiamiDistrict {
  const local = ((s % MIAMI_LEN) + MIAMI_LEN) % MIAMI_LEN;
  if (local < 2200) return 'ocean-drive';
  if (local < 5000) return 'causeway';
  if (local < 8400) return 'marina';
  return 'downtown';
}

/** Each 6 km half turns π: repeating it closes naturally by central symmetry. */
export function miamiScript(): RoadScript {
  const a = 1 / 1500;
  const b = (Math.PI - 1900 * a) / 2400;
  const half: CurveStep[] = [
    { len: 600, k0: 0, k1: 0 },
    { len: 400, k0: 0, k1: a },
    { len: 1500, k0: a, k1: a },
    { len: 400, k0: a, k1: 0 },
    { len: 300, k0: 0, k1: 0 },
    { len: 400, k0: 0, k1: b },
    { len: 2000, k0: b, k1: b },
    { len: 400, k0: b, k1: 0 },
  ];
  // Every bridge is approached and left on a viaduct, including across district boundaries.
  const sections: SectionStep[] = [
    { kind: 'open', light: 'led', chunks: 18, gantry: [9] },
    { kind: 'walls', light: 'led', chunks: 4 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'bridge', light: 'led', chunks: 16 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'open', light: 'sodium', chunks: 14, gantry: [5] },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'bridge', light: 'led', chunks: 8 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'open', light: 'led', chunks: 12 },
    { kind: 'tunnel', light: 'led', chunks: 10 },
    { kind: 'open', light: 'led', chunks: 14 },
  ];
  return { sections, curves: Array.from({ length: 2 }, () => half.map(c => ({ ...c }))).flat(), loop: true, ring: true };
}
