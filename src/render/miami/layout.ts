import { mulberry32, range, type Rng } from '../../core/rng';
import { MIAMI_CHUNKS, miamiChunk, miamiZone, type MiamiZone } from '../../sim/miami';
import { CHUNK_LEN } from '../../sim/road';
import { miamiIslandY, miamiIslands, miamiScene, type MiamiIsland, type MiamiSceneId } from './terrain';

/*
 * What stands where along the Miami lap: for every chunk, a list of prototype placements in road
 * coordinates. Pure data from the chunk's canonical lap index, so every client, every lap and the
 * tests see the same city.
 *
 * The heavy modelled kit (hotels, towers, kit palms) is rationed to the front row; the light props
 * (palm groves, trees, villas, shops, beach sets, boats) carry the density.
 */

export interface MiamiPlacement {
  readonly prototype: string;
  /** Chunk-local distance along the road, and lateral offset from its centre line. */
  readonly s: number;
  readonly d: number;
  /** Height above the ground (or water) under it. */
  readonly y: number;
  readonly heading: number;
  readonly scale: number;
  /** sRGB colour multiplying the prototype's paintable surfaces; 0xffffff = as modelled. */
  readonly tint: number;
}

/** Half footprints (across the front, front to back) of everything that fronts the road. */
const FOOTPRINT: Readonly<Record<string, readonly [number, number]>> = {
  hotel_deco: [11.9, 8.6],
  hotel_colonnade: [13.8, 9.3],
  condo_terrace: [15.1, 11.2],
  tower_glass: [14.8, 13.5],
  tower_setback: [14.8, 13.5],
  garage_canopy: [7.9, 5.4],
  villa: [11.8, 6.7],
  shop: [13.3, 8.3],
};
/** Centres of the three building plots of a 100 m block (side streets take the block ends). */
export const MIAMI_PLOTS: readonly number[] = [20, 50, 80];

const HOTEL_TINTS = [0xffffff, 0xffe9d6, 0xe4f4ff, 0xfff3c4, 0xffdfe6, 0xe2ffe9, 0xf4ecff, 0xfff8ef];
const TOWER_TINTS = [0xffffff, 0xe8eef2, 0xf4f0e8, 0xdfe8ee];
const VILLA_TINTS = [0xfff4e2, 0xffe2c4, 0xfbd9c0, 0xfff9f0, 0xf6e7b8, 0xf2d7d0, 0xe9efe2];
const SHOP_TINTS = [0xf26d5b, 0x35b6ad, 0xf2c14e, 0x8a63d2, 0xf28aa8, 0x4a90d9, 0xf4efe6, 0x6cc070, 0xee8a3a];
const BEACH_TINTS = [0x2f8fd6, 0xf2c230, 0xf06a5a, 0xffffff, 0x2fb89a, 0xf08ab0];
const HULL_TINTS = [0xffffff, 0xf4f1e8, 0x23364d, 0xb8312f, 0xffffff, 0xdfe8ee];
const CRANE_TINTS = [0xc9412f, 0x2d6fb3, 0xe0a52a];

type Add = (prototype: string, s: number, d: number, heading?: number, scale?: number, tint?: number, y?: number) => void;

