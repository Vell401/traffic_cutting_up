/*
 * Admin API behind the admin page (/admin.html), all under /api/admin. Off unless ADMIN_PASSWORD is
 * set on the server.
 *
 *   POST /api/admin/login   {password}            → {token}: a session for 12 h
 *   POST /api/admin/logout
 *   GET  /api/admin/state                         server health, rules, traffic, drivers, bans
 *   POST /api/admin/traffic {trafficOn?, traffic?, intensity?, mode?, modePerKm?: {mode, perKm}}
 *                          (kept in the database: the server starts with them after a restart)
 *   POST /api/admin/players {maxPlayers}
 *   POST /api/admin/kick    {id, banMinutes?}
 *   POST /api/admin/unban   {addr}
 *   POST /api/admin/say     {text}                 a line in every driver's feed
 *   GET  /api/admin/logs?limit=200&source=client|server
 *   GET  /api/admin/board?mode=solo|online&limit=50
 *   POST /api/admin/board/remove {mode, name}      delete a player's runs from one board
 *
 * Every request after the login carries `Authorization: Bearer <token>`. Writes must be JSON from our
 * own pages. Wrong passwords: 8 tries per address and 40 overall per 10 minutes. Every change goes to
 * the diagnostics log with the address it came from.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameServer } from '../src/online/gameServer';
import { TRAFFIC_MODES, type WorldConfig } from '../src/online/world';
import type { TrafficMode } from '../src/sim/director';
import { MAX_PER_KM } from '../src/sim/traffic';
import { Limiter, clientIp, ownJson, readJson, send } from './api';
import type { RunMode, Store } from './store';

const SESSION_MS = 12 * 3600_000;
/** Settings key of the traffic configuration the admin page set last. */
export const TRAFFIC_SETTINGS = 'traffic';

/** The traffic settings to keep: everything the admin page can change about traffic, as it is now. */
export function trafficSettings(game: GameServer): WorldConfig {
  const t = game.trafficState();
  const densities: Partial<Record<TrafficMode, number>> = {};
  for (const d of t.densities) densities[d.mode] = d.perKm;
  return { trafficOn: t.on, traffic: t.preset, intensity: t.intensity, mode: t.held ? t.mode : 'auto', densities };
}
const MAX_SESSIONS = 50;

