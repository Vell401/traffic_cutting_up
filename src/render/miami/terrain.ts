import { WALL_D } from '../../config';
import { MIAMI_CHUNKS, MIAMI_LEN, miamiChunk, miamiZone, type MiamiDistrict } from '../../sim/miami';
import { CHUNK_LEN, type Road, type SectionKind } from '../../sim/road';

/*
 * The shape of the land beside the Miami road, as pure functions of lap position.
 *
 * Every side of every chunk has a scene (beach, hotel strip, marina quay, open bay...). A scene is a
 * cross-section: surface bands going outward from the road, where the shore is, how the land steps
 * down to it. The numbers that move the ground (shore distance, bank, shore slope) are blended between
 * neighbouring chunk centres, so coastlines swing in and out instead of jumping at chunk boundaries,
 * and the height at any (s, d) is the same whichever chunk asks: props, terrain and tests agree.
 *
 * Visual only. Nothing here touches the road, the barriers or collision.
 */

/** Bay and ocean level. The road is at 0: low enough to see docks and beaches over the barrier. */
export const MIAMI_WATER = -3;
/** Lower marina boardwalk / floating-dock landings. */
export const MIAMI_QUAY = MIAMI_WATER + 0.6;
export const MIAMI_SEABED = MIAMI_WATER - 1.6;
/** Outer edge of the barrier / deck, and of the lit maintenance walkway beyond it. */
export const MIAMI_DECK = WALL_D + 0.55;
export const MIAMI_WALK = 15.5;
/** Land reaches this far from the road; past it only water and fog. */
export const MIAMI_OUT = 700;

export const SURFACE = {
  concrete: 0,
  pavers: 1,
  grass: 2,
  sand: 3,
  asphalt: 4,
  rock: 5,
  wood: 6,
  planting: 7,
  tiles: 8,
  lawn: 9,
  /** Not a ground: grey fbm used for large-scale tone variation. */
  noise: 10,
} as const;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];
export const SURFACE_COUNT = 11;
/** Size of one texture repeat, m. Every size divides 1200 m so chunk-relative UVs stay seamless. */
export const SURFACE_TILE: readonly number[] = [3, 2.4, 4, 5, 4, 4, 2, 3, 2.4, 4, 40];

export type MiamiSceneId = 'beach' | 'strip' | 'bay' | 'towers' | 'arts' | 'quay' | 'lush' | 'dunes' | 'golf' | 'villas' | 'park' | 'hill';

/** Band: from the previous band's outer edge to `to` metres from the road centre. */
export interface MiamiBand {
  readonly to: number;
  readonly surface: Surface;
  /** Linear RGB multiplier. */
  readonly tint: readonly [number, number, number];
}

export interface MiamiScene {
  readonly id: MiamiSceneId;
  /** Where the land ends. MIAMI_OUT = no water on this side. */
  readonly shore: number;
  /** Width of the drop from the land edge to the seabed: ~1 m is a seawall, 20+ m a beach. */
  readonly slope: number;
  /** The land steps down by `drop` between `from` and `to` metres from the road. */
  readonly bank: { readonly from: number; readonly to: number; readonly drop: number };
  readonly bands: readonly MiamiBand[];
  /** Surface of the shore slope itself. */
  readonly edge: Surface;
  readonly edgeTint: readonly [number, number, number];
}

const S = SURFACE;
const W: readonly [number, number, number] = [1, 1, 1];
const band = (to: number, surface: Surface, tint: readonly [number, number, number] = W): MiamiBand => ({ to, surface, tint });
const FLAT = { from: 22, to: 32, drop: 0 };

