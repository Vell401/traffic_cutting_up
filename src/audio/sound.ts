import { G, clamp, smoothstep } from '../core/math';
import { ROAD_HALF } from '../config';
import type { Sim } from '../sim/world';

/*
 * All sound is synthesised with Web Audio: no samples to download.
 *
 *   engine, turbo, pops        ── engine bus ─┐    ┌─ dry ──────────────┐
 *   wind, roar, squeal, strips,               ├────┤                    ├─ master ─ compressor ─ out
 *   scrape, traffic, pass-bys  ── world bus  ─┤    │                    │
 *   chimes, impacts, relay     ── fx bus     ─┘    └─ send ─ convolver ─ wet (tunnels only)
 *
 * Each bus has a dry and a reverb-send gain set from the mixer. Continuous voices are tuned every
 * frame from the sim with short setTargetAtTime ramps (no zipper noise); one-shots (pops, whooshes,
 * chimes, crashes) are built per event.
 */

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];
const semi = (base: number, n: number) => base * 2 ** (n / 12);
const MUTE_KEY = 'tcu.muted';
const MIX_KEY = 'tcu.mix';

/** Mixer channels: the master level and the three buses. */
export type Channel = 'master' | 'engine' | 'world' | 'fx';
export const CHANNELS: readonly { id: Channel; name: string }[] = [
  { id: 'master', name: 'Общая' },
  { id: 'engine', name: 'Мотор' },
  { id: 'world', name: 'Дорога' },
  { id: 'fx', name: 'Эффекты' },
];
type Bus = Exclude<Channel, 'master'>;
/** Master at 100 % is this gain (headroom for the compressor). */
const MASTER_GAIN = 0.8;

function loadMix(): Record<Channel, number> {
  const mix: Record<Channel, number> = { master: 1, engine: 1, world: 1, fx: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}') as Partial<Record<Channel, unknown>>;
    for (const { id } of CHANNELS) {
      const v = Number(saved[id]);
      if (saved[id] !== undefined && Number.isFinite(v)) mix[id] = clamp(v, 0, 1);
    }
  } catch {
    /* defaults */
  }
  return mix;
}

/*
 * Inline four (physics №3, the AMG): one engine cycle (two revolutions) holds four firing pulses. The
 * wave runs at the cycle frequency; the 4th harmonic is the firing order, the others are the small
 * cylinder-to-cylinder differences that give a four its gravel. Fixed pseudo-random phases make the
 * pulse lopsided like a real exhaust pressure trace instead of a smooth tone.
 */
const I4_HARMONICS = [0, 0.16, 0.3, 0.12, 1, 0.15, 0.26, 0.1, 0.62, 0.08, 0.13, 0.06, 0.36, 0.05, 0.08, 0.04, 0.22, 0.03, 0.05, 0.03, 0.14, 0.02, 0.03, 0.02, 0.09];

interface Voice {
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private send!: GainNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private bus!: Record<Bus, { dry: GainNode; send: GainNode }>;
  private readonly mix = loadMix();

  // Inline-four voice (physics №3).
  private i4Osc!: OscillatorNode;
  private i4Fire!: OscillatorNode;
  private i4Drive!: GainNode;
  private i4Low!: BiquadFilterNode;
  private i4Gain!: GainNode;
  private i4Rasp!: GainNode;
  private i4RaspDepth!: GainNode;
  /** Overrun crackle left after a lift, s. */
  private burble = 0;
  private burbleT = 0;

  private o1!: OscillatorNode;
  private o2!: OscillatorNode;
  private intake!: Voice;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private turboOsc!: OscillatorNode;
  private turboGain!: GainNode;
  private wind!: Voice;
  private roar!: Voice;
  private squeal!: Voice;
  private scrape!: Voice;
  private hum!: Voice;
  private rumbleOsc!: OscillatorNode;
  private rumbleGain!: GainNode;

  private muted: boolean;
  private paused = false;
  private t = 0;
  private load = 0;
  private boost = 0;
  private prevThrottle = 0;
  private prevGear = 1;
  private shiftDip = 0;
  private popsLeft = 0;
  private popT = 0;