interface Site {
  readonly index: number;
  readonly zone: MiamiZone;
  readonly side: number;
  readonly rng: Rng;
  readonly add: Add;
  /** Front toward the road / away from it, for this side. */
  readonly face: number;
  readonly away: number;
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

/** A building on a plot, its front `front` metres from the road centre. */
function building(site: Site, prototype: string, s: number, front: number, scale: number, tint: number): void {
  if (site.zone.overpass && Math.abs(s - 50) < 34) return;
  site.add(prototype, s, site.side * (front + FOOTPRINT[prototype][1] * scale), site.face, scale, tint);
}

/** Scatter light props over a lateral band, keeping the crossing overpass clear. */
function scatter(site: Site, prototype: string, count: number, dMin: number, dMax: number, scaleMin: number, scaleMax: number, tint = 0xffffff): void {
  for (let n = 0; n < count; n++) {
    const s = range(site.rng, 2, CHUNK_LEN - 2);
    const d = range(site.rng, dMin, dMax);
    const scale = range(site.rng, scaleMin, scaleMax);
    const heading = site.rng() * Math.PI * 2;
    if (site.zone.overpass && Math.abs(s - 50) < 14 && d < 60) continue;
    site.add(prototype, s, site.side * d, heading, scale, tint);
  }
}

/** Evenly spaced row along the road (avenue palms, sidewalk trees). */
function row(site: Site, prototypes: readonly string[], d: number, from: number, step: number, scale = 1, jitter = 1): void {
  let n = 0;
  for (let s = from; s < CHUNK_LEN - 1; s += step, n++) {
    if (site.zone.overpass && Math.abs(s - 50) < 14) continue;
    const prototype = prototypes[(n + site.index) % prototypes.length];
    // Quarter turns: the clearance to the barrier is taken from the full bounding box.
    site.add(prototype, s + range(site.rng, -jitter, jitter), site.side * d, Math.floor(site.rng() * 4) * Math.PI / 2, scale * range(site.rng, 0.9, 1.08));
  }
}

/** Kit palms close to the barrier: the detailed ones, where they are seen best. */
function kitPalms(site: Site, positions: readonly number[], d: number, royal: boolean): void {
  for (const [n, s] of positions.entries()) {
    if (site.zone.overpass && Math.abs(s - 50) < 14) continue;
    site.add(royal || (n + site.index) % 3 === 0 ? 'palm_royal' : 'palm_coconut', s, site.side * d, ((site.index + n) % 4) * Math.PI / 2, 0.88 + ((site.index + n) % 4) * 0.025);
  }
}

function seating(site: Site, d: number, positions: readonly number[], outward: boolean): void {
  for (const s of positions) {
    site.add('bench', s, site.side * d, outward ? site.away : site.face);
    site.add('planter', s + 3.6, site.side * d);
  }
}

const SCENES: Readonly<Record<MiamiSceneId, (site: Site) => void>> = {
  // Ocean side of South Beach: palms in the dunes, rows of club umbrellas, lifeguard stands.
  beach(site) {
    const { index, rng } = site;
    kitPalms(site, [37, 87], 18.4, false);
    row(site, ['palm_lite', 'palm_tall'], 29.2, 6, 12.5, 1, 2);
    scatter(site, 'bush', 7, 27.5, 31.5, 0.8, 1.4);
    seating(site, 23.3, [18, 68], true);
    const colour = BEACH_TINTS[index % BEACH_TINTS.length];
    for (const d of [44, 52, 60, 70]) {
      for (let s = 6 + (d % 8); s < 96; s += 7.5) {
        if (rng() < 0.3) continue;
        site.add('umbrella', s + range(rng, -1, 1), site.side * (d + range(rng, -1.2, 1.2)), rng() * Math.PI * 2, 1, colour);
      }
    }
    if (index % 3 === 1) site.add('lifeguard', 50, site.side * 74, site.away, 1, pick(rng, BEACH_TINTS));
    scatter(site, 'palm_lite', 2, 34, 42, 0.9, 1.1);
    if (index % 2 === 0) site.add('sailboat', range(rng, 10, 90), site.side * range(rng, 190, 330), rng() * Math.PI * 2, range(rng, 0.9, 1.3), pick(rng, HULL_TINTS));
    if (index % 5 === 2) site.add('yacht', 40, site.side * range(rng, 170, 260), rng() * Math.PI * 2, 1.6);
    if (index % 11 === 4) site.add('cruise', 50, site.side * 620, range(rng, -0.2, 0.2), 1, 0xffffff);
  },
  // Hotel side of South Beach: two modelled hotels and a facade block per 100 m, palms on the sidewalk.
  strip(site) {
    const { index, rng } = site;
    kitPalms(site, [12, 62], 17.6, false);
    row(site, ['palm_lite'], 28.4, 9, 14, 1, 1.5);
    const skip = index % 3;
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if (n === skip) continue;
      const kind = (index * 7 + n * 3) % 9;
      const prototype = kind === 0 ? 'condo_terrace' : kind % 2 ? 'hotel_deco' : 'hotel_colonnade';
      building(site, prototype, s, 32, prototype === 'condo_terrace' ? 0.86 : [0.92, 1.04, 0.98][(index + n) % 3], pick(rng, HOTEL_TINTS));
    }
    seating(site, 29.4, [35, 65], false);
    scatter(site, 'bush', 3, 16.2, 17.4, 0.6, 0.9);
    scatter(site, 'palm_lite', 3, 62, 66, 0.9, 1.1);
  },
  // Causeways: boats on the bay; what stands on the islands is added from the island list.
  bay(site) {
    const { index, rng } = site;
    if ((index + (site.side > 0 ? 1 : 0)) % 2 === 0) site.add('sailboat', range(rng, 8, 92), site.side * range(rng, 60, 150), rng() * Math.PI * 2, range(rng, 0.9, 1.4), pick(rng, HULL_TINTS));
    if ((index + (site.side > 0 ? 2 : 0)) % 4 === 0) site.add('yacht', range(rng, 10, 90), site.side * range(rng, 70, 160), rng() * Math.PI * 2, range(rng, 1.2, 1.9));
  },
  // Downtown / Brickell: a modelled tower or hotel per block per side, royal palms, plaza trees.
  towers(site) {
    const { index, rng, side } = site;
    // The people-mover runs over the left plaza: buildings stand back from it.
    const front = side < 0 ? 39 : 33.5;
    kitPalms(site, side > 0 ? [25, 75] : [50], 17.4, true);
    row(site, ['palm_tall', 'palm_lite'], 29.6, 11, 19.5, 1, 1);
    const plot = (index + (side > 0 ? 0 : 1)) % 3;
    const tower = (index + (side > 0 ? 0 : 1)) % 2 === 0;
    if (tower) building(site, (index >> 1) % 2 ? 'tower_glass' : 'tower_setback', MIAMI_PLOTS[plot], front, 0.92 + (index % 3) * 0.04, pick(rng, TOWER_TINTS));
    else building(site, index % 3 ? 'hotel_colonnade' : 'condo_terrace', MIAMI_PLOTS[plot], front, 1.05, pick(rng, TOWER_TINTS));
    if (index % 4 === 2) building(site, 'garage_canopy', MIAMI_PLOTS[(plot + 1) % 3], front + 2, 1, 0xffffff);
    seating(site, 30.6, [44, 94], false);
    scatter(site, 'tree', 2, 76, 80, 0.8, 1);
  },
  // Wynwood: painted low-rise shopfronts, car parks, the odd hotel.
  arts(site) {
    const { index, rng } = site;
    row(site, ['palm_lite', 'tree'], 17.7, 14, 24, 0.8, 1);
    row(site, ['palm_lite'], 28.3, 7, 15, 0.95, 1.5);
    scatter(site, 'bush', 4, 16.2, 17.2, 0.6, 0.9);
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if ((index + n) % 7 === 3) building(site, 'hotel_deco', s, 32, 0.9, pick(rng, SHOP_TINTS));
      else if ((index * 3 + n) % 8 === 5) building(site, 'garage_canopy', s, 33, 1, 0xffffff);
      else building(site, 'shop', s, 31.5, range(rng, 0.92, 1.05), pick(rng, SHOP_TINTS));
    }
    scatter(site, 'tree', 2, 50, 62, 0.7, 0.95);
    scatter(site, 'palm_lite', 2, 66, 71, 0.9, 1.1);
  },
  // Coconut Grove marina: promenade palms, a floating dock with yachts and sloops, moored boats beyond.
  quay(site) {
    const { index, rng, side } = site;
    kitPalms(site, [20, 70], 18.4, false);
    row(site, ['palm_lite'], 21.8, 8, 16, 0.95, 1.5);
    scatter(site, 'bush', 9, 25, 31, 0.8, 1.3);
    site.add('marina_pontoon', 50, side * 53.5, site.face);
    site.add('yacht', 29, side * 61, -0.22, 1.6);
    site.add('yacht', 77, side * 66, 0.15, 1.3);
    site.add('sailboat', 14, side * 58, 0.1, 1, pick(rng, HULL_TINTS));
    site.add('sailboat', 62, side * 59, -0.08, 1.15, pick(rng, HULL_TINTS));
    site.add('sailboat', 91, side * 60, 0.05, 0.95, pick(rng, HULL_TINTS));
    for (const s of [16, 70]) {
      site.add('bench', s, side * 39, site.away);
      site.add('planter', s + 4, side * 38);
    }
    for (const s of [9, 27, 54, 89]) site.add('bollard', s, side * 46);
    for (let n = 0; n < 3; n++) site.add('sailboat', range(rng, 5, 95), side * range(rng, 95, 210), rng() * Math.PI * 2, range(rng, 0.9, 1.3), pick(rng, HULL_TINTS));
    if (index % 3 === 0) site.add('yacht', range(rng, 10, 90), side * range(rng, 110, 190), rng() * Math.PI * 2, 1.8);
  },
  // Grove land side: condominiums in gardens.
  lush(site) {
    const { index, rng } = site;
    kitPalms(site, [25, 75], 18, false);
    row(site, ['tree', 'palm_tall'], 29.5, 12, 22, 0.9, 2);
    if (index % 2 === 0) building(site, 'condo_terrace', 28, 37, 1, pick(rng, HOTEL_TINTS));
    else building(site, index % 3 ? 'hotel_colonnade' : 'hotel_deco', 72, 37, 1.05, pick(rng, HOTEL_TINTS));
    building(site, 'villa', index % 2 === 0 ? 76 : 24, 40, 1.1, pick(rng, VILLA_TINTS));
    scatter(site, 'tree', 5, 84, 150, 0.8, 1.3);
    scatter(site, 'palm_lite', 5, 36, 72, 0.9, 1.15);
    scatter(site, 'tree', 4, 160, 300, 1, 1.6);
  },
  // Key Biscayne ocean side: coastal hammock, then a wild beach.
  dunes(site) {
    const { index, rng } = site;
    kitPalms(site, [30, 80], 18.6, false);
    scatter(site, 'tree', 6, 30, 56, 0.6, 1);
    scatter(site, 'palm_lite', 7, 28, 62, 0.85, 1.2);
    scatter(site, 'palm_tall', 3, 30, 56, 0.9, 1.1);
    scatter(site, 'bush', 10, 27.5, 60, 0.9, 1.7);
    scatter(site, 'palm_lite', 3, 64, 92, 0.9, 1.2);
    if (index % 2 === 0) {
      const colour = pick(rng, BEACH_TINTS);
      for (let n = 0; n < 6; n++) site.add('umbrella', 20 + n * 11 + range(rng, -2, 2), site.side * range(rng, 78, 92), rng() * Math.PI * 2, 1, colour);
    }
    if (index % 6 === 3) site.add('lifeguard', 50, site.side * 96, site.away, 1, pick(rng, BEACH_TINTS));
    if (index % 3 === 0) site.add('sailboat', range(rng, 10, 90), site.side * range(rng, 230, 340), rng() * Math.PI * 2, range(rng, 1, 1.4), pick(rng, HULL_TINTS));
  },
  // Key Biscayne land side: golf fairways between palms and shade trees, the odd clubhouse.
  golf(site) {
    const { index, rng } = site;
    kitPalms(site, [5, 55], 18.6, true);
    row(site, ['palm_lite', 'palm_tall'], 22.2, 17, 25, 1, 2);
    scatter(site, 'tree', 6, 34, 120, 0.8, 1.4);
    scatter(site, 'palm_lite', 6, 32, 110, 0.9, 1.2);
    scatter(site, 'tree', 6, 130, 330, 1.1, 1.8);
    scatter(site, 'bush', 5, 30, 60, 1, 1.8);
    if (index % 3 === 0) building(site, 'villa', 50, 62, 1.25, pick(rng, VILLA_TINTS));
  },
  // Coral Gables: villas behind hedges under big trees, a second row beyond the back street.
  villas(site) {
    const { index, rng, side } = site;
    kitPalms(site, (index + (side > 0 ? 0 : 1)) % 2 ? [40, 90] : [15], 17.6, false);
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if ((index + n * 2 + (side > 0 ? 0 : 1)) % 5 === 0) continue;
      building(site, 'villa', s + range(rng, -2, 2), range(rng, 33, 40), range(rng, 0.95, 1.2), pick(rng, VILLA_TINTS));
    }
    for (const s of [24, 76]) building(site, 'villa', s + range(rng, -6, 6), 84, range(rng, 0.95, 1.15), pick(rng, VILLA_TINTS));
    row(site, ['tree', 'palm_lite', 'tree', 'palm_tall'], 28, 5, 15, 0.85, 2);
    scatter(site, 'tree', 5, 56, 70, 0.8, 1.2);
    scatter(site, 'tree', 8, 100, 280, 1, 1.7);
    scatter(site, 'palm_lite', 5, 30, 110, 0.9, 1.2);
    scatter(site, 'bush', 5, 25, 34, 0.9, 1.5);
  },
  // Waterfront parks (Bayfront, Watson Island): lawns under trees, a bay walk, yachts along the seawall.
  park(site) {
    const { index, rng, zone, side } = site;
    kitPalms(site, [20, 70], 18.4, true);
    row(site, ['palm_tall', 'palm_lite'], 24.6, 9, 18, 1, 1.5);
    scatter(site, 'tree', 5, 32, 66, 0.8, 1.25);
    scatter(site, 'palm_lite', 5, 30, 68, 0.9, 1.2);
    scatter(site, 'bush', 6, 28, 68, 0.9, 1.6);
    seating(site, 73, [22, 58], true);
    for (const s of [8, 34, 66, 92]) site.add('bollard', s, side * 82.6);
    if (index % 2 === 0) site.add('yacht', range(rng, 20, 80), side * 93, range(rng, -0.15, 0.15), range(rng, 1.3, 1.8));
    else site.add('sailboat', range(rng, 20, 80), side * 91, range(rng, -0.1, 0.1), 1.1, pick(rng, HULL_TINTS));
    if (zone.district === 'bayfront' && zone.kind === 'open' && zone.index === 11) site.add('wheel', 50, side * 50, site.face);
    if (zone.district === 'watson' && zone.index === 3) building(site, 'garage_canopy', 50, 40, 1.2, 0xffffff);
    for (let n = 0; n < 2; n++) site.add('sailboat', range(rng, 5, 95), side * range(rng, 130, 240), rng() * Math.PI * 2, range(rng, 0.9, 1.3), pick(rng, HULL_TINTS));
  },
  hill() {},
};

