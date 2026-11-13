import { describe, expect, it } from 'vitest';
import { Writer } from '../src/online/protocol';
import { link, NetSession } from './netsim';

function fixture() {
  const net = new NetSession(11);
  net.server.world.traffic.enabled = false;
  const client = net.add({ name: 'A', physics: 1, up: link(0), down: link(0), fps: 60, bot: { kmh: 0, weave: false } });
  client.paused = true;
  client.update(1); // hello reaches the real GameServer
  const driver = client.conn!.slot!.driver;
  const writer = new Writer(8192);
  const snapshot = () => {
    net.server.world.writeSnapshot(driver, writer.reset());
    client.conn!.peer.send(writer.bytes());
  };
  snapshot();
  client.update(2); // initial snapshot teleports, it is not a correction
  expect(client.core.ready).toBe(true);
  expect(client.core.stats.corrections).toBe(0);
  return { net, client, driver, snapshot };
}

describe('per-receive headless correction telemetry', () => {
  it('counts both real corrections in one delivery burst, including the larger first event', () => {
    const f = fixture();
    f.driver.car.s += 3;
    f.snapshot();
    f.driver.car.s += 0.25;
    f.snapshot();
    f.client.update(3); // both snapshots delivered at the same virtual millisecond
    expect(f.client.core.stats.corrections).toBe(2);
    expect(f.client.core.stats.lastCorrection).toBe(0.25);
    expect(f.client.core.stats.maxCorrection).toBe(3);
    expect(f.net.corrections.summary()).toMatchObject({ count: 2, samples: 2, sampled: false, max: 3, p50: 3, p95: 3 });
  });

  it('keeps all-event count/max exact and bounds explicitly sampled percentiles on long bursts', () => {
    const f = fixture();
    for (let i = 0; i < 20_000; i++) {
      f.driver.car.s += i === 0 ? 4 : 1;
      f.snapshot();
    }
    f.client.update(3);
    expect(f.client.core.stats.corrections).toBe(20_000);
    expect(f.client.core.stats.maxCorrection).toBe(4);
    expect(f.net.corrections.summary()).toMatchObject({ count: 20_000, samples: 16_384, sampled: true, max: 4, p50: 1, p95: 1 });
  });

  it('aggregates independent clients without counting text, unchanged snapshots or initial teleports', () => {
    const f = fixture();
    const second = f.net.add({ name: 'B', physics: 1, up: link(0), down: link(0), fps: 60, bot: { kmh: 0, weave: false } });
    second.paused = true;
    second.update(1);
    const driver = second.conn!.slot!.driver;
    const writer = new Writer(8192);
    const send = () => { f.net.server.world.writeSnapshot(driver, writer.reset()); second.conn!.peer.send(writer.bytes()); };
    send();
    second.update(2);
    driver.car.s += 0.5;
    send();
    second.update(3);
    f.driver.car.s += 2;
    f.snapshot();
    f.snapshot(); // same state, zero correction
    f.client.update(3);
    expect(f.client.core.stats.corrections + second.core.stats.corrections).toBe(2);
    expect(f.net.corrections.summary()).toMatchObject({ count: 2, samples: 2, sampled: false, max: 2, p50: 2, p95: 2 });
  });

  it('matches actual receive events in the seeded 150ms-stalls audit reproduction', () => {
    const net = new NetSession(11);
    const connection = link(75, 30, 0.01);
    const clients = [
      net.add({ name: 'A', physics: 1, up: connection, down: connection, fps: 60, bot: { kmh: 220, weave: true } }),
      net.add({ name: 'B', physics: 2, up: connection, down: connection, fps: 60, bot: { kmh: 200, weave: true } }),
    ];
    const actual: number[] = [];
    for (const client of clients) {
      const receive = client.core.receive.bind(client.core);
      client.core.receive = (data, now) => {
        const before = client.core.stats.corrections;
        receive(data, now);
        if (client.core.stats.corrections !== before) actual.push(client.core.stats.lastCorrection);
      };
    }
    const last = [0, 0];
    let legacyCount = 0;
    net.run(20, () => clients.forEach((client, i) => {
      if (client.core.stats.corrections !== last[i]) { last[i] = client.core.stats.corrections; legacyCount++; }
    }));
    actual.sort((a, b) => a - b);
    expect(legacyCount).toBeLessThan(actual.length); // fixture really delivers a multi-correction bucket
    expect(net.corrections.summary()).toMatchObject({
      count: clients.reduce((sum, client) => sum + client.core.stats.corrections, 0),
      samples: actual.length, sampled: false, max: Math.max(...actual),
      p50: actual[Math.floor(actual.length * 0.5)], p95: actual[Math.floor(actual.length * 0.95)],
    });
  });
});