  constructor(private readonly sim: Sim) {
    let m = false;
    try {
      m = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* default: sound on */
    }
    this.muted = m;

    const ev = sim.events;
    ev.on('passBy', (e) => this.whoosh(e.side, clamp(1.4 - e.gap / 2, 0.25, 1.2) * clamp(e.relSpeed / 30, 0.4, 1.2), e.truck));
    ev.on('nearMiss', (e) => this.chime(Math.min(e.combo - 1, PENTA.length - 1), e.gap < 0.3 ? 0.16 : 0.12));
    ev.on('laneSplit', (e) => {
      const n = Math.min(e.combo, PENTA.length - 3);
      this.chime(n, 0.12);
      this.chime(n + 2, 0.1, 0.07);
    });
    ev.on('comboEnd', (e) => (e.reason === 'wall' ? this.buzz() : this.notes([7, 0], 392, 0.07, 0.11)));
    ev.on('wallHit', (e) => this.thump(clamp(0.25 + e.speed * 0.06, 0.25, 0.8)));
    ev.on('bump', (e) => this.thump(clamp(0.3 + e.speed * 0.08, 0.3, 0.9)));
    ev.on('crash', (e) => this.crash(clamp(0.5 + e.speed * 0.03, 0.5, 1)));
    ev.on('runEnd', (e) => {
      if (e.score <= 0) return;
      if (e.newBest) this.notes([0, 4, 7, 12, 16], 659, 0.09, 0.12);
      else this.notes([0, -3, -7], 523, 0.14, 0.12);
    });
    ev.on('trafficMode', (e) => {
      if (e.label) this.notes([0, 7], 1047, 0.06, 0.05);
    });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** For the F1 overlay. */
  get state(): string {
    if (!this.ctx) return 'locked (press a key)';
    return this.muted ? 'muted' : this.ctx.state;
  }

  /** Browsers only allow audio after a user gesture: call from key/click handlers. */
  unlock(): void {
    if (!this.ctx) this.build();
    else if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* not persisted */
    }
    this.applyMaster();
    return this.muted;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyMaster();
  }

  /** Mixer level of a channel, 0..1. */
  level(ch: Channel): number {
    return this.mix[ch];
  }

  setLevel(ch: Channel, v: number): void {
    this.mix[ch] = clamp(v, 0, 1);
    try {
      localStorage.setItem(MIX_KEY, JSON.stringify(this.mix));
    } catch {
      /* not persisted */
    }
    if (ch === 'master') this.applyMaster();
    else if (this.ctx) {
      const now = this.ctx.currentTime;
      this.bus[ch].dry.gain.setTargetAtTime(this.mix[ch], now, 0.03);
      this.bus[ch].send.gain.setTargetAtTime(this.mix[ch], now, 0.03);
    }
  }

