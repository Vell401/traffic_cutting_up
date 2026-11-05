import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { CHUNK_LEN, CHUNK_SAMPLES, MIN_RADIUS, Road, SAMPLE_DS } from '../src/sim/road';

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
});
