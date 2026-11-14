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
  tower_round: [18.1, 15.1],
  tower_slab: [17, 12.3],
  tower_deco: [15.4, 12.1],
  garage: [19.5, 15.1],
  cafe: [13.8, 8.8],
  arcade: [15.6, 7.7],
  loft: [13.2, 7.7],
  bungalow: [11.5, 8.7],
  villa_modern: [10.8, 11.4],
};
/** Widest a building may be across its front and still leave its neighbours on the block alone. */
const PLOT_HALF = 14.4;
/** Largest scale at which a prototype fits its plot (never more than `want`). */
const fit = (prototype: string, want = 1): number => Math.min(want, PLOT_HALF / FOOTPRINT[prototype][0]);
/** Centres of the three building plots of a 100 m block (side streets take the block ends). */
export const MIAMI_PLOTS: readonly number[] = [20, 50, 80];

const HOTEL_TINTS = [0xffffff, 0xffe9d6, 0xe4f4ff, 0xfff3c4, 0xffdfe6, 0xe2ffe9, 0xf4ecff, 0xfff8ef];
const TOWER_TINTS = [0xffffff, 0xe8eef2, 0xf4f0e8, 0xdfe8ee];
const VILLA_TINTS = [0xfff4e2, 0xffe2c4, 0xfbd9c0, 0xfff9f0, 0xf6e7b8, 0xf2d7d0, 0xe9efe2];
const SHOP_TINTS = [0xf26d5b, 0x35b6ad, 0xf2c14e, 0x8a63d2, 0xf28aa8, 0x4a90d9, 0xf4efe6, 0x6cc070, 0xee8a3a];
const BEACH_TINTS = [0x2f8fd6, 0xf2c230, 0xf06a5a, 0xffffff, 0x2fb89a, 0xf08ab0];
const HULL_TINTS = [0xffffff, 0xf4f1e8, 0x23364d, 0xb8312f, 0xffffff, 0xdfe8ee];
const CRANE_TINTS = [0xc9412f, 0x2d6fb3, 0xe0a52a];
/** What each flowering plant may bloom in; a placement without a tint of its own takes one of these. */
const BLOOMS: Readonly<Record<string, readonly number[]>> = {
  bloom_tree: [0xff86b4, 0xffd23f, 0xb794f6, 0xffffff, 0xff9a52, 0xff86b4],
  poinciana: [0xff4a1f, 0xff7a1c, 0xffb326, 0xff4a1f],
  bush_flower: [0xff4d6d, 0xff9cc0, 0xffffff, 0xffa63d, 0xffe359, 0xd768ff, 0xff4d6d],
};

/**
 * Out of the detail range (see MIAMI_DETAIL in world.ts): a [stand-in, scale factor] drawn instead,
 * or null for things too small to see from there, which are simply left out (unless scaled up large).
 */
export const MIAMI_FAR_LOD: Readonly<Record<string, readonly [string, number] | null>> = {
  palm_coconut: ['palm_lite', 1],
  palm_royal: ['palm_tall', 1],
  bench: null, planter: null, bollard: null, agave: null, oats: null, banana: null, bush: null, bush_flower: null,
};
const CONDO_TINTS = [0xffffff, 0xf4efe6, 0xe6f0f4, 0xfde7d6, 0xdcefe6, 0xf7e3ea];
const SHIP_TINTS = [0x1f3550, 0x8f2a24, 0x20252b, 0x2f6f62];
const YARD_TINTS = [0xe3b22a, 0xf0f0ea, 0xd9541e];
const SHED_TINTS = [0xdfe3e6, 0xbfd0dc, 0xe8dcc6, 0xc9d8cc];

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
function scatter(site: Site, prototype: string | readonly string[], count: number, dMin: number, dMax: number, scaleMin: number, scaleMax: number, tint = 0xffffff): void {
  for (let n = 0; n < count; n++) {
    const name = typeof prototype === 'string' ? prototype : prototype[Math.floor(site.rng() * prototype.length)];
    const s = range(site.rng, 2, CHUNK_LEN - 2);
    const d = range(site.rng, dMin, dMax);
    const scale = range(site.rng, scaleMin, scaleMax);
    const heading = site.rng() * Math.PI * 2;
    if (site.zone.overpass && Math.abs(s - 50) < 14 && d < 60) continue;
    site.add(name, s, site.side * d, heading, scale, tint);
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
    // One kit species per place (coconut by the water, royal in town): the light palms supply the variety.
    site.add(royal ? 'palm_royal' : 'palm_coconut', s, site.side * d, ((site.index + n) % 4) * Math.PI / 2, 0.88 + ((site.index + n) % 4) * 0.025);
  }
}

