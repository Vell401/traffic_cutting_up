import { ROAD_HALF, SHOULDER } from '../config';
import type { CurveStep, RoadScript, SectionStep } from './road';

/*
 * The online ring: a closed 12 km highway lap shared by every driver on a server.
 *
 * Geometry: three identical 4 km thirds, each turning exactly 120° to the right, so the lap closes by
 * symmetry (the road ends where it started, heading +360°). A third is a straight, a long R≈1300 m
 * sweeper that relaxes to R 2600 m in the middle and tightens again, then a second straight. Every
 * segment length is a whole number of 2 m road samples, so the integrated heading is exact.
 *
 * Sections are scripted (not random) so the lap looks the same to every client and on every lap.
 */

export const RING_THIRD = 4000;
export const RING_LEN = 3 * RING_THIRD;

/** Radius of the wide middle part of each sweeper. */
const R_WIDE = 2600;
/** Length of the main arc; its curvature is solved so that a third turns exactly 120°. */
const MAIN_ARC = 1532;

function third(): CurveStep[] {
  const k2 = 1 / R_WIDE;
  // Turn of the third: k1·(940 + MAIN_ARC) + 500·k2 = 2π/3 (see the segment list below).
  const k1 = ((2 * Math.PI) / 3 - 500 * k2) / (940 + MAIN_ARC);
  const segs: CurveStep[] = [
    { len: 400, k0: 0, k1: 0 },
    { len: 240, k0: 0, k1 },
    { len: MAIN_ARC, k0: k1, k1 },
    { len: 200, k0: k1, k1: k2 },
    { len: 300, k0: k2, k1: k2 },
    { len: 200, k0: k2, k1 },
    { len: 500, k0: k1, k1 },
    { len: 240, k0: k1, k1: 0 },
  ];
  let used = 0;
  for (const s of segs) used += s.len;
  segs.push({ len: RING_THIRD - used, k0: 0, k1: 0 });
  return segs;
}

const SECTIONS: SectionStep[] = [
  { kind: 'walls', light: 'led', chunks: 8, gantry: [4] },
  { kind: 'viaduct', light: 'sodium', chunks: 6, gantry: [3] },
  { kind: 'bridge', light: 'led', chunks: 10 },
  { kind: 'viaduct', light: 'sodium', chunks: 5 },
  { kind: 'open', light: 'sodium', chunks: 12, gantry: [3], overpass: [8] },
  { kind: 'tunnel', light: 'led', chunks: 7 },
  { kind: 'walls', light: 'sodium', chunks: 9, gantry: [5] },
  { kind: 'open', light: 'led', chunks: 10, overpass: [4] },
  { kind: 'viaduct', light: 'led', chunks: 9, gantry: [4] },
  { kind: 'open', light: 'sodium', chunks: 8, gantry: [4] },
  { kind: 'tunnel', light: 'sodium', chunks: 6 },
  { kind: 'walls', light: 'led', chunks: 8, gantry: [3] },
  { kind: 'open', light: 'sodium', chunks: 12, gantry: [6], overpass: [9] },
  { kind: 'tunnel', light: 'led', chunks: 10 },
];

export function ringScript(): RoadScript {
  const t = third();
  return { sections: SECTIONS, curves: [...t, ...t, ...t], loop: true, ring: true };
}

/*
 * Spawn pad (online): numbered places on the right shoulder of the long open straight before the third
 * third (7612–8400 m), front place first. Every driver owns one place: joining puts the car there and
 * R brings it back, standing, ghosted, ready to pull out into the right lane.
 */
export const SPAWN_S = 7800;
export const SPAWN_GAP = 22;
/** On the shoulder: between the edge line and the barrier. */
export const SPAWN_D = ROAD_HALF + SHOULDER / 2;
/** Places drawn on the pad (servers with more drivers queue further back). */
export const SPAWN_PLACES = 5;

/** s (on lap 0) of spawn place i. */
export const spawnS = (i: number): number => SPAWN_S - i * SPAWN_GAP;
