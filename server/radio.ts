import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { unlink, rename } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RADIO_MAX_TRACK_BYTES, type RadioLibrary, type RadioTrack } from '../src/audio/radioTypes';
import { send } from './api';
import type { Store } from './store';

const KEY = 'radio';
const ID = /^[a-f0-9-]{36}$/;
const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
const title = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 100) : '';

/** Streams uploads to the persistent data volume; audio bytes never live in SQLite or the JS heap. */
export class RadioStore {
  private library: RadioLibrary;
  private uploading = false;
  constructor(private readonly store: Store, private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    // Only unfinished uploads created by us; completed audio and unfamiliar files are never swept.
    for (const name of readdirSync(directory)) if (/^[a-f0-9-]{36}\.part$/.test(name)) {
      try { unlinkSync(join(directory, name)); } catch { /* A later restart can retry a locked file. */ }
    }
    this.library = store.setting<RadioLibrary>(KEY) ?? { playlists: [] };
  }
  state(): RadioLibrary { return structuredClone(this.library); }
  private save(): void { this.store.setSetting(KEY, this.library); }
  private file(id: string): string { if (!ID.test(id)) throw new Error('Неверный ID'); return join(this.directory, id); }

  async action(b: Record<string, unknown>): Promise<RadioLibrary> {
    if (this.uploading) throw new Error('Дождитесь окончания загрузки трека');
    if (b.action === 'create') {
      const name = title(b.name);
      if (!name || this.library.playlists.length >= 30) throw new Error('Укажите имя (до 30 плейлистов)');
      this.library.playlists.push({ id: randomUUID(), name, tracks: [] });
    } else {
      const list = this.library.playlists.find(p => p.id === b.playlist);
      if (!list) throw new Error('Плейлист не найден');
      if (b.action === 'rename') {
        const name = title(b.name); if (!name) throw new Error('Укажите имя'); list.name = name;
      } else if (b.action === 'deletePlaylist') {
        this.library.playlists = this.library.playlists.filter(p => p !== list);
        this.save();
        for (const track of list.tracks) await unlink(this.file(track.id)).catch(() => {});
        return this.state();
      } else if (b.action === 'deleteTrack') {
        const track = list.tracks.find(t => t.id === b.track);
        if (!track) throw new Error('Трек не найден');
        list.tracks = list.tracks.filter(t => t !== track);
        this.save(); await unlink(this.file(track.id)).catch(() => {}); return this.state();
      } else if (b.action === 'move') {
        const at = list.tracks.findIndex(t => t.id === b.track);
        const to = at + (b.direction === -1 ? -1 : 1);
        if (at < 0 || to < 0 || to >= list.tracks.length) throw new Error('Нельзя переместить трек');
        [list.tracks[at], list.tracks[to]] = [list.tracks[to], list.tracks[at]];
      } else throw new Error('Неизвестная операция');
    }
    this.save(); return this.state();
  }

  async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const list = this.library.playlists.find(p => p.id === url.searchParams.get('playlist'));
    if (!list || list.tracks.length >= 200) { req.resume(); send(res, 400, { error: 'Плейлист не найден или содержит 200 треков' }); return; }
    if (this.uploading) { req.resume(); send(res, 409, { error: 'Другая загрузка ещё не закончена' }); return; }
    const type = String(req.headers['content-type'] ?? '').split(';')[0];
    if (!['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/flac', 'audio/x-flac'].includes(type)) { req.resume(); send(res, 415, { error: 'Поддерживаются MP3, OGG, WAV, M4A и FLAC' }); return; }
    if (Number(req.headers['content-length']) > RADIO_MAX_TRACK_BYTES) { req.resume(); send(res, 413, { error: 'Максимум 40 МБ на трек' }); return; }
    const used = this.library.playlists.flatMap(p => p.tracks).reduce((n, t) => n + t.bytes, 0);
    if (used + Number(req.headers['content-length'] ?? 0) > MAX_LIBRARY_BYTES) { req.resume(); send(res, 413, { error: 'Максимум 1 ГБ на библиотеку' }); return; }
    this.uploading = true;
    const id = randomUUID(), temp = this.file(id) + '.part';
    let bytes = 0, head = Buffer.alloc(0);
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
      if (bytes > RADIO_MAX_TRACK_BYTES || used + bytes > MAX_LIBRARY_BYTES) callback(new Error('Превышен лимит: 40 МБ на трек, 1 ГБ на библиотеку'));
      else callback(null, chunk);
    } });
    try {
      await pipeline(req, limit, createWriteStream(temp, { flags: 'wx' }));
      const signature = type === 'audio/mpeg' ? head.subarray(0, 3).toString() === 'ID3' || head[0] === 255 && (head[1] & 224) === 224
        : type === 'audio/ogg' ? head.subarray(0, 4).toString() === 'OggS'
        : type.includes('wav') ? head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE'
        : type === 'audio/mp4' ? head.subarray(4, 8).toString() === 'ftyp'
        : head.subarray(0, 4).toString() === 'fLaC';
      if (!signature || bytes < 32) throw new Error('Файл не соответствует выбранному аудиоформату');
      await rename(temp, this.file(id));
      const track: RadioTrack = { id, title: title(url.searchParams.get('title')) || 'Без названия', bytes, type };
      list.tracks.push(track);
      try { this.save(); } catch (error) { list.tracks.pop(); await unlink(this.file(id)).catch(() => {}); throw error; }
      send(res, 200, { ok: true, track, radio: this.state() });
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (!res.destroyed) send(res, bytes > RADIO_MAX_TRACK_BYTES ? 413 : 400, { error: (error as Error).message });
    } finally { this.uploading = false; }
  }

  /** Public read-only API, including Range/HEAD so the browser can seek without downloading again. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/radio')) return false;
    res.setHeader('access-control-allow-origin', '*');
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { send(res, 405, { error: 'read only' }); return true; }
    if (path === '/api/radio') { send(res, 200, this.state()); return true; }
    const id = path.slice('/api/radio/audio/'.length);
    const track = path.startsWith('/api/radio/audio/') && ID.test(id) ? this.library.playlists.flatMap(p => p.tracks).find(t => t.id === id) : undefined;
    if (!track || !existsSync(this.file(track.id))) { send(res, 404, { error: 'Трек не найден' }); return true; }
    const size = statSync(this.file(track.id)).size;
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
      status = 206;
    }
    res.writeHead(status, { 'content-type': track.type, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(this.file(track.id), { start, end });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    }
    return true;
  }
}
