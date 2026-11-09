import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTyreFeedback, sampleTyreFeedback } from '../src/presentation/tyres';
import { createTyreAudioTargets, sampleTyreAudio, TyreAudio } from '../src/audio/tyreAudio';
import { Sound } from '../src/audio/sound';
import { R34Car } from '../src/sim/vehicleR34';
import { Sim } from '../src/sim/world';

const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
function mockNode() {
  const n = { gain: param(), frequency: param(), Q: param(), pan: param(), threshold: param(), knee: param(),
    ratio: param(), attack: param(), release: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    setPeriodicWave: vi.fn(), buffer: null as unknown, type: '', loop: false };
  n.connect.mockImplementation(() => n); return n;
}
function audioMock() {
  const nodes: ReturnType<typeof mockNode>[] = [], node = () => { const n = mockNode(); nodes.push(n); return n; };
  const ctx = { currentTime: 1, sampleRate: 8000, state: 'running', destination: {},
    createGain: vi.fn(node), createBiquadFilter: vi.fn(node), createStereoPanner: vi.fn(node), createBufferSource: vi.fn(node),
    createOscillator: vi.fn(node), createWaveShaper: vi.fn(node), createDynamicsCompressor: vi.fn(node),
    createConvolver: vi.fn(node), createPeriodicWave: vi.fn(), createMediaElementSource: vi.fn(node),
    createBuffer: vi.fn((ch: number, n: number, sr: number) => {
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      return { duration: n / sr, getChannelData: (i: number) => channels[i] };
    }) };
  return { ctx, nodes, bus: { dry: node(), send: node() } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('slip/load tyre audio targets', () => {
  it('separates clean rolling from squeal, regardless of brake pedal', () => {
    const car = new R34Car(); car.reset(0, 0, 30); car.brake = 1;
    const w = sampleTyreFeedback(car, createTyreFeedback()).wheels[0];
    const target = sampleTyreAudio(w, createTyreAudioTargets());
    expect(target.rollingGain).toBeGreaterThan(0); expect(target.scrubGain).toBe(0); expect(target.lockGain).toBe(0);
  });
  it('makes stationary rear burnout audible while fronts remain silent', () => {
    const car = new R34Car(); car.reset(0, 0, 0); car.omega[2] = car.omega[3] = 90;
    const f = sampleTyreFeedback(car, createTyreFeedback());
    expect(sampleTyreAudio(f.wheels[2], createTyreAudioTargets()).scrubGain).toBeGreaterThan(.04);
    expect(sampleTyreAudio(f.wheels[0], createTyreAudioTargets()).scrubGain).toBe(0);
  });
  it('adds darker lock texture only to actually stopped wheels moving over the road', () => {
    const car = new R34Car(); car.reset(0, 0, 25); car.omega[0] = 0;
    const f = sampleTyreFeedback(car, createTyreFeedback());
    const locked = sampleTyreAudio(f.wheels[0], createTyreAudioTargets());
    expect(locked.lockGain).toBeGreaterThan(.02);
    expect(locked.lockHz).toBeLessThan(locked.scrubHz);
    expect(sampleTyreAudio(f.wheels[1], createTyreAudioTargets()).lockGain).toBe(0);
  });
  it('has identical clean forward/reverse target gains and no low-speed cutoff jump', () => {
    const car = new R34Car(), out = createTyreFeedback(); car.reset(0, 0, 6);
    const a = sampleTyreAudio(sampleTyreFeedback(car, out).wheels[0], createTyreAudioTargets());
    car.reset(0, 0, -6);
    const b = sampleTyreAudio(sampleTyreFeedback(car, out).wheels[0], createTyreAudioTargets());
    expect(a).toEqual(b);
    car.reset(0, 0, 1.49); car.omega[2] = 90;
    const low = sampleTyreAudio(sampleTyreFeedback(car, out).wheels[2], createTyreAudioTargets());
    car.vx = 1.51;
    const high = sampleTyreAudio(sampleTyreFeedback(car, out).wheels[2], createTyreAudioTargets());
    expect(Math.abs(low.scrubGain - high.scrubGain)).toBeLessThan(.001);
  });
  it('bounds levels/filters under extreme slip and unloads all layers with zero load', () => {
    const w = createTyreFeedback().wheels[0];
    Object.assign(w, { contactLongitudinal: 300, rollingSpeed: 0, longitudinalSlipSpeed: -300,
      lateralSlipSpeed: 200, normalLoad: 20000, slipIntensity: 1 });
    const out = sampleTyreAudio(w, createTyreAudioTargets());
    expect(out.rollingGain + out.scrubGain + out.lockGain).toBeLessThan(.14);
    expect(out.rollingHz).toBeLessThanOrEqual(2400); expect(out.scrubHz).toBeLessThanOrEqual(2100);
    w.normalLoad = 0; sampleTyreAudio(w, out);
    expect(out.rollingGain + out.scrubGain + out.lockGain).toBe(0);
  });
  it('ramps continuously through scrub onset instead of switching a whistle on', () => {
    const car = new R34Car(); car.reset(0, 0, 20);
    const feedback = createTyreFeedback(), target = createTyreAudioTargets();
    let previous = 0;
    for (let slip = 0; slip < 8; slip += .01) {
      car.omega[2] = (20 + slip) / car.tune.wheelRadius;
      sampleTyreAudio(sampleTyreFeedback(car, feedback).wheels[2], target);
      expect(target.scrubGain).toBeGreaterThanOrEqual(previous - 1e-10);
      expect(target.scrubGain - previous).toBeLessThan(.0004);
      previous = target.scrubGain;
    }
  });
});

describe('persistent tyre graph and mixer integration', () => {
  it('builds four stereo voices, sends scrub to reverb and allocates no nodes over 1000 updates', () => {
    const { ctx, nodes, bus } = audioMock();
    const noise = ctx.createBuffer(1, 16000, 8000);
    const audio = new TyreAudio(ctx as unknown as AudioContext, noise as AudioBuffer, bus as unknown as { dry: GainNode; send: GainNode });
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(4); expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBiquadFilter).toHaveBeenCalledTimes(12); expect(ctx.createStereoPanner).toHaveBeenCalledTimes(4);
    expect(ctx.createBiquadFilter.mock.results.every(r => r.value.Q.value <= .85)).toBe(true);
    expect(nodes.filter(n => n.connect.mock.calls.some(c => c[0] === bus.send))).toHaveLength(4);
    const count = nodes.length, car = new R34Car(); car.reset(0, 0, 0); car.omega[2] = car.omega[3] = 90;
    const f = sampleTyreFeedback(car, createTyreFeedback());
    for (let i = 0; i < 1000; i++) audio.update(f, i / 60);
    expect(nodes).toHaveLength(count);
    expect(nodes.some(n => n.gain.setTargetAtTime.mock.calls.some(c => c[0] > .04 && c[2] === .045))).toBe(true);
    expect(nodes.filter(n => n.pan.value < 0)).toHaveLength(2);
    expect(nodes.filter(n => n.pan.value > 0)).toHaveLength(2);
  });
  it('retains independent radio, pause/mute and world sends without rebuilding during updates', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    const { ctx, nodes } = audioMock(); vi.stubGlobal('AudioContext', function () { return ctx; });
    const sim = new Sim(Math.random, { physics: 2 }), sound = new Sound(sim); sound.unlock();
    const s = sound as unknown as { master: GainNode; wet: GainNode; dry: GainNode; bus: Record<string, { dry: GainNode; send: GainNode }> };
    const media = {} as HTMLMediaElement; sound.connectRadio(media); sound.connectRadio(media);
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(s.bus.radio.dry.connect).toHaveBeenCalledWith(s.master);
    expect(s.bus.radio.send.gain.value).toBe(0);
    const count = nodes.length;
    for (let i = 0; i < 100; i++) sound.update(1 / 60);
    expect(nodes).toHaveLength(count); expect(ctx.createConvolver).toHaveBeenCalledTimes(3);
    sound.setLevel('world', .3);
    expect(s.bus.world.send.gain.setTargetAtTime).toHaveBeenLastCalledWith(.3, 1, .03);
    sound.setPaused(true);
    expect(s.dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .05);
    expect(s.wet.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .05);
    sound.toggleMute(); expect(s.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .05);
  });
});
