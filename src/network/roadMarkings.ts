import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';
import { msdRampCurbRange } from './msdPilot';
import { PILOT_DIVERGE_IN, PILOT_DIVERGE_OUT, PILOT_EXIT, PILOT_MAIN_IN, PILOT_MAIN_OUT, PILOT_RAMP, pilotDivergeEdges, pilotMergeEdges, pilotMarkingPoint, intersectionArea, type SurfaceTriangle } from './pilotJunctionSurface';

export const LANE_WIDTH = 3.6;
export const EDGE_LINE_WIDTH = .2;
export const LANE_LINE_WIDTH = .15;
export const DASH_LENGTH = 3;
export const DASH_PERIOD = 12;
export interface MarkingSegment {
  kind: 'edge' | 'lane'; start: number; end: number;
  /** Lateral centre at the start/end, metres to the driver's right. */
  d0: number; d1: number; width: number;
}
export interface RoadMarkingPlan { phase: Map<string, number>; segments: Map<string, MarkingSegment[]> }

function laneHalfWidth(edge: NetworkEdge, s: number): number {
  const p = sampleEdge(edge, s);
  // Explicit narrow source widths take precedence over the nominal lane width.
  return Math.min(p.lanes * LANE_WIDTH / 2, Math.max(0, p.halfWidth - .25));
}

type Triangle = { points: [Vec3, Vec3, Vec3]; minX: number; maxX: number; minZ: number; maxZ: number };
/** Same sampled surface/width/frames as asphalt, not a coarse constant-width capsule. */
type Ribbon = Map<string, Triangle[]>;
function ribbon(edge: NetworkEdge): Ribbon {
  const stations = roadSampleDistances(edge, 2), triangles: Triangle[] = [];
  const sides = stations.map(s => {
    const width = sampleEdge(edge, s).halfWidth;
    return [sampleEdge(edge, s, -width), sampleEdge(edge, s, width)];
  });
  for (let i = 1; i < sides.length; i++) {
    const [a, d] = sides[i - 1], [b, c] = sides[i];
    for (const points of [[a, b, c], [a, c, d]] as Array<[Vec3, Vec3, Vec3]>) triangles.push({ points,
      minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
      minZ: Math.min(...points.map(p => p.z)), maxZ: Math.max(...points.map(p => p.z)) });
  }
  const bins: Ribbon = new Map();
  for (const triangle of triangles) {
    for (let x = Math.floor(triangle.minX / 16); x <= Math.floor(triangle.maxX / 16); x++) {
      for (let z = Math.floor(triangle.minZ / 16); z <= Math.floor(triangle.maxZ / 16); z++) {
        const key = `${x}:${z}`, bin = bins.get(key) ?? [];
        bin.push(triangle); bins.set(key, bin);
      }
    }
  }
  return bins;
}
function insideRibbon(p: Vec3, surface: Ribbon): boolean {
  return (surface.get(`${Math.floor(p.x / 16)}:${Math.floor(p.z / 16)}`) ?? []).some(triangle => {
    if (p.x < triangle.minX || p.x > triangle.maxX || p.z < triangle.minZ || p.z > triangle.maxZ) return false;
    const [a, b, c] = triangle.points;
    const determinant = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(determinant) < 1e-9) return false;
    const u = ((b.z - c.z) * (p.x - c.x) + (c.x - b.x) * (p.z - c.z)) / determinant;
    const v = ((c.z - a.z) * (p.x - c.x) + (a.x - c.x) * (p.z - c.z)) / determinant;
    return u >= 0 && v >= 0 && u + v <= 1 && Math.abs(p.y - (u * a.y + v * b.y + (1 - u - v) * c.y)) < 1;
  });
}

