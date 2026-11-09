import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Admin, trafficSettings } from '../server/admin';
import { Api } from '../server/api';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { MIN_SCORE, Store, type RunRecord } from '../server/store';
import { defaultTuning, applyTuning } from '../src/sim/tuning';

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
    // A player's own place among everyone (any letter case), and how many players a board has.
    expect(s.placeOn('solo', 'LENA')).toMatchObject({ rank: 3, name: 'Lena', score: 20000 });
    expect(s.placeOn('solo', 'kira')?.rank).toBe(1);
    expect(s.placeOn('online', 'Kira')).toBeNull();
    expect(s.playerCount('solo')).toBe(3);
    expect(s.playerCount('online')).toBe(1);
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
    expect(await res.json()).toEqual({ ok: true, map: 'highway', stored: true, rank: 1 });
    const board = (await (await fetch(`${base}/api/leaderboard?mode=solo`)).json()) as { entries: { name: string; score: number }[] };
    expect(board.entries[0]).toMatchObject({ name: 'Vell b', score: 42000 });
    const online = (await (await fetch(`${base}/api/leaderboard?mode=online`)).json()) as { entries: unknown[] };
    expect(online.entries).toEqual([]);
    const mine = (await (await fetch(`${base}/api/leaderboard?mode=solo&name=vell%20b`)).json()) as { total: number; me: { rank: number } | null };
    expect(mine).toMatchObject({ total: 1, me: { rank: 1 } });
    const nobody = (await (await fetch(`${base}/api/leaderboard?mode=online&name=Vell`)).json()) as { total: number; me: unknown };
    expect(nobody).toMatchObject({ total: 0, me: null });
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

