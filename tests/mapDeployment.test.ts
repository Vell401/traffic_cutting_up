import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { ViteDevServer } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compose = read('compose.yaml');
const deploy = read('deploy/deploy.sh');
const workflow = read('.github/workflows/test.yml');
const caddy = read('deploy/docker/Caddyfile');
const bash = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync)
  : 'bash';

async function world(map: string) {
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url!);
    if (req.url?.startsWith('/api/radio/audio/')) {
      res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-2/6' });
      res.end('abc');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, map, version: 'fixture', url: req.url, method: req.method, range: req.headers.range }));
  });
  const ws = new WebSocketServer({ noServer: true });
  ws.on('connection', socket => socket.send(map));
  server.on('upgrade', (req, socket, head) => {
    requests.push(req.url!);
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, ws, requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('map deployment routing', () => {
  let highway: Awaited<ReturnType<typeof world>>;
  let miami: Awaited<ReturnType<typeof world>>;
  let vite: ViteDevServer;
  let base: string;

  beforeAll(async () => {
    highway = await world('highway');
    miami = await world('miami');
    vi.stubEnv('GAME_SERVER', highway.url);
    vi.stubEnv('GAME_MIAMI_SERVER', miami.url);
    vi.resetModules();
    const { default: config } = await import('../vite.config');
    const resolved = config({ command: 'serve', mode: 'test', isSsrBuild: false });
    vite = await createViteServer({
      configFile: false,
      logLevel: 'silent',
      server: { ...resolved.server, host: '127.0.0.1', port: 0, strictPort: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await vite.listen();
    base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await vite?.close();
    for (const upstream of [highway, miami]) {
      if (!upstream) continue;
      upstream.ws.close();
      await new Promise<void>((resolve, reject) => upstream.server.close(error => error ? reject(error) : resolve()));
    }
    vi.unstubAllEnvs();
  });

  it('keeps highway routes and strips only the Miami prefix, including query strings', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ map: 'highway', url: '/health' });
    expect(await (await fetch(`${base}/miami/health?probe=1`)).json()).toMatchObject({ map: 'miami', url: '/health?probe=1' });
    for (const path of ['/api/map', '/api/tuning', '/api/admin/state', '/api/radio', '/api/radio?playlist=fixture']) {
      expect(await (await fetch(`${base}/miami${path}`)).json()).toMatchObject({ map: 'miami', url: path });
      expect(await (await fetch(`${base}${path}`)).json()).toMatchObject({ map: 'highway', url: path });
    }
    expect(highway.requests.some(path => path.startsWith('/miami'))).toBe(false);
    expect(miami.requests.some(path => path.startsWith('/miami'))).toBe(false);
  });

  it('preserves streamed radio range responses and admin HTTP methods', async () => {
    const audio = await fetch(`${base}/miami/api/radio/audio/fixture`, { headers: { range: 'bytes=0-2' } });
    expect(audio.status).toBe(206);
    expect(audio.headers.get('content-range')).toBe('bytes 0-2/6');
    expect(await audio.text()).toBe('abc');
    const admin = await fetch(`${base}/miami/api/admin/rules`, { method: 'POST', body: '{}' });
    expect(await admin.json()).toMatchObject({ map: 'miami', method: 'POST', url: '/api/admin/rules' });
  });

  it('upgrades both WebSocket paths to the correct world', async () => {
    for (const [path, expected] of [['/ws', 'highway'], ['/miami/ws', 'miami']]) {
      const client = new WebSocket(`${base.replace('http:', 'ws:')}${path}`);
      try {
        const identity = await new Promise<string>((resolve, reject) => {
          client.once('message', data => resolve(data.toString()));
          client.once('error', reject);
        });
        expect(identity).toBe(expected);
      } finally { client.close(); }
    }
    expect(miami.requests).toContain('/ws');
  });

  it('does not proxy Miami static files or lookalike prefixes', async () => {
    const { default: config } = await import('../vite.config');
    const { server } = config({ command: 'serve', mode: 'test', isSsrBuild: false });
    const [pattern] = Object.keys(server!.proxy!);
    const matcher = new RegExp(pattern);
    for (const path of ['/miami/assets/a.js', '/miami/index.html', '/miami/healthier', '/miami/apiary', '/miamian/ws']) {
      expect(matcher.test(path), path).toBe(false);
    }
    expect(caddy).toContain('route {');
    expect(caddy.indexOf('uri strip_prefix /miami')).toBeLessThan(caddy.indexOf('handle /miami/*'));
    expect(caddy).toContain('reverse_proxy game-miami:8787');
    expect(caddy).toContain('reverse_proxy game:8787');
    expect(caddy).toContain('respond "Not found" 404');
    expect(caddy).toContain('max-age=31536000, immutable');
    expect(caddy).toContain('Cache-Control "no-cache"');
  });
});

describe('map deployment safety gates', () => {
  it('lets hardened Caddy read host-owned TLS keys and checks actual HTTPS readiness', () => {
    const web = compose.slice(compose.indexOf('\n  web:'), compose.indexOf('\nnetworks:'));
    expect(web).toContain('cap_drop: [ALL]');
    expect(web).toContain('cap_add: [NET_BIND_SERVICE, DAC_READ_SEARCH]');
    expect(web).not.toContain('DAC_OVERRIDE');
    expect(web).toContain(':/certs:ro');
    expect(web).toContain('https://$$SITE_ADDRESS/health');
    expect(web).not.toContain('https://127.0.0.1/health');
    expect(web).toContain('no-new-privileges:true');
  });

  it('isolates durable DB/radio state and preserves the established highway volume', () => {
    expect(compose).toContain('name: traffic');
    expect(compose).toContain('image: traffic-game');
    expect(compose).toContain('MAP_ID: highway');
    expect(compose).toContain('MAP_ID: miami');
    expect(compose).toContain('- game_data:/data');
    expect(compose).toContain('- miami_data:/data');
    expect(compose).toContain('RADIO_DIR: /data/radio');
    expect(compose).toContain('<<: *game-service');
    expect(compose).toMatch(/game-miami:\r?\n        condition: service_healthy/);
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop: [ALL]');
    expect(compose).toContain('security_opt: [no-new-privileges:true]');
    expect(compose).toContain('mem_limit: 512m');
    expect(compose).toContain('tmpfs:');
    expect(compose).not.toMatch(/8787:8787|8788:8787|8793:8787/);
    expect(deploy).not.toMatch(/docker compose down|volume (?:rm|prune)|down[^\n]*-v/);
  });

  it('container health rejects wrong maps, builds, invalid JSON and unsuccessful responses', async () => {
    const code = compose.match(/- "(fetch\('[^\n]+)"/)![1];
    const check = async (body: object, ok = true) => {
      const exits: number[] = [];
      await runInNewContext(code, {
        fetch: async () => ({ ok, json: async () => body }),
        process: { env: { MAP_ID: 'miami', GIT_SHA: 'fixture' }, exit: (value: number) => exits.push(value) },
      });
      return exits;
    };
    expect(await check({ ok: true, map: 'miami', version: 'fixture' })).toEqual([]);
    for (const body of [
      { ok: true, map: 'highway', version: 'fixture' },
      { ok: true, map: 'miami', version: 'stale' },
      { ok: true, version: 'fixture' },
      { ok: false, map: 'miami', version: 'fixture' },
    ]) expect(await check(body)).toContain(1);
    expect(await check({ ok: true, map: 'miami', version: 'fixture' }, false)).toContain(1);
  });

  it('external health requires exact map and build, with a prefix-aware URL', () => {
    const code = deploy.match(/HEALTH_CHECK_JS='([\s\S]*?)'\r?\n/)![1];
    const check = (body: string) => spawnSync(process.execPath, ['-e', code, 'miami', 'fixture'], { input: body }).status;
    expect(check(JSON.stringify({ ok: true, map: 'miami', version: 'fixture' }))).toBe(0);
    expect(check(JSON.stringify({ ok: true, map: 'highway', version: 'fixture' }))).toBe(1);
    expect(check(JSON.stringify({ ok: true, map: 'miami', version: 'old-fixture' }))).toBe(1);
    expect(check(JSON.stringify({ ok: true, version: 'fixture', note: 'miami' }))).toBe(1);
    expect(check('<html>not health</html>')).toBe(1);
    expect(deploy).toContain('"$BASE$prefix/health"');
    expect(deploy).toContain('"$BASE$prefix/api/map"');
    expect(deploy).toContain('"wss://$SITE_ADDRESS$prefix/ws"');
    expect(deploy).toContain('--map "$map"');
  });

  it('rolls back startup and external failures without inventing a previous Miami', () => {
    expect(deploy).toContain('previous_miami_container=$(docker compose ps -q game-miami)');
    expect(deploy).toContain("h.map !== 'miami'");
    expect(deploy).toContain('if [ "$have_previous_miami" != 1 ]; then');
    expect(deploy).toContain('docker compose stop game-miami');
    expect(deploy).toContain('local services=(game web)');
    expect(deploy).toContain('image: traffic-game-miami:previous');
    expect(deploy).toContain('--no-deps --no-build --wait');
    expect(deploy).toMatch(/if ! docker compose up[^\n]+; then\n  rollback/);
    expect(deploy).toMatch(/if ! verify; then\n  rollback/);
  });

  it.skipIf(!bash)('executes rollback safely for first rollout, existing Miami and no previous images', () => {
    const directory = mkdtempSync(join(tmpdir(), 'traffic-rollback-test-'));
    const trace = join(directory, 'docker.trace');
    const rollback = deploy.match(/rollback\(\) \{[\s\S]*?\n\}\n/)![0];
    try {
      for (const [previous, previousMiami] of [[1, 0], [1, 1], [0, 0]]) {
        const result = spawnSync(bash!, ['-c', `
          set -euo pipefail
          docker() {
            printf '%s\\n' "$*" >> "$TRACE"
            if [[ "$1" == compose && "\${2:-}" == -f ]]; then
              cat "$5" >> "$TRACE"
            fi
          }
          IMAGES=(traffic-game traffic-web)
          have_previous=${previous}
          have_previous_miami=${previousMiami}
          ${rollback}
          rollback
        `], { encoding: 'utf8', env: { ...process.env, TRACE: trace, TMPDIR: directory } });
        expect(result.status, result.stderr).toBe(0);
        const commands = readFileSync(trace, 'utf8');
        if (!previousMiami) {
          expect(commands).toContain('compose stop game-miami');
          expect(commands).not.toContain('120 game web game-miami');
        } else {
          expect(commands).not.toContain('compose stop game-miami');
          expect(commands).toContain('image: traffic-game-miami:previous');
          expect(commands).toContain('120 game web game-miami');
        }
        if (previous) {
          expect(commands).toContain('tag traffic-game:previous traffic-game:latest');
          expect(commands).toContain('tag traffic-web:previous traffic-web:latest');
          expect(commands).toContain('--no-deps --no-build --wait --wait-timeout 120 game web');
          expect(commands).toContain("h.map !== undefined && h.map !== 'highway'");
        } else expect(commands).not.toContain(' up ');
        rmSync(trace);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('CI runs both built worlds with separate DBs/radio dirs, readiness identity and process cleanup', () => {
    expect(workflow).toContain('node-version: 22');
    for (const [map, port] of [['highway', '8793'], ['miami', '8788']]) {
      expect(workflow).toContain(`MAP_ID=${map} PORT=${port} GIT_SHA=ci DB_PATH="$data/${map}/traffic.db" RADIO_DIR="$data/${map}/radio" node dist-server/main.js`);
    }
    expect(workflow).toContain('h.map === process.argv[1] && h.version === "ci"');
    expect(workflow).toContain('--map "$map" --clients 3 --seconds 10 --version ci');
    expect(workflow).toContain('trap cleanup EXIT');
    expect(workflow).toContain('kill "$pid"');
    expect(workflow).toContain('wait "$pid"');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('npx vitest run');
    expect(workflow).toContain('npm run build && npm run build:server');
    expect(workflow).toContain('npm run --silent netcheck');
    expect(read('.github/workflows/deploy.yml')).toContain('needs: test');
  });
});
