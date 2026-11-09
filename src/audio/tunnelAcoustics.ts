import { ROAD_HALF } from '../config';
import { clamp, smoothstep } from '../core/math';
import { CHUNK_LEN, type RoadChunk } from '../sim/road';

type AcousticChunk = Readonly<Pick<RoadChunk, 's0' | 'kind' | 'prevKind' | 'nextKind' | 'sectionIndex' | 'sectionLen' | 'void'>>;
export interface AcousticRoad { chunkAt(s: number): AcousticChunk }

export interface TunnelAcousticState {
  blend: number;
  /** Signed nearest portal distance: positive inside, negative outside. */
  depth: number;
  length: number;
  wet: number;
  dry: number;
  dampingHz: number;
  /** Effective bank-weighted predelay/RT60, not a variable-delay node. */
  predelay: number;
  decay: number;
  shortWeight: number;
  mediumWeight: number;
  longWeight: number;
}

export function createTunnelAcousticState(): TunnelAcousticState {
  return { blend: 0, depth: 0, length: 0, wet: 0, dry: 1, dampingHz: 6200,
    predelay: .007, decay: .5, shortWeight: 1, mediumWeight: 0, longWeight: 0 };
}

/** Geometry-only sampler. Reads existing chunks; does not plan/generate/mutate the road. */
export function sampleTunnelAcoustics(road: AcousticRoad, s: number, out: TunnelAcousticState): TunnelAcousticState {
  const c = road.chunkAt(s), local = clamp(s - c.s0, 0, CHUNK_LEN);
  let depth = -1000, length = 0;
  if (!c.void && c.kind === 'tunnel') {
    length = Math.max(1, c.sectionLen) * CHUNK_LEN;
    const along = c.sectionIndex * CHUNK_LEN + local;
    depth = Math.min(along, length - along);
  } else if (!c.void) {
    if (c.prevKind === 'tunnel') {
      depth = -local;
      length = road.chunkAt(c.s0 - .01).sectionLen * CHUNK_LEN;
    }
    if (c.nextKind === 'tunnel' && -(CHUNK_LEN - local) > depth) {
      depth = -(CHUNK_LEN - local);
      length = road.chunkAt(c.s0 + CHUNK_LEN + .01).sectionLen * CHUNK_LEN;
    }
  }
  // Same curve either side of either portal: no binary switch at a chunk boundary.
  const blend = smoothstep((depth + 24) / 64);
  const enclosure = smoothstep(Math.max(0, depth) / 120);
  const size = smoothstep((length - 200) / 800);
  const response = enclosure * (.35 + .65 * size);
  out.shortWeight = 1 - smoothstep(response * 2);
  out.longWeight = smoothstep((response - .5) * 2);
  out.mediumWeight = 1 - out.shortWeight - out.longWeight;
  out.blend = blend; out.depth = depth || 0; out.length = length;
  out.wet = blend * (.23 + .12 * response);
  out.dry = 1 - blend * .075;
  out.dampingHz = 6200 - 3300 * response;
  out.predelay = .007 * out.shortWeight + .012 * out.mediumWeight + .019 * out.longWeight;
  out.decay = .5 * out.shortWeight + 1.15 * out.mediumWeight + 2.05 * out.longWeight;
  return out;
}

export const TUNNEL_IR_PROFILES = [
  { duration: .75, decay: .5, predelay: .007, seed: 0x19f1 },
  { duration: 1.5, decay: 1.15, predelay: .012, seed: 0x32a7 },
  { duration: 2.6, decay: 2.05, predelay: .019, seed: 0x56c3 },
] as const;
export type TunnelIRProfile = typeof TUNNEL_IR_PROFILES[number];

/** Deterministic stereo IR writer, run only at graph construction. Energy is .64 per channel.
 * Diffuse, frequency-damped tail plus ceiling/wall image-path reflection clusters; no direct tap.
 */
export function fillTunnelImpulse(left: Float32Array, right: Float32Array, sampleRate: number, profile: TunnelIRProfile): void {
  for (let ch = 0; ch < 2; ch++) {
    const data = ch === 0 ? left : right;
    data.fill(0);
    let seed = (profile.seed + ch * 0x7183) >>> 0, low = 0;
    const onset = Math.ceil(profile.predelay * sampleRate);
    const attackStep = Math.exp(-1 / (sampleRate * .018));
    const decayStep = Math.exp(-6.9078 / (sampleRate * profile.decay));
    let attack = 1, envelope = 1, alpha = 1;
    for (let i = onset; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // Block-rate damping and recursive envelopes avoid >1M transcendental calls at unlock.
      if ((i - onset) % 32 === 0) {
        const t = (i - onset) / sampleRate;
        const cutoff = Math.min(sampleRate * .4, 4800 / (1 + t * 5));
        alpha = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
      }
      low += (((seed / 0x100000000) * 2 - 1) - low) * alpha;
      data[i] = low * .13 * (1 - attack) * envelope
        * smoothstep((data.length - i) / (sampleRate * .06));
      attack *= attackStep; envelope *= decayStep;
    }
    // Paths approximate a 6.9 m roof and the rendered road width. Small clusters avoid isolated clicks.
    for (let tap = 0; tap < 6; tap++) {
      const path = tap % 2 === 0 ? 13.8 * (1 + tap * .5) : (2 * ROAD_HALF + .4) * (1 + (tap - 1) * .33);
      const time = profile.predelay + path / 343 + ch * (.0013 + tap * .0004);
      const at = Math.floor(time * sampleRate), amplitude = .24 * .69 ** tap;
      for (let j = 0; j < Math.max(1, Math.floor(sampleRate * .0018)); j++) {
        if (at + j < data.length) data[at + j] += amplitude * Math.exp(-j / Math.max(1, sampleRate * .0005));
      }
    }
    let energy = 0;
    for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
    const scale = energy > 0 ? .8 / Math.sqrt(energy) : 0;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}

/** Three fixed IRs crossfade with depth/length; never swaps or rebuilds a convolver in update(). */
export class TunnelAcoustics {
  readonly input: GainNode;
  readonly state = createTunnelAcousticState();
  private readonly damping: BiquadFilterNode;
  private readonly banks: GainNode[] = [];

  constructor(private readonly ctx: BaseAudioContext, output: AudioNode) {
    this.input = ctx.createGain();
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 100; high.Q.value = .6;
    this.damping = ctx.createBiquadFilter(); this.damping.type = 'lowpass';
    this.damping.frequency.value = 6200; this.damping.Q.value = .6;
    this.input.connect(high); high.connect(this.damping);
    for (const profile of TUNNEL_IR_PROFILES) {
      const verb = ctx.createConvolver(); verb.normalize = false;
      const buffer = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * profile.duration), ctx.sampleRate);
      fillTunnelImpulse(buffer.getChannelData(0), buffer.getChannelData(1), ctx.sampleRate, profile);
      verb.buffer = buffer;
      const gain = ctx.createGain(); gain.gain.value = this.banks.length === 0 ? 1 : 0;
      this.damping.connect(verb); verb.connect(gain); gain.connect(output); this.banks.push(gain);
    }
  }

  update(road: AcousticRoad, s: number, now = this.ctx.currentTime): TunnelAcousticState {
    const state = sampleTunnelAcoustics(road, s, this.state);
    this.banks[0].gain.setTargetAtTime(state.shortWeight, now, .18);
    this.banks[1].gain.setTargetAtTime(state.mediumWeight, now, .18);
    this.banks[2].gain.setTargetAtTime(state.longWeight, now, .18);
    this.damping.frequency.setTargetAtTime(state.dampingHz, now, .2);
    return state;
  }
}
