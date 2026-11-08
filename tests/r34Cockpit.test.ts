import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildR34Cockpit, R34_CABIN_LAYOUT, R34_CABIN_STEERING } from '../src/render/car/r34Cockpit';
import { cabinHeadliner, cabinPillar, cabinRoof, cabinSide, cabinWindshield } from '../src/render/car/r34CabinShell';
import { buildR34Exterior } from '../src/render/car/r34Exterior';
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

  it('has finite indexed geometry without exploding the render budget', () => {
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
    expect(triangles).toBeLessThan(180000);
    expect(draws).toBeLessThanOrEqual(36);
    expect(leftSeat).toBeGreaterThan(10000);
    expect(rightSeat).toBeGreaterThan(10000);
  });

  it('wraps both real A-pillars with a closed section, with no disconnected legacy bars', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const nearest = (m: THREE.Mesh, p: readonly number[]) => {
      const a = m.geometry.getAttribute('position'); let min = Infinity;
      for (let i = 0; i < a.count; i++) min = Math.min(min, Math.hypot(a.getX(i) - p[0], a.getY(i) - p[1], a.getZ(i) - p[2]));
      return min;
    };
    for (const side of [-1, 1]) {
      const trim = mesh(c, `R34 ${side < 0 ? 'left' : 'right'} A-pillar:suede`);
      const p = trim.geometry.getAttribute('position'), uv = trim.geometry.getAttribute('uv');
      // Every actual vertex is within 23mm of the painted strip joining the
      // real windshield edge and side glass, not merely within a loose AABB.
      for (let i = 0; i < p.count; i++) {
        const v = uv.getY(i);
        const front = new THREE.Vector3(...cabinWindshield(side < 0 ? 0.034 : 0.966, v));
        const back = new THREE.Vector3(...cabinSide(side, 0.065, v));
        const point = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
        const closest = new THREE.Line3(front, back).closestPointToPoint(point, true, new THREE.Vector3());
        expect(point.distanceTo(closest)).toBeLessThan(0.031);
      }
      for (let i = 0; i <= 32; i++) {
        const v = i / 32, front = cabinPillar(side, 0, v), back = cabinPillar(side, 0.375, v);
        expect(nearest(trim, front)).toBeLessThan(1e-6);
        expect(nearest(trim, back)).toBeLessThan(1e-6);
        expect(cabinPillar(side, 1, v)).toEqual(front);
      }
      const tip = cabinPillar(side, 0.375, 1);
      expect(nearest(mesh(c, 'R34 roof trim:suede'), tip)).toBeLessThan(0.012);
      // Foot is buried in the cowl/door-top transition rather than suspended.
      const foot = cabinPillar(side, 0, 0);
      expect(nearest(mesh(c, 'R34 cabin:dash'), foot)).toBeLessThan(0.025);
    }
  });

  it('keeps headliner beneath the crowned roof and joins both roof-side trims', () => {
    const c = cabin(), headliner = mesh(c, 'R34 headliner:suede');
    const p = headliner.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      let v = 0.5, u = 0.5;
      for (let n = 0; n < 8; n++) {
        u = (p.getX(i) / (0.657 - 0.007 * Math.sin(v * Math.PI)) + 1) / 2;
        const t = u * 2 - 1, front = 0.18 - 0.035 * (1 - t * t), rear = 1.04 + 0.025 * (1 - t * t);
        v = (p.getZ(i) - front) / (rear - front);
      }
      expect(cabinRoof(u, v)[1] - p.getY(i)).toBeCloseTo(0.014, 5);
      expect(u).toBeGreaterThanOrEqual(0.0079); expect(u).toBeLessThanOrEqual(0.9921);
      expect(v).toBeGreaterThanOrEqual(0.0119); expect(v).toBeLessThanOrEqual(0.9881);
    }
    for (const side of [0, 1]) for (let i = 0; i <= 20; i++) {
      const point = new THREE.Vector3(...cabinHeadliner(side, i / 20));
      expect(Math.abs(point.x)).toBeLessThan(0.647);
    }
  });

  it('fits the actual exterior window apertures, not just a duplicate cabin-only approximation', () => {
    const exterior = buildR34Exterior(0x245cb9);
    try {
      const glazing = exterior.body.getObjectByName('R34/glass') as THREE.Mesh;
      const p = glazing.geometry.getAttribute('position');
      const distance = (point: readonly number[]) => {
        let nearest = Infinity;
        for (let i = 0; i < p.count; i++) nearest = Math.min(nearest, Math.hypot(p.getX(i) - point[0], p.getY(i) - point[1], p.getZ(i) - point[2]));
        return nearest;
      };
      for (const side of [-1, 1]) for (let j = 0; j <= 12; j++) {
        const v = j / 12;
        expect(distance(cabinWindshield(side < 0 ? 0.034 : 0.966, 0.045 + v * 0.9))).toBeLessThan(0.021);
        expect(distance(cabinSide(side, 0.065, 0.045 + v * 0.895))).toBeLessThan(0.021);
      }
    } finally { exterior.dispose(); }
  });

  it('closes the complete instrument surround without holes, white see-through patches or detached walls', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const eye = c.eye.getWorldPosition(new THREE.Vector3()), cluster = c.group.getObjectByName('R34 three analog instruments')!;
    const objects = [mesh(c, 'R34 cabin:dash'), mesh(c, 'R34 binnacle:dash'), mesh(c, 'R34 cluster:black'), mesh(c, 'R34 cluster:atlas')];
    for (let j = 0; j <= 12; j++) for (let i = 0; i <= 24; i++) {
      const target = cluster.localToWorld(new THREE.Vector3(-0.215 + i / 24 * 0.43, -0.107 + j / 12 * 0.177, -0.03));
      const d = target.sub(eye);
      const hits = new THREE.Raycaster(eye, d.clone().normalize(), 0, d.length() + 0.1).intersectObjects(objects, false);
      expect(hits.length, `uncovered binnacle sample ${i},${j}`).toBeGreaterThan(0);
    }
    // Both seams of the molded return terminate on a real supporting skin.
    const ring = mesh(c, 'R34 binnacle:dash').geometry, pos = ring.getAttribute('position'), uv = ring.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0); expect(uv.getY(i)).toBeLessThanOrEqual(1);
      if (i % 129 !== 0) {
        expect(new THREE.Vector3().fromBufferAttribute(pos, i).distanceTo(new THREE.Vector3().fromBufferAttribute(pos, i - 1))).toBeLessThan(0.045);
      }
    }
  });

  it('leaves the windshield and side-glass interiors free of a second set of bars', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const eye = c.eye.getWorldPosition(new THREE.Vector3());
    const targets: THREE.Vector3[] = [];
    // Skip the mirror's deliberately occupied upper-middle patch.
    for (const u of [0.17, 0.3, 0.43, 0.65, 0.83]) for (const v of [0.35, 0.55, 0.7]) targets.push(new THREE.Vector3(...cabinWindshield(u, v)));
    for (const side of [-1, 1]) for (const u of [0.2, 0.4, 0.52]) for (const v of [0.3, 0.5, 0.7]) targets.push(new THREE.Vector3(...cabinSide(side, u, v)));
    for (const target of targets) {
      const d = target.sub(eye);
      const hits = new THREE.Raycaster(eye, d.clone().normalize(), 0, d.length() + 0.002).intersectObject(c.group, true);
      expect(hits.map(h => h.object.name)).toEqual([]);
    }
  });

  it('fits the LCD inside a supported recess without overlapping the tach or wheel hub', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const eye = c.eye.getWorldPosition(new THREE.Vector3()), screen = mesh(c, 'R34 odometer gear speed display');
    expect(screen.position.y + 0.028125 / 2).toBeLessThan(-0.065);
    for (const x of [-0.068, 0, 0.068]) for (const y of [-0.01, 0, 0.01]) {
      const target = screen.localToWorld(new THREE.Vector3(x, y, 0));
      const d = target.sub(eye);
      const hits = new THREE.Raycaster(eye, d.clone().normalize(), 0, d.length() + 0.001).intersectObject(c.group, true);
      expect(hits[0]?.object.name).toBe(screen.name);
    }
  });

  it('fits the coupe and leaves the forward eye rays and main dial faces unobstructed', () => {
    const c = cabin(); c.group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(c.group);
    expect(bounds.min.x).toBeGreaterThan(-0.81); expect(bounds.max.x).toBeLessThan(0.81);
    expect(bounds.min.z).toBeGreaterThan(-0.725); expect(bounds.max.z).toBeLessThan(1.68);
    expect(bounds.min.y).toBeGreaterThan(0.29); expect(bounds.max.y).toBeLessThan(1.355);
    const eye = c.eye.getWorldPosition(new THREE.Vector3());
    for (const direction of [[0, 0, -1], [-0.2, -0.03, -1], [0.35, -0.03, -1], [0, -0.03, -1]]) {
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

  it('follows large physical opposite lock monotonically up to 540 degrees, never wrapping at PI', () => {
    const c = cabin(), car = new PlayerCar(), wheel = c.group.getObjectByName('R34 animated steering wheel')!;
    let previous = 0;
    for (const angle of [0.1, 0.3, 0.5, 0.7, 0.95]) {
      car.steerIn = -1; // deliberate mismatch: no input-based steering animation
      car.steerAngle = angle; tick(c, car, 90);
      expect(wheel.rotation.z).toBeLessThan(previous);
      expect(wheel.rotation.z).toBeCloseTo(-Math.min(angle * R34_CABIN_STEERING.ratio, Math.PI * 3), 5);
      previous = wheel.rotation.z;
    }
    expect(wheel.rotation.z).toBeCloseTo(-Math.PI * 3, 5);
    car.steerAngle = -0.95; tick(c, car, 90);
    expect(wheel.rotation.z).toBeCloseTo(Math.PI * 3, 5);
    car.steerAngle = 0; tick(c, car, 90); expect(wheel.rotation.z).toBeCloseTo(0, 5);
    car.steerAngle = Number.NaN; c.update(car, Number.NaN); expect(Number.isFinite(wheel.rotation.z)).toBe(true);
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

  it('accumulates chase-view mileage without LCD uploads, then presents the same odometer as cockpit driving', () => {
    const a = cabin(), b = cabin(), car = new PlayerCar(); car.vx = 36; car.gear = 3;
    a.setCockpit(false); const version = readouts(a).version;
    tick(a, car, 600); tick(b, car, 600);
    expect(readouts(a).version).toBe(version);
    a.setCockpit(true); tick(a, car, 6); tick(b, car, 6);
    // The odometer is the first raster line; transient oil/boost damping differs
    // when the LCD sleeps, but distance must not.
    const line = (c: Cabin) => new Uint8Array(readouts(c).image.data!.buffer, 0, 256 * 14 * 4);
    expect(line(a)).toEqual(line(b));
  });

  it('uses shared linear normal/roughness maps, with independently fadeable per-car materials', () => {
    const a = cabin(), b = cabin();
    for (const finish of ['dash', 'leather', 'suede', 'carpet', 'metal', 'plastic']) {
      const ma = mesh(a, `R34 cabin:${finish}`).material as THREE.MeshStandardMaterial;
      const mb = mesh(b, `R34 cabin:${finish}`).material as THREE.MeshStandardMaterial;
      expect(ma.normalMap).toBeTruthy(); expect(ma.roughnessMap).toBeTruthy();
      expect(ma.normalMap).toBe(mb.normalMap); expect(ma.roughnessMap).toBe(mb.roughnessMap);
      expect(ma.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
      expect(ma.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
      expect(ma.map!.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(ma.bumpMap).toBeNull();
    }
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
