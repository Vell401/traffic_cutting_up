import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import type { ServerMsg } from '../src/online/protocol';

function open(game: GameServer) {
  const messages: ServerMsg[] = [];
  const close = vi.fn();
  const conn = game.connect({
    send(data) { if (typeof data === 'string') messages.push(JSON.parse(data)); },
    close,
    buffered: 0,
  });
  return { conn, close, messages };
}

function hello(game: GameServer, client: ReturnType<typeof open>, token?: string) {
  client.conn.receive(JSON.stringify({
    t: 'hello', v: PROTOCOL_VERSION, map: game.world.map.id,
    rules: rulesHash(game.world.map.id), name: 'Driver', physics: 2, car: 2, seq: 0, token,
  }));
  return client.messages.find((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
}

function ticks(game: GameServer, count: number) {
  for (let i = 0; i < count; i++) game.tick();
}

describe.each(['highway', 'miami'] as const)('%s WebSocket admission', map => {
  function server(maxPlayers = 1) {
    const game = new GameServer({ seed: 171, map, rules: { maxPlayers }, token: () => 'reconnect-secret' });
    game.world.traffic.enabled = false;
    return game;
  }

  it('bounds 250 pending sockets independently of joined players and releases closed entries', () => {
    const game = server();
    const clients = Array.from({ length: 250 }, () => open(game));
    expect(game.connectionLimit).toBe(18);
    expect(game.connectionCount).toBe(18);
    expect(game.canConnect).toBe(false);
    expect(game.playerCount).toBe(0);
    expect(game.world.drivers).toHaveLength(0);
    for (const client of clients.slice(18)) {
      expect(client.conn.closed).toBe(true);
      expect(client.close).toHaveBeenCalledExactlyOnceWith(1013, 'connections');
      expect(hello(game, client)).toBeUndefined();
    }
    clients[0].conn.close();
    clients[0].conn.close();
    expect(game.connectionCount).toBe(17);
    expect(game.canConnect).toBe(true);
    const replacement = open(game);
    expect(replacement.conn.closed).toBe(false);
    expect(game.connectionCount).toBe(18);
    game.closeAll('test');
    expect(game.connectionCount).toBe(0);
  });

  it('expires silent and ping-answering pending peers at their own exact logical hello deadline', () => {
    const game = server();
    ticks(game, 7); // Deadline is relative to connect, not rounded to housekeeping seconds.
    const active = open(game);
    const welcome = hello(game, active)!;
    const pending = Array.from({ length: 17 }, () => open(game));
    const deadline = 5 * game.world.rules.tickHz;
    for (let i = 0; i < deadline - 1; i++) {
      // Application ping traffic must not renew the hello lease; WS pong never reaches Conn.
      for (const client of pending.slice(1)) client.conn.receive('{"t":"ping","c":1}');
      game.tick();
    }
    expect(pending.every(client => !client.conn.closed)).toBe(true);
    expect(pending[1].messages.some(m => m.t === 'pong')).toBe(true);
    game.tick();
    for (const client of pending) {
      expect(client.conn.closed).toBe(true);
      expect(client.close).toHaveBeenCalledExactlyOnceWith(1008, 'hello timeout');
      expect(hello(game, client, welcome.token)).toBeUndefined();
    }
    expect(game.connectionCount).toBe(1);
    expect(active.conn.closed).toBe(false);
    expect(game.playerCount).toBe(1);
    // Regression: even after 70 seconds, ping-responsive non-players cannot linger.
    ticks(game, 65 * game.world.rules.tickHz);
    expect(game.connectionCount).toBe(1);
    expect(game.world.drivers).toHaveLength(1);
    const reconnect = open(game);
    expect(hello(game, reconnect, welcome.token)?.id).toBe(welcome.id);
    expect(active.conn.closed).toBe(true);
    expect(game.connectionCount).toBe(1);
  });

  it('allows full-server replacement and offline reconnects with pending headroom, but no new player', () => {
    const game = server();
    const first = open(game);
    const welcome = hello(game, first)!;
    const driver = game.world.drivers[0];
    const pending = Array.from({ length: 15 }, () => open(game));
    const newcomer = open(game);
    expect(hello(game, newcomer)).toBeUndefined();
    expect(newcomer.messages).toContainEqual(expect.objectContaining({ t: 'reject', reason: 'full' }));
    expect(newcomer.conn.closed).toBe(true);
    const replacement = open(game);
    expect(hello(game, replacement, welcome.token)?.id).toBe(welcome.id);
    expect(first.conn.closed).toBe(true);
    expect(game.world.drivers[0]).toBe(driver);
    expect(game.playerCount).toBe(1);
    expect(game.connectionCount).toBe(16);
    replacement.conn.close();
    ticks(game, 5 * game.world.rules.tickHz);
    expect(pending.every(client => client.conn.closed)).toBe(true);
    expect(game.connectionCount).toBe(0);
    expect(game.playerCount).toBe(1); // Pending expiry must not discard reserved driver slots.
    const reconnect = open(game);
    expect(hello(game, reconnect, welcome.token)?.id).toBe(welcome.id);
    expect(game.world.drivers[0]).toBe(driver);
    expect(game.connectionCount).toBe(1);
  });

  it('accepts a valid hello just before the deadline and does not expire the joined socket', () => {
    const game = server();
    const client = open(game);
    ticks(game, 5 * game.world.rules.tickHz - 1);
    expect(hello(game, client)).toBeDefined();
    ticks(game, 5 * game.world.rules.tickHz);
    expect(client.close).not.toHaveBeenCalled();
    expect(game.connectionCount).toBe(1);
  });

  it('removes expired connections even if the transport close throws', () => {
    const game = server();
    const client = open(game);
    client.close.mockImplementation(() => { throw new Error('transport failed'); });
    ticks(game, 5 * game.world.rules.tickHz - 1);
    expect(() => game.tick()).toThrow('transport failed');
    expect(client.conn.closed).toBe(true);
    expect(game.connectionCount).toBe(0);
    expect(game.canConnect).toBe(true);
    expect(hello(game, open(game))).toBeDefined();
  });

  it.each([NaN, Infinity, -1, 1000000])('keeps malformed/oversized player limit %s bounded', max => {
    const game = server(max);
    const clients = Array.from({ length: 250 }, () => open(game));
    expect(game.connectionCount).toBeLessThanOrEqual(144);
    expect(clients.filter(client => !client.conn.closed)).toHaveLength(game.connectionLimit);
    expect(game.canConnect).toBe(false);
  });

  it('rejects excess sockets before upgrade, expires pending transports and admits reconnects in Node', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const dir = mkdtempSync(join(tmpdir(), 'ws-admission-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env, MAP_ID: map, HOST: '127.0.0.1', PORT: String(port), MAX_PLAYERS: '1',
        DB_PATH: join(dir, 'game.db'), RADIO_DIR: join(dir, 'radio'), JOURNAL_DIR: '',
        ADMIN_PASSWORD: '', ORIGINS: 'https://admission.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sockets: WebSocket[] = [];
    let output = '';
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('listening on')) resolve();
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(output)));
      });
      const url = `ws://127.0.0.1:${port}/ws`;
      await Promise.all(Array.from({ length: 18 }, async () => {
        const ws = new WebSocket(url, { origin: 'https://admission.test' });
        sockets.push(ws);
        await once(ws, 'open');
      }));
      const statuses = await Promise.all(Array.from({ length: 232 }, () => new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(url, { origin: 'https://admission.test' });
        sockets.push(ws);
        ws.once('open', () => reject(new Error('excess socket upgraded')));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => {
          resolve(res.statusCode!);
          res.resume();
          ws.terminate();
        });
      })));
      expect(statuses).toEqual(Array(232).fill(503));
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health).toMatchObject({ map, connections: 18, players: 0 });
      const welcome = new Promise<ServerMsg>((resolve, reject) => {
        sockets[0].on('message', (data, binary) => {
          if (binary) return;
          const msg = JSON.parse(data.toString()) as ServerMsg;
          if (msg.t === 'welcome') resolve(msg);
          if (msg.t === 'reject') reject(new Error(msg.reason));
        });
      });
      sockets[0].send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map, rules: rulesHash(map), name: 'Driver', physics: 2, car: 2 }));
      const joined = await welcome;
      expect(joined).toMatchObject({ t: 'welcome', map });
      if (joined.t !== 'welcome') throw new Error('missing welcome');
      // WS clients automatically answer transport pings; that is not a game hello.
      await Promise.all(sockets.slice(1, 18).map(ws => once(ws, 'close')));
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({ connections: 1, players: 1 });
      const reconnect = new WebSocket(url, { origin: 'https://admission.test' });
      sockets.push(reconnect);
      await once(reconnect, 'open');
      const resumed = once(reconnect, 'message');
      reconnect.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map, rules: rulesHash(map), token: joined.token, physics: 2, car: 2 }));
      expect(JSON.parse((await resumed)[0].toString())).toMatchObject({ t: 'welcome', id: joined.id });
    } finally {
      for (const ws of sockets) ws.terminate();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
