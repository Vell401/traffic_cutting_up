import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sound } from '../src/audio/sound';
import { Sim } from '../src/sim/world';

afterEach(() => vi.unstubAllGlobals());
describe('independent radio mixer', () => {
  it('retains existing saved game levels and adds an independent radio level', () => {
    const saved = new Map([['tcu.mix', JSON.stringify({ master: .7, engine: .8, world: .9, fx: .6 })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    const sound = new Sound(new Sim());
    expect(sound.level('radio')).toBe(.45); expect(sound.level('engine')).toBe(.8);
    const listener = vi.fn(); sound.onMixChange(listener); sound.setLevel('radio', 0);
    expect(sound.level('engine')).toBe(.8); expect(sound.level('radio')).toBe(0); expect(listener).toHaveBeenCalledOnce();
    expect(new Sound(new Sim()).level('radio')).toBe(0);
  });
  it('routes media through the radio bus once and keeps it audible during solo pause but not master mute', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    const sound = new Sound(new Sim());
    const node = () => ({ gain: { setTargetAtTime: vi.fn() } });
    const master = node(), dry = node(), wet = node(), radio = { dry: node(), send: node() };
    const connect = vi.fn(), createMediaElementSource = vi.fn(() => ({ connect }));
    Object.assign(sound, { ctx: { currentTime: 0, state: 'running', createMediaElementSource }, master, dry, wet, bus: { radio } });
    const element = {} as HTMLMediaElement;
    sound.connectRadio(element); sound.connectRadio(element);
    expect(createMediaElementSource).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledWith(radio.dry);
    sound.setLevel('radio', .2);
    expect(radio.dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(.2, 0, .03);
    expect(radio.send.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .03);
    sound.setPaused(true);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(.8, 0, .05);
    expect(dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .05);
    sound.toggleMute(); expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .05);
    sound.toggleMute(); sound.setPaused(false);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(.8, 0, .05);
    expect(dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, .05);
  });
});
