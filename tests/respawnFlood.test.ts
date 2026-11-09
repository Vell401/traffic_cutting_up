import { describe, expect, it, vi } from 'vitest';
import { GameServer, type Peer } from '../src/online/gameServer';
import { Writer, writeInputs, type ServerMsg } from '../src/online/protocol';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import type { MapId } from '../src/sim/maps';

class TestPeer implements Peer {
  buffered = 0;
  texts: string[] = [];
  close = vi.fn();
  send(data: Uint8Array | string): void {
    if (typeof data === 'string') this.texts.push(data);
  }
  messages(): ServerMsg[] { return this.texts.map(text => JSON.parse(text)); }
}

function join(game: GameServer, name: string, token?: string) {
  const peer = new TestPeer();
  const conn = game.connect(peer);
  conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map: game.world.map.id,
    rules: rulesHash(game.world.map.id), name, physics: 2, car: 2, token }));
  const welcome = peer.messages().find((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome')!;
  return { conn, peer, welcome, driver: game.world.byId(welcome.id)! };
}

const respawn = JSON.stringify({ t: 'respawn' });
const idle = { steer: 0, throttle: 0, brake: 0, flags: 0 };

describe.each<MapId>(['highway', 'miami'])('respawn flood admission on %s', map => {
  it('bounds 400 same-second actions to one respawn, at most 21 JSON sends and 24 KiB for ten players', () => {
    const onRun = vi.fn();
    const game = new GameServer({ seed: 9, map, onRun });
    game.world.traffic.enabled = false;
    const clients = Array.from({ length: 10 }, (_, i) => join(game, `Player ${i}`));
    const attacker = clients[0];
    // Open a fresh message-rate window while keeping the attacking driver active.
    for (let tick = 1; tick <= game.world.rules.tickHz; tick++) {
      game.world.input(attacker.driver, tick, [idle], 1);
      game.tick();
    }
    clients.forEach(c => { c.peer.texts.length = 0; });
    const epoch = attacker.driver.epoch;
    const worldRespawn = vi.spyOn(game.world, 'respawn');
    for (let i = 0; i < 400; i++) attacker.conn.receive(respawn);
    const texts = clients.flatMap(c => c.peer.texts);
    const bytes = texts.reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0);
    expect(attacker.conn.closed).toBe(false);
    expect(worldRespawn).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(attacker.driver.epoch).toBe(epoch + 1);
    expect(texts.length).toBeLessThanOrEqual(21);
    expect(bytes).toBeLessThan(24 * 1024);
    expect(clients.slice(1).every(c => c.peer.messages().filter(m => m.t === 'players').length <= 1)).toBe(true);
    console.info(`${map}: 400 respawn messages => ${texts.length} JSON sends, ${bytes} bytes`);
  });

  it('allows independent drivers and a later legitimate respawn at the cooldown boundary', () => {
    const game = new GameServer({ seed: 10, map });
    game.world.traffic.enabled = false;
    const a = join(game, 'A'), b = join(game, 'B');
    const worldRespawn = vi.spyOn(game.world, 'respawn');
    a.conn.receive(respawn);
    b.conn.receive(respawn);
    expect(worldRespawn).toHaveBeenCalledTimes(2);
    for (let tick = 1; tick < game.world.rules.tickHz; tick++) {
      game.world.input(a.driver, tick, [idle], 1);
      game.tick();
    }
    a.driver.car.s = game.world.map.spawn.s + 100;
    const epoch = a.driver.epoch;
    a.conn.receive(respawn);
    expect(a.driver.car.s).toBe(game.world.map.spawn.s + 100);
    expect(a.driver.epoch).toBe(epoch);
    game.world.input(a.driver, game.world.rules.tickHz, [idle], 1);
    game.tick();
    a.conn.receive(respawn);
    expect(worldRespawn).toHaveBeenCalledTimes(3);
    expect(a.driver.car.s).toBe(game.world.map.spawn.s);
    expect(a.driver.car.d).toBe(game.world.map.spawn.d);
    expect(a.driver.car.vAlong).toBe(0);
    expect(a.driver.epoch).toBe(epoch + 1);
  });

  it('does not let a reconnect reset a driver cooldown', () => {
    let token = 0;
    const game = new GameServer({ seed: 11, map, token: () => `token-${++token}` });
    const a = join(game, 'A');
    const worldRespawn = vi.spyOn(game.world, 'respawn');
    a.conn.receive(respawn);
    a.conn.close();
    const reconnected = join(game, 'A', a.welcome.token);
    const epoch = a.driver.epoch;
    reconnected.conn.receive(respawn);
    expect(reconnected.driver).toBe(a.driver);
    expect(worldRespawn).toHaveBeenCalledTimes(1);
    expect(a.driver.epoch).toBe(epoch);
  });

  it('ignores backed-up respawns before side effects and accepts one when the buffer drains', () => {
    const onRun = vi.fn();
    const game = new GameServer({ seed: 12, map, onRun });
    const a = join(game, 'A');
    a.peer.texts.length = 0;
    a.peer.buffered = 256 * 1024 + 1;
    const epoch = a.driver.epoch;
    const worldRespawn = vi.spyOn(game.world, 'respawn');
    for (let i = 0; i < 398; i++) a.conn.receive(respawn);
    expect(worldRespawn).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    expect(a.driver.epoch).toBe(epoch);
    expect(a.peer.texts).toHaveLength(0);
    a.peer.buffered = 0;
    a.conn.receive(respawn);
    expect(worldRespawn).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('keeps away/return input-driven and does not consume a cooldown for an away request', () => {
    const game = new GameServer({ seed: 13, map });
    game.world.traffic.enabled = false;
    const a = join(game, 'A');
    const worldRespawn = vi.spyOn(game.world, 'respawn');
    for (let i = 0; i <= game.world.rules.awaySeconds * game.world.rules.tickHz; i++) game.tick();
    expect(a.driver.state).toBe('away');
    const epoch = a.driver.epoch;
    a.peer.texts.length = 0;
    a.conn.receive(respawn);
    expect(worldRespawn).not.toHaveBeenCalled();
    expect(a.driver.epoch).toBe(epoch);
    expect(a.peer.texts).toHaveLength(0);
    const writer = new Writer();
    writeInputs(writer, 1, [idle], 0, 1);
    a.conn.receive(writer.bytes());
    game.tick();
    expect(a.driver.state).toBe('active');
    expect(a.driver.epoch).toBe(epoch + 1);
    a.conn.receive(respawn);
    expect(worldRespawn).toHaveBeenCalledTimes(1);
    expect(a.driver.car.s).toBe(game.world.map.spawn.s);
  });
});
