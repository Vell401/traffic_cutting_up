import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Api, claimDatabaseMap } from '../server/api';
import { Store, type RunRecord } from '../server/store';
import { GameServer } from '../src/online/gameServer';
import type { ServerMsg } from '../src/online/protocol';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { replay, type Driver, type Stimulus } from '../src/online/world';
import type { SimEvents } from '../src/sim/events';
import type { MapId } from '../src/sim/maps';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(map: MapId) {
  const root = join(tmpdir(), 'opencode');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'final-run-'));
  const path = join(directory, 'traffic.db');
  claimDatabaseMap(path, map);
  const store = new Store(path);
  const db = new DatabaseSync(path);
  const calls: { record: RunRecord; run: SimEvents['runEnd'] }[] = [];
  const journal: Stimulus[] = [];
  let nextToken = 0;
  const game = new GameServer({
    seed: 13, map, rules: { reconnectSeconds: 2 }, token: () => `token-${++nextToken}`,
    journal: entry => journal.push(entry),
    onRun: (driver, run) => {
      // The same authoritative persistence boundary used by server/main.ts.
      const record: RunRecord = { mode: 'online', name: driver.name, score: run.score, car: driver.body, physics: driver.physics, near: run.near, topKmh: run.topKmh, seconds: run.time };
      calls.push({ record, run: { ...run } });
      store.addRun(record);
    },
  });
  game.world.traffic.enabled = false;
  const api = new Api(store, { map, origins: [], log() {} });
  const server: Server = createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  cleanups.push(async () => {
    api.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = (token?: string, physics = 5, car = 2) => {
    const messages: ServerMsg[] = [];
    const conn = game.connect({ addr: '192.0.2.13', buffered: 0, close() {}, send(data) { if (typeof data === 'string') messages.push(JSON.parse(data)); } });
    conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map, rules: rulesHash(map), name: 'Authoritative driver', physics, car, token }));
    return { conn, messages, driver: conn.slot!.driver, token: conn.slot!.token };
  };
  const advance = (ticks: number) => { for (let i = 0; i < ticks; i++) game.tick(); };
  const rowCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n);
  const board = async () => {
    const response = await fetch(`${base}/api/leaderboard?mode=online`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-map-id')).toBe(map);
    return (await response.json() as { entries: RunRecord[] }).entries;
  };
  return { game, store, calls, journal, open, advance, rowCount, board };
}

function scored(driver: Driver) {
  Object.assign(driver.score, { score: 12345.9, best: 14000, near: 7, topKmh: 231.7, runTime: 45.25 });
}

