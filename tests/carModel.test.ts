import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAINT, SHELL, TRIM, r34Geometry } from '../src/render/car/r34';
import * as S from '../src/render/car/r34Shape';
import { caliper, sportRim, sportTyre } from '../src/render/car/wheels';

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('R34 model', () => {
  const geo = r34Geometry();

  it('builds finite geometry with unit normals', () => {
    for (const part of geo.parts) {
      const p = part.getAttribute('position').array;
      const n = part.getAttribute('normal').array;
      for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true);
      for (let i = 0; i < n.length; i += 3) expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 2);
    }
  });

  it('keeps the real proportions', () => {
    const body = geo.parts[PAINT].clone();
    body.computeBoundingBox();
    const b = body.boundingBox!;
    // Length to the wing tips and bumpers, width to the mirrors, roof height.
    expect(b.max.z - b.min.z).toBeGreaterThan(4.55);
    expect(b.max.z - b.min.z).toBeLessThan(4.65);
    expect(b.max.x).toBeLessThan(1.07);
    expect(b.max.y).toBeGreaterThan(1.33);
    expect(b.max.y).toBeLessThan(1.37);
    const under = geo.parts[TRIM].clone();
    under.computeBoundingBox();
    expect(under.boundingBox!.min.y).toBeGreaterThan(0.12);
  });

  it('stands the greenhouse on the body: it starts and ends on the hood and the deck', () => {
    for (const f of [S.F_WS, S.F_RW]) {
      expect(S.roofY(f)).toBeCloseTo(S.yTop(f), 9);
      expect(S.railY(f)).toBeCloseTo(S.baseY(f), 9);
      expect(S.railX(f)).toBeCloseTo(S.baseX(f), 9);
    }
    // The roof crown continues the hood crown, so the windshield base meets the hood exactly.
    for (const q of [0, 0.3, 0.7, 1]) {
      const x = S.baseX(S.F_WS) * (1 - q);
      expect(S.screenY(S.F_WS, x)).toBeCloseTo(S.topY(S.F_WS, x), 6);
    }
  });

  it('clears the wheels: arches above the tyres, wells inside the body', () => {
    for (const f of S.AXLES) {
      expect(S.archTop(f)).toBeGreaterThan(2 * S.WHEEL_R + 0.03);
      expect(S.sideX(f, 0.4)).toBeGreaterThan(S.TRACK_HALF[0] + S.TYRE_W / 2);
      expect(S.W_IN).toBeLessThan(S.TRACK_HALF[0] - S.TYRE_W / 2);
    }
  });

  it('sees out of the cockpit: the eye is under the roof and behind the windshield', () => {
    expect(S.EYE.y).toBeLessThan(S.screenY(S.EYE.f, S.EYE.x) - 0.15);
    expect(S.EYE.f).toBeLessThan(-0.3);
    expect(S.WHEEL.f).toBeGreaterThan(S.EYE.f + 0.45);
  });

  it('stays within a polygon budget', () => {
    let exterior = 0;
    geo.parts.forEach((g, i) => {
      if (i !== SHELL) exterior += tris(g);
    });
    const wheel = tris(sportTyre(S.WHEEL_R, S.TYRE_W, 0.2286)) + tris(sportRim(0.2286, S.TYRE_W)) + tris(caliper());
    expect(exterior).toBeLessThan(30000);
    expect(wheel * 4).toBeLessThan(12000);
  });
});
