import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncHttpTuning } from '../src/online/tuningSync';
import { ClientCore } from '../src/online/clientCore';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { getMap } from '../src/sim/maps';
import { Sim } from '../src/sim/world';
import { applyTuning, currentTuning, defaultTuning } from '../src/sim/tuning';

afterEach(() => { applyTuning(defaultTuning()); vi.unstubAllGlobals(); });

describe('HTTP tuning ownership', () => {
  it.each(['highway', 'miami'] as const)('never starts a stale HTTP request that could roll back %s welcome/tuning', async map => {
    const stale = defaultTuning(); stale.cars['5'].powerKW = 250;
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => stale });
    vi.stubGlobal('fetch', fetch);
    const task = syncHttpTuning('http://server/api', true);
    const sim = new Sim(Math.random, { online: true, physics: 5, map });
    const core = new ClientCore(sim, { send() {} });
    const tuning = defaultTuning(); tuning.cars['5'].powerKW = 400;
    core.receive(JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, map, mapRevision: getMap(map).revision,
      rulesHash: rulesHash(map), ringLen: map === 'miami' ? 30000 : 12000, id: 1, token: 'token', players: [], tuning }), 0);
    tuning.cars['5'].powerKW = 450;
    core.receive(JSON.stringify({ t: 'tuning', tuning }), 1);
    await task;
    expect(fetch).not.toHaveBeenCalled();
    expect(currentTuning().cars['5'].powerKW).toBe(450);
    expect(sim.player.tune.powerKW).toBe(450);
    core.dispose();
  });

  it('still applies valid HTTP tuning in solo using the selected server API', async () => {
    const tuning = defaultTuning(); tuning.cars['5'].powerKW = 390;
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => tuning });
    vi.stubGlobal('fetch', fetch);
    await syncHttpTuning('https://server/miami/api', false);
    expect(fetch).toHaveBeenCalledWith('https://server/miami/api/tuning', expect.objectContaining({ cache: 'no-store' }));
    expect(currentTuning().cars['5'].powerKW).toBe(390);
  });

  it.each(['offline', 'http', 'invalid'])('retains solo settings on %s errors', async error => {
    const before = currentTuning();
    vi.stubGlobal('fetch', error === 'offline' ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({ ok: error !== 'http', json: async () => ({ cars: {} }) }));
    await expect(syncHttpTuning('http://server/api', false)).resolves.toBeUndefined();
    expect(currentTuning()).toEqual(before);
  });
});
