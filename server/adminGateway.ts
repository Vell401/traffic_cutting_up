import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform } from 'node:stream';
import type { Admin } from './admin';
import { send } from './api';
import { parseRequestTarget } from './requestTarget';
import { RADIO_MAX_TRACK_BYTES } from '../src/audio/radioTypes';

const PREFIX = '/api/admin/maps/miami/';
const JSON_MAX = 16 * 1024;
// Bounded diagnostics replies; clients can request smaller batches for unusually large log rows.
const RESPONSE_MAX = 32 * 1024 * 1024;
const READS: Readonly<Record<string, readonly string[]>> = { state: [], logs: ['limit', 'source'], board: ['mode', 'limit'] };
const WRITES: Readonly<Record<string, readonly string[]>> = {
  traffic: [], players: [], kick: [], unban: [], say: [], tuning: [], radio: [], 'board/remove': [],
  'radio/upload': ['playlist', 'title'],
};
const AUDIO = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/flac', 'audio/x-flac'];

interface Options {
  admin: Admin; url?: string; password: string;
  /** Control requests and health/login exchanges: default 15s, capped at 120s. */
  timeoutMs?: number;
  /** Absolute upload lifetime including setup/delivery: default and maximum 180s. */
  uploadTimeoutMs?: number;
}
interface Session { token: string; until: number }
interface Reply { status: number; body: Record<string, unknown> }
class Failure extends Error { constructor(readonly status = 503) { super('Miami admin unavailable'); } }

/** Strict configuration parsing: no userinfo, redirects, query, fragment or ambiguous base paths. */
function destination(value?: string): URL | undefined {
  if (!value || value.trim() !== value || !/^https?:\/\//.test(value) || /[\\\s?#]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname || !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname)) return;
    // URL parsing normalizes dot segments; forbid those in the original configured path too.
    if (value.slice(value.indexOf('://') + 3).includes('/.')) return;
    url.pathname = url.pathname.replace(/\/$/, '') + '/';
    return url;
  } catch { return; }
}

/** Defense in depth for diagnostics returned by an internal service: credentials are never data. */
function redact(value: unknown, secrets: readonly string[]): unknown {
  const text = (s: string) => secrets.reduce((result, secret) => secret ? result.split(secret).join('[redacted]') : result, s);
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), redact(item, secrets)]));
  return value;
}

/** One fixed internal destination; browser authorization is never an upstream credential. */
export class AdminGateway {
  private readonly base: URL | undefined;
  private readonly timeout: number;
  private readonly uploadTimeout: number;
  private cached?: Session;
  private refreshing?: Promise<Session>;

