/*
 * Online game server: one shared ring, up to MAX_PLAYERS drivers.
 *
 *   npm run server          dev (tsx, restarts on change)
 *   npm run build:server    → dist-server/main.js, run with `node dist-server/main.js`
 *
 * HTTP  GET /health  JSON status (tick, players, step times, traffic, memory)
 *       /api/...     leaderboard, solo runs, page diagnostics (server/api.ts)
 *       /api/admin/  the admin page's API (server/admin.ts), only with ADMIN_PASSWORD
 * WS    /ws          the game protocol (src/online/protocol.ts)
 *
 * Environment:
 *   PORT (8787), HOST (0.0.0.0)
 *   ORIGINS        comma-separated allowed page origins (empty = any; set it in production)
 *   GIT_SHA        build version reported by /health (the deploy checks it)
 *   MAX_PLAYERS    (5)          TRAFFIC  1 normal | 2 dense (1)     INTENSITY 0..1 (0.45)
 *   SEED           world seed (random)
 *   JOURNAL_DIR    write a replayable session journal there (off by default)
 *   JOURNAL_MAX_MB stop journalling past this size (200)
 *   LOG_EVERY      seconds between status log lines (60)
 *   DB_PATH        SQLite file for the leaderboard and the diagnostics log (./data/traffic.db)
 *   RADIO_DIR      persistent uploaded tracks (default: radio/ beside DB_PATH)
 *   ADMIN_PASSWORD password of the admin page (/admin.html); unset = no admin page
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, type LogLevel } from '../src/online/gameServer';
import { rulesHash, type OnlineRules } from '../src/online/rules';
import type { Stimulus, WorldConfig } from '../src/online/world';
import { Admin, TRAFFIC_SETTINGS } from './admin';
import { Api, clientIp } from './api';
import { Store } from './store';
import { RadioStore } from './radio';
import { currentTuning, type GlobalTuning } from '../src/sim/tuning';
import { restoreTuning } from './restoreTuning';
import { send } from './api';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? '0.0.0.0';
const ORIGINS = (env.ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LOG_EVERY = Number(env.LOG_EVERY ?? 60);
const seed = Number(env.SEED) || Math.floor(Math.random() * 2 ** 31);

const rules: Partial<OnlineRules> = {};
if (env.MAX_PLAYERS) rules.maxPlayers = Math.max(1, Math.min(64, Number(env.MAX_PLAYERS)));
if (env.TRAFFIC) rules.traffic = env.TRAFFIC === '2' ? 2 : 1;
if (env.INTENSITY) rules.intensity = Math.max(0, Math.min(1, Number(env.INTENSITY)));

// ------------------------------------------------------------------------- logging (bounded)

/** Diagnostics sink (set up below, once the database is open). */
let api: Api | undefined;

