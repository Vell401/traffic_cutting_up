import type { NetworkEdge, RoadNetwork } from './geometry';

/** Section 01 only. Engineering alignment, NOT surveyed elevations. No width edits. */
export const MSD_PILOT_WAY_IDS = [1207836341, 809185810, 809185809, 809185806,
  809185811, 809185812, 809185807, 809185783, 809185786, 809185782] as const;
const wayId = (e: NetworkEdge) => Number(e.id.split(':')[1]);
const selected = (e: NetworkEdge) => {
  const id = wayId(e), part = Number(e.id.split(':')[3]);
  return (MSD_PILOT_WAY_IDS as readonly number[]).includes(id)
    && !(id === 809185806 && part > 3) && !(id === 809185811 && part > 3);
};

/** Explicit context is included; the northbound route stops at node 7566321589.
 * Through pairs include genuine branches; renderers must not infer a filled gore.
 */
export function msdPilotScope(network: RoadNetwork): { edgeIds: Set<string>; throughPairs: Array<[string, string]> } {
  const edges = network.edges.filter(selected), edgeIds = new Set(edges.map(e => e.id));
  const chains = [[809185810, 809185809, 809185806], [809185807, 809185812, 809185811]];
  const throughPairs: Array<[string, string]> = [];
  for (const chain of chains) {
    const main = edges.filter(e => chain.includes(wayId(e)));
    for (const a of main) for (const b of main) if (a.to === b.from) throughPairs.push([a.id, b.id]);
  }
  const incoming = network.edges.find(e => e.id === 'osm:1207836340:1:2');
  const outgoing = edges.find(e => e.id === 'osm:809185810:1:0');
  if (incoming && outgoing) throughPairs.push([incoming.id, outgoing.id]);
  return { edgeIds, throughPairs };
}

const smooth = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
/** Both parallel decks use the same local alignment, rather than interpreting
 * overlapping shoulder envelopes as evidence of two different bridge levels.
 * 8.2m leaves 7.6m under a 0.4m deck above the 0.2m loop at the bridge crossing.
 * Flat tails preserve the untouched section boundaries exactly.
 */
export function msdPilotMainlineHeight(z: number): number {
  const north = -z;
  return .2 + 8 * smooth((north - 950) / 330) * (1 - smooth((north - 1450) / (1833.7737 - 1450)));
}

/** Construction-time only: before width/frame/sample caches. Keeps XY/topology.
 * All changed endpoint representations, including graph nodes, must agree.
 */
export function applyMsdPilotVerticalAlignment(network: RoadNetwork): void {
  const edges = network.edges.filter(selected), nodeHeights = new Map<string, number>();
  // Add samples on existing XY chords (no horizontal displacement). The old
  // flat profile may have only 5m samples; that is insufficient on a new curve.
  for (const e of edges) {
    if ([1207836341, 809185783].includes(wayId(e))) continue;
    if (wayId(e) === 809185811 && Number(e.id.split(':')[3]) === 3) continue;
    const points = [e.points[0]];
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i], length = Math.hypot(b.x - a.x, b.z - a.z);
      const fractions = [Math.min(.25, 1e-6 / length), ...Array.from({ length: Math.ceil(length / .5) - 1 }, (_, j) => (j + 1) / Math.ceil(length / .5)), 1 - Math.min(.25, 1e-6 / length), 1];
      for (const t of fractions) points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
    e.points = points;
  }
  const mainWays = new Set([809185810, 809185809, 809185806, 809185811, 809185812, 809185807]);
  const set = (e: NetworkEdge, height: (s: number, z: number) => number) => {
    let s = 0;
    for (let i = 0; i < e.points.length; i++) {
      if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      e.points[i].y = height(s, e.points[i].z);
    }
    nodeHeights.set(e.from, e.points[0].y); nodeHeights.set(e.to, e.points.at(-1)!.y);
  };
  for (const e of edges) if (mainWays.has(wayId(e))) set(e, (_, z) => msdPilotMainlineHeight(z));
  for (const e of edges) if (wayId(e) === 809185783) set(e, () => .2);
  // These are connected ramps, not independent decks. Interpolate along the
  // complete way, not separately at each artificial runtime edge boundary.
  for (const id of [809185786, 809185782]) {
    const chain = edges.filter(e => wayId(e) === id);
    const first = chain[0], last = chain.at(-1)!;
    const a = nodeHeights.get(first.from) ?? first.points[0].y;
    const b = nodeHeights.get(last.to) ?? last.points.at(-1)!.y;
    const length = chain.reduce((sum, e) => sum + e.length, 0);
    let offset = 0;
    // Follow the through-road grade at the attachment; zero at the lower handoff.
    const z = id === 809185786 ? first.points[0].z : last.points.at(-1)!.z;
    const derivative = (msdPilotMainlineHeight(z + .01) - msdPilotMainlineHeight(z - .01)) / .02;
    const attachment = id === 809185786 ? first : last;
    const p = id === 809185786 ? attachment.points[0] : attachment.points.at(-2)!;
    const q = id === 809185786 ? attachment.points[1] : attachment.points.at(-1)!;
    const grade = derivative * (q.z - p.z) / Math.hypot(q.x - p.x, q.z - p.z);
    const g0 = id === 809185786 ? grade : 0, g1 = id === 809185782 ? grade : 0;
    for (const e of chain) {
      set(e, s => { const t = (offset + s) / length;
        return a + (b - a) * smooth(t) + length * (g0 * t * (1 - t) ** 2 - g1 * t * t * (1 - t)); });
      offset += e.length;
    }
  }
  // Share the physical grade at graph attachments as well as their heights.
  // Compact endpoint corrections die out within 5m; outside roads are immutable.
  const scopeEdges = new Set(edges), grades = new Map<string, number[]>(), fixed = new Map<string, number>();
  const chordGrade = (e: NetworkEdge, end: boolean) => {
    const a = end ? e.points.at(-2)! : e.points[0], b = end ? e.points.at(-1)! : e.points[1];
    return (b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z);
  };
  for (const e of network.edges) for (const end of [false, true]) {
    const node = end ? e.to : e.from, grade = chordGrade(e, end);
    if (!scopeEdges.has(e)) fixed.set(node, grade);
    else grades.set(node, [...(grades.get(node) ?? []), grade]);
  }
  for (const e of edges) {
    const g = (node: string) => fixed.get(node) ?? grades.get(node)!.reduce((a, b) => a + b, 0) / grades.get(node)!.length;
    const d0 = g(e.from) - chordGrade(e, false), d1 = g(e.to) - chordGrade(e, true), reach = Math.min(5, e.length / 3);
    let s = 0;
    for (let i = 0; i < e.points.length; i++) {
      if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      const u = Math.max(0, 1 - s / reach), v = Math.max(0, 1 - (e.length - s) / reach);
      e.points[i].y += d0 * s * u * u - d1 * (e.length - s) * v * v;
    }
  }
  // Refuse accidental scope expansion rather than moving an outside road endpoint.
  const scope = new Set(edges);
  for (const e of network.edges) if (!scope.has(e)) for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)!]] as const) {
    if (nodeHeights.has(id) && Math.abs(nodeHeights.get(id)! - p.y) > 1e-7) throw new Error(`MSD pilot outside handoff changed: ${e.id} ${id}`);
  }
  for (const node of network.nodes) if (nodeHeights.has(node.id)) node.position.y = nodeHeights.get(node.id)!;
}
