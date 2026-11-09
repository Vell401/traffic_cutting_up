import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { Api } from '../server/api';
import type { Store } from '../server/store';
import { clientIp, createClientAddressResolver } from '../server/clientAddress';

function request(peer: string, xff?: string | string[]): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff } } as unknown as IncomingMessage;
}

describe('verified client address', () => {
  it('ignores every forwarded identity on untrusted socket peers by default', () => {
    for (const xff of ['198.51.100.7', '1.2.3.4, 5.6.7.8', ['1.2.3.4', '5.6.7.8'], 'garbage']) {
      expect(clientIp(request('::ffff:203.0.113.9', xff))).toBe('203.0.113.9');
    }
    expect(createClientAddressResolver('10.0.0.2')(request('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
    expect(clientIp(request('', '1.2.3.4'))).toBe('?');
  });

  it('trusts only Caddy and stops at the rightmost untrusted hop, not spoofed prepends', () => {
    const resolve = createClientAddressResolver('172.30.114.2');
    expect(resolve(request('::ffff:172.30.114.2', '198.51.100.1'))).toBe('198.51.100.1');
    expect(resolve(request('172.30.114.2', '1.2.3.4, 198.51.100.1'))).toBe('198.51.100.1');
    expect(resolve(request('172.30.114.2', ['1.2.3.4', '198.51.100.2']))).toBe('198.51.100.2');
    expect(resolve(request('172.30.114.3', '1.2.3.4'))).toBe('172.30.114.3');
  });

  it('supports IPv4/IPv6 CIDRs, multiple trusted hops and canonical mapped identities', () => {
    const resolve = createClientAddressResolver('10.0.0.0/24, 2001:db8:abcd::/48');
    expect(resolve(request('10.0.0.2', '1.2.3.4, 198.51.100.8, 2001:db8:abcd::9'))).toBe('198.51.100.8');
    expect(resolve(request('10.0.1.2', '1.2.3.4'))).toBe('10.0.1.2');
    expect(resolve(request('2001:db8:abce::1', '1.2.3.4'))).toBe('2001:db8:abce:0:0:0:0:1');
    expect(resolve(request('10.0.0.2', '2001:0DB8::7'))).toBe(clientIp(request('2001:db8:0:0:0:0:0:7')));
    expect(resolve(request('10.0.0.2', '::ffff:c000:201'))).toBe('192.0.2.1');
    expect(resolve(request('10.0.0.2', '::ffff:192.0.2.1'))).toBe('192.0.2.1');
    expect(createClientAddressResolver('::ffff:10.0.0.0/120')(request('10.0.0.2', '192.0.2.1'))).toBe('192.0.2.1');
  });

  it('falls back to the peer for malformed, empty or excessive chains', () => {
    const resolve = createClientAddressResolver('10.0.0.2');
    for (const xff of [undefined, '', 'unknown', '192.0.2.1:80', '[2001:db8::1]', 'fe80::1%eth0', '192.0.2.1,', ',192.0.2.1', 'bad, 192.0.2.1', '01.2.3.4', Array(33).fill('192.0.2.1').join(','), ' '.repeat(4096) + '192.0.2.1']) {
      expect(resolve(request('10.0.0.2', xff)), String(xff)).toBe('10.0.0.2');
    }
  });

  it('rejects invalid trust configuration rather than silently broadening it', () => {
    for (const value of ['*', 'private', 'caddy', '10.0.0.2:80', '10.0.0.1/33', '::1/129', '10.0.0.1/-1', '10.0.0.1/', '10.0.0.1,', '::ffff:10.0.0.1/80', '10.0.0.1/24/1']) {
      expect(() => createClientAddressResolver(value), value).toThrow(/TRUSTED_PROXIES/);
    }
  });
});

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of close.splice(0)) await stop(); });

async function fixture(proxies?: string) {
  const resolve = createClientAddressResolver(proxies);
  const store = { addRun: () => true, leaderboard: () => [], log() {} } as unknown as Store;
  const api = new Api(store, { origins: [], log() {}, clientAddress: proxies === undefined ? undefined : resolve });
  const server = createServer((req, res) => {
    if (req.url === '/identity') { res.end(resolve(req)); return; }
    api.handle(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => ws.send(resolve(req)));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  close.push(async () => {
    api.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function run(base: string, xff: string) {
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ name: 'Address test', score: 1, car: 1, physics: 1, near: 0, topKmh: 10, seconds: 1 }),
  });
  await response.text();
  return response.status;
}

describe('HTTP and WebSocket identity contract', () => {
  it('accepts only 20 of 45 solo runs with distinct forged XFF on a direct socket', async () => {
    const base = await fixture();
    const statuses = [];
    for (let i = 1; i <= 45; i++) statuses.push(await run(base, `198.51.100.${i}`));
    expect(statuses.filter(status => status === 200)).toHaveLength(20);
    expect(statuses.filter(status => status === 429)).toHaveLength(25);
  });

  it('keeps trusted-proxy real clients distinct while spoofed prepends cannot reset limits', async () => {
    const base = await fixture('127.0.0.1');
    for (let i = 1; i <= 20; i++) expect(await run(base, `203.0.113.${i}, 198.51.100.1`)).toBe(200);
    expect(await run(base, '203.0.113.99, 198.51.100.1')).toBe(429);
    expect(await run(base, '203.0.113.99, 198.51.100.2')).toBe(200);
  });

  it.each(['', '127.0.0.1'])('uses identical HTTP and upgrade identities with trust=%s', async proxies => {
    const base = await fixture(proxies);
    const xff = '1.2.3.4, 2001:db8::9';
    const httpIdentity = await (await fetch(`${base}/identity`, { headers: { 'x-forwarded-for': xff } })).text();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { 'x-forwarded-for': xff } });
    try {
      const wsIdentity = await new Promise<string>((done, reject) => {
        ws.once('message', data => done(data.toString()));
        ws.once('error', reject);
      });
      expect(wsIdentity).toBe(httpIdentity);
      expect(wsIdentity).toBe(proxies ? '2001:db8:0:0:0:0:0:9' : '127.0.0.1');
    } finally { ws.terminate(); }
  });

  it('wires one configured resolver into production API/WS and pins Compose trust to Caddy', () => {
    const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("createClientAddressResolver(env.TRUSTED_PROXIES ?? '')");
    expect(main).toContain('clientAddress: clientIp');
    expect(main).toContain('const addr = clientIp(req)');
    const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
    expect(compose).toContain('TRUSTED_PROXIES: ${PROXY_IP:-172.30.114.2}');
    expect(compose).toContain('ipv4_address: ${PROXY_IP:-172.30.114.2}');
    expect(compose).toContain('subnet: ${PROXY_NETWORK_SUBNET:-172.30.114.0/24}');
    expect(compose).toContain('ip_range: ${PROXY_NETWORK_IP_RANGE:-172.30.114.128/25}');
  });
});
