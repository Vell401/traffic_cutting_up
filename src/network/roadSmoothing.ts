import type { NetworkEdge, RoadNetwork, Vec3 } from './geometry';

const distance = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.z - a.z);
type Direction = { x: number; z: number };
const direction = (a: Vec3, b: Vec3): Direction => {
  const d = distance(a, b); return { x: (b.x - a.x) / d, z: (b.z - a.z) / d };
};
const bisector = (a: Direction, b: Direction): Direction => {
  const d = Math.hypot(a.x + b.x, a.z + b.z);
  return d > .4 ? { x: (a.x + b.x) / d, z: (a.z + b.z) / d } : a;
};

/** Mutates construction-time geometry only, before frames or sampleEdge caches.
 * Cubics interpolate graph endpoints (including true branches), never proximity
 * joins. Handles stay in a bounded corridor around each original chord. Heights
 * are transported by horizontal arc distance, not by the cubic parameter.
 */
export function smoothRoadCenterlines(network: RoadNetwork, scope: ReadonlySet<string>, maxDeviation = 1.5): void {
  if (!(maxDeviation > 0 && Number.isFinite(maxDeviation))) throw new RangeError('Invalid smoothing bound');
  const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
  const controls = new Map<NetworkEdge, number[]>(), arcs = new Map<NetworkEdge, number[]>();
  for (const e of network.edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    if (!scope.has(e.id)) continue;
    const ds = [0];
    for (let i = 1; i < e.points.length; i++) ds.push(ds[i - 1] + distance(e.points[i - 1], e.points[i]));
    arcs.set(e, ds);
    // Remove only redundant XY samples inserted by verticalProfile. Retain all
    // actual horizontal controls; the complete old height profile remains below.
    const ids = [0];
    for (let i = 1; i < e.points.length - 1; i++) {
      const a = direction(e.points[ids.at(-1)!], e.points[i]), b = direction(e.points[i], e.points[i + 1]);
      if (Math.abs(a.x * b.z - a.z * b.x) > 1e-6 || a.x * b.x + a.z * b.z < 0) ids.push(i);
    }
    ids.push(e.points.length - 1); controls.set(e, ids);
  }
  const tangents = new Map<NetworkEdge, Direction[]>();
  for (const [e, ids] of controls) tangents.set(e, ids.map((id, i) => {
    const left = i ? direction(e.points[ids[i - 1]], e.points[id]) : undefined;
    const right = i < ids.length - 1 ? direction(e.points[id], e.points[ids[i + 1]]) : undefined;
    return left && right ? bisector(left, right) : (left ?? right)!;
  }));
  for (const [node, ins] of incoming) {
    const outs = outgoing.get(node);
    if (ins.length !== 1 || outs?.length !== 1) continue;
    const a = ins[0], b = outs[0];
    if (!tangents.has(a) || !tangents.has(b) || a.from === b.to || distance(a.points.at(-1)!, b.points[0]) > 1e-7) continue;
    const ta = tangents.get(a)!, tb = tangents.get(b)!;
    if (ta.at(-1)!.x * tb[0].x + ta.at(-1)!.z * tb[0].z < .2) continue;
    ta[ta.length - 1] = tb[0] = bisector(ta.at(-1)!, tb[0]);
  }
  for (const [e, ids] of controls) {
    const old = e.points, ds = arcs.get(e)!, ts = tangents.get(e)!;
    const result: Vec3[] = [{ ...old[0] }];
    for (let k = 1; k < ids.length; k++) {
      const first = ids[k - 1], last = ids[k], a = old[first], b = old[last], chord = direction(a, b), length = distance(a, b);
      const handle = (t: Direction) => Math.min(length / 3, maxDeviation / Math.max(1e-12, Math.abs(t.x * chord.z - t.z * chord.x)));
      const h0 = handle(ts[k - 1]), h1 = handle(ts[k]);
      const c = { x: a.x + ts[k - 1].x * h0, z: a.z + ts[k - 1].z * h0 };
      const d = { x: b.x - ts[k].x * h1, z: b.z - ts[k].z * h1 };
      const curve = (t: number): Vec3 => ({ x: (1 - t) ** 3 * a.x + 3 * (1 - t) ** 2 * t * c.x + 3 * (1 - t) * t * t * d.x + t ** 3 * b.x,
        y: 0, z: (1 - t) ** 3 * a.z + 3 * (1 - t) ** 2 * t * c.z + 3 * (1 - t) * t * t * d.z + t ** 3 * b.z });
      const count = Math.max(8, Math.ceil(length / 2));
      const speed = (t: number) => Math.hypot(3 * ((1 - t) ** 2 * (c.x - a.x) + 2 * (1 - t) * t * (d.x - c.x) + t * t * (b.x - d.x)),
        3 * ((1 - t) ** 2 * (c.z - a.z) + 2 * (1 - t) * t * (d.z - c.z) + t * t * (b.z - d.z)));
      const integral = (lo: number, hi: number) => (hi - lo) / 6 * (speed(lo) + 4 * speed((lo + hi) / 2) + speed(hi));
      const arc = [0];
      for (let j = 1; j <= count; j++) arc.push(arc[j - 1] + integral((j - 1) / count, j / count));
      const total = arc[count], original = ds[last] - ds[first], deficit = total - original;
      // Endpoint derivative exactly one preserves all shared vertical grades.
      const sourceStation = (s: number) => { const t = s / total; return s - deficit * t * t * (3 - 2 * t); };
      const targetStation = (s: number) => {
        let lo = 0, hi = total;
        for (let j = 0; j < 45; j++) { const mid = (lo + hi) / 2; if (sourceStation(mid) < s) lo = mid; else hi = mid; }
        return (lo + hi) / 2;
      };
      const stations = [...arc.slice(1, -1)];
      for (let j = first + 1; j < last; j++) stations.push(targetStation(ds[j] - ds[first]));
      // Tiny endpoint chords expose the analytic common horizontal tangent.
      stations.push(Math.min(1e-5, total / 4), total - Math.min(1e-5, total / 4), total);
      stations.sort((a, b) => a - b);
      let horizontal = 0, vertical = first, previous = 0;
      for (const s of stations) {
        if (s - previous < 1e-9 && s !== total) continue;
        if (s === total) { result.push({ ...b }); break; }
        while (horizontal < count - 1 && arc[horizontal + 1] < s) horizontal++;
        const t = (s - arc[horizontal]) / (arc[horizontal + 1] - arc[horizontal]);
        let parameter = (horizontal + t) / count;
        for (let j = 0; j < 4; j++) parameter -= (integral(horizontal / count, parameter) - (s - arc[horizontal])) / speed(parameter);
        const u = sourceStation(s) + ds[first];
        while (vertical < last - 1 && ds[vertical + 1] < u) vertical++;
        const v = (u - ds[vertical]) / (ds[vertical + 1] - ds[vertical]);
        result.push({ ...curve(parameter),
          y: old[vertical].y + (old[vertical + 1].y - old[vertical].y) * v });
        previous = s;
      }
    }
    e.points = result;
    e.length = result.slice(1).reduce((sum, p, i) => sum + distance(result[i], p), 0);
  }
}
