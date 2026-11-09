/** Snapshot CPU benchmark, no sockets/ports. Run: npx tsx scripts/serverPerfcheck.ts
 * Measures complete fan-out including owned socket-safe bytes(), not simulation or network I/O.
 * Frames are stepped at 120 Hz and sampled every four ticks (30 Hz). No performance pass threshold.
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { laneCenter } from '../src/config';
import { Writer, writeCar } from '../src/online/protocol';
import { OnlineWorld } from '../src/online/world';
import { type TrafficCar } from '../src/sim/traffic';
import type { PhysicsId } from '../src/sim/physics';
import { VEHICLES } from '../src/sim/vehicles';

const clampInt = (v: number, lo: number, hi: number): number => v < lo ? lo : v > hi ? hi : Math.round(v);
const wrapPi = (a: number): number => {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Independent pre-optimization 26-byte encoder: keep its arithmetic and field order frozen. */
export class ReferenceWriter extends Writer {
  trafficCar(c: TrafficCar, specIndex: number): void {
    this.u16(c.id);
    this.u8(c.gen & 0xff);
    this.u8(specIndex);
    this.u8(c.colorIdx);
    this.i8(c.color2Idx);
    this.f32(c.s);
    this.i16(clampInt(c.d * 1000, -32767, 32767));
    this.u16(clampInt(c.v * 100, 0, 65535));
    this.i8(clampInt(c.acc * 10, -127, 127));
    this.i16(clampInt(wrapPi(c.yaw) * 10000, -32767, 32767));
    this.i16(clampInt(c.yawRate * 1000, -32767, 32767));
    this.i16(clampInt(c.vd * 1000, -32767, 32767));
    this.u8(c.laneT < 0 ? 255 : clampInt(c.laneT * 250, 0, 250));
    const blink = c.blink === -1 ? 1 : c.blink === 1 ? 2 : c.blink === 2 ? 3 : 0;
    this.u8((c.targetLane & 15) | (blink << 4) | (c.braking ? 64 : 0) | (c.crashed ? 128 : 0));
    this.i16(clampInt(c.laneFromD * 1000, -32767, 32767));
    this.i8(clampInt(c.laneOff * 100, -127, 127));
  }
}

export function makeServerFixture(players: number, npcs: number, frame = 0): OnlineWorld {
  const w = new OnlineWorld(73421, { maxPlayers: Math.max(32, players) });
  w.configure({ mode: 'normal', modePerKm: { mode: 'normal', perKm: players < 8 ? 10 : 25 } });
  for (let i = 0; i < players; i++) {
    const dr = w.join(`Driver ${i}`, (i % 5 + 1) as PhysicsId)!;
    dr.car.reset(i * w.ringLen / players, laneCenter(i % 4), 25 + i % 12);
    dr.car.ghost = true;
    dr.ghostT = Infinity;
  }
  w.traffic.clearAround(0, Infinity);
  w.traffic.reserve(npcs);
  for (let i = 0; i < npcs; i++) {
    const lane = i % 4;
    const s = players < 8
      ? w.traffic.wrap((i % players) * w.ringLen / players - 180 + Math.floor(i / players) * 900 / Math.ceil(npcs / players))
      : Math.floor(i / 4) * w.ringLen / Math.ceil(npcs / 4) + lane * 2;
    w.traffic.spawnAt(VEHICLES[i % VEHICLES.length], s, lane, 18 + i % 18, laneCenter(lane));
  }
  assert.equal(w.traffic.activeCount, npcs);
  for (let tick = 1; tick <= frame * 4; tick++) {
    for (const dr of w.drivers) w.input(dr, tick, [{ steer: (dr.id % 3 - 1) * 400, throttle: 160, brake: 0, flags: 0 }], 1);
    w.step();
  }
  return w;
}

export function assertSnapshotEquivalence(world: OnlineWorld): void {
  const current = new Writer(1), reference = new ReferenceWriter(1);
  for (const dr of world.drivers) {
    world.writeSnapshot(dr, current.reset());
    world.writeSnapshot(dr, reference.reset());
    assert.deepEqual(current.bytes(), reference.bytes());
  }
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1), trials: values };
}

function main(): void {
  const reference = process.argv.includes('--reference');
  if (process.argv.includes('--records-only')) {
    // Isolate the changed encoder from selection, tyre sampling, headers and socket copies.
    const world = makeServerFixture(32, 1200, 7);
    assertSnapshotEquivalence(world);
    const cars = world.traffic.cars.filter(c => c.active);
    const writer = reference ? new ReferenceWriter() : new Writer();
    const sweep = () => {
      writer.reset();
      for (const car of cars) writeCar(writer, car, 0);
    };
    const warmupStart = performance.now();
    do { sweep(); } while (performance.now() - warmupStart < 1500);
    const trials: number[] = [];
    let checksum = 0;
    for (let trial = 0; trial < 11; trial++) {
      const start = performance.now();
      for (let i = 0; i < 1500; i++) sweep();
      trials.push((performance.now() - start) * 1e6 / (1500 * cars.length));
      const out = writer.bytes();
      for (const byte of out) checksum = (checksum + byte) >>> 0;
    }
    console.log(JSON.stringify({ node: process.version, encoder: reference ? 'reference' : 'current', warmupMinimumMs: 1500, recordCount: cars.length, recordsPerTrial: 1500 * cars.length, nsPerRecord: summary(trials), checksum }));
    return;
  }
  console.log(JSON.stringify({ node: process.version, encoder: reference ? 'reference' : 'current', warmupMinimumMs: 1500, trials: 11, sweepsPerTrial: 'low:1500/high:30', frames: 8, snapshotHz: 30 }));
  for (const [players, npcs] of [[2, 80], [32, 1200]]) {
    const frames = Array.from({ length: 8 }, (_, i) => makeServerFixture(players, npcs, i));
    for (const frame of frames) assertSnapshotEquivalence(frame);
    const writer = reference ? new ReferenceWriter() : new Writer();
    let checksum = 0, bytes = 0;
    const sweep = () => {
      for (const world of frames) for (const dr of world.drivers) {
        world.writeSnapshot(dr, writer.reset());
        const out = writer.bytes();
        checksum = (checksum + out[0] + out[out.length - 1]) >>> 0;
        bytes += out.length;
      }
    };
    const warmupStart = performance.now();
    let warmupSweeps = 0;
    do { sweep(); warmupSweeps++; } while (warmupSweeps < 60 || performance.now() - warmupStart < 1500);
    checksum = bytes = 0;
    const sweepsPerTrial = players < 8 ? 1500 : 30;
    const trials: number[] = [];
    for (let trial = 0; trial < 11; trial++) {
      const start = performance.now();
      for (let i = 0; i < sweepsPerTrial; i++) sweep();
      trials.push((performance.now() - start) / (sweepsPerTrial * frames.length));
    }
    console.log(JSON.stringify({ players, initialNpcs: npcs, frameNpcs: frames.map(w => w.traffic.activeCount), fanoutMs: summary(trials), cpuMsPerSecondAt30Hz: summary(trials.map(ms => ms * 30)), checksum, bytes }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
