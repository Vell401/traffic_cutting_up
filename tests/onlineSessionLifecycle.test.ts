import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import type { Conn, GameServer } from '../src/online/gameServer';
import { Writer } from '../src/online/protocol';
import { OnlineSession, type SessionHooks } from '../src/online/session';
import { onlineTokenKey } from '../src/online/link';
import { Sim } from '../src/sim/world';
import { attach, emptyServer } from './chatGarageHelpers';

let server: GameServer;
const sockets: MockSocket[] = [];
const storage = new Map<string, string>();
const tokenKey = onlineTokenKey('ws://test/ws', 'highway');

/** A real GameServer behind the browser WebSocket surface; timers are virtual, no real network. */
class MockSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | Uint8Array }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  readonly conn: Conn;

  constructor(readonly url: string) {
    sockets.push(this);
    this.conn = server.connect({
      send: (data) => this.onmessage?.({ data }),
      close: (code, reason) => this.drop(code, reason),
      buffered: 0,
    });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.conn.receive(data);
  }

  close(code = 1000, reason = 'bye'): void {
    this.drop(code, reason);
  }

  drop(code = 1006, reason = 'lost'): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.conn.close();
    this.onclose?.({ code, reason });
  }
}

function makeSession(sim = new Sim(mulberry32(11), { online: true, physics: 4 }), lag = 0) {
  const hooks: SessionHooks = {
    onState: vi.fn(), onPlayers: vi.fn(), onFeed: vi.fn(), onChat: vi.fn(),
    onAnnounce: vi.fn(), onTeleport: vi.fn(),
  };
  const session = new OnlineSession(sim, 'ws://test/ws', { lag, jitter: 0, stall: 0 }, hooks);
  return { sim, hooks, session };
}

function snapshot(session: OnlineSession): void {
  const dr = server.world.byId(session.core.id)!;
  const writer = new Writer();
  server.world.writeSnapshot(dr, writer);
  sockets.at(-1)!.onmessage?.({ data: writer.bytes() });
}

