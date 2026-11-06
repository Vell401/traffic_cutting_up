/*
 * HTTP API next to the game socket (all under /api, same origin as the site behind the proxy):
 *
 *   GET  /api/leaderboard?mode=solo|online&limit=10   each player's best run, best first
 *   POST /api/runs   {name, score, car, physics, near, topKmh, seconds}   a finished solo run
 *   POST /api/log    {page, ua, gpu, quality, items: [{level, msg, detail?, count?}]}   page problems
 *
 * Solo runs are reported by the page and taken on trust (bounded and rate-limited); online runs go
 * straight from the server's own scoring. Everything that writes is rate-limited per address and
 * overall, so a broken or hostile page cannot fill the disk.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanName } from '../src/online/world';
import type { RunMode, Store } from './store';

const BODY_MAX = 16 * 1024;
const WINDOW = 10 * 60_000;

/** Sliding-window counters: at most `max` events per key in WINDOW. */
class Limiter {
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

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
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

export interface ApiOptions {
  /** Allowed page origins for writes (empty: any). */
  origins: readonly string[];
  /** Diagnostics line for the server's own log. */
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** Build the server runs (pages come from the same deploy), noted with page reports. */
  version?: string;
}

export class Api {
  private readonly runLimit = new Limiter(20);
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
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const mode: RunMode = url.searchParams.get('mode') === 'online' ? 'online' : 'solo';
      const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
      send(res, 200, { mode, entries: this.store.leaderboard(mode, limit) });
      return true;
    }
    if (req.method === 'POST' && (url.pathname === '/api/runs' || url.pathname === '/api/log')) {
      // JSON only (a cross-site form cannot send it without a preflight) and from our own pages.
      const origin = req.headers.origin;
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && this.opts.origins.length && !this.opts.origins.includes(origin))) {
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
    const raw = cleanName(b.name, 0);
    const name = raw === 'Driver 0' ? 'Driver' : raw;
    const stored = this.store.addRun({ mode: 'solo', name, score, car, physics, near, topKmh, seconds });
    const rank = stored ? this.store.leaderboard('solo', 100).find((e) => e.name.toLowerCase() === name.toLowerCase())?.rank : undefined;
    send(res, 200, { ok: true, stored, rank });
  }

  private postLog(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
    const ctx = { page: str(b.page, 20), ua: str(b.ua, 200), gpu: str(b.gpu, 120), quality: str(b.quality, 10), server: this.opts.version ?? '' };
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