/** Pure CPU plan. Topology supplies continuity, lane counts supply spacing; no invented regulatory detail. */
export function planRoadMarkings(network: RoadNetwork, selected: ReadonlySet<string>): RoadMarkingPlan {
  const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
  for (const edge of network.edges) {
    const ins = incoming.get(edge.to) ?? []; ins.push(edge); incoming.set(edge.to, ins);
    const outs = outgoing.get(edge.from) ?? []; outs.push(edge); outgoing.set(edge.from, outs);
  }
  const edges = network.edges.filter(e => selected.has(e.id)), phase = new Map<string, number>();
  const pilotArms = pilotMergeEdges(network);
  const pilotMainIn = pilotArms.find(e => e.id === PILOT_MAIN_IN), pilotMainOut = pilotArms.find(e => e.id === PILOT_MAIN_OUT);
  const pilotMainTriangles: SurfaceTriangle[] = [];
  // Second explicit junction: the 1576 m exit. Its arms are disjoint from the merge.
  const divergeArms = pilotDivergeEdges(network);
  const divergeIn = divergeArms.find(e => e.id === PILOT_DIVERGE_IN), divergeOut = divergeArms.find(e => e.id === PILOT_DIVERGE_OUT);
  const divergeMainTriangles: SurfaceTriangle[] = [];
  for (const main of [...pilotArms.filter(e => e.id !== PILOT_RAMP), ...divergeArms.filter(e => e.id !== PILOT_EXIT)]) {
    const stations = roadSampleDistances(main);
    const target = main.id === PILOT_DIVERGE_IN || main.id === PILOT_DIVERGE_OUT ? divergeMainTriangles : pilotMainTriangles;
    for (let i = 1; i < stations.length; i++) {
      const s = stations[i - 1], t = stations[i];
      if (main.id === PILOT_MAIN_IN || main.id === PILOT_DIVERGE_IN ? main.length - t > 100 : s > 100) continue;
      const w = sampleEdge(main, s).halfWidth, v = sampleEdge(main, t).halfWidth;
      const a = sampleEdge(main, s, -w), b = sampleEdge(main, t, -v);
      const c = sampleEdge(main, t, v), d = sampleEdge(main, s, w);
      target.push([a, b, c], [a, c, d]);
    }
  }
  const ordinary = (node: string) => incoming.get(node)?.length === 1 && outgoing.get(node)?.length === 1;
  // A source tag boundary on a two-way road has 2-in/2-out but only two
  // physical arms. Reverse directed copies are not additional branch mouths.
  const branch = (node: string) => {
    const arms: Array<{ x: number; z: number }> = [];
    for (const road of [...(incoming.get(node) ?? []), ...(outgoing.get(node) ?? [])]) {
      const start = road.from === node, at = start ? 0 : road.length;
      const a = sampleEdge(road, at), b = sampleEdge(road, start ? Math.min(8, road.length) : Math.max(0, road.length - 8));
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (!length) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      if (!arms.some(arm => arm.x * direction.x + arm.z * direction.z > .995)) arms.push(direction);
    }
    return arms.length > 2;
  };
  const branchNodes = new Set([...incoming.keys(), ...outgoing.keys()].filter(branch));
  const ribbons = new Map<NetworkEdge, Ribbon>();
  const crossSections = new Map<string, number>();
  for (const edge of edges) if (ordinary(edge.to)) {
    const next = outgoing.get(edge.to)![0];
    if (!selected.has(next.id)) continue;
    const nominal = (laneHalfWidth(edge, edge.length) + laneHalfWidth(next, 0)) / 2;
    crossSections.set(edge.to, Math.min(nominal, sampleEdge(edge, edge.length).halfWidth - .25, sampleEdge(next, 0).halfWidth - .25));
  }
  const paintHalfWidth = (edge: NetworkEdge, s: number) => {
    const taper = Math.min(20, edge.length / 2), base = laneHalfWidth(edge, s);
    if (pilotMainIn && pilotMainOut) {
      const common = Math.min(laneHalfWidth(pilotMainIn, pilotMainIn.length), laneHalfWidth(pilotMainOut, 0));
      if (edge.id === PILOT_MAIN_IN && edge.length - s < taper) return common + (base - common) * (edge.length - s) / taper;
      if (edge.id === PILOT_MAIN_OUT && s < taper) return common + (base - common) * s / taper;
    }
    const start = crossSections.get(edge.from), end = crossSections.get(edge.to);
    if (start !== undefined && s < taper) return start + (base - start) * s / taper;
    if (end !== undefined && edge.length - s < taper) return end + (base - end) * (edge.length - s) / taper;
    return base;
  };
  // Walk backwards to the start of each ordinary chain, then forwards; iterative for long OSM ways.
  for (const seed of edges) {
    if (phase.has(seed.id)) continue;
    let first = seed; const seen = new Set<string>();
    while (ordinary(first.from)) {
      const prev = incoming.get(first.from)![0];
      if (!selected.has(prev.id) || seen.has(prev.id) || phase.has(prev.id)) break;
      seen.add(first.id); first = prev;
    }
    const prev = ordinary(first.from) ? incoming.get(first.from)![0] : undefined;
    let offset = prev && phase.has(prev.id) ? phase.get(prev.id)! + prev.length : 0;
    let edge: NetworkEdge | undefined = first;
    while (edge && selected.has(edge.id) && !phase.has(edge.id)) {
      phase.set(edge.id, offset % DASH_PERIOD); offset += edge.length;
      edge = ordinary(edge.to) ? outgoing.get(edge.to)![0] : undefined;
    }
  }
  const segments = new Map<string, MarkingSegment[]>();
  // Keep the through movement's existing incoming chain phase across both explicit
  // pilot junctions, in route order (the merge chain reaches the diverge first).
  for (const [into, onward] of [[pilotMainIn, pilotMainOut], [divergeIn, divergeOut]]) {
    if (!into || !onward) continue;
    let next: NetworkEdge | undefined = onward;
    let offset = (phase.get(into.id) ?? 0) + into.length;
    const visited = new Set<string>();
    while (next && selected.has(next.id) && !visited.has(next.id)) {
      visited.add(next.id); phase.set(next.id, offset % DASH_PERIOD); offset += next.length;
      next = ordinary(next.to) ? outgoing.get(next.to)![0] : undefined;
    }
  }
  for (const edge of edges) {
    const paint: MarkingSegment[] = []; segments.set(edge.id, paint);
    if (edge.kind === 'parking') continue;
    const neighbors = new Set<NetworkEdge>();
    for (const node of [edge.from, edge.to]) if (branchNodes.has(node)) {
      for (const other of [...(incoming.get(node) ?? []), ...(outgoing.get(node) ?? [])]) if (other !== edge) neighbors.add(other);
    }
    const add = (kind: MarkingSegment['kind'], start: number, end: number, lateral: (s: number) => number, width: number) => {
      const d0 = lateral(start), d1 = lateral(end);
      const covered = (s: number) => {
        const p = sampleEdge(edge, s, lateral(s));
        for (const other of neighbors) {
          let surface = ribbons.get(other);
          if (!surface) { surface = ribbon(other); ribbons.set(other, surface); }
          if (insideRibbon(p, surface)) return true;
        }
        return false;
      };
      const overlap = [covered(start), covered((start + end) / 2), covered(end)];
      const pilotMain = pilotMainIn && (edge.id === PILOT_MAIN_IN && edge.length - start <= 100
        || edge.id === PILOT_MAIN_OUT && end <= 100)
        || divergeIn && (edge.id === PILOT_DIVERGE_IN && edge.length - start <= 100
        || edge.id === PILOT_DIVERGE_OUT && end <= 100);
      if (pilotMain) {
        // The mainline owns the throat paint; its ramp may not erase through lanes.
        paint.push({ kind, start, end, d0, d1, width }); return;
      }
      const branchTriangles = pilotMainIn && edge.id === PILOT_RAMP && edge.length - start <= 100 ? pilotMainTriangles
        : divergeIn && edge.id === PILOT_EXIT && start <= 100 ? divergeMainTriangles : undefined;
      if (branchTriangles) {
        // Test full paint polygons, not only their centres. Suppress a leaf if any
        // positive area touches either mainline ribbon, retaining branch paint outside.
        const p = (s: number, d: number) => pilotMarkingPoint(edge, s, d, pilotArms);
        const a = p(start, d0 - width / 2), b = p(end, d1 - width / 2);
        const c = p(end, d1 + width / 2), d = p(start, d0 + width / 2);
        const paintTriangles: SurfaceTriangle[] = [[a, b, c], [a, c, d]];
        const touches = branchTriangles.some(t => paintTriangles.some(p => intersectionArea(p, t) > 1e-10));
        if (touches) {
          // The exit lane runs almost parallel to the mainline edge: fine refinement
          // there leaves isolated paint crumbs, so stop at whole-metre pieces.
          if (end - start > (edge.id === PILOT_EXIT ? 1 : .125)) { const mid = (start + end) / 2; add(kind, start, mid, lateral, width); add(kind, mid, end, lateral, width); }
          return;
        }
        paint.push({ kind, start, end, d0, d1, width }); return;
      }
      if (overlap.some(Boolean)) {
        // Refine only the mouth boundary: do not discard an entire ordinary
        // paint interval because its endpoint touches a traversable branch.
        if (!overlap.every(Boolean) && end - start > .125) {
          const mid = (start + end) / 2;
          add(kind, start, mid, lateral, width); add(kind, mid, end, lateral, width);
        }
        return;
      }
      paint.push({ kind, start, end, d0, d1, width });
    };
    const distances = roadSampleDistances(edge, 2);
    // The curbed ramp section carries no paint in the road frames.
    const unpainted = msdRampCurbRange(network, edge);
    let vertex = 1;
    for (let start = 0; start < edge.length - 1e-7;) {
      while (vertex < distances.length - 1 && distances[vertex] <= start + 1e-7) vertex++;
      const absolute = start + (phase.get(edge.id) ?? 0);
      const cycle = ((absolute % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD;
      const on = cycle < DASH_LENGTH - 1e-7;
      const nextBoundary = on ? DASH_LENGTH - cycle : DASH_PERIOD - cycle;
      const candidate = Math.min(edge.length, distances[vertex] ?? edge.length, start + Math.max(1e-6, nextBoundary));
      const end = edge.length - candidate < 1e-7 ? edge.length : candidate;
      if (unpainted && end <= unpainted[1] + 1e-7) { start = end; continue; }
      for (const side of [-1, 1]) add('edge', start, end, s => side * paintHalfWidth(edge, s), EDGE_LINE_WIDTH);
      if (on) for (let lane = 1; lane < Math.max(edge.lanes, edge.endLanes ?? edge.lanes); lane++) {
        const lateral = (s: number) => -paintHalfWidth(edge, s) + lane * LANE_WIDTH;
        if (lateral(start) + LANE_LINE_WIDTH / 2 < paintHalfWidth(edge, start) - EDGE_LINE_WIDTH
          && lateral(end) + LANE_LINE_WIDTH / 2 < paintHalfWidth(edge, end) - EDGE_LINE_WIDTH) add('lane', start, end, lateral, LANE_LINE_WIDTH);
      }
      start = end;
    }
  }
  // No hatch polygons: source centreline topology alone cannot identify a non-traversable gore.
  return { phase, segments };
}
