import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';

/** Deliberately one flat merge, not a proximity-based interchange treatment. */
export const PILOT_MERGE_NODE = 'osm-node:7566321603';
export const PILOT_MAIN_IN = 'osm:1207836340:1:2';
export const PILOT_MAIN_OUT = 'osm:809185810:1:0';
export const PILOT_RAMP = 'osm:1207836341:1:6';
export type SurfaceTriangle = [Vec3, Vec3, Vec3];
export interface PilotJunctionSurface {
  surfaces: Map<string, SurfaceTriangle[]>;
  original: SurfaceTriangle[];
  windows: Map<string, { start: number; end: number }>;
  localSurfaces: Map<string, SurfaceTriangle[]>;
}
const cross = (a: Vec3, b: Vec3, p: Vec3) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
export const triangleArea = (t: SurfaceTriangle) => Math.abs(cross(...t)) / 2;
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const boxes = new WeakMap<SurfaceTriangle, number[]>();
function bounds(t: SurfaceTriangle): number[] {
  let b = boxes.get(t);
  if (!b) { b = [Math.min(...t.map(p => p.x)), Math.max(...t.map(p => p.x)), Math.min(...t.map(p => p.z)), Math.max(...t.map(p => p.z))]; boxes.set(t, b); }
  return b;
}
function disjoint(a: SurfaceTriangle, b: SurfaceTriangle): boolean {
  const p = bounds(a), q = bounds(b);
  return p[1] <= q[0] || p[0] >= q[1] || p[3] <= q[2] || p[2] >= q[3];
}
function halfPlane(polygon: Vec3[], a: Vec3, b: Vec3, orientation: number, inside: boolean): Vec3[] {
  const result: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    const cp = cross(a, b, p) * orientation, cq = cross(a, b, q) * orientation;
    const ip = inside ? cp >= 0 : cp <= 0, iq = inside ? cq >= 0 : cq <= 0;
    if (ip) result.push(p);
    if (ip !== iq) result.push(mix(p, q, cp / (cp - cq)));
  }
  return result;
}
const triangulate = (p: Vec3[]): SurfaceTriangle[] => p.slice(1, -1)
  .map((v, i): SurfaceTriangle => [p[0], v, p[i + 2]]).filter(t => triangleArea(t) > 1e-10);
/** Convex subtraction preserves source heights and never fills a gap between arms. */
export function subtractTriangle(subject: SurfaceTriangle, cutter: SurfaceTriangle): SurfaceTriangle[] {
  if (disjoint(subject, cutter)) return [subject];
  const result: SurfaceTriangle[] = [];
  let remainder: Vec3[] = subject;
  const orientation = Math.sign(cross(...cutter));
  for (let i = 0; i < 3 && remainder.length; i++) {
    const a = cutter[i], b = cutter[(i + 1) % 3];
    result.push(...triangulate(halfPlane(remainder, a, b, orientation, false)));
    remainder = halfPlane(remainder, a, b, orientation, true);
  }
  return result;
}
export function intersectionArea(a: SurfaceTriangle, b: SurfaceTriangle): number {
  if (disjoint(a, b)) return 0;
  let polygon: Vec3[] = a;
  const orientation = Math.sign(cross(...b));
  for (let i = 0; i < 3; i++) polygon = halfPlane(polygon, b[i], b[(i + 1) % 3], orientation, true);
  return triangulate(polygon).reduce((sum, t) => sum + triangleArea(t), 0);
}
export function pilotMergeEdges(network: RoadNetwork): NetworkEdge[] {
  if (!network.id.startsWith('moscow-osm')) return [];
  const edges = [PILOT_MAIN_OUT, PILOT_MAIN_IN, PILOT_RAMP].map(id => network.edges.find(e => e.id === id));
  if (edges.some(e => !e)) return [];
  const [out, incoming, ramp] = edges as NetworkEdge[];
  if (out.from !== PILOT_MERGE_NODE || incoming.to !== out.from || ramp.to !== out.from) return [];
  // A future profile change must not silently weld separate decks or flatten a grade.
  for (const e of edges as NetworkEdge[]) {
    const start = e === out ? 0 : Math.max(0, e.length - 100), end = e === out ? Math.min(100, e.length) : e.length;
    for (const s of [start, end, ...roadSampleDistances(e).filter(s => s > start && s < end)])
      if (Math.abs(sampleEdge(e, s).y - sampleEdge(out, 0).y) > 1e-7) return [];
  }
  return edges as NetworkEdge[];
}
export function planPilotJunctionSurface(network: RoadNetwork): PilotJunctionSurface {
  return ownedSurface(pilotMergeEdges(network), edge => edge.id !== PILOT_MAIN_OUT);
}

