import { ShapeUtils, Vector2 } from 'three';
import raw from '../../data/moscow/msd-environment.json';
import edits from '../../data/moscow/msd-pilot-environment-edits.json';
import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';
import { msdRampCurbRange } from './msdPilot';
import { MSD_SECTION02 } from './msdSection02';
import { msdTerrain, ROAD_SKIN, BERM, SLOPE, WATER_LEVEL, TUNNEL_TURF_MARGIN } from './msdTerrain';

/**
 * MSD sections 01–02 environment (0–5849.8 m only). Sources: OSM context extracts (ODbL,
 * scripts/build-msd-environment.ts) for footprints/lines, Yandex road frames
 * for roadside furniture types (see docs/msd-pilot-acceptance.md). Pure CPU plan:
 * world-metre triangles/boxes through callbacks, no THREE scene objects.
 */
export type EnvironmentMaterial = 'env:grass' | 'env:paved' | 'env:ballast' | 'env:rail' | 'env:roof' | 'env:pipe'
  | 'env:steel' | 'env:truss' | 'env:trunk' | 'env:fence' | 'env:wall' | 'env:noise' | 'env:lamp' | 'env:tank'
  | 'env:water' | 'env:pylon' | 'env:wire' | 'env:turf'
  | `env:facade:${number}` | `env:foliage:${number}` | 'infrastructureWhite' | 'infrastructureDark' | 'infrastructureConcrete';
export type EnvironmentTriangleEmitter = (material: EnvironmentMaterial, a: Vec3, b: Vec3, c: Vec3) => void;
export type EnvironmentBoxEmitter = (material: EnvironmentMaterial, center: Vec3, width: number, height: number, length: number, heading: number) => void;
type XZ = [number, number];
interface EnvironmentData {
  buildings: Array<{ id: string; kind: string; height: number; estimated: boolean; ring: XZ[] }>;
  tanks: Array<{ id: number; height: number; ring: XZ[] }>;
  railways: Array<{ id: number; electrified: boolean; main: boolean; line: XZ[] }>;
  pipelines: Array<{ id: number; overhead: boolean; line: XZ[] }>;
  barriers: Array<{ id: number; kind: 'fence' | 'wall' | 'noise' | 'guard'; height: number; line: XZ[] }>;
  woods: Array<{ id: string; ring: XZ[] }>; paved: Array<{ id: string; kind: string; ring: XZ[] }>;
  trees: XZ[]; masts: Array<{ id: number; kind: string; position: XZ; height: number }>;
  waterways: Array<{ id: number; width: number; line: XZ[] }>; water: Array<{ id: string; ring: XZ[] }>;
  powerLines: Array<{ id: number; voltage: number; line: XZ[] }>; towers: XZ[];
}
export const MSD_ENVIRONMENT = raw as unknown as EnvironmentData;
const data = MSD_ENVIRONMENT;

export const ENV_FACADES = ['#bfc3c4', '#a8b0b5', '#cdc8bc', '#d9d3c5', '#b8664a', '#e4e1d8', '#9ea6a8'] as const;
export const ENV_FOLIAGE = ['#3e5a2b', '#4b6a32', '#58773a', '#6b7d3c'] as const;

/** Deterministic hash in [0, 1). */
const inside = (ring: XZ[], x: number, z: number) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    if ((az > z) !== (bz > z) && x < ax + (z - az) * (bx - ax) / (bz - az)) result = !result;
  }
  return result;
};
const hash = (a: number, b: number, c = 0) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export { msdTerrain, msdRoutePolyline, type MsdTerrain } from './msdTerrain';
import type { MsdTerrain } from './msdTerrain';

