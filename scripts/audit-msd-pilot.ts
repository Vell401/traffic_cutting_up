import { createMoscowNetwork } from '../src/network/moscow';
import { sampleEdge } from '../src/network/geometry';

// Diagnostic, not a claim of junction acceptance: keep actual branch seams visible.
const network = createMoscowNetwork();
const ways = [1207836341, 1207836340, 809185810, 809185809, 809185806,
  809185811, 809185812, 809185807, 809185783, 809185786];
const profiles = ways.map(way => {
  const edges = network.edges.filter(e => e.id.startsWith(`osm:${way}:1:`));
  let peakGrade = 0, minWidth = Infinity, maxWidth = 0, minY = Infinity, maxY = -Infinity;
  for (const e of edges) {
    for (let i = 0, steps = Math.max(1, Math.ceil(e.length)); i <= steps; i++) {
      const s = e.length * i / steps;
      const p = sampleEdge(e, s);
      peakGrade = Math.max(peakGrade, Math.abs(p.grade));
      minWidth = Math.min(minWidth, 2 * p.halfWidth);
      maxWidth = Math.max(maxWidth, 2 * p.halfWidth);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return { way, edges: edges.length, peakGrade, minWidth, maxWidth, minY, maxY };
});
const through = [
  ['osm:1207836340:1:2', 'osm:809185810:1:0'],
  ['osm:809185806:1:0', 'osm:809185806:1:1'],
];
const seams = through.map(([aId, bId]) => {
  const a = network.edges.find(e => e.id === aId)!;
  const b = network.edges.find(e => e.id === bId)!;
  const gap = (side: number) => {
    const pa = sampleEdge(a, a.length, side * sampleEdge(a, a.length).halfWidth);
    const pb = sampleEdge(b, 0, side * sampleEdge(b, 0).halfWidth);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  };
  return { aId, bId, leftGap: gap(-1), rightGap: gap(1),
    gradeJump: Math.abs(sampleEdge(a, a.length).grade - sampleEdge(b, 0).grade) };
});
console.log(JSON.stringify({ scope: 'First MSD pilot and explicit local context', profiles, seams,
  limits: 'Diagnostics only; not surface union, full crossing clearance or driving acceptance.' }, null, 2));
