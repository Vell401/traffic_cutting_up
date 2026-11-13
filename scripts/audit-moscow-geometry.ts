import { mkdirSync, writeFileSync } from 'node:fs';
import { createMoscowNetwork } from '../src/network/moscow';
import { sampleEdge, validateNetwork, type NetworkEdge } from '../src/network/geometry';

// Reproducible inspection of the actual runtime geometry (not just source OSM).
const network = createMoscowNetwork();
const exits = new Map<string, NetworkEdge[]>();
for (const edge of network.edges) {
  const list = exits.get(edge.from) ?? [];
  list.push(edge); exits.set(edge.from, list);
}
const seamIssues: Array<{ from: string; to: string; gap: number; turnDegrees: number; gradeChange: number }> = [];
let maxGrade = 0, maxGradeStep = 0, maxInteriorTurn = 0;
let ordinarySeams = 0;
let maxOrdinarySeamGradeChange = 0, maxAnySeamGradeChange = 0;
for (const edge of network.edges) {
  let previousGrade: number | undefined;
  let previousHeading: number | undefined;
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1], b = edge.points[i];
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    const grade = (b.y - a.y) / ds, heading = Math.atan2(b.x - a.x, a.z - b.z);
    maxGrade = Math.max(maxGrade, Math.abs(grade));
    if (previousGrade !== undefined) maxGradeStep = Math.max(maxGradeStep, Math.abs(grade - previousGrade));
    if (previousHeading !== undefined) maxInteriorTurn = Math.max(maxInteriorTurn,
      Math.abs(Math.atan2(Math.sin(heading - previousHeading), Math.cos(heading - previousHeading))));
    previousGrade = grade; previousHeading = heading;
  }
  const outgoing = exits.get(edge.to) ?? [];
  for (const next of outgoing) maxAnySeamGradeChange = Math.max(maxAnySeamGradeChange,
    Math.abs(sampleEdge(edge, edge.length).grade - sampleEdge(next, 0).grade));
  if (outgoing.length !== 1) continue; // real branch angles are not ordinary seam defects
  const next = outgoing[0], a = sampleEdge(edge, edge.length), b = sampleEdge(next, 0);
  const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const turnDegrees = Math.abs(Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading))) * 180 / Math.PI;
  const gradeChange = Math.abs(a.grade - b.grade);
  maxOrdinarySeamGradeChange = Math.max(maxOrdinarySeamGradeChange, gradeChange);
  ordinarySeams++;
  if (gap > .01 || turnDegrees > 5 || gradeChange > .03) seamIssues.push({ from: edge.id, to: next.id, gap, turnDegrees, gradeChange });
}
const report = {
  networkId: network.id, edgeCount: network.edges.length, nodeCount: network.nodes.length,
  validationErrors: validateNetwork(network),
  boundaryEnds: network.edges.filter(e => !exits.has(e.to)).map(e => e.id),
  ordinarySeams, seamIssues: seamIssues.sort((a, b) => b.turnDegrees - a.turnDegrees),
  maxGrade, maxGradeStep, maxOrdinarySeamGradeChange, maxAnySeamGradeChange,
  maxInteriorTurnDegrees: maxInteriorTurn * 180 / Math.PI,
  limits: 'Reports geometry, not driving acceptance. Branches excluded from ordinary-seam checks; no full mesh/structure collision proof.',
};
mkdirSync('data/moscow', { recursive: true });
writeFileSync('data/moscow/runtime-audit.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, boundaryEnds: report.boundaryEnds.length, seamIssues: report.seamIssues.slice(0, 8) }, null, 2));
if (report.validationErrors.length) process.exitCode = 1;
