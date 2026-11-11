import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { ClientCore, GARAGE_TIMEOUT_MS } from '../src/online/clientCore';
import { GameServer } from '../src/online/gameServer';
import { Writer, inputFromQ, quantizeInput } from '../src/online/protocol';
import { replay } from '../src/online/world';
import { bodyPhysics } from '../src/sim/physics';
import type { CarId } from '../src/sim/cars';
import { SPAWN_D, spawnS } from '../src/sim/ring';
import { Sim } from '../src/sim/world';
import { attach, emptyServer } from './chatGarageHelpers';
import { link, NetSession } from './netsim';

function clientHarness() {
  const server = emptyServer();
  const down: (string | Uint8Array)[] = [];
  const conn = server.connect({ send: (d) => down.push(d), close: () => {}, buffered: 0 });
  const sim = new Sim(mulberry32(9), { online: true, physics: 4 });
  const core = new ClientCore(sim, { send: (d) => conn.receive(d) });
  const drain = () => {
    while (down.length) core.receive(down.shift()!, 0);
  };
  core.hello('Alice', 4, 1, undefined, 0x123456);
  drain();
  const dr = server.world.byId(core.id)!;
  const snapshot = () => {
    const w = new Writer();
    server.world.writeSnapshot(dr, w);
    core.receive(w.bytes(), 0);
  };
  snapshot();
  return { server, conn, sim, core, dr, drain, snapshot };
}

afterEach(() => vi.useRealTimers());

describe('garage server validation', () => {
  it('requires hello and strictly validates body, matched physics, RGB paint and request id', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    const before = a.driver!.car;
    const epoch = a.driver!.epoch;
    const valid = { t: 'garage', request: 1, car: 4, physics: 5, color: 0xabcdef };
    const outsider = server.connect({ send: () => {}, close: () => {}, buffered: 0 });
    outsider.receive(JSON.stringify(valid));
    expect(outsider.violations).toBe(1);
    for (const patch of [
      { car: 0 }, { car: 5 }, { car: '4' }, { car: null }, { car: {} },
      { physics: 1 }, { physics: '5' }, { color: -1 }, { color: 0x1000000 },
      { color: 1.5 }, { color: '123' }, { color: null }, { request: 0 }, { request: 1.5 },
    ]) a.conn.receive(JSON.stringify({ ...valid, ...patch }));
    expect(a.conn.violations).toBe(14);
    expect(a.driver!.car).toBe(before);
    expect(a.driver!.epoch).toBe(epoch);
    expect(a.peer.json('garage').every((m) => !m.ok)).toBe(true);
  });

  it('swaps the real chassis, ends the old run under its old identity, fences inputs and broadcasts players', () => {
    const runs: { car: number; physics: number; score: number }[] = [];
    const server = new GameServer({ seed: 2, onRun: (dr, run) => runs.push({ car: dr.body, physics: dr.physics, score: run.score }) });
    server.world.traffic.enabled = false;
    const a = attach(server, 'Alice');
    const b = attach(server, 'Bob');
    const dr = a.driver!;
    dr.car.s = spawnS(0) + server.world.ringLen + 250;
    dr.score.score = 1234;
    server.world.input(dr, 1, Array.from({ length: 3 }, () => ({ steer: 0, throttle: 255, brake: 0, flags: 0 })), 3);
    const old = dr.car;
    const epoch = dr.epoch;
    a.conn.receive(JSON.stringify({ t: 'garage', request: 7, car: 4, physics: 5, color: 0xffffff }));
    expect(runs).toEqual([{ car: 1, physics: 4, score: 1234 }]);
    expect(dr.car).not.toBe(old);
    expect(dr.physics).toBe(5);
    expect(dr.car.physicsId).toBe(5);
    expect(dr.body).toBe(4);
    expect(dr.car.s).toBe(spawnS(0) + server.world.ringLen);
    expect(dr.car.d).toBe(SPAWN_D);
    expect(dr.car.vAlong).toBe(0);
    expect(dr.car.ghost).toBe(true);
    expect(dr.score.score).toBe(0);
    expect(dr.score.best).toBe(1234);
    expect(dr.queued).toBe(0);
    expect(dr.ack).toBe(3);
    expect(dr.epoch).toBe(epoch + 1);
    expect(a.peer.json('garage').at(-1)).toEqual({ t: 'garage', request: 7, ok: true, epoch: dr.epoch });
    expect(b.peer.json('players').at(-1)!.list.find((p) => p.id === dr.id)).toMatchObject({ car: 4, physics: 5, color: 0xffffff });
  });

  it('works while away and rate limits changes across socket reconnects', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    a.driver!.state = 'away';
    a.conn.receive(JSON.stringify({ t: 'garage', request: 1, car: 2, physics: 2, color: 0 }));
    expect(a.driver!.state).toBe('active');
    a.conn.close();
    const back = attach(server, 'Alice', { token: a.welcome.token, car: 2, physics: 2, color: 0 });
    back.conn.receive(JSON.stringify({ t: 'garage', request: 2, car: 3, physics: 3, color: 0 }));
    expect(back.peer.json('garage').at(-1)).toMatchObject({ ok: false, reason: 'rate' });
    for (let i = 0; i < server.world.rules.tickHz; i++) server.tick();
    back.conn.receive(JSON.stringify({ t: 'garage', request: 3, car: 3, physics: 3, color: 0 }));
    expect(back.driver!.physics).toBe(3);
  });
});