const SCENES: Readonly<Record<MiamiSceneId, MiamiScene>> = {
  // Ocean side of South Beach: dune planting, the beach walk, then sand down to the surf.
  beach: {
    id: 'beach', shore: 112, slope: 26, bank: { from: 62, to: 112, drop: 1.7 },
    bands: [band(20, S.grass), band(26.5, S.pavers, [1, 0.93, 0.88]), band(32, S.planting), band(MIAMI_OUT, S.sand)],
    edge: S.sand, edgeTint: [0.72, 0.68, 0.6],
  },
  // Hotel side: verge, frontage road with parking, sidewalk, hotel forecourts, back alley, city blocks.
  strip: {
    id: 'strip', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(18.5, S.grass), band(26, S.asphalt), band(30.5, S.pavers), band(60, S.tiles), band(68, S.asphalt), band(MIAMI_OUT, S.concrete, [0.78, 0.77, 0.75])],
    edge: S.concrete, edgeTint: W,
  },
  // Causeways: water right up to the deck.
  bay: {
    id: 'bay', shore: MIAMI_WALK + 0.5, slope: 2, bank: FLAT,
    bands: [band(MIAMI_OUT, S.rock)],
    edge: S.rock, edgeTint: W,
  },
  towers: {
    id: 'towers', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(18.5, S.planting), band(27, S.asphalt), band(32, S.tiles, [0.92, 0.94, 0.98]), band(72, S.concrete), band(82, S.asphalt), band(MIAMI_OUT, S.concrete, [0.7, 0.71, 0.73])],
    edge: S.concrete, edgeTint: W,
  },
  arts: {
    id: 'arts', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(18, S.grass, [0.95, 0.95, 0.8]), band(26.5, S.asphalt), band(30, S.concrete), band(64, S.asphalt, [1.12, 1.12, 1.12]), band(72, S.asphalt), band(MIAMI_OUT, S.concrete, [0.74, 0.72, 0.7])],
    edge: S.concrete, edgeTint: W,
  },
  // Marina: upper promenade, planted bank, lower boardwalk at the water, seawall.
  quay: {
    id: 'quay', shore: 48, slope: 1.2, bank: { from: 24, to: 32, drop: -MIAMI_QUAY },
    bands: [band(24, S.pavers), band(32, S.planting), band(MIAMI_OUT, S.wood)],
    edge: S.concrete, edgeTint: [0.85, 0.83, 0.78],
  },
  lush: {
    id: 'lush', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(22, S.grass), band(25, S.asphalt, [1.5, 0.9, 0.8]), band(34, S.lawn), band(74, S.tiles, [0.95, 0.97, 0.9]), band(82, S.asphalt), band(MIAMI_OUT, S.grass, [0.88, 0.95, 0.85])],
    edge: S.concrete, edgeTint: W,
  },
  // Key Biscayne ocean side: coastal hammock, then a wide wild beach.
  dunes: {
    id: 'dunes', shore: 150, slope: 28, bank: { from: 100, to: 150, drop: 1.7 },
    bands: [band(24, S.grass), band(27, S.asphalt, [1.5, 0.9, 0.8]), band(58, S.planting, [0.9, 1, 0.85]), band(MIAMI_OUT, S.sand, [1, 0.98, 0.94])],
    edge: S.sand, edgeTint: [0.72, 0.68, 0.6],
  },
  golf: {
    id: 'golf', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(24, S.grass), band(27, S.asphalt, [1.5, 0.9, 0.8]), band(MIAMI_OUT, S.lawn)],
    edge: S.concrete, edgeTint: W,
  },
  villas: {
    id: 'villas', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(19.5, S.grass), band(22.5, S.pavers), band(72, S.lawn, [0.95, 1, 0.92]), band(80, S.asphalt), band(MIAMI_OUT, S.grass)],
    edge: S.concrete, edgeTint: W,
  },
  // Waterfront park: lawns to a paved bay walk on a seawall.
  park: {
    id: 'park', shore: 84, slope: 1.2, bank: FLAT,
    bands: [band(22, S.grass), band(27, S.pavers), band(70, S.lawn), band(MIAMI_OUT, S.pavers, [1, 0.95, 0.9])],
    edge: S.concrete, edgeTint: [0.85, 0.83, 0.78],
  },
  // Above and beside a tunnel.
  hill: {
    id: 'hill', shore: MIAMI_OUT, slope: 2, bank: FLAT,
    bands: [band(MIAMI_OUT, S.grass, [0.85, 0.92, 0.8])],
    edge: S.concrete, edgeTint: W,
  },
};