/** True where an island is at its full height at (lap distance, lateral offset). */
const onTop = (island: MiamiIsland, s: number, d: number, margin = 0): boolean =>
  miamiIslandY(island, s, d) >= island.top - 1e-6 && (!margin || (miamiIslandY(island, s, d - margin) >= island.top - 1e-6 && miamiIslandY(island, s, d + margin) >= island.top - 1e-6));

/** What stands on the part of an island inside this chunk. */
function islandLife(index: number, island: MiamiIsland, add: Add): void {
  const rng = mulberry32((Math.imul(index + 1, 0x85ebca6b) ^ Math.round(island.s * 31 + island.d)) >>> 0);
  const lap0 = index * CHUNK_LEN;
  const side = Math.sign(island.d);
  const face = side * Math.PI / 2;
  const tryAdd = (prototype: string, s: number, d: number, heading: number, scale: number, tint = 0xffffff, margin = 0): boolean => {
    if (!onTop(island, lap0 + s, d, margin)) return false;
    add(prototype, s, d, heading, scale, tint);
    return true;
  };
  const anywhere = (prototype: string, count: number, scaleMin: number, scaleMax: number, spread = 0.8, tint = 0xffffff) => {
    for (let n = 0; n < count; n++) {
      tryAdd(prototype, range(rng, 2, 98), island.d + range(rng, -spread, spread) * island.w, rng() * Math.PI * 2, range(rng, scaleMin, scaleMax), tint);
    }
  };
  switch (island.kind) {
    case 'villas':
      // Waterfront houses along the road-facing shore, gardens behind.
      for (const s of [18, 50, 82]) tryAdd('villa', s + range(rng, -4, 4), island.d - side * island.w * 0.42, face, range(rng, 1.1, 1.4), pick(rng, VILLA_TINTS), 9);
      for (const s of [34, 66]) tryAdd('villa', s + range(rng, -4, 4), island.d + side * island.w * 0.3, face, range(rng, 1, 1.3), pick(rng, VILLA_TINTS), 9);
      anywhere('palm_lite', 9, 0.9, 1.3);
      anywhere('palm_tall', 4, 0.9, 1.2);
      anywhere('tree', 4, 0.8, 1.2, 0.6);
      break;
    case 'port': {
      // Gantry cranes on the quay facing the channel, container stacks behind, a ship alongside.
      const quay = island.d - side * (island.w * 0.5);
      for (const s of [25, 75]) tryAdd('crane', s, quay, face, 1, pick(rng, CRANE_TINTS));
      for (let n = 0; n < 5; n++) {
        tryAdd('containers', 10 + n * 20 + range(rng, -3, 3), island.d + side * range(rng, -0.1, 0.5) * island.w, face + (rng() < 0.5 ? 0 : Math.PI / 2), 1, 0xffffff, 6);
      }
      if (index % 4 === 1 && Math.abs(lap0 + 50 - island.s) < island.len - 220) add('cruise', 50, island.d - side * (island.w + 34), 0, 1, 0xffffff);
      break;
    }
    case 'beach': {
      // Roadside beach of the causeway: palms and a line of umbrellas, well clear of the deck.
      const colour = pick(rng, BEACH_TINTS);
      for (let s = 6; s < 96; s += 12) tryAdd('palm_lite', s + range(rng, -3, 3), island.d + range(rng, -3, 3), rng() * Math.PI * 2, range(rng, 0.85, 1.1));
      for (let s = 10; s < 96; s += 9) if (rng() < 0.7) tryAdd('umbrella', s + range(rng, -2, 2), island.d + side * range(rng, 1, 6), rng() * Math.PI * 2, 1, colour);
      break;
    }
    case 'mangrove':
      anywhere('bush', 16, 1.6, 3.2, 0.85);
      anywhere('tree', 4, 0.5, 0.8, 0.6);
      break;
    case 'park':
      anywhere('tree', 8, 0.8, 1.4, 0.75);
      anywhere('palm_lite', 9, 0.9, 1.3);
      anywhere('palm_tall', 4, 0.9, 1.2);
      anywhere('bush', 6, 1.2, 2.2);
      break;
    default:
  }
}

