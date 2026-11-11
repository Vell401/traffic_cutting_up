import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { Sim } from '../src/sim/world';
import { WRECK_LIFETIME } from '../src/sim/traffic';
import { VEHICLES } from '../src/sim/vehicles';

describe('wreck cleanup', () => {
  for (const online of [false, true]) {
    it(`clears a wreck at ten seconds even beside a player (${online ? 'ring' : 'solo'})`, () => {
      const sim = new Sim(mulberry32(8), { online });
      const traffic = sim.traffic;
      traffic.clearAround(sim.player.s, Infinity);
      traffic.enabled = false;
      const wreck = traffic.spawnAt(VEHICLES[0], sim.player.s + 5, 1, 0)!;
      wreck.crashed = true;
      wreck.crashT = WRECK_LIFETIME - .02;
      traffic.step(.01, sim.player);
      expect(wreck.active).toBe(true);
      traffic.step(.011, sim.player);
      expect(wreck.active).toBe(false);
      expect(traffic.activeCount).toBe(0);
    });
  }

  it('does not clear an undamaged car because its old crash timer was nonzero', () => {
    const sim = new Sim(mulberry32(8));
    sim.traffic.clearAround(sim.player.s, Infinity);
    sim.traffic.enabled = false;
    const car = sim.traffic.spawnAt(VEHICLES[0], sim.player.s + 30, 1, 20)!;
    car.crashT = 100;
    sim.traffic.step(.1, sim.player);
    expect(car.active).toBe(true);
  });
});
