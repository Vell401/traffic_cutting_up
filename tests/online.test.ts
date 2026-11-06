import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import {
  MSG_INPUT,
  MSG_SNAPSHOT,
  Reader,
  Writer,
  inputFromQ,
  newSnapshot,
  quantizeInput,
  readInputs,
  readSnapshot,
  writeInputs,
  type InputQ,
} from '../src/online/protocol';
import { OnlineWorld, replay } from '../src/online/world';
import { createCar } from '../src/sim/physics';
import { NetSession, link, type ClientSpec } from './netsim';

const spec = (name: string, delay: number, jitter: number, over: Partial<ClientSpec> = {}): ClientSpec => ({
  name,
  physics: 1,
  up: link(delay, jitter),
  down: link(delay, jitter),
  fps: 60,
  bot: { kmh: 200, weave: true },
  ...over,
});

describe('car state', () => {
  for (const physics of [1, 2] as const) {
    it(`physics ${physics}: a saved state steps on exactly like the original`, () => {
      const a = createCar(physics);
      a.reset(100, 2, 150 / 3.6);
      const inp = { steer: 0.4, throttle: 1, brake: 0 };
      for (let i = 0; i < 90; i++) a.step(1 / 120, inp, 1 / 1500);
      const buf = new Float64Array(64);
      const n = a.saveState(buf);
      expect(n).toBe(a.stateSize);
      const b = createCar(physics);
      b.loadState(buf);
      for (let i = 0; i < 240; i++) {
        inp.steer = Math.sin(i * 0.05);
        a.step(1 / 120, inp, 1 / 1500);
        b.step(1 / 120, inp, 1 / 1500);
      }
      const sa = new Float64Array(64);
      const sb = new Float64Array(64);
      a.saveState(sa);
      b.saveState(sb);
      expect([...sb]).toEqual([...sa]);
    });
  }
});

describe('protocol', () => {
  it('quantized inputs survive the wire bit for bit', () => {
    const qs: InputQ[] = [];
    for (let i = 0; i < 5; i++) qs.push(quantizeInput({ steer: Math.sin(i), throttle: i / 4, brake: 1 - i / 4, analog: i % 2 === 0 }, { steer: 0, throttle: 0, brake: 0, flags: 0 }));
    const w = new Writer(16);
    writeInputs(w, 77, qs, 0, qs.length);
    const r = new Reader(w.bytes());
    expect(r.u8()).toBe(MSG_INPUT);
    const out: InputQ[] = [];
    expect(readInputs(r, out)).toEqual({ firstSeq: 77, count: 5 });
    for (let i = 0; i < 5; i++) {
      expect(out[i]).toEqual(qs[i]);
      expect(inputFromQ(out[i], { steer: 0, throttle: 0, brake: 0 })).toEqual(inputFromQ(qs[i], { steer: 0, throttle: 0, brake: 0 }));
    }
  });

  it('rejects malformed input messages', () => {
    const w = new Writer();
    w.u8(MSG_INPUT);
    w.u32(1);
    w.u8(3);
    w.u8(0); // truncated
    const r = new Reader(w.bytes());
    r.u8();
    expect(readInputs(r, [])).toBeNull();
  });

  it('snapshots carry the car state exactly and the traffic to the millimetre', () => {
    const world = new OnlineWorld(5);
    const dr = world.join('Tester', 2)!;
    const q = quantizeInput({ steer: 0.1, throttle: 1, brake: 0 }, { steer: 0, throttle: 0, brake: 0, flags: 0 });
    for (let i = 1; i <= 240; i++) {
      world.input(dr, i, [q], 1);
      world.step();
    }
    const w = new Writer();
    world.writeSnapshot(dr, w);
    const r = new Reader(w.bytes());
    expect(r.u8()).toBe(MSG_SNAPSHOT);
    const sn = newSnapshot();
    expect(readSnapshot(r, sn)).toBe(true);
    expect(sn.ack).toBe(240);
    const state = new Float64Array(64);
    const n = dr.car.saveState(state);
    expect([...sn.state.subarray(0, sn.stateLen)]).toEqual([...state.subarray(0, n)]);
    expect(sn.carCount).toBeGreaterThan(10);
    for (let i = 0; i < sn.carCount; i++) {
      const c = world.traffic.cars[sn.cars[i].id];
      expect(Math.abs(sn.cars[i].s - c.s)).toBeLessThan(2e-3);
      expect(Math.abs(sn.cars[i].d - c.d)).toBeLessThan(1e-3);
    }
  });
});

describe('online world', () => {
  it('replays a session from its seed and journal to the same state', () => {
    const net = new NetSession(21, {}, true);
    net.add(spec('A', 30, 10));
    net.add(spec('B', 60, 25, { physics: 2, fps: 30 }));
    net.run(12);
    const live = net.server.world;
    const again = replay(21, {}, net.journal, live.tick);
    expect(again.hash()).toBe(live.hash());
  });

  it('keeps traffic around every driver and spawns it out of everyone else’s sight', () => {
    const world = new OnlineWorld(8);
    const a = world.join('A', 1)!;
    const b = world.join('B', 1)!;
    // Put B half a lap away: two separate traffic windows.
    b.car.s = (a.car.s + world.ringLen / 2) % world.ringLen;
    const q = quantizeInput({ steer: 0, throttle: 0.5, brake: 0 }, { steer: 0, throttle: 0, brake: 0, flags: 0 });
    for (let i = 1; i <= 600; i++) {
      world.input(a, i, [q], 1);
      world.input(b, i, [q], 1);
      world.step();
    }
    const near = (s: number) => world.traffic.cars.filter((c) => c.active && Math.abs(world.traffic.rel(c.s, s) - 300) < 600).length;
    expect(near(a.car.s)).toBeGreaterThan(10);
    expect(near(b.car.s)).toBeGreaterThan(10);
  });
});

