import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { OnlineWorld } from '../src/online/world';
import { laneCenter } from '../src/config';
import { MAX_TRAFFIC } from '../src/sim/traffic';
import { VEHICLES } from '../src/sim/vehicles';
import { Writer, Reader, MSG_SNAPSHOT, newSnapshot, readSnapshot } from '../src/online/protocol';

describe('server traffic and fan-out budgets', () => {
  it('spreads snapshots over ticks while preserving 30 Hz for every client', () => {
    const game = new GameServer({ seed: 7 });
    const counts = new Array(12).fill(0);
    let sentThisTick = 0;
    for (let i = 0; i < counts.length; i++) {
      const conn = game.connect({
        send(data) { if (typeof data !== 'string') { counts[i]++; sentThisTick++; } },
        close() {}, buffered: 0,
      });
      conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name: `B${i}`, physics: 1, car: 2, seq: 0 }));
    }
    for (let tick = 0; tick < 120; tick++) {
      sentThisTick = 0; game.tick(() => performance.now());
      expect(sentThisTick).toBe(3);
    }
    expect(counts).toEqual(new Array(12).fill(30));
    expect(game.timing.simulationMs).toBeGreaterThanOrEqual(0);
    expect(game.timing.snapshotMs).toBeGreaterThanOrEqual(0);
  });

  it('supports more than the old 106-car target and serializes the expanded client window', () => {
    const world = new OnlineWorld(4, { maxPlayers: 1 });
    world.configure({ mode: 'normal', modePerKm: { mode: 'normal', perKm: 80 } });
    expect(world.traffic.targetCount()).toBe(342);
    const dr = world.join('A', 1)!;
    world.traffic.clearAround(0, Infinity);
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      expect(world.traffic.spawnAt(VEHICLES[0], world.traffic.wrap(dr.car.s + i * 2), i % 4, 20)).not.toBeNull();
    }
    const w = new Writer(); world.writeSnapshot(dr, w);
    const reader = new Reader(w.bytes()); expect(reader.u8()).toBe(MSG_SNAPSHOT);
    const snapshot = newSnapshot(); expect(readSnapshot(reader, snapshot)).toBe(true);
    expect(snapshot.carCount).toBe(MAX_TRAFFIC);
    expect(new Set(snapshot.cars.slice(0, snapshot.carCount).map(c => c.id)).size).toBe(MAX_TRAFFIC);
    world.configure({ maxPlayers: 20 });
    expect(world.traffic.cars.length).toBeGreaterThan(3000);
    expect(world.traffic.activeCount).toBe(MAX_TRAFFIC);
  });

  it('migrates legacy multipliers without changing the old density, and zero can be raised again', () => {
    const world = new OnlineWorld(4);
    world.configure({ traffic: 2, intensity: .7, modeDensity: { normal: 2 } });
    const old = world.director.densityOf('normal');
    expect(old).toBeGreaterThan(0);
    world.configure({ densities: { normal: old } });
    world.configure({ traffic: 1, intensity: 0 });
    expect(world.director.densityOf('normal')).toBe(old);
    world.configure({ modePerKm: { mode: 'normal', perKm: 0 } });
    expect(world.traffic.targetCount()).toBe(0);
    world.configure({ modePerKm: { mode: 'normal', perKm: 80 } });
    expect(world.traffic.targetCount()).toBe(342);
    world.configure({ modePerKm: { mode: 'normal', perKm: Infinity } });
    expect(world.traffic.targetCount()).toBe(342);
  });

  it('can populate substantially more than the old limit with real spawn clearances', () => {
    const world = new OnlineWorld(5, { maxPlayers: 1 });
    world.configure({ mode: 'normal', modePerKm: { mode: 'normal', perKm: 80 } });
    const dr = world.join('A', 1)!;
    dr.car.d = laneCenter(3) + 5;
    expect(world.traffic.activeCount).toBeGreaterThan(106);
  });
});