describe.each(['highway', 'miami'] as const)('%s permanent run persistence', map => {
  it.each(['expiry', 'kick', 'ban', 'connected vehicle change', 'offline vehicle change'] as const)('stores the current run exactly once on %s', async reason => {
    const f = await fixture(map);
    const original = f.open();
    scored(original.driver);
    const started = Date.now();
    expect(await f.board()).toEqual([]);
    if (reason === 'expiry') {
      original.conn.close();
      f.advance(239);
      expect(f.calls).toHaveLength(0);
      expect(f.game.world.byId(original.driver.id)).toBe(original.driver);
      f.advance(1);
    } else if (reason === 'kick' || reason === 'ban') {
      expect(f.game.kickDriver(original.driver.id, reason === 'ban' ? 5 : 0)).toBe(original.driver.name);
      if (reason === 'ban') expect(f.game.bans.get('192.0.2.13')).toBeGreaterThan(Date.now());
    } else {
      if (reason === 'offline vehicle change') original.conn.close();
      const replacement = f.open(original.token, 4, 4);
      expect(replacement.driver).not.toBe(original.driver);
      expect(replacement.driver.score.score).toBe(0);
    }
    expect(f.game.world.byId(original.driver.id)).toBeUndefined();
    expect(f.calls).toEqual([{
      record: { mode: 'online', name: original.driver.name, score: 12345, car: 2, physics: 5, near: 7, topKmh: 231.7, seconds: 45.25 },
      run: { score: 12345, best: 14000, newBest: false, near: 7, topKmh: 231.7, time: 45.25 },
    }]);
    const entries = await f.board();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: original.driver.name, score: 12345, car: 2, physics: 5, near: 7, topKmh: 232, seconds: 45.3 });
    expect(entries[0]).toHaveProperty('at', expect.any(Number));
    const at = (entries[0] as unknown as { at: number }).at;
    expect(at).toBeGreaterThanOrEqual(started);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(f.game.kickDriver(original.driver.id)).toBeNull();
    original.conn.close();
    f.advance(480);
    expect(f.calls).toHaveLength(1);
    expect(f.rowCount()).toBe(1);
  });

  it.each(['offline reconnect', 'live replacement', 'cosmetic body change'] as const)('keeps %s in the same unsubmitted run', async reason => {
    const f = await fixture(map);
    const original = f.open();
    scored(original.driver);
    if (reason !== 'live replacement') original.conn.close();
    f.advance(120);
    const replacement = f.open(original.token, 5, reason === 'cosmetic body change' ? 4 : 2);
    expect(replacement.driver).toBe(original.driver);
    expect(replacement.token).toBe(original.token);
    expect(replacement.driver.score.score).toBe(12345.9);
    expect(f.calls).toHaveLength(0);
    expect(f.rowCount()).toBe(0);
    original.conn.close();
    f.advance(240);
    expect(f.calls).toHaveLength(0);
    expect(f.game.playerCount).toBe(1);
    replacement.conn.close();
    f.advance(240);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].record.car).toBe(reason === 'cosmetic body change' ? 4 : 2);
    expect(f.rowCount()).toBe(1);
  });

  it.each(['crash', 'respawn'] as const)('does not finalize an already ended %s run twice', async reason => {
    const f = await fixture(map);
    const original = f.open();
    scored(original.driver);
    if (reason === 'crash') {
      original.driver.score.grace = 0;
      expect(original.driver.score.onCrash()).toBe(true);
    } else original.conn.receive(JSON.stringify({ t: 'respawn' }));
    expect(f.calls).toHaveLength(1);
    expect(original.driver.score.score).toBe(0);
    f.game.kickDriver(original.driver.id);
    f.advance(240);
    expect(f.calls).toHaveLength(1);
    expect(f.rowCount()).toBe(1);
    expect(original.messages.filter(message => message.t === 'ev' && message.name === 'runEnd')).toHaveLength(1);
  });

  it('does not emit a runEnd or record for an untouched driver', async () => {
    const f = await fixture(map);
    const observer = f.open();
    const original = f.open();
    observer.messages.length = 0;
    f.game.kickDriver(original.driver.id);
    expect(f.calls).toHaveLength(0);
    expect(f.rowCount()).toBe(0);
    expect(observer.messages.filter(message => message.t === 'feed' && message.text.includes('рекорд'))).toHaveLength(0);
    expect(original.messages.filter(message => message.t === 'ev' && message.name === 'runEnd')).toHaveLength(0);
  });

  it('persists a genuinely new run after a crash without repeating the crashed run', async () => {
    const f = await fixture(map);
    const original = f.open();
    scored(original.driver);
    original.driver.score.grace = 0;
    original.driver.score.onCrash();
    Object.assign(original.driver.score, { score: 15000.8, near: 3, topKmh: 220, runTime: 50 });
    f.game.kickDriver(original.driver.id);
    expect(f.calls.map(call => call.record.score)).toEqual([12345, 15000]);
    expect(f.calls[1].run).toMatchObject({ best: 15000, newBest: true, time: 50, near: 3 });
    expect(f.rowCount()).toBe(2);
    expect(await f.board()).toMatchObject([{ score: 15000, car: 2, physics: 5 }]);
  });

  it('retains the existing leave journal and deterministic replay', async () => {
    const f = await fixture(map);
    const original = f.open();
    scored(original.driver);
    f.open();
    f.advance(10);
    f.game.kickDriver(original.driver.id);
    const rebuilt = replay(13, { reconnectSeconds: 2 }, f.journal, f.game.world.tick, world => { world.traffic.enabled = false; }, map);
    expect(f.journal.filter(entry => entry.k === 'leave')).toEqual([{ k: 'leave', t: 10, id: original.driver.id }]);
    expect(rebuilt.hash()).toBe(f.game.world.hash());
    expect(f.calls).toHaveLength(1);
  });
});
