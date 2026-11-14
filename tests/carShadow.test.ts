import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MIAMI_CAR_SHADOW_LAYER } from '../src/render/miami/carBatching';
import { CarShadowProxy } from '../src/render/miami/carShadow';

const SUN = 1 << MIAMI_CAR_SHADOW_LAYER;
const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** A car in the shape the real builders make: a named body, named wheel pivots, parts under both. */
function car() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = 'MAIN_BODY'; root.add(body);
  const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, x = 0, cast = true) => {
    const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    m.position.x = x; m.castShadow = cast; parent.add(m); return m;
  };
  const shell = mesh(body, new THREE.BoxGeometry(2, 1, 4));
  const trim = new THREE.Group(); body.add(trim);
  const mirror = mesh(trim, new THREE.BoxGeometry(0.2, 0.1, 0.1), 1.1);
  const mirrored = mesh(trim, new THREE.BoxGeometry(0.2, 0.1, 0.1), -1.1); mirrored.scale.x = -1;
  const lens = mesh(body, new THREE.BoxGeometry(0.3, 0.1, 0.1), 0.5, false);
  const wheel = new THREE.Group(); wheel.name = 'WHEEL_LF'; wheel.position.set(0.9, 0.3, 1.3); root.add(wheel);
  const tyre = mesh(wheel, new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12));
  const rim = mesh(wheel, new THREE.CylinderGeometry(0.2, 0.2, 0.22, 8).toNonIndexed());
  root.updateMatrixWorld(true);
  return { root, body, trim, shell, mirror, mirrored, lens, wheel, tyre, rim };
}

