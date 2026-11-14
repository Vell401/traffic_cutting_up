import type { NetworkEdge, RoadNetwork, Vec3 } from './geometry';
import { msdPilotScope } from './msdPilot';

/**
 * Section 02: route chainage 1942.3–5849.8 m (node 7566321589 → start of way 877932064).
 * Engineering vertical profile, NOT survey. Control points encode only what the
 * referenced Yandex road frames and OSM crossings establish (docs/msd-section-02.md):
 * at grade to ≈2150 m; long bridge over the Paveletsky main line (2556–2634 m);
 * under the Podolskikh Kursantov overpass (≈3390 m) at grade; a grassed cutting
 * (≈3520–3710 m) down to the 50 m tunnel under the railway (4240–4290 m; railway on
 * an embankment over it); bridge over the river (channel carved in terrain) and road
 * 878341533 (≈4416 / 4600 m); viaduct with noise screens
 * (≈5100–5390 m); back at grade before the 5617 m merge.
 */
export const MSD_SECTION02 = { start: 1942.3, end: 5849.8 } as const;
export const MSD_SECTION02_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [1942.3, .2], [2150, .2], [2400, 7], [2480, 8.6], [2700, 8.6], [2900, 7.6], [3044, 5], [3250, .2], [3480, .2],
  [3700, -1.8], [3950, -3.2], [4200, -3.5], [4290, -3], [4416, 1], [4600, 6.6], [4740, 6.8], [4900, 6.2],
  [5150, 8.4], [5390, 8.4], [5650, .2], [5849.8, .2],
];
const ROUTE_WAYS = new Set(['809185806', '1194199517', '809185801', '1194199515', '809185818', '809185798', '942598242',
  '809185797', '942598243', '942598237', '1194203196']);
const MSD_NAME = /Юго-Восточная хорда/;

/** Fritsch–Carlson monotone cubic: no overshoot between control heights. */
function monotone(points: ReadonlyArray<readonly [number, number]>): (c: number) => number {
  const n = points.length, x = points.map(p => p[0]), y = points.map(p => p[1]);
  const d = x.slice(1).map((xi, i) => (y[i + 1] - y[i]) / (xi - x[i]));
  const m = [d[0], ...d.slice(1).map((di, i) => di * d[i] <= 0 ? 0 : (di + d[i]) / 2), d[n - 2]];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  m[0] = m[n - 1] = 0; // flat at both section boundaries (immutable neighbours)
  return c => {
    if (c <= x[0]) return y[0];
    if (c >= x[n - 1]) return y[n - 1];
    let i = 0; while (c > x[i + 1]) i++;
    const h = x[i + 1] - x[i], t = (c - x[i]) / h;
    return (2 * t ** 3 - 3 * t ** 2 + 1) * y[i] + (t ** 3 - 2 * t ** 2 + t) * h * m[i]
      + (-2 * t ** 3 + 3 * t ** 2) * y[i + 1] + (t ** 3 - t ** 2) * h * m[i + 1];
  };
}
export const msdSection02Height = monotone(MSD_SECTION02_PROFILE);

/** Northbound section-02 centreline with chainage, from the published network. */
export function msdSection02Route(network: RoadNetwork): { points: Vec3[]; chainage: number[]; edges: NetworkEdge[] } {
  const edges: NetworkEdge[] = [];
  let edge = network.edges.find(e => e.from === 'osm-node:7566321589' && e.id.split(':')[2] === '1' && ROUTE_WAYS.has(e.id.split(':')[1]));
  let total = MSD_SECTION02.start;
  while (edge && total < MSD_SECTION02.end - 1 && edges.length < 200) {
    edges.push(edge); total += edge.length;
    const from: string = edge.to;
    edge = network.edges.find(e => e.from === from && e.id.split(':')[2] === '1' && ROUTE_WAYS.has(e.id.split(':')[1]));
  }
  const points: Vec3[] = [], chainage: number[] = [];
  let c = MSD_SECTION02.start;
  for (const e of edges) for (let i = points.length ? 1 : 0; i < e.points.length; i++) {
    if (points.length) c += Math.hypot(e.points[i].x - points.at(-1)!.x, e.points[i].z - points.at(-1)!.z);
    points.push(e.points[i]); chainage.push(c);
  }
  return { points, chainage, edges };
}