/** Pilot section routes for lamp posts: outer (right) edge of each mainline carriageway and the entry ramp. */
function lampRuns(network: RoadNetwork, terrain: MsdTerrain): Array<{ edge: NetworkEdge; spacing: number }> {
  const MSD = /^(809185810|809185809|809185806|809185811|809185812|809185807|1194199517|809185801|1194199515|809185818|942598242|809185797|942598243|942598237|1194203196)$/;
  const select = (e: NetworkEdge) => {
    const [, way, direction, part] = e.id.split(':');
    if (direction !== '1' || e.kind === 'tunnel') return undefined;
    const id = Number(way), n = Number(part);
    if (id === 1207836341) return 34;
    if ([809185810, 809185809, 809185812, 809185807].includes(id) || id === 809185806 && n <= 3 || id === 809185811 && n <= 3) return 40;
    // Section 02: both carriageways (any MSD-named way within the corridor up to 5849.8 m).
    const mid = sampleEdge(e, e.length / 2), at = terrain.route(mid.x, mid.z);
    if ((MSD.test(way) || /Юго-Восточная хорда/.test(e.route)) && at.distance < 45 && at.chainage > 1942.3 && at.chainage < MSD_SECTION02.end) return 40;
    return undefined;
  };
  return network.edges.flatMap(edge => { const spacing = select(edge); return spacing ? [{ edge, spacing }] : []; });
}

