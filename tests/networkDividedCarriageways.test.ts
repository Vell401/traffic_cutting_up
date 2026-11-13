import { describe, expect, it } from 'vitest';
import { correctDividedCarriagewayEnvelopes } from '../src/network/dividedCarriageways';
import { type NetworkEdge, type RoadNetwork } from '../src/network/geometry';
import { createMoscowNetwork } from '../src/network/moscow';

const pair = (separation = 12.875): RoadNetwork => {
  const a: NetworkEdge = { id: 'osm:809185810:1:0', from: 'a', to: 'b', route: 'Юго-Восточная хорда',
    lanes: 3, kind: 'road', length: 100, points: [{ x: 0, y: .2, z: 0 }, { x: 0, y: .2, z: -100 }] };
  const b: NetworkEdge = { ...a, id: 'osm:809185811:1:0', from: 'c', to: 'd',
    points: [{ x: -separation, y: .2, z: -100 }, { x: -separation, y: .2, z: 0 }] };
  return { id: 'moscow-osm-test', nodes: [], edges: [a, b], parkings: [] };
};
describe('inferred divided carriageway envelope correction', () => {
  it('applies to the default manually edited network before preparing frames', () => {
    const n = createMoscowNetwork();
    const e = n.edges.find(e => e.id === 'osm:809185810:1:0')!;
    expect(e.width).toBeGreaterThanOrEqual(11.3);
    expect(e.width).toBeLessThan(12);
    expect(e.surfaceFrames?.length).toBe(e.points.length);
    expect(e.lanes).toBe(3);
  });
  it('reserves a median gap without changing points or three full-width lanes', () => {
    const n = pair(), points = JSON.stringify(n.edges.map(e => e.points));
    const report = correctDividedCarriagewayEnvelopes(n);
    expect(report.adjustedEdges).toBe(2);
    expect(report.adjustedMeters).toBe(200);
    expect(12.875 - n.edges[0].width! / 2 - n.edges[1].width! / 2).toBeCloseTo(.8);
    for (const e of n.edges) { expect(e.lanes).toBe(3); expect(e.width! / 2).toBeGreaterThanOrEqual(5.65); }
    expect(JSON.stringify(n.edges.map(e => e.points))).toBe(points);
  });
  it('is deterministic and idempotent', () => {
    const a = pair(), b = pair(); b.edges.reverse();
    correctDividedCarriagewayEnvelopes(a); correctDividedCarriagewayEnvelopes(b);
    expect(a.edges[0].width).toBe(b.edges[1].width);
    expect(correctDividedCarriagewayEnvelopes(a).adjustedEdges).toBe(0);
  });
  it('preserves dense profile samples without reusing corrections for changed geometry', () => {
    const dense = pair(), sparse = pair();
    for (const edge of dense.edges) {
      const [a, b] = edge.points;
      edge.points = Array.from({ length: 5001 }, (_, i) => ({
        x: a.x + (b.x - a.x) * i / 5000, y: a.y, z: a.z + (b.z - a.z) * i / 5000,
      }));
    }
    const expected = correctDividedCarriagewayEnvelopes(sparse);
    const actual = correctDividedCarriagewayEnvelopes(dense);
    expect(actual).toEqual(expected);
    expect(dense.edges.map(e => e.width)).toEqual(sparse.edges.map(e => e.width));
    // Same IDs and name, but a custom deck must still be checked independently.
    const changed = pair(); changed.edges[1].points.forEach(p => { p.y += 1; });
    expect(correctDividedCarriagewayEnvelopes(changed).adjustedEdges).toBe(0);
  });
  it('leaves separate decks, uncorroborated routes, ramps and explicit widths alone', () => {
    for (const mode of ['deck', 'ramp', 'width', 'unknown']) {
      const n = pair();
      if (mode === 'deck') n.edges[1].points.forEach(p => { p.y += 8; });
      if (mode === 'ramp') n.edges[1].id = 'osm:999999999999:1:0';
      if (mode === 'width') n.edges[1].width = 13.8;
      if (mode === 'unknown') n.id = 'test';
      expect(correctDividedCarriagewayEnvelopes(n).adjustedEdges).toBe(0);
    }
  });
  it('never narrows below lane/shoulder minimum, or outside the specified spacing range', () => {
    for (const separation of [11.9, 14]) expect(correctDividedCarriagewayEnvelopes(pair(separation)).adjustedEdges).toBe(0);
    const n = pair(); n.edges.forEach(e => { e.lanes = 4; });
    const report = correctDividedCarriagewayEnvelopes(n);
    expect(report.adjustedEdges).toBe(0); expect(report.incompatibleSamples).toBeGreaterThan(0);
  });
  it('requires correction before road frames are prepared', () => {
    const n = pair(); n.edges[0].surfaceFrames = [];
    expect(() => correctDividedCarriagewayEnvelopes(n)).toThrow(/before preparing/);
  });
});
