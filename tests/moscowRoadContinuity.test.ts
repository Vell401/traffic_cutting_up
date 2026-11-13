import { describe, expect, it } from 'vitest';
import { createMoscowNetwork } from '../src/network/moscow';
import { roadSampleDistances, sampleEdge, validateNetwork, type NetworkEdge, type RoadNetwork } from '../src/network/geometry';
import { prepareRoadFrames } from '../src/network/roadFrames';
import { msdCorridor } from '../src/network/msdCorridor';
import { project, spawnDriver, stepDriver, FIXED_STEP } from '../src/network/driving';

const gap = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const edge = (id: string, from: string, to: string, coordinates: number[][], lanes = 2): NetworkEdge => {
  const points = coordinates.map(([x, z]) => ({ x, y: .2, z }));
  return { id, from, to, points, lanes, kind: 'road', route: 'test',
    length: points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - points[i].x, p.z - points[i].z), 0) };
};
const network = (edges: NetworkEdge[]): RoadNetwork => ({ id: 'fixture', edges, nodes: [], parkings: [] });
function seamGap(a: NetworkEdge, b: NetworkEdge): number {
  return Math.max(...[-1, 1].map(side => gap(sampleEdge(a, a.length, side * sampleEdge(a, a.length).halfWidth),
    sampleEdge(b, 0, side * sampleEdge(b, 0).halfWidth))));
}

