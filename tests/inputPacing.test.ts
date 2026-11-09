import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer, type Conn, type Peer } from '../src/online/gameServer';
import { Writer, quantizeInput, writeInputs, type InputQ, type ServerMsg } from '../src/online/protocol';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { OnlineWorld, replay, type Stimulus } from '../src/online/world';
import type { MapId } from '../src/sim/maps';
import { NetSession, link } from './netsim';

class Socket implements Peer {
  buffered = 0;
  messages: ServerMsg[] = [];
  snapshots = 0;
  closeCode = 0;
  send(data: Uint8Array | string): void {
    if (typeof data === 'string') this.messages.push(JSON.parse(data) as ServerMsg);
    else this.snapshots++;
  }
  close(code: number): void { this.closeCode = code; }
}

const q = quantizeInput({ steer: 0.013, throttle: 0.61, brake: 0, analog: true },
  { steer: 0, throttle: 0, brake: 0, flags: 0 });

function send(conn: Conn, first: number, count: number, inputs: InputQ[] = Array(count).fill(q)): void {
  const w = new Writer();
  writeInputs(w, first, inputs, 0, count);
  conn.receive(w.bytes());
}

function join(server: GameServer, name = 'Driver', token?: string, seq = 0) {
  const peer = new Socket();
  const conn = server.connect(peer);
  conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map: server.world.map.id,
    rules: rulesHash(server.world.map.id), name, physics: 5, car: 1, seq, token }));
  const welcome = peer.messages.find(m => m.t === 'welcome');
  if (!welcome || welcome.t !== 'welcome') throw new Error('hello rejected');
  return { conn, peer, dr: server.world.byId(welcome.id)!, token: welcome.token };
}

