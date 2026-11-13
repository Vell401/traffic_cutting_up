import { miamiDistrict, miamiScript } from '../../sim/miami';
import type { Road } from '../../sim/road';

export interface MiamiPlacement {
  readonly prototype: string; readonly s: number; readonly d: number; readonly y: number; readonly heading: number; readonly scale: number;
}
// Visual bay elevations only: a low coastal road must reveal its docks over the
// unchanged safety barrier. The old -8m basin hid even real deck/hull geometry.
export const MIAMI_WATER = -3;
export const MIAMI_QUAY = MIAMI_WATER + 0.6;
export const MIAMI_SHORE = 48;
export const MIAMI_BOARDWALK = 32;
export const MIAMI_UPPER_PATH = 24;
export const miamiIndex = (index: number): number => ((index % 120) + 120) % 120;

/** Shared with production scaffolding: upper promenade, planted bank, lower boardwalk.
 * The basin is deliberately near enough to read from the road. Never changes collision. */
export function miamiGround(road: Road, s: number, d: number): number {
  if (d <= -MIAMI_BOARDWALK && miamiDistrict(s) === 'marina') return MIAMI_QUAY;
  if (d < -MIAMI_UPPER_PATH && miamiDistrict(s) === 'marina') {
    const t = (Math.abs(d) - MIAMI_UPPER_PATH) / (MIAMI_BOARDWALK - MIAMI_UPPER_PATH);
    return road.groundY(s) * (1 - t) + MIAMI_QUAY * t;
  }
  return road.groundY(s);
}

const cache = new Map<number, readonly MiamiPlacement[]>();
const sections = miamiScript().sections.flatMap(section => Array.from({ length: section.chunks }, () => section.kind));
/** Canonical local-s descriptors, not objects or requests. Detailed frontage is continuous, while
 * courtyards, tower podiums, marina and open bridge banks have different scale/rhythm. */
export function miamiPlacements(index: number): readonly MiamiPlacement[] {
  const i = miamiIndex(index), existing = cache.get(i); if (existing) return existing;
  const district = miamiDistrict(i * 100), out: MiamiPlacement[] = [];
  const add = (prototype: string, s: number, d: number, heading = 0, scale = 1, y = 0) => out.push(Object.freeze({ prototype, s, d, y, heading, scale }));
  const faceRoad = Math.PI / 2; // glTF front -Z rotates toward the road (-X), not away from it.
  // These are the authored route's elevated/tunnel sections, also filtered by actual chunk kind in world.
  const elevated = sections[i] === 'bridge' || sections[i] === 'viaduct', tunnel = sections[i] === 'tunnel';
  if (district === 'causeway' || elevated) {
    if (i % 2 === 0) add(i % 4 ? 'tower_setback' : 'tower_glass', 45, -290, -faceRoad, 1.1);
    if (i % 3 === 1) add('yacht', 45, -145, 0.35);
  } else if (!tunnel) {
    if (district === 'ocean-drive') {
      // Composed parcels rather than identical extrusions: lower corner hotels, a recessed
      // colonnade, and a taller blade. Uniform scaling preserves the physical facade details.
      for (const [n, s] of [15, 49, 83].entries()) {
        const variant = (i * 7 + n * 3) % 5;
        add((i + n) % 3 ? 'hotel_deco' : 'hotel_colonnade', s, 29 + variant * 1.7, faceRoad, [0.83, 1.02, 0.92, 1.1, 0.88][variant]);
      }
      if (i % 3 === 1) add('garage_canopy', 48, 61, faceRoad);
    } else if (district === 'marina') {
      add('condo_terrace', 23, 40, faceRoad);
      add(i % 2 ? 'hotel_colonnade' : 'hotel_deco', 73, 34, faceRoad);
      add('marina_pontoon', 50, -(MIAMI_SHORE + 5.5), faceRoad);
      add('yacht', 29, -61, -0.22, 1.6);
      add('yacht', 77, -66, 0.15, 1.3);
      for (const s of [16, 70]) { add('bench', s, -39, -faceRoad); add('planter', s + 4, -38); }
      for (const s of [9, 27, 54, 89]) add('bollard', s, -46);
    } else {
      add(i % 2 ? 'tower_glass' : 'tower_setback', 23, 38 + (i % 3) * 5, faceRoad, 0.87 + (i % 4) * 0.055);
      add(i % 2 ? 'tower_setback' : 'tower_glass', 76, 54 + (i % 4) * 4, faceRoad, 0.82 + (i % 3) * 0.065);
      if (i % 3 === 0) add('garage_canopy', 52, 31, faceRoad);
    }
    const palmCount = district === 'ocean-drive' ? 3 : 2;
    for (let n = 0; n < palmCount; n++) {
      const s = 8 + n * (82 / (palmCount - 1));
      add((n + i) % 2 ? 'palm_coconut' : 'palm_royal', s, 20, (i + n) * 1.73, 0.95 + (i % 3) * 0.025);
      add((i + n) % 3 ? 'palm_coconut' : 'palm_royal', s + 3, -21, i * 0.8 + n, 0.88 + ((i + n) % 4) * 0.035);
    }
    for (const s of [20, 70]) {
      add('bench', s, 17.5, faceRoad); add('planter', s + 3.5, 17.5); add('hedge', s + 9, 17.5, faceRoad);
      add('bench', s + 5, -18.5, -faceRoad); add('planter', s + 9, -19);
      add('hedge', s + 13, -22, faceRoad);
    }
  }
  if (!tunnel) for (const s of [0, 25, 50, 75]) {
    const side = s % 50 ? -1 : 1;
    // Streetlight AABB includes its asymmetric arm; base need not equal AABB centre.
    add('streetlight', s, side * 14.2, side * faceRoad);
  }
  const result = Object.freeze(out); cache.set(i, result); return result;
}