export interface AdminOptions {
  /** Empty: the admin API answers 404 to everything. */
  password: string;
  origins: readonly string[];
  game: GameServer;
  store: Store;
  /** Server status (the same as /health). */
  health: () => object;
  /** Audit and problems (the diagnostics log). */
  diag: (level: 'info' | 'warn', message: string) => void;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class Admin {
  private readonly sessions = new Map<string, number>();
  private readonly perAddr = new Limiter(8);
  private readonly overall = new Limiter(40);

  constructor(private readonly o: AdminOptions) {}

  get enabled(): boolean {
    return this.o.password.length > 0;
  }

  /** Handles /api/admin/*; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/admin/')) return false;
    if (!this.enabled) {
      send(res, 404, { ok: false, error: 'admin is off (ADMIN_PASSWORD not set)' });
      return true;
    }
    const path = url.pathname.slice('/api/admin/'.length);
    const ip = clientIp(req);
    if (req.method === 'POST' && !ownJson(req, this.o.origins)) {
      send(res, 403, { ok: false });
      return true;
    }
    if (req.method === 'POST' && path === 'login') {
      this.withBody(req, res, (b) => this.login(b, ip, res));
      return true;
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.valid(token)) {
      send(res, 401, { ok: false, error: 'login' });
      return true;
    }
    if (req.method === 'GET') {
      if (path === 'state') send(res, 200, this.state());
      else if (path === 'logs') {
        const source = url.searchParams.get('source');
        const rows = this.o.store.recentLogs(Number(url.searchParams.get('limit')) || 200, source === 'client' || source === 'server' ? source : undefined);
        send(res, 200, { ok: true, rows });
      } else if (path === 'board') {
        const mode: RunMode = url.searchParams.get('mode') === 'online' ? 'online' : 'solo';
        send(res, 200, { ok: true, mode, entries: this.o.store.leaderboard(mode, Number(url.searchParams.get('limit')) || 50) });
      } else send(res, 404, { ok: false });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false });
      return true;
    }
    if (path === 'logout') {
      this.sessions.delete(token);
      send(res, 200, { ok: true });
      return true;
    }
    this.withBody(req, res, (b) => this.action(path, b, ip, res));
    return true;
  }

  private withBody(req: IncomingMessage, res: ServerResponse, then: (b: Record<string, unknown>) => void): void {
    readJson(req).then(
      (body) => then((body ?? {}) as Record<string, unknown>),
      (e: Error) => send(res, e.message === 'too large' ? 413 : 400, { ok: false }),
    );
  }

  private login(b: Record<string, unknown>, ip: string, res: ServerResponse): void {
    if (!this.perAddr.take(ip) || !this.overall.take('all')) {
      send(res, 429, { ok: false, error: 'Слишком много попыток, подождите 10 минут' });
      return;
    }
    const given = typeof b.password === 'string' ? b.password : '';
    if (!timingSafeEqual(digest(given), digest(this.o.password))) {
      this.o.diag('warn', `admin: wrong password from ${ip}`);
      send(res, 401, { ok: false, error: 'Неверный пароль' });
      return;
    }
    const now = Date.now();
    for (const [t, until] of this.sessions) if (until < now) this.sessions.delete(t);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_MS);
    this.o.diag('info', `admin: login from ${ip}`);
    send(res, 200, { ok: true, token, expiresIn: SESSION_MS / 1000 });
  }

  private valid(token: string): boolean {
    const until = token ? this.sessions.get(token) : undefined;
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private state(): object {
    const g = this.o.game;
    const now = Date.now();
    return {
      ok: true,
      server: this.o.health(),
      rules: { maxPlayers: g.world.rules.maxPlayers, tickHz: g.world.rules.tickHz, ringKm: +(g.world.ringLen / 1000).toFixed(2) },
      traffic: g.trafficState(),
      modes: TRAFFIC_MODES,
      drivers: g.adminDrivers(),
      bans: [...g.bans].filter(([, until]) => until > now).map(([addr, until]) => ({ addr, until })),
    };
  }

  private action(path: string, b: Record<string, unknown>, ip: string, res: ServerResponse): void {
    const g = this.o.game;
    const audit = (text: string) => this.o.diag('info', `admin (${ip}): ${text}`);
    switch (path) {
      case 'traffic': {
        const cfg: WorldConfig = {};
        if (typeof b.trafficOn === 'boolean') cfg.trafficOn = b.trafficOn;
        if (b.traffic === 1 || b.traffic === 2) cfg.traffic = b.traffic;
        if (typeof b.intensity === 'number' && b.intensity >= 0 && b.intensity <= 1) cfg.intensity = b.intensity;
        if (b.mode === 'auto' || TRAFFIC_MODES.includes(b.mode as never)) cfg.mode = b.mode as WorldConfig['mode'];
        const pk = b.modePerKm as { mode?: unknown; perKm?: unknown } | undefined;
        if (pk && TRAFFIC_MODES.includes(pk.mode as never) && typeof pk.perKm === 'number' && Number.isFinite(pk.perKm) && pk.perKm >= 0 && pk.perKm <= MAX_PER_KM) {
          cfg.modePerKm = { mode: pk.mode as TrafficMode, perKm: pk.perKm };
        }
        if (Object.keys(cfg).length === 0) return send(res, 400, { ok: false });
        g.configure(cfg);
        this.o.store.setSetting(TRAFFIC_SETTINGS, trafficSettings(g));
        audit(`traffic ${JSON.stringify(cfg)}`);
        return send(res, 200, { ok: true, traffic: g.trafficState() });
      }
      case 'players': {
        const n = b.maxPlayers;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 64) return send(res, 400, { ok: false });
        g.configure({ maxPlayers: n });
        audit(`max players ${n}`);
        return send(res, 200, { ok: true });
      }
      case 'kick': {
        const ban = typeof b.banMinutes === 'number' && b.banMinutes > 0 ? Math.min(7 * 24 * 60, Math.round(b.banMinutes)) : 0;
        const name = typeof b.id === 'number' ? g.kickDriver(b.id, ban) : null;
        if (name === null) return send(res, 404, { ok: false, error: 'Игрок уже ушёл' });
        audit(`kick #${String(b.id)} ${name}${ban ? `, ban ${ban} min` : ''}`);
        return send(res, 200, { ok: true });
      }
      case 'unban': {
        const addr = typeof b.addr === 'string' ? b.addr : '';
        if (!g.bans.delete(addr)) return send(res, 404, { ok: false });
        audit(`unban ${addr}`);
        return send(res, 200, { ok: true });
      }
      case 'say': {
        const text = typeof b.text === 'string' ? b.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) : '';
        if (!text) return send(res, 400, { ok: false });
        g.announce(text);
        audit(`say "${text}"`);
        return send(res, 200, { ok: true });
      }
      case 'board/remove': {
        const mode: RunMode = b.mode === 'online' ? 'online' : 'solo';
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return send(res, 400, { ok: false });
        const removed = this.o.store.removeRuns(mode, name);
        audit(`board ${mode}: removed ${removed} runs of "${name}"`);
        return send(res, 200, { ok: true, removed });
      }
      default:
        send(res, 404, { ok: false });
    }
  }
}
