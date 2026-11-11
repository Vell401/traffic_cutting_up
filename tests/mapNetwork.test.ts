import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientCore } from '../src/online/clientCore';
import { GameServer } from '../src/online/gameServer';
import { apiBase, healthUrl, onlineTokenKey, serverUrl } from '../src/online/link';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { Writer, type ServerMsg } from '../src/online/protocol';
import { OnlineWorld, replay } from '../src/online/world';
import { getMap } from '../src/sim/maps';
import { Sim } from '../src/sim/world';
import { defaultTuning, applyTuning } from '../src/sim/tuning';
import { laneCenter } from '../src/config';
import { NetSession, link } from './netsim';

afterEach(() => { applyTuning(defaultTuning()); vi.unstubAllGlobals(); });

function connect(game: GameServer, over: Record<string, unknown> = {}) {
  const messages: ServerMsg[] = [];
  const close = vi.fn();
  const conn = game.connect({ send(d) { if (typeof d === 'string') messages.push(JSON.parse(d)); }, close, buffered: 0 });
  conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, map: game.world.map.id, rules: rulesHash(game.world.map.id), name: 'A', physics: 2, car: 2, seq: 0, ...over }));
  return { conn, messages, close };
}

describe('per-map handshake fencing', () => {
  it('uses distinct immutable shipped hashes even after all runtime tuning changes', () => {
    const before = [rulesHash(), rulesHash('miami')];
    expect(before[0]).not.toBe(before[1]);
    const tuning = defaultTuning();
    for (const car of Object.values(tuning.cars)) if (car.powerKW !== undefined) car.powerKW *= 1.1;
    applyTuning(tuning);
    expect([rulesHash(), rulesHash('miami')]).toEqual(before);
    expect(PROTOCOL_VERSION).toBe(13);
  });

  it.each(['highway', 'miami'] as const)('%s validates map and rules before token reconnect/join', map => {
    const game = new GameServer({ seed: 3, map, token: () => 'secret' });
    const first = connect(game);
    const welcome = first.messages.find((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome')!;
    expect(welcome).toMatchObject({ map, mapRevision: getMap(map).revision, v: PROTOCOL_VERSION, ringLen: 12000, rulesHash: rulesHash(map) });
    for (const over of [{ map: map === 'miami' ? 'highway' : 'miami' }, { map: 'bogus' }, { map: null }, { rules: rulesHash(map === 'miami' ? 'highway' : 'miami') }, { v: PROTOCOL_VERSION - 1 }]) {
      const bad = connect(game, { token: welcome.token, ...over });
      expect(bad.messages.some(m => m.t === 'welcome')).toBe(false);
      expect(bad.close).toHaveBeenCalled();
      expect(first.conn.closed).toBe(false);
      expect(game.playerCount).toBe(1);
      expect(game.world.drivers).toHaveLength(1);
    }
    if (map === 'miami') expect(connect(game, { map: undefined }).messages[0]).toMatchObject({ t: 'reject', reason: 'map' });
  });

  it.each(['map', 'mapRevision', 'ringLen', 'rulesHash', 'v', 'missing'] as const)('wrong welcome %s cannot apply tuning, accept snapshots or activate', field => {
    const game = new GameServer({ seed: 7, map: 'miami' });
    const { messages } = connect(game);
    const welcome = messages.find(m => m.t === 'welcome')! as Extract<ServerMsg, { t: 'welcome' }>;
    const wrong: Record<string, unknown> = { ...welcome, tuning: defaultTuning() };
    (wrong.tuning as ReturnType<typeof defaultTuning>).cars['2'].powerKW = 999;
    if (field === 'missing') delete wrong.map;
    else wrong[field] = field === 'map' ? 'highway' : field === 'rulesHash' ? 'bad' : -1;
    const sim = new Sim(Math.random, { online: true, map: 'miami', physics: 2 });
    const power = sim.player.tune.powerKW, onWelcome = vi.fn(), onReject = vi.fn();
    const core = new ClientCore(sim, { send() {}, onWelcome, onReject });
    const writer = new Writer(); game.world.writeSnapshot(game.world.drivers[0], writer);
    core.receive(JSON.stringify(wrong), 0);
    core.receive(writer.bytes(), 0);
    core.receive(JSON.stringify({ t: 'tuning', tuning: wrong.tuning }), 0);
    expect(core.ready).toBe(false);
    expect(core.id).toBe(0);
    expect(core.token).toBe('');
    expect(sim.player.tune.powerKW).toBe(power);
    expect(onWelcome).not.toHaveBeenCalled(); expect(onReject).toHaveBeenCalledOnce();
    // The genuine welcome is accepted, then the exact same snapshot activates prediction.
    core.receive(JSON.stringify(welcome), 0); core.receive(writer.bytes(), 0);
    expect(core.ready).toBe(true);
  });
});

describe('map-aware prediction and authoritative lifecycle', () => {
  it.each(['highway', 'miami'] as const)('%s shares one ghost pad, respawns on ±laps, and parks away', map => {
    const world = new OnlineWorld(9, { ghostSeconds: .01 }, map); world.traffic.enabled = false;
    const a = world.join('A', 2)!, b = world.join('B', 2)!;
    expect(a.car.s).toBe(b.car.s); expect(a.car.s).toBe(world.map.spawn.s);
    const idle = { steer: 0, throttle: 0, brake: 0, flags: 0 };
    for (let i = 1; i <= 240; i++) {
      world.input(a, i, [idle], 1); world.input(b, i, [idle], 1); world.step();
    }
    expect(a.car.ghost && b.car.ghost).toBe(true);
    for (const lap of [-3, 2]) {
      a.car.s = world.map.spawn.s + lap * world.ringLen + 100;
      world.respawn(a);
      expect(a.car.s).toBe(world.map.spawn.s + lap * world.ringLen);
      expect(a.car.d).toBe(world.map.spawn.d); expect(a.car.vAlong).toBe(0);
    }
    for (let i = 0; i < 120; i++) world.step();
    expect(a.state).toBe('away'); expect(a.car.ghost).toBe(true);
    world.input(a, 241, [idle], 1); world.step(); expect(a.state).toBe('active');
  });

  it.each(['highway', 'miami'] as const)('%s replays deterministically with mixed cars, jitter and runtime config', map => {
    const net = new NetSession(43, {}, true, map);
    for (const physics of [1, 2, 3, 4, 5] as const) net.add({ name: `P${physics}`, physics, up: link(35, 15), down: link(35, 15), fps: 30, bot: { kmh: 180, weave: true } });
    net.run(3); net.server.configure({ traffic: 2, intensity: .6 }); net.run(4);
    expect(net.clients.every(c => c.core.ready && c.sim.map.id === map)).toBe(true);
    const live = net.server.world;
    expect(replay(43, {}, net.journal, live.tick, undefined, map).hash()).toBe(live.hash());
    expect(live.drivers.find(d => d.physics === 2)!.car.stateSize).toBe(58);
    expect(net.server.health(false)).toMatchObject({ map, protocol: PROTOCOL_VERSION, ringLen: 12000 });
  });

  it.each([-1, 1])('Miami crosses the seam on lap %s without a correction', lap => {
    const net = new NetSession(10, {}, false, 'miami'); net.server.world.traffic.enabled = false;
    const a = net.add({ name: 'A', physics: 2, up: link(30, 10), down: link(30, 10), fps: 30, bot: { kmh: 200, weave: false } });
    net.run(1);
    const dr = net.server.world.byId(a.core.id)!;
    dr.car.reset(lap * 12000 - 80, laneCenter(1), 200 / 3.6); dr.epoch++;
    net.run(4);
    expect(dr.car.s).toBeGreaterThan(lap * 12000);
    expect(a.core.stats.maxCorrection).toBeLessThan(1e-6);
  });
});

describe('map endpoints and reconnect token namespaces', () => {
  it('routes map defaults, explicit endpoints and sibling HTTP paths without dropping prefixes', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.com', href: 'https://example.com/' });
    expect(serverUrl(new URLSearchParams())).toBe('wss://example.com/ws');
    expect(serverUrl(new URLSearchParams(), 'miami')).toBe('wss://example.com/miami/ws');
    expect(serverUrl(new URLSearchParams('server=wss://custom.test/ws'), 'miami')).toBe('wss://custom.test/ws');
    expect(apiBase('wss://example.com/miami/ws?auth=x')).toBe('https://example.com/miami/api');
    expect(healthUrl('wss://example.com/miami/ws/')).toBe('https://example.com/miami/health');
  });
  it('canonicalizes endpoint identity and separates host, port, prefix and map', () => {
    const key = onlineTokenKey('wss://EXAMPLE.com:443/ws/');
    expect(key).toBe(onlineTokenKey('wss://example.com/ws'));
    const keys = new Set([key, onlineTokenKey('wss://other.com/ws'), onlineTokenKey('wss://example.com:8443/ws'), onlineTokenKey('wss://example.com/miami/ws'), onlineTokenKey('wss://example.com/ws', 'miami')]);
    expect(keys.size).toBe(5);
    expect(key).not.toBe('tcu.online.token');
  });
});
