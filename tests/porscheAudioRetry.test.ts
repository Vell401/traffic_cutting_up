import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../public/audio/porsche/manifest.json';
import type { PorscheEngine } from '../src/audio/porscheEngine';
import type { Sound } from '../src/audio/sound';
import { Sim } from '../src/sim/world';

const count = manifest.clips.length;
const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
function mockNode() {
  const node = { gain: param(), frequency: param(), Q: param(), playbackRate: param(), pan: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), setPeriodicWave: vi.fn(),
    buffer: null as unknown, loop: false, type: '' };
  node.connect.mockImplementation(() => node);
  return node;
}
function audioMock() {
  const nodes: ReturnType<typeof mockNode>[] = [];
  const node = () => { const n = mockNode(); nodes.push(n); return n; };
  const ctx = { currentTime: 1, sampleRate: 1000, state: 'running', destination: {},
    createGain: vi.fn(node), createBiquadFilter: vi.fn(node), createBufferSource: vi.fn(node),
    createOscillator: vi.fn(node), createWaveShaper: vi.fn(node), createStereoPanner: vi.fn(node),
    createDynamicsCompressor: vi.fn(node), createConvolver: vi.fn(node), createPeriodicWave: vi.fn(),
    createBuffer: vi.fn((_ch: number, n: number) => ({ duration: n / 1000, getChannelData: () => new Float32Array(n) })),
    decodeAudioData: vi.fn(async (_data: ArrayBuffer) => ({ duration: 1 })),
  };
  return { ctx, nodes, bus: { dry: node(), send: node() } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const seam = (sound: Sound) => sound as unknown as { porsche: PorscheEngine; engGain: ReturnType<typeof mockNode> };
const internal = (engine: PorscheEngine) => engine as unknown as { buffers: unknown[]; voices: Map<number, unknown> };

async function setup() {
  const audio = audioMock();
  const failedFetch = new Set<number>(), failedDecode = new Set<number>();
  let networkFailure = false;
  const fetcher = vi.fn(async (url: string) => {
    const index = manifest.clips.findIndex(c => url.endsWith(`/${c.file}`));
    if (failedFetch.has(index) && networkFailure) throw new Error('offline');
    return { ok: !failedFetch.has(index), status: 503,
      arrayBuffer: async () => new Uint8Array([index]).buffer };
  });
  audio.ctx.decodeAudioData.mockImplementation(async data => {
    if (failedDecode.has(new Uint8Array(data)[0])) throw new Error('temporary decode failure');
    return { duration: 1 };
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('AudioContext', function () { return audio.ctx; });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  const { PorscheEngine, preloadPorscheAudio } = await import('../src/audio/porscheEngine');
  const { Sound } = await import('../src/audio/sound');
  const engine = () => new PorscheEngine(audio.ctx as unknown as AudioContext, audio.bus as unknown as { dry: GainNode; send: GainNode });
  const sound = () => { const s = new Sound(new Sim()); s.unlock(); s.setCar(1); return s; };
  return { ...audio, fetcher, failedFetch, failedDecode, engine, sound, preloadPorscheAudio,
    network: () => { networkFailure = true; } };
}

beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Porsche selection-triggered recovery', () => {
  it.each([
    ['HTTP', false, false], ['HTTP', false, true], ['network', true, false], ['network', true, true],
  ] as const)('recovers from %s failure (switch away: %s/%s) without replacing its engine', async (_kind, network, switchAway) => {
    const r = await setup(); r.failedFetch.add(0); if (network) r.network();
    const sound = r.sound(), engine = seam(sound).porsche;
    await engine.retry(); expect(engine.ready).toBe(false);
    expect(r.ctx.decodeAudioData).not.toHaveBeenCalled();
    const failedNodes = r.nodes.length;
    for (let i = 0; i < 100; i++) sound.update(1 / 60);
    expect(r.nodes).toHaveLength(failedNodes); expect(r.fetcher).toHaveBeenCalledTimes(count);
    expect(seam(sound).engGain.gain.setTargetAtTime.mock.lastCall![0]).toBeGreaterThan(0);
    r.failedFetch.clear(); if (switchAway) sound.setCar(2); sound.setCar(1);
    await engine.retry(); expect(seam(sound).porsche).toBe(engine); expect(engine.ready).toBe(true);
    expect(r.fetcher).toHaveBeenCalledTimes(count + 1); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count);
    sound.update(1 / 60);
    expect(seam(sound).engGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .04);
    const readyNodes = r.nodes.length;
    for (let i = 0; i < 100; i++) { sound.setCar(1); sound.update(1 / 60); }
    expect(r.nodes).toHaveLength(readyNodes); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count);
    engine.dispose();
  });

  it.each([false, true])('retries only failed decodes and reuses bytes/buffers (switch away: %s)', async switchAway => {
    const r = await setup(); r.failedDecode.add(0);
    const sound = r.sound(), engine = seam(sound).porsche;
    await engine.retry(); expect(engine.ready).toBe(false);
    const cached = internal(engine).buffers[1]; expect(cached).toBeDefined();
    r.failedDecode.clear(); if (switchAway) sound.setCar(2); sound.setCar(1);
    await engine.retry(); expect(engine.ready).toBe(true); expect(internal(engine).buffers[1]).toBe(cached);
    expect(r.fetcher).toHaveBeenCalledTimes(count); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count + 1);
    engine.dispose();
  });

  it('recovers a failed pre-unlock preload on the first unlocked selection', async () => {
    const r = await setup(); r.failedFetch.add(0);
    const { Sound } = await import('../src/audio/sound'); const sound = new Sound(new Sim());
    sound.setCar(1); await expect(r.preloadPorscheAudio()).rejects.toThrow();
    r.failedFetch.clear(); sound.unlock(); await seam(sound).porsche.retry();
    expect(seam(sound).porsche.ready).toBe(true); expect(r.fetcher).toHaveBeenCalledTimes(count + 1);
    seam(sound).porsche.dispose();
  });

  it('deduplicates parallel selections and explicit retries during decoding', async () => {
    const r = await setup(), gate = deferred<{ duration: number }>();
    r.ctx.decodeAudioData.mockImplementation(() => gate.promise);
    const sound = r.sound(), engine = seam(sound).porsche, task = engine.retry();
    await flush();
    for (let i = 0; i < 100; i++) { sound.setCar(1); expect(engine.retry()).toBe(task); }
    expect(r.fetcher).toHaveBeenCalledTimes(count); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count);
    expect(engine.ready).toBe(false); expect(internal(engine).voices.size).toBe(0);
    gate.resolve({ duration: 1 }); await task; expect(engine.ready).toBe(true);
    engine.update(3000, .5, false, true, false); const nodes = r.nodes.length;
    for (let i = 0; i < 100; i++) { sound.setCar(1); engine.update(3000, .5, false, true, false); }
    expect(r.nodes).toHaveLength(nodes); engine.dispose();
  });

  it('shares parallel preloads and retains all successful fetched clips', async () => {
    const r = await setup(); r.failedFetch.add(0);
    const task = r.preloadPorscheAudio();
    expect(r.preloadPorscheAudio()).toBe(task); await expect(task).rejects.toThrow();
    r.failedFetch.clear(); const data = await r.preloadPorscheAudio();
    expect(data).toHaveLength(count); expect(r.fetcher).toHaveBeenCalledTimes(count + 1);
    expect(await r.preloadPorscheAudio()).toBe(data);
  });

  it('drains fetching workers before permitting another batch and caps concurrency at four', async () => {
    const r = await setup(), gate = deferred<ArrayBuffer>(); let active = 0, maxActive = 0;
    r.fetcher.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (r.fetcher.mock.calls.length === 1) { active--; throw new Error('offline'); }
      return { ok: true, status: 200, arrayBuffer: async () => { const b = await gate.promise; active--; return b; } };
    });
    const task = r.preloadPorscheAudio(); const rejected = expect(task).rejects.toThrow('offline'); await flush();
    expect(r.preloadPorscheAudio()).toBe(task); expect(maxActive).toBeLessThanOrEqual(4);
    gate.resolve(new ArrayBuffer(1)); await rejected;
    await r.preloadPorscheAudio(); expect(r.fetcher).toHaveBeenCalledTimes(count + 1);
  });

  it('drains late successful decodes before retrying only the rejected clip', async () => {
    const r = await setup(), gate = deferred<{ duration: number }>();
    r.ctx.decodeAudioData.mockImplementation(async data => {
      if (new Uint8Array(data)[0] === 0) throw new Error('decode failed');
      return gate.promise;
    });
    const engine = r.engine(), task = engine.retry(); await flush();
    expect(engine.retry()).toBe(task); expect(engine.ready).toBe(false);
    gate.resolve({ duration: 1 }); await task;
    r.ctx.decodeAudioData.mockResolvedValue({ duration: 1 }); await engine.retry();
    expect(engine.ready).toBe(true); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count + 1); engine.dispose();
  });

  it('ignores fetch completion after disposal without decoding or rebuilding nodes', async () => {
    const r = await setup(), gate = deferred<ArrayBuffer>();
    r.fetcher.mockImplementation(async () => ({ ok: true, status: 200, arrayBuffer: () => gate.promise }));
    const engine = r.engine(), task = engine.retry(), nodes = r.nodes.length;
    engine.dispose(); engine.dispose(); gate.resolve(new ArrayBuffer(1)); await task; await engine.retry();
    engine.update(3000, 1, false, true, false);
    expect(engine.ready).toBe(false); expect(r.ctx.decodeAudioData).not.toHaveBeenCalled(); expect(r.nodes).toHaveLength(nodes);
    expect(r.nodes.slice(2).every(n => n.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('ignores stale decode completion after disposal', async () => {
    const r = await setup(), gate = deferred<{ duration: number }>();
    r.ctx.decodeAudioData.mockImplementation(() => gate.promise);
    const engine = r.engine(), task = engine.retry(); await flush(); engine.dispose();
    gate.resolve({ duration: 1 }); await task; await engine.retry();
    expect(engine.ready).toBe(false); expect(internal(engine).buffers).toEqual([]);
    expect(r.ctx.createBufferSource).not.toHaveBeenCalled(); expect(r.ctx.decodeAudioData).toHaveBeenCalledTimes(count);
  });

  it('does not publish buffers or retry into a closed context; another context decodes cached bytes', async () => {
    const r = await setup(), gate = deferred<{ duration: number }>();
    r.ctx.decodeAudioData.mockImplementation(() => gate.promise);
    const engine = r.engine(), task = engine.retry(); await flush(); r.ctx.state = 'closed';
    gate.resolve({ duration: 1 }); await task; await engine.retry(); engine.update(3000, 1, false, true, false);
    expect(engine.ready).toBe(false); expect(internal(engine).buffers).toEqual([]); expect(r.ctx.createBufferSource).not.toHaveBeenCalled();
    const other = audioMock(), { PorscheEngine } = await import('../src/audio/porscheEngine');
    const next = new PorscheEngine(other.ctx as unknown as AudioContext, other.bus as unknown as { dry: GainNode; send: GainNode });
    await next.retry(); expect(next.ready).toBe(true); expect(other.ctx.decodeAudioData).toHaveBeenCalledTimes(count);
    expect(r.fetcher).toHaveBeenCalledTimes(count); engine.dispose(); next.dispose();
  });

  it('stays silent when a deselected engine finishes and disposes every voice exactly once', async () => {
    const r = await setup(), gate = deferred<{ duration: number }>();
    r.ctx.decodeAudioData.mockImplementation(() => gate.promise);
    const sound = r.sound(), engine = seam(sound).porsche, task = engine.retry();
    sound.setCar(2); gate.resolve({ duration: 1 }); await task;
    expect(engine.ready).toBe(true); expect(internal(engine).voices.size).toBe(0);
    engine.update(3000, .5, false, false, false); expect(internal(engine).voices.size).toBe(0);
    sound.setCar(1); engine.update(3000, .5, false, true, false);
    const voices = r.ctx.createBufferSource.mock.results.map(result => result.value).filter(n => n.buffer && n.loop && n.start.mock.calls.length);
    const sampled = voices.filter(n => n.playbackRate.value > 0); expect(sampled.length).toBeGreaterThan(0);
    engine.dispose(); engine.dispose();
    for (const source of sampled) { expect(source.stop).toHaveBeenCalledTimes(1); expect(source.disconnect).toHaveBeenCalledTimes(1); }
    expect(internal(engine).voices.size).toBe(0); expect(engine.ready).toBe(false);
  });
});