function projector(route: { points: Vec3[]; chainage: number[] }) {
  const CELL = 50, cells = new Map<string, number[]>();
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    for (let x = Math.floor((Math.min(a.x, b.x) - 60) / CELL); x <= Math.floor((Math.max(a.x, b.x) + 60) / CELL); x++)
      for (let z = Math.floor((Math.min(a.z, b.z) - 60) / CELL); z <= Math.floor((Math.max(a.z, b.z) + 60) / CELL); z++) {
        const key = `${x}:${z}`, list = cells.get(key) ?? []; list.push(i); cells.set(key, list);
      }
  }
  return (p: Vec3) => {
    let best = { d: Infinity, c: 0 };
    for (const i of cells.get(`${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`) ?? []) {
      const a = route.points[i - 1], b = route.points[i], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
      if (d < best.d) best = { d, c: route.chainage[i - 1] + (route.chainage[i] - route.chainage[i - 1]) * t };
    }
    return best;
  };
}

/** Construction-time only (before frames/widths/sample caches). XY and topology unchanged. */
export function applyMsdSection02VerticalAlignment(network: RoadNetwork, names: ReadonlyMap<string, string>): Set<string> {
  const route = msdSection02Route(network);
  const changed = new Set<string>();
  if (!route.edges.length) return changed;
  const project = projector(route), pilot = msdPilotScope(network).edgeIds;
  const way = (e: NetworkEdge) => e.id.split(':')[1];
  // Both MSD carriageways (and their tag-boundary parts) inside the section corridor.
  const main = network.edges.filter(e => !pilot.has(e.id) && MSD_NAME.test(names.get(way(e)) ?? '') && e.points.every(p => project(p).d < 45)
    && (() => { const c = project(e.points[Math.floor(e.points.length / 2)]).c; return c > MSD_SECTION02.start + 1e-6 && c < MSD_SECTION02.end - 1e-6; })());
  const mainSet = new Set(main);
  const densify = (e: NetworkEdge) => {
    const points = [e.points[0]];
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i], length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / .5));
      // Micro-chords at both edge ends make the seam chord grade the exact tangent.
      const fractions = Array.from({ length: steps }, (_, j) => (j + 1) / steps);
      if (i === 1) fractions.unshift(Math.min(.25 / steps, 1e-6 / length));
      if (i === e.points.length - 1) fractions.splice(fractions.length - 1, 0, 1 - Math.min(.25 / steps, 1e-6 / length));
      for (const t of fractions) points.push({ x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t });
    }
    e.points = points;
  };
  const heights = new Map<string, number>();
  for (const e of main) {
    densify(e);
    // Chainage per point: interpolate the end projections by arc length (monotone and
    // smooth; independent nearest-point projection kinks at axis vertices).
    const c0 = project(e.points[0]).c, c1 = project(e.points.at(-1)!).c;
    let s = 0;
    for (let i = 0; i < e.points.length; i++) {
      if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      e.points[i].y = msdSection02Height(c0 + (c1 - c0) * s / e.length);
    }
    heights.set(e.from, e.points[0].y); heights.set(e.to, e.points.at(-1)!.y);
    changed.add(e.id);
  }
  // Branches: every other directed way chain touching a changed node, eased between
  // its (possibly changed) end heights with the mainline grade at an attachment.
  const nodeY = new Map(network.nodes.map(n => [n.id, n.position.y]));
  const touched = (e: NetworkEdge) => !mainSet.has(e) && [e.from, e.to].some(n => heights.has(n)
    && Math.abs(heights.get(n)! - (n === e.from ? e.points[0].y : e.points.at(-1)!.y)) > 1e-7);
  const branchKeys = new Set(network.edges.filter(touched).map(e => e.id.split(':').slice(1, 3).join(':')));
  const mainGrade = (node: string, direction: { x: number; z: number }) => {
    for (const e of main) for (const end of [false, true]) if ((end ? e.to : e.from) === node) {
      const a = end ? e.points.at(-2)! : e.points[0], b = end ? e.points.at(-1)! : e.points[1];
      const l = Math.hypot(b.x - a.x, b.z - a.z), along = ((b.x - a.x) * direction.x + (b.z - a.z) * direction.z) / l;
      return (b.y - a.y) / l * along;
    }
    return 0;
  };
  const chainOf = (key: string) => network.edges.filter(e => e.id.split(':').slice(1, 3).join(':') === key)
    .sort((a, b) => Number(a.id.split(':')[3]) - Number(b.id.split(':')[3]));
  const keyOf = (e: NetworkEdge) => e.id.split(':').slice(1, 3).join(':');
  const handled = new Set<string>();
  for (const key of branchKeys) {
    if (handled.has(key)) continue;
    let chain = chainOf(key); handled.add(key);
    // A >7% ease means the far end height is a layer artefact (e.g. a street bridge
    // tagged layer=1 from its abutment): extend through single continuations instead.
    for (let hop = 0; hop < 4; hop++) {
      const length = chain.reduce((sum, e) => sum + e.length, 0), first = chain[0], last = chain.at(-1)!;
      const hA = heights.get(first.from) ?? nodeY.get(first.from)!, hB = heights.get(last.to) ?? nodeY.get(last.to)!;
      if (Math.abs(hB - hA) / length <= .045) break;
      const forward = heights.has(first.from) && !heights.has(last.to);
      const node = forward ? last.to : first.from;
      const next = network.edges.filter(e => (forward ? e.from === node : e.to === node) && !mainSet.has(e) && !pilot.has(e.id));
      const others = network.edges.filter(e => (e.from === node || e.to === node) && !chain.includes(e));
      if (next.length !== 1 || others.length !== 1) break;
      const extra = chainOf(keyOf(next[0])); handled.add(keyOf(next[0]));
      chain = forward ? [...chain, ...extra] : [...extra, ...chain];
    }
    if (chain.some(e => pilot.has(e.id))) throw new Error(`MSD section 02 would modify pilot edge via ${key}`);
    chain.forEach(densify);
    const first = chain[0], last = chain.at(-1)!, length = chain.reduce((s, e) => s + e.length, 0);
    const hA = heights.get(first.from) ?? nodeY.get(first.from) ?? first.points[0].y;
    const hB = heights.get(last.to) ?? nodeY.get(last.to) ?? last.points.at(-1)!.y;
    const dirA = { x: first.points[1].x - first.points[0].x, z: first.points[1].z - first.points[0].z };
    const dirB = { x: last.points.at(-1)!.x - last.points.at(-2)!.x, z: last.points.at(-1)!.z - last.points.at(-2)!.z };
    const nA = Math.hypot(dirA.x, dirA.z), nB = Math.hypot(dirB.x, dirB.z);
    const gA = mainSet.has(first) ? 0 : heights.has(first.from) ? mainGrade(first.from, { x: dirA.x / nA, z: dirA.z / nA }) : 0;
    const gB = heights.has(last.to) ? mainGrade(last.to, { x: dirB.x / nB, z: dirB.z / nB }) : 0;
    let offset = 0;
    for (const e of chain) {
      let s = 0;
      for (let i = 0; i < e.points.length; i++) {
        if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
        const t = (offset + s) / length;
        e.points[i].y = (2 * t ** 3 - 3 * t ** 2 + 1) * hA + (t ** 3 - 2 * t ** 2 + t) * length * gA
          + (-2 * t ** 3 + 3 * t ** 2) * hB + (t ** 3 - t ** 2) * length * gB;
      }
      heights.set(e.from, e.points[0].y); heights.set(e.to, e.points.at(-1)!.y);
      offset += e.length; changed.add(e.id);
    }
  }
  // Share the physical grade at every node touched (as the section-01 pass does):
  // compact endpoint corrections die out within 5 m; unchanged roads are fixed.
  const changedEdges = network.edges.filter(e => changed.has(e.id));
  const chordGrade = (e: NetworkEdge, end: boolean) => {
    const a = end ? e.points.at(-2)! : e.points[0], b = end ? e.points.at(-1)! : e.points[1];
    return (b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z);
  };
  const shared = new Map<string, number[]>(), fixed = new Map<string, number>();
  for (const e of network.edges) for (const end of [false, true]) {
    const node = end ? e.to : e.from;
    if (!heights.has(node)) continue;
    if (!changed.has(e.id)) fixed.set(node, chordGrade(e, end));
    else shared.set(node, [...(shared.get(node) ?? []), chordGrade(e, end)]);
  }
  const target = (node: string) => fixed.get(node) ?? shared.get(node)!.reduce((a, b) => a + b, 0) / shared.get(node)!.length;
  for (const e of changedEdges) {
    const d0 = target(e.from) - chordGrade(e, false), d1 = target(e.to) - chordGrade(e, true), reach = Math.min(5, e.length / 3);
    let s = 0;
    for (let i = 0; i < e.points.length; i++) {
      if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      const u = Math.max(0, 1 - s / reach), v = Math.max(0, 1 - (e.length - s) / reach);
      e.points[i].y += d0 * s * u * u - d1 * (e.length - s) * v * v;
    }
  }
  // Every edge touching a changed node must now agree; refuse silent scope growth.
  for (const e of network.edges) if (!changed.has(e.id)) for (const [n, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)!]] as const) {
    if (heights.has(n) && Math.abs(heights.get(n)! - p.y) > 1e-6) throw new Error(`MSD section 02 left an inconsistent handoff: ${e.id} ${n}`);
  }
  for (const node of network.nodes) if (heights.has(node.id)) node.position.y = heights.get(node.id)!;
  return changed;
}
