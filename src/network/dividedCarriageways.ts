import source from '../../data/moscow/network.json';
import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';

const tags = new Map(source.ways.map(w => [String(w.id), w.tags as Record<string, string | undefined>]));
const named = (edge: NetworkEdge) => {
  const t = tags.get(/^osm:(\d+):/.exec(edge.id)?.[1] ?? '');
  return t && ['primary', 'trunk', 'motorway'].includes(t.highway ?? '') && t.oneway === 'yes'
    && /(?:Юго-Восточная|Северо-Восточная) хорда|Московский скоростной диаметр/.test(t.name ?? '') ? t.name : undefined;
};
export interface DividedEnvelopeReport {
  adjustedEdges: number; adjustedMeters: number; incompatibleSamples: number;
  minimumSeparation: number | null; maximumWidthReduction: number;
}
type Segment = { a: Vec3; b: Vec3; dx: number; dz: number; len: number };
type SegmentTree = { minX: number; maxX: number; minZ: number; maxZ: number;
  left?: SegmentTree; right?: SegmentTree; segments?: Segment[] };
type IndexedEdge = { edge: NetworkEdge; name: string; tree: SegmentTree };

// Keep every profile segment, but prune distant subtrees instead of scanning
// thousands of sub-metre segments in the same broad-phase cell for each sample.
function segmentTree(segments: Segment[], start = 0, end = segments.length): SegmentTree {
  if (end - start > 8) {
    const mid = (start + end) >>> 1;
    const left = segmentTree(segments, start, mid), right = segmentTree(segments, mid, end);
    return { minX: Math.min(left.minX, right.minX), maxX: Math.max(left.maxX, right.maxX),
      minZ: Math.min(left.minZ, right.minZ), maxZ: Math.max(left.maxZ, right.maxZ), left, right };
  }
  const leaf = segments.slice(start, end);
  // Exact projection accepts t in [-1e-6, 1 + 1e-6], so bounds must
  // include that endpoint tolerance too, even for unusually long segments.
  return { minX: Math.min(...leaf.map(s => Math.min(s.a.x, s.b.x) - Math.abs(s.dx) * 1e-6)),
    maxX: Math.max(...leaf.map(s => Math.max(s.a.x, s.b.x) + Math.abs(s.dx) * 1e-6)),
    minZ: Math.min(...leaf.map(s => Math.min(s.a.z, s.b.z) - Math.abs(s.dz) * 1e-6)),
    maxZ: Math.max(...leaf.map(s => Math.max(s.a.z, s.b.z) + Math.abs(s.dz) * 1e-6)), segments: leaf };
}
function squaredDistance(tree: SegmentTree, x: number, z: number): number {
  const dx = Math.max(tree.minX - x, 0, x - tree.maxX), dz = Math.max(tree.minZ - z, 0, z - tree.maxZ);
  return dx * dx + dz * dz;
}

/** Before prepareRoadFrames ONLY. Mutates width, never coordinates or lane counts.
 * OSM centerline spacing constrains inferred symmetric shoulders: reserve >=0.8 m
 * between paired ribbons, preserving 3.6 m lanes and >=0.25 m shoulders per side.
 * This also narrows the outer shoulder until asymmetric borders are supported;
 * it is a rendering inference, not surveyed road or median dimensions.
 * Explicit widths, ramps, different names/decks and separations outside 12..13.8 m
 * are untouched. Unsafe constraints are reported, never forced.
 */