const BY_DISTRICT: Readonly<Record<MiamiDistrict, readonly [MiamiSceneId, MiamiSceneId]>> = {
  'south-beach': ['beach', 'strip'],
  macarthur: ['bay', 'bay'],
  watson: ['park', 'park'],
  downtown: ['towers', 'towers'],
  wynwood: ['arts', 'arts'],
  grove: ['quay', 'lush'],
  rickenbacker: ['bay', 'bay'],
  'key-biscayne': ['dunes', 'golf'],
  'bear-cut': ['bay', 'bay'],
  gables: ['villas', 'villas'],
  bayfront: ['park', 'towers'],
};

const elevated = (kind: SectionKind): boolean => kind === 'viaduct' || kind === 'bridge';

/** Scene on one side (-1 left / ocean, +1 right / city) of a chunk, on any lap. */
export function miamiScene(index: number, side: number): MiamiScene {
  const zone = miamiZone(index);
  if (zone.kind === 'tunnel') return SCENES.hill;
  if (elevated(zone.kind)) return SCENES.bay;
  return SCENES[BY_DISTRICT[zone.district][side < 0 ? 0 : 1]];
}

/** The blended numbers that shape the ground at one cross-section. */
export interface MiamiSection {
  shore: number;
  slope: number;
  bankFrom: number;
  bankTo: number;
  drop: number;
}

const smooth = (t: number): number => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/** Cross-section numbers at lap distance s: scenes blend between neighbouring chunk centres. */
export function miamiSection(s: number, side: number, out: MiamiSection): MiamiSection {
  const u = s / CHUNK_LEN - 0.5;
  const i = Math.floor(u);
  const a = miamiScene(i, side);
  const b = miamiScene(i + 1, side);
  const t = a === b ? 0 : smooth(u - i);
  out.shore = a.shore + (b.shore - a.shore) * t;
  out.slope = a.slope + (b.slope - a.slope) * t;
  out.bankFrom = a.bank.from + (b.bank.from - a.bank.from) * t;
  out.bankTo = a.bank.to + (b.bank.to - a.bank.to) * t;
  out.drop = a.bank.drop + (b.bank.drop - a.bank.drop) * t;
  return out;
}

/** Height of the main land profile `ad` metres from the road centre, given the road-side level `base`. */
export function miamiProfileY(base: number, sec: MiamiSection, ad: number): number {
  const at = ad < sec.shore ? ad : sec.shore;
  const k = sec.bankTo > sec.bankFrom ? (at - sec.bankFrom) / (sec.bankTo - sec.bankFrom) : 0;
  const y = base - sec.drop * (k < 0 ? 0 : k > 1 ? 1 : k);
  if (ad <= sec.shore || y <= MIAMI_SEABED) return y;
  const t = (ad - sec.shore) / sec.slope;
  return t >= 1 ? MIAMI_SEABED : y + (MIAMI_SEABED - y) * t;
}

/** An island in the bay: an ellipse in road coordinates with a flat top and a sloping rim. */
export interface MiamiIsland {
  /** Lap distance and lateral offset of the centre; half-length along the road, half-width across. */
  readonly s: number;
  readonly d: number;
  readonly len: number;
  readonly w: number;
  /** Height of the flat top. */
  readonly top: number;
  readonly surface: Surface;
  readonly kind: 'villas' | 'port' | 'beach' | 'mangrove' | 'park';
}

const isle = (s: number, len: number, d: number, w: number, kind: MiamiIsland['kind'], surface: Surface, top = MIAMI_WATER + 1.3): MiamiIsland =>
  ({ s, d, len, w, top, surface, kind });

