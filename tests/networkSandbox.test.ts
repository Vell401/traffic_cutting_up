import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createNetworkSandboxServer } from '../server/networkSandbox';
import { NetworkSession, FIXED_STEP, type NetworkSnapshot } from '../src/network/session';
import { createBayNetwork } from '../src/network/layout';

type Message = { type: 'welcome'; id: string; layout: 'bay' | 'prototype' }
  | { type: 'snapshot'; snapshot: NetworkSnapshot };
type Sandbox = Awaited<ReturnType<typeof createNetworkSandboxServer>>;
const servers: Sandbox[] = [];
const clients: WebSocket[] = [];

async function start(options: Parameters<typeof createNetworkSandboxServer>[0] = {}) {
  const server = await createNetworkSandboxServer({ host: '127.0.0.1', port: 0, trafficCount: 0, ...options });
  servers.push(server);
  return server;
}

function connect(server: Sandbox, query = '', autoPong = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address()!.port}/${query}`, { autoPong });
  clients.push(socket);
  const messages: Message[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString()) as Message));
  // Some tests deliberately reject the HTTP upgrade or terminate the transport.
  socket.on('error', () => undefined);
  async function wait<T>(read: () => T | undefined, label: string): Promise<T> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  return {
    socket, messages,
    welcome: () => wait(() => messages.find(m => m.type === 'welcome'), 'welcome'),
    snapshot: (predicate: (snapshot: NetworkSnapshot) => boolean = () => true) => wait(() => {
      const message = messages.find(m => m.type === 'snapshot' && predicate(m.snapshot));
      return message?.type === 'snapshot' ? message.snapshot : undefined;
    }, 'snapshot'),
    closed: () => wait(() => socket.readyState === WebSocket.CLOSED ? true : undefined, 'close'),
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('isolated authoritative network sandbox', () => {
  it('welcomes unique drivers, broadcasts identical full state, and matches deterministic NetworkSession replay', async () => {
    const server = await start({ trafficCount: 4 });
    const a = connect(server, '?parking=P1&physics=3');
    const aw = await a.welcome();
    await a.snapshot();
    expect(a.messages[0]).toEqual(aw);
    expect(a.messages[1]?.type).toBe('snapshot');
    const b = connect(server, '?layout=bay&parking=P2&physics=5');
    const bw = await b.welcome();
    expect(aw.layout).toBe('bay');
    expect(bw.id).not.toBe(aw.id);
    const first = await a.snapshot(s => s.drivers.length === 2);
    expect(first.drivers.find(d => d.id === aw.id)).toMatchObject({ parkingId: 'P1', physicsId: 3 });
    expect(first.drivers.find(d => d.id === bw.id)).toMatchObject({ parkingId: 'P2', physicsId: 5 });
    expect(await b.snapshot(s => s.tick === first.tick)).toEqual(first);
    const later = await a.snapshot(s => s.tick >= first.tick + 24);
    expect(await b.snapshot(s => s.tick === later.tick)).toEqual(later);
    const replay = new NetworkSession(createBayNetwork(), { trafficCount: 0 });
    replay.restore(first);
    replay.step((later.tick - first.tick) * FIXED_STEP, {});
    const expected = replay.snapshot();
    // Wall-clock residue is transport timing, not fixed-step simulation state.
    expect({ ...later, accumulator: 0 }).toEqual({ ...expected, accumulator: 0 });
    expect(later.traffic).toHaveLength(4);
  });

  it('isolates bay and prototype worlds and applies real held input movement', async () => {
    const server = await start();
    const bay = connect(server, '?parking=P2');
    const prototype = connect(server, '?layout=prototype&parking=P1&physics=1');
    const bw = await bay.welcome(), pw = await prototype.welcome();
    const before = await prototype.snapshot();
    prototype.socket.send(JSON.stringify({ type: 'input', input: { steer: 0, throttle: 1, brake: 0, branch: 0 } }));
    const moving = await prototype.snapshot(s => s.drivers.some(d => d.id === pw.id && d.speed > 1));
    expect(moving.networkId).toBe('prototype');
    expect(moving.drivers.map(d => d.id)).toEqual([pw.id]);
    expect(moving.drivers[0].s).toBeGreaterThan(before.drivers[0].s);
    const bayState = await bay.snapshot(s => s.tick >= moving.tick);
    expect(bayState.networkId).toBe('bay');
    expect(bayState.drivers.map(d => d.id)).toEqual([bw.id]);
    expect(bayState.drivers[0].speed).toBe(0);
  });

  it('removes disconnected and malformed-input drivers without damaging other clients', async () => {
    const server = await start();
    const observer = connect(server);
    const observerId = (await observer.welcome()).id;
    const departing = connect(server, '?parking=P2');
    const departingId = (await departing.welcome()).id;
    await observer.snapshot(s => s.drivers.some(d => d.id === departingId));
    departing.socket.close();
    await departing.closed();
    await observer.snapshot(s => s.drivers.length === 1 && s.tick > 12);
    const invalid = [
      '{', 'null', JSON.stringify({ type: 'snapshot', snapshot: {} }),
      ...[
        { steer: 2, throttle: 0, brake: 0 }, { steer: 0, throttle: -1, brake: 0 },
        { steer: 0, throttle: 0, brake: 2 }, { steer: '0', throttle: 0, brake: 0 },
        { steer: 0, throttle: 0, brake: 0, branch: 1.5 },
        { steer: 0, throttle: 0, brake: 0, branch: -1 },
        { steer: 0, throttle: 0, brake: 0, reset: 'yes' },
      ].map(input => JSON.stringify({ type: 'input', input })),
    ];
    for (const payload of invalid) {
      const bad = connect(server, '?parking=P2');
      const id = (await bad.welcome()).id;
      const joined = await observer.snapshot(s => s.drivers.some(d => d.id === id));
      bad.socket.send(payload);
      await bad.closed();
      const cleaned = await observer.snapshot(s => s.tick > joined.tick && s.drivers.length === 1);
      expect(cleaned.drivers[0].id).toBe(observerId);
      expect(cleaned.drivers[0].state.every(Number.isFinite)).toBe(true);
    }
  }, 10000);

  it('bounds payloads, binary input, message rate, query selection and total clients', async () => {
    const server = await start({ maxClients: 1 });
    for (const query of ['?layout=other', '?parking=missing', '?physics=0', '?physics=1.5']) {
      const bad = connect(server, query);
      await bad.closed();
      expect(bad.messages).toEqual([]);
    }
    const first = connect(server);
    await first.welcome();
    const excess = connect(server);
    await excess.closed();
    expect(excess.messages).toEqual([]);
    first.socket.send('x'.repeat(1025));
    await first.closed();
    const binary = connect(server);
    await binary.welcome();
    binary.socket.send(Buffer.from('{}'));
    await binary.closed();
    const flood = connect(server);
    await flood.welcome();
    const input = JSON.stringify({ type: 'input', input: { steer: 0, throttle: 0, brake: 0 } });
    for (let i = 0; i < 241; i++) flood.socket.send(input);
    await flood.closed();
    const replacement = connect(server);
    await replacement.welcome();
  });

  it('evicts a peer that stops answering heartbeats and allows replacement', async () => {
    const server = await start({ maxClients: 1, heartbeatMs: 30 });
    const dead = connect(server, '', false);
    await dead.welcome();
    await dead.closed();
    const replacement = connect(server);
    const welcome = await replacement.welcome();
    const snapshot = await replacement.snapshot();
    expect(snapshot.drivers.map(d => d.id)).toEqual([welcome.id]);
  });

  it('closes idempotently with live clients and releases its port', async () => {
    const server = await start();
    const client = connect(server);
    await client.welcome();
    const port = server.address()!.port;
    const first = server.close();
    expect(server.close()).toBe(first);
    await first;
    await client.closed();
    expect(server.address()).toBeNull();
    const replacement = await start({ port });
    await connect(replacement).welcome();
  });
});
