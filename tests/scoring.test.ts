import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { laneCenter, trafficTune } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { VEHICLES } from '../src/sim/vehicles';
import { Sim } from '../src/sim/world';

const DT = 1 / 120;
const sedan = VEHICLES[0];
let density = 0;

/** Empty highway, player cruising at `kmh` in lane 1, scoring live. */
function setup(kmh: number) {
  const sim = new Sim(mulberry32(3));
  sim.traffic.clearAround(sim.player.s, 1e9);
  sim.player.reset(sim.player.s, laneCenter(1), kmh / 3.6);
  sim.score.grace = 0;
  const events: string[] = [];
  for (const type of ['nearMiss', 'laneSplit', 'crash', 'runEnd', 'comboEnd'] as const) {
    sim.events.on(type, () => events.push(type));
  }
  return { sim, events };
}

function drive(sim: Sim, seconds: number) {
  const input = { steer: 0, throttle: 0.6, brake: 0 };
  for (let i = 0; i < seconds / DT; i++) sim.step(DT, input);
}

describe('Scoring', () => {
  beforeEach(() => {
    density = trafficTune.density;
    trafficTune.density = 0;
  });
  afterEach(() => {
    trafficTune.density = density;
  });

  it('awards a near miss for a tight, fast pass', () => {
    const { sim, events } = setup(220);
    const p = sim.player;
    // Car ahead, offset so the lateral gap is ~0.4 m.
    const d = p.d + p.tune.width / 2 + sedan.wid / 2 + 0.4;
    const c = sim.traffic.spawnAt(sedan, p.s + 60, 2, 100 / 3.6, d)!;
    c.decisionT = 1e9;
    drive(sim, 4);
    expect(events).toContain('nearMiss');
    expect(sim.score.combo).toBe(1);
    expect(sim.score.score).toBeGreaterThan(150);
  });

  it('ignores a pass with a comfortable gap', () => {
    const { sim, events } = setup(220);
    const p = sim.player;
    const c = sim.traffic.spawnAt(sedan, p.s + 60, 2, 100 / 3.6)!;
    c.decisionT = 1e9;
    drive(sim, 4);
    expect(events).not.toContain('nearMiss');
  });

  it('gives a lane split bonus when threading between two cars', () => {
    const { sim, events } = setup(220);
    const p = sim.player;
    const off = p.tune.width / 2 + sedan.wid / 2 + 0.5;
    sim.traffic.spawnAt(sedan, p.s + 60, 0, 100 / 3.6, p.d - off)!.decisionT = 1e9;
    sim.traffic.spawnAt(sedan, p.s + 60, 2, 100 / 3.6, p.d + off)!.decisionT = 1e9;
    drive(sim, 4);
    expect(events).toContain('laneSplit');
    expect(events.filter((e) => e === 'nearMiss').length).toBe(2);
  });

  it('ends the run when the player hits a car', () => {
    const { sim, events } = setup(220);
    const p = sim.player;
    sim.score.score = 5000;
    sim.traffic.spawnAt(sedan, p.s + 60, 1, 90 / 3.6)!.decisionT = 1e9;
    drive(sim, 3);
    expect(events).toContain('crash');
    expect(events).toContain('runEnd');
    expect(sim.score.best).toBeGreaterThanOrEqual(5000);
    expect(sim.score.score).toBeLessThan(5000);
    expect(p.vAlong).toBeLessThan(220 / 3.6);
  });
});
