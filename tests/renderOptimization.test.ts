/// <reference types="node" />
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { createTyreFeedback } from '../src/presentation/tyres';
import { TyreEffects, TYRE_EFFECT_BUDGET } from '../src/render/tyreEffects';
import { internals, referenceUpdate, seedMarks } from '../scripts/renderPerfcheck';

function bytes(array: ArrayBufferView): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/** Includes inactive slots: stale matrices/attributes must also remain exactly unchanged. */
function state(effects: TyreEffects): string {
  const s = internals(effects), hash = createHash('sha256');
  for (const array of [s.world, s.velocity, s.life, s.duration, s.power, s.seed, s.centres, s.puffs,
    s.markWorld, s.markLife, s.markPower, s.markAlpha, s.last, s.trail,
    effects.skids.instanceMatrix.array]) hash.update(bytes(array));
  hash.update(JSON.stringify(effects.stats));
  return hash.digest('hex');
}

function equalState(actual: TyreEffects, reference: TyreEffects): void {
  expect(state(actual)).toBe(state(reference));
  expect(bytes(actual.skids.instanceMatrix.array).equals(bytes(reference.skids.instanceMatrix.array))).toBe(true);
  for (const [a, b] of [[actual.skids.instanceMatrix, reference.skids.instanceMatrix],
    [actual.skids.geometry.getAttribute('markAlpha'), reference.skids.geometry.getAttribute('markAlpha')],
    [actual.smoke.geometry.getAttribute('centre'), reference.smoke.geometry.getAttribute('centre')],
    [actual.smoke.geometry.getAttribute('puff'), reference.smoke.geometry.getAttribute('puff')]]) {
    expect((a as THREE.BufferAttribute).version).toBe((b as THREE.BufferAttribute).version);
  }
}

describe('render optimization preserves exact pre-optimization output', () => {
  it.each([30, 60, 120])('matches every GPU/state byte through emission, slot reuse, fades and rebasing at %i FPS', fps => {
    const actual = new TyreEffects(), reference = new TyreEffects(), feedback = createTyreFeedback();
    const random = vi.spyOn(Math, 'random');
    seedMarks(actual, TYRE_EFFECT_BUDGET.skids); seedMarks(reference, TYRE_EFFECT_BUDGET.skids);
    let frame = 0, ox = 0, oz = 0;
    const contact = (i: number, out: THREE.Vector3) => out.set(
      1e7 + Math.sin(frame * .017) * 30 + (i % 2 ? .8 : -.8) - ox, .018,
      -2e7 - frame * .28 + (frame >= 410 ? 200 : 0) + (i < 2 ? -1.3 : 1.3) - oz);
    try {
      for (; frame < 900; frame++) {
        ox = frame < 70 ? 0 : frame < 360 ? 1e7 : -3e6 + frame * .1;
        oz = frame < 70 ? 0 : frame < 360 ? -2e7 : 5e6 - frame * .2;
        for (let i = 0; i < 4; i++) Object.assign(feedback.wheels[i], {
          normalLoad: frame % 83 === 0 ? 0 : 3500,
          smokeIntensity: (frame % 19) / 18, slipIntensity: frame % 71 === 0 ? .1 : .85,
          contactLongitudinal: frame < 20 ? 0 : frame % 53 === 0 ? -12 : 15,
          contactLateral: frame < 20 ? 0 : 3, longitudinalSlipSpeed: i < 2 ? -15 : 22,
        });
        for (const effects of [actual, reference]) {
          random.mockImplementation(mulberry32(1234 + frame));
          effects.emit(1 / fps, feedback, contact, frame * .017, Math.sin(frame) * .4, ox, oz, frame % 101 !== 0);
          // Zero/invalid dt must still rebase; two emits before an update also reuse dirty slots.
          if (frame % 29 === 0) effects.emit(1 / fps, feedback, contact, .7, -.3, ox, oz);
        }
        const dt = frame % 97 === 0 ? NaN : frame % 89 === 0 ? -1 : frame % 13 === 0 ? 0 : 1 / fps;
        actual.update(dt, ox, oz); referenceUpdate(reference, dt, ox, oz);
        equalState(actual, reference);
      }
      expect(actual.stats.marksEmitted).toBeGreaterThan(TYRE_EFFECT_BUDGET.skids * 2);
      for (const dt of [5, 1, 1, 18, 0]) {
        actual.update(dt, -1e8, 1e8); referenceUpdate(reference, dt, -1e8, 1e8); equalState(actual, reference);
      }
      expect(actual.stats.marksAlive).toBe(0);
      // Expired slots are safely overwritten, including a mark that expires before first update.
      seedMarks(actual, 2000); seedMarks(reference, 2000);
      actual.update(25, 0, 0); referenceUpdate(reference, 25, 0, 0); equalState(actual, reference);
      seedMarks(actual, 2000); seedMarks(reference, 2000);
      actual.update(0, 300, -400); referenceUpdate(reference, 0, 300, -400); equalState(actual, reference);
      actual.update(.5, -300, 400); referenceUpdate(reference, .5, -300, 400); equalState(actual, reference);
      actual.dispose(); reference.dispose();
      actual.update(1, 0, 0); referenceUpdate(reference, 1, 0, 0); equalState(actual, reference);
    } finally { random.mockRestore(); actual.dispose(); reference.dispose(); }
  });

  it('preserves geometry, shaders, material flags, fixed pool sizes and draw/triangle budgets', () => {
    const effects = new TyreEffects();
    try {
      expect(TYRE_EFFECT_BUDGET).toEqual({ smoke: 240, skids: 1536, smokePerWheelSecond: 42, skidLife: 24, draws: 2 });
      expect(effects.group.children).toHaveLength(2);
      const smoke = effects.smoke.geometry as THREE.InstancedBufferGeometry;
      expect(smoke.instanceCount).toBe(240); expect(effects.skids.count).toBe(1536);
      expect(smoke.index!.count / 3 * smoke.instanceCount + effects.skids.geometry.index!.count / 3 * effects.skids.count).toBe(3552);
      for (const mesh of [effects.smoke, effects.skids]) {
        const mat = mesh.material as THREE.ShaderMaterial;
        expect(mat.transparent).toBe(true); expect(mat.depthWrite).toBe(false);
        expect(mesh.frustumCulled).toBe(false);
      }
      expect((effects.skids.material as THREE.ShaderMaterial).polygonOffset).toBe(true);
      expect(smoke.getAttribute('centre').count).toBe(240);
      expect(effects.skids.instanceMatrix.count).toBe(1536);
    } finally { effects.dispose(); }
  });
});