describe('shared Moscow road ribbon frames', () => {
  it('maps physical forward, reverse and drift displacement before resolving framed walls', () => {
    const e = edge('skew', '1', '2', [[0, 0], [100, -20]]);
    e.surfaceFrames = [{ rightX: .8, rightZ: .6, halfWidth: 8 }, { rightX: .8, rightZ: .6, halfWidth: 8 }];
    const n = network([e]); n.parkings.push({ id: 'p', name: 'test', edgeId: e.id, s: 30 });
    for (const physicsId of [1, 2, 3, 4, 5] as const) for (const speed of [-3, 12]) {
      const driver = spawnDriver(n, 'test', 'p', physicsId);
      driver.car.reset(30, 1, .15); driver.car.setRoadVelocity(speed, 1);
      const p = sampleEdge(e, driver.car.s, driver.car.d);
      stepDriver(n, driver, { steer: 0, throttle: 0, brake: 0 }, FIXED_STEP);
      const q = sampleEdge(e, driver.s, driver.d);
      const h = sampleEdge(e, driver.s).heading;
      const vx = Math.sin(h) * driver.car.vAlong + Math.cos(h) * driver.car.vLat;
      const vz = -Math.cos(h) * driver.car.vAlong + Math.sin(h) * driver.car.vLat;
      expect(Math.hypot(q.x - p.x - vx * FIXED_STEP, q.z - p.z - vz * FIXED_STEP)).toBeLessThan(.003);
      expect(Math.abs(driver.d)).toBeLessThan(8);
    }
    const wall = spawnDriver(n, 'wall', 'p');
    wall.car.reset(30, 7.9, .2); wall.car.setRoadVelocity(8, 5);
    for (let i = 0; i < 20; i++) stepDriver(n, wall, { steer: 0, throttle: 0, brake: 0 }, FIXED_STEP);
    expect(Math.abs(wall.d) + wall.car.halfExtentD()).toBeLessThanOrEqual(8.001);
  });
  it('inverts the actual interpolated surface on skew synthetic and real MSD segments', () => {
    const synthetic = edge('skew', '1', '2', [[0, 0], [10, -2], [11, -8]]);
    synthetic.surfaceFrames = [
      { rightX: 1, rightZ: 0, halfWidth: 5 },
      { rightX: .8, rightZ: .6, halfWidth: 5 },
      { rightX: .6, rightZ: .8, halfWidth: 5 },
    ];
    const real = createMoscowNetwork().edges.find(e => e.id === 'osm:782665387:1:3')!;
    expect(real).toBeDefined();
    for (const e of [synthetic, real]) for (const s of [1, 4, e.length * .4, e.length * .8]) {
      for (const d of [-3, 0, 3]) {
        const p = sampleEdge(e, s, d), address = project(e, p);
        expect(gap(sampleEdge(e, address.s, address.d), p)).toBeLessThan(1e-7);
        expect(address.s).toBeCloseTo(s, 6);
        expect(address.d).toBeCloseTo(d, 6);
      }
    }
    const n = network([real]); n.parkings.push({ id: 'p', name: 'real skew', edgeId: real.id, s: 4 });
    const driver = spawnDriver(n, 'real');
    driver.car.reset(4, 3, .1); driver.car.setRoadVelocity(12, .5);
    const p = sampleEdge(real, 4, 3);
    stepDriver(n, driver, { steer: 0, throttle: 0, brake: 0 }, FIXED_STEP);
    const q = sampleEdge(real, driver.s, driver.d), h = sampleEdge(real, driver.s).heading;
    const vx = Math.sin(h) * driver.car.vAlong + Math.cos(h) * driver.car.vLat;
    const vz = -Math.cos(h) * driver.car.vAlong + Math.sin(h) * driver.car.vLat;
    expect(Math.hypot(q.x - p.x - vx * FIXED_STEP, q.z - p.z - vz * FIXED_STEP)).toBeLessThan(.003);
  });
  it('reproduces independent endpoint-normal cracks and closes both sides of turning seams', () => {
    const a = edge('a', '1', '2', [[-100, 0], [0, 0]]);
    const b = edge('b', '2', '3', [[0, 0], [4, -3]]);
    expect(seamGap(a, b)).toBeGreaterThan(1);
    const before = JSON.stringify([a.points, b.points]);
    prepareRoadFrames(network([a, b]));
    expect(seamGap(a, b)).toBeLessThan(1e-10);
    expect(JSON.stringify([a.points, b.points])).toBe(before);
    expect(sampleEdge(a, a.length).heading).toBeCloseTo(sampleEdge(b, 0).heading, 12);
  });

  it('uses distance-windowed unit frames on unequal segments and continuous finite vertex offsets', () => {
    const a = edge('unequal', '1', '2', [[-100, 0], [0, 0], [0, -1]]);
    prepareRoadFrames(network([a]));
    const frame = a.surfaceFrames![1];
    expect(Math.hypot(frame.rightX, frame.rightZ)).toBeCloseTo(1, 12);
    expect(gap(sampleEdge(a, 100, 5), sampleEdge(a, 100))).toBeCloseTo(5, 10);
    for (const d of [-5.1, 0, 5.1]) {
      expect(gap(sampleEdge(a, 100 - 1e-9, d), sampleEdge(a, 100 + 1e-9, d))).toBeLessThan(1e-7);
    }
    const stations = roadSampleDistances(a, .4);
    expect(stations).toContain(100); expect(stations.at(-1)).toBe(a.length);
    for (let i = 1; i < stations.length; i++) expect(stations[i] - stations[i - 1]).toBeLessThanOrEqual(.400000001);
    expect(() => roadSampleDistances(a, 0)).toThrow(RangeError);
  });

  it('matches finite widths on very short lane-changing edges without changing lane metadata', () => {
    const a = edge('a', '1', '2', [[-.02, 0], [0, 0]], 3);
    const b = edge('b', '2', '3', [[0, 0], [.001, -.001]], 1);
    prepareRoadFrames(network([a, b]));
    expect(seamGap(a, b)).toBeLessThan(1e-10);
    expect(a.lanes).toBe(3); expect(b.lanes).toBe(1);
    for (const e of [a, b]) for (const s of roadSampleDistances(e)) {
      expect(Object.values(sampleEdge(e, s, 8)).every(Number.isFinite)).toBe(true);
      expect(sampleEdge(e, s).halfWidth).toBeGreaterThan(0);
    }
  });

  it('does not weld branches, nearby unrelated decks, or manufacture a reverse corridor', () => {
    const a = edge('a', '1', '2', [[-10, 0], [0, 0]]);
    const b = edge('b', '2', '3', [[0, 0], [10, -5]]);
    const c = edge('c', '2', '4', [[0, 0], [0, 10]]);
    const d = edge('d', '5', '6', [[0, 0], [10, -5]]);
    prepareRoadFrames(network([a, b, c, d]));
    expect(seamGap(a, b)).toBeGreaterThan(1);
    expect(a.surfaceFrames!.at(-1)!.rightX).toBe(0);
    expect(b.surfaceFrames![0]).toEqual(d.surfaceFrames![0]);
  });

  it('closes ordinary seams and keeps finite continuous curve samples across the full MSD network', () => {
    const n = createMoscowNetwork();
    const scope = msdCorridor(n);
    const incoming = new Map<string, NetworkEdge[]>(), outgoing = new Map<string, NetworkEdge[]>();
    for (const e of n.edges) {
      incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
      outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    }
    let seams = 0, reversals = 0, maxGap = 0, stations = 0, maxMiter = 0, maxVertexGap = 0, foldedQuads = 0;
    const cross = (a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }) =>
      (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    for (const e of n.edges) {
      if (!scope.has(e.id)) { expect(e.surfaceFrames).toBeUndefined(); continue; }
      const ds = roadSampleDistances(e);
      stations += ds.length;
      for (const s of ds) {
        const p = sampleEdge(e, s);
        expect(Object.values(p).every(Number.isFinite)).toBe(true);
        expect(p.halfWidth).toBeGreaterThan(0);
        const right = sampleEdge(e, s, p.halfWidth);
        expect(gap(right, p)).toBeCloseTo(p.halfWidth, 8);
      }
      for (let i = 1; i < ds.length; i++) {
        const s = ds[i - 1], t = ds[i], w = sampleEdge(e, s).halfWidth, v = sampleEdge(e, t).halfWidth;
        const a = sampleEdge(e, s, -w), b = sampleEdge(e, t, -v), c = sampleEdge(e, t, v), d = sampleEdge(e, s, w);
        if (cross(a, b, c) * cross(a, c, d) < -1e-10) foldedQuads++;
      }
      let s = 0;
      for (let i = 0; i < e.points.length; i++) {
        const f = e.surfaceFrames![i]; maxMiter = Math.max(maxMiter, Math.hypot(f.rightX, f.rightZ));
        if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
        if (i && i < e.points.length - 1) for (const side of [-1, 1]) {
          const epsilon = Math.min(1e-10,
            Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z) * 1e-8,
            Math.hypot(e.points[i + 1].x - e.points[i].x, e.points[i + 1].z - e.points[i].z) * 1e-8);
          maxVertexGap = Math.max(maxVertexGap, gap(sampleEdge(e, s - epsilon, side * f.halfWidth),
            sampleEdge(e, s + epsilon, side * f.halfWidth)));
        }
      }
      const exits = outgoing.get(e.to);
      if (incoming.get(e.to)?.length === 1 && exits?.length === 1 && scope.has(exits[0].id) && exits[0].to !== e.from) {
        const p = e.points.at(-1)!, q = e.points.at(-2)!, r = exits[0].points[1];
        const dot = ((p.x - q.x) * (r.x - p.x) + (p.z - q.z) * (r.z - p.z))
          / Math.hypot(p.x - q.x, p.z - q.z) / Math.hypot(r.x - p.x, r.z - p.z);
        if (dot < -.95) { reversals++; continue; }
        maxGap = Math.max(maxGap, seamGap(e, exits[0])); seams++;
      }
    }
    console.info('Moscow road ribbon continuity metrics', { edges: n.edges.length, corridorEdges: scope.size, stations, seams, reversals, maxGap, maxMiter, maxVertexGap, foldedQuads });
    expect(seams).toBeGreaterThan(700);
    expect(maxGap).toBeLessThan(1e-7);
    expect(maxMiter).toBeLessThanOrEqual(2.000000001);
    expect(maxVertexGap).toBeLessThan(1e-4);
    expect(foldedQuads).toBe(0);
    expect(validateNetwork(n)).toEqual([]);
  }, 30000);
});
