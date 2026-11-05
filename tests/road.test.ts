import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { CHUNK_LEN, CHUNK_SAMPLES, GROUND_LEVEL, MIN_RADIUS, Road, SAMPLE_DS } from '../src/sim/road';

describe('Road', () => {
  const road = new Road(mulberry32(7));
  road.ensure(0, 60_000);

  it('only has gentle highway curves', () => {
    let maxK = 0;
    for (const c of road.chunks) for (let i = 0; i <= CHUNK_SAMPLES; i++) maxK = Math.max(maxK, Math.abs(c.k[i]));
    expect(maxK).toBeLessThanOrEqual(1 / MIN_RADIUS + 1e-9);
    expect(maxK).toBeGreaterThan(0); // and it does curve somewhere in 60 km
  });

  it('is continuous across chunks with a 2 m step', () => {
    for (let n = 1; n < road.chunks.length; n++) {
      const a = road.chunks[n - 1];
      const b = road.chunks[n];
      expect(b.index).toBe(a.index + 1);
      expect(b.x[0]).toBe(a.x[CHUNK_SAMPLES]);
      expect(b.z[0]).toBe(a.z[CHUNK_SAMPLES]);
      expect(b.th[0]).toBe(a.th[CHUNK_SAMPLES]);
    }
    const c = road.chunks[10];
    for (let i = 1; i <= CHUNK_SAMPLES; i++) {
      expect(Math.hypot(c.x[i] - c.x[i - 1], c.z[i] - c.z[i - 1])).toBeCloseTo(SAMPLE_DS, 3);
    }
  });

  it('keeps its general direction', () => {
    for (const c of road.chunks) expect(Math.abs(c.th[0])).toBeLessThan(1.6);
  });

  it('maps (s, d) to points d metres from the centre line', () => {
    const p0 = { x: 0, z: 0, th: 0, k: 0 };
    const p1 = { x: 0, z: 0, th: 0, k: 0 };
    for (const s of [1234.5, 20_001, 47_777.7]) {
      road.sample(s, p0);
      road.toWorld(s, -5.5, p1);
      expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeCloseTo(5.5, 6);
    }
  });

  it('drops chunks behind and keeps generating ahead', () => {
    const r = new Road(mulberry32(1));
    r.ensure(0, 2000);
    r.ensure(5000, 9000);
    expect(r.chunks[0].index).toBe(Math.floor(5000 / CHUNK_LEN) - 1);
    expect(r.sEnd).toBeGreaterThanOrEqual(9000);
  });

  it('alternates sections and never jumps from a viaduct straight into a tunnel', () => {
    const seen = new Set<string>();
    for (const c of road.chunks) {
      seen.add(c.kind);
      if (c.kind === 'tunnel') expect(c.prevKind).not.toBe('viaduct');
      if (c.kind === 'viaduct') expect(c.prevKind).not.toBe('tunnel');
    }
    expect([...seen].sort()).toEqual(['open', 'tunnel', 'viaduct', 'walls']);
    expect(road.chunks.slice(0, 8).every((c) => c.kind === 'open')).toBe(true);
  });

  it('links neighbouring chunk kinds', () => {
    for (let n = 1; n < road.chunks.length; n++) {
      expect(road.chunks[n].prevKind).toBe(road.chunks[n - 1].kind);
      expect(road.chunks[n - 1].nextKind).toBe(road.chunks[n].kind);
    }
  });

  it('blends ground height smoothly across section boundaries', () => {
    let prev = road.groundY(road.sStart);
    let maxStep = 0;
    for (let s = road.sStart; s < road.sEnd - CHUNK_LEN; s += 1) {
      const y = road.groundY(s);
      maxStep = Math.max(maxStep, Math.abs(y - prev));
      prev = y;
    }
    // 23 m of height change over a 120 m blend is at most ~0.3 m per metre.
    expect(maxStep).toBeLessThan(0.35);
    const mid = road.chunks.find((c) => c.kind === 'viaduct' && c.prevKind === 'viaduct' && c.nextKind === 'viaduct')!;
    expect(road.groundY(mid.s0 + 50)).toBe(GROUND_LEVEL.viaduct);
  });

  it('places gantries and overpasses only inside stable sections', () => {
    let gantries = 0;
    let overpasses = 0;
    for (const c of road.chunks) {
      if (c.gantry || c.overpass) {
        expect(c.prevKind).toBe(c.kind);
        expect(c.nextKind).toBe(c.kind);
        expect(c.kind).not.toBe('tunnel');
      }
      if (c.overpass) expect(c.kind).toBe('open');
      gantries += +c.gantry;
      overpasses += +c.overpass;
    }
    expect(gantries).toBeGreaterThan(5);
    expect(overpasses).toBeGreaterThan(5);
  });
});
