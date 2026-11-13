import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createBayNetwork, createPrototypeNetwork } from '../src/network/layout';
import { NetworkSession, type NetworkInput } from '../src/network/session';
import type { PhysicsId } from '../src/sim/physics';

type Layout = 'bay' | 'prototype';
export interface NetworkSandboxOptions {
  host?: string;
  port?: number;
  maxClients?: number;
  trafficCount?: number;
  heartbeatMs?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const inRange = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

function parseInput(value: unknown): NetworkInput | undefined {
  if (!record(value) || value.type !== 'input' || !record(value.input)) return;
  const { steer, throttle, brake, branch, reset } = value.input;
  if (!inRange(steer, -1, 1) || !inRange(throttle, 0, 1) || !inRange(brake, 0, 1)) return;
  if (branch !== undefined && (!inRange(branch, 0, 255) || !Number.isInteger(branch))) return;
  if (reset !== undefined && typeof reset !== 'boolean') return;
  return { steer, throttle, brake, ...(branch === undefined ? {} : { branch }), ...(reset === undefined ? {} : { reset }) };
}

/**
 * Async, already-listening factory. Defaults: 127.0.0.1:3011 (NETWORK_PORT overrides
 * the default); port: 0 requests an ephemeral port. address() returns AddressInfo.
 * Await close() to stop timers, terminate even unresponsive sockets and release the
 * listener. Repeated/concurrent close calls share one promise. No app-server hooks.
 * Query: layout=bay|prototype (default bay), parking=<layout parking ID>, physics=1..5.
 * Invalid queries are rejected before upgrade; malformed inputs disconnect the peer.
 */
export async function createNetworkSandboxServer(options: NetworkSandboxOptions = {}) {
  const port = options.port ?? Number(process.env.NETWORK_PORT ?? 3011);
  const maxClients = options.maxClients ?? 32;
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const trafficCount = options.trafficCount ?? 24;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid network port');
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 128) throw new Error('Invalid client cap');
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60000) throw new Error('Invalid heartbeat interval');
  if (!Number.isInteger(trafficCount) || trafficCount < 0 || trafficCount > 128) throw new Error('Invalid traffic count');
  const worlds = {
    bay: new NetworkSession(createBayNetwork(), { trafficCount }),
    prototype: new NetworkSession(createPrototypeNetwork(), { trafficCount }),
  };
  const inputs: Record<Layout, Record<string, NetworkInput>> = { bay: {}, prototype: {} };
  const peers = new Map<WebSocket, { id: string; layout: Layout; alive: boolean; messages: number }>();
  const http = createServer((_req, res) => { res.writeHead(426); res.end('WebSocket required'); });
  http.headersTimeout = 5000;
  http.requestTimeout = 5000;
  const sockets = new Set<import('node:net').Socket>();
  let closing = false;
  http.on('connection', socket => {
    if (closing || sockets.size >= maxClients + 8) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  let nextId = 0;
  function remove(socket: WebSocket) {
    const peer = peers.get(socket);
    if (!peer) return;
    worlds[peer.layout].removeDriver(peer.id);
    delete inputs[peer.layout][peer.id];
    peers.delete(socket);
  }
  function drop(socket: WebSocket) { remove(socket); socket.terminate(); }
  function send(socket: WebSocket, text: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) { drop(socket); return; }
    socket.send(text, error => { if (error) drop(socket); });
  }
  http.on('upgrade', (request, socket, head) => {
    if (closing || peers.size >= maxClients || (request.url?.length ?? 0) > 1024) { socket.destroy(); return; }
    let query: URLSearchParams;
    try { query = new URL(request.url ?? '/', 'http://sandbox').searchParams; }
    catch { socket.destroy(); return; }
    const layout = query.get('layout') ?? 'bay';
    if (layout !== 'bay' && layout !== 'prototype') { socket.destroy(); return; }
    const world = worlds[layout];
    const parking = query.get('parking') ?? undefined;
    const physics = query.get('physics') ?? '1';
    if ((parking !== undefined && !world.network.parkings.some(p => p.id === parking)) || !/^[1-5]$/.test(physics)) {
      socket.destroy(); return;
    }
    request.socket.setTimeout(0);
    ws.handleUpgrade(request, socket, head, client => {
      const id = `driver:${++nextId}`;
      world.addDriver(id, parking, Number(physics) as PhysicsId);
      const peer: { id: string; layout: Layout; alive: boolean; messages: number } = { id, layout, alive: true, messages: 0 };
      peers.set(client, peer);
      client.on('error', () => drop(client));
      client.on('close', () => remove(client));
      client.on('pong', () => { peer.alive = true; });
      client.on('message', (data, binary) => {
        if (!peers.has(client)) return;
        if (binary || ++peer.messages > 240) { drop(client); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString()); }
        catch { drop(client); return; }
        const input = parseInput(parsed);
        if (!input) { drop(client); return; }
        inputs[layout][id] = input;
      });
      send(client, JSON.stringify({ type: 'welcome', id, layout }));
      send(client, JSON.stringify({ type: 'snapshot', snapshot: world.snapshot() }));
    });
  });
  // Permanent error listener prevents late transport errors becoming uncaught events.
  ws.on('error', () => { for (const client of peers.keys()) drop(client); });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { http.off('listening', ready); ws.close(); reject(error); };
    const ready = () => { http.off('error', failed); resolve(); };
    http.once('error', failed);
    http.once('listening', ready);
    http.listen(port, options.host ?? '127.0.0.1');
  });
  let last = performance.now();
  const simulation = setInterval(() => {
    const now = performance.now();
    // Bound catch-up after suspension; NetworkSession owns the 120 Hz fixed step.
    const elapsed = Math.min((now - last) / 1000, .1);
    last = now;
    for (const layout of ['bay', 'prototype'] as const) {
      const previousTime = worlds[layout].time;
      worlds[layout].step(elapsed, inputs[layout]);
      // Keep reset pending if this callback did not consume a fixed tick.
      if (worlds[layout].time !== previousTime) {
        for (const input of Object.values(inputs[layout])) input.reset = false;
      }
    }
  }, 1000 / 120);
  const snapshots = setInterval(() => {
    for (const layout of ['bay', 'prototype'] as const) {
      const text = JSON.stringify({ type: 'snapshot', snapshot: worlds[layout].snapshot() });
      for (const [client, peer] of peers) if (peer.layout === layout) send(client, text);
    }
  }, 100);
  const rate = setInterval(() => { for (const peer of peers.values()) peer.messages = 0; }, 1000);
  const heartbeat = setInterval(() => {
    for (const [client, peer] of peers) {
      if (!peer.alive) { drop(client); continue; }
      peer.alive = false;
      if (client.readyState === WebSocket.OPEN) client.ping(undefined, undefined, error => { if (error) drop(client); });
    }
  }, heartbeatMs);
  let closePromise: Promise<void> | undefined;
  return {
    address: () => http.address() as AddressInfo | null,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      for (const timer of [simulation, snapshots, rate, heartbeat]) clearInterval(timer);
      for (const client of peers.keys()) drop(client);
      for (const socket of sockets) socket.destroy();
      closePromise = Promise.all([
        new Promise<void>(resolve => ws.close(() => resolve())),
        new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())),
      ]).then(() => undefined);
      return closePromise;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createNetworkSandboxServer().then(server => {
    process.stdout.write(`Network sandbox listening on ${JSON.stringify(server.address())}\n`);
    const stop = () => { void server.close().catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
}
