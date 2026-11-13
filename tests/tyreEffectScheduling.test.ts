import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createTyreFeedback } from '../src/presentation/tyres';
import { TyreEffects } from '../src/render/tyreEffects';
import { seedMarks } from '../scripts/renderPerfcheck';

const attributes = (e: TyreEffects) => [e.smoke.geometry.getAttribute('centre'), e.smoke.geometry.getAttribute('puff'), e.skids.instanceMatrix, e.skids.geometry.getAttribute('markAlpha')] as THREE.BufferAttribute[];
const versions = (e: TyreEffects) => attributes(e).map(a => a.version);
it('empty and unchanged paused pools request no uploads or draws, retaining all capacities', () => {
  const e = new TyreEffects();
  try {
    const before = versions(e);
    for (const dt of [0, 1/60, 3, NaN, -1]) e.update(dt, 100, -200);
    expect(versions(e)).toEqual(before); expect([e.smoke.visible, e.skids.visible]).toEqual([false, false]);
    expect((e.smoke.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(240); expect(e.skids.count).toBe(1536);
    seedMarks(e, 1); e.update(0, 100, -200);
    const active = versions(e); expect(e.skids.visible).toBe(true);
    e.update(0, 100, -200); expect(versions(e)).toEqual(active);
    e.update(0, 200, -300); expect(e.skids.instanceMatrix.version).toBe(active[2] + 1);
    expect((e.skids.geometry.getAttribute('markAlpha') as THREE.BufferAttribute).version).toBe(active[3]);
  } finally { e.dispose(); }
});

it('flushes final expiry once, reawakens after idle and uploads newly reused slots without stale effects', () => {
  const e = new TyreEffects(), f = createTyreFeedback();
  Object.assign(f.wheels[0], { normalLoad: 3500, smokeIntensity: 1 });
  try {
    e.emit(.1, f, (_i, out) => out.set(1, .018, 2), 0, 0, 0, 0); seedMarks(e, 2000);
    e.update(.05, 0, 0); expect([e.smoke.visible, e.skids.visible]).toEqual([true, true]);
    const active = versions(e); e.update(0, 0, 0); expect(versions(e)).toEqual(active);
    e.update(0, 50, -60); expect(versions(e)[1]).toBe(active[1]); expect(versions(e)[3]).toBe(active[3]);
    e.update(25, 1000, -1000);
    expect([e.smoke.visible, e.skids.visible]).toEqual([false, false]);
    expect(e.smoke.geometry.getAttribute('puff').getY(0)).toBe(0);
    expect([...e.skids.geometry.getAttribute('markAlpha').array].every(a => a === 0)).toBe(true);
    const expired = versions(e); expect(expired[1]).toBeGreaterThan(active[1]); expect(expired[3]).toBeGreaterThan(active[3]);
    e.update(1, 0, 0); expect(versions(e)).toEqual(expired);
    e.emit(.1, f, (_i, out) => out.set(11, .018, 12), 0, 0, 0, 0); seedMarks(e, 2000); e.update(.05, 0, 0);
    expect([e.smoke.visible, e.skids.visible]).toEqual([true, true]);
    expect(versions(e).every((v,i) => v > expired[i])).toBe(true);
  } finally { e.dispose(); }
});
