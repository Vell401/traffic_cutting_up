import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Api, claimDatabaseMap, claimRadioMap } from '../server/api';
import { Store } from '../server/store';
import { RadioStore } from '../server/radio';
import { Admin } from '../server/admin';
import { GameServer } from '../src/online/gameServer';

const directories: string[] = [];
const stores: Store[] = [];
const apis: Api[] = [];
const servers: Server[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tcu-map-test-')); directories.push(dir); return dir; };
const storeAt = (path: string) => { const store = new Store(path); stores.push(store); return store; };
afterEach(async () => {
  for (const api of apis.splice(0)) api.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('persistent map identity', () => {
  it('claims each fresh DB once and rejects accidental cross-map reuse without changing data', () => {
    const path = join(temp(), 'traffic.db');
    claimDatabaseMap(path, 'miami'); claimDatabaseMap(path, 'miami');
    const store = storeAt(path);
    store.setSetting('custom', { keep: true });
    expect(() => claimDatabaseMap(path, 'highway')).toThrow('MAP_ID');
    expect(store.setting('MAP_ID')).toBe('miami');
    expect(store.setting('custom')).toEqual({ keep: true });
  });
  it('grandfathers populated legacy DBs only as highway, retaining scores, tuning and radio', () => {
    const path = join(temp(), 'legacy.db'), store = storeAt(path);
    store.addRun({ mode: 'online', name: 'Legacy', score: 12345, car: 4, physics: 5, near: 2, topKmh: 200, seconds: 30 });
    store.setSetting('tuning', { untouched: true }); store.setSetting('radio', { playlists: [{ id: 'keep' }] });
    expect(() => claimDatabaseMap(path, 'miami')).toThrow('legacy');
    expect(store.setting('MAP_ID')).toBeUndefined();
    claimDatabaseMap(path, 'highway');
    expect(store.setting('MAP_ID')).toBe('highway');
    expect(store.leaderboard('online')[0]).toMatchObject({ name: 'Legacy', score: 12345, physics: 5 });
    expect(store.setting('tuning')).toEqual({ untouched: true });
    expect(store.setting('radio')).toEqual({ playlists: [{ id: 'keep' }] });
  });
  it('refuses ambiguous/corrupt stored identity rather than relabelling it', () => {
    const path = join(temp(), 'bad.db'), store = storeAt(path);
    store.setSetting('MAP_ID', 'unrecognized');
    expect(() => claimDatabaseMap(path, 'highway')).toThrow('MAP_ID');
    expect(store.setting('MAP_ID')).toBe('unrecognized');
  });
  it('guards shared radio directories and safely grandfathers legacy bytes', () => {
    const dir = temp();
    claimRadioMap(dir, 'miami'); claimRadioMap(dir, 'miami');
    expect(() => claimRadioMap(dir, 'highway')).toThrow('MAP_ID');
    const legacy = join(temp(), 'radio'); mkdirSync(legacy);
    writeFileSync(join(legacy, 'track'), 'original bytes');
    expect(() => claimRadioMap(legacy, 'miami')).toThrow('Unlabelled');
    claimRadioMap(legacy, 'highway');
    expect(readFileSync(join(legacy, 'track'), 'utf8')).toBe('original bytes');
  });
});

describe('separate map HTTP/storage instances', () => {
  it('partitions boards, settings and radio; names map in health/admin/API; rejects misrouted solo runs', async () => {
    const instances = await Promise.all((['highway', 'miami'] as const).map(async map => {
      const dir = temp(), path = join(dir, 'traffic.db'); claimDatabaseMap(path, map);
      const store = storeAt(path);
      store.setSetting('profile', { map });
      const radioDir = join(dir, 'radio'); claimRadioMap(radioDir, map);
      const radio = new RadioStore(store, radioDir); await radio.action({ action: 'create', name: map });
      const game = new GameServer({ seed: 1, map });
      const api = new Api(store, { map, origins: [], log() {} }); apis.push(api);
      const admin = new Admin({ password: 'test-password', origins: [], game, store, radio, health: () => game.health(false), diag() {} });
      const server = createServer((req, res) => { if (!admin.handle(req, res) && !api.handle(req, res)) res.writeHead(404).end(); });
      servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { map, store, base, post };
    }));
    const body = { name: 'Same player', score: 9000, car: 4, physics: 5, near: 1, topKmh: 150, seconds: 20 };
    for (const i of instances) {
      expect((await i.post('/api/runs', { ...body, map: i.map === 'miami' ? 'highway' : 'miami' })).status).toBe(400);
      if (i.map === 'miami') expect((await i.post('/api/runs', body)).status).toBe(400);
      expect((await i.post('/api/runs', { ...body, map: i.map, score: i.map === 'miami' ? 15000 : 9000 })).status).toBe(200);
      const identity = await (await fetch(`${i.base}/api/map`)).json();
      expect(identity).toMatchObject({ map: i.map, mapRevision: i.map === 'miami' ? 3 : 1, soloPolicy: 'selected-instance' });
      const boardResponse = await fetch(`${i.base}/api/leaderboard?mode=solo`);
      expect(boardResponse.headers.get('x-map-id')).toBe(i.map);
      const board = await boardResponse.json() as { entries: { score: number }[] };
      expect(board.entries).toHaveLength(1); expect(board.entries[0].score).toBe(i.map === 'miami' ? 15000 : 9000);
      expect(i.store.setting('profile')).toEqual({ map: i.map });
      const login = await (await i.post('/api/admin/login', { password: 'test-password' })).json() as { token: string };
      const admin = await (await fetch(`${i.base}/api/admin/state`, { headers: { authorization: `Bearer ${login.token}` } })).json();
      expect(admin).toMatchObject({ map: i.map, mapRevision: i.map === 'miami' ? 3 : 1, server: { map: i.map, protocol: 13 }, radio: { playlists: [{ name: i.map }] } });
    }
  });
});