describe('car shadow proxies', () => {
  it('merges every caster under its animated pivot into one sun-layer mesh, losing no triangle', () => {
    const c = car();
    const before = [c.shell, c.mirror, c.mirrored, c.lens, c.tyre, c.rim].map(m => ({ mask: m.layers.mask, cast: m.castShadow, geometry: m.geometry, material: m.material }));
    const proxy = new CarShadowProxy(c.root);
    expect(proxy.proxies).toHaveLength(2);
    const [body, wheel] = [c.body, c.wheel].map(parent => proxy.proxies.find(p => p.parent === parent)!);
    expect(triangles(body.geometry)).toBe(triangles(c.shell.geometry) + triangles(c.mirror.geometry) + triangles(c.mirrored.geometry));
    expect(triangles(wheel.geometry)).toBe(triangles(c.tyre.geometry) + triangles(c.rim.geometry));
    for (const p of proxy.proxies) {
      expect(p.castShadow).toBe(true);
      // The sun's shadow camera sees it; the player's camera never does.
      expect(p.layers.mask).toBe(SUN);
      expect(p.layers.test(new THREE.Layers())).toBe(false);
      expect(Object.keys(p.geometry.attributes)).toEqual(['position']);
    }
    // The car itself is exactly as it was.
    for (const [i, m] of [c.shell, c.mirror, c.mirrored, c.lens, c.tyre, c.rim].entries()) {
      expect({ mask: m.layers.mask, cast: m.castShadow, geometry: m.geometry, material: m.material }).toEqual(before[i]);
    }
    // Parts sit where the originals are: the wheel proxy spans the tyre in the wheel's own space.
    wheel.geometry.computeBoundingBox();
    expect(wheel.geometry.boundingBox!.max.x).toBeCloseTo(0.3, 5);
    body.geometry.computeBoundingBox();
    expect(body.geometry.boundingBox!.max.x).toBeCloseTo(1.2, 5);
    expect(body.geometry.boundingBox!.min.x).toBeCloseTo(-1.2, 5);
    proxy.dispose();
    expect(c.body.children.some(o => o.name === 'miami/car-shadow')).toBe(false);
  });

  it('keeps the facing of mirrored parts: their triangles are wound the other way round', () => {
    const c = car();
    // Isolate the two mirrors: the body's side faces also lie at x = +/-1.
    c.shell.castShadow = false;
    const proxy = new CarShadowProxy(c.root);
    const g = proxy.proxies.find(p => p.parent === c.body)!.geometry;
    const p = g.getAttribute('position'), index = g.index!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), centre = new THREE.Vector3();
    // Every triangle of every closed box still faces away from its box's centre.
    let outward = 0, total = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(p, index.getX(i)); b.fromBufferAttribute(p, index.getX(i + 1)); d.fromBufferAttribute(p, index.getX(i + 2));
      const normal = b.clone().sub(a).cross(d.clone().sub(a));
      centre.set(a.x > 0.9 ? 1.1 : a.x < -0.9 ? -1.1 : 0, 0, 0);
      if (Math.abs(a.x) > 0.9 && Math.abs(a.x) < 1.3) { total++; if (normal.dot(a.clone().add(b).add(d).divideScalar(3).sub(centre)) > 0) outward++; }
    }
    expect(total).toBe(24);
    expect(outward).toBe(24);
    proxy.dispose();
  });

  it('follows the pivots for free and rebuilds only when a part between pivot and mesh changes', () => {
    const c = car();
    const proxy = new CarShadowProxy(c.root);
    const first = [...proxy.proxies];
    // Spinning or steering a pivot moves its proxy with it: nothing to rebuild.
    c.wheel.rotation.x = 1.2; c.wheel.updateMatrix(); c.root.rotation.y = 0.4; c.root.updateMatrix();
    for (let i = 0; i < 40; i++) proxy.update();
    expect(proxy.proxies).toEqual(first);
    // Hiding a branch of the body (a camera mode, a damaged part) drops it from the body's shadow.
    c.trim.visible = false; proxy.update();
    const body = proxy.proxies.find(p => p.parent === c.body)!;
    expect(first).not.toContain(body);
    expect(triangles(body.geometry)).toBe(triangles(c.shell.geometry));
    // A part that starts casting is picked up, once the cooldown has passed.
    c.trim.visible = true; c.lens.castShadow = true;
    proxy.update();
    expect(triangles(proxy.proxies.find(p => p.parent === c.body)!.geometry)).toBe(triangles(c.shell.geometry));
    for (let i = 0; i < 31; i++) proxy.update();
    expect(triangles(proxy.proxies.find(p => p.parent === c.body)!.geometry))
      .toBe(triangles(c.shell.geometry) + triangles(c.mirror.geometry) + triangles(c.mirrored.geometry) + triangles(c.lens.geometry));
    proxy.dispose();
  });

  it('puts casters it cannot merge on the sun layer as they are, and takes a restless part out of the merge', () => {
    const c = car();
    const spinners = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
    spinners.castShadow = true; c.body.add(spinners);
    const proxy = new CarShadowProxy(c.root);
    expect(spinners.layers.mask).toBe(1 | SUN);
    expect(triangles(proxy.proxies.find(p => p.parent === c.body)!.geometry)).toBe(triangles(c.shell.geometry) + 2 * triangles(c.mirror.geometry));
    // A mesh that turns out to move on its own under the pivot cannot live in a snapshot.
    c.mirror.position.y = 0.2; c.mirror.updateMatrix(); proxy.update();
    expect(c.mirror.layers.mask).toBe(1 | SUN);
    expect(triangles(proxy.proxies.find(p => p.parent === c.body)!.geometry)).toBe(triangles(c.shell.geometry) + triangles(c.mirrored.geometry));
    // It keeps moving: no further rebuilds.
    const settled = [...proxy.proxies];
    for (let i = 0; i < 80; i++) { c.mirror.position.y += 0.01; c.mirror.updateMatrix(); proxy.update(); }
    expect(proxy.proxies).toEqual(settled);
    proxy.dispose();
    expect(spinners.layers.mask).toBe(1);
    expect(c.mirror.layers.mask).toBe(1);
  });

  it('shares merged geometry between cars of one model and frees it with the last of them', () => {
    const a = car(), b = car();
    // Two views of one model share their source geometry, as the real builders do.
    for (const key of ['shell', 'mirror', 'mirrored', 'lens', 'tyre', 'rim'] as const) b[key].geometry = a[key].geometry;
    const first = new CarShadowProxy(a.root), second = new CarShadowProxy(b.root);
    const body = first.proxies.find(p => p.parent === a.body)!.geometry;
    expect(second.proxies.find(p => p.parent === b.body)!.geometry).toBe(body);
    const dispose = vi.spyOn(body, 'dispose');
    first.dispose(); first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('merges an unknown model per parent node, so nothing it animates can go stale', () => {
    const root = new THREE.Group();
    const axle = new THREE.Group(); root.add(axle);
    const make = (parent: THREE.Object3D) => { const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); m.castShadow = true; parent.add(m); return m; };
    make(root); make(root); make(axle); make(axle);
    root.updateMatrixWorld(true);
    const proxy = new CarShadowProxy(root, undefined);
    expect(proxy.proxies.map(p => p.parent)).toEqual(expect.arrayContaining([root, axle]));
    expect(proxy.proxies).toHaveLength(2);
    axle.rotation.z = 2; axle.updateMatrix();
    const before = [...proxy.proxies];
    for (let i = 0; i < 40; i++) proxy.update();
    expect(proxy.proxies).toEqual(before);
    proxy.dispose();
  });
});
