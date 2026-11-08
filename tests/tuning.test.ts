import { afterEach, describe, expect, it } from 'vitest';
import { applyTuning, currentTuning, defaultTuning, validateTuning } from '../src/sim/tuning';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { OnlineWorld, replay, type Stimulus } from '../src/online/world';
import { MercedesCar } from '../src/sim/vehicleMercedes';
import { PlayerCar } from '../src/sim/vehicle';
import { laneCenter } from '../src/config';
import { VEHICLES } from '../src/sim/vehicles';
import { ClientCore } from '../src/online/clientCore';
import { Sim } from '../src/sim/world';

afterEach(() => applyTuning(defaultTuning()));

describe('global tuning defaults and validation', () => {
  it('keeps the current published tune as an independent resettable baseline', () => {
    const defaults = defaultTuning();
    expect(defaults.cars['3']).toMatchObject({ powerKW: 495, mass: 1605, brakeDecel: 14.6 });
    expect(defaults.cars['4']).toMatchObject({ powerKW: 386, mass: 1450, brakeDecel: 15.8 });
    expect(defaults.traffic.lanes[0]).toEqual([112, 132]);
    const existing = new MercedesCar();
    const next = defaultTuning(); next.cars['3'].powerKW = 600; next.cars['3'].brakeDecel = 20;
    applyTuning(next);
    expect(existing.tune.powerKW).toBe(600); expect(new MercedesCar().tune.brakeDecel).toBe(20);
    expect(defaultTuning()).toEqual(defaults);
    applyTuning(defaultTuning()); expect(existing.tune.powerKW).toBe(495);
  });
  it('rejects invalid, incomplete and prototype-changing data atomically', () => {
    const before = currentTuning();
    for (const n of [Infinity, NaN, -1, 20000]) {
      const next = defaultTuning(); next.cars['3'].powerKW = n;
      expect(() => applyTuning(next)).toThrow(); expect(currentTuning()).toEqual(before);
    }
    const invalid = defaultTuning(); invalid.traffic.lanes[0] = [150, 100];
    expect(() => validateTuning(invalid)).toThrow();
    const polluted = JSON.parse(JSON.stringify(defaultTuning()));
    Object.defineProperty(polluted.cars, '__proto__', { value: { bad: true }, enumerable: true });
    expect(() => validateTuning(polluted)).toThrow(); expect(({} as { bad?: boolean }).bad).toBeUndefined();
    expect(() => validateTuning({ cars: {}, traffic: defaultTuning().traffic })).toThrow();
  });
});

describe('live authoritative settings', () => {
  it('sends settings in welcome, broadcasts changes and starts a new prediction epoch without moving the car', () => {
    const game = new GameServer({ seed: 5 }), got: string[] = [];
    const peer = game.connect({ send(d) { if (typeof d === 'string') got.push(d); }, close() {}, buffered: 0 });
    const hash = rulesHash();
    peer.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: hash, name: 'A', physics: 3, car: 3, seq: 0 }));
    expect(JSON.parse(got.find(t => t.includes('"welcome"'))!).tuning).toEqual(defaultTuning());
    const dr = game.world.drivers[0], epoch = dr.epoch, s = dr.car.s;
    dr.push(1, { steer: 0, throttle: 255, brake: 0, flags: 0 }); dr.lastQueued = 1;
    const next = defaultTuning(); next.cars['3'].powerKW = 700; game.setTuning(next);
    expect(dr.epoch).toBe(epoch + 1); expect(dr.queued).toBe(0); expect(dr.car.s).toBe(s);
    expect(JSON.parse(got.at(-1)!).tuning.cars['3'].powerKW).toBe(700);
    expect(rulesHash()).toBe(hash);
    const sim = new Sim(Math.random, { online: true, physics: 3 });
    const core = new ClientCore(sim, { send() {} }); core.ready = true;
    core.receive(got.at(-1)!, 0);
    expect(core.ready).toBe(false); expect(sim.player.tune.powerKW).toBe(700);
  });
  it('changes existing traffic targets smoothly and preserves common speeds within a wall', () => {
    const world = new OnlineWorld(7), player = new PlayerCar(); player.s = 0;
    world.traffic.setDrivers(player);
    const c = world.traffic.spawnAt(VEHICLES[0], 300, 0, 30, laneCenter(0))!;
    expect(world.traffic.spawnWall(500, player)).toBe(true);
    const wall = world.traffic.cars.filter(c => c.active && c.wall);
    const next = defaultTuning(); next.traffic.lanes = [[45,45],[40,40],[35,35],[30,30]]; next.traffic.wallMin = next.traffic.wallMax = 50;
    world.setTuning(next);
    expect(c.v).toBe(30); expect(c.v0).toBe(45 / 3.6);
    expect(new Set(wall.map(c => c.v0))).toEqual(new Set([50 / 3.6]));
  });
  it('records tuning changes and replays them with the same epochs and traffic', () => {
    const journal: Stimulus[] = [], world = new OnlineWorld(9); world.journal = s => journal.push(s);
    const dr = world.join('A', 3, 3)!;
    for (let i = 1; i <= 120; i++) {
      world.input(dr, i, [{ steer: 0, throttle: 180, brake: 0, flags: 0 }], 1);
      if (i === 60) { const next = defaultTuning(); next.cars['3'].powerKW = 600; world.setTuning(next); }
      world.step();
    }
    const hash = world.hash();
    expect(replay(9, {}, journal, world.tick).hash()).toBe(hash);
  });
});
