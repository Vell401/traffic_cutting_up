import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import { mulberry32 } from '../src/core/rng';
import { WALL_D } from '../src/config';
import { getMap } from '../src/sim/maps';
import { Road } from '../src/sim/road';
import { extractMiamiAssets, type MiamiAssets, type MiamiManifest } from '../src/render/miami/assets';
import { miamiPlacements, miamiGround } from '../src/render/miami/layout';
import { MiamiWorld, MIAMI_WINDOW, MIAMI_CAPACITIES } from '../src/render/miami/world';

const manifest = JSON.parse(readFileSync('public/models/miami/manifest.json', 'utf8')) as MiamiManifest;
let a: MiamiAssets;
let releaseFixture: () => void;
beforeAll(async () => {
  const b = readFileSync('public/models/miami/coastal-kit.glb');
  const gltf = await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
  a = extractMiamiAssets(manifest, gltf.scene, new Map(manifest.textures.map(t => [t.id, new THREE.Texture()])));
  releaseFixture = a.retain();
});
afterAll(() => releaseFixture());
const road = () => new Road(mulberry32(7), getMap('miami').script);
const batches = (w: MiamiWorld) => w.group.children as THREE.InstancedMesh[];
const output = (w: MiamiWorld) => batches(w).map(m => ({ name: m.name, count: m.count, matrices: [...m.instanceMatrix.array.slice(0, m.count * 16)] }));

