import type { CurveStep, RoadScript, SectionKind, SectionStep } from './road';

/*
 * Miami: a closed 30 km coastal lap. One lap is a tour of the city, in driving order:
 *
 *   South Beach → MacArthur Causeway (Watson Island in the middle) → Downtown → Port tunnel →
 *   Wynwood → Coconut Grove marina → Rickenbacker Causeway → Key Biscayne → Bear Cut bridge →
 *   Coral Gables → Brickell tunnel → Bayfront → back to South Beach.
 *
 * Geometry: two identical 15 km halves, each turning exactly π. Repeating a half that turns π closes
 * the lap by central symmetry whatever happens inside it, so a half is free to mix long straights,
 * wide sweepers and S-bends. Every segment length is a whole number of 2 m road samples.
 *
 * The lap turns right overall, so the left side (d < 0) is the outside of the ring: ocean and bay.
 */

export const MIAMI_LEN = 30000;
export const MIAMI_CHUNKS = MIAMI_LEN / 100;

export type MiamiDistrict =
  | 'south-beach'
  | 'macarthur'
  | 'watson'
  | 'downtown'
  | 'wynwood'
  | 'grove'
  | 'rickenbacker'
  | 'key-biscayne'
  | 'bear-cut'
  | 'gables'
  | 'bayfront';

interface Stage extends SectionStep {
  district: MiamiDistrict;
}

/** The lap in driving order. Every bridge is entered and left over a viaduct. */
const STAGES: readonly Stage[] = [
  { district: 'south-beach', kind: 'open', light: 'led', chunks: 30, gantry: [13] },

  { district: 'macarthur', kind: 'viaduct', light: 'led', chunks: 5 },
  { district: 'macarthur', kind: 'bridge', light: 'led', chunks: 12 },
  { district: 'macarthur', kind: 'viaduct', light: 'led', chunks: 4 },
  { district: 'watson', kind: 'open', light: 'sodium', chunks: 6 },
  { district: 'macarthur', kind: 'viaduct', light: 'led', chunks: 4 },
  { district: 'macarthur', kind: 'bridge', light: 'led', chunks: 8 },
  { district: 'macarthur', kind: 'viaduct', light: 'led', chunks: 4 },

  { district: 'downtown', kind: 'open', light: 'led', chunks: 10, gantry: [2], overpass: [6] },
  { district: 'downtown', kind: 'walls', light: 'led', chunks: 4 },
  { district: 'downtown', kind: 'open', light: 'led', chunks: 12, gantry: [9], overpass: [3] },
  { district: 'downtown', kind: 'tunnel', light: 'led', chunks: 12 },

  { district: 'wynwood', kind: 'open', light: 'sodium', chunks: 14, gantry: [3], overpass: [9] },
  { district: 'wynwood', kind: 'walls', light: 'sodium', chunks: 5 },
  { district: 'wynwood', kind: 'open', light: 'sodium', chunks: 11, gantry: [6] },

  { district: 'grove', kind: 'open', light: 'led', chunks: 28, gantry: [14] },

  { district: 'rickenbacker', kind: 'viaduct', light: 'led', chunks: 6 },
  { district: 'rickenbacker', kind: 'bridge', light: 'led', chunks: 16 },
  { district: 'rickenbacker', kind: 'viaduct', light: 'led', chunks: 8 },

  { district: 'key-biscayne', kind: 'open', light: 'sodium', chunks: 30, gantry: [16] },

  { district: 'bear-cut', kind: 'viaduct', light: 'led', chunks: 4 },
  { district: 'bear-cut', kind: 'bridge', light: 'led', chunks: 6 },
  { district: 'bear-cut', kind: 'viaduct', light: 'led', chunks: 4 },

  { district: 'gables', kind: 'open', light: 'sodium', chunks: 12, overpass: [7] },
  { district: 'gables', kind: 'walls', light: 'sodium', chunks: 6 },
  { district: 'gables', kind: 'open', light: 'sodium', chunks: 8, gantry: [4] },
  { district: 'bayfront', kind: 'tunnel', light: 'led', chunks: 8 },

  { district: 'bayfront', kind: 'open', light: 'led', chunks: 23, gantry: [5], overpass: [14] },
];