export function correctDividedCarriagewayEnvelopes(network: RoadNetwork): DividedEnvelopeReport {
  const report: DividedEnvelopeReport = { adjustedEdges: 0, adjustedMeters: 0, incompatibleSamples: 0,
    minimumSeparation: null, maximumWidthReduction: 0 };
  if (!network.id.startsWith('moscow-osm')) return report;
  const candidates = network.edges.filter(e => named(e) && e.kind !== 'tunnel');
  if (candidates.some(e => e.surfaceFrames)) throw new Error('Correct divided envelopes before preparing road frames');
  const cells = new Map<string, IndexedEdge[]>(), cell = 32;
  for (const edge of candidates) {
    if (edge.points.length < 2) continue;
    const segments = edge.points.slice(1).map((b, i) => {
      const a = edge.points[i], dx = b.x - a.x, dz = b.z - a.z;
      return { a, b, dx, dz, len: Math.hypot(dx, dz) };
    });
    const tree = segmentTree(segments), indexed = { edge, name: named(edge)!, tree };
    for (let x = Math.floor(tree.minX / cell); x <= Math.floor(tree.maxX / cell); x++)
      for (let z = Math.floor(tree.minZ / cell); z <= Math.floor(tree.maxZ / cell); z++) {
        const key = `${x}:${z}`, list = cells.get(key) ?? []; list.push(indexed); cells.set(key, list);
      }
  }
  const limits = new Map<NetworkEdge, number>();
  const originalHalf = (e: NetworkEdge) => e.width === undefined ? Math.max(e.lanes, e.endLanes ?? e.lanes) * 1.8 + 1.5 : e.width / 2;
  for (const edge of candidates) {
    if (edge.width !== undefined) continue;
    const name = named(edge);
    for (const s of roadSampleDistances(edge, 5)) {
      const p = sampleEdge(edge, s);
      const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
      let nearest: { edge: NetworkEdge; separation: number } | undefined;
      const visit = (tree: SegmentTree, other: NetworkEdge): void => {
        // A tiny broad-phase margin keeps floating-point boundary cases in the
        // exact checks below (including the inclusive 13.8 m cutoff).
        const radius = (nearest?.separation ?? 13.8) + 1e-9;
        if (squaredDistance(tree, p.x, p.z) > radius * radius) return;
        if (tree.left && tree.right) {
          const first = squaredDistance(tree.left, p.x, p.z) <= squaredDistance(tree.right, p.x, p.z);
          visit(first ? tree.left : tree.right, other);
          visit(first ? tree.right : tree.left, other);
          return;
        }
        for (const { a, b, dx, dz, len } of tree.segments!) {
          if (!len || (dx * sin - dz * cos) / len > -.98) continue;
          const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len);
          // Don't interpret longitudinally separated endpoints as opposite ribbons.
          if (t < -1e-6 || t > 1 + 1e-6) continue;
          const qx = a.x + t * dx, qz = a.z + t * dz;
          if (Math.abs(a.y + t * (b.y - a.y) - p.y) > .75) continue;
          if ((qx - p.x) * cos + (qz - p.z) * sin >= 0) continue;
          const separation = Math.hypot(qx - p.x, qz - p.z);
          if (separation >= 12 && separation <= 13.8 && (!nearest || separation < nearest.separation)) nearest = { edge: other, separation };
        }
      };
      const seen = new Set<IndexedEdge>();
      for (let x = Math.floor((p.x - 14) / cell); x <= Math.floor((p.x + 14) / cell); x++)
        for (let z = Math.floor((p.z - 14) / cell); z <= Math.floor((p.z + 14) / cell); z++)
          for (const indexed of cells.get(`${x}:${z}`) ?? []) {
            if (seen.has(indexed)) continue; seen.add(indexed);
            if (indexed.edge === edge || indexed.name !== name) continue;
            visit(indexed.tree, indexed.edge);
          }
      if (!nearest || nearest.edge.width !== undefined) continue;
      const other = nearest.edge, separation = nearest.separation;
      if (originalHalf(edge) + originalHalf(other) <= separation) continue;
      const limit = (separation - .8) / 2;
      const minimum = (e: NetworkEdge) => Math.max(e.lanes, e.endLanes ?? e.lanes) * 1.8 + .25;
      if (limit < minimum(edge) || limit < minimum(other)) { report.incompatibleSamples++; continue; }
      report.minimumSeparation = Math.min(report.minimumSeparation ?? Infinity, separation);
      for (const e of [edge, other]) limits.set(e, Math.min(limits.get(e) ?? originalHalf(e), limit));
    }
  }
  for (const [edge, limit] of limits) {
    const reduction = originalHalf(edge) * 2 - limit * 2;
    if (reduction <= 0) continue;
    edge.width = limit * 2;
    report.adjustedEdges++; report.adjustedMeters += edge.length;
    report.maximumWidthReduction = Math.max(report.maximumWidthReduction, reduction);
  }
  return report;
}
