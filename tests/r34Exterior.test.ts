import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildR34Exterior, R34_EXTERIOR_BUDGET, R34_GREENHOUSE } from '../src/render/car/r34Exterior';
import type { R34Exterior } from '../src/render/car/r34Exterior';

function meshes(group: THREE.Group): THREE.Mesh[] { const out: THREE.Mesh[] = []; group.traverse(o => { if (o instanceof THREE.Mesh) out.push(o); }); return out; }
function triangles(m: THREE.Mesh): number { return (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3 * (m instanceof THREE.InstancedMesh ? m.count : 1); }
function cast(group: THREE.Group, from: THREE.Vector3, direction: THREE.Vector3, far = 10) { group.updateMatrixWorld(true); return new THREE.Raycaster(from, direction, 0, far).intersectObject(group, true); }

describe('independent R34 exterior surface model', () => {
  let a: R34Exterior, b: R34Exterior;
  beforeAll(() => { a = buildR34Exterior(0x164c9e); b = buildR34Exterior(0xeeeeee); }, 30000);
  afterAll(() => { a.dispose(); b.dispose(); });

  it('builds without a renderer, DOM, downloads or shared car materials', () => {
    expect(typeof document).toBe('undefined'); expect(a.body.name).toBe('R34/exterior');
    const paint = (a.body.getObjectByName('R34/paint') as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(paint.clearcoat).toBe(1); expect(paint.bumpMap).toBeInstanceOf(THREE.DataTexture); expect(paint.userData.shared).not.toBe(true);
    expect((paint.bumpMap!.image as { width: number }).width).toBeLessThanOrEqual(1024);
  });
  it('stays within explicit geometry, draw-call and texture limits', () => {
    const all = [...meshes(a.body), ...meshes(a.wheelRoot)], total = all.reduce((n, m) => n + triangles(m), 0);
    console.info(`R34 asset: ${total} triangles, ${all.length} material draws (excluding scene/shadow passes)`);
    expect(total).toBeGreaterThanOrEqual(R34_EXTERIOR_BUDGET.targetTriangles[0]); expect(total).toBeLessThanOrEqual(R34_EXTERIOR_BUDGET.targetTriangles[1]); expect(all.length).toBeLessThanOrEqual(R34_EXTERIOR_BUDGET.maximumDrawCalls);
    const textures = new Set<THREE.Texture>();
    for (const m of all) for (const value of Object.values(m.material)) if (value instanceof THREE.Texture) textures.add(value);
    expect(textures.size).toBe(R34_EXTERIOR_BUDGET.textures.textureCount);
    for (const t of textures) { const image = t.image as { width: number; height: number }; expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1024); }
  });
  it('shares immutable geometry and pixels but never paint or signal materials', () => {
    const am = meshes(a.body), bm = meshes(b.body);
    for (let i = 0; i < am.length; i++) { expect(am[i].geometry).toBe(bm[i].geometry); expect(am[i].geometry.userData.shared).toBe(true); expect(am[i].material).not.toBe(bm[i].material); }
    const ap = am[0].material as THREE.MeshPhysicalMaterial, bp = bm[0].material as THREE.MeshPhysicalMaterial;
    expect(ap.bumpMap).toBe(bp.bumpMap); a.setPaint(0xef4912); expect(ap.color.getHex()).toBe(0xef4912); expect(bp.color.getHex()).toBe(0xeeeeee); expect(a.tail).not.toBe(b.tail);
  });
  it('has finite unit normals and no zero-area padding triangles', () => {
    for (const mesh of [...meshes(a.body), ...meshes(a.wheelRoot)]) {
      const g = mesh.geometry, p = g.getAttribute('position'), normal = g.getAttribute('normal'), idx = g.index;
      expect(Array.from(p.array).every(Number.isFinite), mesh.name).toBe(true); expect(Array.from(normal.array).every(Number.isFinite), mesh.name).toBe(true);
      let degenerates = 0, badNormals = 0; const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
      for (let i = 0; i < normal.count; i++) if (Math.abs(va.fromBufferAttribute(normal, i).length() - 1) > .002) badNormals++;
      for (let i = 0; i < (idx?.count ?? p.count); i += 3) { va.fromBufferAttribute(p, idx ? idx.getX(i) : i); vb.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1).sub(va); vc.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2).sub(va); if (vb.cross(vc).lengthSq() < 1e-20) degenerates++; }
      expect(degenerates, mesh.name).toBe(0); expect(badNormals, mesh.name).toBe(0);
    }
  });
  it('keeps the outer arch openings clear, but closes sight lines into the cabin with inner tubs', () => {
    for (const z of R34_EXTERIOR_BUDGET.axles) for (const y of [.3, .44, .57]) for (const sign of [-1, 1]) {
      const from = new THREE.Vector3(sign * 1.3, y, z), dir = new THREE.Vector3(-sign, 0, 0);
      expect(cast(a.body, from, dir, .59), `open lip at ${y}/${z}/${sign}`).toHaveLength(0);
      const liner = cast(a.body, from, dir, 1.02).filter(hit => (hit.object as THREE.Mesh).name === 'R34/trim');
      expect(liner.length, `closed tub at ${y}/${z}/${sign}`).toBeGreaterThan(0);
      expect(Math.abs(liner[0].point.x)).toBeLessThan(.6);
    }
  });
  it('leaves the passenger compartment open and glazing transparent', () => {
    const opaque = meshes(a.body).filter(m => !(m.material as THREE.Material).transparent);
    a.body.updateMatrixWorld(true); expect(new THREE.Raycaster(new THREE.Vector3(0, 1.23, .7), new THREE.Vector3(0, -1, 0), 0, .9).intersectObjects(opaque)).toHaveLength(0);
    const glass = (a.body.getObjectByName('R34/glass') as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(glass.transparent).toBe(true); expect(glass.opacity).toBeLessThan(.3); expect(glass.depthWrite).toBe(false);
  });
  it('faces hood, roof, flanks and windscreen frames outward', () => {
    const hood = cast(a.body, new THREE.Vector3(.2, 2, -1.4), new THREE.Vector3(0, -1, 0))[0]; expect(hood.point.y).toBeGreaterThan(.78); expect(hood.face!.normal.y).toBeGreaterThan(.8);
    const side = cast(a.body, new THREE.Vector3(2, .6, 0), new THREE.Vector3(-1, 0, 0))[0]; expect(side.face!.normal.x).toBeGreaterThan(.8);
    const roof = cast(a.body, new THREE.Vector3(0, 2, .6), new THREE.Vector3(0, -1, 0))[0]; expect(roof.point.y).toBeCloseTo(1.36, 2);
    const frame = cast(a.body, new THREE.Vector3(0, 1.343, -1), new THREE.Vector3(0, 0, 1)).find(h => h.object.name === 'R34/paint'); expect(frame).toBeDefined(); expect(frame!.face!.normal.z).toBeLessThan(-.2);
  });
  it('uses contiguous curved roof-to-screen/frame boundaries without unattached rail tips', () => {
    const roof = a.body.getObjectByName('R34/roof')!, roofPaint = roof.getObjectByName('R34/paint') as THREE.Mesh, p = roofPaint.geometry.getAttribute('position');
    const shell = (a.body.getObjectByName('R34/paint') as THREE.Mesh).geometry, sp = shell.getAttribute('position'), si = shell.index!, triangle = new THREE.Triangle(), closest = new THREE.Vector3();
    // Different surface tessellations must still meet within 0.6 mm, measured to faces, not vertices.
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i), t = v.x / .657, frontZ = R34_GREENHOUSE.roofFrontZ - .035 * (1 - t * t), rearZ = R34_GREENHOUSE.roofRearZ + .025 * (1 - t * t);
      if (Math.min(Math.abs(v.z - frontZ), Math.abs(v.z - rearZ)) > 1e-5) continue;
      let distance = Infinity;
      for (let j = 0; j < si.count; j += 3) {
        triangle.a.fromBufferAttribute(sp, si.getX(j)); triangle.b.fromBufferAttribute(sp, si.getX(j + 1)); triangle.c.fromBufferAttribute(sp, si.getX(j + 2));
        if (triangle.a.y < 1.28 || triangle.b.y < 1.28 || triangle.c.y < 1.28) continue;
        triangle.closestPointToPoint(v, closest); distance = Math.min(distance, closest.distanceToSquared(v));
      }
      expect(distance).toBeLessThan(.0006 ** 2);
    }
  });
  it('keeps tyre sidewalls outward-facing with readable, non-mirrored tangential UVs', () => {
    const tyre = a.wheelRoot.getObjectByName('R34/wheels/tyre') as THREE.InstancedMesh, n = tyre.geometry.getAttribute('normal'), p = tyre.geometry.getAttribute('position');
    let outward = 0, inward = 0; for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < .105) { const radial = p.getY(i) * n.getY(i) + p.getZ(i) * n.getZ(i); if (radial > .1) outward++; if (radial < -.1) inward++; }
    expect(outward).toBeGreaterThan(1000); expect(inward).toBe(0);
    const lettering = (a.wheelRoot.getObjectByName('R34/wheels/decal') as THREE.InstancedMesh).geometry, lp = lettering.getAttribute('position'), uv = lettering.getAttribute('uv'), ln = lettering.getAttribute('normal');
    let leftZ = 0, rightZ = 0; for (let i = 0; i < lp.count; i++) if (lp.getY(i) > .22) { expect(ln.getX(i)).toBeGreaterThan(.99); if (uv.getX(i) < .01) leftZ = lp.getZ(i); if (uv.getX(i) > .99) rightZ = lp.getZ(i); }
    expect(leftZ).toBeGreaterThan(rightZ);
  });
  it('has recessed mirror glass, with no blue shell protruding through its centre', () => {
    for (const sign of [-1, 1]) {
      const hits = cast(a.body, new THREE.Vector3(sign * .948, .972, .1), new THREE.Vector3(0, 0, -1)).filter(h => !(h.object as THREE.Mesh).material || !((h.object as THREE.Mesh).material as THREE.Material).transparent);
      expect(hits[0].object.name).toBe('R34/chrome'); expect(hits[0].face!.normal.z).toBeGreaterThan(.95);
      const nose = cast(a.body, new THREE.Vector3(sign * .948, .972, -.6), new THREE.Vector3(0, 0, 1))[0];
      expect(nose.object.name).toBe('R34/paint'); expect(nose.point.z).toBeCloseTo(-.411, 3); expect(hits[0].point.z - nose.point.z).toBeGreaterThan(.12);
    }
  });
  it('lines the rim barrel inward instead of showing the road through its back faces', () => {
    const barrel = a.wheelRoot.getObjectByName('R34/wheels/darkMetal') as THREE.InstancedMesh;
    const local = new THREE.Mesh(barrel.geometry, barrel.material);
    const hits = new THREE.Raycaster(new THREE.Vector3(.07, 0, 0), new THREE.Vector3(0, -1, 0), .1, .25).intersectObject(local);
    expect(hits.length).toBeGreaterThan(0); expect(hits[0].point.y).toBeCloseTo(-.219, 3); expect(hits[0].face!.normal.y).toBeGreaterThan(.95);
  });
  it('keeps the actual steered tyre envelope clear of arch lips and deep inner tub walls', () => {
    const tyre = a.wheelRoot.getObjectByName('R34/wheels/tyre') as THREE.InstancedMesh, positions = tyre.geometry.getAttribute('position'), matrix = new THREE.Matrix4(), v = new THREE.Vector3();
    for (const lock of [-55, 0, 55]) {
      a.wheels.update(lock * Math.PI / 180, 0);
      for (let wheel = 0; wheel < 2; wheel++) {
        tyre.getMatrixAt(wheel, matrix);
        for (let i = 0; i < positions.count; i++) {
          v.fromBufferAttribute(positions, i).applyMatrix4(matrix);
          expect(Math.abs(v.x)).toBeGreaterThan(.39);
          expect(Math.hypot(v.y - .327, v.z + 1.35)).toBeLessThan(.376);
        }
      }
    }
    a.wheels.update(0, 0);
  });
  it('steers the front wheels through 55 degrees, spins the rotors but not the calipers', () => {
    expect(a.wheelRoot.parent).not.toBe(a.body);
    const tyre = a.wheelRoot.getObjectByName('R34/wheels/tyre') as THREE.InstancedMesh, caliper = a.wheelRoot.getObjectByName('R34/wheels/caliper') as THREE.InstancedMesh;
    const before = new THREE.Matrix4(), after = new THREE.Matrix4(), rolling = new THREE.Matrix4(), rear0 = new THREE.Matrix4();
    a.wheels.update(0, 0); tyre.getMatrixAt(2, rear0); a.wheels.update(55 * Math.PI / 180, 0); caliper.getMatrixAt(0, before); a.wheels.update(55 * Math.PI / 180, 1.7); caliper.getMatrixAt(0, after); tyre.getMatrixAt(0, rolling);
    expect(after.elements).toEqual(before.elements); expect(rolling.elements).not.toEqual(before.elements);
    for (let i = 0; i < 4; i++) { tyre.getMatrixAt(i, rolling); expect(rolling.elements[12]).toBeCloseTo(i % 2 ? .763 : -.763); expect(rolling.elements[13]).toBeCloseTo(.327); expect(rolling.elements[14]).toBeCloseTo(i < 2 ? -1.35 : 1.315); }
    a.wheels.update(55 * Math.PI / 180, 0); tyre.getMatrixAt(2, after); expect(after.elements).toEqual(rear0.elements); expect(Math.abs(before.elements[0])).toBeCloseTo(Math.cos(55 * Math.PI / 180)); a.wheels.update(0, 0);
  });
  it('places both fixed calipers behind their axle rather than mirroring one to the front', () => {
    const caliper = a.wheelRoot.getObjectByName('R34/wheels/caliper') as THREE.InstancedMesh, matrix = new THREE.Matrix4(), centre = new THREE.Vector3();
    a.wheels.update(0, 0);
    for (let i = 0; i < 4; i++) { caliper.getMatrixAt(i, matrix); centre.set(.005, 0, .157).applyMatrix4(matrix); expect(centre.y).toBeCloseTo(.327); expect(centre.z).toBeCloseTo((i < 2 ? -1.35 : 1.315) + .157); }
  });
  it('controls each indicator and brake ring independently', () => {
    const left = (a.body.getObjectByName('R34/left') as THREE.Mesh).material as THREE.MeshBasicMaterial, right = (a.body.getObjectByName('R34/right') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    a.indicators.set(true, false, true); expect(left.color.r).toBeGreaterThan(3); expect(right.color.r).toBeLessThan(.2); expect(a.tail.color).toEqual(a.tailBrake); expect(b.tail.color).toEqual(b.tailIdle);
    a.indicators.set(false, true, false); expect(right.color.r).toBeGreaterThan(3); expect(left.color.r).toBeLessThan(.2); expect(a.tail.color).toEqual(a.tailIdle);
  });
  it('hides only the physical roof for cockpit mode', () => { a.setCockpit(true); expect(a.body.getObjectByName('R34/roof')!.visible).toBe(false); expect(a.body.getObjectByName('R34/glass')!.visible).toBe(true); a.setCockpit(false); });
  it('disposes private resources once without invalidating cached meshes or texture pixels', () => {
    const car = buildR34Exterior(0x112233), mesh = car.body.getObjectByName('R34/paint') as THREE.Mesh, paint = mesh.material as THREE.MeshPhysicalMaterial, mat = vi.fn(), geo = vi.fn(), tex = vi.fn();
    paint.addEventListener('dispose', mat); mesh.geometry.addEventListener('dispose', geo); paint.bumpMap!.addEventListener('dispose', tex); car.dispose(); car.dispose(); expect(mat).toHaveBeenCalledOnce(); expect(geo).not.toHaveBeenCalled(); expect(tex).not.toHaveBeenCalled(); mesh.geometry.removeEventListener('dispose', geo); paint.bumpMap!.removeEventListener('dispose', tex);
  });
});
