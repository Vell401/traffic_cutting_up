import { describe, expect, it, vi } from 'vitest';
import { Store, type RunMode } from '../server/store';
import { ReferenceWriter, assertSnapshotEquivalence, makeServerFixture } from '../scripts/serverPerfcheck';
import { MSG_SNAPSHOT, Reader, Writer, newSnapshot, readSnapshot, writeCar } from '../src/online/protocol';
import { OnlineWorld, replay, type Stimulus } from '../src/online/world';
import type { MapId } from '../src/sim/maps';
import type { PhysicsId } from '../src/sim/physics';
import { TrafficCar } from '../src/sim/traffic';
import { VEHICLES } from '../src/sim/vehicles';

describe('bounded traffic-record serialization optimization', () => {
  it('reduces capacity checks from sixteen to one without adding a record allocation', () => {
    const current = new Writer(32), reference = new ReferenceWriter(32);
    const currentRoom = vi.spyOn(current as unknown as { room(n: number): void }, 'room');
    const referenceRoom = vi.spyOn(reference as unknown as { room(n: number): void }, 'room');
    const car = new TrafficCar(12);
    writeCar(current, car, 0);
    reference.trafficCar(car, 0);
    expect(currentRoom).toHaveBeenCalledExactlyOnceWith(26);
    expect(referenceRoom).toHaveBeenCalledTimes(16);
    expect(current.bytes()).toEqual(reference.bytes());
  });

  it('matches every byte at growth boundaries, offsets, saturation and half-rounding cases', () => {
    const numbers = [-Infinity, -1e9, -655.355, -32.7675, -3 * Math.PI, -Math.PI, -.0015, -.0005, -0, 0, .0005, .0015, Math.PI, 3 * Math.PI, 32.7675, 655.355, 1e9, Infinity, NaN];
    for (const size of [1, 7, 25, 26, 27, 52, 4096]) {
      const actual = new Writer(size), expected = new ReferenceWriter(size);
      for (let i = 0; i < 190; i++) {
        const c = new TrafficCar(i * 997);
        c.gen = i * 37;
        c.colorIdx = i % 256;
        c.color2Idx = i % 2 ? -1 : i % 128;
        c.s = numbers[i % numbers.length];
        c.d = numbers[(i + 1) % numbers.length];
        c.v = numbers[(i + 2) % numbers.length];
        c.acc = numbers[(i + 3) % numbers.length];
        c.yaw = numbers[(i + 4) % numbers.length];
        c.yawRate = numbers[(i + 5) % numbers.length];
        c.vd = numbers[(i + 6) % numbers.length];
        c.laneT = numbers[(i + 7) % numbers.length];
        c.laneFromD = numbers[(i + 8) % numbers.length];
        c.laneOff = numbers[(i + 9) % numbers.length];
        c.targetLane = i % 4;
        c.blink = [-1, 0, 1, 2][i % 4];
        c.braking = !!(i & 4);
        c.crashed = !!(i & 8);
        actual.u8(i); expected.u8(i);
        writeCar(actual, c, i % VEHICLES.length);
        expected.trafficCar(c, i % VEHICLES.length);
        expect(actual.pos).toBe((i + 1) * 27);
      }
      expect(actual.bytes()).toEqual(expected.bytes());
      const retained = actual.bytes();
      const retainedCopy = retained.slice();
      actual.reset(); expected.reset();
      writeCar(actual, new TrafficCar(99), 0);
      expected.trafficCar(new TrafficCar(99), 0);
      expect(actual.bytes()).toEqual(expected.bytes());
      expect(retained).toEqual(retainedCopy); // Socket copies must not alias reusable storage.
    }
  });

  it('matches complete low-load and 32-player/1200-NPC snapshots over stepped frames', () => {
    for (const [players, npcs] of [[2, 80], [32, 1200]]) {
      for (const frame of [0, 1, 3, 7]) assertSnapshotEquivalence(makeServerFixture(players, npcs, frame));
    }
  });

  it('retains visibility boundaries, pool order, nearest-first overflow and stable distance ties', () => {
    const w = makeServerFixture(2, 80);
    const dr = w.drivers[0];
    const check = () => {
      assertSnapshotEquivalence(w);
      const writer = new Writer(1);
      w.writeSnapshot(dr, writer);
      const reader = new Reader(writer.bytes());
      expect(reader.u8()).toBe(MSG_SNAPSHOT);
      const snapshot = newSnapshot();
      expect(readSnapshot(reader, snapshot)).toBe(true);
      return snapshot.cars.slice(0, snapshot.carCount).map(c => c.id);
    };
    w.traffic.clearAround(0, Infinity);
    for (const r of [-w.rules.viewBehind - .001, -w.rules.viewBehind, 0, w.rules.viewAhead, w.rules.viewAhead + .001]) {
      w.traffic.spawnAt(VEHICLES[0], w.traffic.wrap(dr.car.s + r), 0, 25, 0);
    }
    expect(check()).toEqual([1, 2, 3]);
    w.traffic.clearAround(0, Infinity);
    for (let i = 0; i < 410; i++) w.traffic.spawnAt(VEHICLES[0], w.traffic.wrap(dr.car.s + (i % 2 ? 1 : -1) * Math.floor(i / 2)), 0, 25, 0);
    expect(check()).toEqual(Array.from({ length: 384 }, (_, i) => i));
    dr.state = 'away';
    w.drivers[1].state = 'away';
    assertSnapshotEquivalence(w);
  });

  it.each<MapId>(['highway', 'miami'])('retains journal replay hash and exact snapshot bytes on %s', mapId => {
    const journal: Stimulus[] = [];
    const world = new OnlineWorld(9327, {}, mapId);
    world.journal = s => journal.push(s);
    world.configure({ mode: 'normal', modePerKm: { mode: 'normal', perKm: 10 } });
    for (let i = 0; i < 5; i++) world.join(`Replay ${i}`, (i + 1) as PhysicsId);
    for (let tick = 1; tick <= 128; tick++) {
      for (const dr of world.drivers) world.input(dr, tick, [{ steer: tick % 30 * 120 - 1800, throttle: 200, brake: tick % 21 ? 0 : 90, flags: tick % 11 ? 0 : 512 }], 1);
      if (tick === 35) world.paint(world.drivers[0], 0xaabbcc);
      if (tick === 65) world.respawn(world.drivers[1]);
      if (tick === 90) world.resync(world.drivers[2], tick);
      world.step();
      if (tick % 4 === 0) assertSnapshotEquivalence(world);
    }
    const rebuilt = replay(world.seed, {}, journal, world.tick, undefined, mapId);
    expect(rebuilt.hash()).toBe(world.hash());
    for (const dr of world.drivers) {
      const a = new Writer(1), b = new ReferenceWriter(1);
      world.writeSnapshot(dr, a);
      rebuilt.writeSnapshot(rebuilt.byId(dr.id)!, b);
      expect(a.bytes()).toEqual(b.bytes());
    }
  });

  it('retains byte-for-byte leaderboard JSON from reference/current snapshot scores', () => {
    const baseline = new Store(':memory:'), optimized = new Store(':memory:');
    try {
      const world = makeServerFixture(5, 80, 3);
      for (const mode of ['solo', 'online'] as RunMode[]) {
        for (let round = 0; round < 3; round++) for (const dr of world.drivers) {
          dr.score.score = 5000.99 + (dr.id % 3) * 1000 + round * 200;
          dr.score.near = 12 + dr.id;
          dr.score.topKmh = 200.55 + dr.id;
          dr.score.runTime = 12.345 + dr.id;
          for (const [writer, store] of [[new ReferenceWriter(1), baseline], [new Writer(1), optimized]] as const) {
            world.writeSnapshot(dr, writer);
            const reader = new Reader(writer.bytes()); reader.u8();
            const snap = newSnapshot();
            expect(readSnapshot(reader, snap)).toBe(true);
            store.addRun({ mode, name: round % 2 ? dr.name.toUpperCase() : dr.name, score: snap.score.score, car: dr.body, physics: dr.physics, near: snap.score.near, topKmh: snap.score.topKmh, seconds: snap.score.runTime }, 1000 + round * 100 + dr.id);
          }
        }
        for (const limit of [1, 3, 10, 100]) expect(JSON.stringify(optimized.leaderboard(mode, limit))).toBe(JSON.stringify(baseline.leaderboard(mode, limit)));
        for (const dr of world.drivers) expect(JSON.stringify(optimized.placeOn(mode, dr.name))).toBe(JSON.stringify(baseline.placeOn(mode, dr.name)));
        expect(optimized.playerCount(mode)).toBe(baseline.playerCount(mode));
      }
    } finally { baseline.close(); optimized.close(); }
  });
});
