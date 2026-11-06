import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api } from '../server/api';
import { MIN_SCORE, Store, type RunRecord } from '../server/store';

const run = (over: Partial<RunRecord>): RunRecord => ({ mode: 'solo', name: 'A', score: 5000, car: 1, physics: 1, near: 10, topKmh: 250, seconds: 60, ...over });

describe('leaderboard store', () => {
  it("keeps each player's best run, best first, solo and online apart", () => {
    const s = new Store(':memory:');
    s.addRun(run({ name: 'Kira', score: 12000 }), 1);
    s.addRun(run({ name: 'kira', score: 30000 }), 2); // same player, any case
    s.addRun(run({ name: 'Max', score: 20000 }), 3);
    s.addRun(run({ name: 'Lena', score: 20000 }), 4); // tie: the earlier one ranks higher
    s.addRun(run({ name: 'Online', score: 99999, mode: 'online' }), 5);
    expect(s.addRun(run({ name: 'Tiny', score: MIN_SCORE - 1 }))).toBe(false);
    const solo = s.leaderboard('solo');
    expect(solo.map((e) => [e.rank, e.name, e.score])).toEqual([
      [1, 'kira', 30000],
      [2, 'Max', 20000],
      [3, 'Lena', 20000],
    ]);
    expect(s.leaderboard('online').map((e) => e.name)).toEqual(['Online']);
    s.close();
  });

  it('logs newest first and cuts long text', () => {
    const s = new Store(':memory:');
    s.log('server', 'warn', 'first');
    s.log('client', 'error', 'x'.repeat(2000), 'y'.repeat(9000));
    const rows = s.recentLogs(10);
    expect(rows[0].message.length).toBe(500);
    expect(rows[0].detail!.length).toBe(4000);
    expect(rows[1].message).toBe('first');
    expect(s.recentLogs(10, 'server').length).toBe(1);
    s.close();
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base = '';
  const store = new Store(':memory:');
  const api = new Api(store, { origins: [], log: () => {} });
  const post = (path: string, body: unknown, type = 'application/json') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    api.close();
    server.close();
    store.close();
  });

  it('takes a solo run, ranks it and serves the board', async () => {
    const res = await post('/api/runs', { name: ' Vell <b> ', score: 42000, car: 2, physics: 3, near: 31, topKmh: 288, seconds: 95 });
    expect(await res.json()).toEqual({ ok: true, stored: true, rank: 1 });
    const board = (await (await fetch(`${base}/api/leaderboard?mode=solo`)).json()) as { entries: { name: string; score: number }[] };
    expect(board.entries[0]).toMatchObject({ name: 'Vell b', score: 42000 });
    const online = (await (await fetch(`${base}/api/leaderboard?mode=online`)).json()) as { entries: unknown[] };
    expect(online.entries).toEqual([]);
  });

  it('turns away bad runs and non-JSON posts', async () => {
    expect((await post('/api/runs', { name: 'X', score: -5, car: 1, physics: 1, near: 0, topKmh: 0, seconds: 1 })).status).toBe(400);
    expect((await post('/api/runs', { name: 'X', score: 5000, car: 1, physics: 1, near: 0, topKmh: 9999, seconds: 1 })).status).toBe(400);
    expect((await post('/api/runs', { score: 5000 }, 'text/plain')).status).toBe(403);
    const big = await post('/api/log', { items: [{ msg: 'x'.repeat(20000) }] });
    expect(big.status).toBe(413);
  });

  it('keeps page reports small and rate-limited', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ level: 'error', msg: `boom ${i}`, count: 3 }));
    const res = await post('/api/log', { page: 'solo', ua: 'test', items });
    expect(await res.json()).toEqual({ ok: true, kept: 20 });
    expect(store.recentLogs(1, 'client')[0].message).toBe('[solo] boom 19 (×3)');
    // 10 posts per 10 minutes per address (one used above, one in the previous test).
    let last = 200;
    for (let i = 0; i < 10; i++) last = (await post('/api/log', { items: [{ msg: 'again' }] })).status;
    expect(last).toBe(429);
  });

  it('folds repeats of a server problem within a minute into one row', () => {
    for (let i = 0; i < 5; i++) api.diag('warn', 'slow tick', { ms: 9 });
    expect(store.recentLogs(50, 'server').filter((r) => r.message.startsWith('slow tick')).length).toBe(1);
  });
});
