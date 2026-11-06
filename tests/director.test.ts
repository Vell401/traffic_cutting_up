import { describe, expect, it } from 'vitest';
import { LANES, laneCenter } from '../src/config';
import { Emitter } from '../src/core/events';
import { mulberry32 } from '../src/core/rng';
import { Director, RAMP_DIST } from '../src/sim/director';
import type { SimEvents } from '../src/sim/events';
import { Sim } from '../src/sim/world';

describe('Director', () => {
  it('starts calm, then cycles through modes without repeating one back to back', () => {
    const events = new Emitter<SimEvents>();
    const seen: string[] = [];
    events.on('trafficMode', (e) => seen.push(e.mode));
    const d = new Director(mulberry32(5), events);
    expect(d.mode).toBe('normal');
    for (let i = 0; i < 40_000; i++) d.step(1);
    expect(seen.length).toBeGreaterThan(15);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(5);
  });

  it('ramps difficulty with run distance and resets on a crash', () => {
    const sim = new Sim(mulberry32(2));
    const d = sim.director;
    d.setMode('normal', 1e9);
    const calm = d.density();
    d.step(RAMP_DIST / 2);
    expect(d.intensity).toBeCloseTo(0.5);
    d.step(RAMP_DIST);
    expect(d.intensity).toBe(1);
    expect(d.density()).toBeGreaterThan(calm * 1.7);
    sim.score.grace = 0;
    sim.score.onCrash();
    expect(d.intensity).toBe(0);
  });

  it('spawns a wall: three vehicles abreast with exactly one lane open', () => {
    const sim = new Sim(mulberry32(9));
    const p = sim.player;
    sim.traffic.clearAround(p.s, 1e9);
    expect(sim.traffic.spawnWall(p.s + 300, p)).toBe(true);
    const cars = sim.traffic.cars.filter((c) => c.active);
    expect(cars.length).toBe(3);
    const lanes = new Set(cars.map((c) => c.lane));
    expect(lanes.size).toBe(3);
    for (const c of cars) {
      expect(Math.abs(c.s - (p.s + 300))).toBeLessThan(1.6);
      expect(c.v).toBe(cars[0].v);
      expect(c.decisionT).toBeGreaterThan(6); // holds formation until we arrive
    }
    const open = [...Array(LANES).keys()].filter((l) => !lanes.has(l));
    expect(open.length).toBe(1);
    expect(cars.every((c) => Math.abs(c.d - laneCenter(open[0])) > 3)).toBe(true);
  });

  it('spawns a platoon: cars nose to tail in one lane with a short headway', () => {
    const sim = new Sim(mulberry32(4));
    const p = sim.player;
    sim.traffic.clearAround(p.s, 1e9);
    expect(sim.traffic.spawnPlatoon(p.s + 300, p)).toBe(true);
    const cars = sim.traffic.cars.filter((c) => c.active).sort((a, b) => a.s - b.s);
    expect(cars.length).toBeGreaterThanOrEqual(3);
    expect(new Set(cars.map((c) => c.lane)).size).toBe(1);
    for (let i = 1; i < cars.length; i++) {
      const gap = cars[i].s - cars[i - 1].s - (cars[i].spec.len + cars[i - 1].spec.len) / 2;
      expect(gap).toBeGreaterThan(8);
      expect(gap).toBeLessThan(15);
      expect(cars[i].tGap).toBeLessThan(1);
    }
  });

  it('keeps a healthy amount of traffic on the road while driving', () => {
    const sim = new Sim(mulberry32(11));
    const input = { steer: 0, throttle: 0, brake: 0 };
    sim.score.grace = Infinity;
    for (let i = 0; i < 120 * 30; i++) sim.step(1 / 120, input);
    expect(sim.traffic.activeCount).toBeGreaterThan(sim.traffic.targetCount() * 0.6);
  });

  it('dense preset fills the road with more, closer traffic', () => {
    const normal = new Sim(mulberry32(9));
    const dense = new Sim(mulberry32(9));
    dense.director.preset = 2;
    normal.director.setMode('normal', 1e9);
    dense.director.setMode('normal', 1e9);
    expect(dense.director.density()).toBeCloseTo(normal.director.density() * 1.7);
    expect(dense.director.timeGap()).toBeLessThan(normal.director.timeGap());
    normal.traffic.reset(normal.player);
    dense.traffic.reset(dense.player);
    expect(dense.traffic.activeCount).toBeGreaterThan(normal.traffic.activeCount * 1.4);
    // Even at peak difficulty in heavy traffic the pool never runs dry.
    dense.director.step(1e6);
    dense.director.setMode('dense', 1e9);
    expect(dense.traffic.targetCount()).toBeLessThanOrEqual(dense.traffic.cars.length - 6);
  });
});
