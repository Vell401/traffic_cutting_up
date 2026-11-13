import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { peerWelcome } from './helpers/peerWelcome';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const stop of cleanup.splice(0).reverse()) await stop(); });

it.each(['welcome', 'reject', 'close', 'silent'] as const)('settles and cleans up a real peer: %s', async kind => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => new Promise<void>(done => { for (const peer of server.clients) peer.terminate(); server.close(() => done()); }));
  await new Promise<void>(done => server.once('listening', done));
  let hello: unknown;
  server.on('connection', peer => peer.once('message', data => {
    hello = JSON.parse(String(data));
    if (kind === 'welcome') peer.send(JSON.stringify({ t: 'welcome', id: 7, players: [{}, {}] }));
    if (kind === 'reject') peer.send(JSON.stringify({ t: 'reject', reason: 'fixture rejected' }));
    if (kind === 'close') peer.close();
  }));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  cleanup.push(() => ws.close());
  const waiting = peerWelcome(ws, { t: 'hello' }, 80);
  if (kind === 'welcome') await expect(waiting).resolves.toEqual({ id: 7, players: 2 });
  else await expect(Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(Error('test watchdog')), 500))])).rejects.toThrow(kind === 'reject' ? 'fixture rejected' : kind === 'close' ? 'closed before welcome' : 'welcome timeout');
  expect(hello).toEqual({ t: 'hello' });
  for (const handler of [ws.onopen, ws.onmessage, ws.onerror, ws.onclose]) expect(handler).toBeNull();
  if (kind === 'silent') expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws.readyState);
});

it('rejects a connection error and removes every handler', async () => {
  const ws = new WebSocket('ws://127.0.0.1:0');
  await expect(peerWelcome(ws, {}, 80)).rejects.toThrow('peer connection');
  for (const handler of [ws.onopen, ws.onmessage, ws.onerror, ws.onclose]) expect(handler).toBeNull();
});

it.each([false, true])('clears its timer and ignores late events after one settlement (missing global CloseEvent=%s)', async missingCloseEvent => {
  if (missingCloseEvent) vi.stubGlobal('CloseEvent', undefined);
  try {
    if (missingCloseEvent) expect(globalThis.CloseEvent).toBeUndefined();
    vi.useFakeTimers();
    const ws = { onopen: null, onmessage: null, onerror: null, onclose: null, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
    const waiting = peerWelcome(ws, {}, 80);
    const lateClose = ws.onclose;
    ws.onmessage!(new MessageEvent('message', { data: JSON.stringify({ t: 'welcome', id: 3, players: [] }) }));
    await expect(waiting).resolves.toEqual({ id: 3, players: 0 });
    expect(lateClose).toBeTypeOf('function');
    // The handler ignores close-specific fields; no runtime CloseEvent constructor is needed.
    lateClose!.call(ws, new Event('close') as CloseEvent);
    for (const handler of [ws.onopen, ws.onmessage, ws.onerror, ws.onclose]) expect(handler).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.close).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
