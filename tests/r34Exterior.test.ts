import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildR34Exterior, R34_EXTERIOR_BUDGET } from '../src/render/car/r34Exterior';
import type { R34Exterior } from '../src/render/car/r34Exterior';

function meshes(group: THREE.Group): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  group.traverse(o => { if (o instanceof THREE.Mesh) result.push(o); });
  return result;
}

function triangles(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  return (g.index?.count ?? g.getAttribute('position').count) / 3 * (mesh instanceof THREE.InstancedMesh ? mesh.count : 1);
}

describe('rebuilt procedural R34 exterior', () => {
  let a: R34Exterior, b: R34Exterior;
  beforeAll(() => {
    a = buildR34Exterior(0x164c9e);
    b = buildR34Exterior(0xeeeeee);
  }, 30000);
  afterAll(() => { a.dispose(); b.dispose(); });

  it('builds on a CPU without document, network assets or a renderer', () => {
    expect(typeof document).toBe('undefined');
    expect(a.body.name).toBe('R34/exterior');
    const paint = (a.body.getObjectByName('R34/paint') as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(paint.clearcoat).toBe(1);
    expect(paint.bumpMap).toBeInstanceOf(THREE.DataTexture);
    expect((paint.bumpMap!.image as { width: number }).width).toBeLessThanOrEqual(2048);
    expect(paint.userData.shared).not.toBe(true);
  });

  it('stays within the stated geometry and draw-call budgets', () => {
    const all = [...meshes(a.body), ...meshes(a.wheelRoot)];
    const total = all.reduce((n, m) => n + triangles(m), 0);
    console.info(`R34 exterior: ${total.toLocaleString()} rendered triangles, ${all.length} draw calls`);
    expect(total).toBeGreaterThanOrEqual(R34_EXTERIOR_BUDGET.targetTriangles[0]);
    expect(total).toBeLessThanOrEqual(R34_EXTERIOR_BUDGET.targetTriangles[1]);
    expect(all.length).toBeLessThanOrEqual(R34_EXTERIOR_BUDGET.maximumDrawCalls);
  });

  it('shares immutable geometries/textures but never paint, tail or indicator materials', () => {
    const am = meshes(a.body), bm = meshes(b.body);
    for (let i = 0; i < am.length; i++) {
      expect(am[i].geometry).toBe(bm[i].geometry);
      expect(am[i].geometry.userData.shared).toBe(true);
      expect(am[i].material).not.toBe(bm[i].material);
    }
    const ap = am[0].material as THREE.MeshPhysicalMaterial;
    const bp = bm[0].material as THREE.MeshPhysicalMaterial;
    expect(ap.bumpMap).toBe(bp.bumpMap);
    a.setPaint(0xef4912);
    expect(ap.color.getHex()).toBe(0xef4912);
    expect(bp.color.getHex()).toBe(0xeeeeee);
    expect(a.tail).not.toBe(b.tail);
  });

  it('uses finite geometry and normals rather than degenerate high-poly padding', () => {
    for (const mesh of [...meshes(a.body), ...meshes(a.wheelRoot)]) {
      const g = mesh.geometry, p = g.getAttribute('position'), normal = g.getAttribute('normal');
      expect(Array.from(p.array).every(Number.isFinite), mesh.name).toBe(true);
      expect(Array.from(normal.array).every(Number.isFinite), mesh.name).toBe(true);
      const index = g.index;
      let degenerates = 0;
      const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
      for (let i = 0; i < (index?.count ?? p.count); i += 3) {
        va.fromBufferAttribute(p, index ? index.getX(i) : i);
        vb.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1).sub(va);
        vc.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2).sub(va);
        if (vb.cross(vc).lengthSq() < 1e-20) degenerates++;
      }
      expect(degenerates, mesh.name).toBe(0);
    }
  });

  it('has actual open wheel wells with no body triangles spanning the tyre openings', () => {
    a.body.updateMatrixWorld(true);
    for (const z of [-1.35, 1.315]) for (const y of [0.3, 0.44, 0.57]) for (const sign of [-1, 1]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(sign * 1.3, y, z), new THREE.Vector3(-sign, 0, 0), 0, 0.59);
      expect(ray.intersectObject(a.body, true), `arch at ${y}, ${z}, side ${sign}`).toHaveLength(0);
    }
  });

  it('leaves a real open cabin and physically separate transparent windows', () => {
    a.body.updateMatrixWorld(true);
    const opaque = meshes(a.body).filter(m => !(m.material as THREE.Material).transparent);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.23, 0), new THREE.Vector3(0, -1, 0), 0, 0.9);
    expect(ray.intersectObjects(opaque)).toHaveLength(0);
    const glass = a.body.getObjectByName('R34/glass') as THREE.Mesh;
    expect((glass.material as THREE.MeshPhysicalMaterial).transparent).toBe(true);
    expect((glass.material as THREE.MeshPhysicalMaterial).opacity).toBeLessThan(0.3);
    expect((glass.material as THREE.MeshPhysicalMaterial).depthWrite).toBe(false);
  });

  it('has outward-facing hood, fender, roof, and reflector surfaces', () => {
    a.body.updateMatrixWorld(true);
    const topRay = new THREE.Raycaster(new THREE.Vector3(0.2, 2, -1.4), new THREE.Vector3(0, -1, 0));
    const hits = topRay.intersectObject(a.body, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].point.y).toBeGreaterThan(0.8);
    expect(hits[0].face!.normal.y).toBeGreaterThan(0.8);
    const sideRay = new THREE.Raycaster(new THREE.Vector3(2, 0.6, 0), new THREE.Vector3(-1, 0, 0));
    const sideHit = sideRay.intersectObject(a.body, true)[0];
    expect(sideHit.face!.normal.x).toBeGreaterThan(0.8);
    const roofRay = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0));
    expect(roofRay.intersectObject(a.body, true)[0].point.y).toBeCloseTo(1.36, 2);
  });

  it('keeps wheels outside the suspension body, steering the front only and spinning without calipers', () => {
    expect(a.wheelRoot.parent).not.toBe(a.body);
    const tyre = a.wheelRoot.getObjectByName('R34/wheels/tyre') as THREE.InstancedMesh;
    const caliper = a.wheelRoot.getObjectByName('R34/wheels/caliper') as THREE.InstancedMesh;
    const before = new THREE.Matrix4(), after = new THREE.Matrix4(), other = new THREE.Matrix4();
    a.wheels.update(0.2, 0);
    caliper.getMatrixAt(0, before);
    a.wheels.update(0.2, 1.7);
    caliper.getMatrixAt(0, after);
    tyre.getMatrixAt(0, other);
    expect(after.elements).toEqual(before.elements);
    expect(other.elements).not.toEqual(before.elements);
    for (let i = 0; i < 4; i++) {
      tyre.getMatrixAt(i, other);
      expect(other.elements[12]).toBeCloseTo(i % 2 === 0 ? -0.763 : 0.763);
      expect(other.elements[13]).toBeCloseTo(0.327);
      expect(other.elements[14]).toBeCloseTo(i < 2 ? -1.35 : 1.315);
    }
    a.wheels.update(0, 0);
  });

  it('controls brake rings and each indicator side independently', () => {
    const left = (a.body.getObjectByName('R34/left') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const right = (a.body.getObjectByName('R34/right') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    a.indicators.set(true, false, true);
    expect(left.color.r).toBeGreaterThan(4);
    expect(right.color.r).toBeLessThan(0.2);
    expect(a.tail.color).toEqual(a.tailBrake);
    expect(b.tail.color).toEqual(b.tailIdle);
    a.indicators.set(false, true, false);
    expect(right.color.r).toBeGreaterThan(4);
    expect(left.color.r).toBeLessThan(0.2);
    expect(a.tail.color).toEqual(a.tailIdle);
  });

  it('can remove the exterior roof for the local cockpit without hiding glazing', () => {
    a.setCockpit(true);
    expect(a.body.getObjectByName('R34/roof')!.visible).toBe(false);
    expect(a.body.getObjectByName('R34/glass')!.visible).toBe(true);
    a.setCockpit(false);
    expect(a.body.getObjectByName('R34/roof')!.visible).toBe(true);
  });

  it('disposes each private material once, retaining all cached geometry and texture resources', () => {
    const car = buildR34Exterior(0x112233);
    const paint = (car.body.getObjectByName('R34/paint') as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    const disposeMat = vi.fn(), disposeGeometry = vi.fn(), disposeTexture = vi.fn();
    paint.addEventListener('dispose', disposeMat);
    const g = (car.body.getObjectByName('R34/paint') as THREE.Mesh).geometry;
    g.addEventListener('dispose', disposeGeometry);
    paint.bumpMap!.addEventListener('dispose', disposeTexture);
    car.dispose(); car.dispose();
    expect(disposeMat).toHaveBeenCalledOnce();
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeTexture).not.toHaveBeenCalled();
    g.removeEventListener('dispose', disposeGeometry);
    paint.bumpMap!.removeEventListener('dispose', disposeTexture);
  });
});
