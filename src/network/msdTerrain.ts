import raw from '../../data/moscow/msd-environment.json';
import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';
import { msdSection02Route } from './msdSection02';

/**
 * Terrain for MSD sections 01–02: a 4 m grid masked to 430 m around the route.
 * Heights are derived only from the published road surfaces and OSM watercourses:
 * embankments 1:1.5 under elevated roads, cut slopes beside roads below grade, a
 * cover embankment over tunnels (never a bare roof slab), carved river channels.
 * Terrain never rises through any road surface (clamp band of one cell diagonal).
 */
type XZ = [number, number];
const water = raw as unknown as { waterways: Array<{ width: number; line: XZ[] }>; water: Array<{ ring: XZ[] }> };
export const TERRAIN_BASE = -.05, ROAD_SKIN = .3, BERM = 1.5, SLOPE = 1.5, STEP = 4;
/** Tunnel cover above the road (roof at +6.5 m in the renderer); river/stream bed and level. */
export const TUNNEL_COVER = 6.6, WATER_BED = -2.4, WATER_LEVEL = -1.7;
const MASK = 430, RIM = 50;

const inside = (ring: XZ[], x: number, z: number) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    if ((az > z) !== (bz > z) && x < ax + (z - az) * (bx - ax) / (bz - az)) result = !result;
  }
  return result;
};

export interface MsdTerrain {
  x0: number; z0: number; step: number; nx: number; nz: number; heights: Float32Array;
  /** 1 where the vertex lies inside the route corridor (a cell needs all four). */
  mask: Uint8Array;
  /** 1 where the vertex lies over a tunnel bore (no terrain cell is emitted there). */
  hole: Uint8Array;
  /** Bilinear terrain height (TERRAIN_BASE outside the grid). */
  height(x: number, z: number): number;
  /** True inside any road footprint (plus margin) – nothing may be planted there. */
  occupied(x: number, z: number, margin?: number): boolean;
  /** True where the containing terrain cell is actually drawn (corridor, not a tunnel bore). */
  emitted(x: number, z: number): boolean;
  /** Route chainage (sections 01–02) and lateral distance of a point. */
  route(x: number, z: number): { chainage: number; distance: number };
}

/** Northbound centreline, chainage 0–5849.8 m (pilot ramp chain, then section 02). */
export function msdRoutePolyline(network: RoadNetwork): { points: Vec3[]; chainage: number[] } {
  const ways = ['1207836341', '809185810', '809185809', '809185806'], points: Vec3[] = [], chainage: number[] = [];
  const push = (p: Vec3) => {
    if (points.length) { const q = points.at(-1)!, d = Math.hypot(p.x - q.x, p.z - q.z); if (d < 1e-9) return; chainage.push(chainage.at(-1)! + d); }
    else chainage.push(0);
    points.push(p);
  };
  let edge = network.edges.find(e => e.id === 'osm:1207836341:1:0');
  for (let n = 0; edge && n < 64; n++) {
    edge.points.forEach(push);
    if (edge.to === 'osm-node:7566321589') break;
    const from: string = edge.to;
    edge = network.edges.find(e => e.from === from && ways.includes(e.id.split(':')[1]) && e.id.split(':')[2] === '1');
  }
  for (const e of msdSection02Route(network).edges) e.points.forEach(push);
  return { points, chainage };
}