beforeEach(() => {
  vi.useFakeTimers();
  server = emptyServer();
  sockets.length = 0;
  storage.clear();
  vi.stubGlobal('WebSocket', MockSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('online session lifecycle without a page reload', () => {
  it('exposes onChat/sendChat and refuses disconnected session operations', async () => {
    const h = makeSession();
    expect(h.session.sendChat('offline')).toBe(false);
    await expect(h.session.changeCar(2, 1)).rejects.toThrow('подключения');
    h.session.start('Alice', 4, 1, 0x123456);
    sockets[0].open();
    expect(h.session.sendChat('hello')).toBe(true);
    expect(h.hooks.onChat).toHaveBeenCalledWith({ id: h.session.core.id, name: 'Alice', text: 'hello' });
    h.session.leave();
  });

  it('intentional leave releases the server slot, forgets token and owned views, and permits a fresh session on the same Sim', () => {
    server.world.traffic.enabled = true;
    attach(server, 'Observer');
    const h = makeSession();
    h.session.start('Alice', 4, 1, 0x123456);
    sockets[0].open();
    snapshot(h.session);
    const oldId = h.session.core.id;
    expect(h.sim.remotes).toHaveLength(1);
    expect(h.sim.traffic.activeCount).toBeGreaterThan(0);
    expect(storage.has(tokenKey)).toBe(true);
    const otherMapKey = onlineTokenKey('ws://test/miami/ws', 'miami');
    const otherServerKey = onlineTokenKey('ws://other/ws', 'highway');
    storage.set(otherMapKey, 'miami-session');
    storage.set(otherServerKey, 'other-server-session');
    h.sim.visual.ds = 2;
    h.session.leave();
    expect(h.session.state).toBe('idle');
    expect(h.session.core.ready).toBe(false);
    expect(h.session.core.token).toBe('');
    expect(storage.has(tokenKey)).toBe(false);
    expect(storage.get(otherMapKey)).toBe('miami-session');
    expect(storage.get(otherServerKey)).toBe('other-server-session');
    expect(server.world.byId(oldId)).toBeUndefined();
    expect(h.sim.remotes).toHaveLength(0);
    expect(h.sim.traffic.activeCount).toBe(0);
    expect(h.sim.visual.ds).toBe(0);
    const next = makeSession(h.sim);
    next.session.start('New Name', 5, 4, 0xabcdef);
    sockets[1].open();
    snapshot(next.session);
    expect(next.session.state).toBe('joined');
    expect(server.playerCount).toBe(2);
    expect(next.session.core.id).not.toBe(oldId);
    expect(next.sim.player.physicsId).toBe(5);
    expect(next.sim.remotes).toHaveLength(1);
    const newToken = storage.get(tokenKey);
    h.session.leave(); // a stale owner's second cleanup must not erase the new session's token/views
    expect(storage.get(tokenKey)).toBe(newToken);
    expect(next.sim.remotes).toHaveLength(1);
    next.session.leave();
  });

  it('cancels delayed input/chat/receive callbacks but sends leave immediately through artificial lag', () => {
    const h = makeSession(undefined, 100);
    h.session.start('Alice', 4, 1);
    sockets[0].open();
    vi.advanceTimersByTime(100);
    snapshot(h.session);
    vi.advanceTimersByTime(50);
    expect(h.session.state).toBe('joined');
    h.session.sendChat('delayed outbound');
    sockets[0].onmessage?.({ data: JSON.stringify({ t: 'chat', id: 4, name: 'Other', text: 'delayed inbound' }) });
    const callbacks = vi.mocked(h.hooks.onState).mock.calls.length;
    h.session.leave();
    expect(server.playerCount).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(h.hooks.onChat).not.toHaveBeenCalled();
    expect(vi.mocked(h.hooks.onState).mock.calls).toHaveLength(callbacks);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d as string).t)).toEqual(['hello', 'leave']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels auto reconnect after a drop followed by leave and ignores a late open', () => {
    const h = makeSession();
    h.session.start('Alice', 4, 1);
    sockets[0].open();
    sockets[0].drop();
    expect(h.session.state).toBe('reconnecting');
    h.session.leave();
    sockets[0].open();
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
    expect(h.session.state).toBe('idle');
    expect(h.session.core.id).toBe(0);
    expect(storage.has(tokenKey)).toBe(false);
  });

  it('resumes the authoritative new car even when garage ACK was lost before reconnect', async () => {
    const h = makeSession(undefined, 100);
    h.session.start('Alice', 4, 1, 0x123456);
    sockets[0].open();
    vi.advanceTimersByTime(100);
    snapshot(h.session);
    vi.advanceTimersByTime(50);
    const id = h.session.core.id;
    const promise = h.session.changeCar(4, 0xabcdef);
    vi.advanceTimersByTime(50); // garage reaches server, but its ACK/player list is still in flight
    expect(server.world.byId(id)!.physics).toBe(5);
    sockets[0].drop();
    await expect(promise).rejects.toThrow('потеряна');
    vi.advanceTimersByTime(500);
    sockets[1].open();
    vi.advanceTimersByTime(100);
    expect(h.session.core.id).toBe(id);
    expect(server.playerCount).toBe(1);
    const hello = JSON.parse(sockets[1].sent[0] as string);
    expect(hello).toMatchObject({ t: 'hello', physics: 4, car: 1, resume: true });
    expect(server.world.byId(id)!.physics).toBe(5);
    snapshot(h.session);
    vi.advanceTimersByTime(50);
    expect(h.sim.player.physicsId).toBe(5);
    h.session.leave();
  });

  it('keeps the hello sequence baseline if reconnect must allocate a new player identity', () => {
    const h = makeSession();
    h.session.start('Alice', 4, 1);
    sockets[0].open();
    snapshot(h.session);
    for (let i = 0; i < 12; i++) h.session.step({ steer: 0, throttle: 1, brake: 0 });
    const oldId = h.session.core.id;
    sockets[0].drop();
    server.world.leave(oldId);
    // Expire the old reconnect slot through normal housekeeping.
    server.world.tick = server.world.rules.tickHz * server.world.rules.reconnectSeconds;
    for (let i = 0; i < server.world.rules.tickHz; i++) server.tick();
    vi.advanceTimersByTime(500);
    sockets[1].open();
    expect(h.session.core.id).not.toBe(oldId);
    snapshot(h.session);
    expect(h.session.core.ready).toBe(true);
    expect(h.session.core.ack).toBe(12);
    h.session.leave();
  });
});