describe('admin API', () => {
  let server: Server;
  let base = '';
  const store = new Store(':memory:');
  const game = new GameServer({ seed: 7 });
  const diag: string[] = [];
  const admin = new Admin({ password: 'correct horse battery', origins: [], game, store, health: () => ({ ok: true }), diag: (_l, m) => diag.push(m) });
  let token = '';
  const req = (path: string, body?: unknown, t = token) =>
    fetch(`${base}/api/admin/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${t}`, 'x-forwarded-for': '10.0.0.9' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** A socket that joins as a driver; `got` collects what the server sent it. */
  const peer = (addr: string) => {
    const got: string[] = [];
    let closed = false;
    const conn = game.connect({ send: (d) => typeof d === 'string' && got.push(d), close: () => (closed = true), buffered: 0, addr });
    conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name: 'Rude', physics: 1, car: 1, seq: 0 }));
    return { got, closed: () => closed };
  };

  beforeAll(async () => {
    server = createServer((rq, rs) => {
      if (!admin.handle(rq, rs)) rs.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    store.close();
  });

  it('is off without a password', async () => {
    const off = new Admin({ password: '', origins: [], game, store, health: () => ({}), diag: () => {} });
    const s = createServer((rq, rs) => void off.handle(rq, rs));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/admin/state`);
    expect(res.status).toBe(404);
    s.close();
  });

  it('wants the right password and a session for everything else', async () => {
    expect((await req('state')).status).toBe(401);
    expect((await req('login', { password: 'nope' })).status).toBe(401);
    const ok = await req('login', { password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    token = ((await ok.json()) as { token: string }).token;
    expect(token.length).toBeGreaterThan(30);
    const st = (await (await req('state')).json()) as { traffic: { on: boolean }; rules: { maxPlayers: number } };
    expect(st.traffic.on).toBe(true);
    expect(st.rules.maxPlayers).toBe(50);
    // Writes must be JSON.
    const form = await fetch(`${base}/api/admin/say`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${token}` }, body: 'x' });
    expect(form.status).toBe(403);
  });

  it('changes traffic and the player limit while the server runs', async () => {
    for (let i = 0; i < 240; i++) game.tick();
    expect((await req('traffic', { trafficOn: false })).status).toBe(200);
    expect(game.trafficState()).toMatchObject({ on: false, cars: 0 });
    const r = (await (await req('traffic', { trafficOn: true, mode: 'trucks' })).json()) as { traffic: object };
    expect(r.traffic).toMatchObject({ on: true, mode: 'trucks', held: true });
    expect((await req('traffic', { traffic: 2, intensity: .8 })).status).toBe(400);
    expect((await req('traffic', { mode: 'flying' })).status).toBe(400);
    // One mode's spawn density in cars per km of lane; kept in the database for the next start.
    const d = (await (await req('traffic', { modePerKm: { mode: 'dense', perKm: 30 } })).json()) as { traffic: { densities: { mode: string; perKm: number }[] } };
    expect(d.traffic.densities.find((x) => x.mode === 'dense')!.perKm).toBeCloseTo(30, 6);
    const saved = store.setting<{ traffic: number; mode: string; densities: Record<string, number> }>('traffic')!;
    expect(saved).toMatchObject({ mode: 'trucks' });
    expect(saved.densities.dense).toBe(30);
    expect((await req('players', { maxPlayers: 12 })).status).toBe(200);
    expect(game.world.rules.maxPlayers).toBe(12);
    expect((await req('players', { maxPlayers: 500 })).status).toBe(400);
    // Forwarded headers from an untrusted direct client cannot forge the audit identity.
    expect(diag.some((m) => m.includes('traffic') && m.includes('127.0.0.1'))).toBe(true);
    expect(diag.some((m) => m.includes('10.0.0.9'))).toBe(false);
  });

  it('accepts the full density range, preserves zero, and restores absolute targets after restart', async () => {
    for (const value of [0, 80]) {
      const res = await req('traffic', { modePerKm: { mode: 'sparse', perKm: value } });
      expect(res.status).toBe(200);
      expect(game.trafficState().densities.find(d => d.mode === 'sparse')!.perKm).toBe(value);
    }
    for (const perKm of [-1, 80.1, '80', null]) {
      expect((await req('traffic', { modePerKm: { mode: 'sparse', perKm } })).status).toBe(400);
    }
    game.configure({ traffic: 1, intensity: 0 });
    expect(game.trafficState().densities.find(d => d.mode === 'sparse')!.perKm).toBe(80);
    const restored = new GameServer({ seed: 8 });
    restored.configure(trafficSettings(game));
    expect(restored.trafficState().densities).toEqual(game.trafficState().densities);
    restored.configure({ mode: 'sparse' });
    expect(restored.world.traffic.targetCount()).toBeGreaterThan(106);
  });

  it('persists global car/speed settings and resets only the selected group to shipped defaults', async () => {
    const defaults = defaultTuning();
    try {
      expect((await req('tuning', { car: '3', values: { ...defaults.cars['3'], powerKW: 600, brakeDecel: 20 } })).status).toBe(200);
      expect((await req('tuning', { car: '4', values: { ...defaults.cars['4'], powerKW: 500 } })).status).toBe(200);
      expect(game.tuning.cars['3'].powerKW).toBe(600);
      expect(store.setting<{ cars: Record<string, { powerKW: number }> }>('tuning')!.cars['3'].powerKW).toBe(600);
      expect((await req('tuning', { resetCar: '3' })).status).toBe(200);
      expect(game.tuning.cars['3']).toEqual(defaults.cars['3']); expect(game.tuning.cars['4'].powerKW).toBe(500);
      expect((await req('tuning', { car: '__proto__', values: {} })).status).toBe(400);
      expect((await req('tuning', { car: '3', values: { ...defaults.cars['3'], powerKW: -100 } })).status).toBe(400);
      expect((await req('tuning', { traffic: { ...defaults.traffic, lanes: [[50,60],[40,50],[30,40],[20,30]] } })).status).toBe(200);
      expect(game.tuning.traffic.lanes[0]).toEqual([50,60]);
      expect((await req('tuning', { resetTraffic: true })).status).toBe(200);
      expect(game.tuning.traffic).toEqual(defaults.traffic);
      expect((await req('tuning', { resetCar: '4' })).status).toBe(200);
    } finally { applyTuning(defaults); game.setTuning(defaults); }
  });

  it('kicks a driver, keeps the address out while banned, lets it back after unban', async () => {
    const a = peer('203.0.113.5');
    const id = (JSON.parse(a.got.find((m) => m.includes('"welcome"'))!) as { id: number }).id;
    expect((await req('kick', { id, banMinutes: 30 })).status).toBe(200);
    expect(a.closed()).toBe(true);
    expect(a.got.some((m) => m.includes('"kicked"'))).toBe(true);
    expect(game.world.byId(id)).toBeUndefined();
    const again = peer('203.0.113.5');
    expect(again.got.some((m) => m.includes('"banned"'))).toBe(true);
    expect((await req('unban', { addr: '203.0.113.5' })).status).toBe(200);
    expect(peer('203.0.113.5').got.some((m) => m.includes('"welcome"'))).toBe(true);
    expect((await req('kick', { id: 999 })).status).toBe(404);
  });

  it('removes a player from a leaderboard and serves the log', async () => {
    store.addRun(run({ name: 'Cheater', score: 9_999_999 }));
    store.addRun(run({ name: 'cheater', score: 50_000 }));
    store.addRun(run({ name: 'Honest', score: 40_000 }));
    const r = (await (await req('board/remove', { mode: 'solo', name: 'CHEATER' })).json()) as { removed: number };
    expect(r.removed).toBe(2);
    const board = (await (await req('board?mode=solo')).json()) as { entries: { name: string }[] };
    expect(board.entries.map((e) => e.name)).toEqual(['Honest']);
    store.log('client', 'error', '[solo] boom');
    const logs = (await (await req('logs?source=client')).json()) as { rows: { message: string }[] };
    expect(logs.rows[0].message).toBe('[solo] boom');
  });

  it('turns away a password guesser after 8 tries from one address', async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (
        await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify({ password: `guess${i}` }) })
      ).status;
    }
    expect(last).toBe(429);
  });
});