beforeEach(() => vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

for (const map of ['highway', 'miami'] as const satisfies readonly MapId[]) {
  describe(`${map}: binary input admission pacing`, () => {
    function setup() {
      const journal: Stimulus[] = [];
      let token = 0;
      const server = new GameServer({ seed: 90, map, token: () => `pacing-${++token}`,
        journal: s => journal.push(s) });
      server.configure({ trafficOn: false });
      return { server, journal };
    }

    it('blocks the concrete 2395 steps / 1200 ticks exploit and replays accepted inputs exactly', () => {
      const { server, journal } = setup();
      const normal = join(server, 'Normal');
      const attack = join(server, 'Attacker');
      // Control demonstrates why queue depth alone is not a time budget. Do not change world physics.
      const unpaced = new OnlineWorld(90, {}, map);
      unpaced.configure({ trafficOn: false });
      const control = unpaced.join('Control', 5)!;
      let normalSteps = 0, attackSteps = 0, controlSteps = 0, openTicks = 0;
      for (let t = 0; t < 1200; t++) {
        send(normal.conn, t + 1, 1);
        if (!attack.conn.closed) {
          openTicks++;
          send(attack.conn, t * 2 + 1, 2);
        }
        unpaced.input(control, t * 2 + 1, [q, q], 2);
        server.tick();
        unpaced.step();
        normalSteps += normal.dr.stepped;
        attackSteps += attack.dr.stepped;
        controlSteps += control.stepped;
        expect(attackSteps).toBeLessThanOrEqual(t + 1 + 8);
      }
      expect(controlSteps).toBe(2395);
      expect(normalSteps).toBe(1200);
      expect(normal.conn.violations).toBe(0);
      expect(attackSteps).toBeLessThanOrEqual(openTicks + 8);
      expect(attackSteps).toBe(114);
      expect(openTicks).toBe(108);
      expect(attack.conn.closed).toBe(true);
      expect(attack.conn.violations).toBe(51);
      expect(attack.peer.closeCode).toBe(1008);
      expect(normal.peer.snapshots).toBe(300);
      expect(replay(90, {}, journal, server.world.tick, undefined, map).hash()).toBe(server.world.hash());
    });

    it('disconnects 120-input-per-tick flooding instead of just counting queue overflows forever', () => {
      const { server } = setup();
      const { conn, dr, peer } = join(server);
      let ticks = 0;
      while (!conn.closed && ticks < 1200) {
        send(conn, ticks * 120 + 1, 120);
        server.tick();
        expect(dr.queued).toBeLessThanOrEqual(server.world.rules.inputMax);
        ticks++;
      }
      expect(ticks).toBe(51);
      expect(conn.violations).toBe(51);
      expect(dr.violations).toBe(51);
      expect(peer.closeCode).toBe(1008);
      expect(dr.ack).toBe(0);
    });

    it('charges only fresh inputs, not duplicate prefixes or sequence-number gaps', () => {
      const { server, journal } = setup();
      const { conn, dr } = join(server);
      send(conn, 1, 8);
      for (let i = 0; i < 20; i++) send(conn, 1, 8);
      expect(conn.violations).toBe(0);
      server.tick();
      server.tick();
      send(conn, 7, 4); // only 9 and 10 are new
      expect(dr.lastQueued).toBe(10);
      server.tick();
      send(conn, 1000, 1); // sequence gaps do not grant or consume fictitious steps
      expect(dr.lastQueued).toBe(1000);
      send(conn, 1001, 1); // same tick, exhausted budget
      expect(conn.violations).toBe(1);
      expect(dr.lastQueued).toBe(1000);
      for (let i = 0; i < 12; i++) server.tick();
      expect(dr.ack).toBe(1000);
      expect(dr.input.steer).toBe(q.steer / 32767);
      expect(dr.input.throttle).toBe(q.throttle / 255);
      expect(replay(90, {}, journal, server.world.tick, undefined, map).hash()).toBe(server.world.hash());
    });

    it('does not mint time through reconnect, resync, or respawn', () => {
      const { server } = setup();
      const original = join(server);
      send(original.conn, 1, 8);
      original.conn.close();
      const resumed = join(server, 'Resumed', original.token, 8);
      resumed.conn.receive(JSON.stringify({ t: 'respawn' }));
      send(resumed.conn, 9, 1);
      expect(resumed.dr).toBe(original.dr);
      expect(resumed.dr.lastQueued).toBe(8);
      expect(resumed.conn.violations).toBe(1);
      server.tick();
      send(resumed.conn, 9, 1);
      expect(resumed.dr.lastQueued).toBe(9);
    });

    it('accepts ordered 60 fps frame batches and a 500 ms network stall without dropped steps', () => {
      const { server } = setup();
      const { conn, dr } = join(server);
      let seq = 1, stepped = 0, doubled = 0;
      const pending: number[] = [];
      for (let t = 0; t < 1200; t++) {
        if (t % 2 === 0) {
          pending.push(seq);
          seq += 2;
        }
        if (t < 300 || t >= 360) {
          for (const first of pending) send(conn, first, 2);
          pending.length = 0;
        }
        server.tick();
        stepped += dr.stepped;
        if (dr.stepped === 2) doubled++;
      }
      while (dr.queued) { server.tick(); stepped += dr.stepped; }
      expect(stepped).toBe(1200);
      expect(dr.ack).toBe(1200);
      expect(doubled).toBeGreaterThan(30);
      expect(conn.violations).toBe(0);
      expect(conn.closed).toBe(false);
    });

    it('uses a bounded, non-additive wall-clock allowance for a stalled server', () => {
      const { server } = setup();
      const { conn, dr } = join(server);
      send(conn, 1, 8);
      // No world ticks during a one-second event-loop stall: two legal wire batches arrive together.
      vi.mocked(performance.now).mockReturnValue(1000);
      send(conn, 9, 120);
      expect(dr.lastQueued).toBe(128);
      expect(conn.violations).toBe(0);
      for (let i = 0; i < 120; i++) server.tick();
      send(conn, 129, 1);
      expect(conn.violations).toBe(1); // catching up world ticks must not pay twice for that second
      vi.mocked(performance.now).mockReturnValue(60_000);
      send(conn, 129, 120);
      send(conn, 249, 120);
      send(conn, 369, 1); // a minute idle still only banks 240 inputs
      expect(dr.queued).toBe(240);
      expect(conn.violations).toBe(2);
      vi.mocked(performance.now).mockReturnValue(61_000);
      send(conn, 369, 1); // earned credit cannot overwrite a full queue either
      expect(dr.queued).toBe(240);
      expect(conn.violations).toBe(3);
      expect(dr.violations).toBe(3);
    });

    for (const profile of [
      { name: 'latency/jitter', up: link(75, 90), down: link(75, 90) },
      { name: 'repeated 500 ms stalls', up: { ...link(35, 40, 0.03), stallMs: 500 }, down: link(35, 40) },
    ]) {
      it(`preserves exact R34 prediction at 60 fps with ${profile.name}`, () => {
        const net = new NetSession(193, {}, true, map);
        net.server.configure({ trafficOn: false });
        const client = net.add({ name: 'Legitimate', physics: 5, fps: 60,
          up: profile.up, down: profile.down, bot: { kmh: 100, weave: false } });
        net.run(20);
        const dr = net.server.world.byId(client.core.id)!;
        expect(client.connected).toBe(true);
        expect(client.conn!.violations).toBe(0);
        expect(dr.violations).toBe(0);
        expect(client.core.ready).toBe(true);
        expect(client.core.stats.snapshots).toBeGreaterThan(500);
        expect(client.core.stats.maxCorrection).toBeLessThan(1e-6);
        expect(dr.ack).toBeGreaterThan(2000);
        expect(client.core.seq - dr.ack).toBeLessThan(150);
        expect(replay(193, {}, net.journal, net.server.world.tick, undefined, map).hash())
          .toBe(net.server.world.hash());
      });
    }
  });
}
