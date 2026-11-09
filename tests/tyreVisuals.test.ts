/// <reference types="node" />
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { PlayerView } from '../src/render/playerView';
import { RemoteCar } from '../src/render/remoteCar';
import { WheelSet, caliper, plainWheel } from '../src/render/car/wheels';
import { buildCar } from '../src/render/car';
import { R34Car } from '../src/sim/vehicleR34';
import { PlayerCar } from '../src/sim/vehicle';
import { Road } from '../src/sim/road';
import { ringScript, RING_LEN } from '../src/sim/ring';
import { mulberry32 } from '../src/core/rng';
import { createTyreFeedback, sampleTyreFeedback } from '../src/presentation/tyres';
import { TyreEffects, TyreEmissionClock, TYRE_EFFECT_BUDGET } from '../src/render/tyreEffects';

const zero = new THREE.Vector3();
const matrix = (mesh: THREE.InstancedMesh, wheel: number): number[] => {
  const m = new THREE.Matrix4(); mesh.getMatrixAt(wheel, m); return m.toArray();
};

describe('independent presentation wheel phases', () => {
  it('animates the real R34 tyre/rim/disc/decal instances independently, never fixed calipers', () => {
    const view = new PlayerView(2, 0x225599, new THREE.Texture(), 4.6, 1.785, false);
    const car = new R34Car(); car.omega.splice(0, 4, 0, 0, 12, 21); car.throttle = 1;
    const tyre = view.root.getObjectByName('R34/wheels/tyre') as THREE.InstancedMesh;
    const rim = view.root.getObjectByName('R34/wheels/rim') as THREE.InstancedMesh;
    const brake = view.root.getObjectByName('R34/wheels/caliper') as THREE.InstancedMesh;
    try {
      view.update(0, car, zero, 0);
      const before = [0, 1, 2, 3].map(i => matrix(tyre, i)), fixed = matrix(brake, 2);
      view.update(.1, car, zero, 0);
      expect(view.wheelAngles).toEqual([0, 0, 1.2000000000000002, 2.1]);
      expect(matrix(tyre, 0)).toEqual(before[0]); expect(matrix(tyre, 1)).toEqual(before[1]);
      expect(matrix(tyre, 2)).not.toEqual(before[2]); expect(matrix(tyre, 3)).not.toEqual(before[3]);
      expect(matrix(rim, 2)).toEqual(matrix(tyre, 2)); expect(matrix(brake, 2)).toEqual(fixed);
      car.vx = 20; car.omega.splice(0, 4, 0, 0, 30, 30); car.steerAngle = .4;
      const locked = [...view.wheelAngles];
      view.update(.1, car, zero, 0);
      expect(view.wheelAngles.slice(0, 2)).toEqual(locked.slice(0, 2));
      const paused = [...view.wheelAngles]; view.update(0, car, zero, 1.5);
      expect(view.wheelAngles).toEqual(paused);
      const contact = view.wheelContact(0, new THREE.Vector3()); view.root.updateMatrixWorld(true);
      view.wheelContact(0, contact);
      expect(contact.x).toBeCloseTo(-.763 * Math.cos(1.5) + 1.35 * Math.sin(1.5), 5);
      expect(contact.y).toBeCloseTo(.018);
    } finally { view.dispose(); }
  });

  it.each([30, 60, 120])('integrates signed omega identically at %i FPS, including hidden/cockpit phases', fps => {
    const view = new PlayerView(2, 0x225599, new THREE.Texture(), 4.6, 1.785, true);
    const car = new R34Car(); car.omega.splice(0, 4, -2, -3, -4, -5); view.setCockpit(true);
    try {
      for (let frame = 0; frame < fps; frame++) view.update(1 / fps, car, zero, 0);
      view.wheelAngles.forEach((angle, i) => expect(angle).toBeCloseTo(-i - 2, 10));
      view.setCockpit(false); view.update(0, car, zero, 0);
      view.wheelAngles.forEach((angle, i) => expect(angle).toBeCloseTo(-i - 2, 10));
    } finally { view.dispose(); }
  });

  it('does not infer remote locks from default dynamics or handbrake, but accepts future explicit omega', () => {
    const view = new PlayerView(2, 0x225599, new THREE.Texture(), 4.6, 1.785, false);
    const car = new R34Car() as R34Car & { visualWheelOmega?: ArrayLike<number> };
    car.vx = 10; car.handbrake = true; car.omega.fill(0);
    try {
      view.update(.1, car, zero, 0, true);
      expect(view.wheelAngles.every(angle => angle > 0)).toBe(true);
      const front = view.wheelAngles[0];
      car.visualWheelOmega = new Float64Array([0, 0, -10, 15]);
      view.update(.1, car, zero, 0, true);
      expect(view.wheelAngles[0]).toBe(front);
      expect(view.wheelAngles[2]).toBeCloseTo(front - 1); expect(view.wheelAngles[3]).toBeCloseTo(front + 1.5);
    } finally { view.dispose(); }
  });

  it.each([1, 2, 3, 4] as const)('uses actual remote road-wheel steering and render-dt phases for model %i', id => {
    const view = new PlayerView(id, 0x225599, new THREE.Texture(), 4.6, 1.9, false, true);
    const car = new R34Car() as R34Car & { visualWheelOmega?: ArrayLike<number> };
    car.visualWheelOmega = new Float64Array([0, 0, 5, -4]);
    car.omega.fill(888); car.wheelSpin = 999; car.steerAngle = .23; car.steerIn = -.9;
    const parts = (view as unknown as { parts: ReturnType<typeof buildCar> }).parts;
    const update = vi.spyOn(parts.wheels, 'update');
    try {
      view.update(.1, car, zero, 0, true);
      expect(update).toHaveBeenLastCalledWith(.23, 0, view.wheelAngles);
      expect(view.wheelAngles).toEqual([0, 0, .5, -.4]);
      view.update(0, car, zero, 1.2, true);
      expect(view.wheelAngles).toEqual([0, 0, .5, -.4]);
      view.update(.1, car, zero, 1.2, true);
      expect(view.wheelAngles).toEqual([0, 0, 1, -.8]);
    } finally { update.mockRestore(); view.dispose(); }
  });

  it('keeps deferred remote detail phases current behind the proxy without hidden-time catch-up', async () => {
    const remote = new RemoteCar(2, 0x225599, new THREE.Texture(), 4.6, 1.785);
    const renderer = { compileAsync: vi.fn().mockResolvedValue(undefined) } as unknown as THREE.WebGLRenderer;
    const car = new R34Car() as R34Car & { visualWheelOmega?: ArrayLike<number> };
    car.visualWheelOmega = new Float64Array([0, 0, 5, -4]); car.wheelSpin = 999;
    try {
      await remote.prepare(renderer, new THREE.PerspectiveCamera(), new THREE.Scene());
      const detail = (remote as unknown as { detail: PlayerView }).detail;
      remote.update(.1, car, zero, 0, 100);
      remote.update(.1, car, zero, 0, 300);
      expect(detail.root.visible).toBe(false); expect(detail.wheelAngles[2]).toBeCloseTo(1);
      remote.update(0, car, zero, 1.2, 100);
      expect(detail.wheelAngles[2]).toBeCloseTo(1);
      remote.update(.1, car, zero, 1.2, 100);
      expect(detail.wheelAngles.slice(0, 2)).toEqual([0, 0]);
      expect(detail.wheelAngles[2]).toBeCloseTo(1.5); expect(detail.wheelAngles[3]).toBeCloseTo(-1.2);
    } finally { remote.dispose(); }
  });

  it('supports per-wheel phases on procedural WheelSet without rolling fixed calipers', () => {
    const geometry = plainWheel(.33, .22), mat = new THREE.MeshBasicMaterial();
    const set = new WheelSet({ ...geometry, fixed: caliper(), tyreMat: mat, rimMat: mat, fixedMat: mat },
      [-1, 1, -1, 1].map((side, i) => ({ x: side * .8, y: .33, z: i < 2 ? -1.3 : 1.3, front: i < 2 })));
    set.update(.3, 0); const fixed = matrix(set.group.children[2] as THREE.InstancedMesh, 0);
    set.update(.3, 5, [0, 1, 2, 3]);
    expect(matrix(set.group.children[2] as THREE.InstancedMesh, 0)).toEqual(fixed);
    expect(matrix(set.group.children[0] as THREE.InstancedMesh, 0)).not.toEqual(matrix(set.group.children[0] as THREE.InstancedMesh, 1));
  });

  it.each([{ id: 1 as const, file: 'porsche-911-irl10.glb' }, { id: 4 as const, file: 'mercedes-w204.glb' }])(
    'forwards phases through the actual protected imported model $file without moving calipers', async ({ id, file }) => {
      const bytes = readFileSync(new URL(`../public/models/${file}`, import.meta.url));
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      loader.register(() => ({ name: 'headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, done) => done(gltf));
      let parts: ReturnType<typeof buildCar> | undefined;
      try {
        parts = buildCar(id, 0x225599, 4.6, 1.9, true); await parts.ready;
        const fixed: { node: THREE.Object3D; rotation: number[] }[] = [];
        parts.wheelRoot.traverse(node => { if (/caliper/i.test(node.name)) fixed.push({ node, rotation: node.quaternion.toArray() }); });
        parts.wheels.update(.25, 99, [0, 0, 1.2, -2.3]);
        for (const [i, corner] of ['FL', 'FR', 'RL', 'RR'].entries()) {
          const wheel = parts.wheelRoot.getObjectByName(`Wheel_${corner}`)!;
          expect(wheel, corner).toBeDefined();
          expect(wheel.parent!.rotation.x).toBeCloseTo(-[0, 0, 1.2, -2.3][i]);
          expect(wheel.parent!.parent!.rotation.y).toBeCloseTo(i < 2 ? -.25 : 0);
        }
        expect(fixed.length).toBeGreaterThan(0);
        for (const item of fixed) expect(item.node.quaternion.toArray()).toEqual(item.rotation);
      } finally { parts?.dispose?.(); load.mockRestore(); }
    }, 30000);

  it('forwards the same FL/FR/RL/RR phases after the actual A45 procedural-to-imported swap', async () => {
    const bytes = readFileSync(new URL('../public/models/mercedes-a45s.glb', import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.register(() => ({ name: 'headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const load = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, done) => done(gltf));
    // The existing A45 lamp halo uses a canvas; wheel geometry/material decoding remains real.
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
    }) }) });
    let parts: ReturnType<typeof buildCar> | undefined;
    try {
      parts = buildCar(3, 0x225599, 4.6, 1.9, true); await parts.ready;
      parts.wheels.update(.2, 0);
      const rest = ['LF', 'RF', 'LR', 'RR'].map(corner => parts!.body.getObjectByName(`WHEEL_${corner}`)!.quaternion.clone());
      const fixed = parts.body.getObjectByName('SUSP_LF')!.quaternion.clone();
      parts.wheels.update(.2, 99, [0, 0, 1.2, -2.3]);
      for (const [i, corner] of ['LF', 'RF', 'LR', 'RR'].entries()) {
        const node = parts.body.getObjectByName(`WHEEL_${corner}`)!;
        const expected = rest[i].clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), [0, 0, 1.2, -2.3][i]));
        // Authored GLB quaternions are float32-rounded. Compare orientations, not raw norms.
        expect(node.quaternion.clone().normalize().angleTo(expected.normalize())).toBeLessThan(1e-6);
      }
      expect(parts.body.getObjectByName('SUSP_LF')!.quaternion.clone().normalize().angleTo(fixed.normalize())).toBeLessThan(1e-6);
      expect(parts.wheelRoot.children).toHaveLength(0);
    } finally { parts?.dispose?.(); load.mockRestore(); vi.unstubAllGlobals(); }
  }, 30000);
});

