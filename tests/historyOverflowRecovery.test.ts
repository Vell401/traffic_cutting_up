import { describe, expect, it } from 'vitest';
import { Writer } from '../src/online/protocol';
import { NetSession, link } from './netsim';

describe('input history overflow recovery', () => {
  it.each([
    ['highway', 0], ['miami', 0],
    ['highway', 45], ['miami', 45],
  ] as const)('%s resumes input and ACK progress (latency %i ms)', (map, latency) => {
    const net = new NetSession(43, {}, false, map);
    net.server.world.traffic.enabled = false;
    const down = link(latency), up = link(latency);
    const client = net.add({ name: 'A', physics: 2, up, down, fps: 60, bot: { kmh: 100, weave: false } });
    net.run(1);
    let previousSeq = client.core.seq;
    const monotonic = () => {
      expect(client.core.seq).toBeGreaterThanOrEqual(previousSeq);
      previousSeq = client.core.seq;
    };
    down.stallChance = 1;
    down.stallMs = 10000;
    net.run(.04, monotonic);
    down.stallChance = 0;
    net.run(10.1, monotonic);
    const driver = net.server.world.byId(client.core.id)!;
    expect(client.core.stats.horizon).toBeLessThan(24);
    const before = { seq: client.core.seq, ack: client.core.ack, serverAck: driver.ack, bytes: client.core.stats.bytesOut };
    let maxStarve = 0;
    net.run(2, () => { monotonic(); maxStarve = Math.max(maxStarve, driver.starve); });
    expect(client.core.seq).toBeGreaterThanOrEqual(before.serverAck);
    expect(client.core.ack - before.ack).toBeGreaterThan(200);
    expect(driver.ack - before.serverAck).toBeGreaterThan(200);
    expect(client.core.stats.bytesOut - before.bytes).toBeGreaterThan(1000);
    expect(driver.state).toBe('active');
    expect(maxStarve).toBeLessThan(5);
    expect(client.core.stats.horizon).toBeLessThan(24);
  });

  it.each(['highway', 'miami'] as const)('%s bounds overwritten replay and flush without trusting a future ACK or changing the server queue/epoch', map => {
    const net = new NetSession(44, {}, false, map);
    net.server.world.traffic.enabled = false;
    const client = net.add({ name: 'A', physics: 2, up: link(0), down: link(0), fps: 60, bot: { kmh: 100, weave: false } });
    net.run(1);
    const driver = net.server.world.byId(client.core.id)!;
    const writer = new Writer();
    net.server.world.writeSnapshot(driver, writer);
    const snapshot = writer.bytes().slice();
    // The last complete ring must still replay; the next input crosses the overwrite boundary.
    const retainedSteps = driver.ack + 1023 - client.core.seq;
    for (let i = 0; i < retainedSteps; i++) client.core.step({ steer: 0, throttle: 0, brake: 1 });
    const beforeBoundary = client.core.stats.replayed;
    client.core.receive(snapshot, net.now);
    expect(client.core.stats.replayed - beforeBoundary).toBe(1023);
    client.core.step({ steer: 0, throttle: 0, brake: 1 });
    const boundarySeq = client.core.seq, boundaryReplayed = client.core.stats.replayed;
    client.core.receive(snapshot, net.now);
    expect(client.core.seq).toBe(boundarySeq);
    expect(client.core.stats.replayed).toBe(boundaryReplayed);
    for (let i = 0; i < 76; i++) client.core.step({ steer: 0, throttle: 0, brake: 1 });
    const seq = client.core.seq, replayed = client.core.stats.replayed;
    const authority = { ack: driver.ack, queued: driver.queued, lastQueued: driver.lastQueued, epoch: driver.epoch };
    expect(authority.queued).toBeGreaterThan(0);
    const future = snapshot.slice();
    const view = new DataView(future.buffer, future.byteOffset, future.byteLength);
    view.setUint32(5, seq + 1, true); // ACK follows message kind and server tick.
    view.setUint16(9, driver.epoch + 1, true);
    const snapshots = client.core.stats.snapshots;
    client.core.receive(future, net.now);
    expect(client.core.stats.snapshots).toBe(snapshots);
    expect(client.core.seq).toBe(seq);
    client.core.receive(snapshot, net.now);
    expect(client.core.seq).toBe(seq);
    expect(client.core.ack).toBe(driver.ack);
    expect(client.core.stats.replayed).toBe(replayed);
    expect({ ack: driver.ack, queued: driver.queued, lastQueued: driver.lastQueued, epoch: driver.epoch }).toEqual(authority);
    // Only the 1023 still-retained unsent inputs can be flushed; numbering must not restart at ACK.
    const bytes = client.core.stats.bytesOut;
    client.core.flush();
    expect(client.core.stats.bytesOut - bytes).toBe(1023 * 6 + Math.ceil(1023 / 120) * 6);
    const afterFlush = client.core.stats.bytesOut;
    client.core.step({ steer: 0, throttle: 0, brake: 1 });
    client.core.flush();
    expect(client.core.stats.bytesOut - afterFlush).toBe(12);
    net.run(2);
    expect(driver.ack).toBeGreaterThan(seq);
    expect(driver.input.brake).toBe(0); // New live bot input supersedes the retained braking backlog.
    expect(driver.state).toBe('active');
    expect(driver.queued).toBeLessThanOrEqual(net.server.world.rules.inputMax);
    expect(client.core.stats.horizon).toBeLessThan(16);
  });
});
