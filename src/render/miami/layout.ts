import { WALL_D } from '../../config';
import { miamiDistrict, miamiScript } from '../../sim/miami';
import type { Road } from '../../sim/road';

export interface MiamiPlacement {
  readonly prototype: string; readonly s: number; readonly d: number; readonly y: number; readonly heading: number; readonly scale: number;
}
export const MIAMI_WATER = -8;
export const MIAMI_SHORE = 98;
export const miamiIndex = (index: number): number => ((index % 120) + 120) % 120;

/** Surface used by production scaffolding AND the feet of the authored models. Flat marina boardwalk
 * beyond 68m avoids burying small furniture in the old single 87m slope. Never changes collision. */
export function miamiGround(road: Road, s: number, d: number): number {
  if (d <= -68 && miamiDistrict(s) === 'marina') return -7;
  if (d < -(WALL_D + 0.55) && miamiDistrict(s) === 'marina') {
    const t = (Math.abs(d) - WALL_D - 0.55) / (68 - WALL_D - 0.55);
    return road.groundY(s) * (1 - t) - 7 * t;
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
      for (const [n, s] of [16, 50, 84].entries()) add((i + n) % 3 ? 'hotel_deco' : 'hotel_colonnade', s, 31 + (n % 2) * 2, faceRoad);
      if (i % 3 === 1) add('garage_canopy', 50, 67, faceRoad);
    } else if (district === 'marina') {
      add('condo_terrace', 23, 40, faceRoad);
      add(i % 2 ? 'hotel_colonnade' : 'hotel_deco', 73, 34, faceRoad);
      add('marina_pontoon', 50, -103.5, faceRoad);
      add('yacht', 34, -113, -0.25);
      add('yacht', 73, -116, 0.12);
      for (const s of [16, 70]) { add('bench', s, -80, -faceRoad); add('planter', s + 4, -78); }
      for (const s of [9, 27, 54, 89]) add('bollard', s, -95);
    } else {
      add(i % 2 ? 'tower_glass' : 'tower_setback', 23, 42, faceRoad);
      add(i % 2 ? 'tower_setback' : 'tower_glass', 76, 55, faceRoad, 0.95);
      if (i % 3 === 0) add('garage_canopy', 52, 31, faceRoad);
    }
    const palmCount = district === 'ocean-drive' ? 3 : 2;
    for (let n = 0; n < palmCount; n++) {
      const s = 8 + n * (82 / (palmCount - 1));
      add((n + i) % 2 ? 'palm_coconut' : 'palm_royal', s, 20, (i + n) * 1.73, 0.95 + (i % 3) * 0.025);
      add('palm_coconut', s + 3, district === 'marina' ? -73 : -24, i * 0.8 + n, 0.92);
    }
    for (const s of [20, 70]) {
      add('bench', s, 17.5, faceRoad); add('planter', s + 3.5, 17.5); add('hedge', s + 9, 17.5, faceRoad);
      if (district !== 'marina') { add('bench', s + 5, -48, -faceRoad); add('planter', s + 9, -49); }
    }
  }
  if (!tunnel) for (const s of [0, 25, 50, 75]) {
    const side = s % 50 ? -1 : 1;
    // Streetlight AABB includes its asymmetric arm; base need not equal AABB centre.
    add('streetlight', s, side * 14.2, side * faceRoad);
  }
  const result = Object.freeze(out); cache.set(i, result); return result;
}