describe('garage authoritative client acknowledgement', () => {
  it('does not carry optional clutch/assist input from the previous chassis or a future replay step', () => {
    const out = { steer: 0, throttle: 0, brake: 0, clutch: true, tractionControlEnabled: false, espEnabled: true };
    const q = quantizeInput({ steer: 0, throttle: 1, brake: 0 }, { steer: 0, throttle: 0, brake: 0, flags: 0 });
    const decoded = inputFromQ(q, out);
    expect(decoded.clutch).toBeUndefined();
    expect(decoded.tractionControlEnabled).toBeUndefined();
    expect(decoded.espEnabled).toBeUndefined();
  });

  it('flushes old inputs and resolves only after the new epoch snapshot, never on players/ACK alone', async () => {
    const h = clientHarness();
    for (let i = 0; i < 3; i++) h.core.step({ steer: 0, throttle: 1, brake: 0 });
    const before = h.sim.player;
    let done = false;
    const promise = h.core.changeCar(4, 0x123456).then(() => { done = true; });
    expect(h.dr.ack).toBe(3);
    expect(h.sim.player).toBe(before);
    h.drain();
    await Promise.resolve();
    expect(done).toBe(false);
    h.snapshot();
    await promise;
    expect(done).toBe(true);
    expect(h.sim.player.physicsId).toBe(5);
    expect(h.core.ready).toBe(true);
    expect(h.sim.player.s).toBe(h.dr.car.s);
    h.core.dispose();
  });

  it('accepts a later epoch (including wraparound) if a return/resync follows the garage change', async () => {
    const h = clientHarness();
    h.dr.epoch = 65534;
    const promise = h.core.changeCar(2, 0x123456);
    h.drain();
    h.server.world.resync(h.dr, h.dr.lastQueued);
    expect(h.dr.epoch).toBe(65536);
    h.snapshot();
    await promise;
    expect(h.sim.player.physicsId).toBe(2);
  });

  it('a no-op selection confirms on a snapshot without ending or respawning the run', async () => {
    const h = clientHarness();
    const epoch = h.dr.epoch;
    h.dr.score.score = 42;
    const promise = h.core.changeCar(1, 0x123456);
    h.drain();
    expect(h.dr.epoch).toBe(epoch);
    expect(h.dr.score.score).toBe(42);
    h.snapshot();
    await promise;
  });

  it('rejects invalid/concurrent requests, explicit server refusal and disconnection', async () => {
    const h = clientHarness();
    await expect(h.core.changeCar(99 as CarId, 1)).rejects.toThrow();
    const first = h.core.changeCar(2, 1);
    await expect(h.core.changeCar(3, 1)).rejects.toThrow('уже');
    h.drain();
    h.snapshot();
    await first;
    const rateLimited = h.core.changeCar(4, 1);
    h.drain();
    await expect(rateLimited).rejects.toThrow('раз в секунду');
    h.server.world.tick += h.server.world.rules.tickHz;
    const disconnected = h.core.changeCar(4, 1);
    h.core.disconnected();
    await expect(disconnected).rejects.toThrow('потеряна');
  });

  it('rejects on timeout, session rejection or disposal instead of leaving the loading UI stuck', async () => {
    vi.useFakeTimers();
    const h = clientHarness();
    const timedOut = h.core.changeCar(2, 1);
    const assertion = expect(timedOut).rejects.toThrow('не подтвердил');
    vi.advanceTimersByTime(GARAGE_TIMEOUT_MS);
    await assertion;
    const rejected = h.core.changeCar(3, 1);
    h.core.receive(JSON.stringify({ t: 'reject', reason: 'kicked', text: 'kicked' }), 0);
    await expect(rejected).rejects.toThrow('kicked');
    const disposed = h.core.changeCar(4, 1);
    h.core.dispose();
    await expect(disposed).rejects.toThrow('вышли');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps exact prediction for every body after delayed changes and replays the journal', async () => {
    const net = new NetSession(57, {}, true);
    net.server.world.traffic.enabled = false;
    const a = net.add({ name: 'Alice', physics: 4, car: 1, up: link(70, 45), down: link(90, 50), fps: 30, bot: { kmh: 120, weave: false } });
    const b = net.add({ name: 'Observer', physics: 4, car: 1, up: link(20, 5), down: link(20, 5), fps: 60, bot: { kmh: 20, weave: false } });
    net.run(3);
    for (const car of [2, 3, 4, 1] as const) {
      const promise = a.core.changeCar(car, 0xabcdef);
      net.run(3);
      await promise;
      expect(a.sim.player.physicsId).toBe(bodyPhysics(car));
      const remote = b.sim.remotes.find((r) => r.id === a.core.id)!;
      expect(remote.carId).toBe(car);
      expect(remote.car.physicsId).toBe(bodyPhysics(car));
      expect(remote.color).toBe(0xabcdef);
      // Exclude driver/traffic contacts: only test own deterministic prediction here.
      expect(a.core.stats.maxCorrection).toBeLessThan(1e-6);
    }
    const again = replay(57, {}, net.journal, net.server.world.tick, (w) => { w.traffic.enabled = false; });
    expect(again.hash()).toBe(net.server.world.hash());
  });
});
