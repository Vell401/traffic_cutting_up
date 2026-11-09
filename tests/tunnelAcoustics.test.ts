import { describe, expect, it, vi } from 'vitest';
import { createTunnelAcousticState, fillTunnelImpulse, sampleTunnelAcoustics,
  TUNNEL_IR_PROFILES, TunnelAcoustics } from '../src/audio/tunnelAcoustics';
import { RoadChunk, type SectionKind } from '../src/sim/road';

function roadFixture(tunnelChunks = 6) {
  const chunks: RoadChunk[] = [];
  const add = (kind: SectionKind, count: number) => {
    for (let i = 0; i < count; i++) {
      const c = new RoadChunk(); c.index = chunks.length; c.kind = kind; c.sectionIndex = i; c.sectionLen = count;
      chunks.push(c);
    }
  };
  add('open', 3); add('tunnel', tunnelChunks); add('walls', 3);
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].prevKind = chunks[i - 1]?.kind ?? 'open'; chunks[i].nextKind = chunks[i + 1]?.kind ?? 'open';
    Object.freeze(chunks[i]);
  }
  return Object.freeze({ chunkAt: (s: number) => chunks[Math.max(0, Math.min(chunks.length - 1, Math.floor(s / 100)))] });
}
const energy = (d: Float32Array, from = 0, to = d.length) => {
  let sum = 0; for (let i = from; i < to; i++) sum += d[i] * d[i]; return sum;
};

describe('geometry-aware tunnel targets', () => {
  it('is dry outside portal reach and preserves the caller buffer', () => {
    const out = createTunnelAcousticState();
    expect(sampleTunnelAcoustics(roadFixture(), 200, out)).toBe(out);
    expect(out.blend).toBe(0); expect(out.wet).toBe(0); expect(out.dry).toBe(1);
  });
  it('blends continuously across entry and exit, including adjacent chunk boundaries', () => {
    const road = roadFixture(), out = createTunnelAcousticState();
    for (const boundary of [276, 300, 340, 400, 500, 600, 800, 860, 900, 924]) {
      const a = { ...sampleTunnelAcoustics(road, boundary - .0001, out) };
      const b = sampleTunnelAcoustics(road, boundary + .0001, out);
      expect(Math.abs(a.wet - b.wet)).toBeLessThan(.00001);
      expect(Math.abs(a.dry - b.dry)).toBeLessThan(.00001);
      expect(Math.abs(a.decay - b.decay)).toBeLessThan(.00001);
    }
    expect(sampleTunnelAcoustics(road, 299, out).wet).toBeGreaterThan(0);
    expect(sampleTunnelAcoustics(road, 901, out).wet).toBeGreaterThan(0);
  });
  it('uses section length and depth, rather than the current 100m chunk alone', () => {
    const short = { ...sampleTunnelAcoustics(roadFixture(3), 450, createTunnelAcousticState()) };
    const long = sampleTunnelAcoustics(roadFixture(9), 750, createTunnelAcousticState());
    const portal = sampleTunnelAcoustics(roadFixture(9), 300, createTunnelAcousticState());
    expect(short.length).toBe(300); expect(long.length).toBe(900); expect(long.depth).toBe(450);
    expect(long.decay).toBeGreaterThan(short.decay); expect(long.wet).toBeGreaterThan(short.wet);
    expect(long.dampingHz).toBeLessThan(short.dampingHz);
    expect(long.predelay).toBeGreaterThan(portal.predelay); expect(long.wet).toBeGreaterThan(portal.wet);
  });
  it('is symmetric at the two portals and direction-independent', () => {
    const road = roadFixture();
    for (const depth of [-23, -10, 0, 10, 35, 100, 200]) {
      const entry = sampleTunnelAcoustics(road, 300 + depth, createTunnelAcousticState());
      const exit = sampleTunnelAcoustics(road, 900 - depth, createTunnelAcousticState());
      expect(entry).toEqual(exit);
    }
  });
  it('keeps weights normalized and all wet/dry/predelay values bounded', () => {
    const road = roadFixture(9), out = createTunnelAcousticState();
    for (let s = 150; s < 1400; s += .7) {
      sampleTunnelAcoustics(road, s, out);
      expect(out.shortWeight + out.mediumWeight + out.longWeight).toBeCloseTo(1);
      expect(out.wet).toBeGreaterThanOrEqual(0); expect(out.wet).toBeLessThanOrEqual(.35);
      expect(out.dry).toBeGreaterThanOrEqual(.925); expect(out.dry).toBeLessThanOrEqual(1);
      expect(out.predelay).toBeGreaterThanOrEqual(.007); expect(out.predelay).toBeLessThanOrEqual(.019);
    }
  });
});

describe('deterministic damped tunnel impulses', () => {
  it.each(TUNNEL_IR_PROFILES)('has stereo decorrelation, finite normalized energy and no direct signal ($duration s)', profile => {
    const sr = 24000, n = Math.ceil(sr * profile.duration);
    const left = new Float32Array(n), right = new Float32Array(n), repeat = new Float32Array(n);
    fillTunnelImpulse(left, right, sr, profile);
    fillTunnelImpulse(repeat, new Float32Array(n), sr, profile);
    expect(left).toEqual(repeat); expect(left).not.toEqual(right);
    expect(left.every(Number.isFinite)).toBe(true); expect(right.every(Number.isFinite)).toBe(true);
    expect(energy(left)).toBeCloseTo(.64, 5); expect(energy(right)).toBeCloseTo(.64, 5);
    expect(energy(left, 0, Math.ceil(profile.predelay * sr))).toBe(0);
    expect(energy(left, Math.floor(n * .7))).toBeLessThan(energy(left, 0, Math.floor(n * .3)) * .01);
    expect(Math.max(...left.map(Math.abs))).toBeLessThan(.8);
  });
  it('retains measurably more late energy in longer-room banks', () => {
    const late = TUNNEL_IR_PROFILES.map(profile => {
      const a = new Float32Array(Math.ceil(24000 * profile.duration));
      fillTunnelImpulse(a, new Float32Array(a.length), 24000, profile);
      return energy(a, 12000);
    });
    expect(late[1]).toBeGreaterThan(late[0] * 10);
    expect(late[2]).toBeGreaterThan(late[1] * 3);
  });
  it('builds three IRs once and only automates persistent banks/filters over 1000 updates', () => {
    const nodes: { connect: ReturnType<typeof vi.fn>; gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> } }[] = [];
    const node = () => {
      const n = { connect: vi.fn(), gain: { value: 0, setTargetAtTime: vi.fn() },
        frequency: { value: 0, setTargetAtTime: vi.fn() }, Q: { value: 0 } }; nodes.push(n); return n;
    };
    const ctx = { sampleRate: 8000, currentTime: 0, createGain: vi.fn(node), createBiquadFilter: vi.fn(node),
      createConvolver: vi.fn(node), createBuffer: vi.fn((_c: number, n: number) => {
        const channels = [new Float32Array(n), new Float32Array(n)];
        return { getChannelData: (i: number) => channels[i] };
      }) };
    const room = new TunnelAcoustics(ctx as unknown as AudioContext, {} as AudioNode), count = nodes.length;
    for (let i = 0; i < 1000; i++) room.update(roadFixture(), 250 + i * .7, i / 60);
    expect(nodes).toHaveLength(count); expect(ctx.createConvolver).toHaveBeenCalledTimes(3);
    expect(ctx.createBuffer).toHaveBeenCalledTimes(3);
    expect(nodes.some(n => n.gain.setTargetAtTime.mock.calls.length === 1000)).toBe(true);
  });
});