/** Second explicit pilot junction: the 1576 m exit diverge. Mainline arms own the
 * throat; the exit keeps only asphalt outside them. Not a generic interchange pass.
 */
export const PILOT_DIVERGE_NODE = 'osm-node:7566321594';
export const PILOT_DIVERGE_IN = 'osm:809185806:1:0';
export const PILOT_DIVERGE_OUT = 'osm:809185806:1:1';
export const PILOT_EXIT = 'osm:809185786:1:0';
export function pilotDivergeEdges(network: RoadNetwork): NetworkEdge[] {
  if (!network.id.startsWith('moscow-osm')) return [];
  const edges = [PILOT_DIVERGE_IN, PILOT_DIVERGE_OUT, PILOT_EXIT].map(id => network.edges.find(e => e.id === id));
  if (edges.some(e => !e)) return [];
  const [incoming, out, exit] = edges as NetworkEdge[];
  if (incoming.to !== PILOT_DIVERGE_NODE || out.from !== PILOT_DIVERGE_NODE || exit.from !== PILOT_DIVERGE_NODE) return [];
  return edges as NetworkEdge[];
}
export function planPilotDivergeSurface(network: RoadNetwork): PilotJunctionSurface {
  return ownedSurface(pilotDivergeEdges(network), edge => edge.id === PILOT_DIVERGE_IN);
}

/** Earlier arms own overlapping asphalt; `endsAtNode` arms use their final 100 m. */
function ownedSurface(arms: NetworkEdge[], endsAtNode: (edge: NetworkEdge) => boolean): PilotJunctionSurface {
  const plan: PilotJunctionSurface = { surfaces: new Map(), original: [], windows: new Map(), localSurfaces: new Map() };
  const claimed: SurfaceTriangle[] = [];
  for (const edge of arms) {
    const ds = roadSampleDistances(edge);
    const start = !endsAtNode(edge) ? 0 : ds.filter(s => s <= Math.max(0, edge.length - 100)).at(-1)!;
    // Short arms (<100 m) end on their last station, which may differ from the
    // published length by rounding: never leave the window open-ended.
    const end = !endsAtNode(edge) ? ds.find(s => s >= Math.min(100, edge.length) - 1e-9) ?? ds.at(-1)! : edge.length;
    plan.windows.set(edge.id, { start, end });
    const stations = ds;
    const output: SurfaceTriangle[] = []; plan.surfaces.set(edge.id, output);
    const local: SurfaceTriangle[] = []; plan.localSurfaces.set(edge.id, local);
    const original: SurfaceTriangle[] = [];
    for (let i = 1; i < stations.length; i++) {
      const s = stations[i - 1], t = stations[i];
      const w = sampleEdge(edge, s).halfWidth, v = sampleEdge(edge, t).halfWidth;
      const a = sampleEdge(edge, s, -w), b = sampleEdge(edge, t, -v);
      const c = sampleEdge(edge, t, v), d = sampleEdge(edge, s, w);
      const triangles: SurfaceTriangle[] = [[a, b, c], [a, c, d]];
      if (s >= start && t <= end) original.push(...triangles);
      else output.push(...triangles);
    }
    plan.original.push(...original);
    for (const triangle of original) {
      let pieces = [triangle];
      for (const cutter of claimed.filter(cutter => !disjoint(triangle, cutter))) pieces = pieces.flatMap(piece => subtractTriangle(piece, cutter));
      output.push(...pieces); local.push(...pieces);
    }
    claimed.push(...original);
  }
  return plan;
}

/** Common paint endpoint only; published road frames and driving remain unchanged. */
export function pilotMarkingPoint(edge: NetworkEdge, s: number, d: number, arms: NetworkEdge[]): Vec3 {
  const atMerge = edge.id === PILOT_MAIN_IN && Math.abs(s - edge.length) < 1e-7
    || edge.id === PILOT_MAIN_OUT && s < 1e-7;
  if (atMerge && arms.length) {
    const incoming = arms.find(e => e.id === PILOT_MAIN_IN)!, out = arms.find(e => e.id === PILOT_MAIN_OUT)!;
    const a = sampleEdge(incoming, incoming.length), b = sampleEdge(out, 0);
    const rx = Math.cos(a.heading) + Math.cos(b.heading), rz = Math.sin(a.heading) + Math.sin(b.heading);
    const magnitude = Math.hypot(rx, rz);
    return { x: b.x + rx / magnitude * d, y: b.y, z: b.z + rz / magnitude * d };
  }
  return sampleEdge(edge, s, d);
}
