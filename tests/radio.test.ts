/// <reference types="node" />
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RadioStore } from '../server/radio';
import { Store } from '../server/store';
import { Admin } from '../server/admin';
import { GameServer } from '../src/online/gameServer';
import type { RadioLibrary } from '../src/audio/radioTypes';

describe('persistent radio library and streaming', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traffic-radio-'));
  const store = new Store(':memory:'), radio = new RadioStore(store, dir);
  const admin = new Admin({ password: 'test-radio-password', origins: ['http://game.test'], game: new GameServer({ seed: 6 }), store, radio, health: () => ({}), diag() {} });
  let server: Server, base = '', token = '', playlist = '', track = '';
  const post = (path: string, body: object, auth = token) => fetch(`${base}/api/admin/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  const wav = Buffer.alloc(1000, 0); wav.write('RIFF'); wav.writeUInt32LE(992, 4); wav.write('WAVE', 8);
  const upload = (body: Buffer, type = 'audio/wav', auth = token, origin?: string) => fetch(`${base}/api/admin/radio/upload?playlist=${playlist}&title=Test%20track`, {
    method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${auth}`, ...(origin ? { origin } : {}) }, body: new Uint8Array(body),
  });
  beforeAll(async () => {
    server = createServer((req, res) => { if (!admin.handle(req, res) && !radio.handle(req, res)) res.writeHead(404).end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = (await (await post('login', { password: 'test-radio-password' })).json()).token;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  it('requires an authenticated same-origin admin for playlist changes and audio uploads', async () => {
    expect((await post('radio', { action: 'create', name: 'Night Drive' }, '')).status).toBe(401);
    const res = await post('radio', { action: 'create', name: 'Night Drive' }); expect(res.status).toBe(200);
    playlist = (await res.json()).radio.playlists[0].id;
    expect((await upload(wav, 'audio/wav', '')).status).toBe(401);
    expect((await upload(wav, 'audio/wav', token, 'https://evil.test')).status).toBe(403);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('rejects unsupported media and invalid signatures without leaving temporary files', async () => {
    expect((await upload(wav, 'text/html')).status).toBe(415);
    expect((await upload(Buffer.alloc(100), 'audio/mpeg')).status).toBe(400);
    const oversized = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/admin/radio/upload?playlist=${playlist}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav', 'content-length': 40 * 1024 * 1024 + 1 },
      }, response => { response.resume(); response.on('end', () => { resolve(response.statusCode); request.destroy(); }); });
      request.on('error', reject); request.end();
    });
    expect(oversized).toBe(413);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('persists a streamed upload and serves exact byte ranges and HEAD', async () => {
    const res = await upload(wav); expect(res.status).toBe(200);
    track = (await res.json()).track.id;
    expect(new RadioStore(store, dir).state().playlists[0].tracks[0]).toMatchObject({ id: track, bytes: wav.length, title: 'Test track' });
    const audio = await fetch(`${base}/api/radio/audio/${track}`, { headers: { range: 'bytes=10-29' } });
    expect(audio.status).toBe(206); expect(audio.headers.get('content-range')).toBe('bytes 10-29/1000');
    expect(Buffer.from(await audio.arrayBuffer())).toEqual(wav.subarray(10,30));
    const head = await fetch(`${base}/api/radio/audio/${track}`, { method: 'HEAD' }); expect(head.headers.get('content-length')).toBe('1000'); expect(await head.text()).toBe('');
    expect((await fetch(`${base}/api/radio/audio/${track}`, { headers: { range: 'bytes=1001-' } })).status).toBe(416);
    expect((await fetch(`${base}/api/radio/audio/../../traffic.db`)).status).toBe(404);
    const publicLibrary = await (await fetch(`${base}/api/radio`)).json() as RadioLibrary;
    expect(publicLibrary.playlists[0].tracks[0].id).toBe(track);
  });
  it('cleans only interrupted application uploads on restart, not completed tracks or unfamiliar files', () => {
    const partial = '11111111-1111-4111-8111-111111111111.part';
    writeFileSync(join(dir, partial), 'unfinished'); writeFileSync(join(dir, 'notes.txt'), 'keep');
    const restored = new RadioStore(store, dir);
    expect(readdirSync(dir)).not.toContain(partial);
    expect(readdirSync(dir)).toContain(track); expect(readdirSync(dir)).toContain('notes.txt');
    expect(restored.state().playlists[0].tracks[0].id).toBe(track);
    unlinkSync(join(dir, 'notes.txt'));
  });
  it('reorders tracks, deletes audio and keeps the remaining playlist valid', async () => {
    const second = await (await upload(wav)).json();
    expect((await post('radio', { action: 'move', playlist, track: second.track.id, direction: -1 })).status).toBe(200);
    expect(radio.state().playlists[0].tracks[0].id).toBe(second.track.id);
    expect((await post('radio', { action: 'deleteTrack', playlist, track })).status).toBe(200);
    expect((await fetch(`${base}/api/radio/audio/${track}`)).status).toBe(404);
    expect((await post('radio', { action: 'deletePlaylist', playlist })).status).toBe(200);
    expect(radio.state().playlists).toEqual([]); expect(readdirSync(dir)).toEqual([]);
  });
});