let logBurst = 0;
let logWindow = 0;
function log(level: LogLevel, text: string): void {
  // At most 50 lines per 10 s: a misbehaving client must not fill the disk.
  const now = Date.now();
  if (now - logWindow > 10_000) {
    if (logBurst > 50) console.warn(`${new Date().toISOString()} warn ${logBurst - 50} log lines suppressed`);
    logWindow = now;
    logBurst = 0;
  }
  // Warnings and errors also go to the diagnostics log (deduplicated and capped there).
  if (level !== 'info') api?.diag(level, text);
  if (++logBurst > 50) return;
  const line = `${new Date().toISOString()} ${level} ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ------------------------------------------------------------------------- journal

let journal: WriteStream | null = null;
let journalBytes = 0;
const journalMax = Number(env.JOURNAL_MAX_MB ?? 200) * 1024 * 1024;
if (env.JOURNAL_DIR) {
  mkdirSync(env.JOURNAL_DIR, { recursive: true });
  const file = join(env.JOURNAL_DIR, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  journal = createWriteStream(file);
  journal.write(JSON.stringify({ seed, rules, rulesHash: rulesHash(), started: new Date().toISOString() }) + '\n');
  log('info', `journal → ${file}`);
}
function record(s: Stimulus): void {
  if (!journal) return;
  const line = JSON.stringify(s) + '\n';
  journalBytes += line.length;
  if (journalBytes > journalMax) {
    log('warn', 'journal size limit reached: journalling stopped');
    journal.end();
    journal = null;
    return;
  }
  journal.write(line);
}

// ------------------------------------------------------------------------- game

// ------------------------------------------------------------------------- storage and API

const DB_PATH = env.DB_PATH ?? join('data', 'traffic.db');
mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new Store(DB_PATH);
const radio = new RadioStore(store, env.RADIO_DIR ?? join(dirname(DB_PATH), 'radio'));
api = new Api(store, { origins: ORIGINS, log, version: env.GIT_SHA ?? 'dev' });

process.on('uncaughtException', (e) => {
  api?.diag('error', `uncaught: ${e.message}`, e.stack);
  log('error', `uncaught: ${e.stack ?? e.message}`);
  // State may be broken: let the supervisor (Docker) restart the process.
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => {
  const err = e instanceof Error ? e : new Error(String(e));
  log('error', `unhandled rejection: ${err.message}`);
  api?.diag('error', `unhandled rejection: ${err.message}`, err.stack);
});

const game = new GameServer({
  seed,
  rules,
  log,
  journal: env.JOURNAL_DIR ? record : undefined,
  onRun: (dr, run) => {
    try {
      store.addRun({ mode: 'online', name: dr.name, score: run.score, car: dr.body, physics: dr.physics, near: run.near, topKmh: run.topKmh, seconds: run.time });
    } catch (e) {
      log('error', `leaderboard write failed: ${(e as Error).message}`);
    }
  },
});

// Traffic as the admin page left it before the restart (else the defaults: TRAFFIC, INTENSITY).
const savedTraffic = store.setting<WorldConfig>(TRAFFIC_SETTINGS);
if (savedTraffic) {
  game.configure(savedTraffic);
  log('info', `traffic settings restored: ${JSON.stringify(savedTraffic)}`);
}
const savedTuning = store.setting<GlobalTuning>('tuning');
if (savedTuning) {
  try {
    const restored = restoreTuning(savedTuning);
    game.setTuning(restored);
    if (savedTuning.r34Revision !== restored.r34Revision) store.setSetting('tuning', restored);
  }
  catch (error) { log('warn', `Invalid saved tuning, using shipped defaults: ${String(error)}`); }
}

const admin = new Admin({
  password: env.ADMIN_PASSWORD ?? '',
  origins: ORIGINS,
  game,
  store,
  radio,
  health: () => health(false),
  diag: (level, message) => api?.diag(level, message),
});
if (admin.enabled && (env.ADMIN_PASSWORD ?? '').length < 12) log('warn', 'ADMIN_PASSWORD is short: use 12+ characters');

function health(reset: boolean) {
  const mem = process.memoryUsage();
  return {
    ok: true,
    /** Commit the running build came from (set by the Docker build; checked after every deploy). */
    version: env.GIT_SHA ?? 'dev',
    rules: rulesHash(),
    seed,
    uptimeS: Math.round(process.uptime()),
    rssMB: +(mem.rss / 1048576).toFixed(1),
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    ...game.health(reset),
  };
}

const http = createServer((req, res) => {
  if (admin.handle(req, res)) return;
  if (radio.handle(req, res)) return;
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/tuning') { res.setHeader('access-control-allow-origin', '*'); send(res, 200, currentTuning()); return; }
  if (api?.handle(req, res)) return;
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(health(false)));
    return;
  }
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Traffic Cutting Up game server. WebSocket: /ws, status: /health\n');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
  verifyClient: (info: { origin: string }) => ORIGINS.length === 0 || ORIGINS.includes(info.origin),
});

const alive = new WeakMap<WebSocket, boolean>();
wss.on('connection', (ws, req) => {
  ws.binaryType = 'nodebuffer';
  const addr = clientIp(req);
  const conn = game.connect({
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    get buffered() {
      return ws.bufferedAmount;
    },
    addr,
  });
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      conn.receive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } else {
      conn.receive(data.toString());
    }
  });
  ws.on('close', () => conn.close());
  ws.on('error', () => conn.close());
  log('info', `connect ${addr} (${game.connectionCount} open)`);
});

// Dead sockets (no TCP close, e.g. a laptop lid shut) are found by WS-level pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 15_000);

// ------------------------------------------------------------------------- fixed-rate loop

const tickMs = 1000 / game.world.rules.tickHz;
const now = () => performance.now();
let next = now();
let lagDrops = 0;
function loop(): void {
  const t = now();
  let n = 0;
  while (t >= next && n < 12) {
    const t0 = now();
    game.tick(now);
    const ms = now() - t0;
    // A tick over its whole budget (8.3 ms) is a real problem: note it with what was going on.
    if (ms > tickMs) api?.diag('warn', 'slow tick', {
      ms: +ms.toFixed(2), ...game.timing,
      players: game.playerCount, traffic: game.world.traffic.activeCount,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    });
    next += tickMs;
    n++;
  }
  if (t - next > 250) {
    // Fell far behind (paused VM, GC storm): drop the backlog instead of fast-forwarding the world.
    lagDrops++;
    api?.diag('warn', 'server fell behind, backlog dropped', { behindMs: Math.round(t - next) });
    next = t;
  }
  setTimeout(loop, Math.max(0, next - now() - 0.5));
}

const status = setInterval(() => {
  const h = health(true);
  if (h.rssMB > 400) api?.diag('warn', 'high memory', { rssMB: h.rssMB, heapMB: h.heapMB, players: h.players });
  log('info', `tick ${h.tick} players ${h.players} conn ${h.connections} traffic ${h.traffic} step avg ${h.stepAvgMs} max ${h.stepMaxMs} ms rss ${h.rssMB} MB snaps ${h.snapshots} skipped ${h.skipped} lagDrops ${lagDrops}`);
}, LOG_EVERY * 1000);

api?.diag('info', `start ${env.GIT_SHA ?? 'dev'}`, { rules: rulesHash(), seed, maxPlayers: game.world.rules.maxPlayers });

http.listen(PORT, HOST, () => {
  log('info', `listening on ${HOST}:${PORT} (rules ${rulesHash()}, seed ${seed}, max ${game.world.rules.maxPlayers} players, traffic ${game.world.rules.traffic})`);
  loop();
});

function shutdown(signal: string): void {
  log('info', `${signal}: shutting down`);
  game.closeAll('Сервер перезапускается');
  clearInterval(heartbeat);
  clearInterval(status);
  journal?.end();
  api?.close();
  store.close();
  wss.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
