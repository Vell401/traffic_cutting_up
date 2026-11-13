import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import { mulberry32 } from '../src/core/rng';
import { WALL_D } from '../src/config';
import { getMap } from '../src/sim/maps';
import { Road } from '../src/sim/road';
import { extractMiamiAssets, type MiamiAssets, type MiamiManifest } from '../src/render/miami/assets';
import { miamiPlacements, miamiGround, MIAMI_WATER, MIAMI_QUAY } from '../src/render/miami/layout';
import { MiamiWorld, MIAMI_WINDOW, MIAMI_CAPACITIES } from '../src/render/miami/world';
import { RoadView } from '../src/render/roadView';
import { ChaseCamera } from '../src/render/camera';
import { CAMERA_RIGS } from '../src/render/car';
import { QUALITY } from '../src/settings';
import { renderDocument } from './renderCanvas';

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
  it('allocates every prototype tint attribute before loader warm-up, including models absent at spawn', () => {
    const w = new MiamiWorld(a);
    for (const m of batches(w)) {
      expect(m.instanceColor, m.name).not.toBeNull();
      expect(m.instanceColor!.count).toBe(m.instanceMatrix.count);
      expect(Array.from(m.instanceColor!.array.slice(0, 3))).toEqual([1, 1, 1]);
      expect(m.instanceColor!.usage).toBe(THREE.DynamicDrawUsage);
    }
    w.dispose();
  });
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
      if (m.userData.prototype === 'yacht') expect(matrix.elements[13] + .9 * new THREE.Vector3().setFromMatrixScale(matrix).x).toBeCloseTo(MIAMI_WATER);
      if (m.userData.prototype === 'marina_pontoon') expect(matrix.elements[13]).toBeCloseTo(MIAMI_WATER - .3);
    }
    expect(miamiGround(r, 6150, -80)).toBe(MIAMI_QUAY); w.dispose();
  });
  it('brings the marina basin to the road without burying its upper promenade or losing physical yacht draft', () => {
    const r = road(); r.ensure(5800, 6400);
    // Furniture must stand on the upper path, not the old long slope down to -98m.
    expect(miamiGround(r, 6150, -22)).toBe(r.groundY(6150));
    const boats = miamiPlacements(61).filter(p => p.prototype === 'yacht');
    expect(boats.every(p => Math.abs(p.d) < 75)).toBe(true);
    const w = new MiamiWorld(a); w.update(r, 6100, 0, 0, 0);
    const hull = batches(w).find(m => m.name === 'yacht__hull_pearl')!;
    for (let i = 0; i < hull.count; i++) {
      const matrix = new THREE.Matrix4(); hull.getMatrixAt(i, matrix);
      const scale = new THREE.Vector3().setFromMatrixScale(matrix).x;
      expect(matrix.elements[13] + .9 * scale).toBeCloseTo(MIAMI_WATER);
    }
    w.dispose();
  });
  it('separates full building footprints on curves, neighbouring chunks and the lap seam', () => {
    const r = road(); r.ensure(-200, 12300);
    const buildings: { index: number; points: THREE.Vector2[] }[] = [];
    for (let index = -1; index <= 120; index++) for (const p of miamiPlacements(index)) {
      if (!/^(hotel|condo|tower)/.test(p.prototype) || Math.abs(p.d) > 200) continue;
      const b = a.prototypes.get(p.prototype)!.bounds, along = index * 100 + p.s;
      const at = r.toWorld(along, p.d, { x: 0, z: 0, th: 0, k: 0 }), angle = -at.th + p.heading;
      const points = [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]]
        .map(([x, z]) => new THREE.Vector2(at.x + p.scale * (x * Math.cos(angle) + z * Math.sin(angle)),
          at.z + p.scale * (-x * Math.sin(angle) + z * Math.cos(angle))));
      for (const other of buildings.filter(o => Math.abs(o.index - index) <= 1)) {
        const separated = [...points, ...other.points].some((point, n) => {
          const polygon = n < 4 ? points : other.points, j = n % 4;
          const edge = polygon[(j + 1) % 4].clone().sub(point), axis = new THREE.Vector2(-edge.y, edge.x).normalize();
          const a = points.map(v => v.dot(axis)), b = other.points.map(v => v.dot(axis));
          return Math.max(...a) + .25 < Math.min(...b) || Math.max(...b) + .25 < Math.min(...a);
        });
        expect(separated, `building overlap ${other.index}/${index}`).toBe(true);
      }
      buildings.push({ index, points });
    }
  });
  it('exposes real pontoon deck vertices past the real barrier/quay to the canonical on-road R34 chase camera', () => {
    vi.stubGlobal('document', renderDocument);
    const r = road(); r.ensure(5900, 6900);
    const w = new MiamiWorld(a), v = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami', 'assets');
    try {
      w.update(r, 6100, 0, 0, 0); v.update(r, 6000, 6799, 0, 0);
      w.group.updateMatrixWorld(true); v.group.updateMatrixWorld(true);
      const camera = new THREE.PerspectiveCamera(62.17771448963918, 1280 / 800, .5, 3000);
      const chase = new ChaseCamera(); chase.setRig(CAMERA_RIGS[2]);
      const eye = r.toWorld(6100, 0, { x: 0, z: 0, th: 0, k: 0 });
      chase.update(0, camera, new THREE.Vector3(eye.x, 0, eye.z), eye.th, 0, null); camera.updateMatrixWorld(true);
      expect(camera.position.y).toBe(2.05);
      const deck = batches(w).find(m => m.name === 'marina_pontoon__teak_deck')!;
      const at = r.toWorld(6250, -53.5, { x: 0, z: 0, th: 0, k: 0 });
      const matrices = Array.from({ length: deck.count }, (_, i) => { const matrix = new THREE.Matrix4(); deck.getMatrixAt(i, matrix); return matrix; });
      const matrix = matrices.find(m => Math.hypot(m.elements[12] - at.x, m.elements[14] - at.z) < .001)!;
      expect(matrix).toBeDefined();
      const pos = deck.geometry.getAttribute('position'), normals = deck.geometry.getAttribute('normal');
      const occluders = v.group.children.flatMap(c => c.children as THREE.Mesh[]).filter(m => m.visible);
      let visible = 0;
      for (let i = 0; i < pos.count; i++) {
        if (normals.getY(i) < .99) continue;
        const target = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix);
        const projected = target.clone().project(camera);
        if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z > 1) continue;
        const direction = target.clone().sub(camera.position), distance = direction.length();
        const ray = new THREE.Raycaster(camera.position, direction.normalize(), .5, distance - .02);
        const hits = ray.intersectObjects(occluders, false);
        if (!hits.length) visible++;
      }
      expect(visible, 'actual deck must not be entirely hidden below the barrier/quay').toBeGreaterThan(10);
    } finally { w.dispose(); v.dispose(); vi.unstubAllGlobals(); }
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
