import { describe, expect, it } from 'vitest';
import { type DataTexture } from 'three';
import { sampleEdge, type NetworkEdge, type RoadNetwork } from '../src/network/geometry';
import { createMoscowNetwork } from '../src/network/moscow';
import { msdCorridor } from '../src/network/msdCorridor';
import { asphaltMaterialKey, ASPHALT_DEPTH_BUCKETS, roadChunkVisible } from '../src/network/render';
import { DASH_LENGTH, DASH_PERIOD, EDGE_LINE_WIDTH, LANE_LINE_WIDTH, planRoadMarkings } from '../src/network/roadMarkings';
import { createRoadMaterials } from '../src/network/roadMaterials';

function edge(id: string, from: string, to: string, x: number, z: number, endX: number, endZ: number, lanes = 3): NetworkEdge {
  return { id, from, to, points: [{ x, y: 0, z }, { x: endX, y: 0, z: endZ }], length: Math.hypot(endX - x, endZ - z), lanes, kind: 'road', route: 'test' };
}
function network(edges: NetworkEdge[]): RoadNetwork { return { id: 'test', nodes: [], edges, parkings: [] }; }
function plan(edges: NetworkEdge[]) { return planRoadMarkings(network(edges), new Set(edges.map(e => e.id))); }

describe('metric road marking planner', () => {
  it('terminates when published length exceeds the last sampled arc by rounding noise', () => {
    const road = edge('rounding', 'a', 'b', 0, 0, 0, -30);
    road.length += 1e-12;
    const paint = plan([road]).segments.get(road.id)!;
    expect(paint.length).toBeLessThan(100);
    expect(paint.filter(p => p.kind === 'edge' && p.d0 > 0).at(-1)!.end).toBe(road.length);
  });
  function expectCoverage(paint: ReturnType<typeof plan>['segments'], road: NetworkEdge) {
    for (const side of [-1, 1]) {
      const runs = paint.get(road.id)!.filter(s => s.kind === 'edge' && Math.sign(s.d0) === side);
      expect(runs[0]?.start, `${road.id} side ${side} start`).toBe(0);
      for (let i = 1; i < runs.length; i++) expect(runs[i].start, `${road.id} side ${side} gap`).toBeCloseTo(runs[i - 1].end, 7);
      expect(runs.at(-1)?.end, `${road.id} side ${side} end`).toBeCloseTo(road.length, 7);
    }
  }

  it('keeps every ordinary real corridor segment continuously painted, not only its seams', () => {
    const net = createMoscowNetwork(), selected = msdCorridor(net), paint = planRoadMarkings(net, selected).segments;
    const degree = new Map<string, number>();
    for (const road of net.edges) for (const node of [road.from, road.to]) degree.set(node, (degree.get(node) ?? 0) + 1);
    let checked = 0;
    for (const road of net.edges) if (selected.has(road.id) && degree.get(road.from) === 2 && degree.get(road.to) === 2) {
      expectCoverage(paint, road); checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('does not confuse reverse copies at an ordinary source tag boundary with branches', () => {
    const roads = [edge('a', '0', 'tag', 0, 0, 0, -30), edge('b', 'tag', '2', 0, -30, 0, -60),
      edge('ar', 'tag', '0', 0, -30, 0, 0), edge('br', '2', 'tag', 0, -60, 0, -30)];
    const paint = plan(roads).segments;
    for (const road of roads) expectCoverage(paint, road);
  });
  it('shares ordinary lane-drop cross-sections and tapers over 20m', () => {
    const a = edge('a', '0', '1', 0, 0, 0, -60, 2), b = edge('b', '1', '2', 0, -60, 0, -120, 1);
    const paint = plan([a, b]).segments;
    const before = paint.get('a')!.filter(s => s.kind === 'edge' && s.d0 > 0);
    const after = paint.get('b')!.filter(s => s.kind === 'edge' && s.d0 > 0);
    expect(before.at(-1)!.d1).toBe(after[0].d0);
    expect(before.find(s => s.start === 40)!.d0).toBeCloseTo(3.6);
    expect(after.find(s => s.start === 20)!.d0).toBeCloseTo(1.8);
    for (const s of [...before, ...after]) expect(Math.abs(s.d1 - s.d0)).toBeLessThan(.25);
  });

  it('closes both reported real MSD seams and every ordinary selected shoulder seam', () => {
    const net = createMoscowNetwork(), selected = msdCorridor(net), paint = planRoadMarkings(net, selected).segments;
    const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
    for (const e of net.edges) {
      incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]); outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    }
    let checked = 0;
    for (const a of net.edges) {
      const b = outgoing.get(a.to)?.[0];
      if (!selected.has(a.id) || !b || !selected.has(b.id) || incoming.get(a.to)?.length !== 1 || outgoing.get(a.to)?.length !== 1) continue;
      for (const side of [-1, 1]) {
        const end = [...paint.get(a.id)!].reverse().find(s => s.kind === 'edge' && Math.sign(s.d1) === side);
        const start = paint.get(b.id)!.find(s => s.kind === 'edge' && Math.sign(s.d0) === side);
        if (!end || !start || Math.abs(end.end - a.length) > 1e-6 || start.start !== 0) continue;
        const p = sampleEdge(a, a.length, end.d1), q = sampleEdge(b, 0, start.d0);
        expect(Math.hypot(p.x - q.x, p.z - q.z), `${a.id} -> ${b.id}`).toBeLessThan(.01); checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    for (const [aId, bId] of [['osm:78326958:1:4', 'osm:251617382:1:0'], ['osm:259235949:1:6', 'osm:1213813872:1:0']]) {
      const a = net.edges.find(e => e.id === aId)!, b = net.edges.find(e => e.id === bId)!;
      expect(a.to).toBe(b.from);
      for (const side of [-1, 1]) {
        const end = paint.get(aId)!.filter(s => s.kind === 'edge' && Math.sign(s.d1) === side).at(-1)!;
        const start = paint.get(bId)!.find(s => s.kind === 'edge' && Math.sign(s.d0) === side)!;
        expect(end.end).toBeCloseTo(a.length); expect(start.start).toBe(0);
        expect(end.d1).toBeCloseTo(start.d0);
      }
    }
  });

  it('bounds legacy asphalt batches and culls around either camera eye while retaining large quads', () => {
    const keys = new Set(Array.from({ length: 10000 }, (_, i) => asphaltMaterialKey(i % 3 ? 'road' : 'parking', i)));
    expect(keys.size).toBe(ASPHALT_DEPTH_BUCKETS * 2);
    expect(roadChunkVisible(0, 0, 256, { x: 100, z: 0 })).toBe(true);
    expect(roadChunkVisible(0, 0, 256, { x: 4000, z: 0 })).toBe(false);
    expect(roadChunkVisible(10000, 0, 256, { x: 10100, z: 0 })).toBe(true);
    expect(roadChunkVisible(0, 0, 10000, { x: 9000, z: 0 })).toBe(true);
  });
  it('carries the dash phase across ordinary source-edge seams regardless of input order', () => {
    const a = edge('a', '0', '1', 0, 0, 0, -14), b = edge('b', '1', '2', 0, -14, 0, -40);
    const result = plan([b, a]);
    expect(result.phase.get('b')).toBe(14 % DASH_PERIOD);
    const lanes = result.segments.get('b')!.filter(s => s.kind === 'lane');
    expect(lanes.some(s => s.start === 0 && s.end === 1)).toBe(true);
    expect(lanes.some(s => s.start > 1 && s.start < 10)).toBe(false);
    for (const s of lanes) {
      const centre = (s.start + s.end) / 2 + result.phase.get('b')!;
      expect(centre % DASH_PERIOD).toBeLessThan(DASH_LENGTH);
    }
  });

  it('uses fixed paint widths and 3.6m lanes independently of shoulder width', () => {
    const road = edge('a', '0', '1', 0, 0, 0, -30); road.width = 22;
    const segments = plan([road]).segments.get('a')!;
    const boundaries = segments.filter(s => s.start === 0);
    expect(boundaries.filter(s => s.kind === 'edge').map(s => s.d0)).toEqual([-5.4, 5.4]);
    expect(boundaries.filter(s => s.kind === 'lane').map(s => s.d0)).toEqual([expect.closeTo(-1.8), expect.closeTo(1.8)]);
    for (const s of segments) expect(s.width).toBe(s.kind === 'edge' ? EDGE_LINE_WIDTH : LANE_LINE_WIDTH);
  });

  it('clips overlap paint at a traversable branch without a blanket 60m gap or invented hatches', () => {
    const approach = edge('a', '0', 'junction', 0, 30, 0, 0);
    const main = edge('main', 'junction', '2', 0, 0, 0, -80);
    const ramp = edge('ramp', 'junction', '3', 0, 0, 60, -60, 1);
    const paint = plan([approach, main, ramp]).segments.get('main')!;
    expect(paint.some(s => s.kind === 'lane' && s.start < 60)).toBe(true);
    // Right shoulder intersects the diverging ribbon; do not paint across that mouth.
    expect(paint.some(s => s.kind === 'edge' && s.d0 > 0 && s.start < 10)).toBe(false);
    expect(paint.some(s => s.kind === 'edge' && s.d0 < 0 && s.start < 10)).toBe(true);
    expect(paint.every(s => s.kind === 'edge' || s.kind === 'lane')).toBe(true);
    const right = paint.filter(s => s.kind === 'edge' && s.d0 > 0);
    expect(right[0].start).toBeLessThan(20);
    for (let i = 1; i < right.length; i++) expect(right[i].start).toBeCloseTo(right[i - 1].end, 7);
    expect(right.at(-1)!.end).toBe(80);
  });

  it('clips against varying surface-frame widths rather than a coarse maximum-width ribbon', () => {
    const main = edge('main', 'junction', '2', 0, 0, 0, -80);
    const approach = edge('a', '0', 'junction', 0, 30, 0, 0);
    const ramp = edge('ramp', 'junction', '3', 0, 0, 60, -60, 1);
    ramp.width = 40; // Actual prepared envelope is narrower than raw source width.
    ramp.surfaceFrames = [{ rightX: Math.SQRT1_2, rightZ: Math.SQRT1_2, halfWidth: 2 },
      { rightX: Math.SQRT1_2, rightZ: Math.SQRT1_2, halfWidth: 2 }];
    const right = plan([approach, main, ramp]).segments.get('main')!.filter(s => s.kind === 'edge' && s.d0 > 0);
    expect(right.some(s => s.start >= 10 && s.end <= 14)).toBe(true);
    const afterMouth = right.filter(s => s.start >= 9);
    for (let i = 1; i < afterMouth.length; i++) expect(afterMouth[i].start).toBeCloseTo(afterMouth[i - 1].end, 7);
  });

  it('emits nothing for unselected roads', () => {
    const road = edge('a', '0', '1', 0, 0, 0, -30);
    expect(planRoadMarkings(network([road]), new Set()).segments.size).toBe(0);
  });

  it('splits paint at actual source vertices rather than cutting across a corner', () => {
    const road = edge('a', '0', '1', 0, 0, 0, -20);
    road.points = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -7.3 }, { x: 8, y: 0, z: -14 }];
    road.length = 7.3 + Math.hypot(8, 6.7);
    const segments = plan([road]).segments.get('a')!;
    expect(segments.some(s => s.end === 7.3)).toBe(true);
    expect(segments.some(s => s.start < 7.3 && s.end > 7.3)).toBe(false);
  });

  it('shares one small deterministic asphalt texture rather than per-edge material clones', () => {
    const a = createRoadMaterials(16), b = createRoadMaterials();
    const texture = a.get('msd:asphalt')!.map! as DataTexture;
    expect(a.size).toBe(2); expect(texture.image.width).toBe(256);
    expect(texture.image.data).toEqual((b.get('msd:asphalt')!.map! as DataTexture).image.data);
    expect(texture.anisotropy).toBe(8);
    for (const set of [a, b]) for (const material of set.values()) { material.map?.dispose(); material.dispose(); }
  });
});
