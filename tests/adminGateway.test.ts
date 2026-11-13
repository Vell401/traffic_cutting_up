import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Admin } from '../server/admin';
import { AdminGateway } from '../server/adminGateway';
import { GameServer } from '../src/online/gameServer';
import { Store } from '../server/store';
import { RadioStore } from '../server/radio';
import { send } from '../server/api';

const password = 'fixture internal password only';
const origin = 'https://admin.test';
const prefix = '/api/admin/maps/miami/';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function fixture(options: { url?: (url: string) => string | undefined; timeoutMs?: number } = {}) {
  const seen: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
  const diagnostics: string[] = [];
  const store = new Store(':memory:'), centralStore = new Store(':memory:');
  cleanup.push(() => { store.close(); centralStore.close(); });
  const directory = mkdtempSync(join(tmpdir(), 'admin-gateway-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const game = new GameServer({ map: 'miami', seed: 1 });
  const centralGame = new GameServer({ map: 'highway', seed: 2 });
  const radio = new RadioStore(store, directory);
  const service = new Admin({ password, origins: [origin], game, store, radio, health: () => ({ map: 'miami' }), diag: (_level, text) => diagnostics.push(text) });
  const admin = new Admin({ password: 'central fixture password', origins: [origin], game: centralGame, store: centralStore, health: () => ({ map: 'highway' }), diag() {} });
  let intercept: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const upstream = await listen((req, res) => {
    seen.push({ path: req.url!, headers: req.headers });
    res.setHeader('x-map-id', 'miami');
    if (intercept?.(req, res)) return;
    if (req.url === '/health') { send(res, 200, { ok: true, map: 'miami' }); return; }
    if (!service.handle(req, res)) res.writeHead(404).end();
  });
  const gateway = new AdminGateway({ admin, url: options.url ? options.url(upstream.url) : upstream.url, password, timeoutMs: options.timeoutMs ?? 1000 });
  const central = await listen((req, res) => {
    res.setHeader('x-map-id', 'highway');
    if (!gateway.handle(req, res) && !admin.handle(req, res)) res.writeHead(404).end();
  });
  const login = await fetch(`${central.url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'central fixture password' }) });
  const { token } = await login.json() as { token: string };
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => fetch(central.url + prefix + path, {
    method, headers: { authorization: `Bearer ${token}`, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  return { ...central, upstream, seen, game, centralGame, store, radio, token, call, diagnostics, intercept: (handler: typeof intercept) => { intercept = handler; } };
}

describe('authorized Miami gateway', () => {
  it('uses one central login for isolated Miami reads and mutations without forwarding browser identity', async () => {
    const f = await fixture();
    const state = await f.call('state', undefined, { 'x-forwarded-for': '198.51.100.8', forwarded: 'for=198.51.100.8', 'x-real-ip': '198.51.100.8', cookie: 'browser=secret' });
    expect(state.status).toBe(200); expect(state.headers.get('x-map-id')).toBe('miami');
    expect(await state.json()).toMatchObject({ map: 'miami' });
    expect((await f.call('players', { maxPlayers: 12 })).status).toBe(200);
    expect(f.game.world.rules.maxPlayers).toBe(12); expect(f.centralGame.world.rules.maxPlayers).not.toBe(12);
    expect(f.seen.filter(x => x.path === '/api/admin/login')).toHaveLength(1);
    for (const { headers } of f.seen) {
      for (const key of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cookie', 'origin']) expect(headers[key]).toBeUndefined();
      expect(headers.authorization).not.toBe(`Bearer ${f.token}`);
    }
    expect(f.diagnostics.some(x => x.includes('127.0.0.1'))).toBe(true);
    expect(f.diagnostics.join()).not.toContain('198.51.100.8');
  });

  it('denies missing sessions, foreign origins and non-JSON writes with zero upstream side effects', async () => {
    const f = await fixture();
    expect((await f.call('state', undefined, { authorization: '' })).status).toBe(401);
    expect((await f.call('players', { maxPlayers: 1 }, { origin: 'https://foreign.test' })).status).toBe(403);
    expect((await f.call('state', undefined, { origin: 'https://foreign.test' })).status).toBe(403);
    expect((await f.call('players', {}, { 'content-type': 'text/plain' })).status).toBe(403);
    expect(f.seen).toHaveLength(0);
  });

  it('denies an already logged-out central session without contacting Miami', async () => {
    const f = await fixture();
    await fetch(f.url + '/api/admin/logout', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', origin }, body: '{}' });
    expect((await f.call('state')).status).toBe(401); expect(f.seen).toHaveLength(0);
  });

  it.each([
    ['login', 'POST', 404], ['logout', 'POST', 404], ['rules', 'POST', 404], ['radio/audio/id', 'GET', 404],
    ['state/extra', 'GET', 404], ['state', 'POST', 405], ['players', 'GET', 405], ['state', 'DELETE', 405],
    ['state?url=http://evil.test', 'GET', 400], ['logs?source=other', 'GET', 400], ['logs?limit=1&limit=2', 'GET', 400],
    ['board?mode=other', 'GET', 400], ['players?host=evil.test', 'POST', 400], ['radio/upload?playlist=x&target=x', 'POST', 400],
    ['%73tate', 'GET', 400], ['state/../players', 'POST', 400], ['state%2fextra', 'GET', 400],
    ['logs?source=client&source=server', 'GET', 400], ['radio/upload?title=%ZZ', 'POST', 400],
  ])('rejects the exact route/method/query boundary %s %s before any upstream request', async (path, method, status) => {
    const f = await fixture();
    // Node request keeps dot segments intact (fetch would normalize them before sending).
    const result = await raw(f.url, prefix + path, { method, headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'application/json' } }, method === 'POST' ? '{}' : undefined);
    expect(result.status).toBe(status); expect(f.seen).toHaveLength(0);
  });

  it('forwards only supported read queries and all existing admin write routes', async () => {
    const f = await fixture();
    for (const path of ['state', 'logs?limit=2&source=client', 'board?mode=online&limit=3']) expect((await f.call(path)).status).toBe(200);
    for (const path of ['traffic', 'players', 'kick', 'unban', 'say', 'tuning', 'radio', 'board/remove']) {
      const response = await f.call(path, {});
      expect([200, 400, 404]).toContain(response.status);
      expect(f.seen.at(-1)?.path).toBe('/api/admin/' + path);
    }
  });

  it.each(['body', 'header', 'missing-header', 'redirect', 'bad-json'])('rejects wrong health identity %s before credentials or mutations', async kind => {
    const f = await fixture();
    f.intercept((req, res) => {
      if (req.url !== '/health') return false;
      if (kind === 'header') res.setHeader('x-map-id', 'highway');
      if (kind === 'missing-header') res.removeHeader('x-map-id');
      if (kind === 'redirect') { res.writeHead(302, { location: '/api/admin/login' }); res.end(); }
      else if (kind === 'bad-json') res.end('not json');
      else send(res, 200, { ok: true, map: kind === 'body' ? 'highway' : 'miami' });
      return true;
    });
    expect((await f.call('players', { maxPlayers: 1 })).status).toBe(503);
    expect(f.seen.map(x => x.path)).toEqual(['/health']);
  });

  it.each([undefined, 'not a URL', 'ftp://127.0.0.1', 'http://user:password@localhost', 'http://localhost/#fragment', 'http://localhost/?target=x', 'http://localhost/%2f..'])('fails closed for absent/malformed configured target %s', async url => {
    const f = await fixture({ url: () => url });
    expect((await f.call('state')).status).toBe(503); expect(f.seen).toHaveLength(0);
  });

  it('maps offline and bounded timeout failures to sanitized target-unavailable errors', async () => {
    const f = await fixture({ timeoutMs: 100 });
    f.intercept(() => true);
    const before = Date.now();
    const timeout = await f.call('state');
    expect(timeout.status).toBe(503); expect(Date.now() - before).toBeLessThan(1000);
    expect(await timeout.text()).not.toContain(password);
    f.upstream.server.closeAllConnections(); await new Promise<void>(done => f.upstream.server.close(() => done()));
    expect((await f.call('state')).status).toBe(503);
  });

  it('honors the browser deadline even while a coalesced internal login is still pending', async () => {
    const f = await fixture({ timeoutMs: 200 });
    let loginStarted!: () => void;
    const login = new Promise<void>(done => { loginStarted = done; });
    f.intercept((req, res) => {
      if (req.url === '/health') { setTimeout(() => send(res, 200, { ok: true, map: 'miami' }), 150); return true; }
      if (req.url === '/api/admin/login') { req.resume(); loginStarted(); return true; }
      return false;
    });
    const pending = f.call('state'); await login;
    // The original deadline precedes this marker; a new per-login timeout would not.
    const first = await Promise.race([pending.then(res => res.status), new Promise<string>(done => setTimeout(() => done('login outlived browser deadline'), 100))]);
    expect(first).toBe(503); await pending;
  });

  it.each([200, 400, 'timeout'] as const)('destroys stalled downstream delivery after res.end (upstream %s)', async status => {
    const f = await fixture({ timeoutMs: 250 });
    f.intercept((req, res) => {
      if (status === 'timeout') return true;
      if (req.url !== '/api/admin/state') return false;
      send(res, status, { map: 'miami', detail: 'x'.repeat(1024 * 1024) }); return true;
    });
    const blocked = blockDownstream(f.server);
    const client = request(f.url + prefix + 'state', { headers: { authorization: `Bearer ${f.token}`, origin } });
    client.on('response', res => res.resume()); client.on('error', () => {}); client.end();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await blocked.queued;
      // Real ServerResponse/Socket writable queues are blocked before OS buffering can hide the stall.
      expect(res.headersSent).toBe(true); expect(res.writableEnded).toBe(true);
      expect(res.writableFinished).toBe(false); expect(res.writableLength).toBeGreaterThan(0);
      const outcome = await Promise.race([
        once(res, 'close').then(() => 'closed'),
        new Promise<string>(done => { watchdog = setTimeout(() => done('still queued beyond deadline'), 650); }),
      ]);
      expect(outcome).toBe('closed'); expect(res.destroyed).toBe(true);
      expect(res.writableFinished).toBe(false);
    } finally { clearTimeout(watchdog); client.destroy(); blocked.release(); }
  });

  it('coalesces concurrent refreshes and reauthenticates an expired single service session', async () => {
    const f = await fixture(); let logins = 0;
    f.intercept((req, res) => {
      if (req.url === '/api/admin/login') {
        logins++; req.resume();
        setTimeout(() => send(res, 200, { token: 'fixture_service_token_that_is_long_enough', expiresIn: .15 }), 20);
        return true;
      }
      if (req.url === '/api/admin/state') { send(res, 200, { ok: true, map: 'miami' }); return true; }
      return false;
    });
    expect((await Promise.all(Array.from({ length: 12 }, () => f.call('state')))).every(x => x.status === 200)).toBe(true);
    expect(logins).toBe(1);
    await new Promise(done => setTimeout(done, 170));
    expect((await f.call('state')).status).toBe(200); expect(logins).toBe(2);
  });

  it('discards a rejected service token and refreshes only on a later authorized request', async () => {
    const f = await fixture();
    expect((await f.call('state')).status).toBe(200);
    const oldToken = f.seen.find(x => x.path === '/api/admin/state')!.headers.authorization;
    f.intercept((req, res) => { if (req.url !== '/api/admin/state') return false; send(res, 401, { error: 'login' }); return true; });
    expect((await f.call('state')).status).toBe(503);
    expect(f.seen.filter(x => x.path === '/api/admin/login')).toHaveLength(1);
    f.intercept(undefined);
    expect((await f.call('state')).status).toBe(200);
    expect(f.seen.filter(x => x.path === '/api/admin/login')).toHaveLength(2);
    expect(f.seen.at(-1)?.headers.authorization).not.toBe(oldToken);
  });

  it('also invalidates a service token on a non-JSON 401 without reflecting its error body', async () => {
    const f = await fixture(); expect((await f.call('state')).status).toBe(200);
    f.intercept((req, res) => { if (req.url !== '/api/admin/state') return false; res.writeHead(401); res.end(password); return true; });
    const rejected = await f.call('state'); expect(rejected.status).toBe(503); expect(await rejected.text()).not.toContain(password);
    f.intercept(undefined); expect((await f.call('state')).status).toBe(200);
    expect(f.seen.filter(x => x.path === '/api/admin/login')).toHaveLength(2);
  });

  it('clears a failed coalesced login so a later authorized request can recover', async () => {
    const f = await fixture();
    f.intercept((req, res) => { if (req.url !== '/api/admin/login') return false; req.resume(); send(res, 200, { token: 'short', expiresIn: -1 }); return true; });
    expect((await f.call('state')).status).toBe(503);
    expect(f.seen.some(x => x.path === '/api/admin/state')).toBe(false);
    f.intercept(undefined);
    expect((await f.call('state')).status).toBe(200);
  });

  it('rechecks health even with a cached token before every mutation', async () => {
    const f = await fixture(); expect((await f.call('state')).status).toBe(200);
    f.seen.length = 0;
    f.intercept((req, res) => { if (req.url !== '/health') return false; send(res, 200, { ok: true, map: 'highway' }); return true; });
    expect((await f.call('players', { maxPlayers: 1 })).status).toBe(503);
    expect(f.seen.map(x => x.path)).toEqual(['/health']);
  });

  it('checks identity again after login setup before a mutation can reach a replaced wrong-map service', async () => {
    const f = await fixture(); let loggedIn = false;
    f.intercept((req, res) => {
      if (req.url === '/api/admin/login') loggedIn = true;
      if (req.url !== '/health' || !loggedIn) return false;
      send(res, 200, { ok: true, map: 'highway' }); return true;
    });
    expect((await f.call('players', { maxPlayers: 1 })).status).toBe(503);
    expect(f.seen.some(x => x.path === '/api/admin/players')).toBe(false);
  });

  it.each(['health', 'login'])('reauthorizes central logout during asynchronous %s before dispatch', async stage => {
    const f = await fixture(); let release!: () => void; let reached!: () => void;
    const waiting = new Promise<void>(done => { reached = done; });
    f.intercept((req, res) => {
      if (req.url !== (stage === 'health' ? '/health' : '/api/admin/login')) return false;
      req.resume();
      release = () => send(res, 200, stage === 'health' ? { ok: true, map: 'miami' } : { token: 'fixture_service_token_that_is_long_enough', expiresIn: 100 });
      reached(); return true;
    });
    const pending = f.call('players', { maxPlayers: 1 }); await waiting;
    await fetch(f.url + '/api/admin/logout', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', origin }, body: '{}' });
    release(); expect((await pending).status).toBe(401);
    expect(f.seen.some(x => x.path === '/api/admin/players')).toBe(false);
  });

  it.each([401, 302, 500, 400])('sanitizes service status %s, never replays a write or logs out the browser', async status => {
    const f = await fixture();
    f.intercept((req, res) => {
      if (req.url !== '/api/admin/players') return false;
      req.resume(); res.setHeader('set-cookie', 'internal=secret'); res.setHeader('location', 'http://secret.test');
      send(res, status, { error: password + ' ' + req.headers.authorization }); return true;
    });
    const response = await f.call('players', { maxPlayers: 1 });
    expect(response.status).toBe(status === 400 ? 400 : 503);
    expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).not.toMatch(/fixture|Bearer|secret\.test/);
    expect(f.seen.filter(x => x.path === '/api/admin/players')).toHaveLength(1);
    expect((await fetch(f.url + '/api/admin/state', { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(200);
  });

  it('rejects wrong-map admin responses and oversized response bodies without forwarding their headers/data', async () => {
    const f = await fixture();
    f.intercept((req, res) => {
      if (req.url !== '/api/admin/state') return false;
      res.setHeader('x-map-id', 'highway'); send(res, 200, { ok: true, map: 'highway' }); return true;
    });
    expect((await f.call('state')).status).toBe(503);
    f.intercept((req, res) => { if (req.url !== '/api/admin/state') return false; res.end('x'.repeat(33 * 1024 * 1024)); return true; });
    expect((await f.call('state')).status).toBe(503);
  });

  it('rejects malformed and >16KiB JSON before contacting the service', async () => {
    const f = await fixture();
    for (const [body, status] of [['{bad', 400], [JSON.stringify({ text: 'x'.repeat(16 * 1024) }), 413]] as const) {
      const result = await raw(f.url, prefix + 'say', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'application/json' } }, body);
      expect(result.status).toBe(status);
    }
    expect(f.seen).toHaveLength(0);
  });

  it('never replays an ambiguous write after the service applies it and drops the connection', async () => {
    const f = await fixture(); let writes = 0;
    f.intercept((req) => {
      if (req.url !== '/api/admin/players') return false;
      req.resume(); req.once('end', () => { writes++; req.socket.destroy(); }); return true;
    });
    expect((await f.call('players', { maxPlayers: 1 })).status).toBe(503); expect(writes).toBe(1);
  });

  it('never discloses an internal token/password even if a successful upstream body echoes credentials', async () => {
    const f = await fixture();
    f.intercept((req, res) => {
      if (req.url !== '/api/admin/state') return false;
      send(res, 200, { map: 'miami', rows: [{ message: password, detail: req.headers.authorization }] }); return true;
    });
    const result = await f.call('state'); const text = await result.text();
    expect(result.status).toBe(200); expect(text).not.toContain(password);
    const internal = f.seen.find(x => x.path === '/api/admin/state')!.headers.authorization!.slice(7);
    expect(text).not.toContain(internal);
  });

  it('accepts an exact 16KiB JSON body but rejects chunked excess before upstream setup', async () => {
    const f = await fixture();
    const headers = { authorization: `Bearer ${f.token}`, origin, 'content-type': 'application/json' };
    const exact = JSON.stringify({ text: 'x'.repeat(16 * 1024 - 11) });
    expect(Buffer.byteLength(exact)).toBe(16 * 1024);
    expect((await raw(f.url, prefix + 'say', { method: 'POST', headers }, exact)).status).toBe(200);
    f.seen.length = 0;
    const oversized = request(f.url + prefix + 'say', { method: 'POST', headers });
    const response = new Promise<number>((done, reject) => { oversized.once('response', res => { res.resume(); done(res.statusCode!); }); oversized.once('error', reject); });
    oversized.write(exact); oversized.end(' ');
    expect(await response).toBe(413); expect(f.seen).toHaveLength(0);
  });

  it('streams a valid upload through real Miami radio storage without changing Highway data', async () => {
    const f = await fixture();
    expect((await f.call('radio', { action: 'create', name: 'Miami only' })).status).toBe(200);
    const playlist = f.radio.state().playlists[0].id;
    const body = Buffer.alloc(128 * 1024); body.write('ID3');
    const result = await fetch(f.url + prefix + `radio/upload?playlist=${playlist}&title=Fixture`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'audio/mpeg' }, body });
    expect(result.status).toBe(200);
    expect(f.radio.state().playlists[0].tracks[0]).toMatchObject({ title: 'Fixture', bytes: 128 * 1024 });
  });

  it('times out a stalled upload and cancels its upstream stream without replay', async () => {
    const f = await fixture({ timeoutMs: 150 });
    let cancelled!: () => void;
    const aborted = new Promise<void>(done => { cancelled = done; });
    f.intercept(req => { if (!req.url?.startsWith('/api/admin/radio/upload')) return false; req.resume(); req.once('aborted', cancelled); return true; });
    const upload = request(f.url + prefix + 'radio/upload?playlist=fixture', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'audio/mpeg' } });
    upload.on('error', () => {}); upload.write(Buffer.alloc(64));
    await aborted; upload.destroy();
    expect(f.seen.filter(x => x.path.startsWith('/api/admin/radio/upload'))).toHaveLength(1);
  });

  it('streams uploads before their end, keeps query metadata and propagates client cancellation', async () => {
    const f = await fixture();
    let started!: () => void, aborted!: () => void;
    const received = new Promise<void>(done => { started = done; });
    const cancelled = new Promise<void>(done => { aborted = done; });
    f.intercept((req) => {
      if (!req.url?.startsWith('/api/admin/radio/upload')) return false;
      req.once('data', started); req.once('aborted', aborted); return true;
    });
    const upload = request(f.url + prefix + 'radio/upload?playlist=fixture&title=Test', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'audio/mpeg' } });
    upload.on('error', () => {}); upload.write(Buffer.alloc(64 * 1024));
    await received; expect(f.seen.at(-1)?.path).toBe('/api/admin/radio/upload?playlist=fixture&title=Test');
    upload.destroy(); await cancelled;
  });

  it('does not claim upload success if an upstream replies before consuming the upload', async () => {
    const f = await fixture();
    f.intercept((req, res) => { if (!req.url?.startsWith('/api/admin/radio/upload')) return false; send(res, 200, { ok: true }); return true; });
    const upload = request(f.url + prefix + 'radio/upload?playlist=fixture', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, origin, 'content-type': 'audio/mpeg' } });
    const response = new Promise<number>((done, reject) => { upload.once('response', res => { res.resume(); done(res.statusCode!); }); upload.once('error', reject); });
    upload.write(Buffer.alloc(64));
    expect(await response).toBe(503); upload.destroy();
  });

  it('enforces 40MiB declared/chunked upload limits without forwarding excessive bytes', async () => {
    const f = await fixture();
    const headers = { authorization: `Bearer ${f.token}`, origin, 'content-type': 'audio/mpeg' };
    const declared = await raw(f.url, prefix + 'radio/upload?playlist=fixture', { method: 'POST', headers: { ...headers, 'content-length': String(40 * 1024 * 1024 + 1) } });
    expect(declared.status).toBe(413); expect(f.seen).toHaveLength(0);
    let bytes = 0;
    f.intercept(req => { if (!req.url?.startsWith('/api/admin/radio/upload')) return false; req.on('data', c => { bytes += c.length; }); return true; });
    const upload = request(f.url + prefix + 'radio/upload?playlist=fixture', { method: 'POST', headers });
    const response = new Promise<number>((done, reject) => { upload.once('response', res => { res.resume(); done(res.statusCode!); }); upload.once('error', reject); });
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 41; i++) { if (!upload.write(chunk)) await once(upload, 'drain'); }
    upload.end(); expect(await response).toBe(413); expect(bytes).toBeLessThanOrEqual(40 * 1024 * 1024);
  });
});

/** Inject backpressure only at a real central socket's write-completion boundary. */
function blockDownstream(server: Server) {
  let queued!: (res: ServerResponse) => void;
  const result = { queued: new Promise<ServerResponse>(done => { queued = done; }), release: () => {} };
  server.prependOnceListener('request', (req, res) => {
    const socket = req.socket, write = socket._write, writev = socket._writev!;
    const pending: Array<() => void> = [];
    socket._write = (chunk, encoding, callback) => {
      pending.push(() => socket.destroyed ? callback() : write.call(socket, chunk, encoding, callback)); queued(res);
    };
    socket._writev = (chunks, callback) => {
      pending.push(() => socket.destroyed ? callback() : writev.call(socket, chunks, callback)); queued(res);
    };
    result.release = () => {
      socket._write = write; socket._writev = writev;
      for (const resume of pending.splice(0)) resume();
    };
  });
  return result;
}

function raw(base: string, path: string, options: Parameters<typeof request>[1], body?: string) {
  return new Promise<{ status: number; body: string }>((done, reject) => {
    const req = request(base, { ...options, path }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
