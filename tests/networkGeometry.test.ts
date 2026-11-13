import { describe, expect, it } from 'vitest';
import { edgeById, networkLength, outgoing, sampleEdge, validateNetwork } from '../src/network/geometry';
import type { NetworkEdge, RoadNetwork } from '../src/network/geometry';
import { createBayNetwork, createPrototypeNetwork } from '../src/network/layout';

const angle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const straight = (): NetworkEdge => ({ id: 'a', from: 'a', to: 'b', route: 'test', lanes: 2, endLanes: 3, kind: 'road', length: 100, points: [{ x: 0, y: 5, z: 0 }, { x: 0, y: 15, z: -100 }] });

describe('standalone network geometry contract', () => {
  it('samples horizontal distance, grade, right offset, clamp, taper and explicit width', () => {
    const edge = straight();
    expect(sampleEdge(edge, 50, 4)).toEqual({ x: 4, y: 10, z: -50, heading: 0, grade: 0.1, curvature: 0, lanes: 2.5, halfWidth: 6 });
    expect(sampleEdge(edge, -10).z).toBe(0);
    expect(sampleEdge(edge, 1000).z).toBe(-100);
    expect(sampleEdge(edge, Infinity).z).toBe(-100);
    edge.width = 20;
    expect(sampleEdge(edge, 50).halfWidth).toBe(10);
    expect(() => sampleEdge({ ...edge, points: [] }, 0)).toThrow('Degenerate');
    expect(() => edgeById(createPrototypeNetwork(), 'missing')).toThrow('Unknown');
  });

  it('uses actual cumulative arc distance on unequally spaced points', () => {
    const edge = straight();
    edge.points.splice(1, 0, { x: 0, y: 6, z: -10 });
    expect(sampleEdge(edge, 55).y).toBeCloseTo(10.5, 8);
    expect(sampleEdge(edge, 55).z).toBeCloseTo(-55, 8);
  });

  for (const [name, create] of [['prototype', createPrototypeNetwork], ['bay', createBayNetwork]] as const) {
    describe(name, () => {
      const network = create();
      it('is deterministic, valid and all directed edges are strongly reachable', () => {
        expect(create()).toEqual(network);
        expect(validateNetwork(network)).toEqual([]);
        for (const root of network.edges) {
          const seen = new Set<string>(), pending = [root];
          while (pending.length) {
            const edge = pending.pop()!;
            if (seen.has(edge.id)) continue;
            seen.add(edge.id); pending.push(...outgoing(network, edge.id));
          }
          expect(seen.size, root.id).toBe(network.edges.length);
        }
      }, 20000);
      it('has dense finite geometry, mild grades, continuous legal seams and no median U-turns', () => {
        for (const edge of network.edges) {
          for (let i = 1; i < edge.points.length; i++) {
            const a = edge.points[i - 1], b = edge.points[i];
            const ds = Math.hypot(b.x - a.x, b.z - a.z);
            expect(ds, edge.id).toBeGreaterThan(0);
            expect(ds, edge.id).toBeLessThan(16);
            expect(Math.abs(b.y - a.y) / ds, edge.id).toBeLessThan(0.12);
          }
          const a = sampleEdge(edge, edge.length);
          for (const next of outgoing(network, edge.id)) {
            const b = sampleEdge(next, 0);
            expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `${edge.id} -> ${next.id}`).toBeLessThan(0.001);
            expect(angle(a.heading, b.heading), `${edge.id} -> ${next.id}`).toBeLessThan(0.055);
            expect(next.to === edge.from, edge.id).toBe(false);
          }
        }
      });
      it('provides genuine splits, merges, lane taper and drivable parking access', () => {
        expect(network.edges.some(e => outgoing(network, e.id).length > 1)).toBe(true);
        expect(network.nodes.some(n => network.edges.filter(e => e.to === n.id).length > 1)).toBe(true);
        expect(network.edges.some(e => e.endLanes !== undefined && e.endLanes !== e.lanes)).toBe(true);
        for (const p of network.parkings) {
          const e = edgeById(network, p.edgeId);
          expect(e.kind).toBe('parking'); expect(p.s).toBeGreaterThan(20);
          expect(p.s).toBeLessThan(e.length - 20);
          expect(outgoing(network, e.id).length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('keeps both carriageways left of their directed shared axis', () => {
    const network = createBayNetwork();
    for (const plus of network.edges.filter(e => /^(R0|C1|C2)\+:/.test(e.id))) {
      const minus = edgeById(network, plus.id.replace('+', '-'));
      const a = sampleEdge(plus, plus.length / 2), b = sampleEdge(minus, minus.length / 2);
      const rightProjection = (b.x - a.x) * Math.cos(a.heading) + (b.z - a.z) * Math.sin(a.heading);
      expect(rightProjection).toBeGreaterThan(12);
      expect(angle(a.heading, b.heading)).toBeGreaterThan(3.1);
    }
  });

  it('encodes identical mainline seam tangents in the actual endpoint segments', () => {
    const network = createBayNetwork();
    for (const edge of network.edges.filter(e => /^(R0|C[123]|S[123])[+-]:/.test(e.id))) {
      const p = edge.points, a = p[p.length - 2], b = p[p.length - 1];
      for (const next of outgoing(network, edge.id).filter(e => e.route === edge.route)) {
        const [c, d] = next.points;
        const incoming = Math.atan2(b.x - a.x, a.z - b.z);
        const departing = Math.atan2(d.x - c.x, c.z - d.z);
        expect(angle(incoming, departing), `${edge.id} -> ${next.id}`).toBeLessThan(1e-8);
        expect(angle(sampleEdge(edge, edge.length).heading, incoming)).toBeLessThan(1e-8);
        expect(angle(sampleEdge(next, 0).heading, departing)).toBeLessThan(1e-8);
        // Curvature remains the local heading derivative, including either side
        // of a seam, rather than being masked by a special endpoint heading.
        for (const [e, s] of [[edge, edge.length - 0.5], [next, 0.5]] as const) {
          const h0 = sampleEdge(e, s - 0.01).heading, h1 = sampleEdge(e, s + 0.01).heading;
          const derivative = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)) / 0.02;
          expect(sampleEdge(e, s).curvature).toBeCloseTo(derivative, 7);
        }
      }
    }
  });

  it('prototype contains a physical grade-separated crossing with no shared junction', () => {
    const network = createPrototypeNetwork();
    const near = network.edges.filter(e => e.route === 'prototype').flatMap(e => e.points).filter(p => Math.hypot(p.x, p.z) < 20);
    expect(near.length).toBeGreaterThan(2);
    expect(Math.max(...near.map(p => p.y)) - Math.min(...near.map(p => p.y))).toBeGreaterThan(16);
  });

  it('keeps every authored bay ramp/access segment below eight percent grade', () => {
    const network = createBayNetwork();
    const ramps = network.edges.filter(e => !/^(R0|C[123]|S[123])[+-]:/.test(e.id));
    expect(ramps.length).toBeGreaterThan(30);
    // Inspect every segment, not sparse sampleEdge probes that can miss spikes
    // around low-speed regions of the horizontal Bezier parameterisation.
    const worst = ramps.map(edge => ({
      id: edge.id,
      grade: Math.max(...edge.points.slice(1).map((p, i) => {
        const q = edge.points[i];
        return Math.abs(p.y - q.y) / Math.hypot(p.x - q.x, p.z - q.z);
      })),
    })).sort((a, b) => b.grade - a.grade);
    expect(worst[0].grade, JSON.stringify(worst.slice(0, 5))).toBeLessThanOrEqual(0.08);
  });

  it('matches variant02 axis budgets excluding ramps and contains its named facilities', () => {
    const n = createBayNetwork();
    const budgets: Record<string, [number, number]> = { R0: [33000, 39000], C1: [7000, 8500], C2: [8000, 9500], C3: [2000, 3000], S1: [3300, 4200], S2: [3300, 4200], S3: [3300, 4200] };
    let axes = 0;
    for (const [route, [min, max]] of Object.entries(budgets)) {
      const length = n.edges.filter(e => e.route === route).reduce((s, e) => s + e.length, 0) / 2;
      expect(length, route).toBeGreaterThanOrEqual(min); expect(length, route).toBeLessThanOrEqual(max); axes += length;
    }
    expect(axes).toBeGreaterThanOrEqual(60000); expect(axes).toBeLessThanOrEqual(73000);
    expect(networkLength(n)).toBeGreaterThan(axes * 2);
    for (const id of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'X1', 'F4']) expect(n.edges.some(e => e.route === id), id).toBe(true);
    expect(n.parkings.map(p => p.id)).toEqual(['P1', 'P2', 'P3']);
    expect(n.edges.some(e => e.route === 'R0' && e.kind === 'tunnel' && e.points.some(p => p.y < -30))).toBe(true);
    expect(n.edges.some(e => e.route === 'R0' && e.kind === 'bridge' && e.points.some(p => p.y > 35))).toBe(true);
    for (const route of ['C1', 'C2']) expect(n.edges.some(e => e.route === route && e.kind === 'tunnel')).toBe(true);
  });

  it('crosses city mainlines at independent levels rather than connecting at the crossing', () => {
    const n = createBayNetwork();
    const near = (route: string) => n.edges.filter(e => e.route === route).flatMap(e => e.points.map(p => ({ p, e }))).sort((a, b) => Math.hypot(a.p.x + 150, a.p.z + 100) - Math.hypot(b.p.x + 150, b.p.z + 100))[0];
    const a = near('C1'), b = near('C2');
    expect(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z)).toBeLessThan(25);
    expect(Math.abs(a.p.y - b.p.y)).toBeGreaterThan(14);
    expect(a.e.from).not.toBe(b.e.from); expect(a.e.to).not.toBe(b.e.to);
  });

  it('reports invalid topology and geometry without mutating input', () => {
    const n: RoadNetwork = { id: 'broken', nodes: [{ id: 'a', position: { x: 0, y: 0, z: 0 } }, { id: 'isolated', position: { x: 1, y: 0, z: 0 } }], edges: [{ ...straight(), lanes: -1, length: 7 }], parkings: [{ id: 'bad', name: '', edgeId: 'missing', s: -1 }] };
    const before = JSON.stringify(n), errors = validateNetwork(n).join(';');
    for (const message of ['Missing endpoint', 'Length mismatch', 'Invalid lanes', 'Endpoint gap', 'Invalid parking', 'strongly connected']) expect(errors).toContain(message);
    expect(JSON.stringify(n)).toBe(before);
  });
});