const SMALL = new Set(['bench', 'planter', 'bollard', 'hedge', 'bush', 'umbrella']);
const cache = new Map<number, readonly MiamiPlacement[]>();

/** Everything placed in one chunk of the lap (canonical: any lap, any sign of index). */
export function miamiPlacements(index: number): readonly MiamiPlacement[] {
  const i = miamiChunk(index);
  const existing = cache.get(i);
  if (existing) return existing;
  const zone = miamiZone(i);
  const out: MiamiPlacement[] = [];
  const add: Add = (prototype, s, d, heading = 0, scale = 1, tint = 0xffffff, y = 0) => {
    // Behind noise walls only what rises above them is ever seen.
    if (zone.kind === 'walls' && SMALL.has(prototype)) return;
    out.push(Object.freeze({ prototype, s: Math.min(CHUNK_LEN - 0.01, Math.max(0, s)), d, y, heading, scale, tint }));
  };
  if (zone.kind !== 'tunnel') {
    for (const side of [-1, 1]) {
      const rng = mulberry32((Math.imul(i + 1, 0xc2b2ae35) ^ (side > 0 ? 0x27d4eb2f : 0x165667b1)) >>> 0);
      SCENES[miamiScene(i, side).id]({ index: i, zone, side, rng, add, face: side * Math.PI / 2, away: -side * Math.PI / 2 });
    }
    for (const island of miamiIslands(i)) islandLife(i, island, add);
    for (const s of [0, 25, 50, 75]) {
      const side = s % 50 ? -1 : 1;
      if (zone.overpass && s === 50) continue;
      // Streetlight AABB includes its asymmetric arm; base need not equal AABB centre.
      add('streetlight', s, side * 14.2, side * Math.PI / 2);
    }
  }
  const result = Object.freeze(out);
  cache.set(i, result);
  return result;
}

