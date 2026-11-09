import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../server/api';
import { Store } from '../server/store';
import type { MapId } from '../src/sim/maps';

const MAX = 120;
const MINUTE = 60_000;
const run = { name: 'Driver', score: 5000, car: 1, physics: 1, near: 2, topKmh: 160, seconds: 30 };
const instances: { server: Server; api: Api; store: Store }[] = [];

async function instance(map: MapId = 'highway') {
  const store = new Store(':memory:');
  const api = new Api(store, { map, origins: ['https://game.test'], log() {} });
  const server = createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  instances.push({ server, api, store });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let serial = 0;
  const post = (body: unknown = { ...run, map, name: `Driver ${serial++}` }, address = 1, raw = false, type = 'application/json', origin = 'https://game.test') =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      // Genuine loopback source addresses, not spoofable forwarding headers or a mocked API call.
      const req = request({ hostname: '127.0.0.1', port, path: '/api/runs', method: 'POST', localAddress: `127.0.0.${address}`,
        agent: false, headers: { 'content-type': type, origin } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(raw ? String(body) : JSON.stringify(body));
    });
  const fill = async (count = MAX, offset = 0) => {
    for (let i = 0; i < count; i++) expect((await post(undefined, 1 + (i + offset) % 45)).status).toBe(200);
  };
  return { store, api, post, fill };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { api } of instances) api.close();
  await Promise.all(instances.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  for (const { store } of instances.splice(0)) store.close();
});

