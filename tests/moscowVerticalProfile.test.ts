import { describe, expect, it } from 'vitest';
import data from '../data/moscow/network.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { boundedGrade, verticalProfile } from '../src/network/verticalProfile';
import { validateNetwork, type Vec3 } from '../src/network/geometry';
import { msdPilotMainlineHeight, msdPilotScope } from '../src/network/msdPilot';

const grade = (a: Vec3, b: Vec3) => (b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z);
const way = (id: number, nodes: number[], tags = {}) => ({ id, nodes, tags: { oneway: 'yes', lanes: '2', ...tags } });

describe('bounded continuous Moscow vertical profiles', () => {
  it('rejects invalid inputs and unsatisfiable sampling budgets before allocation', () => {
    for (const length of [0, -1, Infinity, NaN]) {
      expect(() => verticalProfile(0, 8, length, 0, 0)).toThrow(RangeError);
    }
    expect(() => verticalProfile(NaN, 8, 100, 0, 0)).toThrow(RangeError);
    expect(() => verticalProfile(0, 8, 100, Infinity, 0)).toThrow(RangeError);
    expect(() => verticalProfile(0, 8, 1e-6, 0, 0)).toThrow(/sampling budget/);
  });
  it('has exact endpoint heights and shared analytic grades without overshoot on unequal intervals', () => {
    for (const sign of [1, -1]) for (const length of [.01, 2, 100, 1000]) {
      for (const slope of [.001, .08, .12, .2]) for (const start of [0, slope / 2, slope]) {
        const a = 3, b = a + sign * length * slope;
        const profile = verticalProfile(a, b, length, sign * start, 0);
        expect(profile.height(0)).toBe(a); expect(profile.height(1)).toBe(b);
        const ts = [0, ...profile.fractions];
        let previous: number | undefined;
        let minY = Infinity, maxY = -Infinity, minRise = Infinity, maxStep = 0;
        for (let i = 1; i < ts.length; i++) {
          const y = profile.height(ts[i]), before = profile.height(ts[i - 1]);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          minRise = Math.min(minRise, sign * (y - before));
          const g = (y - before) / (length * (ts[i] - ts[i - 1]));
          if (previous !== undefined) maxStep = Math.max(maxStep, Math.abs(g - previous));
          previous = g;
        }
        expect(minY).toBeGreaterThanOrEqual(Math.min(a, b) - 1e-12);
        expect(maxY).toBeLessThanOrEqual(Math.max(a, b) + 1e-12);
        expect(minRise).toBeGreaterThanOrEqual(-1e-12);
        expect(maxStep).toBeLessThan(.00201);
        const h = 1e-7;
        expect((profile.height(h) - a) / (h * length)).toBeCloseTo(sign * start, 5);
        expect((b - profile.height(1 - h)) / (h * length)).toBeCloseTo(0, 5);
      }
    }
    expect(boundedGrade(.1, -.2)).toBe(0);
    expect(boundedGrade(.1, 0)).toBe(0);
    expect(boundedGrade(.1, .02)).toBe(.02);
  });

  it('smooths steep-to-flat interior controls, ordinary tag seams, and reverse travel', () => {
    for (const oneway of ['yes', 'no']) for (const split of [false, true]) {
      const network = createMoscowNetwork({ nodes: {
        1: [0, 0, 0], 2: [100, 10, 0], 3: [120, 10, 0], 4: [250, 2, 0],
      }, ways: split ? [way(1, [1, 2], { oneway, bridge: 'yes', layer: '1' }),
        way(2, [2, 3, 4], { oneway })] : [way(1, [1, 2, 3, 4], { oneway })], startWayId: 1 });
      expect(validateNetwork(network)).toEqual([]);
      for (const edge of network.edges) {
        let previous: number | undefined;
        for (let i = 1; i < edge.points.length; i++) {
          const g = grade(edge.points[i - 1], edge.points[i]);
          expect(Math.abs(g)).toBeLessThan(.125);
          if (previous !== undefined) expect(Math.abs(g - previous)).toBeLessThan(.00201);
          previous = g;
        }
      }
      for (const x of [0, 100, 120, 250]) {
        const points = network.edges.flatMap(e => e.points).filter(p => p.x === x);
        expect(points.length).toBeGreaterThan(0);
        for (const p of points) expect(p.y).toBe(x === 0 ? 0 : x === 250 ? 2 : 10);
      }
    }
  });

  it('keeps real branch XYZ and matches the grade of every incident movement', () => {
    const network = createMoscowNetwork({ nodes: { 1: [-100, 0, 0], 2: [0, 8, 0],
      3: [100, 8, 0], 4: [0, 0, 100] }, ways: [way(1, [1, 2]), way(2, [2, 3]), way(3, [2, 4])], startWayId: 1 });
    expect(network.nodes.find(n => n.id === 'osm-node:2')!.position).toEqual({ x: 0, y: 8, z: 0 });
    for (const e of network.edges) {
      const points = e.points;
      const g = e.to === 'osm-node:2' ? grade(points.at(-2)!, points.at(-1)!) : grade(points[0], points[1]);
      expect(Math.abs(g)).toBeLessThan(.00001);
    }
  });

  it('shares zero grade when another way joins an interior source control', () => {
    const network = createMoscowNetwork({ nodes: { 1: [-100, 0, 0], 2: [0, 8, 0],
      3: [100, 10, 0] }, ways: [way(1, [1, 2, 3]), way(2, [2, 3])], startWayId: 1 });
    const incoming = network.edges.filter(e => e.to === 'osm-node:2');
    const outgoing = network.edges.filter(e => e.from === 'osm-node:2');
    expect(incoming.length).toBeGreaterThan(0); expect(outgoing.length).toBeGreaterThan(1);
    for (const a of incoming) for (const b of outgoing) {
      expect(Math.abs(grade(a.points.at(-2)!, a.points.at(-1)!) - grade(b.points[0], b.points[1])))
        .toBeLessThan(.00001);
    }
  });

  it('bounds runtime adjacent grade changes and ordinary seam errors across the entire Moscow network', () => {
    const network = createMoscowNetwork();
    const starts = new Map<string, typeof network.edges>();
    for (const e of network.edges) starts.set(e.from, [...(starts.get(e.from) ?? []), e]);
    let maxStep = 0, maxSeam = 0, maxSharedSeam = 0, maxGrade = 0, seams = 0, sharedSeams = 0;
    for (const e of network.edges) {
      let previous: number | undefined;
      for (let i = 1; i < e.points.length; i++) {
        const g = grade(e.points[i - 1], e.points[i]);
        expect(Number.isFinite(g)).toBe(true);
        maxGrade = Math.max(maxGrade, Math.abs(g));
        if (previous !== undefined) maxStep = Math.max(maxStep, Math.abs(g - previous));
        previous = g;
      }
      const exits = starts.get(e.to) ?? [];
      for (const next of exits) {
        maxSharedSeam = Math.max(maxSharedSeam, Math.abs(previous! - grade(next.points[0], next.points[1])));
        sharedSeams++;
      }
      if (exits.length === 1) {
        maxSeam = Math.max(maxSeam, Math.abs(previous! - grade(exits[0].points[0], exits[0].points[1]))); seams++;
      }
    }
    console.info('Moscow vertical profile metrics', { maxGrade, maxStep, maxSeam, maxSharedSeam, seams, sharedSeams });
    expect(maxGrade).toBeLessThan(.125);
    expect(maxStep).toBeLessThan(.00201);
    expect(maxSeam).toBeLessThan(.00001);
    expect(maxSharedSeam).toBeLessThan(.00001);
    expect(sharedSeams).toBeGreaterThan(seams);
    expect(seams).toBeGreaterThan(5000);
    // Only the declared section-01 pilot and section-02 pass replace inferred source heights.
    // Outside nodes remain exact constraints; inside nodes must agree with all
    // incident representations and the explicit engineering alignment.
    const raw = data.nodes as Record<string, number[]>;
    const scope = msdPilotScope(network).edgeIds;
    // Section 02 (1942.3–5849.8 m) is the second declared height pass: its edges are
    // exactly those whose published points differ from a build without it.
    const without = createMoscowNetwork(undefined, { section02VerticalAlignment: false });
    const section02 = new Set(network.edges.filter((e, i) => e.points.length !== without.edges[i].points.length
      || e.points.some((p, j) => p.y !== without.edges[i].points[j].y)).map(e => e.id));
    expect(section02.size).toBeGreaterThan(20);
    const incident = new Map<string, Array<{ way: number; scoped: boolean; section02: boolean; point: Vec3 }>>();
    for (const e of network.edges) for (const [id, point] of [[e.from, e.points[0]], [e.to, e.points.at(-1)!]] as const) {
      incident.set(id, [...(incident.get(id) ?? []), { way: Number(e.id.split(':')[1]), scoped: scope.has(e.id), section02: section02.has(e.id), point }]);
    }
    const main = new Set([809185810, 809185809, 809185806, 809185807, 809185812, 809185811]);
    let changedNodes = 0, mainNodes = 0, loopNodes = 0;
    for (const node of network.nodes) {
      const records = incident.get(node.id) ?? [], baseline = raw[node.id.split(':')[1]][1];
      if (records.some(r => r.section02) && !records.some(r => r.scoped)) {
        for (const record of records) expect(record.point.y).toBeCloseTo(node.position.y, 6);
        continue;
      }
      if (!records.some(r => r.scoped)) { expect(node.position.y).toBe(baseline); continue; }
      for (const record of records) expect(record.point.y).toBeCloseTo(node.position.y, 7);
      if (records.some(r => !r.scoped)) expect(node.position.y).toBe(baseline);
      if (records.some(r => r.scoped && main.has(r.way))) {
        expect(node.position.y).toBeCloseTo(msdPilotMainlineHeight(node.position.z), 7); mainNodes++;
      }
      if (records.some(r => r.way === 809185783)) { expect(node.position.y).toBe(.2); loopNodes++; }
      // Connector interior is a bounded Hermite transition between the loop
      // and southbound mainline, not an unconstrained exception.
      if (records.every(r => r.way === 809185782)) {
        expect(node.position.y).toBeGreaterThanOrEqual(.2);
        expect(node.position.y).toBeLessThanOrEqual(msdPilotMainlineHeight(-1622.4474));
      }
      if (node.position.y !== baseline) changedNodes++;
    }
    expect(changedNodes).toBeGreaterThan(10);
    expect(mainNodes).toBeGreaterThan(10); expect(loopNodes).toBeGreaterThan(3);
    expect(validateNetwork(network)).toEqual([]);
  });
});
