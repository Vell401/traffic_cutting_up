import { describe, expect, it } from 'vitest';
import { LANE_W, LANES, ROAD_HALF, SHOULDER, WALL_D, laneCenter } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { GLARE_FLOOR, GLARE_REFERENCE, beamGap, beamScale } from '../src/render/headlightGlare';
import { Sim } from '../src/sim/world';

describe('road cross-section', () => {
  it('has four standard 3.75 m lanes and a 2.5 m shoulder each side inside the barriers', () => {
    expect(LANES).toBe(4);
    expect(LANE_W).toBe(3.75);
    expect(ROAD_HALF).toBe(7.5);
    expect(SHOULDER).toBe(2.5);
    expect(WALL_D).toBe(10);
    expect([0, 1, 2, 3].map(laneCenter)).toEqual([-5.625, -1.875, 1.875, 5.625]);
  });
});

describe('headlight anti-glare', () => {
  it('leaves a clear beam alone and holds the light on a near car at its reference level', () => {
    expect(beamScale(Infinity)).toBe(1);
    expect(beamScale(GLARE_REFERENCE)).toBe(1);
    expect(beamScale(GLARE_REFERENCE + 30)).toBe(1);
    // Inverse-square light times this scale is constant inside the reference distance.
    for (const gap of [3, 6, 9, 12, 17]) {
      expect(beamScale(gap) / (gap * gap)).toBeCloseTo(1 / (GLARE_REFERENCE * GLARE_REFERENCE), 12);
    }
    // Monotonic, never dark, never brighter than full.
    let previous = 0;
    for (let gap = 0; gap <= 40; gap += 0.25) {
      const k = beamScale(gap);
      expect(k).toBeGreaterThanOrEqual(GLARE_FLOOR);
      expect(k).toBeLessThanOrEqual(1);
      expect(k).toBeGreaterThanOrEqual(previous);
      previous = k;
    }
    expect(beamScale(0)).toBe(GLARE_FLOOR);
    // The brighter high beam backs off from farther away.
    expect(beamScale(25, 30)).toBeLessThan(1);
    expect(beamScale(25)).toBe(1);
  });

  it('measures the nearest car inside the beam: ahead and in line, not behind or lanes away', () => {
    const sim = new Sim(mulberry32(5), { map: 'miami' });
    for (const car of sim.traffic.cars) car.active = false;
    const lane = laneCenter(2);
    const nose = 2.2;
    expect(beamGap(sim, 1000, lane, nose)).toBe(Infinity);
    const lead = sim.traffic.cars[0];
    lead.active = true; lead.s = 1000 + nose + lead.spec.len / 2 + 6; lead.d = lane;
    expect(beamGap(sim, 1000, lane, nose)).toBeCloseTo(6, 9);
    // The other headlamp, 1.2 m to the side, still has that car's tail in front of it.
    expect(beamGap(sim, 1000, lane + 1.2, nose)).toBeLessThan(6.5);
    // Two lanes over, at the same distance: outside the beam.
    lead.d = laneCenter(0);
    expect(beamGap(sim, 1000, lane, nose)).toBe(Infinity);
    // ...but far enough ahead the spreading beam reaches it.
    lead.s = 1000 + 30;
    expect(beamGap(sim, 1000, lane, nose)).toBeGreaterThan(20);
    expect(beamGap(sim, 1000, lane, nose)).toBeLessThan(40);
    // Behind us, or beyond the look-ahead: nothing.
    lead.d = lane; lead.s = 1000 - 12;
    expect(beamGap(sim, 1000, lane, nose)).toBe(Infinity);
    lead.s = 1000 + 150;
    expect(beamGap(sim, 1000, lane, nose)).toBe(Infinity);
    // The nearest of several wins, and the lap seam is no obstacle.
    const second = sim.traffic.cars[1];
    second.active = true; second.d = lane; second.s = 5 + nose + second.spec.len / 2;
    lead.s = 40;
    expect(beamGap(sim, sim.road.ringLen - 3, lane, nose)).toBeCloseTo(8, 9);
  });
});
