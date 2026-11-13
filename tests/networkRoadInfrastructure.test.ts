import { describe, expect, it } from 'vitest';
import source from '../data/moscow/network.json';
import { sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from '../src/network/geometry';
import { emitRoadInfrastructure, planRoadInfrastructure } from '../src/network/roadInfrastructure';
import { correctDividedCarriagewayEnvelopes } from '../src/network/dividedCarriageways';
import { createMoscowNetwork } from '../src/network/moscow';

const edge = (id = 'road', x = 0, y = 0): NetworkEdge => ({ id, from: `${id}:a`, to: `${id}:b`,
  route: 'test', lanes: 3, kind: y > 0 ? 'bridge' : 'road', length: 400,
  points: [{ x, y, z: 0 }, { x, y, z: -400 }] });
const network = (...edges: NetworkEdge[]): RoadNetwork => ({ id: 'moscow-osm-test', nodes: [], parkings: [], edges });
const way90 = source.ways.find(w => (w.tags as Record<string, string>).maxspeed === '90')!;
const namedMain = source.ways.find(w => (w.tags as Record<string, string>).name === 'Северо-Восточная хорда'
  && (w.tags as Record<string, string>).oneway === 'yes')!;

describe('scoped roadside infrastructure CPU plan', () => {
  it('emits nothing outside the explicit corridor, including an empty corridor', () => {
    const a = edge(), b = edge('unrelated', 50), n = network(a, b);
    expect(planRoadInfrastructure(n, new Set())).toMatchObject({ runs: [], signs: [] });
    expect(planRoadInfrastructure(n, new Set([a.id])).runs.every(r => r.edgeId === a.id)).toBe(true);
  });
  it('leaves shared branch/merge throats open without transverse end caps', () => {
    const a = edge(), b = edge('branch', 50), c = edge('branch2', -50);
    b.from = a.from; c.from = a.from;
    b.points = [{ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: -50 }]; b.length = Math.hypot(50, 50);
    c.points = [{ x: 0, y: 0, z: 0 }, { x: -50, y: 0, z: -50 }]; c.length = b.length;
    const plan = planRoadInfrastructure(network(a, b, c), new Set([a.id]));
    expect(plan.runs.length).toBeGreaterThan(0);
    expect(plan.runs.every(r => r.start >= 16 && r.end <= 400)).toBe(true);
    expect(Math.max(...plan.runs.map(r => r.end))).toBe(400);
  });
  it('keeps rail faces, posts, reflectors and sign boxes outside the driving envelope', () => {
    const a = edge(`osm:${way90.id}:1:0`), n = network(a), half = sampleEdge(a, 0).halfWidth;
    let quads = 0, boxes = 0;
    emitRoadInfrastructure(n, new Set([a.id]), (_key, ...points: Vec3[]) => {
      quads++; for (const p of points) expect(Math.abs(p.x)).toBeGreaterThan(half);
    }, (_key, p, width, _height, length, heading) => {
      boxes++; const extent = Math.abs(Math.cos(heading)) * width / 2 + Math.abs(Math.sin(heading)) * length / 2;
      expect(Math.abs(p.x) - extent).toBeGreaterThan(half);
    });
    expect(quads).toBeGreaterThan(0); expect(boxes).toBeGreaterThan(0);
  });
  it('requires the original OSM maxspeed=90, never a route name or designed speed', () => {
    const a = edge(`osm:${way90.id}:1:0`), b = edge('osm:78326942:1:0', 50), c = edge('fake', 100);
    c.route = 'МСД 90';
    const n = network(a, b, c), signs = planRoadInfrastructure(n, new Set(n.edges.map(e => e.id))).signs;
    expect(signs.filter(s => s.kind === 'speed90').map(s => s.edgeId)).toEqual([a.id]);
    expect(planRoadInfrastructure({ ...network(a), id: 'synthetic' }, new Set([a.id])).signs).toEqual([]);
  });
  it('does not place signs on another carriageway and retains the source deck height', () => {
    const a = edge(`osm:${way90.id}:1:0`, 0, 12), other = edge('other', 9.5, 12);
    expect(planRoadInfrastructure(network(a, other), new Set([a.id])).signs).toEqual([]);
    other.points.forEach(p => { p.y = 0; });
    expect(planRoadInfrastructure(network(a, other), new Set([a.id])).signs.length).toBe(1);
    const heights: number[] = [];
    emitRoadInfrastructure(network(a, other), new Set([a.id]), (_key, ...points) => heights.push(...points.map(p => p.y)), (_key, p) => heights.push(p.y));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(12);
  });
  it('uses concrete only on corroborated divided named mainline, not ramps', () => {
    const a = edge(`osm:${namedMain.id}:1:0`), b = edge(`osm:${namedMain.id}:1:1`, -26);
    b.points.reverse();
    const rampWay = source.ways.find(w => (w.tags as Record<string, string>).highway?.endsWith('_link'))!;
    const ramp = edge(`osm:${rampWay.id}:1:0`, 60);
    const n = network(a, b, ramp), plan = planRoadInfrastructure(n, new Set(n.edges.map(e => e.id)));
    expect(plan.runs.some(r => r.edgeId === a.id && r.kind === 'median' && r.side === -1)).toBe(true);
    expect(plan.runs.filter(r => r.edgeId === ramp.id).every(r => r.kind === 'rail')).toBe(true);
  });
  it('never invents a direction sign from a branch alone', () => {
    const a = edge(), b = edge('branch', 50), c = edge('branch2', -50);
    b.from = a.to; c.from = a.to;
    expect(planRoadInfrastructure(network(a, b, c), new Set([a.id])).signs).toEqual([]);
  });
  it('shares one narrow-gap median outside both ribbons, including its emitted base', () => {
    const a = edge('osm:809185810:1:0'), b = edge('osm:809185811:1:0', -12.875);
    b.points.reverse();
    const n = network(a, b); correctDividedCarriagewayEnvelopes(n);
    const corridor = new Set([a.id, b.id]), p = planRoadInfrastructure(n, corridor);
    const medians = p.runs.filter(r => r.kind === 'median');
    expect(medians.length).toBe(1);
    expect(medians[0]).toMatchObject({ edgeId: a.id, start: 0, end: 400, pairedEdgeId: b.id });
    expect(p.runs.filter(r => r.side === -1).length).toBe(1);
    expect(p.coverage.duplicateSuppressedMeters).toBe(400);
    let vertices = 0;
    emitRoadInfrastructure(n, corridor, (material, ...points) => {
      if (material !== 'infrastructureConcrete') return;
      for (const q of points) {
        vertices++;
        expect(-q.x - a.width! / 2).toBeGreaterThanOrEqual(.025 - 1e-8);
        expect(q.x + 12.875 - b.width! / 2).toBeGreaterThanOrEqual(.025 - 1e-8);
      }
    }, () => {});
    expect(vertices).toBeGreaterThan(0);
  });
  it('opens a shared median at a crossing ramp instead of blocking its throat', () => {
    const a = edge('osm:809185810:1:0'), b = edge('osm:809185811:1:0', -12.875);
    b.points.reverse();
    const ramp = edge('ramp'); ramp.lanes = 1; ramp.width = 4;
    ramp.points = [{ x: 20, y: 0, z: -200 }, { x: -30, y: 0, z: -200 }]; ramp.length = 50;
    const n = network(a, b, ramp); correctDividedCarriagewayEnvelopes(n);
    const p = planRoadInfrastructure(n, new Set([a.id, b.id]));
    expect(p.runs.some(r => r.kind === 'median' && r.start < 190)).toBe(true);
    expect(p.runs.some(r => r.kind === 'median' && r.end > 210)).toBe(true);
    expect(p.runs.filter(r => r.kind === 'median').every(r => r.end < 198 || r.start > 202)).toBe(true);
  });
  it('does not suppress a requested median unless its counterpart actually emitted', () => {
    const a = edge('osm:809185810:1:0'), b = edge('osm:809185811:1:0', -26);
    b.points.reverse();
    // The lower-ID ribbon is excluded from furniture, but remains a real obstacle/pair.
    a.kind = 'tunnel';
    const p = planRoadInfrastructure(network(a, b), new Set([a.id, b.id]));
    expect(p.runs.some(r => r.edgeId === b.id && r.kind === 'median')).toBe(true);
    expect(p.coverage.duplicateSuppressedMeters).toBe(0);
  });
  it('restores the actual early MSD s180 median using framed envelopes', () => {
    const n = createMoscowNetwork(), a = n.edges.find(e => e.id === 'osm:809185810:1:0')!;
    const p = planRoadInfrastructure(n, new Set([a.id]));
    const run = p.runs.find(r => r.kind === 'median' && r.start <= 180 && r.end >= 180)!;
    expect(run).toBeDefined();
    const b = n.edges.find(e => e.id === run.pairedEdgeId)!;
    for (let s = run.start; s <= run.end; s += .25) {
      const lateral = run.lateralStart! + (run.lateralEnd! - run.lateralStart!) * (s - run.start) / (run.end - run.start);
      const q = sampleEdge(a, s, lateral), own = sampleEdge(a, s);
      expect(-lateral - own.halfWidth).toBeGreaterThanOrEqual(.375 - 1e-7);
      let nearest = { distance: Infinity, s: 0 }, arc = 0;
      for (let i = 1; i < b.points.length; i++) {
        const v = b.points[i - 1], w = b.points[i], dx = w.x - v.x, dz = w.z - v.z, length = Math.hypot(dx, dz);
        const t = Math.max(0, Math.min(1, ((q.x - v.x) * dx + (q.z - v.z) * dz) / (length * length)));
        const distance = Math.hypot(q.x - v.x - t * dx, q.z - v.z - t * dz);
        if (distance < nearest.distance) nearest = { distance, s: arc + t * length };
        arc += length;
      }
      const other = sampleEdge(b, nearest.s);
      const outside = -(q.x - other.x) * Math.cos(other.heading) - (q.z - other.z) * Math.sin(other.heading) - other.halfWidth;
      expect(outside).toBeGreaterThanOrEqual(.375 - .001);
    }
  }, 20000);
  it('includes interior profile knots in longitudinal rail quads', () => {
    const a = edge();
    a.points = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: -11 }, { x: 0, y: 0, z: -400 }];
    a.surfaceFrames = a.points.map(() => ({ rightX: 1, rightZ: 0, halfWidth: 6.9 }));
    let atKnot = false;
    emitRoadInfrastructure(network(a), new Set([a.id]), (_key, ...points) => {
      if (points.some(p => Math.abs(p.z + 11) < 1e-8 && p.y > 1.5)) atKnot = true;
      expect(points.some(p => p.z > -11) && points.some(p => p.z < -11)).toBe(false);
    }, () => {});
    expect(atKnot).toBe(true);
  });
  it('bounds geometry even if given a huge corridor', () => {
    const a = edge(); a.length = 100000; a.points[1].z = -100000;
    expect(planRoadInfrastructure(network(a), new Set([a.id])).runs.length).toBeLessThanOrEqual(12000);
  });
  it('continues through ordinary edge seams and includes the final partial run', () => {
    const a = edge('a'), b = edge('b');
    a.length = 403; a.points[1].z = -403;
    b.from = a.to; b.points = [{ x: 0, y: 0, z: -403 }, { x: 0, y: 0, z: -803 }];
    const p = planRoadInfrastructure(network(a, b), new Set([a.id, b.id]));
    for (const side of [-1, 1]) {
      const first = p.runs.filter(r => r.edgeId === a.id && r.side === side);
      const next = p.runs.filter(r => r.edgeId === b.id && r.side === side);
      expect(first[0].start).toBe(0); expect(first.at(-1)!.end).toBe(403);
      expect(next[0].start).toBe(0); expect(next.at(-1)!.end).toBe(400);
    }
    expect(p.coverage.emittedRoadsideMeters).toBe(1606);
    expect(p.coverage.clearanceSkippedMeters).toBe(0);
  });
  it('spreads a saturated run budget over later edges instead of truncating the corridor', () => {
    const edges = Array.from({ length: 10 }, (_, i) => {
      const a = edge(String(i), i * 100); a.length = 10000; a.points[1].z = -10000; return a;
    });
    const p = planRoadInfrastructure(network(...edges), new Set(edges.map(e => e.id)));
    expect(p.runs.length).toBeLessThanOrEqual(12000);
    expect(p.coverage.coveredEdges).toBe(10);
    expect(p.coverage.emittedRoadsideMeters).toBeCloseTo(200000, 4);
    expect(p.coverage.budgetSkippedMeters).toBe(0);
    expect(p.coverage.runStep).toBeGreaterThan(8);
  });
});
