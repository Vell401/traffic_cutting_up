import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildR34Cockpit, R34_CABIN_LAYOUT } from '../src/render/car/r34Cockpit';
import { PlayerCar } from '../src/sim/vehicle';

type Cabin = ReturnType<typeof buildR34Cockpit>;
const live = new Set<Cabin>();
function cabin(): Cabin { const c = buildR34Cockpit(); live.add(c); return c; }
function mesh(c: Cabin, name: string): THREE.Mesh {
  const m = c.group.getObjectByName(name);
  expect(m).toBeInstanceOf(THREE.Mesh);
  return m as THREE.Mesh;
}
function materials(c: Cabin): Set<THREE.Material> {
  const found = new Set<THREE.Material>();
  c.group.traverse(o => { if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) found.add(m); });
  return found;
}
function readouts(c: Cabin): THREE.DataTexture {
  return (mesh(c, 'R34 live MFD').material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
}
function tick(c: Cabin, car: PlayerCar, frames: number): void { for (let i = 0; i < frames; i++) c.update(car, 1 / 60); }
afterEach(() => { live.forEach(c => c.dispose()); live.clear(); vi.unstubAllGlobals(); });

describe('new R34 left-hand-drive cabin', () => {
  it('builds the real geometry and raster resources without document or canvas', () => {
    const createElement = vi.fn(() => { throw new Error('Unexpected DOM dependency'); });
    vi.stubGlobal('document', { createElement });
    const c = cabin();
    expect(createElement).not.toHaveBeenCalled();
    expect(c.eye.position.toArray()).toEqual([-0.36, 1.08, 0.7]);
    const axis = c.group.getObjectByName('R34 inclined steering axis')!;
    expect(axis.position.toArray()).toEqual([-0.36, 0.82, 0.1]);
    expect(axis.rotation.x).toBeCloseTo(-0.42);
    expect(R34_CABIN_LAYOUT.cowlZ).toBe(-0.6);
    expect(c.group.visible).toBe(true);
  });

  it('has a high-detail but merged, finite and indexed geometry budget', () => {
    const c = cabin(); let triangles = 0, draws = 0, invalid = false, leftSeat = 0, rightSeat = 0;
    c.group.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      draws++;
      const g = o.geometry as THREE.BufferGeometry, p = g.getAttribute('position');
      triangles += (g.index?.count ?? p.count) / 3;
      for (const attr of Object.values(g.attributes)) for (let i = 0; i < attr.array.length; i++) if (!Number.isFinite(attr.array[i])) invalid = true;
      if (g.index) for (let i = 0; i < g.index.count; i++) if (g.index.getX(i) >= p.count) invalid = true;
      if (o.name.startsWith('R34 cabin:')) for (let i = 0; i < p.count; i++) {
        if (p.getY(i) > 0.45 && p.getY(i) < 1.25 && p.getZ(i) > 0.3 && p.getZ(i) < 1.13) {
          if (p.getX(i) < -0.15 && p.getX(i) > -0.64) leftSeat++;
          if (p.getX(i) > 0.15 && p.getX(i) < 0.64) rightSeat++;
        }
      }
    });
    expect(invalid).toBe(false);
    expect(triangles).toBeGreaterThan(80000);
    expect(triangles).toBeLessThan(180000);
    expect(draws).toBeLessThanOrEqual(32);
    expect(leftSeat).toBeGreaterThan(10000);
    expect(rightSeat).toBeGreaterThan(10000);
  });

  it('fits the coupe and leaves the forward eye rays and main dial faces unobstructed', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(c.group);
    expect(bounds.min.x).toBeGreaterThan(-0.81); expect(bounds.max.x).toBeLessThan(0.81);
    expect(bounds.min.z).toBeGreaterThan(-0.6); expect(bounds.max.z).toBeLessThan(1.66);
    expect(bounds.min.y).toBeGreaterThan(0.29); expect(bounds.max.y).toBeLessThan(1.345);
    const eye = c.eye.getWorldPosition(new THREE.Vector3());
    for (const direction of [[0, 0, -1], [-0.35, -0.03, -1], [0.35, -0.03, -1], [0, -0.03, -1]]) {
      const ray = new THREE.Raycaster(eye, new THREE.Vector3(...direction).normalize(), 0, 2);
      expect(ray.intersectObject(c.group, true)).toHaveLength(0);
    }
    const cluster = c.group.getObjectByName('R34 three analog instruments')!;
    for (const [x, y] of [[-0.113, 0.034], [0.025, 0.04]]) {
      const target = cluster.localToWorld(new THREE.Vector3(x, y, 0.004)), d = target.sub(eye);
      const hits = new THREE.Raycaster(eye, d.clone().normalize(), 0, d.length() + 0.002).intersectObject(c.group, true);
      expect(hits[0]?.object.name).toBe('R34 cluster:atlas');
    }
  });

  it('animates three needles clockwise with rising values and steers from the actual road-wheel angle', () => {
    const c = cabin(), car = new PlayerCar();
    const names = ['speed', 'tach', 'boost'].map(n => `R34 ${n} needle`);
    const initial = names.map(n => mesh(c, n).rotation.z);
    car.vx = 40; car.rpm = 6500; car.throttle = 1; car.steerIn = 0; car.steerAngle = 0.08;
    tick(c, car, 90);
    names.forEach((n, i) => { expect(mesh(c, n).rotation.z).toBeLessThan(initial[i]); });
    const wheel = c.group.getObjectByName('R34 animated steering wheel')!;
    expect(wheel.rotation.z).toBeLessThan(0);
    expect(wheel.rotation.x).toBe(0); // rotate around inclined column's LOCAL z, not world z.
    expect(wheel.parent!.rotation.x).toBeCloseTo(-0.42);
    car.steerAngle = -0.08; tick(c, car, 90); expect(wheel.rotation.z).toBeGreaterThan(0);
  });

  it('uploads only a small LCD atlas, at 12 Hz, without repainting static textures', () => {
    const c = cabin(), car = new PlayerCar();
    const tex = readouts(c), before = tex.version;
    const atlas = (mesh(c, 'R34 cluster:atlas').material as THREE.MeshBasicMaterial).map!;
    const staticVersion = atlas.version, initialPixels = new Uint8Array(tex.image.data!);
    for (let i = 0; i < 120; i++) { car.vx = i; car.rpm = 900 + i * 35; car.gear = 4; car.throttle = i / 120; c.update(car, 1 / 60); }
    expect(tex.version - before).toBe(24);
    expect(atlas.version).toBe(staticVersion);
    expect(tex.image.width * tex.image.height).toBe(32768);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.image.data).not.toEqual(initialPixels);
    expect(new Set(tex.image.data).size).toBeGreaterThan(25);
  });

  it('does not upload identical readouts and freezes instruments when the cabin or an ancestor is hidden', () => {
    const c = cabin(), car = new PlayerCar(), parent = new THREE.Group(); parent.add(c.group);
    car.rpm = 900;
    tick(c, car, 60);
    const tex = readouts(c), version = tex.version;
    tick(c, car, 10); expect(tex.version).toBe(version);
    const needle = mesh(c, 'R34 tach needle'), angle = needle.rotation.z;
    c.group.visible = false; car.rpm = 7600; car.vx = 20; tick(c, car, 120);
    expect(tex.version).toBe(version); expect(needle.rotation.z).toBe(angle);
    c.group.visible = true; parent.visible = false; tick(c, car, 120);
    expect(tex.version).toBe(version); expect(needle.rotation.z).toBe(angle);
    parent.visible = true; tick(c, car, 10); expect(tex.version).toBeGreaterThan(version);
  });

  it('keeps the physical cabin visible outside while sleeping eye-centric instruments', () => {
    const c = cabin(), car = new PlayerCar(), tex = readouts(c), version = tex.version;
    c.setCockpit!(false);
    expect(c.group.visible).toBe(true);
    expect(mesh(c, 'R34 cabin:dash').visible).toBe(true);
    expect(mesh(c, 'R34 cabin:suede').visible).toBe(true);
    expect(mesh(c, 'R34 cluster:atlas').visible).toBe(true);
    expect(mesh(c, 'R34 live MFD').visible).toBe(false);
    expect(mesh(c, 'R34 speed needle').visible).toBe(false);
    const before = mesh(c, 'R34 tach needle').rotation.z;
    car.rpm = 7000; car.steerAngle = 0.12; tick(c, car, 120);
    expect(tex.version).toBe(version); expect(mesh(c, 'R34 tach needle').rotation.z).toBe(before);
    expect(c.group.getObjectByName('R34 animated steering wheel')!.rotation.z).toBeLessThan(0);
    c.setCockpit!(true); tick(c, car, 6);
    expect(mesh(c, 'R34 live MFD').visible).toBe(true);
    expect(mesh(c, 'R34 speed needle').visible).toBe(true);
    expect(tex.version).toBeGreaterThan(version);
  });

  it('shares immutable geometry/maps but never ghost-fade materials or dynamic LCDs', () => {
    const a = cabin(), b = cabin();
    const ma = mesh(a, 'R34 cabin:leather'), mb = mesh(b, 'R34 cabin:leather');
    expect(ma.geometry).toBe(mb.geometry); expect(ma.material).not.toBe(mb.material);
    const matA = ma.material as THREE.MeshStandardMaterial, matB = mb.material as THREE.MeshStandardMaterial;
    expect(matA.map).toBe(matB.map); expect(readouts(a)).not.toBe(readouts(b));
    materials(a).forEach(m => { m.transparent = true; m.opacity = 0.35; });
    materials(b).forEach(m => { expect(m.opacity).toBe(1); });
    a.setCockpit!(false); a.setCockpit!(true); expect(matA.opacity).toBe(0.35);
    expect(new Set((matA.map as THREE.DataTexture).image.data!).size).toBeGreaterThan(60);
  });

  it('retains model-lifetime shared resources, disposes private resources, and tolerates repeated disposal', () => {
    const a = cabin(), b = cabin(), ma = mesh(a, 'R34 cabin:leather');
    const geo = ma.geometry, map = (ma.material as THREE.MeshStandardMaterial).map!, tex = readouts(a);
    const geoDisposed = vi.fn(), mapDisposed = vi.fn(), texDisposed = vi.fn();
    geo.addEventListener('dispose', geoDisposed); map.addEventListener('dispose', mapDisposed); tex.addEventListener('dispose', texDisposed);
    a.dispose(); a.dispose();
    expect(a.group.children).toHaveLength(0); expect(texDisposed).toHaveBeenCalledTimes(1);
    expect(geoDisposed).not.toHaveBeenCalled(); expect(mapDisposed).not.toHaveBeenCalled();
    const car = new PlayerCar(); car.rpm = 5000; tick(b, car, 6);
    expect(mesh(b, 'R34 cabin:leather').geometry).toBe(geo);
    b.dispose(); expect(geoDisposed).not.toHaveBeenCalled(); expect(mapDisposed).not.toHaveBeenCalled();
    expect(() => { a.update(car, 1); a.setCockpit!(true); }).not.toThrow();
  });

  it('reuses byte-identical procedural textures across complete car replacement', () => {
    const a = cabin();
    const atlasA = (mesh(a, 'R34 cluster:atlas').material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    const expected = new Uint8Array(atlasA.image.data!); a.dispose();
    const b = cabin(), atlasB = (mesh(b, 'R34 cluster:atlas').material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    expect(atlasB).toBe(atlasA); expect(atlasB.image.data).toEqual(expected);
  });
});
