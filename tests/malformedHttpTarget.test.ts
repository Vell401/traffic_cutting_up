/// <reference types="node" />
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseRequestTarget } from '../server/requestTarget';
import { Admin } from '../server/admin';
import { Store } from '../server/store';
import { GameServer } from '../src/online/gameServer';

function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('HTTP response timed out')));
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(response));
  });
}

async function startServer(admin: boolean) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const dir = mkdtempSync(join(resolve(process.cwd(), '..'), 'traffic-http-target-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), MAP_ID: admin ? 'miami' : 'highway',
      DB_PATH: join(dir, 'traffic.db'), RADIO_DIR: join(dir, 'radio'), JOURNAL_DIR: '',
      ADMIN_PASSWORD: admin ? 'test-http-target-password' : '', ORIGINS: '', LOG_EVERY: '3600', SEED: '7',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15_000);
      const ready = (chunk: Buffer) => {
        if (!chunk.toString().includes('listening on')) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stdout.on('data', ready);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Server exited: ${output}`)); });
    });
    return { port, child, output: () => output, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

describe('malformed HTTP request targets', () => {
  it('only catches invalid URL errors and preserves ordinary prefixed paths and queries', () => {
    expect(parseRequestTarget('http://[')).toBeNull();
    const url = parseRequestTarget('/miami/api/admin/state?next=http://[')!;
    expect(url.pathname).toBe('/miami/api/admin/state');
    expect(url.searchParams.get('next')).toBe('http://[');
    const failure = new Error('unexpected parser failure');
    vi.stubGlobal('URL', class { constructor() { throw failure; } });
    try { expect(() => parseRequestTarget('/health')).toThrow(failure); }
    finally { vi.unstubAllGlobals(); }
  });

  it.each([false, true])('standalone admin handler also rejects malformed targets (admin=%s)', async enabled => {
    const store = new Store(':memory:');
    const diag = vi.fn();
    const admin = new Admin({ password: enabled ? 'test-password' : '', origins: [], game: new GameServer({ seed: 7 }), store, health: () => ({}), diag });
    const server = createHttpServer((req, res) => { if (!admin.handle(req, res)) res.writeHead(404).end(); });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      expect(await rawRequest(port, 'http://[')).toMatch(/^HTTP\/1\.1 400 /);
      expect(await rawRequest(port, '/api/admin/state')).toMatch(enabled ? /^HTTP\/1\.1 401 / : /^HTTP\/1\.1 404 /);
      expect(diag).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });

  it.each([false, true])('actual server returns bounded 400s and stays healthy (admin=%s)', async admin => {
    const server = await startServer(admin);
    try {
      for (const target of ['http://[', 'http://[::1', 'http://example.test:bad/api/admin/state', 'http://private-user:private-password@[', '//[']) {
        const response = await rawRequest(server.port, target);
        expect(response).toMatch(/^HTTP\/1\.1 400 /);
        expect(response.length).toBeLessThan(1024);
        expect(response).toContain('Invalid request target');
        expect(response).not.toContain('private-password');
        expect(response).not.toContain(target);
        // These are the upstream paths after Caddy strips /miami on that instance.
        const health = await fetch(`http://127.0.0.1:${server.port}/health?probe=http://[`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ ok: true, map: admin ? 'miami' : 'highway' });
      }
      const state = await fetch(`http://127.0.0.1:${server.port}/api/admin/state`);
      expect(state.status).toBe(admin ? 401 : 404);
      const identity = await fetch(`http://127.0.0.1:${server.port}/api/map`);
      expect(identity.status).toBe(200);
      expect(await identity.json()).toMatchObject({ map: admin ? 'miami' : 'highway' });
      // Beyond the old uncaught-exception exit timer; health must still work.
      await new Promise(resolve => setTimeout(resolve, 150));
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
      expect(server.child.exitCode).toBeNull();
      expect(server.output()).not.toMatch(/uncaught|unhandled rejection|private-user|private-password/);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
