import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  LUT3DEffect,
  LookupTexture,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/math';
import type { QualityPreset } from '../settings';
import type { MapTheme } from './miami';

/**
 * Grading baked into a 3D LUT (applied in sRGB after tone mapping): teal shadows, warm highlights,
 * a gentle S-curve and a little extra saturation — the sodium-and-neon night look.
 */
function makeGradeLUT(size = 32, coastal = false): LookupTexture {
  const data = new Float32Array(size ** 3 * 4);
  const k = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r * k;
        let G = g * k;
        let B = b * k;
        const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const sh = 1 - smoothstep(l / 0.5);
        const hi = smoothstep((l - 0.45) / 0.55);
        R += sh * (coastal ? -0.005 : -0.018) + hi * (coastal ? 0.012 : 0.03);
        G += sh * 0.008 + hi * 0.008;
        B += sh * (coastal ? 0.012 : 0.034) + hi * (coastal ? -0.012 : -0.03);
        R = R + (smoothstep(R) - R) * 0.22;
        G = G + (smoothstep(G) - G) * 0.22;
        B = B + (smoothstep(B) - B) * 0.22;
        const l2 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const i = (r + g * size + b * size * size) * 4;
        const saturation = coastal ? 1.04 : 1.12;
        data[i] = clamp(l2 + (R - l2) * saturation, 0, 1);
        data[i + 1] = clamp(l2 + (G - l2) * saturation, 0, 1);
        data[i + 2] = clamp(l2 + (B - l2) * saturation, 0, 1);
        data[i + 3] = 1;
      }
    }
  }
  const lut = new LookupTexture(data, size);
  lut.name = 'night-grade';
  return lut;
}

/**
 * HDR post chain: scene → optional score/speed or impact aberration → bloom + ACES tone mapping
 * + grading LUT + vignette in one merged pass. Bloom only picks up what is genuinely brighter than
 * white (lamp heads, head/tail lights, lit windows), so lit asphalt never smears.
 */
export class Post {
  readonly composer: EffectComposer;
  private readonly caPass: EffectPass;
  private readonly ca: ChromaticAberrationEffect;
  private kick = 0;
  private scoreKick = 0;
  private scoreDistortion = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualityPreset, theme: MapTheme = 'highway') {
    renderer.toneMapping = THREE.NoToneMapping;
    const samples = Math.min(q.msaa, renderer.capabilities.maxSamples);
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: samples });
    this.composer.addPass(new RenderPass(scene, camera));

    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0, 0),
      radialModulation: true,
      modulationOffset: 0.3,
    });
    this.caPass = new EffectPass(camera, this.ca);
    this.caPass.enabled = false;
    this.composer.addPass(this.caPass);

    const bloom = new BloomEffect({
      mipmapBlur: true,
      // Above white only: lit paint and the white cargo boxes in our headlights must not bloom. Kept
      // gentle (was threshold 1.25, intensity 0.85): close lamps and tail lights used to dazzle.
      luminanceThreshold: 1.45,
      luminanceSmoothing: 0.25,
      intensity: theme === 'miami' ? 0.32 : 0.6,
      radius: 0.55,
      levels: q.bloomLevels,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const grade = new LUT3DEffect(makeGradeLUT(32, theme === 'miami'));
    const vignette = new VignetteEffect({ offset: 0.3, darkness: theme === 'miami' ? 0.35 : 0.5 });
    this.composer.addPass(new EffectPass(camera, bloom, tone, grade, vignette));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  /** Impact fringe pulse, independent of the optional score/speed effect. */
  pulse(amount: number): void {
    this.kick = Math.max(this.kick, amount);
  }

  /** Optional score/speed effect, 0..1. Impact feedback remains independent. */
  setScoreDistortion(level: number): void {
    this.scoreDistortion = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
    if (this.scoreDistortion === 0) this.scoreKick = 0;
  }

  scorePulse(amount: number): void {
    if (this.scoreDistortion > 0) this.scoreKick = Math.max(this.scoreKick, amount);
  }

  render(dt: number, kmh: number): void {
    this.kick = Math.max(0, this.kick - dt * 2.5);
    this.scoreKick = Math.max(0, this.scoreKick - dt * 2.5);
    const speed = smoothstep((kmh - 160) / 160);
    const amount = (speed * speed * 0.0016 + this.scoreKick * 0.004) * this.scoreDistortion + this.kick * 0.004;
    this.caPass.enabled = amount > 0.00015;
    this.ca.offset.set(amount, amount * 0.55);
    this.composer.render(dt);
  }
}
