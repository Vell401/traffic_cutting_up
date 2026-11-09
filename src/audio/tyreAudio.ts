import { clamp, smoothstep } from '../core/math';
import type { TyreFeedback, WheelTyreFeedback } from '../presentation/tyres';

export interface TyreAudioTargets {
  rollingGain: number; scrubGain: number; lockGain: number;
  rollingHz: number; scrubHz: number; lockHz: number;
}

export function createTyreAudioTargets(): TyreAudioTargets {
  return { rollingGain: 0, scrubGain: 0, lockGain: 0, rollingHz: 300, scrubHz: 900, lockHz: 650 };
}

/** Continuous, bounded targets. Lock texture requires observed contact slip, never brake input. */
export function sampleTyreAudio(w: Readonly<WheelTyreFeedback>, out: TyreAudioTargets): TyreAudioTargets {
  const speed = Math.hypot(w.contactLongitudinal, w.contactLateral);
  const slip = Math.hypot(w.longitudinalSlipSpeed, w.lateralSlipSpeed);
  const load = clamp(w.normalLoad / 3700, 0, 1.4);
  const lock = smoothstep((Math.abs(w.contactLongitudinal) - 1) / 5)
    * (1 - smoothstep(Math.abs(w.rollingSpeed) / Math.max(1, Math.abs(w.contactLongitudinal) * .35)))
    * smoothstep((Math.abs(w.longitudinalSlipSpeed) - .5) / 3);
  out.rollingGain = .023 * smoothstep(speed / 70) * load * (1 - .55 * w.slipIntensity);
  out.scrubGain = .055 * w.slipIntensity * Math.sqrt(Math.min(1.4, load)) * (1 - .55 * lock);
  out.lockGain = .038 * lock * w.slipIntensity * Math.min(1, load);
  out.rollingHz = clamp(260 + speed * 17, 260, 2400);
  out.scrubHz = clamp(680 + Math.sqrt(slip) * 160 + speed * 3, 680, 2100);
  out.lockHz = clamp(480 + speed * 11, 480, 1500);
  return out;
}

interface TyreVoice {
  rolling: GainNode; scrub: GainNode; lock: GainNode;
  rollingFilter: BiquadFilterNode; scrubFilter: BiquadFilterNode; lockFilter: BiquadFilterNode;
  targets: TyreAudioTargets;
}

/** Four persistent, decorrelated noise voices: broad rolling hiss, scrub/chirp and darker lock scrub. */
export class TyreAudio {
  private readonly voices: TyreVoice[] = [];

  constructor(private readonly ctx: BaseAudioContext, noise: AudioBuffer, bus: { dry: GainNode; send: GainNode }) {
    for (let i = 0; i < 4; i++) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i % 2 === 0 ? -1 : 1) * (i < 2 ? .55 : .38);
      pan.connect(bus.dry);
      const send = ctx.createGain(); send.gain.value = .48;
      pan.connect(send); send.connect(bus.send);
      const source = ctx.createBufferSource(); source.buffer = noise; source.loop = true;
      const layer = (type: BiquadFilterType, hz: number, q: number) => {
        const filter = ctx.createBiquadFilter(); filter.type = type;
        filter.frequency.value = hz; filter.Q.value = q;
        const gain = ctx.createGain(); gain.gain.value = 0;
        source.connect(filter); filter.connect(gain); gain.connect(pan);
        return { filter, gain };
      };
      const rolling = layer('lowpass', 300, .6), scrub = layer('bandpass', 900, .85), lock = layer('bandpass', 650, .6);
      this.voices.push({ rolling: rolling.gain, scrub: scrub.gain, lock: lock.gain,
        rollingFilter: rolling.filter, scrubFilter: scrub.filter, lockFilter: lock.filter, targets: createTyreAudioTargets() });
      source.start(0, (i * .417) % noise.duration);
    }
  }

  update(feedback: TyreFeedback, now = this.ctx.currentTime): void {
    for (let i = 0; i < 4; i++) {
      const v = this.voices[i], t = sampleTyreAudio(feedback.wheels[i], v.targets);
      v.rolling.gain.setTargetAtTime(t.rollingGain, now, .09);
      v.scrub.gain.setTargetAtTime(t.scrubGain, now, .045);
      v.lock.gain.setTargetAtTime(t.lockGain, now, .065);
      v.rollingFilter.frequency.setTargetAtTime(t.rollingHz, now, .1);
      v.scrubFilter.frequency.setTargetAtTime(t.scrubHz, now, .075);
      v.lockFilter.frequency.setTargetAtTime(t.lockHz, now, .08);
    }
  }
}