  constructor(private readonly o: Options) {
    this.base = destination(o.url);
    this.timeout = Number.isFinite(o.timeoutMs) && o.timeoutMs! > 0 ? Math.min(o.timeoutMs!, 120_000) : 15_000;
    this.uploadTimeout = Number.isFinite(o.uploadTimeoutMs) && o.uploadTimeoutMs! > 0 ? Math.min(o.uploadTimeoutMs!, 180_000) : 180_000;
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const raw = req.url ?? '/';
    const url = parseRequestTarget(raw);
    if (!url) { send(res, 400, { ok: false, error: 'Invalid request target' }); return true; }
    if (!url.pathname.startsWith(PREFIX) && !raw.startsWith(PREFIX) && url.pathname !== PREFIX.slice(0, -1)) return false;
    const path = url.pathname.slice(PREFIX.length);
    const upload = req.method === 'POST' && path === 'radio/upload';
    if (!this.o.admin.authorize(req, res, upload)) return true;
    // Never normalize a browser target into an allowed route (absolute form, escapes, dot segments).
    if (!raw.startsWith(PREFIX) || raw.split('?')[0] !== PREFIX + path || /[%\\#]/.test(raw.split('?')[0]) || raw.length > 4096) {
      send(res, 400, { ok: false }); return true;
    }
    const read = Object.hasOwn(READS, path), write = Object.hasOwn(WRITES, path);
    if (!read && !write) { send(res, 404, { ok: false }); return true; }
    if ((read && req.method !== 'GET') || (write && req.method !== 'POST')) { send(res, 405, { ok: false }); return true; }
    const allowed = read ? READS[path] : WRITES[path];
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length ||
        (url.searchParams.has('source') && !['client', 'server'].includes(url.searchParams.get('source')!)) ||
        (url.searchParams.has('mode') && !['solo', 'online'].includes(url.searchParams.get('mode')!)) || raw.includes('#') || /%(?![a-fA-F0-9]{2})/.test(raw)) {
      send(res, 400, { ok: false }); return true;
    }
    if (!this.base || !this.o.password) { send(res, 503, { ok: false, error: 'Miami admin unavailable' }); return true; }
    const max = upload ? RADIO_MAX_TRACK_BYTES : JSON_MAX;
    if (Number(req.headers['content-length'] ?? 0) > max) {
      res.setHeader('connection', 'close'); send(res, 413, { ok: false }); return true;
    }
    if (upload && !AUDIO.includes(String(req.headers['content-type'] ?? '').split(';')[0])) { send(res, 415, { ok: false }); return true; }
    void this.dispatch(req, res, path, url.search, upload);
    return true;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, path: string, search: string, upload: boolean): Promise<void> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    let flush: ReturnType<typeof setImmediate> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (flush) clearImmediate(flush);
      req.removeListener('aborted', cancel);
      res.removeListener('finish', cleanup); res.removeListener('close', closed);
    };
    const closed = () => { cancel(); cleanup(); };
    const timer = setTimeout(() => {
      cancel();
      if (res.headersSent) res.destroy();
      else {
        // Let the aborted operation queue its sanitized 503, but never wait for a slow reader.
        flush = setImmediate(() => { if (!res.writableFinished) res.destroy(); });
      }
    }, upload ? this.uploadTimeout : this.timeout);
    req.once('aborted', cancel);
    res.once('finish', cleanup); res.once('close', closed);
    try {
      const body = req.method === 'POST' && !upload ? await this.jsonBody(req, abort.signal) : undefined;
      await this.checkHealth(abort.signal);
      if (abort.signal.aborted || req.aborted || res.destroyed) throw new Failure();
      if (!this.o.admin.authorize(req, res, upload)) return;
      const session = await this.session(abort.signal);
      // Setup can await a remote login. Check again immediately before writes, not just before login.
      if (req.method === 'POST') await this.checkHealth(abort.signal);
      // Logout/expiry/origin admission must survive both asynchronous health and login setup.
      if (abort.signal.aborted || req.aborted || res.destroyed) throw new Failure();
      if (!this.o.admin.authorize(req, res, upload)) return;
      const reply = await this.exchange('api/admin/' + path + search, req.method!, session.token, upload ? req : body, abort.signal);
      if (reply.status === 401) {
        if (this.cached === session) this.cached = undefined;
        throw new Failure(); // No replay, including reads. Never invalidate the central bearer.
      }
      if (reply.status < 200 || reply.status >= 300) throw new Failure([400, 404, 409, 413, 415, 429].includes(reply.status) ? reply.status : 503);
      if (upload && !req.complete) throw new Failure();
      if ((path === 'state' || path === 'board') && reply.body.map !== 'miami') throw new Failure();
      if (reply.body.map !== undefined && reply.body.map !== 'miami') throw new Failure();
      res.setHeader('x-map-id', 'miami');
      send(res, reply.status, redact(reply.body, [session.token, this.o.password]));
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        // Stop an incomplete upload without draining unbounded client bytes or leaking errors/URLs.
        if (!req.complete) {
          req.pause(); res.setHeader('connection', 'close');
          // Closing a TCP socket with unread in-flight bytes can erase the 413 with a reset.
          // Discard at most 1MiB under a short drain budget; the absolute deadline still applies.
          await this.discard(req, abort.signal);
        }
        if (res.destroyed) return;
        const status = error instanceof Failure ? error.status : 503;
        send(res, status, { ok: false, error: status === 503 ? 'Miami admin unavailable' : 'Miami admin request rejected' });
      }
    } finally {
      // res.end() only queues output: the deadline/close guard lives through finish or close.
      req.removeListener('aborted', cancel);
      abort.abort();
    }
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    const health = await this.exchange('health', 'GET', undefined, undefined, signal, JSON_MAX);
    if (health.status !== 200 || health.body.ok !== true || health.body.map !== 'miami') throw new Failure();
  }

  private discard(req: IncomingMessage, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      let bytes = 0;
      const finish = () => {
        clearTimeout(timer);
        req.pause(); req.removeListener('data', data); req.removeListener('end', finish);
        req.removeListener('error', finish); signal.removeEventListener('abort', finish); resolve();
      };
      const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(); };
      const timer = setTimeout(finish, this.timeout);
      req.on('data', data); req.once('end', finish); req.once('error', finish);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || req.aborted || req.complete) finish(); else req.resume();
    });
  }

  private session(signal: AbortSignal): Promise<Session> {
    if (signal.aborted) return Promise.reject(new Failure());
    if (this.cached && this.cached.until > Date.now()) return Promise.resolve(this.cached);
    this.cached = undefined;
    if (!this.refreshing) {
      // Callers already checked public identity. One bounded refresh, not one token per browser.
      const refresh = this.exchange('api/admin/login', 'POST', undefined, Buffer.from(JSON.stringify({ password: this.o.password })), undefined, JSON_MAX)
        .then(reply => {
          const { token, expiresIn } = reply.body;
          if (reply.status !== 200 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Failure();
          const ttl = Math.min(expiresIn * 1000, 12 * 3600_000);
          return this.cached = { token, until: Date.now() + ttl - Math.min(1000, ttl * .1) };
        });
      this.refreshing = refresh;
      void refresh.finally(() => { if (this.refreshing === refresh) this.refreshing = undefined; }).catch(() => {});
    }
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(new Failure());
      signal.addEventListener('abort', cancelled, { once: true });
      // An individual browser may stop waiting, without cancelling another browser's shared login.
      void this.refreshing!.then(
        session => { signal.removeEventListener('abort', cancelled); resolve(session); },
        error => { signal.removeEventListener('abort', cancelled); reject(error); },
      );
    });
  }

  private jsonBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error) => {
        req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', failed);
        signal.removeEventListener('abort', cancelled);
        if (error) { req.pause(); reject(error); }
      };
      const failed = (error: Error) => finish(error);
      const cancelled = () => finish(new Failure());
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > JSON_MAX) finish(new Failure(413));
        else chunks.push(chunk);
      };
      const end = () => {
        finish(); const body = Buffer.concat(chunks);
        try { JSON.parse(body.toString('utf8')); resolve(body); } catch { reject(new Failure(400)); }
      };
      req.on('data', data); req.once('end', end); req.once('error', failed);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
  }

  /** Bounded JSON replies; upload bodies are piped with backpressure and never collected. */
  private exchange(path: string, method: string, token?: string, body?: Buffer | IncomingMessage, signal?: AbortSignal, max = RESPONSE_MAX): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const target = new URL(path, this.base!);
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (Buffer.isBuffer(body)) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
      else if (body) {
        // Deliberate allowlist: no browser Origin/Host/cookie/forwarding or arbitrary hop headers.
        headers['content-type'] = String(body.headers['content-type']);
        if (body.headers['content-length']) headers['content-length'] = body.headers['content-length'];
      }
      let finished = false;
      let limiter: Transform | undefined;
      const done = (error?: Error, reply?: Reply) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (body && !Buffer.isBuffer(body)) { body.unpipe(limiter!); limiter?.unpipe(upstream); limiter?.destroy(); }
        if (error) { upstream.destroy(); reject(error); } else resolve(reply!);
      };
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, signal, maxHeaderSize: 16 * 1024, agent: false }, response => {
        if (response.headers['x-map-id'] !== 'miami') { response.destroy(); done(new Failure()); return; }
        if (response.statusCode! < 200 || response.statusCode! >= 300) {
          // Do not read/parse/reflect error or redirect bodies. Even a non-JSON 401 expires the cache.
          response.destroy(); done(undefined, { status: response.statusCode!, body: {} }); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > max) { response.destroy(); done(new Failure()); }
          else chunks.push(chunk);
        });
        response.once('error', () => done(new Failure()));
        response.once('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Failure();
            done(undefined, { status: response.statusCode!, body: value as Record<string, unknown> });
          } catch { done(new Failure()); }
        });
      });
      // Health/login/ordinary JSON remain short even when setting up a long upload.
      const timer = setTimeout(() => done(new Failure()), body && !Buffer.isBuffer(body) ? this.uploadTimeout : this.timeout);
      upstream.once('error', () => done(new Failure()));
      if (body && !Buffer.isBuffer(body)) {
        let bytes = 0;
        limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > RADIO_MAX_TRACK_BYTES) callback(new Failure(413)); else callback(null, chunk);
        } });
        limiter.once('error', error => done(error));
        body.pipe(limiter).pipe(upstream);
      } else upstream.end(body);
    });
  }
}
