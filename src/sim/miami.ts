import type { CurveStep, RoadScript, SectionStep } from './road';

export const MIAMI_LEN = 12000;
export const MIAMI_QUARTER = 3000;

/** Four identical 90° profiles: integral κ ds = 4 × (200 + 1600 + 200)π/4000. */
export function miamiScript(): RoadScript {
  const k = Math.PI / 4000;
  const quarter: CurveStep[] = [
    { len: 600, k0: 0, k1: 0 },
    { len: 400, k0: 0, k1: k },
    { len: 1600, k0: k, k1: k },
    { len: 400, k0: k, k1: 0 },
  ];
  // Coastal Art Deco, causeway, marina, tunnel: each district occupies exactly 30 chunks.
  // Every bridge is approached and left on a viaduct, including across district boundaries.
  const sections: SectionStep[] = [
    { kind: 'open', light: 'led', chunks: 18, gantry: [9] },
    { kind: 'walls', light: 'led', chunks: 6 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'bridge', light: 'led', chunks: 18 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'open', light: 'sodium', chunks: 12, gantry: [5] },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'bridge', light: 'led', chunks: 6 },
    { kind: 'viaduct', light: 'led', chunks: 6 },
    { kind: 'open', light: 'led', chunks: 6 },
    { kind: 'tunnel', light: 'led', chunks: 18 },
    { kind: 'open', light: 'led', chunks: 6 },
  ];
  return { sections, curves: Array.from({ length: 4 }, () => quarter.map(c => ({ ...c }))).flat(), loop: true, ring: true };
}
