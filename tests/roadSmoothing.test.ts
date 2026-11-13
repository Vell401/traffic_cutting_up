import { describe, expect, it } from 'vitest';
import { smoothRoadCenterlines } from '../src/network/roadSmoothing';
import { createMoscowNetwork } from '../src/network/moscow';
import { msdCorridor } from '../src/network/msdCorridor';
import { validateNetwork, type NetworkEdge, type RoadNetwork, type Vec3 } from '../src/network/geometry';

const direction = (a: Vec3, b: Vec3) => Math.atan2(b.z - a.z, b.x - a.x);
const angle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
function turns(n: RoadNetwork, scope: ReadonlySet<string>) {
  let squared = 0, peak = 0, seams = 0;
  const ins = new Map<string, NetworkEdge[]>(), outs = new Map<string, NetworkEdge[]>();
  for (const e of n.edges) {
    ins.set(e.to, [...(ins.get(e.to) ?? []), e]); outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
    if (!scope.has(e.id)) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      const turn = angle(direction(e.points[i - 1], e.points[i]), direction(e.points[i], e.points[i + 1]));
      squared += turn * turn; peak = Math.max(peak, turn);
    }
  }
  let seamPeak = 0;
  for (const [node, incoming] of ins) {
    const outgoing = outs.get(node);
    if (incoming.length !== 1 || outgoing?.length !== 1) continue;
    const a = incoming[0], b = outgoing[0];
    if (!scope.has(a.id) || !scope.has(b.id)) continue;
    const turn = angle(direction(a.points.at(-2)!, a.points.at(-1)!), direction(b.points[0], b.points[1]));
    if (turn > Math.acos(.2)) continue;
    seamPeak = Math.max(seamPeak, turn); squared += turn * turn; seams++;
  }
  return { squared, peak, seamPeak, seams };
}
const edge = (id: string, from: string, to: string, points: number[][]): NetworkEdge => ({
  id, from, to, points: points.map(([x, y, z]) => ({ x, y, z })), lanes: 2, route: 'test', kind: 'road', length: 100,
});

describe('bounded physical road centerline smoothing', () => {
  it('rounds rising chains across ordinary seams without moving branch nodes or unrelated parallel roads', () => {
    const a = edge('a', '1', '2', [[-100, 0, 0], [0, 4, 0]]);
    const b = edge('b', '2', '3', [[0, 4, 0], [100, 8, -50]]);
    const c = edge('c', '3', '4', [[100, 8, -50], [150, 8, -50], [200, 8, -100]]);
    const d = edge('branch', '3', '5', [[100, 8, -50], [100, 8, 50]]);
    const parallel = edge('parallel', '6', '7', [[-100, 0, 10], [0, 4, 10], [100, 8, -40]]);
    const n: RoadNetwork = { id: 'fixture', edges: [a, b, c, d, parallel], nodes: [], parkings: [] };
    const untouched = JSON.stringify([d, parallel]);
    smoothRoadCenterlines(n, new Set(['a', 'b', 'c']));
    expect(JSON.stringify([d, parallel])).toBe(untouched);
    expect(a.points.at(-1)).toEqual(b.points[0]);
    expect(b.points.at(-1)).toEqual({ x: 100, y: 8, z: -50 });
    expect(angle(direction(a.points.at(-2)!, a.points.at(-1)!), direction(b.points[0], b.points[1]))).toBeLessThan(1e-5);
    expect(a.points.some(p => Math.abs(p.z) > .1)).toBe(true);
    for (const e of [a, b, c]) {
      const start = e.points[0], end = e.points.at(-1)!;
      for (const p of e.points) expect(p.y).toBeGreaterThanOrEqual(start.y - 1e-9);
      for (const p of e.points) expect(p.y).toBeLessThanOrEqual(end.y + 1e-9);
      for (let i = 1; i < e.points.length; i++) expect(e.points[i].x).toBeGreaterThan(e.points[i - 1].x);
    }
    expect(Math.max(...a.points.map(p => Math.abs(p.z)))).toBeLessThanOrEqual(1.5);
  });

  it('reduces actual MSD/ramp chord turning, not just frame normals, with unchanged scope and topology', () => {
    // Compare only XY smoothing: the later engineering vertical alignment uses
    // physical arc distance and is independently validated in msdPilot.test.ts.
    const isolated = { pilotVerticalAlignment: false, pilotWidths: false };
    const before = createMoscowNetwork(undefined, { ...isolated, smoothCenterlines: false });
    const after = createMoscowNetwork(undefined, isolated);
    const scope = msdCorridor(before), oldMetric = turns(before, scope), newMetric = turns(after, scope);
    console.info('MSD physical centerline turn metrics', { before: oldMetric, after: newMetric });
    expect(newMetric.squared).toBeLessThan(oldMetric.squared * .5);
    expect(newMetric.peak).toBeLessThan(oldMetric.peak * .3);
    expect(newMetric.seamPeak).toBeLessThan(.0001);
    expect(newMetric.seams).toBeGreaterThan(700);
    expect([...msdCorridor(after)]).toEqual([...scope]);
    expect(after.nodes).toEqual(before.nodes);
    for (let i = 0; i < before.edges.length; i++) {
      const a = before.edges[i], b = after.edges[i];
      expect([a.id, a.from, a.to, a.lanes, a.kind]).toEqual([b.id, b.from, b.to, b.lanes, b.kind]);
      expect(a.points[0]).toEqual(b.points[0]); expect(a.points.at(-1)).toEqual(b.points.at(-1));
      if (!scope.has(a.id)) expect(b.points).toEqual(a.points);
    }
    expect(validateNetwork(after)).toEqual([]);
  }, 30000);
});
