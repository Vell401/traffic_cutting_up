/** Standalone, metre-based network geometry. Treat published edge points as immutable. */
export type Vec3 = { x: number; y: number; z: number };
export type RoadKind = 'road' | 'bridge' | 'tunnel' | 'parking';
export interface NetworkNode { id: string; position: Vec3 }
export interface NetworkEdge {
  id: string; from: string; to: string; points: Vec3[]; lanes: number;
  endLanes?: number; width?: number; kind: RoadKind; route: string; length: number;
  /** Optional continuous unit ribbon normals/widths, aligned with immutable points. */
  surfaceFrames?: Array<{ rightX: number; rightZ: number; halfWidth: number }>;
}
export interface Parking { id: string; name: string; edgeId: string; s: number }
export interface RoadNetwork { id: string; nodes: NetworkNode[]; edges: NetworkEdge[]; parkings: Parking[];
  /** A clipped real-world network has genuine boundary dead ends, not artificial return ramps. */
  openBoundaries?: boolean;
}
export interface SurfaceSample extends Vec3 {
  heading: number; grade: number; curvature: number; lanes: number; halfWidth: number;
}

const distances = new WeakMap<NetworkEdge, number[]>();
function arc(edge: NetworkEdge): number[] {
  let result = distances.get(edge);
  if (!result) {
    result = [0];
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      result.push(result[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    distances.set(edge, result);
  }
  return result;
}
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Include every polyline/profile vertex: uniform stations alone can cut corners. */
export function roadSampleDistances(edge: NetworkEdge, maxStep = 5): number[] {
  if (!(maxStep > 0 && Number.isFinite(maxStep))) throw new RangeError('Invalid road sample step');
  const ds = arc(edge), result = [0];
  for (let i = 1; i < ds.length; i++) {
    const steps = Math.max(1, Math.ceil((ds[i] - ds[i - 1]) / maxStep));
    for (let j = 1; j <= steps; j++) result.push(j === steps ? ds[i] : ds[i - 1] + (ds[i] - ds[i - 1]) * j / steps);
  }
  return result;
}

/** Horizontal arc distance, positive d to the driver's right; fractional lanes form tapers. */
export function sampleEdge(edge: NetworkEdge, s: number, d = 0): SurfaceSample {
  const ds = arc(edge), last = ds.length - 1;
  if (last < 1 || !(ds[last] > 0)) throw new Error(`Degenerate edge: ${edge.id}`);
  const at = Math.max(0, Math.min(ds[last], Number.isNaN(s) ? 0 : s));
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (ds[mid] <= at) lo = mid; else hi = mid; }
  const a = edge.points[lo], b = edge.points[hi];
  const t = (at - ds[lo]) / (ds[hi] - ds[lo]);
  const tangent = (i: number) => {
    const p = edge.points[Math.max(0, i - 1)], q = edge.points[Math.min(last, i + 1)];
    return Math.atan2(q.x - p.x, p.z - q.z);
  };
  const h0 = tangent(lo), turn = angleDelta(h0, tangent(hi));
  const heading = h0 + turn * t;
  const lanes = edge.lanes + ((edge.endLanes ?? edge.lanes) - edge.lanes) * at / ds[last];
  if (edge.surfaceFrames) {
    const f = edge.surfaceFrames[lo], g = edge.surfaceFrames[hi];
    const rx = f.rightX + (g.rightX - f.rightX) * t, rz = f.rightZ + (g.rightZ - f.rightZ) * t;
    const magnitude = Math.hypot(rx, rz);
    return {
      x: a.x + (b.x - a.x) * t + rx / magnitude * d, y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t + rz / magnitude * d,
      heading: Math.atan2(rz, rx), grade: (b.y - a.y) / (ds[hi] - ds[lo]),
      curvature: (rx * (g.rightZ - f.rightZ) - rz * (g.rightX - f.rightX))
        / ((rx * rx + rz * rz) * (ds[hi] - ds[lo])),
      lanes, halfWidth: f.halfWidth + (g.halfWidth - f.halfWidth) * t,
    };
  }
  return {
    x: a.x + (b.x - a.x) * t + Math.cos(heading) * d,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t + Math.sin(heading) * d,
    heading, grade: (b.y - a.y) / (ds[hi] - ds[lo]),
    curvature: turn / (ds[hi] - ds[lo]), lanes,
    halfWidth: edge.width === undefined ? lanes * 3.6 / 2 + 1.5 : edge.width / 2,
  };
}
export function edgeById(network: RoadNetwork, id: string): NetworkEdge {
  const edge = network.edges.find(e => e.id === id);
  if (!edge) throw new Error(`Unknown network edge: ${id}`);
  return edge;
}
export function outgoing(network: RoadNetwork, edgeId: string): NetworkEdge[] {
  const edge = edgeById(network, edgeId);
  return network.edges.filter(e => e.from === edge.to);
}
/** Sum of directed carriageways, including ramps and parking access (not unique axes). */
export function networkLength(network: RoadNetwork): number {
  return network.edges.reduce((sum, edge) => sum + edge.length, 0);
}

export function validateNetwork(network: RoadNetwork): string[] {
  const errors: string[] = [];
  const unique = (ids: string[], label: string) => {
    const seen = new Set<string>();
    for (const id of ids) { if (!id || seen.has(id)) errors.push(`Duplicate/empty ${label}: ${id}`); seen.add(id); }
  };
  const finite = (p: Vec3) => [p.x, p.y, p.z].every(Number.isFinite);
  const gap = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  unique(network.nodes.map(n => n.id), 'node'); unique(network.edges.map(e => e.id), 'edge');
  unique(network.parkings.map(p => p.id), 'parking');
  const nodes = new Map(network.nodes.map(n => [n.id, n]));
  for (const node of network.nodes) if (!finite(node.position)) errors.push(`Nonfinite node: ${node.id}`);
  for (const edge of network.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to) errors.push(`Missing endpoint: ${edge.id}`);
    if (edge.points.length < 2 || edge.points.some(p => !finite(p))) { errors.push(`Invalid points: ${edge.id}`); continue; }
    let length = 0;
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      const ds = Math.hypot(b.x - a.x, b.z - a.z);
      if (!(ds > 0)) errors.push(`Degenerate segment: ${edge.id}/${i}`);
      length += ds;
    }
    if (!Number.isFinite(edge.length) || edge.length <= 0 || Math.abs(length - edge.length) > 0.01) errors.push(`Length mismatch: ${edge.id}`);
    if (!(Number.isFinite(edge.lanes) && edge.lanes > 0) || (edge.endLanes !== undefined && !(Number.isFinite(edge.endLanes) && edge.endLanes > 0))) errors.push(`Invalid lanes: ${edge.id}`);
    if (edge.width !== undefined && !(Number.isFinite(edge.width) && edge.width > 0)) errors.push(`Invalid width: ${edge.id}`);
    if (!['road', 'bridge', 'tunnel', 'parking'].includes(edge.kind)) errors.push(`Invalid kind: ${edge.id}`);
    if (from && gap(from.position, edge.points[0]) > 0.01 || to && gap(to.position, edge.points[edge.points.length - 1]) > 0.01) errors.push(`Endpoint gap: ${edge.id}`);
  }
  for (const parking of network.parkings) {
    const edge = network.edges.find(e => e.id === parking.edgeId);
    if (!edge || !Number.isFinite(parking.s) || parking.s < 0 || parking.s > edge.length) errors.push(`Invalid parking: ${parking.id}`);
  }
  // Two graph traversals prove strong connectivity, without quadratic all-pairs searches.
  if (network.nodes.length && !network.openBoundaries) for (const reverse of [false, true]) {
    const adjacency = new Map<string, string[]>();
    for (const e of network.edges) {
      const a = reverse ? e.to : e.from, b = reverse ? e.from : e.to;
      const list = adjacency.get(a) ?? []; list.push(b); adjacency.set(a, list);
    }
    const seen = new Set<string>(), pending = [network.nodes[0].id];
    while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id); pending.push(...(adjacency.get(id) ?? [])); }
    if (network.nodes.some(n => !seen.has(n.id))) { errors.push('Network is not strongly connected'); break; }
  }
  return errors;
}
