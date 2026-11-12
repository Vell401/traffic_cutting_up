import { describe, expect, it } from 'vitest';
import { WALL_D } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { getMap, resolveMap, isSpawnProtected } from '../src/sim/maps';
import { MIAMI_LEN, miamiDistrict, miamiScript } from '../src/sim/miami';
import { ringScript, spawnS, SPAWN_D } from '../src/sim/ring';
import { Road, CurvatureProfile, MIN_RADIUS, SAMPLE_DS } from '../src/sim/road';
import { Sim } from '../src/sim/world';
import { SHOWCASES } from '../src/sim/testTrack';

const point = () => ({ x: 0, z: 0, th: 0, k: 0 });
type Point = ReturnType<typeof point>;

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
    || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) return false;
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

describe('immutable map registry and solo lifecycle', () => {
  it('validates IDs, reuses the untouched highway script and freezes nested definitions', () => {
    expect(resolveMap()).toBe(getMap('highway'));
    for (const id of ['', null, 'Miami', 'constructor', 'unknown']) expect(() => resolveMap(id)).toThrow('Unknown map');
    expect(getMap('highway').script).toEqual(ringScript());
    expect(getMap('highway').spawn.s).toBe(spawnS(0));
    expect(getMap('miami').spawn.d).toBe(SPAWN_D);
    for (const id of ['highway', 'miami'] as const) {
      const map = getMap(id);
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.isFrozen(map.spawn)).toBe(true);
      expect(Object.isFrozen(map.script.curves[0])).toBe(true);
      expect(() => { map.script.curves[0].len = 7; }).toThrow();
    }
  });

  it('preserves procedural highway solo and finite showcases, but Miami solo drives its real map', () => {
    const old = new Sim(mulberry32(9));
    const highway = new Sim(mulberry32(9), { map: 'highway' });
    expect(highway.road.ringLen).toBe(Infinity);
    expect(highway.road.chunks.map(c => [...c.x])).toEqual(old.road.chunks.map(c => [...c.x]));
    const miami = new Sim(mulberry32(9), { map: 'miami' });
    expect(miami.road.ringLen).toBe(12000);
    expect(miami.traffic.ringLen).toBe(12000);
    expect(miami.score.ringLen).toBe(12000);
    expect(miami.player.s).toBe(300);
    expect(miami.player.vAlong * 3.6).toBeCloseTo(100);
    const showcase = new Sim(mulberry32(9), { map: 'miami', track: SHOWCASES[0].script });
    expect(showcase.road.ringLen).toBe(Infinity);
    expect(showcase.player.s).toBe(60);
    expect(showcase.player.vAlong * 3.6).toBeCloseTo(160);
  });
});