export const MIAMI_ISLANDS: readonly MiamiIsland[] = [
  // MacArthur Causeway: residential islands to the north (left), the cruise port to the south (right).
  isle(3900, 430, -235, 105, 'villas', S.lawn),
  isle(4780, 360, -300, 95, 'villas', S.lawn),
  isle(4250, 900, 345, 150, 'port', S.concrete, MIAMI_WATER + 1.6),
  isle(6350, 380, -215, 90, 'villas', S.lawn),
  isle(6500, 760, 320, 140, 'port', S.concrete, MIAMI_WATER + 1.6),
  // Coconut Grove: picnic islands off the marina.
  isle(15500, 190, -255, 70, 'park', S.grass),
  isle(16350, 150, -215, 55, 'mangrove', S.planting),
  // Rickenbacker Causeway: roadside beaches on both approaches, mangrove islets, Virginia Key.
  isle(17190, 290, -31, 14.5, 'beach', S.sand, MIAMI_WATER + 1.1),
  isle(19500, 390, -32, 15.5, 'beach', S.sand, MIAMI_WATER + 1.1),
  isle(17900, 160, 185, 60, 'mangrove', S.planting),
  isle(18750, 210, 250, 75, 'mangrove', S.planting),
  isle(18300, 520, -340, 130, 'park', S.grass),
  // Bear Cut.
  isle(23300, 130, -150, 50, 'mangrove', S.planting),
  isle(23900, 170, 175, 58, 'mangrove', S.planting),
  // Off the Bayfront park.
  isle(28700, 240, -260, 80, 'park', S.grass),
];

/** Islands by the chunks they touch, so a lookup only tests the one or two that can matter. */
const ISLANDS_AT: readonly (readonly MiamiIsland[])[] = (() => {
  const out: MiamiIsland[][] = Array.from({ length: MIAMI_CHUNKS }, () => []);
  for (const island of MIAMI_ISLANDS) {
    const first = Math.floor((island.s - island.len) / CHUNK_LEN);
    const last = Math.floor((island.s + island.len) / CHUNK_LEN);
    for (let i = first; i <= last; i++) out[miamiChunk(i)].push(island);
  }
  return out;
})();

export const miamiIslands = (index: number): readonly MiamiIsland[] => ISLANDS_AT[miamiChunk(index)];

/** Share of the rim: the island is at full height inside 1 - RIM of its radius. */
const RIM = 0.3;

/** Height of an island at (lap distance, lateral offset); the seabed outside it. */
export function miamiIslandY(island: MiamiIsland, s: number, d: number): number {
  let ds = s - island.s;
  ds -= MIAMI_LEN * Math.round(ds / MIAMI_LEN);
  const u = ds / island.len;
  const v = (d - island.d) / island.w;
  const q = 1 - u * u - v * v;
  if (q <= 0) return MIAMI_SEABED;
  return q >= RIM ? island.top : MIAMI_SEABED + (island.top - MIAMI_SEABED) * (q / RIM);
}

/** Half-width of an island across the road at lap distance s (0 outside it). */
export function miamiIslandHalfWidth(island: MiamiIsland, s: number): number {
  let ds = s - island.s;
  ds -= MIAMI_LEN * Math.round(ds / MIAMI_LEN);
  const u = ds / island.len;
  return u * u >= 1 ? 0 : island.w * Math.sqrt(1 - u * u);
}

const section: MiamiSection = { shore: 0, slope: 0, bankFrom: 0, bankTo: 0, drop: 0 };

/**
 * Ground height at road coordinates (s, d) outside the barrier: the land profile or an island,
 * whichever is higher, and never below the bay floor. Below MIAMI_WATER means open water.
 */
export function miamiGround(road: Road, s: number, d: number): number {
  const ad = Math.abs(d);
  const base = road.groundY(s);
  if (ad <= MIAMI_WALK) return base;
  let y = miamiProfileY(base, miamiSection(s, d < 0 ? -1 : 1, section), ad);
  // The bay has one floor: under a causeway the road-side level is far below it.
  if (y < MIAMI_SEABED) y = MIAMI_SEABED;
  for (const island of miamiIslands(Math.floor(s / CHUNK_LEN))) {
    const h = miamiIslandY(island, s, d);
    if (h > y) y = h;
  }
  return y;
}

/** True where the ground at (s, d) is above the water. */
export const miamiDry = (road: Road, s: number, d: number): boolean => miamiGround(road, s, d) > MIAMI_WATER + 0.25;
