import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../server/api';
import { Store, type LeaderEntry, type RunMode } from '../server/store';
import type { MapId } from '../src/sim/maps';

const instances: { api: Api; store: Store }[] = [];
const run = { car: 1, physics: 1, near: 2, topKmh: 180, seconds: 30 };
function fixture(map: MapId = 'highway', history = 0) {
  const store = new Store(':memory:');
  for (let i = 0; i < history; i++) store.addRun({ ...run, mode: 'solo', name: `Name ${i % 100}`, score: 1000 + i }, i);
  const api = new Api(store, { map, origins: [], log() {} });
  instances.push({ api, store });
  const queries = {
    board: vi.spyOn(store, 'leaderboard'), count: vi.spyOn(store, 'playerCount'), place: vi.spyOn(store, 'placeOn'),
  };
  const work = () => Object.values(queries).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  const get = (name = '', mode: RunMode = 'solo', limit = '10', addr = '192.0.2.1') => {
    const headers: Record<string, string> = {};
    let status = 0;
    let body: { entries?: LeaderEntry[]; total?: number; me?: LeaderEntry | null; map?: MapId } = {};
    const req = { method: 'GET', url: `/api/leaderboard?${new URLSearchParams({ mode, limit, name })}`, headers: {}, socket: { remoteAddress: addr } } as IncomingMessage;
    const res = {
      setHeader(key: string, value: string) { headers[key] = value; },
      writeHead(code: number, values: Record<string, string>) { status = code; Object.assign(headers, values); },
      end(value: string) { body = JSON.parse(value); },
    } as unknown as ServerResponse;
    expect(api.handle(req, res)).toBe(true);
    return { status, body, headers };
  };
  return { store, api, get, queries, work };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { api, store } of instances.splice(0)) { api.close(); store.close(); }
});

describe('bounded public leaderboard SQL work', () => {
  it('caches mature-history board/count/name work independently of hostile response limits', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const f = fixture('highway', 50_000);
    const first = f.get('Name 0');
    expect(first).toMatchObject({ status: 200, body: { total: 100, me: { name: 'Name 0', rank: 100, score: 50900 } } });
    expect(first.body.entries).toHaveLength(10);
    for (const limit of ['1', '1.5', 'NaN', 'Infinity', '1e300', '100']) {
      const result = f.get('Name 0', 'solo', limit);
      expect(result.status).toBe(200);
      expect(result.body.entries!.length).toBeLessThanOrEqual(100);
    }
    expect(f.work()).toBe(3);
    expect(f.queries.board).toHaveBeenCalledWith('solo', 100);
    expect(f.store.playerCount('solo')).toBe(100);
  });

  it('admits at most six SQL calls per rolling second across names, modes and addresses', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const f = fixture('highway', 10_000);
    expect(f.get('Name 0').status).toBe(200); // board, count, place = 3
    clock.mockReturnValue(200_500);
    expect(f.get('Unknown 1').status).toBe(200);
    expect(f.get('Unknown 2').status).toBe(200);
    expect(f.get('Unknown 3').status).toBe(200);
    for (let i = 0; i < 100; i++) expect(f.get(`Random ${i}`, i % 2 ? 'solo' : 'online', '10', `198.51.100.${i}`).status).toBe(429);
    expect(f.work()).toBe(6);
    expect(f.get('Name 0').status).toBe(200); // hits cost no SQL even when exhausted
    expect(f.get('Unknown 1').body.me).toBeNull(); // negative results are cached too
    clock.mockReturnValue(200_999);
    expect(f.get('Another').status).toBe(429);
    clock.mockReturnValue(201_000);
    expect(f.get('Online', 'online').status).toBe(200); // first 3 admissions expired exactly
    expect(f.work()).toBe(9);
    expect(f.get('Another').status).toBe(429); // later admissions have not expired
  });

  it('expires entries at two seconds, caps name retention at 32 and never refreshes denied misses', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(300_000);
    const f = fixture();
    expect(f.get('First').status).toBe(200);
    for (let i = 0; i < 1000; i++) {
      clock.mockReturnValue(300_000 + (i + 1) * 1000);
      expect(f.get(`Name ${i}`).status).toBe(200);
    }
    // Structural memory bound as well as behavioral work bounds: names cannot accumulate forever.
    const cache = (f.api as unknown as { leaderboardNames: Map<string, unknown> }).leaderboardNames;
    expect(cache?.size ?? Infinity).toBeLessThanOrEqual(32);
    const before = f.work();
    expect(f.get('Name 999').status).toBe(200);
    expect(f.work()).toBe(before);
    clock.mockReturnValue(1_301_999);
    expect(f.get('Name 999').status).toBe(200);
    expect(f.work()).toBe(before);
    clock.mockReturnValue(1_302_000);
    expect(f.get('Name 999').status).toBe(200);
    expect(f.work()).toBe(before + 3);
  });

  it('invalidates after online/solo writes and removals, never returning stale rankings under pressure', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(400_000);
    const f = fixture();
    f.store.addRun({ ...run, mode: 'solo', name: 'Old', score: 2000 });
    expect(f.get('Old').body.me?.rank).toBe(1);
    f.store.addRun({ ...run, mode: 'solo', name: 'New', score: 3000 });
    expect(f.get('Old').body).toMatchObject({ total: 2, entries: [{ name: 'New', rank: 1 }, { name: 'Old', rank: 2 }], me: { rank: 2 } });
    f.store.removeRuns('solo', 'NEW');
    expect(f.get('Old').status).toBe(429); // stale cache cannot bypass admission
    expect(f.work()).toBe(6);
    clock.mockReturnValue(401_000);
    expect(f.get('Old').body).toMatchObject({ total: 1, me: { rank: 1 } });
    expect(f.get('Online', 'online').body.total).toBe(0);
    f.store.addRun({ ...run, mode: 'online', name: 'Online', score: 5000 });
    expect(f.get('Online', 'online').status).toBe(429);
    clock.mockReturnValue(402_000);
    expect(f.get('Online', 'online').body).toMatchObject({ total: 1, me: { score: 5000, rank: 1 } });
    const before = f.work();
    f.store.addRun({ ...run, mode: 'online', name: 'Low', score: 999 });
    f.store.removeRuns('online', 'Missing');
    expect(f.get('Online', 'online').status).toBe(200);
    expect(f.work()).toBe(before);
  });

  it('isolates budgets, caches and mode revisions across instances, including two of the same map', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500_000);
    const highway = fixture('highway');
    const miami = fixture('miami');
    const peer = fixture('highway');
    for (const [index, f] of [highway, miami, peer].entries()) {
      f.store.addRun({ ...run, mode: 'solo', name: 'Shared', score: 2000 + index });
      expect(f.get('Shared').body).toMatchObject({ map: index === 1 ? 'miami' : 'highway', me: { score: 2000 + index } });
    }
    for (let i = 0; i < 3; i++) expect(highway.get(`Missing ${i}`).status).toBe(200);
    expect(highway.get('Exhausted').status).toBe(429);
    expect(miami.get('Fresh').status).toBe(200);
    expect(peer.get('Fresh').status).toBe(200);
    highway.store.addRun({ ...run, mode: 'online', name: 'Online', score: 9999 });
    expect(highway.get('Shared').body.me?.score).toBe(2000); // other-mode write keeps solo hit valid
    expect(highway.work()).toBe(6);
  });
});