describe('Miami geometry', () => {
  const map = getMap('miami');
  const road = new Road(mulberry32(3), map.script);

  it('has two distinct gentle bends per centrally symmetric 6 km half and 120 chunks', () => {
    expect(map.script.sections.reduce((n, s) => n + s.chunks, 0)).toBe(120);
    expect(MIAMI_LEN).toBe(12000);
    expect(road.ringLen).toBe(12000);
    const curves = map.script.curves;
    expect(curves).toHaveLength(16);
    expect(curves.reduce((n, c) => n + c.len, 0)).toBe(12000);
    for (let half = 0; half < 2; half++) {
      const part = curves.slice(half * 8, half * 8 + 8);
      expect(part).toEqual(curves.slice(0, 8));
      expect(part.map(c => c.len)).toEqual([600, 400, 1500, 400, 300, 400, 2000, 400]);
      expect(part.reduce((n, c) => n + c.len * (c.k0 + c.k1) / 2, 0)).toBeCloseTo(Math.PI, 14);
    }
    const bends = curves.filter(c => c.k0 > 0 && c.k0 === c.k1);
    const radii = [...new Set(bends.map(c => 1 / c.k0))];
    expect(radii).toHaveLength(2);
    expect(radii[0]).toBeCloseTo(1500, 10);
    expect(radii[1]).toBeCloseTo(1280.050528255, 8);
    expect(1 / Math.max(...curves.map(c => Math.max(Math.abs(c.k0), Math.abs(c.k1))))).toBeGreaterThan(MIN_RADIUS);
    for (let i = 0; i < curves.length; i++) expect(curves[i].k1).toBe(curves[(i + 1) % curves.length].k0);
    expect(map.script).not.toEqual(ringScript());
  });

  it('returns independent mutable curvature steps for the repeated half and future scripts', () => {
    const a = miamiScript(), b = miamiScript();
    for (let i = 0; i < 8; i++) {
      expect(a.curves[i + 8]).toEqual(a.curves[i]);
      expect(a.curves[i + 8]).not.toBe(a.curves[i]);
      expect(b.curves[i]).not.toBe(a.curves[i]);
    }
  });

  it('composes the coastal sections without branches or overpasses', () => {
    expect(map.script.sections.map(s => [s.kind, s.chunks])).toEqual([
      ['open', 18], ['walls', 4], ['viaduct', 6], ['bridge', 16], ['viaduct', 6], ['open', 14],
      ['viaduct', 6], ['bridge', 8], ['viaduct', 6], ['open', 12], ['tunnel', 10], ['open', 14],
    ]);
    road.ensure(0, 12000);
    expect(road.chunks).toHaveLength(120);
    expect(road.chunks.some(c => c.overpass)).toBe(false);
  });

  it.each([
    [0, 'ocean-drive'], [2199, 'ocean-drive'], [2200, 'causeway'], [4999, 'causeway'],
    [5000, 'marina'], [8399, 'marina'], [8400, 'downtown'], [11999, 'downtown'],
  ] as const)('looks up district %s periodically on negative and future laps', (s, district) => {
    expect(miamiDistrict).toBeTypeOf('function');
    for (const lap of [-5, -1, 0, 1, 8]) expect(miamiDistrict(s + lap * 12000)).toBe(district);
  });

  it('closes naturally before the Road numerical closure correction', () => {
    const profile = new CurvatureProfile(mulberry32(1), 700, map.script.curves);
    let k0 = profile.next(SAMPLE_DS, 0), th = 0, x = 0, z = 0;
    for (let s = 0; s < 12000; s += SAMPLE_DS) {
      const k = profile.next(SAMPLE_DS, th);
      const next = th + (k0 + k) * SAMPLE_DS / 2;
      x += Math.sin((th + next) / 2) * SAMPLE_DS;
      z -= Math.cos((th + next) / 2) * SAMPLE_DS;
      th = next; k0 = k;
    }
    expect(th).toBeCloseTo(2 * Math.PI, 10);
    expect(Math.hypot(x, z)).toBeLessThan(1e-7);
  });

  it('repeats position/curvature on positive and negative laps, with a continuous seam', () => {
    for (const lap of [-5, -1, 0, 1, 8]) for (const s of [0, .5, 300, 599.5, 1000, 3000, 11999.5]) {
      const a = road.sample(s, point()), b = road.sample(s + lap * road.ringLen, point());
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-9);
      expect(b.k).toBe(a.k);
      expect(b.th - a.th).toBeCloseTo(lap * 2 * Math.PI, 9);
    }
    const a = road.sample(11999.5, point()), b = road.sample(12000.5, point());
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(1, 8);
    expect(Math.abs(a.k - b.k)).toBeLessThan(1 / (MIN_RADIUS * 400));
    expect(b.k).toBe(0);
    expect(road.curvature(12000)).toBe(road.curvature(0));
  });

  it('has no non-neighbor crossings or overlapping protected road envelopes', () => {
    // Use every 2 m integration segment, not a sparse set of chunk centers.
    const samples = Array.from({ length: 12000 / SAMPLE_DS + 1 }, (_, i) => road.sample(i * SAMPLE_DS, point()));
    const n = samples.length - 1, diameter = 2 * (WALL_D + 2);
    const crossings: number[][] = [], overlaps: number[][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const separation = Math.min(j - i, n - (j - i));
      if (separation <= 1) continue; // Shared endpoints, including the lap seam, are neighbors.
      const a = samples[i], b = samples[i + 1], c = samples[j], d = samples[j + 1];
      if (crosses(a, b, c, d)) crossings.push([i * SAMPLE_DS, j * SAMPLE_DS]);
      // A continuous road's local envelopes necessarily overlap. Check disjoint along-road spans.
      if (separation * SAMPLE_DS <= diameter + 2 * SAMPLE_DS) continue;
      if (Math.max(a.x, b.x) + diameter < Math.min(c.x, d.x) || Math.max(c.x, d.x) + diameter < Math.min(a.x, b.x)
        || Math.max(a.z, b.z) + diameter < Math.min(c.z, d.z) || Math.max(c.z, d.z) + diameter < Math.min(a.z, b.z)) continue;
      const distance = Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
        pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
      if (distance <= diameter) overlaps.push([i * SAMPLE_DS, j * SAMPLE_DS]);
    }
    expect(crossings).toEqual([]);
    expect(overlaps).toEqual([]);
  });

  it('puts the spawn on an open straight and enters/leaves every bridge via viaduct', () => {
    road.ensure(0, 12000);
    expect(road.curvature(map.spawn.s)).toBe(0);
    expect(road.chunkAt(map.spawn.s).kind).toBe('open');
    for (const c of road.chunks) if (c.kind === 'bridge') {
      expect(['bridge', 'viaduct']).toContain(c.prevKind);
      expect(['bridge', 'viaduct']).toContain(c.nextKind);
    }
  });
});

for (const id of ['highway', 'miami'] as const) describe(`${id} pad protection`, () => {
  it('preserves strict interval edges on any lap', () => {
    const map = getMap(id), p = map.spawn;
    for (const lap of [-4, 0, 3]) {
      const home = p.s + lap * 12000;
      for (const offset of [-11.999, 0, 29.999]) expect(isSpawnProtected(map, home + offset, p.d, 12000)).toBe(true);
      for (const offset of [-12, 30]) expect(isSpawnProtected(map, home + offset, p.d, 12000)).toBe(false);
      expect(isSpawnProtected(map, home, p.d - p.protectionInset, 12000)).toBe(true);
      expect(isSpawnProtected(map, home, p.d - p.protectionInset - .001, 12000)).toBe(false);
    }
  });
});