  private applyMaster(): void {
    if (!this.ctx) return;
    const v = this.muted || this.paused ? 0 : this.mix.master * MASTER_GAIN;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- graph

  private build(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = this.gainNode(0, comp);
    this.applyMaster();
    this.dry = this.gainNode(1, this.master);
    this.wet = this.gainNode(0, this.master);
    const verb = ctx.createConvolver();
    verb.buffer = this.makeTunnelIR();
    verb.connect(this.wet);
    this.send = this.gainNode(1, verb);
    const bus = (b: Bus) => ({ dry: this.gainNode(this.mix[b], this.dry), send: this.gainNode(this.mix[b], this.send) });
    this.bus = { engine: bus('engine'), world: bus('world'), fx: bus('fx') };
    const E = this.bus.engine;
    const W = this.bus.world;

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Engine: one warm voice at the firing frequency (harmonics falling off fast, no saw/square buzz,
    // no detuned layer — that beat against the harmonics as a "wah-wah"), a sine half-order sub for
    // the lope, a little intake noise, gentle saturation and a dark low-pass.
    this.engGain = this.gainNode(0, E.dry);
    this.gainNode(0.5, E.send, this.engGain);
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 0.7;
    this.engFilter.connect(this.engGain);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.softClip(1.3);
    shaper.oversample = '2x';
    shaper.connect(this.engFilter);
    const mix = this.gainNode(1, shaper);
    const harmonics = [0, 1, 0.55, 0.3, 0.2, 0.11, 0.07, 0.04, 0.025];
    const wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
    this.o1 = this.osc('sine', this.gainNode(0.5, mix));
    this.o1.setPeriodicWave(wave);
    this.o2 = this.osc('sine', this.gainNode(0.32, mix));
    this.intake = this.noiseVoice('bandpass', 400, 0.7, mix);

    this.turboGain = this.gainNode(0, E.dry);
    this.turboOsc = this.osc('sine', this.turboGain);

    this.buildInlineFour(E);

    this.wind = this.noiseVoice('lowpass', 400, 0.5, W.dry);
    this.roar = this.noiseVoice('lowpass', 480, 0.7, W.dry);
    this.squeal = this.noiseVoice('bandpass', 900, 3, W.dry);
    // Barrier contact: a low, soft grind rather than a hiss.
    this.scrape = this.noiseVoice('bandpass', 420, 0.8, W.dry);
    this.hum = this.noiseVoice('lowpass', 170, 0.7, W.dry);
    this.gainNode(0.6, W.send, this.roar.gain);

    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 170;
    this.rumbleGain = this.gainNode(0, W.dry);
    rumbleFilter.connect(this.rumbleGain);
    this.rumbleOsc = this.osc('triangle', rumbleFilter);
  }

  /**
   * Inline-four voice: the lopsided cycle wave driven into a soft clipper (harder on load), an exhaust
   * body resonance and a mid bark, plus exhaust rasp (band-passed noise chopped by the firing pulses),
   * all under one low-pass that opens with revs and load.
   */
  private buildInlineFour(E: { dry: GainNode; send: GainNode }): void {
    const ctx = this.ctx!;
    this.i4Gain = this.gainNode(0, E.dry);
    this.gainNode(0.35, E.send, this.i4Gain);
    this.i4Low = ctx.createBiquadFilter();
    this.i4Low.type = 'lowpass';
    this.i4Low.Q.value = 0.9;
    this.i4Low.connect(this.i4Gain);
    const bark = ctx.createBiquadFilter();
    bark.type = 'peaking';
    bark.frequency.value = 560;
    bark.Q.value = 1.1;
    bark.gain.value = 5;
    bark.connect(this.i4Low);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 135;
    body.Q.value = 0.8;
    body.gain.value = 6;
    body.connect(bark);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.softClip(2.4);
    shaper.oversample = '4x';
    shaper.connect(body);
    this.i4Drive = this.gainNode(0.6, shaper);

    const n = I4_HARMONICS.length;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      const phase = (((k * 2654435761) % 1000) / 1000) * Math.PI * 2;
      re[k] = I4_HARMONICS[k] * Math.cos(phase);
      im[k] = I4_HARMONICS[k] * Math.sin(phase);
    }
    this.i4Osc = this.osc('sine', this.gainNode(0.55, this.i4Drive));
    this.i4Osc.setPeriodicWave(ctx.createPeriodicWave(re, im));

    // Rasp: noise whose level is pulsed at the firing frequency (gain = base + depth * pulse).
    const raspBand = ctx.createBiquadFilter();
    raspBand.type = 'bandpass';
    raspBand.frequency.value = 1700;
    raspBand.Q.value = 0.7;
    this.i4Rasp = this.gainNode(0, this.i4Low);
    raspBand.connect(this.i4Rasp);
    const src = this.noiseSource(true);
    src.connect(raspBand);
    src.start(0, Math.random() * 2);
    const pulse = new Float32Array([0, 1, 0.8, 0.55, 0.35, 0.2, 0.1]);
    this.i4RaspDepth = ctx.createGain();
    this.i4RaspDepth.gain.value = 0;
    this.i4RaspDepth.connect(this.i4Rasp.gain);
    this.i4Fire = this.osc('sine', this.i4RaspDepth);
    this.i4Fire.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(pulse.length), pulse));
  }

  private gainNode(value: number, to: AudioNode, from?: AudioNode): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = value;
    g.connect(to);
    from?.connect(g);
    return g;
  }

  private osc(type: OscillatorType, to: AudioNode): OscillatorNode {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.value = 40;
    o.connect(to);
    o.start();
    return o;
  }

  private noiseSource(loop: boolean): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    return src;
  }

  private noiseVoice(type: BiquadFilterType, freq: number, q: number, to: AudioNode): Voice {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.gainNode(0, to);
    filter.connect(gain);
    const src = this.noiseSource(true);
    src.connect(filter);
    src.start(0, Math.random() * 2);
    return { gain, filter };
  }

  private softClip(drive: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  /** Concrete tube: dense decaying noise plus a few flutter taps off the walls. */
  private makeTunnelIR(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 1.8);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * 0.6;
      for (const [ms, g] of [[19, 0.7], [37, 0.5], [58, 0.35], [83, 0.25]]) {
        const at = Math.floor(((ms + ch * 3) / 1000) * sr);
        d[at] += g;
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || this.paused || dt <= 0) return;
    this.t += dt;
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.03) => p.setTargetAtTime(v, now, tc);
    const sim = this.sim;
    const p = sim.player;
    const t = p.tune;
    const v = Math.max(0, p.vAlong);
    const rpmN = clamp(p.rpm / t.redline, 0, 1.05);

    // Physics №3 is the AMG's turbo inline four; №1 and №2 keep the six and the V8 voice.
    const four = p.physicsId === 3;

    // Engine.
    this.load += (p.throttle - this.load) * Math.min(1, dt * 10);
    // Firing frequency: three pulses per revolution for the straight six, four for the V8 (physics №2).
    const f = (p.rpm / 60) * (p.physicsId === 2 ? 4 : 3);
    set(this.o1.frequency, f, 0.02);
    set(this.o2.frequency, f * 0.5, 0.02);
    set(this.intake.filter.frequency, f * 3);
    set(this.intake.gain.gain, 0.02 + this.load * 0.1 * rpmN);
    set(this.engFilter.frequency, 180 + rpmN * 900 + this.load * 1100);
    if (p.gear !== this.prevGear) {
      // The AMG's upshift under load: the ignition cut fires a short blat into the exhaust.
      if (four && p.gear > this.prevGear && this.prevGear > 0 && this.load > 0.6 && rpmN > 0.5) this.blat();
      this.shiftDip = p.gear > this.prevGear ? 0.09 : 0.05;
      this.prevGear = p.gear;
    }
    let eg = 0.11 + 0.16 * this.load + 0.06 * rpmN;
    if (this.shiftDip > 0) {
      this.shiftDip -= dt;
      eg *= 0.25;
    }
    if (p.rpm >= t.redline * 0.995 && p.throttle > 0.5) eg *= Math.sin(this.t * Math.PI * 2 * 17) > 0 ? 1 : 0.35;
    if (four) {
      set(this.engGain.gain, 0, 0.05);
      this.inlineFour(set, dt, p.rpm, p.throttle, rpmN, eg);
    } else {
      set(this.i4Gain.gain, 0, 0.05);
      set(this.engGain.gain, eg, 0.015);
    }

    // Lift-off: crackle and pop on the overrun, blow-off valve if the turbo was spooled.
    if (this.prevThrottle > 0.6 && p.throttle < 0.15 && rpmN > 0.55) {
      if (four) {
        // AMG Sport+: a longer crackle while the revs fall.
        this.burble = 0.8 + 1.2 * rpmN;
        this.burbleT = 0.05;
      } else {
        this.popsLeft = 3 + Math.floor(Math.random() * 5);
        this.popT = 0.06;
      }
      if (this.boost > 0.4) this.blowOff(this.boost);
    }
    this.prevThrottle = p.throttle;
    if (this.popsLeft > 0) {
      this.popT -= dt;
      if (this.popT <= 0) {
        this.pop();
        this.popsLeft--;
        this.popT = 0.04 + Math.random() * 0.13;
      }
    }

    // Turbo whistle follows boost (throttle × revs).
    const boostTarget = p.throttle * smoothstep((rpmN - 0.35) / 0.5);
    this.boost += (boostTarget - this.boost) * Math.min(1, dt * (boostTarget > this.boost ? 2.5 : 6));
    set(this.turboOsc.frequency, 1400 + this.boost * 2200 + rpmN * 500);
    set(this.turboGain.gain, (four ? 0.014 : 0.008) * this.boost);

    // Speed: wind and tyre roar; louder roar in tunnels where it reverberates.
    const tunnel = sim.road.chunkAt(p.s).kind === 'tunnel';
    set(this.wind.filter.frequency, 200 + v * 22);
    set(this.wind.gain.gain, 0.32 * (v / 85) ** 2);
    set(this.roar.gain.gain, 0.1 * Math.min(1.2, v / 75) * (tunnel ? 1.5 : 1));
    set(this.wet.gain, tunnel ? 0.55 : 0, 0.25);

    // Tyres: squeal when sliding or near the grip limit, a little under hard braking.
    const beta = Math.abs(Math.atan2(p.vy, Math.max(p.vx, 1)));
    const latUse = Math.abs(p.accLat) / (t.gripFront * G);
    let sq = clamp((beta - 0.06) / 0.1, 0, 1) * 0.7 + clamp((latUse - 0.92) / 0.1, 0, 1) * 0.3;
    if (p.brake > 0.85 && v > 15) sq += 0.25;
    if (v < 5) sq = 0;
    set(this.squeal.filter.frequency, 820 + beta * 500);
    set(this.squeal.gain.gain, 0.09 * Math.min(1, sq), 0.06);

    // Rumble strips just outside the edge lines: a buzz at speed / strip spacing.
    const onStrip = Math.abs(p.d) + p.halfExtentD() > ROAD_HALF + 0.25;
    set(this.rumbleOsc.frequency, Math.max(20, v / 0.36));
    set(this.rumbleGain.gain, onStrip ? 0.12 * clamp(v / 25, 0, 1) : 0, 0.03);

    // Barrier scrape: quiet low grind with a slow wobble (no per-frame random gain — that crackled).
    const grind = 0.8 + 0.2 * Math.sin(this.t * 2 * Math.PI * 6);
    set(this.scrape.filter.frequency, 360 + v * 3);
    set(this.scrape.gain.gain, p.scrapeSide !== 0 ? 0.1 * clamp(v / 30, 0.3, 1) * grind : 0, 0.05);

    // Traffic around us: low hum, trucks louder.
    let w = 0;
    for (const c of sim.traffic.cars) {
      if (!c.active) continue;
      const ds = c.s - p.s;
      if (ds < -60 || ds > 60) continue;
      const dd = c.d - p.d;
      w += (c.spec.truck ? 1.7 : 1) / (1 + (ds * ds + dd * dd) / 80);
    }
    set(this.hum.gain.gain, 0.2 * Math.min(1, w), 0.08);
  }

  /** Inline-four voice per frame: pitch from the revs, drive, brightness and rasp from the load. */
  private inlineFour(set: (p: AudioParam, v: number, tc?: number) => void, dt: number, rpm: number, throttle: number, rpmN: number, level: number): void {
    const cycle = rpm / 120;
    const load = this.load;
    set(this.i4Osc.frequency, cycle, 0.015);
    set(this.i4Fire.frequency, cycle * 4, 0.015);
    set(this.i4Drive.gain, 0.5 + 1.9 * load * (0.4 + 0.6 * rpmN), 0.03);
    set(this.i4Low.frequency, 260 + rpmN * 2600 + load * 2400, 0.03);
    const depth = (0.03 + 0.2 * load) * (0.3 + 0.7 * rpmN);
    set(this.i4Rasp.gain, depth * 0.6, 0.03);
    set(this.i4RaspDepth.gain, depth, 0.03);
    set(this.i4Gain.gain, level * 1.15, 0.015);
    if (this.burble <= 0) return;
    this.burble -= dt;
    this.burbleT -= dt;
    if (throttle > 0.2 || rpm < 2600) this.burble = 0;
    else if (this.burbleT <= 0) {
      this.crackle(0.45 + Math.random() * 0.55);
      this.burbleT = 0.03 + Math.random() * 0.14;
    }
  }

  // ---------------------------------------------------------------- one-shots

  private env(g: GainNode, at: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  private ready(): AudioContext | null {
    return this.ctx && !this.paused && !this.muted ? this.ctx : null;
  }

  private pop(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 250 + Math.random() * 500;
    f.Q.value = 1.4;
    const g = this.gainNode(0, this.bus.engine.dry);
    this.gainNode(0.6, this.bus.engine.send, g);
    src.connect(f).connect(g);
    this.env(g, at, 0.3 + Math.random() * 0.25, 0.003, 0.07);
    src.start(at, Math.random() * 1.5, 0.12);
  }

  /** Exhaust crackle of the four on the overrun: a sharp burst over a low thud. */
  private crackle(strength: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const E = this.bus.engine;
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 1600;
    f.Q.value = 1.1;
    const g = this.gainNode(0, E.dry);
    this.gainNode(0.7, E.send, g);
    src.connect(f).connect(g);
    this.env(g, at, 0.32 * strength, 0.002, 0.05 + Math.random() * 0.04);
    src.start(at, Math.random() * 1.5, 0.12);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70 + Math.random() * 50, at);
    o.frequency.exponentialRampToValueAtTime(45, at + 0.08);
    const og = this.gainNode(0, E.dry);
    o.connect(og);
    this.env(og, at, 0.28 * strength, 0.002, 0.08);
    o.start(at);
    o.stop(at + 0.12);
  }

  /** Upshift on the throttle: the ignition cut's short, dark blat. */
  private blat(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const E = this.bus.engine;
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 520;
    f.Q.value = 0.9;
    const g = this.gainNode(0, E.dry);
    this.gainNode(0.6, E.send, g);
    src.connect(f).connect(g);
    this.env(g, at, 0.42, 0.004, 0.09);
    src.start(at, Math.random() * 1.5, 0.14);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 88;
    const og = this.gainNode(0, E.dry);
    o.connect(og);
    this.env(og, at, 0.3, 0.004, 0.1);
    o.start(at);
    o.stop(at + 0.14);
  }

  private blowOff(boost: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const src = this.noiseSource(false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1300;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3200, at);
    bp.frequency.exponentialRampToValueAtTime(1600, at + 0.4);
    const g = this.gainNode(0, this.bus.engine.dry);
    src.connect(hp).connect(bp).connect(g);
    this.env(g, at, 0.16 * boost, 0.01, 0.4);
    src.start(at, Math.random() * 1.5, 0.5);
  }

  /** Doppler-ish pass-by: band-passed noise sweeping down, panned to the passed car's side. */
  private whoosh(side: number, strength: number, truck: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const src = this.noiseSource(false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    const top = truck ? 900 : 1400;
    bp.frequency.setValueAtTime(top, at);
    bp.frequency.exponentialRampToValueAtTime(top * 0.25, at + 0.45);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(side * 0.85, -1, 1);
    const g = this.gainNode(0, this.bus.world.dry);
    this.gainNode(0.7, this.bus.world.send, g);
    src.connect(bp).connect(pan).connect(g);
    this.env(g, at, 0.28 * strength * (truck ? 1.4 : 1), 0.05, 0.5);
    src.start(at, Math.random() * 1.4, 0.6);
  }

  private chime(step: number, gain: number, delay = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime + delay;
    const f = semi(784, PENTA[Math.max(0, Math.min(step, PENTA.length - 1))]);
    for (const [type, mult, k] of [
      ['triangle', 1, 1],
      ['sine', 2, 0.35],
    ] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const g = this.gainNode(0, this.bus.fx.dry);
      o.connect(g);
      this.env(g, at, gain * k, 0.005, 0.28);
      o.start(at);
      o.stop(at + 0.35);
    }
  }

  private notes(steps: number[], base: number, spacing: number, gain: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    steps.forEach((n, i) => {
      const at = ctx.currentTime + i * spacing;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = semi(base, n);
      const g = this.gainNode(0, this.bus.fx.dry);
      o.connect(g);
      this.env(g, at, gain, 0.006, 0.22);
      o.start(at);
      o.stop(at + 0.3);
    });
  }

  private buzz(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 98;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = this.gainNode(0, this.bus.fx.dry);
    o.connect(f).connect(g);
    this.env(g, at, 0.12, 0.01, 0.22);
    o.start(at);
    o.stop(at + 0.3);
  }

  /** Turn signal relay: a click when the lamp lights, a softer one when it goes dark. */
  tick(lit: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    this.noiseHit(at, 'bandpass', lit ? 3400 : 2300, lit ? 0.05 : 0.03, 0.018);
  }

  private thump(strength: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, at);
    o.frequency.exponentialRampToValueAtTime(42, at + 0.2);
    const g = this.gainNode(0, this.bus.fx.dry);
    o.connect(g);
    this.env(g, at, 0.5 * strength, 0.004, 0.22);
    o.start(at);
    o.stop(at + 0.3);
    this.noiseHit(at, 'lowpass', 900, 0.3 * strength, 0.15);
  }

  private crash(strength: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, at);
    o.frequency.exponentialRampToValueAtTime(36, at + 0.32);
    const g = this.gainNode(0, this.bus.fx.dry);
    o.connect(g);
    this.env(g, at, 0.75 * strength, 0.004, 0.35);
    o.start(at);
    o.stop(at + 0.45);
    this.noiseHit(at, 'lowpass', 1500, 0.55 * strength, 0.5);
    this.noiseHit(at + 0.02, 'highpass', 3500, 0.22 * strength, 0.16);
  }

  private noiseHit(at: number, type: BiquadFilterType, freq: number, peak: number, decay: number): void {
    const ctx = this.ctx!;
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.gainNode(0, this.bus.fx.dry);
    this.gainNode(0.5, this.bus.fx.send, g);
    src.connect(f).connect(g);
    this.env(g, at, peak, 0.004, decay);
    src.start(at, Math.random() * 1.2, decay + 0.1);
  }
}
