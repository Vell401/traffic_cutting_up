import type { NetworkEdge, RoadNetwork, Vec3 } from './geometry';

type Right = { rightX: number; rightZ: number };
const normal = (a: Vec3, b: Vec3): Right => {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return { rightX: (a.z - b.z) / length, rightZ: (b.x - a.x) / length };
};
/** Unit-chord bisector, not a length-weighted secant. Bound sharp/hairpin miters. */
function miter(a: Right, b: Right): Right {
  const x = a.rightX + b.rightX, z = a.rightZ + b.rightZ, length = Math.hypot(x, z);
  if (length < 1e-6) return a;
  const scale = Math.min(2, 2 / length) / length;
  return { rightX: x * scale, rightZ: z * scale };
}
const width = (e: NetworkEdge, end: boolean) => e.width === undefined
  ? (end ? e.endLanes ?? e.lanes : e.lanes) * 1.8 + 1.5 : e.width / 2;

/** Moscow opt-in: no centreline/height changes and no arbitrary branch wedge fill.
 * Each ordinary directed seam shares a cross-section. Other maps keep legacy sampling.
 * Optional scope leaves all other edges untouched (including selected-boundary frames).
 * Call once after constructing all points; published geometry is immutable thereafter.
 */
export function prepareRoadFrames(network: RoadNetwork, scope?: ReadonlySet<string>): void {
  const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
  const arcs = new Map<NetworkEdge, number[]>();
  for (const e of network.edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    const ds = [0];
    for (let i = 1; i < e.points.length; i++) ds.push(ds[i - 1] + Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z));
    arcs.set(e, ds);
    if (scope && !scope.has(e.id)) continue;
    e.surfaceFrames = e.points.map((p, i) => {
      const before = i ? normal(e.points[i - 1], p) : undefined;
      const after = i < e.points.length - 1 ? normal(p, e.points[i + 1]) : undefined;
      return { ...(before && after ? miter(before, after) : (before ?? after)!), halfWidth: width(e, false) };
    });
  }
  const endpointWidths = new Map<NetworkEdge, { start: number; end: number }>();
  const before = new Map<NetworkEdge, NetworkEdge>(), after = new Map<NetworkEdge, NetworkEdge>();
  for (const e of network.edges) endpointWidths.set(e, { start: width(e, false), end: width(e, true) });
  for (const [node, ins] of incoming) {
    const outs = outgoing.get(node);
    if (ins.length !== 1 || outs?.length !== 1) continue;
    const a = ins[0], b = outs[0];
    if (!a.surfaceFrames || !b.surfaceFrames) continue;
    if (a === b || a.from === b.to) continue;
    const p = a.points.at(-1)!, q = b.points[0];
    if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 1e-7) continue;
    const na = normal(a.points.at(-2)!, p), nb = normal(q, b.points[1]);
    // A reversal is not a through corridor. Do not manufacture a U-turn surface.
    if (na.rightX * nb.rightX + na.rightZ * nb.rightZ < -.95) continue;
    before.set(b, a); after.set(a, b);
    const shared = miter(na, nb), halfWidth = (width(a, true) + width(b, false)) / 2;
    Object.assign(a.surfaceFrames!.at(-1)!, shared);
    Object.assign(b.surfaceFrames![0], shared);
    endpointWidths.get(a)!.end = halfWidth; endpointWidths.get(b)!.start = halfWidth;
  }
  const position = (initial: NetworkEdge, station: number): Vec3 => {
    let e = initial, s = station;
    const seen = new Set<NetworkEdge>();
    while (s < 0 && before.has(e) && !seen.has(e)) {
      seen.add(e); e = before.get(e)!; s += e.length;
    }
    while (s > e.length && after.has(e) && !seen.has(e)) {
      seen.add(e); s -= e.length; e = after.get(e)!;
    }
    const ds = arcs.get(e)!, at = Math.max(0, Math.min(ds.at(-1)!, s));
    let lo = 0, hi = ds.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (ds[mid] <= at) lo = mid; else hi = mid; }
    const t = (at - ds[lo]) / (ds[hi] - ds[lo]), a = e.points[lo], b = e.points[hi];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  for (const e of network.edges) {
    if (!e.surfaceFrames) continue;
    const ends = endpointWidths.get(e)!;
    let s = 0;
    for (let i = 0; i < e.points.length; i++) {
      if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      // Tiny source fillets have a radius smaller than the road width. Their
      // local normals reverse the inner strip. A corridor-scale secant spreads
      // frame rotation over physical distance, including across ordinary seams.
      const a = position(e, s - 40), b = position(e, s + 40);
      if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-8) Object.assign(e.surfaceFrames![i], normal(a, b));
      const t = s / e.length, reach = Math.min(20, e.length / 2);
      e.surfaceFrames![i].halfWidth = width(e, false) + (width(e, true) - width(e, false)) * t
        + (ends.start - width(e, false)) * Math.max(0, 1 - s / reach)
        + (ends.end - width(e, true)) * Math.max(0, 1 - (e.length - s) / reach);
    }
  }
  // Eliminate numerical drift from traversing the same corridor in opposite
  // directions. Endpoint frames and widths are literally the same values.
  for (const [a, b] of after) Object.assign(b.surfaceFrames![0], a.surfaceFrames!.at(-1)!);
  if (scope) for (const e of network.edges) {
    if (!e.surfaceFrames) continue;
    for (const start of [true, false]) {
      const adjacent = start ? incoming.get(e.from) : outgoing.get(e.to);
      if (!adjacent?.some(other => !scope.has(other.id))) continue;
      const other = adjacent.find(other => !scope.has(other.id))!;
      // At the polish boundary retain the untouched neighbour's cross-section.
      // Genuine branches remain separate movements, never filled wedges.
      if (adjacent.length !== 1) continue;
      const points = other.points;
      const target = start ? normal(points.at(-2)!, points.at(-1)!) : normal(points[0], points[1]);
      const ds = arcs.get(e)!;
      for (let i = 0; i < ds.length; i++) {
        const distance = start ? ds[i] : e.length - ds[i];
        const weight = Math.max(0, 1 - distance / Math.min(40, e.length));
        const frame = e.surfaceFrames[i];
        const x = frame.rightX * (1 - weight) + target.rightX * weight;
        const z = frame.rightZ * (1 - weight) + target.rightZ * weight;
        const length = Math.hypot(x, z);
        if (length > 1e-8) { frame.rightX = x / length; frame.rightZ = z / length; }
        frame.halfWidth += (width(other, start) - width(e, !start)) * weight;
      }
    }
  }
  // Explicit pilot through movements only. Ordinary-chain discovery deliberately
  // stops at branches, but these two surveyed graph continuations must share a
  // through tangent. Keep the branch's chart, centreline and all widths intact.
  if (network.id.startsWith('moscow-osm')) for (const [incomingId, outgoingId] of [
    ['osm:1207836340:1:2', 'osm:809185810:1:0'],
    ['osm:809185806:1:0', 'osm:809185806:1:1'],
  ]) {
    const a = network.edges.find(e => e.id === incomingId), b = network.edges.find(e => e.id === outgoingId);
    if (!a?.surfaceFrames || !b?.surfaceFrames || a.to !== b.from
      || (scope && (!scope.has(a.id) || !scope.has(b.id)))) continue;
    const p = a.points.at(-1)!, q = b.points[0];
    if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 1e-7) continue;
    const through = (s: number) => s < 0 ? position(a, a.length + s) : position(b, s);
    for (const edge of [a, b]) {
      const ds = arcs.get(edge)!;
      for (let i = 0; i < ds.length; i++) {
        const station = edge === a ? ds[i] - a.length : ds[i];
        const weight = Math.max(0, 1 - Math.abs(station) / 40);
        if (!weight) continue;
        const tangent = normal(through(station - 40), through(station + 40));
        const frame = edge.surfaceFrames![i];
        const x = frame.rightX * (1 - weight) + tangent.rightX * weight;
        const z = frame.rightZ * (1 - weight) + tangent.rightZ * weight;
        const length = Math.hypot(x, z);
        if (length > 1e-8) { frame.rightX = x / length; frame.rightZ = z / length; }
      }
    }
    const shared = a.surfaceFrames.at(-1)!;
    b.surfaceFrames[0].rightX = shared.rightX; b.surfaceFrames[0].rightZ = shared.rightZ;
  }
}
