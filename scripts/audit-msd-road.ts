import { writeFileSync } from 'node:fs';
import { createMoscowNetwork } from '../src/network/moscow';
import { sampleEdge, validateNetwork, type NetworkEdge } from '../src/network/geometry';
import { msdCorridor } from '../src/network/msdCorridor';

const network = createMoscowNetwork(), corridor = msdCorridor(network);
const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
for (const edge of network.edges) {
  incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
}
const defects: Array<{ from: string; to: string; left: number; right: number; turn: number }> = [];
let seams = 0, maxLeft = 0, maxRight = 0;
for (const a of network.edges) {
  if (!corridor.has(a.id) || incoming.get(a.to)?.length !== 1 || outgoing.get(a.to)?.length !== 1) continue;
  const b = outgoing.get(a.to)![0];
  if (!corridor.has(b.id)) continue;
  const p = sampleEdge(a, a.length), q = sampleEdge(b, 0);
  if (Math.abs(p.halfWidth - q.halfWidth) > 1e-4) continue;
  const gap = (side: number) => {
    const x = sampleEdge(a, a.length, side * p.halfWidth), y = sampleEdge(b, 0, side * q.halfWidth);
    return Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
  };
  const left = gap(-1), right = gap(1);
  seams++; maxLeft = Math.max(maxLeft, left); maxRight = Math.max(maxRight, right);
  if (Math.max(left, right) > .01) defects.push({ from: a.id, to: b.id, left, right,
    turn: Math.abs(Math.atan2(Math.sin(p.heading - q.heading), Math.cos(p.heading - q.heading))) * 180 / Math.PI });
}
const report = { scope: 'Named MSD both directions, connected ramp chains and route Kantemirovskaya approach; MKAD excluded',
  selectedEdges: corridor.size, directedKm: network.edges.filter(e => corridor.has(e.id)).reduce((sum, e) => sum + e.length, 0) / 1000,
  equalWidthUnbranchedSeams: seams, maxLeftGap: maxLeft, maxRightGap: maxRight,
  defectiveSeams: defects.length, validationErrors: validateNetwork(network), defects,
  limits: 'Cross-section endpoint equality only, not full junction union, all same-layer overlaps, clearance or driving acceptance.' };
writeFileSync('data/moscow/msd-road-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, defects: defects.slice(0, 12) }, null, 2));