describe('actual authored Miami world', () => {
  it('composes four canonical districts and keeps actual transformed model bounds clear of the protected road on every lap', () => {
    const r = road(); r.ensure(-12000, 24000);
    for (let index = 0; index < 120; index++) {
      const placements = miamiPlacements(index);
      expect(placements).toEqual(miamiPlacements(index - 120)); expect(placements).toEqual(miamiPlacements(index + 240));
      for (const p of placements) {
        const prototype = a.prototypes.get(p.prototype)!; expect(prototype).toBeDefined();
        const bounds = new THREE.Box3(new THREE.Vector3(...prototype.bounds.min), new THREE.Vector3(...prototype.bounds.max));
        bounds.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(p.d, p.y, -p.s),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.heading), new THREE.Vector3().setScalar(p.scale)));
        expect(Math.min(Math.abs(bounds.min.x), Math.abs(bounds.max.x))).toBeGreaterThan(WALL_D + 2);
        let actualClearance = Infinity;
        for (const part of prototype.parts) {
          const vertices = part.geometry.getAttribute('position');
          for (let v = 0; v < vertices.count; v++) {
            const d = p.d + p.scale * (vertices.getX(v) * Math.cos(p.heading) + vertices.getZ(v) * Math.sin(p.heading));
            actualClearance = Math.min(actualClearance, Math.abs(d));
          }
        }
        expect(actualClearance, `${index}/${p.prototype}: actual submitted vertex corridor`).toBeGreaterThan(WALL_D + 2);
        expect(p.s).toBeGreaterThanOrEqual(0); expect(p.s).toBeLessThan(100);
        expect(Number.isFinite(miamiGround(r, index * 100 + p.s, p.d))).toBe(true);
      }
    }
    expect(miamiPlacements(3).filter(p => p.prototype.startsWith('hotel')).length).toBeGreaterThanOrEqual(3);
    expect(miamiPlacements(23).some(p => p.d > 0 && p.d < 100 && p.prototype !== 'streetlight')).toBe(false);
    expect(miamiPlacements(61).some(p => p.prototype === 'yacht')).toBe(true);
    expect(miamiPlacements(86).some(p => p.prototype.startsWith('tower'))).toBe(true);
  });
  it('has explicit bounded batch capacities and counts real instanced triangles including a complete shadow pass', () => {
    const r = road(), w = new MiamiWorld(a); r.ensure(0, 12000);
    expect(batches(w).length).toBeLessThanOrEqual(120);
    for (let s = 0; s < 12000; s += 100) {
      w.update(r, s, 0, 0, 0);
      let triangles = 0, shadowTriangles = 0, instances = 0;
      for (const m of batches(w)) {
        expect(m.count).toBeLessThanOrEqual(m.instanceMatrix.count);
        expect(m.instanceMatrix.count).toBe(MIAMI_CAPACITIES[m.userData.prototype as keyof typeof MIAMI_CAPACITIES]);
        triangles += m.geometry.index!.count / 3 * m.count;
        if (m.castShadow) shadowTriangles += m.geometry.index!.count / 3 * m.count;
        if (m.userData.firstPart) instances += m.count;
      }
      expect(instances).toBeLessThanOrEqual(1800); expect(triangles * 2).toBeLessThan(4_400_000);
      expect(triangles + shadowTriangles).toBeLessThan(3_500_000); // Reserve real headroom for selected car/traffic/road/post.
    }
    expect(MIAMI_WINDOW.ahead).toBeGreaterThanOrEqual(600); w.dispose();
  });
  it('keeps full close geometry but omits small metal/frame trim from the shadow pass, not the visible scene', () => {
    const w = new MiamiWorld(a);
    for (const m of batches(w)) {
      expect(m.geometry).toBe(a.prototypes.get(m.userData.prototype)!.parts.find(p => p.name === m.name)!.geometry);
      const trim = ['frame_ivory', 'metal_satin', 'bronze_dark', 'light_warm'].includes((m.material as THREE.Material).name);
      expect(m.castShadow).toBe(!trim); expect(m.receiveShadow).toBe(true);
    }
    w.dispose();
  });
  it('does no steady-frame rebuilding, rebase only moves the group, and invalidates road/version/range/empty transitions', () => {
    const r = road(); r.ensure(0, 1500); const w = new MiamiWorld(a); w.update(r, 300, 0, 0, 0);
    const initial = output(w), scan = vi.spyOn(r.chunks, Symbol.iterator);
    w.update(r, 301, 0, 0, 10); expect(scan).not.toHaveBeenCalled(); expect(output(w)).toEqual(initial);
    w.update(r, 300, 1000, -2000, 20); expect(scan).not.toHaveBeenCalled(); expect(output(w)).toEqual(initial);
    expect(w.group.position.toArray()).toEqual([-1000, 0, 2000]);
    for (const s of [800, -11800, 12200]) {
      r.ensure(s - 200, s + 1500); w.update(r, s, 9, 10, 0);
      const fresh = new MiamiWorld(a); fresh.update(r, s, 9, 10, 0); expect(output(w)).toEqual(output(fresh)); fresh.dispose();
    }
    const next = road(); next.ensure(0, 1500); w.update(next, 300, 0, 0, 0); expect(output(w)).toEqual(initial);
    next.chunks.length = 0; next.version++; w.update(next, 300, 0, 0, 0); expect(batches(w).every(m => m.count === 0)).toBe(true);
    next.ensure(0, 1500); w.update(next, 300, 0, 0, 0); expect(output(w)).toEqual(initial); w.dispose();
  });
  it('grounds marina furniture on its flat boardwalk, and uses manifest draft/deck offsets rather than recentering parts', () => {
    const r = road(); r.ensure(5800, 7000); const w = new MiamiWorld(a); w.update(r, 6100, 0, 0, 0);
    for (const m of batches(w)) {
      if (!m.count) continue;
      const matrix = new THREE.Matrix4(); m.getMatrixAt(0, matrix);
      if (m.userData.prototype === 'yacht') expect(matrix.elements[13]).toBeCloseTo(-8.9);
      if (m.userData.prototype === 'marina_pontoon') expect(matrix.elements[13]).toBeCloseTo(-8.3);
    }
    expect(miamiGround(r, 6150, -80)).toBe(-7); w.dispose();
  });
  it('uses the lowest terrain under full building bounds on portal/viaduct approaches, not only the centre', () => {
    const r = road(); r.ensure(9000, 12000); const w = new MiamiWorld(a); w.update(r, 10600, 0, 0, 0);
    for (const index of [106, 107]) for (const p of miamiPlacements(index).filter(p => p.prototype.startsWith('tower'))) {
      const prototype = a.prototypes.get(p.prototype)!, extent = prototype.bounds.max[0] * p.scale;
      const along = index * 100 + p.s;
      const point = r.toWorld(along, p.d, { x: 0, z: 0, th: 0, k: 0 });
      const m = batches(w).find(m => m.userData.prototype === p.prototype)!;
      const matrices = Array.from({ length: m.count }, (_, i) => { const matrix = new THREE.Matrix4(); m.getMatrixAt(i, matrix); return matrix; });
      const matrix = matrices.find(matrix => Math.hypot(matrix.elements[12] - point.x, matrix.elements[14] - point.z) < 0.001)!;
      const ground = Math.min(miamiGround(r, along - extent, p.d), miamiGround(r, along + extent, p.d));
      expect(matrix.elements[13]).toBeLessThanOrEqual(ground + 0.00001);
    }
    w.dispose();
  });
  it('disposes instance buffers once but leaves borrowed source geometry/maps alive while another world uses them', () => {
    const first = new MiamiWorld(a), second = new MiamiWorld(a);
    const instanceSpies = batches(first).map(m => vi.spyOn(m, 'dispose'));
    const geo = batches(first).map(m => vi.spyOn(m.geometry, 'dispose'));
    first.dispose(); first.dispose(); instanceSpies.forEach(s => expect(s).toHaveBeenCalledOnce());
    geo.forEach(s => expect(s).not.toHaveBeenCalled()); expect(first.group.children).toHaveLength(0);
    second.dispose(); geo.forEach(s => expect(s).not.toHaveBeenCalled());
    releaseFixture(); geo.forEach(s => expect(s).toHaveBeenCalledOnce());
  });
});
