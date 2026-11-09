import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { ClientCore } from '../src/online/clientCore';
import { GameServer, type Conn } from '../src/online/gameServer';
import { Writer } from '../src/online/protocol';
import { Sim } from '../src/sim/world';
import { NetSession, link } from './netsim';

describe.each(['highway', 'miami'] as const)('%s reconnect sequence baseline', map => {
  it.each([false, true])('resumes prediction with an expired token: %s', expired => {
    const net = new NetSession(5, { reconnectSeconds: expired ? 1 : 30 }, false, map);
    net.server.world.traffic.enabled = false;
    const client = net.add({ name: 'A', physics: 2, up: link(10, 5), down: link(10, 5), fps: 60, bot: { kmh: 120, weave: false } });
    net.run(2);
    expect(client.core.ready).toBe(true);
    const { id, token, seq } = client.core;
    const teleports = client.teleports;
    client.drop();
    net.run(2);
    expect(client.core.seq).toBe(seq);
    expect(net.server.world.byId(id) === undefined).toBe(expired);
    client.open(token);
    let previous = seq;
    net.run(2, () => {
      expect(client.core.seq).toBeGreaterThanOrEqual(previous);
      expect(client.core.ack).toBeLessThanOrEqual(client.core.seq);
      previous = client.core.seq;
    });
    expect(client.core.id === id).toBe(!expired);
    expect(client.core.token === token).toBe(!expired);
    expect(client.core.ready).toBe(true);
    expect(client.core.seq).toBeGreaterThan(seq + 120);
    expect(client.core.ack).toBeGreaterThan(seq + 120);
    const driver = net.server.world.byId(client.core.id)!;
    expect(driver.ack).toBeGreaterThan(seq + 120);
    expect(driver.state).toBe('active');
    expect(driver.violations).toBe(0);
    expect(client.conn!.violations).toBe(0);
    expect(net.server.playerCount).toBe(1);
    expect(client.teleports).toBeGreaterThan(teleports);
    expect(client.core.stats.maxCorrection).toBeLessThan(1e-6);
  });

  it.each([false, true])('boots against a fresh server (different ID: %s) without replaying old inputs or accepting future acks', differentId => {
    type Message = string | Uint8Array;
    const outgoing: Message[] = [], incoming: Message[] = [];
    let game = new GameServer({ seed: 5, map, token: () => 'old-token' });
    let conn: Conn;
    let teleports = 0;
    const core = new ClientCore(new Sim(mulberry32(7), { online: true, physics: 2, map }), {
      send: data => outgoing.push(typeof data === 'string' ? data : data.slice()),
      onTeleport: () => teleports++,
    });
    const receive = () => { for (const data of incoming.splice(0)) core.receive(data, game.world.tick * 1000 / 120); };
    const send = () => { for (const data of outgoing.splice(0)) conn.receive(data); };
    const open = (token?: string) => {
      conn = game.connect({ send: data => incoming.push(typeof data === 'string' ? data : data.slice()), close() {}, buffered: 0 });
      core.hello('A', 2, 2, token);
      send();
      receive();
    };
    const snapshot = () => {
      const writer = new Writer();
      game.world.writeSnapshot(conn.slot!.driver, writer);
      core.receive(writer.bytes(), game.world.tick * 1000 / 120);
    };
    const drive = (steps: number) => {
      for (let i = 0; i < steps; i++) {
        core.step({ steer: 0, throttle: 1, brake: 0 });
        core.flush();
        send();
        game.tick();
        receive();
      }
    };
    open();
    snapshot();
    drive(240);
    expect(core.ready).toBe(true);
    const { id, token, seq } = core;
    const replayed = core.stats.replayed;
    const teleported = teleports;
    conn!.close();
    core.disconnected();
    game = new GameServer({ seed: 6, map, token: () => 'fresh-token' });
    if (differentId) game.world.join('Other', 1);
    open(token);
    expect(core.id === id).toBe(!differentId);
    expect(core.token).toBe('fresh-token');
    expect(core.ready).toBe(false);
    expect(core.seq).toBe(seq);
    expect(core.ack).toBe(seq);
    expect(conn!.slot!.driver.ack).toBe(seq);
    expect(teleports).toBe(teleported);

    // Even while awaiting the first new-epoch snapshot, an impossible future ack stays rejected.
    const snapshots = core.stats.snapshots;
    game.world.resync(conn!.slot!.driver, seq + 1);
    snapshot();
    expect(core.ready).toBe(false);
    expect(core.stats.snapshots).toBe(snapshots);
    expect(core.seq).toBe(seq);
    game.world.resync(conn!.slot!.driver, seq);
    snapshot();
    expect(core.ready).toBe(true);
    expect(core.stats.snapshots).toBe(snapshots + 1);
    expect(core.stats.replayed).toBe(replayed);
    expect(teleports).toBe(teleported + 1);
    core.step({ steer: 0, throttle: 1, brake: 0 });
    expect(core.seq).toBe(seq + 1);
    core.flush();
    send();
    game.tick();
    receive();
    drive(239);
    expect(core.ready).toBe(true);
    expect(core.seq).toBe(seq + 240);
    expect(conn!.slot!.driver.ack).toBeGreaterThan(seq + 120);
    expect(core.ack).toBeGreaterThan(seq + 120);
    expect(conn!.violations).toBe(0);
    expect(conn!.slot!.driver.violations).toBe(0);
  });
});
