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

/**
 * Grading baked into a 3D LUT (applied in sRGB after tone mapping): teal shadows, warm highlights,
 * a gentle S-curve and a little extra saturation — the sodium-and-neon night look.
 */
function makeGradeLUT(size = 32): LookupTexture {
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
        R += sh * -0.018 + hi * 0.03;
        G += sh * 0.008 + hi * 0.008;
        B += sh * 0.034 + hi * -0.03;
        R = R + (smoothstep(R) - R) * 0.22;
        G = G + (smoothstep(G) - G) * 0.22;
        B = B + (smoothstep(B) - B) * 0.22;
        const l2 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const i = (r + g * size + b * size * size) * 4;
        data[i] = clamp(l2 + (R - l2) * 1.12, 0, 1);
        data[i + 1] = clamp(l2 + (G - l2) * 1.12, 0, 1);
        data[i + 2] = clamp(l2 + (B - l2) * 1.12, 0, 1);
        data[i + 3] = 1;
      }
    }
  }
  const lut = new LookupTexture(data, size);
  lut.name = 'night-grade';
  return lut;
}

/**
 * HDR post chain: scene → (chromatic aberration, only when moving fast) → bloom + ACES tone mapping
 * + grading LUT + vignette in one merged pass. Bloom only picks up what is genuinely brighter than
 * white (lamp heads, head/tail lights, lit windows), so lit asphalt never smears.
 */
export class Post {
  readonly composer: EffectComposer;
  private readonly caPass: EffectPass;
  private readonly ca: ChromaticAberrationEffect;
  private kick = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    renderer.toneMapping = THREE.NoToneMapping;
    const samples = Math.min(4, renderer.capabilities.maxSamples);
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
      // Above white only: lit paint and the white cargo boxes in our headlights must not bloom.
      luminanceThreshold: 1.25,
      luminanceSmoothing: 0.2,
      intensity: 0.85,
      radius: 0.62,
      levels: 6,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const grade = new LUT3DEffect(makeGradeLUT());
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.5 });
    this.composer.addPass(new EffectPass(camera, bloom, tone, grade, vignette));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  /** Short fringe pulse on near misses and hits. */
  pulse(amount: number): void {
    this.kick = Math.max(this.kick, amount);
  }

  render(dt: number, kmh: number): void {
    this.kick = Math.max(0, this.kick - dt * 2.5);
    const speed = smoothstep((kmh - 160) / 160);
    const amount = speed * speed * 0.0016 + this.kick * 0.004;
    this.caPass.enabled = amount > 0.00015;
    this.ca.offset.set(amount, amount * 0.55);
    this.composer.render(dt);
  }
}
