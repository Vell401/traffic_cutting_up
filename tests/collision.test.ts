import { describe, expect, it } from 'vitest';
import { obbOverlap, type Contact } from '../src/sim/collision';

const box = (x: number, y: number, rot = 0) => ({ x, y, hx: 2.3, hy: 0.95, rot });
const out: Contact = { nx: 0, ny: 0, depth: 0 };

describe('obbOverlap', () => {
  it('detects a rear-end overlap and points the normal from A to B', () => {
    expect(obbOverlap(box(0, 0), box(4.4, 0.3), out)).toBe(true);
    expect(out.nx).toBeCloseTo(1);
    expect(out.depth).toBeCloseTo(0.2);
  });

  it('separates side-by-side cars with a gap', () => {
    expect(obbOverlap(box(0, 0), box(1, 1.95), out)).toBe(false);
    expect(obbOverlap(box(0, 0), box(1, 1.85), out)).toBe(true);
    expect(out.ny).toBeCloseTo(1);
  });

  it('accounts for rotation', () => {
    // A car turned 90° is 4.6 m wide across the road.
    expect(obbOverlap(box(0, 0, Math.PI / 2), box(0, 3.1), out)).toBe(true);
    expect(obbOverlap(box(0, 0), box(0, 3.1), out)).toBe(false);
  });
});
