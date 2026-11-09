import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { getMap, resolveMap, isSpawnProtected } from '../src/sim/maps';
import { ringScript, spawnS, SPAWN_D } from '../src/sim/ring';
import { Road, CurvatureProfile, MIN_RADIUS, SAMPLE_DS } from '../src/sim/road';
import { Sim } from '../src/sim/world';
import { SHOWCASES } from '../src/sim/testTrack';

const point = () => ({ x: 0, z: 0, th: 0, k: 0 });

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

  it('has four identical 3 km 90-degree profiles and 120 section chunks', () => {
    expect(map.script.sections.reduce((n, s) => n + s.chunks, 0)).toBe(120);
    const curves = map.script.curves;
    expect(curves).toHaveLength(16);
    for (let q = 0; q < 4; q++) {
      const part = curves.slice(q * 4, q * 4 + 4);
      expect(part).toEqual(curves.slice(0, 4));
      expect(part.map(c => c.len)).toEqual([600, 400, 1600, 400]);
      expect(part.reduce((n, c) => n + c.len * (c.k0 + c.k1) / 2, 0)).toBeCloseTo(Math.PI / 2, 14);
    }
    expect(1 / Math.max(...curves.map(c => Math.max(c.k0, c.k1)))).toBeGreaterThan(MIN_RADIUS);
    expect(map.script).not.toEqual(ringScript());
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