/** Stretches of a chunk's frontage (chunk-local s) taken by modelled buildings on one side. */
export function miamiFrontage(index: number, side: number): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  for (const p of miamiPlacements(index)) {
    const footprint = FOOTPRINT[p.prototype];
    if (!footprint || Math.sign(p.d) !== side || Math.abs(p.d) > 75) continue;
    out.push([p.s - footprint[0] * p.scale, p.s + footprint[0] * p.scale]);
  }
  return out;
}

/** Largest number of instances of each prototype in any window of `span` consecutive chunks. */
export function miamiPeakCounts(span: number): Map<string, number> {
  const perChunk: Map<string, number>[] = [];
  for (let i = 0; i < MIAMI_CHUNKS; i++) {
    const counts = new Map<string, number>();
    for (const p of miamiPlacements(i)) counts.set(p.prototype, (counts.get(p.prototype) ?? 0) + 1);
    perChunk.push(counts);
  }
  const peak = new Map<string, number>();
  for (let i = 0; i < MIAMI_CHUNKS; i++) {
    const window = new Map<string, number>();
    for (let k = 0; k < span; k++) for (const [name, n] of perChunk[(i + k) % MIAMI_CHUNKS]) window.set(name, (window.get(name) ?? 0) + n);
    for (const [name, n] of window) if (n > (peak.get(name) ?? 0)) peak.set(name, n);
  }
  return peak;
}
