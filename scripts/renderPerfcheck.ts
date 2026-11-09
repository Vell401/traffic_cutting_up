/// <reference types="node" />
/** CPU-only A/B: frozen pre-optimization update versus the current implementation. */
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { mulberry32 } from '../src/core/rng';
import { createTyreFeedback } from '../src/presentation/tyres';
import { TyreEffects, TYRE_EFFECT_BUDGET } from '../src/render/tyreEffects';

export interface EffectInternals {
  disposed: boolean;
  life: Float32Array; duration: Float32Array; power: Float32Array; seed: Float32Array;
  world: Float64Array; velocity: Float32Array; centres: Float32Array; puffs: Float32Array;
  markLife: Float32Array; markPower: Float32Array; markAlpha: Float32Array; markWorld: Float64Array;
  last: Float64Array; trail: Uint8Array; dummy: THREE.Object3D;
  mark(ax: number, az: number, bx: number, bz: number, intensity: number): void;
}
export const internals = (effects: TyreEffects) => effects as unknown as EffectInternals;

/** Keep this reference unchanged: original full update, including Three's matrix composition. */
export function referenceUpdate(effects: TyreEffects, dt: number, ox: number, oz: number): void {
  const s = internals(effects);
  if (s.disposed) return;
  dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  for (let i = 0; i < TYRE_EFFECT_BUDGET.smoke; i++) {
    const o = i * 3;
    s.life[i] = Math.max(0, s.life[i] - dt);
    if (!s.life[i]) { s.puffs[o] = s.puffs[o + 1] = 0; continue; }
    const drag = Math.exp(-dt * .65), travel = (1 - drag) / .65;
    s.world[o] += s.velocity[o] * travel; s.world[o + 2] += s.velocity[o + 2] * travel;
    s.velocity[o] *= drag; s.velocity[o + 2] *= drag;
    s.world[o + 1] += s.velocity[o + 1] * dt;
    const age = 1 - s.life[i] / s.duration[i];
    s.centres[o] = s.world[o] - ox; s.centres[o + 1] = s.world[o + 1]; s.centres[o + 2] = s.world[o + 2] - oz;
    s.puffs[o] = .28 + age * (1.45 + s.power[i] * .65);
    s.puffs[o + 1] = (.13 + s.power[i] * .15) * Math.min(1, age * 12) * (1 - age) ** 1.6;
    s.puffs[o + 2] = s.seed[i] + age * .045;
  }
  effects.smoke.geometry.getAttribute('centre').needsUpdate = true;
  effects.smoke.geometry.getAttribute('puff').needsUpdate = true;
  for (let i = 0; i < TYRE_EFFECT_BUDGET.skids; i++) {
    s.markLife[i] = Math.max(0, s.markLife[i] - dt);
    s.markAlpha[i] = s.markLife[i] ? .38 * s.markPower[i] * Math.min(1, s.markLife[i] / 6) : 0;
    if (!s.markLife[i]) continue;
    const o = i * 4, ax = s.markWorld[o], az = s.markWorld[o + 1], bx = s.markWorld[o + 2], bz = s.markWorld[o + 3];
    s.dummy.position.set((ax + bx) * .5 - ox, .018, (az + bz) * .5 - oz);
    s.dummy.rotation.set(0, Math.atan2(bx - ax, bz - az), 0);
    s.dummy.scale.set(.205, 1, Math.hypot(bx - ax, bz - az) + .035);
    s.dummy.updateMatrix(); effects.skids.setMatrixAt(i, s.dummy.matrix);
  }
  effects.skids.instanceMatrix.needsUpdate = true;
  effects.skids.geometry.getAttribute('markAlpha').needsUpdate = true;
}

export function seedMarks(effects: TyreEffects, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = 100000 + Math.sin(i * .77) * 200, z = -200000 + Math.cos(i * .31) * 300;
    internals(effects).mark(x, z, x + Math.sin(i) * .4, z + Math.cos(i) * .4, .2 + (i % 17) / 22);
  }
}

function benchmark(): void {
  const frames = 600, warmups = 3, trials = 9;
  const feedback = createTyreFeedback();
  for (const wheel of feedback.wheels) Object.assign(wheel, {
    normalLoad: 3500, smokeIntensity: 1, slipIntensity: 1, contactLongitudinal: 15,
    contactLateral: 4, longitudinalSlipSpeed: 20,
  });
  console.log(JSON.stringify({ frames, warmups, trials, node: process.version, platform: process.platform,
    note: 'CPU only; same fixed GPU budgets/uploads. Alternating A/B order; milliseconds per frame.' }));
  for (const [name, marks, emitting] of [
    ['idle', 0, false], ['384 resident skids', 384, false],
    ['1536 resident skids', 1536, false], ['1536 skids + continuous smoke/mark emission', 1536, true],
  ] as const) {
    const before: number[] = [], after: number[] = [];
    const run = (reference: boolean): number => {
      const effects = new TyreEffects(); seedMarks(effects, marks);
      // Both paths first materialize every mark, outside the measured steady-state interval.
      if (reference) referenceUpdate(effects, 0, 0, 0); else effects.update(0, 0, 0);
      let frame = 0;
      const contact = (i: number, out: THREE.Vector3) => out.set(100000 + (i % 2) * 1.6, .018, -200000 - frame * .3 + (i < 2 ? -1.3 : 1.3));
      const random = Math.random;
      Math.random = mulberry32(1776);
      const start = performance.now();
      try {
        for (; frame < frames; frame++) {
          if (emitting) effects.emit(1 / 60, feedback, contact, frame * .01, .2, 0, 0);
          const ox = frame * .25, oz = -frame * .5;
          if (reference) referenceUpdate(effects, 1 / 60, ox, oz); else effects.update(1 / 60, ox, oz);
        }
        return (performance.now() - start) / frames;
      } finally {
        Math.random = random; effects.dispose();
      }
    };
    for (let trial = -warmups; trial < trials; trial++) {
      for (const reference of trial % 2 ? [false, true] : [true, false]) {
        const elapsed = run(reference);
        if (trial >= 0) (reference ? before : after).push(elapsed);
      }
    }
    const summary = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), trials: values };
    };
    const a = summary(before), b = summary(after);
    console.log(JSON.stringify({ name, before: a, after: b, speedup: a.median / b.median }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) benchmark();
