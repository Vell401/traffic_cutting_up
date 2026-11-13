import { mkdirSync, writeFileSync } from 'node:fs';
import source from '../data/moscow/network.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { roadSampleDistances, sampleEdge, type Vec3 } from '../src/network/geometry';

// Inspect the actual road/deck triangles after runtime profile smoothing.
// This is deliberately separate from the OSM generator's conservative envelopes.
type P = { x: number; z: number };
type Triangle = { points: Vec3[]; id: number; edgeId: string; wayId: number; layer: number;
  from: string; to: string; kind: string; minY: number; maxY: number };
const cross = (a: P, b: P, c: P) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function intersection(a: P[], b: P[]): P[] {
  let polygon = a;
  const sign = cross(b[0], b[1], b[2]) >= 0 ? 1 : -1;
  for (let i = 0; i < 3 && polygon.length; i++) {
    const start = b[i], end = b[(i + 1) % 3], result: P[] = [];
    let previous = polygon[polygon.length - 1], dp = sign * cross(start, end, previous);
    for (const current of polygon) {
      const dc = sign * cross(start, end, current);
      if ((dp >= 0) !== (dc >= 0)) {
        const t = dp / (dp - dc);
        result.push({ x: previous.x + (current.x - previous.x) * t, z: previous.z + (current.z - previous.z) * t });
      }
      if (dc >= 0) result.push(current);
      previous = current; dp = dc;
    }
    polygon = result;
  }
  return polygon;
}
function height(t: Triangle, p: P): number {
  const [a, b, c] = t.points, denominator = cross(a, b, c);
  return (a.y * cross(p, b, c) + b.y * cross(a, p, c) + c.y * cross(a, b, p)) / denominator;
}
const tags = new Map(source.ways.map(w => [w.id, w.tags as Record<string, string | undefined>]));
const level = (id: number) => {
  const t = tags.get(id)!;
  return t.layer !== undefined ? Number(t.layer) : t.bridge === 'yes' ? 1 : t.tunnel === 'yes' ? -1 : 0;
};
const network = createMoscowNetwork();
const bins = new Map<string, Triangle[]>();
let triangleCount = 0, overlaps = 0, connectedOverlaps = 0, minimum = Infinity;
const issues = new Map<string, { ways: number[]; edges: string[]; clearance: number; absoluteClearance: number; x: number; z: number; connected: boolean }>();
for (const edge of network.edges) {
  const wayId = Number(edge.id.split(':')[1]), layer = level(wayId);
  const stations = edge.surfaceFrames ? roadSampleDistances(edge) : Array.from({ length: Math.ceil(edge.length / 5) + 1 }, (_, i) => Math.min(edge.length, i * 5));
  for (let i = 0; i < stations.length - 1; i++) {
    const s = stations[i], end = stations[i + 1];
    const a = sampleEdge(edge, s), b = sampleEdge(edge, end);
    const width = edge.kind === 'bridge' ? 1.02 : 1;
    const points = [sampleEdge(edge, s, -a.halfWidth * width), sampleEdge(edge, end, -b.halfWidth * width),
      sampleEdge(edge, end, b.halfWidth * width), sampleEdge(edge, s, a.halfWidth * width)];
    for (const indices of [[0, 1, 2], [0, 2, 3]]) {
      const p = indices.map(i => points[i]);
      if (Math.abs(cross(p[0], p[1], p[2])) < 1e-8) continue;
      const triangle: Triangle = { points: p, id: triangleCount++, edgeId: edge.id, wayId, layer,
        from: edge.from, to: edge.to, kind: edge.kind,
        minY: Math.min(...p.map(v => v.y)), maxY: Math.max(...p.map(v => v.y)) };
      const visited = new Set<number>();
      const binKeys: string[] = [];
      for (let x = Math.floor(Math.min(...p.map(v => v.x)) / 32); x <= Math.floor(Math.max(...p.map(v => v.x)) / 32); x++) {
        for (let z = Math.floor(Math.min(...p.map(v => v.z)) / 32); z <= Math.floor(Math.max(...p.map(v => v.z)) / 32); z++) {
          const key = `${x}:${z}`, list = bins.get(key) ?? [];
          binKeys.push(key);
          for (const other of list) {
            if (visited.has(other.id)) continue;
            visited.add(other.id);
            if (other.wayId === wayId || other.layer === layer) continue;
            const overlap = intersection(p, other.points);
            if (overlap.length < 3) continue;
            let area = 0;
            for (let i = 1; i < overlap.length - 1; i++) area += Math.abs(cross(overlap[0], overlap[i], overlap[i + 1]));
            if (area < .01) continue;
            const connected = [other.from, other.to].some(n => n === edge.from || n === edge.to);
            if (connected) connectedOverlaps++; else overlaps++;
            const upper = layer > other.layer ? triangle : other, lower = layer > other.layer ? other : triangle;
            // Surface separation includes the emitted bridge underside (-0.4m).
            const differences = overlap.map(q => height(upper, q) - height(lower, q));
            const minDifference = Math.min(...differences), maxDifference = Math.max(...differences);
            const separation = minDifference - (upper.kind === 'bridge' ? .4 : 0);
            const absoluteClearance = minDifference <= 0 && maxDifference >= 0 ? 0
              : Math.min(Math.abs(minDifference), Math.abs(maxDifference)) - .4;
            if (!connected) minimum = Math.min(minimum, separation);
            if (separation < 6) {
              const pair = [wayId, other.wayId].sort((a, b) => a - b).join(':') + `:${connected}`;
              if (absoluteClearance < (issues.get(pair)?.absoluteClearance ?? Infinity)) issues.set(pair, {
                ways: [upper.wayId, lower.wayId], edges: [upper.edgeId, lower.edgeId], clearance: separation, absoluteClearance,
                x: overlap[0].x, z: overlap[0].z, connected,
              });
            }
          }
        }
      }
      // Publish only after all bins have been queried; otherwise a triangle can
      // intersect itself through a second occupied bin and inflate the audit.
      for (const key of binKeys) {
        const list = bins.get(key) ?? [];
        list.push(triangle); bins.set(key, list);
      }
    }
  }
}
const defects = [...issues.values()].sort((a, b) => a.clearance - b.clearance);
const report = { triangles: triangleCount, distinctLevelTriangleOverlaps: overlaps, connectedOverlaps,
  minimumClearance: Number.isFinite(minimum) ? minimum : null,
  suspectWayPairs: defects.filter(d => !d.connected).length,
  insufficientAbsoluteClearancePairs: defects.filter(d => !d.connected && d.absoluteClearance < 6).length,
  connectedSuspectWayPairs: defects.filter(d => d.connected).length,
  issues: defects,
  limits: 'Road/deck XY triangles only; tagged layer order, not surveyed height. Connected overlaps listed separately, not automatically defects. Same-layer conflicts, tunnel shells, piers, barriers and legality require separate checks.' };
mkdirSync('data/moscow', { recursive: true });
writeFileSync('data/moscow/runtime-ribbon-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, issues: defects.slice(0, 12) }, null, 2));
