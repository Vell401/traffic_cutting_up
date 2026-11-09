/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { createW204, preloadW204, W204_NAME } from '../src/render/car/w204';
import type { ModelLoad } from '../src/render/car';
import type { PlayerCar } from '../src/sim/vehicle';

const bytes = readFileSync(new URL('../public/models/mercedes-w204.glb', import.meta.url));
const asset = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
let gltf: GLTF;
const load = vi.spyOn(GLTFLoader.prototype, 'load');
const position = (node: THREE.Object3D): number[] => node.getWorldPosition(new THREE.Vector3()).toArray();
function close(actual: number[], expected: number[]): void {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 5));
}
function materials(root: THREE.Object3D): Map<string, THREE.MeshStandardMaterial> {
  const result = new Map<string, THREE.MeshStandardMaterial>();
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) for (const mat of [mesh.material].flat()) result.set(mat.name, mat as THREE.MeshStandardMaterial);
  });
  return result;
}

beforeAll(async () => {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // Headless tests parse/decode real geometry and materials. Only browser image decoding is stubbed.
  loader.register(() => ({ name: 'headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
});
afterAll(() => load.mockRestore());

describe('W204 delivered GLB and runtime adapter', () => {
  it('parses the complete Meshopt asset, preserves root and authored anchors, and checks decoded indices', () => {
    expect(asset.extensionsRequired).toContain('EXT_meshopt_compression');
    expect(asset.images.length).toBeGreaterThanOrEqual(60);
    expect(asset.nodes.length).toBe(102);
    const root = gltf.scene.getObjectByName('Mercedes_W204')!;
    expect(Math.abs(root.quaternion.y)).toBeCloseTo(1);
    const anchors: Record<string, number[]> = {
      Wheel_FL: [-.745,.33,-1.4], Wheel_FR: [.745,.33,-1.4],
      Wheel_RL: [-.730,.33,1.295], Wheel_RR: [.730,.33,1.295],
      SteeringWheel: [-.343852401,.926682830,-.298687190], CockpitCamera: [-.344,1.16,.17],
    };
    gltf.scene.updateMatrixWorld(true);
    for (const [name, anchor] of Object.entries(anchors)) close(position(gltf.scene.getObjectByName(name)!), anchor);
    let triangles = 0;
    gltf.scene.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const index = mesh.geometry.index!;
      triangles += index.count / 3;
      let max = 0;
      for (let i = 0; i < index.count; i++) max = Math.max(max, index.getX(i));
      expect(max).toBeLessThan(mesh.geometry.getAttribute('position').count);
    });
    expect(triangles).toBe(234632);
    const wheel = gltf.scene.getObjectByName('SteeringWheel')!;
    close(new THREE.Vector3(0,1,0).applyQuaternion(wheel.getWorldQuaternion(new THREE.Quaternion())).toArray(), [0,.390400112,.920645297]);
    for (const corner of ['FL','FR','RL','RR']) {
      const wheel = gltf.scene.getObjectByName(`Wheel_${corner}`)!;
      expect(wheel.children.map(n => n.name)).toEqual([`Wheel_${corner}_Rim`, `Wheel_${corner}_Tyre`]);
      expect(wheel.getObjectByName(`Wheel_${corner}_BrakeDisc`)).toBeUndefined();
      const size = new THREE.Box3().setFromObject(wheel.getObjectByName(`Wheel_${corner}_Tyre`)!).getSize(new THREE.Vector3());
      expect(size.y / 2).toBeCloseTo(.325, 2);
    }
  });

  it('ships restored source normals, untinted atlases, clearcoat paint and separate masked lamps', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/models/mercedes-w204.manifest.json', import.meta.url), 'utf8'));
    expect(manifest.normalVerification.passed).toBe(true);
    expect(manifest.normalVerification.deliveredSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(manifest.normalVerification.panelCount).toBe(10);
    expect(manifest.normalVerification.authoredCornersVerified).toBeGreaterThan(240000);
    for (const panel of manifest.normalVerification.panels) expect(panel.normalMaxErrorDegrees).toBeLessThan(1);
    const find = (name: string): any => asset.materials.find((mat: any) => mat.name === name);
    const head = find('c63w204kene_c63_hl_PBR');
    expect(head.pbrMetallicRoughness.baseColorTexture).toBeDefined();
    expect(head.pbrMetallicRoughness.baseColorFactor ?? [1,1,1,1]).toEqual([1,1,1,1]);
    const paint = find('W204_BodyPaint');
    expect(paint.occlusionTexture).toBeDefined();
    expect(paint.extensions.KHR_materials_clearcoat.clearcoatFactor).toBe(1);
    expect(paint.extensions.KHR_materials_clearcoat.clearcoatRoughnessFactor).toBeCloseTo(.03);
    for (const name of ['c63_hl', 'c63_hl_running', 'c63_hl_signal_l', 'c63_hl_signal_r', 'c63_taillights_stop', 'c63_taillights_reverse', 'c63_taillights_lowhighbeam', 'signal_L_mirrors', 'signal_R_mirrors', 'c63_interior_dash']) {
      expect(find(`c63w204kene_${name}_PBR`).emissiveTexture, name).toBeDefined();
    }
    for (const side of ['L', 'R']) expect(find(`c63w204kene_signal_${side}_mirrors_PBR`).pbrMetallicRoughness.roughnessFactor).toBeCloseTo(.352);
    for (const mesh of asset.meshes) for (const primitive of mesh.primitives) {
      expect(primitive.attributes.NORMAL).toBeDefined();
      const mat = asset.materials[primitive.material];
      for (const texture of [mat.occlusionTexture, mat.emissiveTexture, mat.normalTexture, mat.pbrMetallicRoughness?.baseColorTexture, mat.pbrMetallicRoughness?.metallicRoughnessTexture]) {
        if (texture) expect(primitive.attributes[`TEXCOORD_${texture.texCoord ?? 0}`]).toBeDefined();
      }
    }
  });

  it('retries failures, coalesces concurrent loads and reports progress to every caller', async () => {
    load.mockImplementationOnce((_url, _done, _progress, fail) => { fail!({ message: 'offline' } as ErrorEvent); });
    const failed: ModelLoad[] = [];
    await expect(preloadW204(s => failed.push(s))).rejects.toMatchObject({ message: 'offline' });
    expect(failed.at(-1)).toMatchObject({ name: W204_NAME, failed: true, done: false });
    load.mockImplementation((_url, done, progress) => {
      progress!({ loaded: bytes.length, total: bytes.length, lengthComputable: true } as ProgressEvent);
      done(gltf);
    });
    const a: ModelLoad[] = [], b: ModelLoad[] = [];
    const first = preloadW204(s => a.push(s)), second = preloadW204(s => b.push(s));
    expect(first).toBe(second);
    await first;
    expect(load).toHaveBeenCalledTimes(2);
    for (const events of [a,b]) {
      expect(events.some(s => s.unpacking)).toBe(true);
      expect(events.at(-1)).toMatchObject({ name: W204_NAME, done: true, failed: false, loaded: bytes.length });
    }
    await preloadW204();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('preserves bind matrices, rolls around world X, steers front brakes separately and resets exactly', async () => {
    const car = createW204(0x123456, true, true);
    await car.ready;
    const before = new Map<string, THREE.Matrix4>();
    const root = new THREE.Group(); root.add(car.body, car.wheelRoot); root.updateMatrixWorld(true);
    gltf.scene.traverse(node => {
      if (node.name) before.set(node.name, node.matrixWorld.clone());
    });
    for (const [name, matrix] of before) {
      const node = root.getObjectByName(name);
      if (node) node.matrixWorld.elements.forEach((v,i) => expect(v).toBeCloseTo(matrix.elements[i], 5));
    }
    const wheel = root.getObjectByName('Wheel_FL')!, brake = root.getObjectByName('Wheel_FL_BrakeDisc')!;
    const caliper = root.getObjectByName('brake_caliper_6pot_red_amg_Selected')!;
    expect(brake.parent).toBe(wheel.parent!.parent);
    expect(caliper.parent!.name).toBe('W204_Steer_FR'); // Source suffix is not the runtime side.
    const origin = new THREE.Vector3(-.745,.33,-1.4);
    const rest = wheel.getWorldQuaternion(new THREE.Quaternion());
    const brakeRest = brake.getWorldQuaternion(new THREE.Quaternion());
    car.wheels.update(.3, 1.2); root.updateMatrixWorld(true);
    close(position(wheel), origin.toArray());
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -.3)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -1.2)).multiply(rest);
    expect(wheel.getWorldQuaternion(new THREE.Quaternion()).angleTo(expected)).toBeLessThan(1e-6);
    const expectedBrake = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -.3).multiply(brakeRest);
    expect(brake.getWorldQuaternion(new THREE.Quaternion()).angleTo(expectedBrake)).toBeLessThan(1e-6);
    car.wheels.update(0,0); root.updateMatrixWorld(true);
    expect(wheel.getWorldQuaternion(new THREE.Quaternion()).angleTo(rest)).toBeLessThan(1e-6);
    close(position(car.cockpit!.eye), [-.344,1.16,.17]);
    const steering = root.getObjectByName('SteeringWheel')!, steeringRest = steering.quaternion.clone();
    car.updateCabin!({ steerAngle: .1, steerIn: .2 } as PlayerCar, 1);
    const delta = steeringRest.clone().invert().multiply(steering.quaternion);
    expect(Math.abs(delta.y)).toBeGreaterThan(.1); expect(delta.x).toBeCloseTo(0); expect(delta.z).toBeCloseTo(0);
    close(position(steering), [-.343852401,.926682830,-.298687190]);
    car.dispose!();
  });

  it.each([
    { direction: 'right', steerAngle: .1, steerIn: .2, target: 1.35 },
    { direction: 'left', steerAngle: -.1, steerIn: -.2, target: -1.35 },
    { direction: 'right input-dominant', steerAngle: .01, steerIn: .8, target: 1.4 },
    { direction: 'left input-dominant', steerAngle: -.01, steerIn: -.8, target: -1.4 },
  ])('turns the exported cockpit wheel $direction and returns to its authored rest', async ({ steerAngle, steerIn, target }) => {
    const car = createW204(0xffffff, true, true);
    await car.ready;
    try {
      const steering = car.body.getObjectByName('SteeringWheel')!;
      const rest = steering.quaternion.clone(), origin = position(steering);
      const axis = new THREE.Vector3(0, 1, 0);
      const input = { steerAngle, steerIn } as PlayerCar;
      car.updateCabin!(input, .05);
      // Authored local +Y points toward the driver: right input must rotate clockwise (-Y).
      const delta = rest.clone().invert().multiply(steering.quaternion);
      expect(Math.sign(delta.y)).toBe(-Math.sign(target));
      const expected = rest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, -target * (1 - Math.exp(-14 * .05))));
      // GLB quaternion components are rounded; compare orientation without changing authored data.
      expect(steering.quaternion.clone().normalize().angleTo(expected.normalize())).toBeLessThan(1e-6);
      for (let i = 0; i < 120; i++) car.updateCabin!(input, 1 / 60);
      expected.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(axis, -target));
      expect(steering.quaternion.clone().normalize().angleTo(expected.normalize())).toBeLessThan(1e-6);
      for (let i = 0; i < 120; i++) car.updateCabin!({ steerAngle: 0, steerIn: 0 } as PlayerCar, 1 / 60);
      expect(steering.quaternion.clone().normalize().angleTo(rest.clone().normalize())).toBeLessThan(1e-6);
      close(position(steering), origin);
    } finally {
      car.dispose!();
    }
  });

  it('isolates paint, ghost, signals, brake lights and cabin visibility and disposes only owned resources once', async () => {
    const a = createW204(0xff0000,true,true), b = createW204(0x00ff00,false,true);
    a.setCockpit!(true); a.setPaint(0x123456);
    await Promise.all([a.ready,b.ready]);
    const ma = materials(a.body), mb = materials(b.body), source = materials(gltf.scene);
    expect(ma.get('W204_BodyPaint')!.color.getHex()).toBe(0x123456);
    expect(mb.get('W204_BodyPaint')!.color.getHex()).toBe(0x00ff00);
    for (const [name, mat] of ma) {
      expect(mat).not.toBe(mb.get(name)); expect(mat).not.toBe(source.get(name));
      expect(mat.userData.shared).not.toBe(true);
      mat.opacity *= .35;
      expect(mb.get(name)!.opacity).toBe(source.get(name)!.opacity);
    }
    a.indicators.set(true,false,true);
    expect(ma.get('c63w204kene_c63_hl_signal_l_PBR')!.emissive.r).toBeGreaterThan(1);
    expect(ma.get('c63w204kene_c63_hl_signal_r_PBR')!.emissive.r).toBeLessThan(.1);
    expect(ma.get('c63w204kene_c63_taillights_stop_PBR')!.emissive.r).toBe(4);
    expect(ma.get('c63w204kene_c63_hl_running_PBR')!.emissive.r).toBe(2);
    expect(ma.get('c63w204kene_c63_hl_PBR')!.emissive.r).toBe(2);
    expect(ma.get('c63w204kene_c63_interior_dash_PBR')!.emissive.r).toBe(.25);
    expect(ma.get('c63w204kene_c63_interior_dash_PBR')!.emissiveMap).not.toBeNull();
    expect(mb.get('c63w204kene_c63_hl_signal_l_PBR')!.emissive.r).toBeLessThan(.1);
    const glass = a.body.getObjectByName('c63w204kene_windshield_Selected')!;
    expect(glass.visible).toBe(false);
    expect(a.body.getObjectByName('c63w204kene_dash_Selected')!.visible).toBe(true);
    a.setCockpit!(false); expect(glass.visible).toBe(true);
    const ownedDispose = vi.fn(), sharedDispose = vi.fn();
    for (const mat of a.managedMaterials!) mat.addEventListener('dispose',ownedDispose);
    for (const mat of source.values()) mat.addEventListener('dispose',sharedDispose);
    a.dispose!(); a.dispose!();
    expect(ownedDispose).toHaveBeenCalledTimes(a.managedMaterials!.size);
    expect(sharedDispose).not.toHaveBeenCalled();
    expect(b.body.children.length).toBeGreaterThan(0);
    b.dispose!();
  });

  it('does not load warm-up spares or attach models after disposal', async () => {
    const calls = load.mock.calls.length;
    const spare = createW204(0xffffff,true,false);
    await spare.ready;
    expect(load.mock.calls.length).toBe(calls); expect(spare.cockpit).toBeNull();
    const cancelled = createW204(0xffffff,false,true);
    cancelled.dispose!(); await cancelled.ready;
    expect(cancelled.body.children).toHaveLength(0); expect(cancelled.wheelRoot.children).toHaveLength(0);
    spare.dispose!();
  });
});
