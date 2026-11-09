import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Admin } from '../server/admin';
import { Api } from '../server/api';
import { Store } from '../server/store';
import { GameServer } from '../src/online/gameServer';

// All assertions exercise HTTP handlers backed by actual SQLite, not just the parser.
describe('HTTP query limits', () => {
  let store: Store;
  let api: Api;
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    store = new Store(':memory:');
    for (const mode of ['solo', 'online'] as const) {
      for (let i = 0; i < 105; i++) store.addRun({ mode, name: `Driver ${i}`, score: 10000 + i, car: 1, physics: 1, near: 1, topKmh: 100, seconds: 30 });
    }
    for (let i = 0; i < 5010; i++) store.log(i % 2 ? 'client' : 'server', 'info', `Message ${i}`);
    api = new Api(store, { origins: [], log() {} });
    const game = new GameServer({ seed: 1 });
    const admin = new Admin({ password: 'test', origins: [], game, store, health: () => ({}), diag() {} });
    server = createServer((req, res) => {
      if (!admin.handle(req, res) && !api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test' }) });
    expect(response.status).toBe(200);
    token = ((await response.json()) as { token: string }).token;
  });

  afterAll(async () => {
    api?.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store?.close();
  });

  const cases = [
    [undefined, null], ['', null], ['0', null], ['NaN', null], ['Infinity', null], ['-Infinity', null], ['1e309', null], ['garbage', null],
    ['1.5', 1], ['2.9', 2], ['0.5', 1], ['-1.5', 1], ['-999999', 1], ['1e-300', 1], ['1e2', 100], ['1e300', Infinity],
    ['9007199254740993', Infinity], ['9'.repeat(400), null], ['3', 3],
  ] as const;

  for (const route of [
    { path: '/api/leaderboard', field: 'entries', fallback: 10, max: 100 },
    { path: '/api/admin/board', field: 'entries', fallback: 50, max: 100 },
    { path: '/api/admin/logs', field: 'rows', fallback: 200, max: 5000 },
  ]) {
    it(`normalizes fractional, non-finite and extreme limits on ${route.path}`, async () => {
      for (const [value, normalized] of cases) {
        const query = new URLSearchParams({ mode: 'online', name: 'Driver 0' });
        if (value !== undefined) query.set('limit', value);
        const response = await fetch(`${base}${route.path}?${query}`, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status, `${route.path}: ${value}`).toBe(200);
        const body = await response.json() as Record<string, unknown[]>;
        expect(body[route.field], `limit=${value}`).toHaveLength(normalized === null ? route.fallback : Math.min(route.max, normalized));
        if (route.path === '/api/leaderboard') {
          expect(response.headers.get('x-map-id')).toBe('highway');
          expect(body).toMatchObject({ map: 'highway', mode: 'online', total: 105, me: { name: 'Driver 0', rank: 105 } });
        }
        // A normal request after every hostile value must still succeed.
        expect((await fetch(`${base}/api/map`)).status).toBe(200);
      }
    });
  }

  it('preserves authenticated log filtering and public access', async () => {
    expect((await fetch(`${base}/api/admin/logs?limit=1.5`)).status).toBe(401);
    const logs = await fetch(`${base}/api/admin/logs?limit=2.9&source=client`, { headers: { authorization: `Bearer ${token}` } });
    expect(await logs.json()).toMatchObject({ ok: true, rows: [{ source: 'client' }, { source: 'client' }] });
    expect((await fetch(`${base}/api/leaderboard?limit=1.5`)).status).toBe(200);
  });
});

describe('production server survives hostile query limits', () => {
  let child: ChildProcess;
  let directory: string;
  let base: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'traffic-query-limits-'));
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MAP_ID: 'highway', DB_PATH: join(directory, 'traffic.db'), RADIO_DIR: join(directory, 'radio'), ADMIN_PASSWORD: 'test', JOURNAL_DIR: '', TRAFFIC: '1', INTENSITY: '0', LOG_EVERY: '3600', ORIGINS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
      child.stderr!.on('data', chunk => { output += String(chunk); });
      child.stdout!.on('data', chunk => {
        output += String(chunk);
        if (output.includes('listening on')) { clearTimeout(timeout); resolve(); }
      });
    });
  }, 20000);

  afterAll(async () => {
    if (child && child.exitCode === null) await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill();
    });
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the started main process healthy after public and authenticated requests', async () => {
    const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test' }) });
    expect(login.status).toBe(200);
    const { token } = await login.json() as { token: string };
    for (const path of ['/api/leaderboard', '/api/admin/board', '/api/admin/logs']) {
      for (const limit of ['1.5', 'NaN', 'Infinity', '-Infinity', '1e309', '1e300', '-2.5', '0', '9'.repeat(400)]) {
        const response = await fetch(`${base}${path}?limit=${encodeURIComponent(limit)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
        expect(response.status, `${path}?limit=${limit}`).toBe(200);
        await response.json();
      }
    }
    // The uncaught-exception shutdown is delayed, so check health after that delay too.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).status).toBe(200);
  }, 15000);
});
