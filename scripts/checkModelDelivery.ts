/** Native Caddy HTTP smoke, isolated loopback listener: node --import tsx scripts/checkModelDelivery.ts [caddy-executable] */
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.argv[2] ?? 'caddy';
const native = JSON.parse(execFileSync(executable, ['adapt', '--adapter', 'caddyfile', '--config', 'deploy/docker/Caddyfile'], {
  encoding: 'utf8', env: { ...process.env, SITE_ADDRESS: '127.0.0.1' },
}));
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
// Test the adapted production routes; only certificate provisioning/listener/root differ locally.
delete native.apps.tls;
const server = native.apps.http.servers.srv0;
delete server.tls_connection_policies;
server.listen = [`127.0.0.1:${port}`]; server.automatic_https = { disable: true };
function root(object: any): void {
  if (!object || typeof object !== 'object') return;
  if (object.handler === 'vars' && object.root) object.root = resolve('dist');
  for (const value of Object.values(object)) root(value);
}
root(native);
const temporary = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
const directory = await mkdtemp(join(temporary, 'caddy-delivery-')), config = join(directory, 'caddy.json');
await writeFile(config, JSON.stringify(native));
const processCaddy = spawn(executable, ['run', '--config', config], { stdio: ['ignore', 'ignore', 'pipe'] });
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Caddy startup timeout')), 10000);
    processCaddy.once('error', error => { clearTimeout(timeout); reject(error); });
    processCaddy.stderr.on('data', data => {
      if (String(data).includes('server running')) { clearTimeout(timeout); resolve(); }
    });
    processCaddy.once('exit', code => { clearTimeout(timeout); reject(new Error(`Caddy exited: ${code}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const file = 'mercedes-a45s.glb', path = `${url}/models/${file}`;
  const original = await readFile(`dist/models/${file}`);
  const identity = await fetch(path, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(identity.status, 200); assert.equal(identity.headers.get('Content-Length'), String(original.length));
  assert.equal(identity.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  const compressed = await fetch(path, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.status, 200); assert.equal(compressed.headers.get('Content-Encoding'), 'gzip');
  assert.match(compressed.headers.get('Vary') ?? '', /Accept-Encoding/i);
  const contentLength = Number(compressed.headers.get('Content-Length'));
  assert.ok(contentLength > 0 && contentLength < original.length);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  // fetch transparently decompresses the response; verify its complete original model bytes.
  assert.equal(hash(new Uint8Array(await compressed.arrayBuffer())), hash(original));
  const conditional = await fetch(path, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': compressed.headers.get('ETag')! } });
  assert.equal(conditional.status, 304);
  const page = await fetch(`${url}/`, { method: 'HEAD' }); assert.equal(page.headers.get('Cache-Control'), 'no-cache');
  const asset = (await readdir('dist/assets')).find(file => file.endsWith('.js'))!;
  const hashed = await fetch(`${url}/assets/${asset}`, { method: 'HEAD' });
  assert.equal(hashed.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  console.log(JSON.stringify({ model: file, originalBytes: original.length, gzipBytes: contentLength, conditionalStatus: conditional.status, lossless: true }));
} finally {
  if (processCaddy.pid && processCaddy.exitCode === null && processCaddy.signalCode === null) {
    const exited = once(processCaddy, 'exit'); processCaddy.kill(); await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