type RoadSegment = { a: Vec3; b: Vec3; ha: number; hb: number; kind: NetworkEdge['kind']; s0: number; s1: number; length: number };
/** Terrain is not emitted inside a tunnel bore footprint (+margin); a turf deck covers the roof instead. */
export const TUNNEL_TURF_MARGIN = 5;
const cache = new WeakMap<RoadNetwork, MsdTerrain>();
export function msdTerrain(network: RoadNetwork): MsdTerrain {
  const cached = cache.get(network); if (cached) return cached;
  const full = network.id.startsWith('moscow-osm') ? msdRoutePolyline(network) : { points: [] as Vec3[], chainage: [] as number[] };
  // Decimate the (0.5 m densified) centreline to ≈4 m chords for corridor queries.
  const line = { points: [] as Vec3[], chainage: [] as number[] };
  for (let i = 0; i < full.points.length; i++) if (i === 0 || i === full.points.length - 1 || full.chainage[i] - line.chainage.at(-1)! >= 4) {
    line.points.push(full.points[i]); line.chainage.push(full.chainage[i]);
  }
  if (line.points.length < 2) {
    const empty: MsdTerrain = { x0: 0, z0: 0, step: STEP, nx: 0, nz: 0, heights: new Float32Array(0), mask: new Uint8Array(0), hole: new Uint8Array(0),
      height: () => TERRAIN_BASE, occupied: () => false, emitted: () => false, route: () => ({ chainage: 0, distance: Infinity }) };
    cache.set(network, empty); return empty;
  }
  const xs = line.points.map(p => p.x), zs = line.points.map(p => p.z);
  const x0 = Math.floor((Math.min(...xs) - MASK) / STEP) * STEP, x1 = Math.ceil((Math.max(...xs) + MASK) / STEP) * STEP;
  const z0 = Math.floor((Math.min(...zs) - MASK) / STEP) * STEP, z1 = Math.ceil((Math.max(...zs) + MASK) / STEP) * STEP;
  const nx = (x1 - x0) / STEP + 1, nz = (z1 - z0) / STEP + 1;
  const RCELL = 60, routeCells = new Map<string, number[]>();
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1], b = line.points[i];
    for (let x = Math.floor((Math.min(a.x, b.x) - MASK) / RCELL); x <= Math.floor((Math.max(a.x, b.x) + MASK) / RCELL); x++)
      for (let z = Math.floor((Math.min(a.z, b.z) - MASK) / RCELL); z <= Math.floor((Math.max(a.z, b.z) + MASK) / RCELL); z++) {
        const key = `${x}:${z}`, list = routeCells.get(key) ?? []; list.push(i); routeCells.set(key, list);
      }
  }
  const route = (x: number, z: number) => {
    let best = { chainage: 0, distance: Infinity };
    for (const i of routeCells.get(`${Math.floor(x / RCELL)}:${Math.floor(z / RCELL)}`) ?? []) {
      const a = line.points[i - 1], b = line.points[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
      if (d < best.distance) best = { distance: d, chainage: line.chainage[i - 1] + (line.chainage[i] - line.chainage[i - 1]) * t };
    }
    return best;
  };
  const CELL = 32, buckets = new Map<string, RoadSegment[]>();
  for (const edge of network.edges) {
    if (edge.kind === 'parking') continue;
    if (!edge.points.some(p => p.x > x0 - 60 && p.x < x1 + 60 && p.z > z0 - 60 && p.z < z1 + 60)) continue;
    if (!edge.points.some((p, i) => (i % 8 === 0 || i === edge.points.length - 1) && route(p.x, p.z).distance < MASK + 80)) continue;
    const ds = roadSampleDistances(edge, 4);
    let previous = sampleEdge(edge, 0);
    for (let i = 1; i < ds.length; i++) {
      const next = sampleEdge(edge, ds[i]);
      const segment: RoadSegment = { a: previous, b: next, ha: previous.halfWidth, hb: next.halfWidth, kind: edge.kind, s0: ds[i - 1], s1: ds[i], length: edge.length };
      const lift = edge.kind === 'tunnel' ? Math.max(0, Math.max(previous.y, next.y) + TUNNEL_COVER)
        : Math.max(0, previous.y, next.y, -Math.min(previous.y, next.y));
      const reach = lift * SLOPE + Math.max(previous.halfWidth, next.halfWidth) + BERM + STEP * 1.5 + 4;
      for (let x = Math.floor((Math.min(previous.x, next.x) - reach) / CELL); x <= Math.floor((Math.max(previous.x, next.x) + reach) / CELL); x++)
        for (let z = Math.floor((Math.min(previous.z, next.z) - reach) / CELL); z <= Math.floor((Math.max(previous.z, next.z) + reach) / CELL); z++) {
          const key = `${x}:${z}`, list = buckets.get(key) ?? []; list.push(segment); buckets.set(key, list);
        }
      previous = next;
    }
  }
  const box = <T extends { xs: number[]; zs: number[] }>(item: T, x: number, z: number) => x >= item.xs[0] && x <= item.xs[1] && z >= item.zs[0] && z <= item.zs[1];
  const channels = water.waterways.map(w => ({ ...w, xs: [Math.min(...w.line.map(p => p[0])) - 40, Math.max(...w.line.map(p => p[0])) + 40],
    zs: [Math.min(...w.line.map(p => p[1])) - 40, Math.max(...w.line.map(p => p[1])) + 40] }));
  const basins = water.water.map(w => ({ ring: w.ring, xs: [Math.min(...w.ring.map(p => p[0])), Math.max(...w.ring.map(p => p[0]))],
    zs: [Math.min(...w.ring.map(p => p[1])), Math.max(...w.ring.map(p => p[1]))] }));
  const project = (s: RoadSegment, x: number, z: number) => {
    const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - s.a.x) * dx + (z - s.a.z) * dz) / l2)) : 0;
    return { d: Math.hypot(x - s.a.x - t * dx, z - s.a.z - t * dz), y: s.a.y + (s.b.y - s.a.y) * t, half: s.ha + (s.hb - s.ha) * t, t };
  };
  const BAND = .4 + STEP * Math.SQRT2;
  const bore = (x: number, z: number) => {
    for (const s of buckets.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`) ?? []) if (s.kind === 'tunnel') {
      const { d, half, t } = project(s, x, z);
      if (d <= half * 1.04 + .5 && (t > 0 && t < 1 || s.s0 > 0 && s.s1 < s.length || (t <= 0 ? s.s0 > 0 : s.s1 < s.length))) return true;
    }
    return false;
  };
  const solve = (x: number, z: number, margin = 0): { height: number; occupied: boolean } => {
    let raise = TERRAIN_BASE, clamp = Infinity, occupied = false;
    for (const c of channels) {
      if (!box(c, x, z)) continue;
      for (let i = 1; i < c.line.length; i++) {
        const [ax, az] = c.line[i - 1], [bx, bz] = c.line[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), d = Math.hypot(x - ax - t * dx, z - az - t * dz);
        clamp = Math.min(clamp, WATER_BED + Math.max(0, d - c.width / 2) / 2);
      }
    }
    for (const b of basins) if (box(b, x, z) && inside(b.ring, x, z)) clamp = Math.min(clamp, WATER_BED);
    const list = buckets.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`) ?? [];
    // Over a tunnel footprint the approach roads' end caps must not cut the cover:
    // only their lateral (in-span) clamp applies there.
    let overTunnel = false;
    for (const s of list) if (s.kind === 'tunnel') {
      const { d, y, half } = project(s, x, z);
      const top = Math.max(y + TUNNEL_COVER, TERRAIN_BASE), berm = half + 3;
      raise = Math.max(raise, d <= berm ? top : top - (d - berm) / SLOPE);
      if (d <= berm) overTunnel = true;
    }
    for (const s of list) {
      if (s.kind === 'tunnel') continue;
      const { d, y, half, t } = project(s, x, z);
      if (overTunnel && (t <= 0 || t >= 1) && d > half + .4) continue;
      if (d <= half + .4 + margin) occupied = true;
      // Clamp every vertex of any cell touching the surface (one cell diagonal), then a
      // 1:1.5 cut slope. Bridges keep open space under the deck; roads keep a skin;
      // the lower chord end keeps the clamp safe on steep context grades.
      const floor = s.kind === 'bridge' ? Math.min(y, s.a.y, s.b.y) - 1.2 : Math.min(s.a.y, s.b.y) - ROAD_SKIN;
      if (d <= half + BAND) clamp = Math.min(clamp, floor);
      else if (s.kind !== 'bridge') clamp = Math.min(clamp, floor + (d - half - BAND) / SLOPE);
      if (s.kind !== 'bridge' && y > TERRAIN_BASE + ROAD_SKIN) {
        const top = y - ROAD_SKIN, berm = half + BERM;
        raise = Math.max(raise, d <= berm ? top : top - (d - berm) / SLOPE);
      }
    }
    return { height: Math.min(raise, clamp), occupied };
  };
  // Corridor distance on a 16 m grid, bilinear on the 4 m grid (≤ ~1 m error at the rim).
  const C = 4, cx = Math.ceil((nx - 1) / C) + 1, cz = Math.ceil((nz - 1) / C) + 1, coarse = new Float32Array(cx * cz);
  for (let j = 0; j < cz; j++) for (let i = 0; i < cx; i++) coarse[j * cx + i] = Math.min(1e4, route(x0 + i * C * STEP, z0 + j * C * STEP).distance);
  const corridor = (i: number, j: number) => {
    const fi = i / C, fj = j / C, a = Math.min(cx - 2, Math.floor(fi)), b = Math.min(cz - 2, Math.floor(fj)), u = fi - a, v = fj - b;
    const q = (di: number, dj: number) => coarse[(b + dj) * cx + a + di];
    return q(0, 0) * (1 - u) * (1 - v) + q(1, 0) * u * (1 - v) + q(0, 1) * (1 - u) * v + q(1, 1) * u * v;
  };
  const heights = new Float32Array(nx * nz), mask = new Uint8Array(nx * nz), hole = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * STEP, z = z0 + j * STEP, distance = corridor(i, j);
    if (distance > MASK) { heights[j * nx + i] = -2; continue; }
    mask[j * nx + i] = 1;
    if (bore(x, z)) hole[j * nx + i] = 1;
    const rim = MASK - distance, base = solve(x, z).height;
    heights[j * nx + i] = rim >= RIM ? base : -2 + (base + 2) * rim / RIM;
  }
  const height = (x: number, z: number) => {
    const fx = (x - x0) / STEP, fz = (z - z0) / STEP, i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return TERRAIN_BASE;
    const u = fx - i, v = fz - j, h = (a: number, b: number) => heights[(j + b) * nx + i + a];
    return h(0, 0) * (1 - u) * (1 - v) + h(1, 0) * u * (1 - v) + h(0, 1) * (1 - u) * v + h(1, 1) * u * v;
  };
  const emitted = (x: number, z: number) => {
    const i = Math.floor((x - x0) / STEP), j = Math.floor((z - z0) / STEP);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return false;
    const k = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1];
    return k.every(n => mask[n] && !hole[n]);
  };
  const terrain: MsdTerrain = { x0, z0, step: STEP, nx, nz, heights, mask, hole, emitted, height, occupied: (x, z, margin = 0) => solve(x, z, margin).occupied, route };
  cache.set(network, terrain); return terrain;
}
