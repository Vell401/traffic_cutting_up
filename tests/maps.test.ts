import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { getMap, resolveMap, isSpawnProtected } from '../src/sim/maps';
import { MIAMI_CHUNKS, MIAMI_LEN, miamiDistrict, miamiScript, miamiZone } from '../src/sim/miami';
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
    expect(miami.road.ringLen).toBe(30000);
    expect(miami.traffic.ringLen).toBe(30000);
    expect(miami.score.ringLen).toBe(30000);
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
  const HALF = MIAMI_LEN / 2;

  it('is a 30 km lap of two identical halves, each turning exactly half a circle on gentle radii', () => {
    expect(MIAMI_LEN).toBe(30000);
    expect(MIAMI_CHUNKS).toBe(300);
    expect(map.revision).toBe(3);
    expect(map.script.sections.reduce((n, s) => n + s.chunks, 0)).toBe(300);
    expect(road.ringLen).toBe(30000);
    const curves = map.script.curves;
    expect(curves.length % 2).toBe(0);
    expect(curves.reduce((n, c) => n + c.len, 0)).toBe(30000);
    const half = curves.length / 2;
    for (let h = 0; h < 2; h++) {
      const part = curves.slice(h * half, h * half + half);
      expect(part).toEqual(curves.slice(0, half));
      expect(part.reduce((n, c) => n + c.len, 0)).toBe(HALF);
      expect(part.reduce((n, c) => n + c.len * (c.k0 + c.k1) / 2, 0)).toBeCloseTo(Math.PI, 12);
    }
    // Whole 2 m samples everywhere: the integrated heading is exact.
    for (const c of curves) { expect(c.len).toBeGreaterThan(0); expect(c.len % SAMPLE_DS).toBe(0); }
    for (let i = 0; i < curves.length; i++) expect(curves[i].k1).toBe(curves[(i + 1) % curves.length].k0);
    expect(1 / Math.max(...curves.map(c => Math.max(Math.abs(c.k0), Math.abs(c.k1))))).toBeGreaterThan(MIN_RADIUS);
    // Not an oval: sweepers both ways, and real straights between them.
    expect(curves.some(c => c.k0 > 0 && c.k0 === c.k1)).toBe(true);
    expect(curves.some(c => c.k0 < 0 && c.k0 === c.k1)).toBe(true);
    expect(curves.filter(c => c.k0 === 0 && c.k1 === 0 && c.len >= 400).length).toBeGreaterThanOrEqual(8);
    expect(map.script).not.toEqual(ringScript());
  });

  it('returns independent mutable curvature steps for the repeated half and future scripts', () => {
    const a = miamiScript(), b = miamiScript();
    const half = a.curves.length / 2;
    for (let i = 0; i < half; i++) {
      expect(a.curves[i + half]).toEqual(a.curves[i]);
      expect(a.curves[i + half]).not.toBe(a.curves[i]);
      expect(b.curves[i]).not.toBe(a.curves[i]);
    }
    expect(b.sections).toEqual(a.sections);
    expect(b.sections[0]).not.toBe(a.sections[0]);
  });

  it('tours eleven districts over every kind of section, with gantries and overpasses only on open road', () => {
    road.ensure(0, MIAMI_LEN);
    expect(road.chunks).toHaveLength(300);
    const districts = new Set<string>(), kinds = new Set<string>();
    for (const c of road.chunks) {
      const zone = miamiZone(c.index);
      districts.add(zone.district); kinds.add(c.kind);
      expect(zone.kind).toBe(c.kind);
      expect(zone.gantry).toBe(c.gantry);
      expect(zone.overpass).toBe(c.overpass);
      if (c.gantry || c.overpass) expect(c.kind).toBe('open');
      expect(zone.index).toBe(c.sectionIndex);
      expect(zone.length).toBe(c.sectionLen);
      expect(zone.run).toBeLessThan(zone.runLength);
    }
    expect([...districts].sort()).toEqual(['bayfront', 'bear-cut', 'downtown', 'gables', 'grove', 'key-biscayne', 'macarthur', 'rickenbacker', 'south-beach', 'watson', 'wynwood']);
    expect([...kinds].sort()).toEqual(['bridge', 'open', 'tunnel', 'viaduct', 'walls']);
    expect(road.chunks.filter(c => c.overpass).length).toBeGreaterThanOrEqual(4);
    expect(road.chunks.filter(c => c.kind === 'tunnel').length).toBe(20);
    expect(road.chunks.filter(c => c.kind === 'bridge').length).toBe(42);
  });

  it.each([
    [0, 'south-beach'], [2999, 'south-beach'], [3000, 'macarthur'], [5100, 'watson'], [5700, 'macarthur'],
    [7300, 'downtown'], [11099, 'downtown'], [11100, 'wynwood'], [14100, 'grove'], [16900, 'rickenbacker'],
    [19900, 'key-biscayne'], [22900, 'bear-cut'], [24300, 'gables'], [26900, 'bayfront'], [29999, 'bayfront'],
  ] as const)('looks up district %s periodically on negative and future laps', (s, district) => {
    for (const lap of [-5, -1, 0, 1, 8]) {
      expect(miamiDistrict(s + lap * MIAMI_LEN)).toBe(district);
      expect(miamiZone(Math.floor(s / 100) + lap * MIAMI_CHUNKS)).toBe(miamiZone(Math.floor(s / 100)));
    }
  });

  it('closes naturally before the Road numerical closure correction', () => {
    const profile = new CurvatureProfile(mulberry32(1), 700, map.script.curves);
    let k0 = profile.next(SAMPLE_DS, 0), th = 0, x = 0, z = 0;
    for (let s = 0; s < MIAMI_LEN; s += SAMPLE_DS) {
      const k = profile.next(SAMPLE_DS, th);
      const next = th + (k0 + k) * SAMPLE_DS / 2;
      x += Math.sin((th + next) / 2) * SAMPLE_DS;
      z -= Math.cos((th + next) / 2) * SAMPLE_DS;
      th = next; k0 = k;
    }
    expect(th).toBeCloseTo(2 * Math.PI, 9);
    expect(Math.hypot(x, z)).toBeLessThan(1e-6);
  });

  it('repeats position/curvature on positive and negative laps, with a continuous seam', () => {
    for (const lap of [-5, -1, 0, 1, 8]) for (const s of [0, .5, 300, 699.5, 1000, 3000, 15000, 22222, 29999.5]) {
      const a = road.sample(s, point()), b = road.sample(s + lap * road.ringLen, point());
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-9);
      expect(b.k).toBe(a.k);
      expect(b.th - a.th).toBeCloseTo(lap * 2 * Math.PI, 9);
    }
    const a = road.sample(29999.5, point()), b = road.sample(30000.5, point());
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(1, 8);
    expect(a.k).toBe(0);
    expect(b.k).toBe(0);
    expect(road.curvature(30000)).toBe(road.curvature(0));
  });

  it('has no non-neighbor crossings and keeps distant parts of the lap far apart', () => {
    // Every 2 m integration segment, bucketed on a 200 m grid so the search stays linear.
    const samples = Array.from({ length: MIAMI_LEN / SAMPLE_DS + 1 }, (_, i) => road.sample(i * SAMPLE_DS, point()));
    const n = samples.length - 1, cell = 200;
    const grid = new Map<string, number[]>();
    const key = (p: Point, dx = 0, dz = 0) => [Math.floor(p.x / cell) + dx, Math.floor(p.z / cell) + dz].join();
    for (let i = 0; i < n; i++) {
      const bucket = grid.get(key(samples[i]));
      if (bucket) bucket.push(i); else grid.set(key(samples[i]), [i]);
    }
    const crossings: number[][] = [];
    let nearest = Infinity;
    for (let i = 0; i < n; i++) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const j of grid.get(key(samples[i], dx, dz)) ?? []) {
        if (j <= i) continue;
        const separation = Math.min(j - i, n - (j - i));
        if (separation <= 1) continue; // Shared endpoints, including the lap seam, are neighbors.
        const a = samples[i], b = samples[i + 1], c = samples[j], d = samples[j + 1];
        if (crosses(a, b, c, d)) crossings.push([i * SAMPLE_DS, j * SAMPLE_DS]);
        // Parts of the lap more than 1 km apart along the road never come within 200 m of each other.
        if (separation * SAMPLE_DS > 1000) nearest = Math.min(nearest, pointSegmentDistance(a, c, d));
      }
    }
    expect(crossings).toEqual([]);
    expect(nearest).toBeGreaterThan(200);
  });

  it('puts the spawn on an open straight and enters/leaves every bridge via viaduct', () => {
    road.ensure(0, MIAMI_LEN);
    expect(road.curvature(map.spawn.s)).toBe(0);
    expect(road.chunkAt(map.spawn.s).kind).toBe('open');
    expect(miamiDistrict(map.spawn.s)).toBe('south-beach');
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