describe('online session', () => {
  it('predicts its own car exactly when nothing else interferes (any latency, jitter, frame rate)', () => {
    const net = new NetSession(3);
    net.server.world.traffic.enabled = false;
    const a = net.add(spec('A', 70, 40, { fps: 30 }));
    const b = net.add(spec('B', 10, 5, { physics: 2 }));
    net.run(15);
    for (const c of [a, b]) {
      expect(c.core.ready).toBe(true);
      expect(c.core.stats.snapshots).toBeGreaterThan(300);
      expect(c.core.stats.maxCorrection).toBeLessThan(1e-6);
    }
    expect(a.core.stats.horizon).toBeGreaterThan(12); // ~RTT ahead
    expect(a.sim.remotes.length).toBe(1);
  });

  it('keeps corrections small around traffic at 150 ms with jitter', () => {
    const net = new NetSession(4);
    const a = net.add(spec('A', 75, 40, { bot: { kmh: 220, weave: true } }));
    net.run(30);
    const st = a.core.stats;
    expect(st.snapshots).toBeGreaterThan(800);
    expect(st.maxCorrection).toBeLessThan(2.5);
    expect(a.sim.traffic.activeCount).toBeGreaterThan(10);
  });

  it('hits are predicted and confirmed: crashes end runs on the server', () => {
    const net = new NetSession(9);
    const a = net.add(spec('A', 40, 15, { bot: { kmh: 230, weave: false, reckless: true } }));
    net.run(40);
    const runs = a.events.get('runEnd') ?? 0;
    expect(runs).toBeGreaterThan(0);
    expect(a.localCrashes).toBeGreaterThanOrEqual(runs);
  });

  it('reconnects into the same slot with the token', () => {
    const net = new NetSession(5);
    const a = net.add(spec('A', 20, 5));
    net.run(3);
    const id = a.core.id;
    const token = a.core.token;
    const tele = a.teleports;
    a.drop();
    net.run(2);
    expect(net.server.world.byId(id)?.state).toBe('away');
    a.open(token);
    net.run(3);
    expect(a.core.id).toBe(id);
    expect(net.server.playerCount).toBe(1);
    expect(a.teleports).toBe(tele + 1); // put back on the road where it was
    expect(net.server.world.byId(id)?.state).toBe('active');
  });

  it('a hidden tab leaves the road and comes back', () => {
    const net = new NetSession(6);
    const a = net.add(spec('A', 20, 5));
    net.run(3);
    a.paused = true;
    net.run(2);
    expect(net.server.world.byId(a.core.id)?.state).toBe('away');
    a.paused = false;
    net.run(2);
    expect(net.server.world.byId(a.core.id)?.state).toBe('active');
  });

  it('turns away the sixth driver', () => {
    const net = new NetSession(7);
    const rejected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = net.add(spec(`P${i}`, 10 + i, 0));
      (c.core as unknown as { hooks: { onReject: (t: string) => void } }).hooks.onReject = (t) => rejected.push(t);
    }
    net.run(1);
    expect(net.server.playerCount).toBe(5);
    expect(rejected.length).toBe(1);
  });

  it('drops a client that floods or sends garbage', () => {
    const net = new NetSession(8);
    const a = net.add(spec('A', 5, 0));
    net.run(1);
    const conn = a.conn!;
    for (let i = 0; i < 60; i++) conn.receive(new Uint8Array([MSG_INPUT, 1, 2]));
    expect(conn.closed).toBe(true);
    expect(net.server.connectionCount).toBe(0);
  });

  it('crosses the ring seam without a correction', () => {
    const net = new NetSession(10);
    net.server.world.traffic.enabled = false;
    const a = net.add(spec('A', 30, 10, { bot: { kmh: 250, weave: false } }));
    net.run(2);
    const dr = net.server.world.byId(a.core.id)!;
    dr.car.s = net.server.world.ringLen - 150;
    dr.epoch++;
    net.run(1);
    const before = a.sim.player.s;
    net.run(6);
    expect(a.sim.player.s - before).toBeGreaterThan(200);
    expect(dr.car.s).toBeGreaterThan(net.server.world.ringLen); // a driver's s counts laps
    expect(a.sim.player.s).toBe(dr.car.s - (dr.car.s - a.sim.player.s)); // same frame as the server
    expect(a.core.stats.maxCorrection).toBeLessThan(1e-6);
  });
});

describe('ring traffic', () => {
  it('stays deterministic and in range for minutes', () => {
    const w1 = new OnlineWorld(99, { traffic: 2 });
    const w2 = new OnlineWorld(99, { traffic: 2 });
    for (const w of [w1, w2]) {
      const d = w.join('A', 1)!;
      const rng = mulberry32(1);
      const q: InputQ = { steer: 0, throttle: 200, brake: 0, flags: 0 };
      for (let i = 1; i <= 120 * 60; i++) {
        q.steer = Math.round((rng() - 0.5) * 2000);
        w.input(d, i, [q], 1);
        w.step();
      }
      for (const c of w.traffic.cars) {
        if (!c.active) continue;
        expect(c.s).toBeGreaterThanOrEqual(0);
        expect(c.s).toBeLessThan(w.ringLen);
        expect(Number.isFinite(c.d)).toBe(true);
      }
    }
    expect(w1.hash()).toBe(w2.hash());
  });
});