describe('pooled contact smoke and rubber', () => {
  it('emits at the current front contact and transports steered smoke in that tyre frame', () => {
    const effects = new TyreEffects(), feedback = createTyreFeedback();
    Object.assign(feedback.wheels[0], { normalLoad: 3000, smokeIntensity: 1, slipIntensity: 1,
      contactLongitudinal: 10, longitudinalSlipSpeed: 20 });
    const random = vi.spyOn(Math, 'random').mockReturnValue(.5);
    try {
      effects.emit(1 / 42, feedback, (_i, out) => out.set(12, .018, -34), 0, Math.PI / 2, 0, 0);
      effects.update(.1, 0, 0);
      const centre = effects.smoke.geometry.getAttribute('centre');
      expect(effects.stats.smokeEmitted).toBe(1);
      expect(centre.getX(0)).toBeCloseTo(12 + 1.7 * (1 - Math.exp(-.065)) / .65, 5);
      expect(centre.getZ(0)).toBeCloseTo(-34, 5);
    } finally { random.mockRestore(); effects.dispose(); }
  });

  it.each([30, 60, 120])('emits exactly 84 rear puffs/s at %i FPS, none from stationary front tyres', fps => {
    const effects = new TyreEffects(), car = new R34Car(); car.omega.splice(0, 4, 0, 0, 200, 200);
    const feedback = sampleTyreFeedback(car, createTyreFeedback());
    const contact = (i: number, out: THREE.Vector3) => out.set(i % 2 ? .763 : -.763, .018, i < 2 ? -1.35 : 1.315);
    try {
      expect(feedback.wheels[0].smokeIntensity).toBe(0); expect(feedback.wheels[2].smokeIntensity).toBe(1);
      for (let frame = 0; frame < fps; frame++) { effects.emit(1 / fps, feedback, contact, 0, 0, 0, 0); effects.update(1 / fps, 0, 0); }
      expect(effects.stats.smokeEmitted).toBe(84); expect(effects.stats.marksEmitted).toBe(2);
      const before = effects.stats;
      for (let i = 0; i < 100; i++) { effects.emit(0, feedback, contact, i, .7, 0, 0); effects.update(0, 0, 0); }
      expect(effects.stats).toEqual(before);
      effects.update(3, 1000, -1000); expect(effects.stats.smokeAlive).toBe(0);
    } finally { effects.dispose(); }
  });

  it('has no pedal-only smoke; locks/scrub create grounded bounded marks, not teleport bridges', () => {
    const effects = new TyreEffects(), car = new PlayerCar(); car.throttle = car.brake = 1; car.handbrake = true;
    const feedback = sampleTyreFeedback(car, createTyreFeedback());
    let z = 0;
    const contact = (i: number, out: THREE.Vector3) => out.set(i % 2 ? .8 : -.8, .018, z + (i < 2 ? -1.3 : 1.3));
    try {
      effects.emit(1, feedback, contact, 0, 0, 0, 0); expect(effects.stats.smokeEmitted).toBe(0);
      const locked = new R34Car(); locked.vx = 15; locked.omega.fill(0); sampleTyreFeedback(locked, feedback);
      for (let i = 0; i < 2400; i++) { z -= .25; effects.emit(1 / 60, feedback, contact, .4, .3, 0, 0); effects.update(1 / 60, 0, 0); }
      expect(effects.stats.marksAlive).toBeLessThanOrEqual(TYRE_EFFECT_BUDGET.skids);
      expect(effects.skids.count).toBe(TYRE_EFFECT_BUDGET.skids);
      expect(effects.smoke.geometry.getAttribute('centre').count).toBe(TYRE_EFFECT_BUDGET.smoke);
      const before = effects.stats.marksEmitted; z += 1000;
      effects.emit(1 / 60, feedback, contact, 1.6, 0, 0, 0); expect(effects.stats.marksEmitted).toBe(before);
      effects.resetTrails(); z -= .25; effects.emit(1 / 60, feedback, contact, 0, 0, 0, 0);
      expect(effects.stats.marksEmitted).toBe(before);
      effects.update(25, 0, 0); expect(effects.stats.marksAlive).toBe(0);
      expect(effects.group.children).toHaveLength(2);
    } finally { effects.dispose(); }
  });

  it('rebases smoke/marks at dt=0 without ageing or spawning, and clears ghost trails', () => {
    const effects = new TyreEffects(), car = new R34Car(); car.vx = 15; car.omega.fill(0);
    const feedback = sampleTyreFeedback(car, createTyreFeedback()); let z = 0;
    const contact = (_i: number, out: THREE.Vector3) => out.set(10020, .018, z - 5030);
    try {
      effects.emit(.1, feedback, contact, 1.2, .5, 0, 0); z -= .4;
      effects.emit(.1, feedback, contact, 1.2, .5, 0, 0); effects.update(.05, 0, 0);
      const centres = effects.smoke.geometry.getAttribute('centre'); const x = centres.getX(0), zz = centres.getZ(0);
      const stats = effects.stats; const before = new THREE.Matrix4(); effects.skids.getMatrixAt(0, before);
      effects.update(0, 10000, -5000);
      expect(centres.getX(0)).toBeCloseTo(x - 10000, 2); expect(centres.getZ(0)).toBeCloseTo(zz + 5000, 2);
      const after = new THREE.Matrix4(); effects.skids.getMatrixAt(0, after);
      expect(after.elements[12]).toBeCloseTo(before.elements[12] - 10000); expect(after.elements[13]).toBeCloseTo(.018);
      expect(effects.stats).toEqual(stats);
      effects.emit(.1, feedback, contact, 0, 0, 0, 0, false);
      z -= .4; effects.emit(.1, feedback, contact, 0, 0, 0, 0);
      expect(effects.stats.marksEmitted).toBe(stats.marksEmitted);
    } finally { effects.dispose(); }
  });

  it('keeps fractional emission credit per contact and discards it when contact stops', () => {
    const clock = new TyreEmissionClock(); expect(clock.take(0, 1, 1 / 120)).toBe(0);
    expect(clock.take(0, 0, 1 / 120)).toBe(0); expect(clock.take(0, 1, 1 / 120)).toBe(0);
    expect(clock.take(0, 1, 0)).toBe(0); clock.reset();
    expect(clock.take(0, 1, 1 / 42)).toBe(1);
  });

  it('keeps real R34 contact trails continuous across the road-ring seam and an origin shift', () => {
    const road = new Road(mulberry32(17), ringScript()); road.ensure(RING_LEN - 5, RING_LEN + 5);
    const view = new PlayerView(2, 0x225599, new THREE.Texture(), 4.6, 1.785, false);
    const car = new R34Car(); car.vx = 15; car.omega.fill(0);
    const effects = new TyreEffects(), pt = { x: 0, z: 0, th: 0, k: 0 }, pos = new THREE.Vector3();
    const contact = (i: number, out: THREE.Vector3) => view.wheelContact(i, out);
    try {
      for (let i = 0; i < 4; i++) {
        road.toWorld(RING_LEN - .5 + i * .25, 0, pt);
        const ox = i < 2 ? 0 : 1000, oz = i < 2 ? 0 : -1000;
        view.update(1 / 60, car, pos.set(pt.x - ox, 0, pt.z - oz), pt.th); view.root.updateMatrixWorld(true);
        effects.emit(1 / 60, view.tyreFeedback, contact, pt.th, 0, ox, oz); effects.update(1 / 60, ox, oz);
      }
      expect(effects.stats.marksEmitted).toBe(12);
      for (let i = 0; i < 12; i++) {
        const m = new THREE.Matrix4(); effects.skids.getMatrixAt(i, m);
        expect(new THREE.Vector3().setFromMatrixScale(m).z).toBeLessThan(.4);
        expect(m.elements[13]).toBeCloseTo(.018);
      }
    } finally { effects.dispose(); view.dispose(); }
  });

  it('disposes fixed GPU pools once and cannot emit or age after disposal', () => {
    const effects = new TyreEffects(), scene = new THREE.Scene(); scene.add(effects.group);
    const geometry = vi.spyOn(effects.smoke.geometry, 'dispose'), material = vi.spyOn(effects.smoke.material as THREE.Material, 'dispose');
    effects.dispose(); effects.dispose(); effects.update(1, 0, 0);
    effects.emit(1, createTyreFeedback(), (_i, out) => out.set(0, 0, 0), 0, 0, 0, 0);
    expect(geometry).toHaveBeenCalledTimes(1); expect(material).toHaveBeenCalledTimes(1);
    expect(effects.group.parent).toBeNull(); expect(effects.stats.smokeEmitted).toBe(0);
  });
});