function seating(site: Site, d: number, positions: readonly number[], outward: boolean): void {
  for (const s of positions) {
    site.add('bench', s, site.side * d, outward ? site.away : site.face);
    site.add('bush_flower', s + 3.4, site.side * d, 0, 0.7);
  }
}

const SCENES: Readonly<Record<MiamiSceneId, (site: Site) => void>> = {
  // Ocean side of South Beach: palms in the dunes, rows of club umbrellas, lifeguard stands.
  beach(site) {
    const { index, rng } = site;
    kitPalms(site, [37, 87], 18.4, false);
    row(site, ['palm_lite', 'seagrape', 'palm_fan', 'palm_lite', 'palm_tall'], 29.2, 6, 12.5, 1, 2);
    scatter(site, ['bush', 'bush', 'bush_flower'], 7, 27.5, 31.5, 0.8, 1.4);
    scatter(site, 'agave', 3, 16.6, 19, 0.8, 1.3);
    // Sea oats where the dune planting gives way to sand.
    scatter(site, 'oats', 12, 32.5, 41, 0.8, 1.5);
    seating(site, 23.3, [18, 68], true);
    const colour = BEACH_TINTS[index % BEACH_TINTS.length];
    for (const d of [44, 52, 60, 70]) {
      for (let s = 6 + (d % 8); s < 96; s += 7.5) {
        if (rng() < 0.3) continue;
        site.add('umbrella', s + range(rng, -1, 1), site.side * (d + range(rng, -1.2, 1.2)), rng() * Math.PI * 2, 1, colour);
      }
    }
    if (index % 3 === 1) site.add('lifeguard', 50, site.side * 74, site.away, 1, pick(rng, BEACH_TINTS));
    scatter(site, ['palm_lite', 'palm_fan'], 3, 34, 42, 0.9, 1.1);
    if (index % 2 === 0) site.add('sailboat', range(rng, 10, 90), site.side * range(rng, 190, 330), rng() * Math.PI * 2, range(rng, 0.9, 1.3), pick(rng, HULL_TINTS));
    if (index % 5 === 2) site.add('yacht', 40, site.side * range(rng, 170, 260), rng() * Math.PI * 2, 1.6);
    if (index % 11 === 4) site.add('cruise', 50, site.side * 620, range(rng, -0.2, 0.2), 1, 0xffffff);
  },
  // Hotel side of South Beach: two modelled hotels and a facade block per 100 m, palms on the sidewalk.
  strip(site) {
    const { index, rng } = site;
    kitPalms(site, [12, 62], 17.6, false);
    row(site, ['palm_lite', 'palm_date', 'palm_lite', 'bloom_tree', 'palm_tall'], 28.4, 9, 14, 0.95, 1.5);
    const skip = index % 3;
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if (n === skip) {
        // The plot between the hotels: a corner cafe, an arcade of shops, a slim Deco tower.
        const low = ['cafe', 'arcade', 'tower_deco', 'cafe', 'arcade'][index % 5];
        building(site, low, s, low === 'tower_deco' ? 33 : 31.5, low === 'tower_deco' ? range(rng, 0.5, 0.62) : fit(low, range(rng, 0.9, 1.02)), pick(rng, low === 'cafe' ? SHOP_TINTS : HOTEL_TINTS));
        continue;
      }
      const kind = (index * 7 + n * 3) % 9;
      const prototype = kind === 0 ? 'condo_terrace' : kind % 2 ? 'hotel_deco' : 'hotel_colonnade';
      building(site, prototype, s, 32, prototype === 'condo_terrace' ? 0.86 : [0.92, 1.04, 0.98][(index + n) % 3], pick(rng, HOTEL_TINTS));
    }
    seating(site, 29.4, [35, 65], false);
    scatter(site, ['bush_flower', 'bush', 'bush_flower'], 4, 16.2, 17.4, 0.6, 0.9);
    scatter(site, ['palm_lite', 'palm_areca', 'palm_fan'], 4, 62, 66, 0.9, 1.1);
  },
  // Causeways: boats on the bay; what stands on the islands is added from the island list.
  bay(site) {
    const { index, rng } = site;
    if ((index + (site.side > 0 ? 1 : 0)) % 2 === 0) site.add('sailboat', range(rng, 8, 92), site.side * range(rng, 60, 150), rng() * Math.PI * 2, range(rng, 0.9, 1.4), pick(rng, HULL_TINTS));
    if ((index + (site.side > 0 ? 2 : 0)) % 4 === 0) site.add('yacht', range(rng, 10, 90), site.side * range(rng, 70, 160), rng() * Math.PI * 2, range(rng, 1.2, 1.9));
  },
  // Downtown / Brickell: every plot built. One modelled building per side per block, the rest from the
  // light towers (round, slab, stepped Deco), car parks and the odd open plaza, so no two blocks match.
  towers(site) {
    const { index, rng, side } = site;
    // The people-mover runs over the left plaza: buildings stand back from it.
    const front = side < 0 ? 39 : 33.5;
    kitPalms(site, side > 0 ? [25, 75] : [50], 17.4, true);
    row(site, ['palm_tall', 'palm_date', 'palm_lite', 'poinciana', 'palm_tall', 'bloom_tree'], 29.6, 11, 19.5, 0.9, 1);
    scatter(site, ['bush_flower', 'agave', 'bush_flower'], 5, 16.3, 17.6, 0.6, 1);
    const turn = index * 3 + (side > 0 ? 0 : 4);
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if (n === turn % 3) {
        const heavy = ['tower_glass', 'hotel_colonnade', 'tower_setback', 'condo_terrace'][(index + (side > 0 ? 0 : 2)) % 4];
        building(site, heavy, s, front, heavy.startsWith('tower') ? 0.92 + (index % 3) * 0.04 : 0.95, pick(rng, TOWER_TINTS));
        continue;
      }
      // index * 7 walks every residue of 9, so each kind of light tower gets its turn on each plot.
      switch ((index * 7 + n * 4 + (side > 0 ? 0 : 3)) % 9) {
        case 0: case 5:
          building(site, 'tower_slab', s, front, fit('tower_slab', range(rng, 0.66, 0.84)), pick(rng, CONDO_TINTS));
          break;
        case 1: case 6:
          building(site, 'tower_round', s, front, fit('tower_round', range(rng, 0.62, 0.79)), 0xffffff);
          break;
        case 2: case 7:
          building(site, 'tower_deco', s, front, fit('tower_deco', range(rng, 0.7, 0.93)), pick(rng, HOTEL_TINTS));
          break;
        case 3:
          building(site, 'garage', s, front, fit('garage'), pick(rng, TOWER_TINTS));
          break;
        case 4:
          building(site, 'garage_canopy', s, front + 2, 1.2, 0xffffff);
          site.add('poinciana', s - 9, side * (front + 13), 0, 0.9);
          site.add('bloom_tree', s + 10, side * (front + 15), 1.57, 1);
          break;
        default:
          // A pocket plaza under trees.
          for (const [n, [ds, dd]] of [[-8, 6], [0, 13], [8, 7], [-3, 21], [6, 22]].entries()) {
            site.add(dd > 10 ? ['banyan', 'tree', 'poinciana'][(index + n) % 3] : ['palm_date', 'palm_tall'][n % 2], s + ds, side * (front + dd), 0, dd > 10 ? range(rng, 0.6, 0.8) : range(rng, 0.85, 1.1));
          }
          for (const ds of [-11, -4, 4, 11]) site.add('bush_flower', s + ds, side * (front + 1.5), 0, range(rng, 0.8, 1.2));
      }
    }
    seating(site, 30.6, [44, 94], false);
    scatter(site, ['tree', 'bloom_tree', 'palm_date'], 2, 76, 80, 0.8, 1);
  },
  // Wynwood: no two neighbours alike. Painted shopfronts, warehouse lofts with murals, Deco corner cafes,
  // an arcade of shops, the odd forecourt canopy or small hotel.
  arts(site) {
    const { index, rng, side } = site;
    row(site, ['palm_fan', 'tree', 'palm_lite', 'palm_fan'], 17.7, 14, 24, 0.8, 1);
    row(site, ['palm_lite', 'bloom_tree', 'palm_fan', 'palm_lite'], 28.3, 7, 15, 0.95, 1.5);
    scatter(site, ['agave', 'agave', 'bush', 'bush_flower'], 6, 16.2, 17.2, 0.6, 0.95);
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      const kind = (index * 5 + n * 3 + (side > 0 ? 0 : 4)) % 10;
      if (kind === 0) building(site, 'hotel_deco', s, 32, 0.9, pick(rng, HOTEL_TINTS));
      else if (kind === 5) building(site, 'garage_canopy', s, 33, 1, 0xffffff);
      else {
        const low = kind === 2 || kind === 7 ? 'loft' : kind === 3 || kind === 8 ? 'cafe' : kind === 4 ? 'arcade' : 'shop';
        building(site, low, s, 31.5, fit(low, range(rng, 0.92, 1.06)), pick(rng, SHOP_TINTS));
      }
    }
    scatter(site, ['poinciana', 'tree'], 2, 50, 62, 0.7, 0.95);
    scatter(site, ['palm_lite', 'palm_fan', 'palm_areca'], 3, 66, 71, 0.9, 1.1);
  },
  // Coconut Grove marina: promenade palms, a floating dock with yachts and sloops, moored boats beyond.
  quay(site) {
    const { index, rng, side } = site;
    kitPalms(site, [20, 70], 18.4, false);
    row(site, ['palm_lite', 'palm_date', 'palm_lite'], 21.8, 8, 16, 0.9, 1.5);
    scatter(site, ['bush', 'bush_flower', 'banana', 'bush_flower'], 10, 25, 31, 0.8, 1.3);
    scatter(site, 'palm_areca', 2, 26, 30, 0.8, 1);
    site.add('marina_pontoon', 50, side * 53.5, site.face);
    site.add('yacht', 29, side * 61, -0.22, 1.6);
    site.add('yacht', 77, side * 66, 0.15, 1.3);
    site.add('sailboat', 14, side * 58, 0.1, 1, pick(rng, HULL_TINTS));
    site.add('sailboat', 62, side * 59, -0.08, 1.15, pick(rng, HULL_TINTS));
    site.add('sailboat', 91, side * 60, 0.05, 0.95, pick(rng, HULL_TINTS));
    for (const s of [16, 70]) {
      site.add('bench', s, side * 39, site.away);
      site.add('bush_flower', s + 4, side * 38, 0, 0.75);
    }
    for (const s of [9, 27, 54, 89]) site.add('bollard', s, side * 46);
    for (let n = 0; n < 3; n++) site.add('sailboat', range(rng, 5, 95), side * range(rng, 95, 210), rng() * Math.PI * 2, range(rng, 0.9, 1.3), pick(rng, HULL_TINTS));
    if (index % 3 === 0) site.add('yacht', range(rng, 10, 90), side * range(rng, 110, 190), rng() * Math.PI * 2, 1.8);
  },
  // Grove land side: condominiums in gardens.
  lush(site) {
    const { index, rng } = site;
    kitPalms(site, [25, 75], 18, false);
    row(site, ['tree', 'palm_tall', 'bloom_tree', 'palm_date', 'poinciana'], 29.5, 12, 22, 0.85, 2);
    scatter(site, ['banana', 'bush_flower', 'bush'], 5, 26, 33, 0.8, 1.3);
    if (index % 2 === 0) building(site, 'condo_terrace', 28, 37, 1, pick(rng, HOTEL_TINTS));
    else building(site, index % 3 ? 'hotel_colonnade' : 'hotel_deco', 72, 37, 1.05, pick(rng, HOTEL_TINTS));
    building(site, index % 3 === 1 ? 'villa_modern' : index % 3 === 2 ? 'bungalow' : 'villa', index % 2 === 0 ? 76 : 24, 40, 1.1, pick(rng, VILLA_TINTS));
    scatter(site, ['tree', 'banyan', 'poinciana', 'tree'], 5, 84, 150, 0.8, 1.2);
    scatter(site, ['palm_lite', 'palm_areca', 'palm_fan', 'bloom_tree'], 6, 36, 72, 0.9, 1.15);
    scatter(site, ['tree', 'banyan', 'pine'], 4, 160, 300, 1, 1.5);
  },
  // Key Biscayne ocean side: coastal hammock, then a wild beach.
  dunes(site) {
    const { index, rng } = site;
    kitPalms(site, [30, 80], 18.6, false);
    // Coastal hammock: sea grape and Australian pines among the palms, sea oats out on the sand.
    scatter(site, ['seagrape', 'seagrape', 'tree'], 6, 30, 56, 0.7, 1.1);
    scatter(site, 'pine', 4, 32, 56, 0.8, 1.1);
    scatter(site, ['palm_lite', 'palm_fan', 'palm_lite', 'palm_tall'], 9, 28, 62, 0.85, 1.2);
    scatter(site, ['bush', 'bush', 'bush_flower'], 8, 27.5, 60, 0.9, 1.7);
    scatter(site, 'oats', 12, 59, 76, 0.9, 1.6);
    scatter(site, ['palm_lite', 'seagrape', 'palm_fan'], 4, 64, 92, 0.9, 1.2);
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
    row(site, ['palm_lite', 'palm_tall', 'palm_date'], 22.2, 17, 25, 0.95, 2);
    scatter(site, ['tree', 'banyan', 'pine', 'bloom_tree', 'pine'], 7, 36, 120, 0.8, 1.2);
    scatter(site, ['palm_lite', 'palm_date', 'palm_fan'], 6, 32, 110, 0.9, 1.2);
    scatter(site, ['tree', 'pine', 'banyan'], 6, 130, 330, 1.1, 1.6);
    scatter(site, ['bush', 'bush_flower', 'bush_flower'], 6, 30, 60, 1, 1.8);
    // Clubhouses: an arcaded one, a modern one, a villa.
    if (index % 3 === 0) {
      const club = ['arcade', 'villa_modern', 'villa'][(index / 3) % 3];
      building(site, club, 50, 62, club === 'arcade' ? 0.92 : 1.25, pick(rng, VILLA_TINTS));
    }
  },
  // Coral Gables: villas behind hedges under big trees, a second row beyond the back street.
  villas(site) {
    const { index, rng, side } = site;
    kitPalms(site, (index + (side > 0 ? 0 : 1)) % 2 ? [40, 90] : [15], 17.6, false);
    // Three kinds of house, never the same one twice in a row: two-storey villa, tiled bungalow, modern villa.
    const HOUSES = ['villa', 'bungalow', 'villa_modern', 'bungalow', 'villa', 'villa_modern', 'bungalow'];
    for (const [n, s] of MIAMI_PLOTS.entries()) {
      if ((index + n * 2 + (side > 0 ? 0 : 1)) % 5 === 0) continue;
      const house = HOUSES[(index * 2 + n * 3 + (side > 0 ? 0 : 3)) % HOUSES.length];
      building(site, house, s + range(rng, -2, 2), range(rng, 33, 39), fit(house, range(rng, 0.98, 1.2)), pick(rng, VILLA_TINTS));
    }
    for (const [n, s] of [24, 76].entries()) {
      building(site, HOUSES[(index + n * 4 + (side > 0 ? 1 : 0)) % HOUSES.length], s + range(rng, -6, 6), 84, range(rng, 0.95, 1.15), pick(rng, VILLA_TINTS));
    }
    row(site, ['tree', 'palm_lite', 'poinciana', 'palm_tall', 'bloom_tree', 'palm_areca', 'tree'], 28, 5, 15, 0.85, 2);
    scatter(site, ['banyan', 'tree', 'poinciana'], 4, 58, 70, 0.7, 0.95);
    scatter(site, ['tree', 'banyan', 'pine', 'tree'], 8, 100, 280, 1, 1.5);
    scatter(site, ['palm_lite', 'palm_fan', 'palm_date'], 5, 30, 110, 0.9, 1.2);
    scatter(site, ['bush_flower', 'bush', 'banana', 'agave', 'bush_flower'], 8, 25, 34, 0.9, 1.4);
  },
  // Waterfront parks (Bayfront, Watson Island): lawns under trees, a bay walk, yachts along the seawall.
  park(site) {
    const { index, rng, zone, side } = site;
    kitPalms(site, [20, 70], 18.4, true);
    row(site, ['palm_tall', 'palm_date', 'palm_lite'], 24.6, 9, 18, 0.95, 1.5);
    scatter(site, ['tree', 'banyan', 'poinciana', 'bloom_tree', 'bloom_tree'], 5, 34, 64, 0.7, 1);
    scatter(site, ['palm_lite', 'palm_fan', 'palm_date'], 5, 30, 68, 0.9, 1.2);
    scatter(site, ['bush_flower', 'bush', 'bush_flower', 'agave'], 8, 28, 68, 0.9, 1.5);
    seating(site, 73, [22, 58], true);
    for (const s of [8, 34, 66, 92]) site.add('bollard', s, side * 82.6);
    if (index % 2 === 0) site.add('yacht', range(rng, 20, 80), side * 93, range(rng, -0.15, 0.15), range(rng, 1.3, 1.8));
    else site.add('sailboat', range(rng, 20, 80), side * 91, range(rng, -0.1, 0.1), 1.1, pick(rng, HULL_TINTS));
    if (zone.district === 'bayfront' && zone.kind === 'open' && zone.index === 11) site.add('wheel', 50, side * 50, site.face);
    if (zone.district === 'watson' && zone.index === 3) building(site, 'garage_canopy', 50, 40, 1.2, 0xffffff);
    if (zone.district === 'watson' && zone.index === 1 && side > 0) building(site, 'arcade', 50, 42, 0.92, pick(rng, VILLA_TINTS));
    if (zone.district === 'watson' && zone.index === 4 && side < 0) building(site, 'cafe', 50, 40, 1, pick(rng, SHOP_TINTS));
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
      for (const [n, s] of [18, 50, 82].entries()) {
        tryAdd(['villa', 'villa_modern', 'villa', 'bungalow'][(index + n) % 4], s + range(rng, -4, 4), island.d - side * island.w * 0.42, face, range(rng, 1.1, 1.4), pick(rng, VILLA_TINTS), 9);
      }
      for (const [n, s] of [34, 66].entries()) {
        tryAdd(['villa', 'bungalow', 'villa_modern'][(index + n) % 3], s + range(rng, -4, 4), island.d + side * island.w * 0.3, face, range(rng, 1, 1.3), pick(rng, VILLA_TINTS), 9);
      }
      anywhere('palm_lite', 6, 0.9, 1.3);
      anywhere('palm_tall', 3, 0.9, 1.2);
      anywhere('palm_date', 3, 0.9, 1.2);
      anywhere('tree', 2, 0.8, 1.1, 0.6);
      anywhere('bloom_tree', 2, 0.9, 1.2, 0.7);
      anywhere('poinciana', 1, 0.8, 1, 0.6);
      break;
    case 'port': {
      // A working container terminal. `at(t)` is a lateral line on the pier: 1 is the quay edge
      // facing the road, 0 its centre line, -1 the far side.
      const at = (t: number): number => island.d - side * t * island.w;
      const u = (lap0 + 50 - island.s) / island.len;
      // Quay: two ship-to-shore cranes per block, a container ship alongside every third block.
      for (const s of [22, 72]) tryAdd('crane', s, at(0.86), face, 1, pick(rng, CRANE_TINTS), 9);
      if (index % 3 === 0 && Math.abs(u) < 0.72) add('cargo_ship', 50, at(1) - side * 19, index % 2 ? 0 : Math.PI, 1, pick(rng, SHIP_TINTS));
      // Yard: three rows of stacks parallel to the quay, gantries working two of them.
      for (const [n, t] of [0.6, 0.38, 0.16].entries()) for (const s of [25, 75]) tryAdd('containers', s + (n - 1) * 5, at(t), Math.PI / 2, 1, 0xffffff, 5);
      tryAdd('rtg', 24, at(0.6), 0, 1, pick(rng, YARD_TINTS), 13);
      tryAdd('rtg', 80, at(0.38), 0, 1, pick(rng, YARD_TINTS), 13);
      // Behind the yard: transit sheds, a tank farm, light masts over everything.
      tryAdd('shed', 50, at(-0.25), face, 1, pick(rng, SHED_TINTS), 14);
      if (index % 2 === 0) tryAdd('tanks', 34, at(-0.68), face, 1, 0xffffff, 16);
      else tryAdd('shed', 50, at(-0.68), face, 0.8, pick(rng, SHED_TINTS), 12);
      for (const [s, t] of [[2, 0.74], [52, 0.74], [27, -0.02], [77, -0.48]]) tryAdd('mast', s, at(t), 0, 1);
      break;
    }
    case 'cruise': {
      // The cruise port: terminal halls along the quay, ships alongside, palms on the apron.
      const at = (t: number): number => island.d - side * t * island.w;
      const u = (lap0 + 50 - island.s) / island.len;
      if (index % 2 === 0) tryAdd('terminal', 50, at(0.5), face, 1, 0xffffff, 30);
      else tryAdd('shed', 50, at(0.5), face, 0.85, pick(rng, SHED_TINTS), 12);
      if (index % 3 === 1 && Math.abs(u) < 0.7) add('cruise', 50, at(1) - side * 21, 0, 1, 0xffffff);
      for (const [n, s] of [8, 33, 58, 83].entries()) tryAdd(n % 2 ? 'palm_date' : 'palm_tall', s, at(0.92), Math.floor(rng() * 4) * Math.PI / 2, range(rng, 0.9, 1.1));
      for (const [n, t] of [-0.1, -0.35].entries()) for (const s of [25, 75]) tryAdd('containers', s + n * 8, at(t), Math.PI / 2, 1, 0xffffff, 5);
      if (index % 2 === 1) tryAdd('tanks', 50, at(-0.7), face, 0.9, 0xffffff, 16);
      else tryAdd('shed', 50, at(-0.7), face, 0.9, pick(rng, SHED_TINTS), 13);
      for (const [s, t] of [[2, 0.78], [52, 0.78], [27, 0.1], [77, -0.5]]) tryAdd('mast', s, at(t), 0, 1);
      break;
    }
    case 'beach': {
      // Roadside beach of the causeway: palms and a line of umbrellas, well clear of the deck.
      const colour = pick(rng, BEACH_TINTS);
      for (let s = 6, n = 0; s < 96; s += 12, n++) {
        tryAdd(['palm_lite', 'palm_fan', 'palm_lite', 'seagrape'][n % 4], s + range(rng, -3, 3), island.d + range(rng, -3, 3), Math.floor(rng() * 4) * Math.PI / 2, range(rng, 0.8, 1));
      }
      for (let n = 0; n < 6; n++) tryAdd('oats', range(rng, 4, 96), island.d - side * range(rng, 1, 7), 0, range(rng, 0.9, 1.5));
      for (let s = 10; s < 96; s += 9) if (rng() < 0.7) tryAdd('umbrella', s + range(rng, -2, 2), island.d + side * range(rng, 1, 6), rng() * Math.PI * 2, 1, colour);
      break;
    }
    case 'mangrove':
      // A thicket, not a lawn with trees on it.
      anywhere('mangrove', 30, 1, 1.9, 0.9);
      anywhere('bush', 10, 1.5, 2.6, 0.9);
      break;
    case 'park':
      anywhere('tree', 4, 0.8, 1.3, 0.75);
      anywhere('banyan', 2, 0.7, 1, 0.6);
      anywhere('pine', 4, 0.8, 1.2, 0.75);
      anywhere('seagrape', 3, 0.9, 1.3);
      anywhere('palm_lite', 6, 0.9, 1.3);
      anywhere('palm_fan', 3, 0.9, 1.3);
      anywhere('palm_tall', 3, 0.9, 1.2);
      anywhere('bush', 4, 1.3, 2.2);
      break;
    default:
  }
}

