import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../public/audio/w204/manifest.json';
import { M156EngineSound, m156LoadGain, preloadW204Audio } from '../src/audio/m156Engine';
import { rpmBlend } from '../src/audio/porscheEngine';
import { Sound } from '../src/audio/sound';
import { Sim } from '../src/sim/world';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
function mockNode() {
    const n = {
      gain: param(), frequency: param(), Q: param(), playbackRate: param(), pan: param(),
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), setPeriodicWave: vi.fn(),
      buffer: null as unknown, loop: false, type: '',
    };
    n.connect.mockImplementation(() => n); return n;
}
function audioMock() {
  const nodes: ReturnType<typeof mockNode>[] = [];
  const node = () => { const n = mockNode(); nodes.push(n); return n; };
  const ctx = {
    currentTime: 1, sampleRate: 1000, state: 'running', destination: {},
    createGain: vi.fn(node), createBiquadFilter: vi.fn(node), createBufferSource: vi.fn(node),
    createOscillator: vi.fn(node), createWaveShaper: vi.fn(node), createStereoPanner: vi.fn(node),
    createDynamicsCompressor: vi.fn(node), createConvolver: vi.fn(node), createPeriodicWave: vi.fn(),
    createBuffer: vi.fn((_ch: number, n: number) => ({ duration: n / 1000, getChannelData: () => new Float32Array(n) })),
    decodeAudioData: vi.fn(async () => ({ duration: 1 })),
  };
  return { ctx, nodes, bus: { dry: node(), send: node() } };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('original W204 running sound assets', () => {
  it('preserves all 32 unique WAVs byte for byte with SHA256 provenance', () => {
    expect(manifest.clips).toHaveLength(32);
    expect(new Set(manifest.clips.map(c => c.sha256)).size).toBe(32);
    expect(manifest.clips.reduce((n, c) => n + c.bytes, 0)).toBe(4089792);
    for (const c of manifest.clips) {
      const wav = read(`public/audio/w204/${c.file}`);
      expect(wav.equals(read(`${manifest.source}/${c.source}`))).toBe(true);
      expect(wav.length).toBe(c.bytes); expect(sha(wav)).toBe(c.sha256);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF'); expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(c.rate).toBeGreaterThan(0); expect(c.frames / c.rate).toBe(c.seconds);
    }
    for (const p of manifest.provenance) expect(sha(read(`${manifest.source}/${p.source}`))).toBe(p.sha256);
  });
  it('preserves every source RPM and both identical load lists, including the 04950 filename / 4949 RPM', () => {
    for (const b of manifest.banks) {
      const source = JSON.parse(read(`${manifest.source}/art/sound/blends/V8_AMG_M156_${b.channel}.sfxBlend2D.json`).toString());
      for (const [n, list] of [b.off, b.on].entries())
        expect(list.map(i => [manifest.clips[i].source, manifest.clips[i].rpm])).toEqual(source.samples[n]);
      expect(b.off).toEqual(b.on);
      const rpms = b.off.map(i => manifest.clips[i].rpm);
      expect([rpms[0], rpms.at(-1)]).toEqual([658, 7261]);
      for (let rpm = 500; rpm <= 8000; rpm += 17) {
        const mix = rpmBlend(rpms, rpm);
        expect(mix.a ** 2 + mix.b ** 2).toBeCloseTo(1);
        expect(mix.low).toBeGreaterThanOrEqual(0); expect(mix.high).toBeLessThan(16);
      }
      const mid = rpmBlend(rpms, Math.sqrt(rpms[4] * rpms[5]));
      expect(mid.a).toBeCloseTo(Math.SQRT1_2); expect(mid.b).toBeCloseTo(Math.SQRT1_2);
      expect(m156LoadGain(b, 0)).toBeCloseTo(10 ** (b.config.mainGain / 20) * b.config.offLoadGain);
      expect(m156LoadGain(b, 1)).toBeCloseTo(10 ** (b.config.mainGain / 20) * (.3 * b.config.offLoadGain + .7));
      expect(m156LoadGain(b, 2)).toBe(m156LoadGain(b, 1));
    }
  });
});

describe('M156 lifecycle and routing', () => {
  it('fetches/decodes once per context, blends at most four voices, retires and disposes them', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal('fetch', fetcher);
    const { ctx, bus, nodes } = audioMock();
    const engine = new M156EngineSound(ctx as unknown as AudioContext, bus as unknown as { dry: GainNode; send: GainNode });
    await preloadW204Audio(); await flush(); expect(engine.ready).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(32); expect(ctx.decodeAudioData).toHaveBeenCalledTimes(32);
    engine.update(3000, .5, false, true, false);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(4);
    engine.update(3000, 1, false, true, true);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(4);
    engine.update(3000, 0, false, false, false); ctx.currentTime += 1;
    engine.update(3000, 0, false, false, false);
    expect(nodes.filter(n => n.stop.mock.calls.length)).toHaveLength(4);
    engine.dispose(); engine.dispose(); expect(engine.ready).toBe(false);
    const next = new M156EngineSound(ctx as unknown as AudioContext, bus as unknown as { dry: GainNode; send: GainNode });
    await flush(); expect(next.ready).toBe(true); expect(ctx.decodeAudioData).toHaveBeenCalledTimes(32);
    next.dispose();
  });
  it('routes CarId 4, disables turbo, retains effects, master/pause and cockpit, and reselects safely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    const { ctx, nodes } = audioMock();
    vi.stubGlobal('AudioContext', function () { return ctx; });
    const sim = new Sim(), sound = new Sound(sim);
    sound.setCar(4); sound.unlock(); await flush(); sound.setCockpit(true); sound.update(.016);
    // Inspect the mixer seam without exposing implementation nodes as public API.
    const s = sound as unknown as {
      m156: M156EngineSound | null; turboGain: GainNode; engGain: GainNode; i4Gain: GainNode;
      master: GainNode; dry: GainNode; bus: { engine: { dry: GainNode } }; boost: number;
    };
    expect(s.m156?.ready).toBe(true);
    expect(s.turboGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .03);
    expect(s.engGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .04);
    expect(s.i4Gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .04);
    expect(s.boost).toBe(0);
    expect(nodes.some(n => n.frequency.setTargetAtTime.mock.calls.some(c => c[0] === 6200))).toBe(true);
    const update = vi.spyOn(s.m156!, 'update');
    s.m156!.ready = false; sound.update(.016);
    expect(s.engGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(expect.any(Number), 1, .015);
    expect(vi.mocked(s.engGain.gain.setTargetAtTime).mock.lastCall![0]).toBeGreaterThan(0);
    s.m156!.ready = true;
    const effectsBefore = ctx.createBufferSource.mock.calls.length;
    sound.tick(true); expect(ctx.createBufferSource.mock.calls.length).toBeGreaterThan(effectsBefore);
    sound.setLevel('engine', .4); expect(s.bus.engine.dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(.4, 1, .03);
    sound.setPaused(true); expect(s.dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .05);
    update.mockClear(); sound.update(.016); expect(update).not.toHaveBeenCalled();
    sound.toggleMute(); expect(s.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .05);
    const previous = s.m156!; sound.setCar(3); expect(previous.ready).toBe(false); expect(s.m156).toBeNull();
    sound.setCar(4); await flush(); expect(s.m156?.ready).toBe(true); expect(s.m156).not.toBe(previous);
    sound.setCar(3);
  });
  it('keeps fallback usable after decoding failure and ignores completion after disposal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, bus } = audioMock(); ctx.decodeAudioData.mockRejectedValue(new Error('bad WAV'));
    const engine = new M156EngineSound(ctx as unknown as AudioContext, bus as unknown as { dry: GainNode; send: GainNode });
    await flush(); expect(engine.ready).toBe(false); expect(() => engine.update(800, 0, false, true, false)).not.toThrow();
    engine.dispose();
    ctx.decodeAudioData.mockResolvedValue({ duration: 1 });
    const next = new M156EngineSound(ctx as unknown as AudioContext, bus as unknown as { dry: GainNode; send: GainNode });
    next.dispose(); await flush(); expect(next.ready).toBe(false);
  });
});