/** Emits the environment; returns counts for diagnostics. */
export function emitMsdEnvironment(network: RoadNetwork, triangle: EnvironmentTriangleEmitter, box: EnvironmentBoxEmitter): Record<string, number> {
  if (!network.id.startsWith('moscow-osm')) return {};
  const terrain = msdTerrain(network), stats: Record<string, number> = {};
  if (!terrain.nx) return stats; // a synthetic network without the section-01 roads
  const count = (key: string, n = 1) => { stats[key] = (stats[key] ?? 0) + n; };
  const at = (x: number, z: number, y = 0): Vec3 => ({ x, y: terrain.height(x, z) + y, z });
  const quad = (m: EnvironmentMaterial, a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { triangle(m, a, b, c); triangle(m, a, c, d); };

  // Flat paved yards/parking just above terrain (never over a road: those win depth by height).
  const polygon = (m: EnvironmentMaterial, ring: XZ[], y: (x: number, z: number) => number) => {
    const contour = ring.map(([x, z]) => new Vector2(x, z));
    if (ShapeUtils.isClockWise(contour)) contour.reverse();
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      const p = [contour[a], contour[b], contour[c]].map(q => ({ x: q.x, y: y(q.x, q.y), z: q.y }));
      triangle(m, p[0], p[2], p[1]);
    }
  };
  // Terrain grid.
  const { x0, z0, step, nx, nz, heights, mask, hole } = terrain;
  const v = (i: number, j: number): Vec3 => ({ x: x0 + i * step, y: heights[j * nx + i], z: z0 + j * step });
  for (let j = 1; j < nz; j++) for (let i = 1; i < nx; i++) {
    if (!(mask[j * nx + i] & mask[j * nx + i - 1] & mask[(j - 1) * nx + i] & mask[(j - 1) * nx + i - 1])) continue;
    if (hole[j * nx + i] | hole[j * nx + i - 1] | hole[(j - 1) * nx + i] | hole[(j - 1) * nx + i - 1]) continue;
    quad('env:grass', v(i - 1, j - 1), v(i, j - 1), v(i, j), v(i - 1, j)); count('terrainCells');
  }
  // Water: river/stream ribbons and basins at a fixed level inside carved channels.
  for (const w of data.waterways) {
    for (let i = 1; i < w.line.length; i++) {
      const [ax, az] = w.line[i - 1], [bx, bz] = w.line[i], heading = Math.atan2(bx - ax, az - bz);
      const rx = Math.cos(heading) * w.width / 2, rz = Math.sin(heading) * w.width / 2;
      if (terrain.route((ax + bx) / 2, (az + bz) / 2).distance > 420) continue;
      quad('env:water', { x: ax - rx, y: WATER_LEVEL, z: az - rz }, { x: bx - rx, y: WATER_LEVEL, z: bz - rz },
        { x: bx + rx, y: WATER_LEVEL, z: bz + rz }, { x: ax + rx, y: WATER_LEVEL, z: az + rz });
    }
    count('waterways');
  }
  for (const w of data.water) { polygon('env:water', w.ring, () => WATER_LEVEL); count('waterBodies'); }

  for (const area of data.paved) { polygon('env:paved', area.ring, (x, z) => terrain.height(x, z) + .05); count('paved'); }

  // Buildings and tanks: OSM footprints, flat roofs, base sunk below the lowest terrain sample.
  const extrude = (ring: XZ[], height: number, facade: EnvironmentMaterial, roof: EnvironmentMaterial) => {
    const base = Math.min(...ring.map(([x, z]) => terrain.height(x, z))) - .3, top = Math.max(...ring.map(([x, z]) => terrain.height(x, z))) + height;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      quad(facade, { x: ax, y: base, z: az }, { x: bx, y: base, z: bz }, { x: bx, y: top, z: bz }, { x: ax, y: top, z: az });
    }
    polygon(roof, ring, () => top);
  };
  for (const b of data.buildings) {
    const [cx, cz] = b.ring.reduce(([x, z], [px, pz]) => [x + px / b.ring.length, z + pz / b.ring.length], [0, 0]);
    // Never extrude a footprint over a carriageway (stale or overlapping source data).
    if (b.ring.some(([x, z]) => terrain.occupied(x, z)) || terrain.occupied(cx, cz)) { count('buildingsSkippedOnRoad'); continue; }
    const palette = b.kind === 'apartments' ? [3, 4, 5] : b.kind === 'industrial' || b.kind === 'warehouse' ? [0, 1, 6] : [2, 0, 3, 6];
    const facade = palette[Math.floor(hash(Math.round(cx), Math.round(cz)) * palette.length)];
    extrude(b.ring, b.height, `env:facade:${facade}`, 'env:roof'); count('buildings');
  }
  for (const t of data.tanks) { extrude(t.ring, t.height, 'env:tank', 'env:tank'); count('tanks'); }

  // Polyline helper: callback per resampled span with world points on terrain.
  const along = (line: XZ[], spacing: number, visit: (a: Vec3, b: Vec3, heading: number, s: number) => void) => {
    let s = 0;
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1], [bx, bz] = line[i], length = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(length / spacing)), heading = Math.atan2(bx - ax, az - bz);
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        visit(at(ax + (bx - ax) * t0, az + (bz - az) * t0), at(ax + (bx - ax) * t1, az + (bz - az) * t1), heading, s + length * t0);
      }
      s += length;
    }
  };
  const ribbon = (m: EnvironmentMaterial, a: Vec3, b: Vec3, heading: number, left: number, right: number, y0: number, y1 = y0) => {
    const rx = Math.cos(heading), rz = Math.sin(heading);
    quad(m, { x: a.x + rx * left, y: a.y + y0, z: a.z + rz * left }, { x: b.x + rx * left, y: b.y + y0, z: b.z + rz * left },
      { x: b.x + rx * right, y: b.y + y1, z: b.z + rz * right }, { x: a.x + rx * right, y: a.y + y1, z: a.z + rz * right });
  };

  // Railways: ballast prism, two rails (1520 mm gauge), contact-line masts on electrified track.
  for (const rail of data.railways) {
    along(rail.line, 6, (a, b, heading, s) => {
      ribbon('env:ballast', a, b, heading, -2.2, -1.5, .02, .45); ribbon('env:ballast', a, b, heading, -1.5, 1.5, .45);
      ribbon('env:ballast', a, b, heading, 1.5, 2.2, .45, .02);
      for (const side of [-.76, .76]) {
        ribbon('env:rail', a, b, heading, side - .04, side + .04, .63);
        ribbon('env:rail', a, b, heading, side - .04, side - .04, .45, .63); ribbon('env:rail', a, b, heading, side + .04, side + .04, .63, .45);
      }
      if (rail.electrified && rail.main && Math.floor(s / 60) !== Math.floor((s + Math.hypot(b.x - a.x, b.z - a.z)) / 60)) {
        const rx = Math.cos(heading), rz = Math.sin(heading);
        box('env:steel', { x: a.x - rx * 3.1, y: a.y + 4.5, z: a.z - rz * 3.1 }, .3, 9, .3, heading);
        box('env:steel', { x: a.x - rx * 1.6, y: a.y + 7.4, z: a.z - rz * 1.6 }, 3.1, .12, .12, heading);
        count('catenaryMasts');
      }
    });
    count('railways');
  }

  // Overground/overhead district-heating style pipes (OSM location tag): insulated tubes on supports.
  const tube = (a: Vec3, b: Vec3, heading: number, y: number, radius: number) => {
    for (let k = 0; k < 8; k++) {
      const u0 = k / 8 * Math.PI * 2, u1 = (k + 1) / 8 * Math.PI * 2;
      ribbon('env:pipe', a, b, heading, Math.cos(u0) * radius, Math.cos(u1) * radius, y + Math.sin(u0) * radius, y + Math.sin(u1) * radius);
    }
  };
  const traced = (edits.pipelines as Array<{ line: number[][]; count: number; overhead: boolean }>).map(p => ({ ...p, line: p.line as XZ[] }));
  for (const pipe of [...data.pipelines.map(p => ({ ...p, count: 1 })), ...traced]) {
    // Overhead runs cross the MSD near 720 m (orange truss in frames 3187292168/206):
    // 6.5 m to the pipe soffit is an estimate, supports never stand on a carriageway.
    const y = pipe.overhead ? 7 : 1.1;
    let next = 0;
    along(pipe.line, 3, (a, b, heading, s) => {
      // Parallel runs (traced bundles) are spaced 1.05 m centre to centre.
      for (let k = 0; k < pipe.count; k++) {
        const offset = (k - (pipe.count - 1) / 2) * 1.05, rx = Math.cos(heading) * offset, rz = Math.sin(heading) * offset;
        tube({ ...a, x: a.x + rx, z: a.z + rz }, { ...b, x: b.x + rx, z: b.z + rz }, heading, y, .42);
      }
      if (pipe.overhead) for (const side of [-1, 1]) for (const level of [-.75, 1]) {
        ribbon('env:truss', a, b, heading, side * 1.05 - .08, side * 1.05 + .08, y + level);
      }
      if (s >= next) {
        next = s + (pipe.overhead ? 14 : 7);
        if (pipe.overhead) {
          if (!terrain.occupied(a.x, a.z, 1.5)) for (const side of [-1.4, 1.4]) box('env:truss', { x: a.x + Math.cos(heading) * side, y: a.y + (y + 1) / 2, z: a.z + Math.sin(heading) * side }, .35, y + 1, .35, heading);
          else count('pipeSupportsSkippedOnRoad');
        } else box('infrastructureConcrete', { ...a, y: a.y + (y - .42) / 2 }, 1.1 * pipe.count, y - .42, .4, heading);
      }
    });
    if (pipe.overhead) for (const [x, z] of [pipe.line[0], pipe.line.at(-1)!]) {
      // Risers join the overground runs (1.1 m) to the overhead span.
      if (!terrain.occupied(x, z, 1)) box('env:pipe', at(x, z, (1.1 + y) / 2), .84, y - 1.1, .84, 0);
    }
    count('pipelines');
  }

  // Fences, walls, noise barriers: thin vertical panels.
  for (const barrier of data.barriers) {
    if (barrier.kind === 'guard') continue; // road guard rails are owned by roadInfrastructure
    const m: EnvironmentMaterial = barrier.kind === 'fence' ? 'env:fence' : barrier.kind === 'noise' ? 'env:noise' : 'env:wall';
    if (barrier.kind === 'noise') count('noiseBarriers');
    along(barrier.line, 4, (a, b, heading) => {
      if (terrain.occupied((a.x + b.x) / 2, (a.z + b.z) / 2)) return;
      for (const side of [-.06, .06]) ribbon(m, a, b, heading, side, side, -.2, barrier.height);
      ribbon(m, a, b, heading, -.06, .06, barrier.height);
    });
    count('barriers');
  }

  // Trees: deterministic scatter in mapped woods plus individually mapped trees.
  const tree = (x: number, z: number, seed: number) => {
    if (terrain.occupied(x, z, 2.5)) return;
    const h = 9 + hash(seed, 7) * 10, r = 2 + hash(seed, 11) * 1.8, y = terrain.height(x, z);
    const foliage = `env:foliage:${Math.floor(hash(seed, 13) * ENV_FOLIAGE.length)}` as const;
    box('env:trunk', { x, y: y + h * .3, z }, .35, h * .6, .35, 0);
    // Deciduous crown (poplar/birch belts in the road frames): stacked hexagonal rings.
    const turn = hash(seed, 17) * Math.PI, rings = [[.32, .55], [.5, .95], [.72, 1], [.9, .6]] as const;
    const ring = (k: number, level: number, scale: number) => {
      const a = turn + k / 6 * Math.PI * 2 + level * .5;
      return { x: x + Math.cos(a) * r * scale, y: y + h * rings[level][0], z: z + Math.sin(a) * r * scale };
    };
    const top = { x, y: y + h, z }, bottom = { x, y: y + h * .26, z };
    for (let k = 0; k < 6; k++) {
      triangle(foliage, bottom, ring(k + 1, 0, rings[0][1]), ring(k, 0, rings[0][1]));
      for (let level = 1; level < rings.length; level++) {
        const a = ring(k, level - 1, rings[level - 1][1]), b = ring(k + 1, level - 1, rings[level - 1][1]);
        const c = ring(k + 1, level, rings[level][1]), d = ring(k, level, rings[level][1]);
        triangle(foliage, a, b, c); triangle(foliage, a, c, d);
      }
      triangle(foliage, top, ring(k, 3, rings[3][1]), ring(k + 1, 3, rings[3][1]));
    }
    count('trees');
  };
  for (const [index, wood] of data.woods.entries()) {
    const xs = wood.ring.map(p => p[0]), zs = wood.ring.map(p => p[1]);
    for (let x = Math.floor(Math.min(...xs) / 7) * 7; x < Math.max(...xs); x += 7)
      for (let z = Math.floor(Math.min(...zs) / 7) * 7; z < Math.max(...zs); z += 7) {
        const jx = x + hash(x, z, index) * 6, jz = z + hash(z, x, index + 1) * 6;
        if (inside(wood.ring, jx, jz)) tree(jx, jz, Math.round(jx * 31 + jz * 17));
      }
  }
  for (const [x, z] of data.trees) tree(x, z, Math.round(x * 13 + z * 7));

  // Chimneys and masts (OSM nodes; untagged heights are estimates, see data note).
  for (const m of data.masts) {
    const [x, z] = m.position, y = terrain.height(x, z);
    if (m.kind === 'chimney') for (let k = 0; k < 4; k++) box('infrastructureConcrete', { x, y: y + m.height * (k + .5) / 4, z }, 2.4 - k * .35, m.height / 4, 2.4 - k * .35, 0);
    else box('env:steel', { x, y: y + m.height / 2, z }, .9, m.height, .9, 0);
    count('masts');
  }

  // Power lines (OSM): lattice towers at line vertices and three sagging conductors.
  const towerSet = new Set(data.towers.map(([x, z]) => `${Math.round(x)}:${Math.round(z)}`));
  for (const line of data.powerLines) {
    const height = line.voltage >= 220000 ? 38 : 30;
    const tops: Array<{ p: Vec3; heading: number }> = [];
    for (let i = 0; i < line.line.length; i++) {
      const [x, z] = line.line[i], prev = line.line[Math.max(0, i - 1)], next = line.line[Math.min(line.line.length - 1, i + 1)];
      const heading = Math.atan2(next[0] - prev[0], prev[1] - next[1]);
      if (!towerSet.has(`${Math.round(x)}:${Math.round(z)}`) || terrain.route(x, z).distance > 430) continue;
      if (terrain.occupied(x, z, 3)) { count('towersSkippedOnRoad'); continue; }
      const y = terrain.height(x, z);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box('env:pylon', { x: x + Math.cos(heading) * lx * 1.4 - Math.sin(heading) * lz * 1.4, y: y + height * .35, z: z + Math.sin(heading) * lx * 1.4 + Math.cos(heading) * lz * 1.4 }, .25, height * .7, .25, heading);
      box('env:pylon', { x, y: y + height * .85, z }, .9, height * .3, .9, heading);
      for (const level of [.72, .88]) box('env:pylon', { x, y: y + height * level, z }, 12, .35, .5, heading);
      tops.push({ p: { x, y: y + height * .72 - .8, z }, heading }); count('powerTowers');
    }
    for (let i = 1; i < tops.length; i++) for (const side of [-5.5, 0, 5.5]) {
      const a = tops[i - 1], b = tops[i];
      const at = (t: number): Vec3 => ({ x: a.p.x + Math.cos(a.heading) * side + (b.p.x - a.p.x) * t, z: a.p.z + Math.sin(a.heading) * side + (b.p.z - a.p.z) * t,
        y: a.p.y + (b.p.y - a.p.y) * t - 4 * 3.5 * t * (1 - t) });
      for (let k = 0; k < 8; k++) {
        const p = at(k / 8), q = at((k + 1) / 8), length = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        box('env:wire', { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 }, .06, .06, length, Math.atan2(q.x - p.x, p.z - q.z));
      }
    }
  }

  // Tunnels: the bore keeps no terrain; a turf deck on the roof (+6.55 m) carries the
  // cover, with concrete headwalls at the portals. Railways above use terrain height.
  for (const edge of network.edges) {
    if (edge.kind !== 'tunnel') continue;
    const mid = sampleEdge(edge, edge.length / 2);
    if (terrain.route(mid.x, mid.z).distance > 60) continue;
    const ds = roadSampleDistances(edge, 2), at = (s: number, f: number) => { const p = sampleEdge(edge, s); return sampleEdge(edge, s, f * (p.halfWidth * 1.04 + TUNNEL_TURF_MARGIN)); };
    for (let i = 1; i < ds.length; i++) {
      const lift = (q: Vec3): Vec3 => ({ ...q, y: q.y + 6.55 });
      quad('env:turf', lift(at(ds[i - 1], -1)), lift(at(ds[i], -1)), lift(at(ds[i], 1)), lift(at(ds[i - 1], 1)));
    }
    for (const s of [0, edge.length]) {
      // Portal: lintel over the opening and full-height wing walls either side.
      const p = sampleEdge(edge, s), l = at(s, -1), r = at(s, 1), w = p.halfWidth * 1.04;
      const il = sampleEdge(edge, s, -w), ir = sampleEdge(edge, s, w);
      quad('infrastructureConcrete', { ...il, y: p.y + 6.3 }, { ...ir, y: p.y + 6.3 }, { ...ir, y: p.y + 6.9 }, { ...il, y: p.y + 6.9 });
      for (const [a, b] of [[l, il], [ir, r]]) quad('infrastructureConcrete', { ...a, y: p.y - .5 }, { ...b, y: p.y - .5 }, { ...b, y: p.y + 6.9 }, { ...a, y: p.y + 6.9 });
    }
    count('tunnelTurfDecks');
  }

  // Curbed ramp section (frames 2918419731…2918419746): raised concrete curbs on both
  // sides and a footway on the right, following the published surface edge.
  for (const edge of network.edges) {
    const range = msdRampCurbRange(network, edge); if (!range) continue;
    const ds = roadSampleDistances(edge, 2).filter(s => s <= range[1]);
    if (ds.at(-1)! < range[1]) ds.push(range[1]);
    const edgePoint = (s: number, lateral: number, y: number): Vec3 => {
      const p = sampleEdge(edge, s), q = sampleEdge(edge, s, Math.sign(lateral) * (p.halfWidth + Math.abs(lateral)));
      return { x: q.x, y: q.y + y, z: q.z };
    };
    for (let i = 1; i < ds.length; i++) {
      const a = ds[i - 1], b = ds[i];
      for (const side of [-1, 1]) {
        // Kerb face, kerb top, and (right only) footway with its outer face.
        quad('infrastructureConcrete', edgePoint(a, side * .001, -.05), edgePoint(b, side * .001, -.05), edgePoint(b, side * .001, .15), edgePoint(a, side * .001, .15));
        quad('infrastructureConcrete', edgePoint(a, side * .001, .15), edgePoint(b, side * .001, .15), edgePoint(b, side * .2, .15), edgePoint(a, side * .2, .15));
        if (side === 1) {
          quad('env:paved', edgePoint(a, .2, .14), edgePoint(b, .2, .14), edgePoint(b, 2.2, .14), edgePoint(a, 2.2, .14));
          quad('infrastructureConcrete', edgePoint(a, 2.2, .14), edgePoint(b, 2.2, .14), edgePoint(b, 2.2, -.45), edgePoint(a, 2.2, -.45));
        } else quad('infrastructureConcrete', edgePoint(a, -.2, .15), edgePoint(b, -.2, .15), edgePoint(b, -.2, -.45), edgePoint(a, -.2, -.45));
      }
    }
    count('curbedRampMeters', range[1] - range[0]);
  }

  // Retaining walls: where a neighbouring lower road leaves no room for the 1:1.5
  // embankment beside an elevated pilot carriageway, a concrete wall and cornice
  // replace the clamped terrain (no saw-tooth grass cliff). Geometry, not survey.
  for (const edge of network.edges) {
    const way = Number(edge.id.split(':')[1]);
    if (edge.kind !== 'road') continue;
    if (![809185810, 809185806, 809185811, 809185807, 809185786].includes(way)) {
      const mid = sampleEdge(edge, edge.length / 2), at = terrain.route(mid.x, mid.z);
      if (!/Юго-Восточная хорда/.test(edge.route) || at.distance > 45 || at.chainage <= 1942.3 || at.chainage >= MSD_SECTION02.end) continue;
    }
    const ds = roadSampleDistances(edge, 2);
    for (const side of [-1, 1]) {
      const station = (s: number) => {
        const p = sampleEdge(edge, s), lateral = (d: number) => sampleEdge(edge, s, side * (p.halfWidth + d));
        const foot = lateral(3.5), drop = p.y - terrain.height(foot.x, foot.z);
        const wall = lateral(BERM);
        // Only where terrain sits >1 m below the free 1:1.5 embankment at that offset.
        const expected = ROAD_SKIN + (3.5 - BERM) / SLOPE;
        return { p, drop, edgePoint: lateral(0), wall, open: drop > expected + 1 && !terrain.occupied(wall.x, wall.z, -.3) };
      };
      let previous = station(ds[0]);
      for (let i = 1; i < ds.length; i++) {
        const next = station(ds[i]);
        if (previous.open && next.open) {
          const top = (q: Vec3) => ({ x: q.x, y: q.y - .02, z: q.z }), base = (q: Vec3, drop: number) => ({ x: q.x, y: q.y - drop - .3, z: q.z });
          quad('infrastructureConcrete', top(previous.edgePoint), top(next.edgePoint), top(next.wall), top(previous.wall));
          quad('infrastructureConcrete', top(previous.wall), top(next.wall), base(next.wall, next.drop), base(previous.wall, previous.drop));
          count('retainingWallMeters', ds[i] - ds[i - 1]);
        }
        previous = next;
      }
    }
  }

  // Lamp posts (Yandex frames 2918419731…3187293509: right-edge columns with black/white
  // striped bases on the ramp and both mainline outer edges). Spacing is an estimate.
  for (const { edge, spacing } of lampRuns(network, terrain)) {
    for (let s = spacing / 2; s < edge.length; s += spacing) {
      // Bridges: column on the 1.5 m deck cornice; elsewhere 1.9 m beyond the edge on terrain.
      const p = sampleEdge(edge, s), lateral = p.halfWidth + (edge.kind === 'bridge' ? 1.2 : 1.9);
      const base = sampleEdge(edge, s, lateral), x = base.x, z = base.z;
      if (terrain.occupied(x, z, .3)) { count('lampPostsSkipped'); continue; }
      const y = edge.kind === 'bridge' ? p.y : terrain.height(x, z), rx = Math.cos(p.heading), rz = Math.sin(p.heading);
      // Frames after the 4240 m tunnel (3142363828 …) show curved swan-neck columns
      // without striped bases; before it, straight columns with black/white bases.
      const curved = terrain.route(x, z).chainage > 4290;
      if (!curved) for (let k = 0; k < 4; k++) box(k % 2 ? 'infrastructureWhite' : 'infrastructureDark', { x, y: y + .2 + k * .35, z }, .26, .35, .26, p.heading);
      box('env:steel', { x, y: y + 6.6, z }, .18, 10.4, .18, p.heading);
      if (curved) {
        // Arc of four short members bending over the carriageway.
        for (let k = 0; k < 4; k++) {
          const a0 = k / 4 * Math.PI / 2, a1 = (k + 1) / 4 * Math.PI / 2, r = 2.4;
          const px = -Math.sin((a0 + a1) / 2) * r, py = 11.8 + (Math.cos((a0 + a1) / 2) - 1) * r * .35 + .4;
          box('env:steel', { x: x + rx * px, y: y + py, z: z + rz * px }, .95, .12, .12, p.heading);
        }
        box('env:lamp', { x: x - rx * 2.5, y: y + 11.1, z: z - rz * 2.5 }, .55, .14, .3, p.heading);
      } else {
        box('env:steel', { x: x - rx * 1, y: y + 11.6, z: z - rz * 1 }, 2.1, .1, .1, p.heading);
        box('env:lamp', { x: x - rx * 2, y: y + 11.5, z: z - rz * 2 }, .7, .14, .3, p.heading);
      }
      count('lampPosts');
    }
  }
  return stats;
}