describe('solo aggregate write admission', () => {
  it('accepts 120 reports from 45 actual addresses, then rejects every address before SQLite', async () => {
    const { store, post, fill } = await instance();
    const writes = vi.spyOn(store, 'addRun');
    const boards = vi.spyOn(store, 'leaderboard');
    await fill();
    for (let address = 1; address <= 45; address++) expect((await post(undefined, address)).status).toBe(429);
    expect(writes).toHaveBeenCalledTimes(MAX);
    expect(boards).toHaveBeenCalledTimes(MAX);
    expect(store.playerCount('solo')).toBe(MAX);
  });

  it('expires admissions at exactly one minute, not on a fixed calendar-window boundary', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { post, fill, store } = await instance();
    await fill(MAX / 2);
    clock.mockReturnValue(1_000_000 + MINUTE / 2);
    await fill(MAX / 2);
    clock.mockReturnValue(1_000_000 + MINUTE - 1);
    expect((await post(undefined, 46)).status).toBe(429);
    clock.mockReturnValue(1_000_000 + MINUTE);
    await fill(MAX / 2);
    expect((await post(undefined, 46)).status).toBe(429);
    clock.mockReturnValue(1_000_000 + MINUTE * 1.5);
    await fill(MAX / 2);
    expect(store.playerCount('solo')).toBe(MAX * 2);
  });

  it('keeps the 20-per-address limit active independently of the aggregate window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const { post } = await instance();
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    clock.mockReturnValue(2_000_000 + MINUTE);
    expect((await post()).status).toBe(429);
    expect((await post(undefined, 2)).status).toBe(200);
    clock.mockReturnValue(2_000_000 + 10 * MINUTE + 1);
    expect((await post()).status).toBe(200);
  });

  it('does not let invalid numeric reports consume write admissions', async () => {
    const { post, fill, store } = await instance();
    const writes = vi.spyOn(store, 'addRun');
    for (let i = 0; i < MAX + 1; i++) {
      const invalid = i % 2 ? { ...run, score: '5000' } : { ...run, topKmh: 701 };
      expect((await post(invalid, 1 + i % 45)).status).toBe(400);
    }
    expect(writes).not.toHaveBeenCalled();
    await fill();
    expect((await post(undefined, 46)).status).toBe(429);
  });

  it('does not charge wrong-map reports against the destination budget', async () => {
    const { post, fill } = await instance('miami');
    for (let i = 0; i < MAX + 1; i++) expect((await post({ ...run, map: 'highway' }, 1 + i % 45)).status).toBe(400);
    await fill();
    expect((await post(undefined, 46)).status).toBe(429);
  });

  it('rejects malformed JSON without spending write admissions', async () => {
    const { post, fill, store } = await instance();
    const writes = vi.spyOn(store, 'addRun');
    for (const body of ['{', 'null', '[]', '42']) expect((await post(body, 1, true)).status).toBe(400);
    expect(writes).not.toHaveBeenCalled();
    await fill();
  });

  it('rejects oversized JSON without spending write admissions', async () => {
    const { post, fill } = await instance();
    expect((await post({ ...run, name: 'x'.repeat(17 * 1024) })).status).toBe(413);
    await fill();
  });

  it('preserves content-type and origin checks before write admission', async () => {
    const { post, fill } = await instance();
    expect((await post(run, 1, false, 'text/plain')).status).toBe(403);
    expect((await post(run, 1, false, 'application/json', 'https://attacker.test')).status).toBe(403);
    await fill();
  });

  it('returns 200/stored:false below 1000 even when full, without SQLite or budget use', async () => {
    const { post, fill, store } = await instance();
    const writes = vi.spyOn(store, 'addRun');
    const boards = vi.spyOn(store, 'leaderboard');
    for (let i = 0; i < MAX + 1; i++) {
      expect(await post({ ...run, score: 999.9 }, 1 + i % 45)).toMatchObject({ status: 200, body: { ok: true, stored: false } });
    }
    expect(writes).not.toHaveBeenCalled();
    expect(boards).not.toHaveBeenCalled();
    await fill(MAX - 1);
    expect(await post({ ...run, score: 1000 }, 46)).toMatchObject({ status: 200, body: { stored: true } });
    expect(await post({ ...run, score: 0 }, 46)).toMatchObject({ status: 200, body: { stored: false } });
    expect((await post(undefined, 46)).status).toBe(429);
    expect(writes).toHaveBeenCalledTimes(MAX);
  });

  it('isolates both aggregate and per-address budgets between highway and Miami instances', async () => {
    const highway = await instance('highway');
    const miami = await instance('miami');
    await highway.fill();
    expect((await highway.post(undefined, 46)).status).toBe(429);
    await miami.fill();
    expect((await miami.post(undefined, 46)).status).toBe(429);
    expect(highway.store.playerCount('solo')).toBe(MAX);
    expect(miami.store.playerCount('solo')).toBe(MAX);
    // A single-address limit is local too, even when both instances serve the same map.
    const peer = await instance('highway');
    for (let i = 0; i < 20; i++) expect((await peer.post()).status).toBe(200);
    expect((await peer.post()).status).toBe(429);
  });

  it('does not limit authoritative online writes or delete existing leaderboard records', async () => {
    const { post, fill, store } = await instance();
    store.addRun({ ...run, mode: 'solo', name: 'Existing solo' });
    store.addRun({ ...run, mode: 'online', name: 'Existing online' });
    await fill();
    expect((await post(undefined, 46)).status).toBe(429);
    for (let i = 0; i < MAX + 1; i++) expect(store.addRun({ ...run, mode: 'online', name: `Online ${i}` })).toBe(true);
    expect(store.playerCount('online')).toBe(MAX + 2);
    expect(store.placeOn('solo', 'Existing solo')).not.toBeNull();
    expect(store.placeOn('online', 'Existing online')).not.toBeNull();
  });

  it('does not oversubscribe the budget under concurrent HTTP reports', async () => {
    const { post, store } = await instance();
    const responses = await Promise.all(Array.from({ length: MAX + 15 }, (_, i) => post(undefined, 1 + i % 45)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(MAX);
    expect(responses.filter(response => response.status === 429)).toHaveLength(15);
    expect(store.playerCount('solo')).toBe(MAX);
  });
});