const SMALL = new Set(['bench', 'planter', 'bollard', 'hedge', 'bush', 'bush_flower', 'agave', 'banana', 'oats', 'umbrella']);
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
    // Flowering plants bloom in one of their own colours unless the placement names one.
    const blooms = BLOOMS[prototype];
    if (blooms && tint === 0xffffff) tint = blooms[(i * 7 + out.length * 3) % blooms.length];
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

/**
 * Largest number of instances of each prototype in any window of `span` consecutive chunks. With
 * `detail`, only the first `detail` chunks of a window show a prototype as placed; in the rest the
 * far stand-ins of MIAMI_FAR_LOD apply (small scenery left out, light palms for kit palms).
 */
export function miamiPeakCounts(span: number, detail = span): Map<string, number> {
  const tally = (i: number, far: boolean): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const p of miamiPlacements(i)) {
      let name = p.prototype;
      const lod = far ? MIAMI_FAR_LOD[name] : undefined;
      if (lod === null) { if (p.scale < 1.3) continue; } else if (lod) name = lod[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  };
  const near: Map<string, number>[] = [], distant: Map<string, number>[] = [];
  for (let i = 0; i < MIAMI_CHUNKS; i++) { near.push(tally(i, false)); distant.push(tally(i, true)); }
  const peak = new Map<string, number>();
  for (let i = 0; i < MIAMI_CHUNKS; i++) {
    const window = new Map<string, number>();
    for (let k = 0; k < span; k++) {
      for (const [name, n] of (k < detail ? near : distant)[(i + k) % MIAMI_CHUNKS]) window.set(name, (window.get(name) ?? 0) + n);
    }
    for (const [name, n] of window) if (n > (peak.get(name) ?? 0)) peak.set(name, n);
  }
  return peak;
}