export interface MiamiZone {
  readonly district: MiamiDistrict;
  readonly kind: SectionKind;
  /** Chunk position inside its stage, and the stage length. */
  readonly index: number;
  readonly length: number;
  /** Chunk position inside the whole run of consecutive stages of this district, and that run's length. */
  readonly run: number;
  readonly runLength: number;
  /** A sign gantry / crossing overpass stands in the middle of this chunk. */
  readonly gantry: boolean;
  readonly overpass: boolean;
}

const ZONES: readonly MiamiZone[] = (() => {
  const out: MiamiZone[] = [];
  for (let i = 0; i < STAGES.length; i++) {
    let first = i;
    while (first > 0 && STAGES[first - 1].district === STAGES[i].district) first--;
    let last = i;
    while (last + 1 < STAGES.length && STAGES[last + 1].district === STAGES[i].district) last++;
    let before = 0;
    let runLength = 0;
    for (let k = first; k <= last; k++) {
      if (k < i) before += STAGES[k].chunks;
      runLength += STAGES[k].chunks;
    }
    for (let k = 0; k < STAGES[i].chunks; k++) {
      out.push(Object.freeze({
        district: STAGES[i].district, kind: STAGES[i].kind, index: k, length: STAGES[i].chunks, run: before + k, runLength,
        gantry: !!STAGES[i].gantry?.includes(k), overpass: !!STAGES[i].overpass?.includes(k),
      }));
    }
  }
  if (out.length !== MIAMI_CHUNKS) throw new Error(`Miami lap is ${out.length} chunks, expected ${MIAMI_CHUNKS}`);
  return out;
})();

/** Canonical chunk of the lap for any chunk index, on any positive or negative lap. */
export const miamiChunk = (index: number): number => ((Math.floor(index) % MIAMI_CHUNKS) + MIAMI_CHUNKS) % MIAMI_CHUNKS;

/** What stands at a chunk of the lap. */
export const miamiZone = (index: number): MiamiZone => ZONES[miamiChunk(index)];

/** Districts use canonical lap distance, including before spawn and on negative laps. */
export function miamiDistrict(s: number): MiamiDistrict {
  return ZONES[miamiChunk(Math.floor(s / 100))].district;
}

/** One 15 km half: straights, sweepers and two S-bends, turning exactly π. */
function half(): CurveStep[] {
  const turn = (len: number, k: number, ease: number): CurveStep[] => [
    { len: ease, k0: 0, k1: k },
    { len, k0: k, k1: k },
    { len: ease, k0: k, k1: 0 },
  ];
  const straight = (len: number): CurveStep => ({ len, k0: 0, k1: 0 });
  // Everything except the last sweeper has a round radius; the last one is solved so the half turns π.
  const fixed: CurveStep[] = [
    straight(700),
    ...turn(1300, 1 / 1600, 300),
    straight(500),
    ...turn(500, -1 / 2200, 300),
    straight(600),
    ...turn(1400, 1 / 1400, 400),
    straight(900),
    ...turn(700, 1 / 2600, 300),
    ...turn(400, -1 / 2400, 300),
  ];
  const tail: CurveStep[] = [straight(600), ...turn(300, -1 / 2000, 300), straight(400), ...turn(300, 1 / 2000, 300)];
  const angle = (steps: CurveStep[]) => steps.reduce((sum, c) => sum + c.len * (c.k0 + c.k1) / 2, 0);
  const lastLen = 1100;
  const lastEase = 400;
  const k = (Math.PI - angle(fixed) - angle(tail)) / (lastLen + lastEase);
  const steps = [...fixed, ...turn(lastLen, k, lastEase), ...tail];
  const used = steps.reduce((sum, c) => sum + c.len, 0);
  steps.push(straight(MIAMI_LEN / 2 - used));
  return steps;
}

export function miamiScript(): RoadScript {
  const sections: SectionStep[] = STAGES.map(({ kind, light, chunks, gantry, overpass }) => ({
    kind,
    light,
    chunks,
    ...(gantry ? { gantry: [...gantry] } : {}),
    ...(overpass ? { overpass: [...overpass] } : {}),
  }));
  return { sections, curves: [...half(), ...half()], loop: true, ring: true };
}
