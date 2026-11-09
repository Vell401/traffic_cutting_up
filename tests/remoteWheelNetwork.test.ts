import { describe, expect, it } from 'vitest';
import { OnlineWorld } from '../src/online/world';
import { MSG_SNAPSHOT, newSnapshot, Reader, readSnapshot, REMOTE_DRIVER_BYTES, REMOTE_WHEELS, Writer } from '../src/online/protocol';
import { sampleTyreFeedback, createTyreFeedback } from '../src/presentation/tyres';
import { R34Car } from '../src/sim/vehicleR34';
import { NetSession, link } from './netsim';

describe('v12 remote wheel integration', () => {
  it('sends four independent signed wheel speeds and actual rack angle on both maps', () => {
    expect(REMOTE_DRIVER_BYTES).toBe(36);
    for (const map of ['highway', 'miami'] as const) {
      const world = new OnlineWorld(42, {}, map);
      const owner = world.join('observer', 1)!;
      const other = world.join('R34', 2, 2)!;
      const car = other.car as R34Car;
      car.omega.splice(0, 4, 0, -12.5, 225, 203.1875); car.steerAngle = -.55;
      const w = new Writer(); world.writeSnapshot(owner, w);
      const r = new Reader(w.bytes()); expect(r.u8()).toBe(MSG_SNAPSHOT);
      const snapshot = newSnapshot(); expect(readSnapshot(r, snapshot)).toBe(true);
      const remote = snapshot.drivers[0];
      expect(remote.flags & REMOTE_WHEELS).toBe(REMOTE_WHEELS);
      expect([...remote.wheelOmega!]).toEqual([0, -12.5, 225, 203.1875]);
      expect(remote.steer * 1.1).toBeCloseTo(-.55, 2);
      const buffer = remote.wheelOmega;
      car.omega.splice(0, 4, 1, 2, 3, 4); w.reset(); world.writeSnapshot(owner, w);
      const nextReader = new Reader(w.bytes()); nextReader.u8(); expect(readSnapshot(nextReader, snapshot)).toBe(true);
      expect(snapshot.drivers[0].wheelOmega).toBe(buffer);
      expect([...buffer!]).toEqual([1, 2, 3, 4]);
      const bytes = w.bytes().slice();
      for (let n = 0; n < bytes.length; n++) {
        const truncated = new Reader(bytes.subarray(0, n));
        if (n) truncated.u8();
        expect(readSnapshot(truncated, newSnapshot()), `truncated ${n}`).toBe(false);
      }
    }
  });

  it('copies reusable decoder telemetry into independent observer buffers without rotating on receipt', () => {
    const net = new NetSession(31, {}, false, 'miami');
    const observer = net.add({ name: 'viewer', physics: 1, car: 1, up: link(0), down: link(0), fps: 60, bot: { kmh: 0, weave: false } });
    net.add({ name: 'R34', physics: 2, car: 2, up: link(0), down: link(0), fps: 60, bot: { kmh: 0, weave: false } });
    net.run(.4);
    const remote = observer.sim.remotes.find(r => r.carId === 2)!;
    expect(remote).toBeDefined();
    const source = net.server.world.drivers.find(d => d.body === 2)!;
    (source.car as R34Car).omega.splice(0, 4, 0, 0, 180, 160); source.car.steerAngle = .42;
    const writer = new Writer();
    const target = net.server.world.drivers.find(d => d.name === 'viewer')!;
    net.server.world.writeSnapshot(target, writer);
    const bytes = writer.bytes().slice();
    const phase = remote.car.wheelSpin;
    for (let n = 0; n < 10; n++) observer.core.receive(bytes, net.now);
    expect(remote.car.wheelSpin).toBe(phase);
    const feedback = sampleTyreFeedback(remote.car, createTyreFeedback());
    expect(feedback.wheels.map(w => w.omega)).toEqual([0, 0, 180, 160]);
    expect(remote.car.steerAngle).toBeCloseTo(.42, 2);
    const saved = feedback.wheels.map(w => w.omega);
    (source.car as R34Car).omega.fill(0);
    writer.reset(); net.server.world.writeSnapshot(target, writer);
    expect(sampleTyreFeedback(remote.car, feedback).wheels.map(w => w.omega)).toEqual(saved);
  });
});
