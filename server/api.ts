/*
 * HTTP API next to the game socket (all under /api, same origin as the site behind the proxy):
 *
 *   GET  /api/leaderboard?mode=solo|online&limit=10&name=   each player's best run, best first; how many
 *        players there are; with a name, that player's own place among all of them (me, or null)
 *   POST /api/runs   {name, score, car, physics, near, topKmh, seconds}   a finished solo run
 *   POST /api/log    {page, ua, gpu, quality, items: [{level, msg, detail?, count?}]}   page problems
 *
 * Solo runs are reported by the page and taken on trust (bounded and rate-limited); online runs go
 * straight from the server's own scoring. Everything that writes is rate-limited per address and
 * overall, so a broken or hostile page cannot fill the disk.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanName } from '../src/online/world';
import type { LeaderEntry, RunMode, Store } from './store';
import { DatabaseSync } from 'node:sqlite';
import { resolveMap, type MapId } from '../src/sim/maps';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientIp, type ClientAddressResolver } from './clientAddress';
export { clientIp } from './clientAddress';

/** Protect uploaded bytes too, even when RADIO_DIR was accidentally shared between distinct DBs. */
export function claimRadioMap(directory: string, mapId: MapId): void {
  resolveMap(mapId);
  mkdirSync(directory, { recursive: true });
  const marker = join(directory, '.map-id');
  if (!existsSync(marker)) {
    if (mapId !== 'highway' && readdirSync(directory).length) throw new Error('Unlabelled radio directory belongs to highway; use a new Miami volume');
    try { writeFileSync(marker, mapId, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (readFileSync(marker, 'utf8') !== mapId) throw new Error(`Radio MAP_ID does not match ${mapId}; use a separate volume`);
}

/** Claim the database atomically BEFORE opening stores/radio or restoring mutable settings.
 * Unlabelled populated databases predate maps and belong to highway; never relabel or wipe them.
 */
export function claimDatabaseMap(path: string, mapId: MapId): void {
  resolveMap(mapId);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const identity = db.prepare("SELECT value FROM settings WHERE key = 'MAP_ID'").get() as { value: string } | undefined;
    if (identity) {
      if (identity.value !== JSON.stringify(mapId)) throw new Error(`Database MAP_ID ${identity.value} does not match ${mapId}; use a separate volume`);
    } else {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'log', 'settings')").all() as { name: string }[];
      const populated = tables.some(({ name }) => !!db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get());
      if (populated && mapId !== 'highway') throw new Error('Unlabelled legacy database belongs to highway; use a new Miami volume');
      db.prepare("INSERT INTO settings (key, value) VALUES ('MAP_ID', ?)").run(JSON.stringify(mapId));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

const BODY_MAX = 16 * 1024;
const WINDOW = 10 * 60_000;

/** Sliding-window counters: at most `max` events per key in WINDOW. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number) {}
  take(key: string, now = Date.now()): boolean {
    let list = this.hits.get(key);
    if (!list) this.hits.set(key, (list = []));
    while (list.length && now - list[0] > WINDOW) list.shift();
    if (list.length >= this.max) return false;
    list.push(now);
    return true;
  }
  prune(now = Date.now()): void {
    for (const [k, list] of this.hits) if (!list.length || now - list[list.length - 1] > WINDOW) this.hits.delete(k);
  }
}

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');

/** HTTP LIMIT values must be finite integers; retain the existing zero/invalid defaults. */
export function queryLimit(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  return Math.max(1, Math.min(max, Number.isFinite(n) && n !== 0 ? Math.floor(n) : fallback));
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Over the limit: keep reading (so the 413 gets through) but keep nothing; cut off a flood.
      if (size > 64 * BODY_MAX) req.destroy();
      else if (size <= BODY_MAX) chunks.push(c);
    });
    req.on('end', () => {
      if (size > BODY_MAX) {
        reject(new Error('too large'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/** A write must be JSON (a cross-site form cannot send that without a preflight) from one of our pages. */
export function ownJson(req: IncomingMessage, origins: readonly string[]): boolean {
  const origin = req.headers.origin;
  return String(req.headers['content-type'] ?? '').startsWith('application/json') && !(origin && origins.length && !origins.includes(origin));
}

export interface ApiOptions {
  /** Shared HTTP/WS resolver; defaults to the socket peer with no trusted proxies. */
  clientAddress?: ClientAddressResolver;
  map?: MapId;
  /** Allowed page origins for writes (empty: any). */
  origins: readonly string[];
  /** Diagnostics line for the server's own log. */
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** Build the server runs (pages come from the same deploy), noted with page reports. */
  version?: string;
}

interface LeaderboardCache<T> {
  at: number;
  revision: number;
  value: T;
}

export class Api {
  /** Six expensive SELECTs per rolling second, shared across all public names/modes/addresses.
   * A cold board costs two (top/count), a cold name one. Reserve the entire request before SQL.
   * Two 100-row boards and at most 32 named results (including misses), with a 2 s TTL.
   */
  private readonly leaderboardTimes: number[] = [];
  private readonly leaderboardBoards: Partial<Record<RunMode, LeaderboardCache<{ entries: LeaderEntry[]; total: number }>>> = {};
  private readonly leaderboardNames = new Map<string, LeaderboardCache<LeaderEntry | null>>();
  private readonly runLimit = new Limiter(20);
  /** Solo SQLite admissions: 120 per rolling minute, independent of address and map peers.
   * Fixed-capacity ring: constant-time admission and no address-dependent aggregate memory.
   */
  private readonly runWriteTimes: number[] = [];
  private runWriteNext = 0;
  private readonly runWriteMax = 120;
  private readonly runWriteWindow = 60_000;
  private readonly logPostLimit = new Limiter(10);
  /** Rows the whole log may take from pages / from the server itself per window. */
  private readonly clientRows = new Limiter(300);
  private readonly serverRows = new Limiter(150);
  private readonly recent = new Map<string, { at: number; repeats: number }>();
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: Store,
    private readonly opts: ApiOptions,
  ) {
    resolveMap(opts.map);
    this.pruneTimer = setInterval(() => {
      this.runLimit.prune();
      this.logPostLimit.prune();
      const now = Date.now();
      for (const [k, v] of this.recent) if (now - v.at > 60_000) this.recent.delete(k);
    }, 60_000);
    this.pruneTimer.unref?.();
  }

  /**
   * A server-side problem worth keeping: same message within a minute is counted, not repeated;
   * at most 150 rows per 10 minutes.
   */
  diag(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
    const now = Date.now();
    const seen = this.recent.get(message);
    if (seen && now - seen.at < 60_000) {
      seen.repeats++;
      return;
    }
    const repeats = seen?.repeats ?? 0;
    this.recent.set(message, { at: now, repeats: 0 });
    if (!this.serverRows.take('all', now)) return;
    const text = repeats > 0 ? `${message} (+${repeats} more in the last minute)` : message;
    try {
      this.store.log('server', level, text, detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail));
    } catch (e) {
      this.opts.log('error', `log write failed: ${(e as Error).message}`);
    }
  }

  /** Handles /api/*; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const ip = (this.opts.clientAddress ?? clientIp)(req);
    const map = resolveMap(this.opts.map);
    res.setHeader('x-map-id', map.id);
    if (req.method === 'GET' && url.pathname === '/api/map') {
      send(res, 200, { map: map.id, mapRevision: map.revision, name: map.name, soloPolicy: 'selected-instance' });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const mode: RunMode = url.searchParams.get('mode') === 'online' ? 'online' : 'solo';
      const limit = queryLimit(url.searchParams.get('limit'), 10, 100);
      const name = (url.searchParams.get('name') ?? '').slice(0, 32);
      const now = Date.now();
      const revision = this.store.runRevision(mode);
      let board = this.leaderboardBoards[mode];
      const key = `${mode}:${name}`;
      let own = this.leaderboardNames.get(key);
      const boardMiss = !board || board.revision !== revision || now - board.at >= 2000;
      const nameMiss = !!name && (!own || own.revision !== revision || now - own.at >= 2000);
      const work = (boardMiss ? 2 : 0) + (nameMiss ? 1 : 0);
      while (this.leaderboardTimes.length && now - this.leaderboardTimes[0] >= 1000) this.leaderboardTimes.shift();
      if (this.leaderboardTimes.length + work > 6) {
        res.setHeader('retry-after', '1');
        send(res, 429, { ok: false, error: 'slow down' });
        return true;
      }
      for (let i = 0; i < work; i++) this.leaderboardTimes.push(now);
      if (boardMiss) {
        board = { at: now, revision, value: { entries: this.store.leaderboard(mode, 100), total: this.store.playerCount(mode) } };
        this.leaderboardBoards[mode] = board;
      }
      if (nameMiss) {
        own = { at: now, revision, value: this.store.placeOn(mode, name) };
        // FIFO retention, not address/name-dependent unbounded state. A denied miss inserts nothing.
        this.leaderboardNames.delete(key);
        if (this.leaderboardNames.size >= 32) this.leaderboardNames.delete(this.leaderboardNames.keys().next().value!);
        this.leaderboardNames.set(key, own);
      }
      send(res, 200, { map: map.id, mapRevision: map.revision, soloPolicy: 'selected-instance', mode, entries: board!.value.entries.slice(0, limit), total: board!.value.total, me: name ? own!.value : null });
      return true;
    }
    if (req.method === 'POST' && (url.pathname === '/api/runs' || url.pathname === '/api/log')) {
      if (!ownJson(req, this.opts.origins)) {
        send(res, 403, { ok: false });
        return true;
      }
      const isRun = url.pathname === '/api/runs';
      if (!(isRun ? this.runLimit : this.logPostLimit).take(ip)) {
        send(res, 429, { ok: false, error: 'slow down' });
        return true;
      }
      readJson(req).then(
        (body) => (isRun ? this.postRun(body, res) : this.postLog(body, res)),
        (e: Error) => send(res, e.message === 'too large' ? 413 : 400, { ok: false }),
      );
      return true;
    }
    send(res, 404, { ok: false });
    return true;
  }

  private postRun(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const map = resolveMap(this.opts.map);
    // Existing highway pages remain valid. Miami submissions must explicitly name their map.
    if ((b.map === undefined ? 'highway' : b.map) !== map.id) return send(res, 400, { ok: false, error: 'map mismatch', map: map.id });
    const score = num(b.score, 0, 1e8);
    const car = num(b.car, 1, 9);
    const physics = num(b.physics, 1, 9);
    const near = num(b.near, 0, 1e5);
    const topKmh = num(b.topKmh, 0, 700);
    const seconds = num(b.seconds, 0, 24 * 3600);
    if (score === null || car === null || physics === null || near === null || topKmh === null || seconds === null) {
      send(res, 400, { ok: false });
      return;
    }
    // Match Store.MIN_SCORE without touching SQLite or charging the write budget for ignored runs.
    if (score < 1000) return send(res, 200, { ok: true, map: map.id, stored: false });
    // Validate first: malformed JSON, wrong maps and bad numeric fields cannot exhaust admissions.
    // Reserve synchronously before SQLite; even concurrent requests cannot oversubscribe the ring.
    const now = Date.now();
    if (this.runWriteTimes.length === this.runWriteMax && now - this.runWriteTimes[this.runWriteNext] < this.runWriteWindow) {
      return send(res, 429, { ok: false, error: 'slow down' });
    }
    this.runWriteTimes[this.runWriteNext] = now;
    this.runWriteNext = (this.runWriteNext + 1) % this.runWriteMax;
    const raw = cleanName(b.name, 0);
    const name = raw === 'Driver 0' ? 'Driver' : raw;
    const stored = this.store.addRun({ mode: 'solo', name, score, car, physics, near, topKmh, seconds });
    const rank = stored ? this.store.leaderboard('solo', 100).find((e) => e.name.toLowerCase() === name.toLowerCase())?.rank : undefined;
    send(res, 200, { ok: true, map: map.id, stored, rank });
  }

  private postLog(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
    const ctx = { map: resolveMap(this.opts.map).id, page: str(b.page, 20), ua: str(b.ua, 200), gpu: str(b.gpu, 120), quality: str(b.quality, 10), server: this.opts.version ?? '' };
    let kept = 0;
    for (const it of items) {
      const i = (it ?? {}) as Record<string, unknown>;
      const msg = str(i.msg, 300);
      if (!msg || !this.clientRows.take('all')) continue;
      const level = i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'info';
      const count = num(i.count, 1, 1e6) ?? 1;
      this.store.log('client', level, `[${ctx.page}] ${msg}${count > 1 ? ` (×${count})` : ''}`, JSON.stringify({ ...ctx, detail: str(i.detail, 1500) }));
      kept++;
    }
    send(res, 200, { ok: true, kept });
  }

  close(): void {
    clearInterval(this.pruneTimer);
  }
}
