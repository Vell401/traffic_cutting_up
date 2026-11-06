/*
 * Smoke test of a running game server with real clients, end to end:
 *
 *   node dist-server/smoke.js --url ws://127.0.0.1:8787/ws
 *   node dist-server/smoke.js --url wss://1.2.3.4/ws --origin https://1.2.3.4 --insecure --version abc1234
 *
 * Each client is the full game client (protocol, rules hash, prediction) driven by the lane-keeping
 * bot. Every client must:
 *   - be welcomed (a reject means the server runs other code: protocol or rules differ);
 *   - get snapshots at ~30 Hz for the whole run and keep the connection;
 *   - drive off the spawn pad (the server applies its inputs);
 *   - see the other clients on the ring;
 *   - stay close to the server (prediction corrections under 2 m).
 * /health must answer, count the clients and (with --version) report that build.
 * Exit 0: all good. Exit 1: what failed is printed.
 *
 * Built into dist-server/smoke.js with the server (npm run build:server), so it also runs from the
 * game image on the VPS after a deploy.
 */
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { mulberry32 } from '../src/core/rng';
import { ClientCore } from '../src/online/clientCore';
import type { PhysicsId } from '../src/sim/physics';
import { Sim } from '../src/sim/world';
import { Bot } from '../tests/netsim';

interface Options {
  url: string;
  origin?: string;
  insecure: boolean;
  clients: number;
  seconds: number;
  version?: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { url: 'ws://127.0.0.1:8787/ws', insecure: false, clients: 2, seconds: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--url') o.url = next();
    else if (a === '--origin') o.origin = next();
    else if (a === '--insecure') o.insecure = true;
    else if (a === '--clients') o.clients = Math.max(1, Number(next()) || 1);
    else if (a === '--seconds') o.seconds = Math.max(3, Number(next()) || 10);
    else if (a === '--version') o.version = next() || undefined;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function healthUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/health';
  return u.toString();
}

function getJson(url: string, insecure: boolean): Promise<Record<string, unknown>> {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { rejectUnauthorized: !insecure, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

interface Client {
  name: string;
  sim: Sim;
  core: ClientCore;
  ws: WebSocket;
  welcomed: boolean;
  rejected: string;
  error: string;
  closed: boolean;
  snapshots: number;
  startS: number | null;
  timers: ReturnType<typeof setInterval>[];
}

function startClient(i: number, o: Options): Client {
  const rng = mulberry32(900 + i);
  const physics: PhysicsId = i % 2 === 0 ? 1 : 2;
  const sim = new Sim(rng, { online: true, physics });
  const ws = new WebSocket(o.url, { origin: o.origin, rejectUnauthorized: !o.insecure, handshakeTimeout: 5000 });
  const c = { name: `Проверка ${i + 1}`, sim, ws, welcomed: false, rejected: '', error: '', closed: false, snapshots: 0, startS: null, timers: [] } as unknown as Client;
  c.core = new ClientCore(sim, {
    send: (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    },
    onWelcome: () => (c.welcomed = true),
    onReject: (text) => (c.rejected = text),
  });
  const bot = new Bot(sim, { kmh: 150, weave: false }, rng);
  ws.on('open', () => c.core.hello(c.name, physics, ((i % 3) + 1) as 1 | 2 | 3));
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      c.snapshots++;
      c.core.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), performance.now());
    } else c.core.receive(data.toString(), performance.now());
  });
  ws.on('error', (e) => (c.error ||= e.message));
  ws.on('close', () => (c.closed = true));
  let last = performance.now();
  let acc = 0;
  c.timers.push(
    setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      if (!c.core.ready) return;
      c.startS ??= sim.player.s;
      while (acc >= 1 / 120) {
        c.core.step(bot.drive(1 / 120));
        acc -= 1 / 120;
      }
      c.core.frame(0.016, now);
    }, 16),
  );
  return c;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const problems: string[] = [];
  console.log(`smoke: ${o.clients} clients for ${o.seconds} s on ${o.url}`);

  const before = await getJson(healthUrl(o.url), o.insecure).catch((e: Error) => {
    problems.push(`/health does not answer: ${e.message}`);
    return null;
  });
  if (before && o.version && before.version !== o.version) problems.push(`/health reports version ${String(before.version)}, expected ${o.version}`);
  if (problems.length) return finish(problems, []);

  const clients: Client[] = [];
  for (let i = 0; i < o.clients; i++) {
    clients.push(startClient(i, o));
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, (o.seconds * 1000) / 2));
  const during = await getJson(healthUrl(o.url), o.insecure).catch(() => null);
  if (!during) problems.push('/health stopped answering while clients were connected');
  else if (Number(during.players) < o.clients) problems.push(`/health counts ${String(during.players)} players, expected at least ${o.clients}`);
  await new Promise((r) => setTimeout(r, (o.seconds * 1000) / 2));

  for (const c of clients) {
    const st = c.core.stats;
    const moved = c.startS === null ? 0 : c.sim.player.s - c.startS;
    const tag = `${c.name}:`;
    if (c.rejected) problems.push(`${tag} rejected: ${c.rejected}`);
    else if (!c.welcomed) problems.push(`${tag} not welcomed${c.error ? ` (${c.error})` : ''}`);
    else {
      if (c.closed) problems.push(`${tag} connection closed during the run`);
      if (c.snapshots < o.seconds * 15) problems.push(`${tag} only ${c.snapshots} snapshots in ${o.seconds} s (expected ~30/s)`);
      if (moved < 20) problems.push(`${tag} car moved ${moved.toFixed(1)} m (inputs not applied?)`);
      if (c.sim.remotes.length < o.clients - 1) problems.push(`${tag} sees ${c.sim.remotes.length} other drivers, expected ${o.clients - 1}`);
      if (st.maxCorrection > 2) problems.push(`${tag} prediction corrected by ${st.maxCorrection.toFixed(2)} m`);
    }
    console.log(
      `  ${c.name}: ${c.welcomed ? 'joined' : 'no join'}, ${c.snapshots} snapshots, moved ${moved.toFixed(0)} m, ` +
        `${(c.sim.player.vAlong * 3.6).toFixed(0)} km/h, sees ${c.sim.remotes.length}, ping ${st.rtt.toFixed(0)} ms, ` +
        `max correction ${(st.maxCorrection * 100).toFixed(1)} cm`,
    );
  }
  finish(problems, clients);
}

function finish(problems: string[], clients: Client[]): void {
  for (const c of clients) {
    for (const t of c.timers) clearInterval(t);
    c.ws.close();
  }
  if (problems.length) {
    console.error(`smoke: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('smoke: OK');
  setTimeout(() => process.exit(), 300);
}

main().catch((e: Error) => {
  console.error(`smoke: FAILED\n  - ${e.message}`);
  process.exit(1);
});
