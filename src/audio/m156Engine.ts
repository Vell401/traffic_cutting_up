import manifest from '../../public/audio/w204/manifest.json';
import { clamp } from '../core/math';
import { rpmBlend } from './porscheEngine';

export const W204_AUDIO_CLIPS = manifest.clips;
export const W204_AUDIO_BANKS = manifest.banks;
let pending: Promise<ArrayBuffer[]> | undefined;
const decoded = new WeakMap<AudioContext, Promise<AudioBuffer[]>>();

/** Four concurrent requests, one per unique original WAV. Retry after failure. */
export function preloadW204Audio(): Promise<ArrayBuffer[]> {
  return pending ??= (async () => {
    const results = new Array<ArrayBuffer>(W204_AUDIO_CLIPS.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= results.length) return;
        const response = await fetch(`/audio/w204/${W204_AUDIO_CLIPS[i].file}`);
        if (!response.ok) throw new Error(`M156 sound: ${response.status}`);
        results[i] = await response.arrayBuffer();
      }
    }));
    return results;
  })().catch(error => { pending = undefined; throw error; });
}

function buffersFor(ctx: AudioContext): Promise<AudioBuffer[]> {
  let task = decoded.get(ctx);
  if (!task) {
    task = preloadW204Audio().then(data => Promise.all(data.map(b => ctx.decodeAudioData(b.slice(0)))))
      .catch(error => { decoded.delete(ctx); throw error; });
    decoded.set(ctx, task);
  }
  return task;
}

/** Source load-mix bounds and linear amplitude gains. Identical lists are correlated:
 * use a linear blend, not equal-power summation (+3 dB at half load). */
export function m156LoadGain(bank: typeof W204_AUDIO_BANKS[number], throttle: number): number {
  const c = bank.config;
  const mix = c.minLoadMix + clamp(throttle, 0, 1) * (c.maxLoadMix - c.minLoadMix);
  return 10 ** (c.mainGain / 20) * ((1 - mix) * c.offLoadGain + mix * c.onLoadGain);
}

interface Voice { source: AudioBufferSourceNode; gain: GainNode; last: number }
export class M156EngineSound {
  ready = false;
  private disposed = false;
  private buffers: AudioBuffer[] = [];
  private readonly output: GainNode;
  private readonly send: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly channels: BiquadFilterNode[];
  private readonly shelves: BiquadFilterNode[] = [];
  private readonly voices = new Map<number, Voice>();
  private readonly weights = new Float32Array(W204_AUDIO_CLIPS.length);
  private readonly rpms = W204_AUDIO_BANKS.map(b => b.off.map(i => W204_AUDIO_CLIPS[i].rpm));

  constructor(private readonly ctx: AudioContext, bus: { dry: GainNode; send: GainNode }) {
    this.output = ctx.createGain(); this.output.gain.value = 0;
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
    this.filter.Q.value = .45; this.filter.frequency.value = 13500;
    this.filter.connect(this.output); this.output.connect(bus.dry);
    this.send = ctx.createGain(); this.send.gain.value = .5;
    this.output.connect(this.send); this.send.connect(bus.send);
    this.channels = W204_AUDIO_BANKS.map(bank => {
      const low = ctx.createBiquadFilter(), high = ctx.createBiquadFilter();
      low.type = 'lowshelf'; low.frequency.value = bank.config.lowShelfFreq; low.gain.value = bank.config.lowShelfGain;
      high.type = 'highshelf'; high.frequency.value = bank.config.highShelfFreq; high.gain.value = bank.config.highShelfGain;
      low.connect(high); high.connect(this.filter);
      this.shelves.push(low, high);
      return low;
    });
    void buffersFor(ctx).then(buffers => {
      if (!this.disposed) { this.buffers = buffers; this.ready = true; }
    }).catch(error => console.warn('M156 recordings unavailable; using the fallback engine.', error));
  }

  update(rpm: number, throttle: number, shift: boolean, active: boolean, cockpit: boolean): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    rpm = Math.max(1, Number.isFinite(rpm) ? rpm : 658);
    throttle = Number.isFinite(throttle) ? clamp(throttle, 0, 1) : 0;
    this.output.gain.setTargetAtTime(active && this.ready ? (shift ? .22 : 1) : 0, now, .025);
    this.filter.frequency.setTargetAtTime(cockpit ? 6200 : 13500, now, .12);
    if (!this.ready) return;
    this.weights.fill(0);
    if (active) W204_AUDIO_BANKS.forEach((bank, b) => {
      const blend = rpmBlend(this.rpms[b], rpm);
      const gain = m156LoadGain(bank, throttle) * (cockpit && b === 1 ? .5 : 1);
      // Source off/on banks are identical; both references intentionally share one voice.
      this.weights[bank.off[blend.low]] += blend.a * gain;
      this.weights[bank.off[blend.high]] += blend.b * gain;
    });
    for (let i = 0; i < this.weights.length; i++) {
      const weight = this.weights[i];
      let voice = this.voices.get(i);
      const rate = clamp(rpm / W204_AUDIO_CLIPS[i].rpm, .25, 4);
      if (!voice && weight > .0001) {
        const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
        source.buffer = this.buffers[i]; source.loop = true; source.playbackRate.value = rate;
        gain.gain.value = 0; source.connect(gain);
        gain.connect(this.channels[W204_AUDIO_CLIPS[i].channel === 'engine' ? 0 : 1]);
        source.start(now, (now * rate) % source.buffer.duration);
        voice = { source, gain, last: now }; this.voices.set(i, voice);
      }
      if (!voice) continue;
      voice.gain.gain.setTargetAtTime(weight, now, .035);
      voice.source.playbackRate.setTargetAtTime(rate, now, .018);
      if (weight > .0001) voice.last = now;
      else if (now - voice.last > .3) {
        voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); this.voices.delete(i);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.ready = false;
    for (const { source, gain } of this.voices.values()) { source.stop(); source.disconnect(); gain.disconnect(); }
    this.voices.clear(); this.buffers = [];
    // Disconnect downstream shelf nodes as well as their inputs.
    for (const node of this.shelves) node.disconnect();
    this.filter.disconnect(); this.output.disconnect(); this.send.disconnect();
  }
}
