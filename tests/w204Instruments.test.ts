/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { W204Cockpit } from '../src/render/car/w204Cockpit';
import { W204_ASSIST_LAMP, W204_READOUT, w204AssistState } from '../src/render/car/w204Instruments';
import { PlayerView } from '../src/render/playerView';
import { W204Car } from '../src/sim/vehicleW204';
import { PlayerCar } from '../src/sim/vehicle';

let source: THREE.Group;
const live: W204Cockpit[] = [];
const meshWith = (model: THREE.Object3D, name: string): THREE.Mesh => {
  let result: THREE.Mesh | undefined;
  model.traverse(node => { const m = node as THREE.Mesh; if (m.isMesh && !Array.isArray(m.material) && m.material.name === name) result = m; });
  expect(result).toBeDefined(); return result!;
};
const material = (model: THREE.Object3D, name: string) => meshWith(model, name).material as THREE.MeshBasicMaterial;
const display = (model: THREE.Object3D) => material(model, 'c63w204kene_gauges_screen_PBR').map as THREE.DataTexture;
const needle = (model: THREE.Object3D, suffix: string) => model.getObjectByName(`c63w204kene_needle_${suffix}_Selected`)!;
const direction = (node: THREE.Object3D, axis = new THREE.Vector3(0,0,1)) => axis.applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize();
function cabin(): { cockpit: W204Cockpit; model: THREE.Group; body: THREE.Group } {
  const body = new THREE.Group(), cockpit = new W204Cockpit(body), model = source.clone(true);
  model.updateMatrixWorld(true); cockpit.attach(model); body.add(model); live.push(cockpit);
  return { cockpit, model, body };
}
function tick(c: W204Cockpit, car: W204Car, frames = 120): void { for (let i = 0; i < frames; i++) c.update(car, 1/60); }
beforeAll(async () => {
  const bytes = readFileSync(new URL('../public/models/mercedes-w204.glb', import.meta.url));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register(() => ({ name: 'headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  source = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
});
afterEach(() => { live.forEach(c => c.dispose()); live.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('W204 authored live instruments', () => {
  it('retains the real cluster and mounting geometry without a DOM dependency or shared edits', () => {
    const createElement = vi.fn(() => { throw new Error('Unexpected canvas'); }); vi.stubGlobal('document', { createElement });
    const { model } = cabin();
    expect(createElement).not.toHaveBeenCalled();
    for (const suffix of ['speedo', 'tacho']) {
      const a = needle(model, suffix), b = needle(source, suffix);
      expect(a.position).toEqual(b.position); expect(a.quaternion.toArray()).toEqual(b.quaternion.toArray());
      expect(a.children.length).toBe(b.children.length);
    }
    const name = 'c63w204kene_gauges_screen_PBR', a = meshWith(model, name), b = meshWith(source, name);
    expect(a.geometry).not.toBe(b.geometry); expect(a.material).not.toBe(b.material);
    expect(a.geometry.getAttribute('position').array).toEqual(b.geometry.getAttribute('position').array);
    expect(a.geometry.getAttribute('uv').array).not.toEqual(b.geometry.getAttribute('uv').array);
    expect(display(model).image.width).toBe(W204_READOUT.width); expect(display(model).image.height).toBe(W204_READOUT.height);
    expect(display(model).generateMipmaps).toBe(false); expect(display(model).colorSpace).toBe(THREE.SRGBColorSpace);
    expect(meshWith(model, 'abs_PBR').visible).toBe(false); expect(meshWith(source, 'abs_PBR').visible).toBe(true);
  });

  it('calibrates both stock needles into the dial plane and sweeps clockwise from zero to full scale', () => {
    const { cockpit, model } = cabin(), car = new W204Car(); car.rpm = 0;
    const speed = needle(model, 'speedo'), tach = needle(model, 'tacho');
    const positions = [speed.position.clone(), tach.position.clone()];
    cockpit.update(car, 0); const zero = [direction(speed), direction(tach)];
    expect(zero[0].x).toBeCloseTo(-Math.sqrt(3)/2, 3); expect(zero[0].y).toBeCloseTo(-.5, 2);
    expect(zero[1].x).toBeCloseTo(-Math.SQRT1_2, 3); expect(zero[1].y).toBeCloseTo(-Math.SQRT1_2, 2);
    const normals = [direction(speed, new THREE.Vector3(0,1,0)), direction(tach, new THREE.Vector3(0,1,0))];
    car.vx = 160/3.6; car.rpm = 4000; tick(cockpit, car);
    for (const n of [speed, tach]) { expect(direction(n).y).toBeGreaterThan(.995); expect(Math.abs(direction(n).x)).toBeLessThan(.002); }
    car.vx = 600/3.6; car.rpm = 12000; tick(cockpit, car);
    expect(direction(speed).x).toBeCloseTo(Math.sqrt(3)/2,3); expect(direction(speed).y).toBeCloseTo(-.5,2);
    expect(direction(tach).x).toBeCloseTo(Math.SQRT1_2,3); expect(direction(tach).y).toBeCloseTo(-Math.SQRT1_2,2);
    [speed, tach].forEach((n,i) => {
      expect(n.position).toEqual(positions[i]); expect(direction(n,new THREE.Vector3(0,1,0)).distanceTo(normals[i])).toBeLessThan(1e-5);
    });
    car.vx = 0; car.rpm = 0; tick(cockpit, car);
    expect(direction(speed).distanceTo(zero[0])).toBeLessThan(1e-5); expect(direction(tach).distanceTo(zero[1])).toBeLessThan(1e-5);
  });

  it('shows total speed in reverse/drift, real gear/mode and updates only the tiny changed readout at 12 Hz', () => {
    const { cockpit, model } = cabin(), car = new W204Car(), texture = display(model), initial = texture.version;
    for (let i = 0; i < 120; i++) { car.vx = i; car.rpm = 900+i*30; cockpit.update(car, 1/60); }
    expect(texture.version-initial).toBeGreaterThan(15); expect(texture.version-initial).toBeLessThanOrEqual(24);
    tick(cockpit,car,10); const stable = texture.version; tick(cockpit,car,10); expect(texture.version).toBe(stable);
    const pixels = new Uint8Array(texture.image.data!);
    car.manual = true; car.gear = 3; tick(cockpit,car,6); expect(texture.image.data).not.toEqual(pixels);
    car.vx = -40; car.vy = 30; car.gear = 0; tick(cockpit,car);
    // hypot(40,30) = 50 m/s = 180 km/h, not signed forward/road-progress speed.
    const d = direction(needle(model,'speedo'));
    expect(d.x).toBeCloseTo(Math.cos(-Math.PI*19/12),3); expect(d.y).toBeCloseTo(Math.sin(-Math.PI*19/12),2);
    const reverse = new Uint8Array(texture.image.data!); car.gear = -1; tick(cockpit,car,6); expect(texture.image.data).not.toEqual(reverse);
  });

  it('sleeps hidden instruments while retaining wheel animation, including hidden ancestors', () => {
    const { cockpit, model, body } = cabin(), car = new W204Car(); tick(cockpit,car,6);
    const texture = display(model), version = texture.version, angle = needle(model,'tacho').quaternion.clone();
    cockpit.group.visible = false; car.vx = 50; car.rpm = 7000; car.steerAngle = .1; tick(cockpit,car);
    expect(texture.version).toBe(version); expect(needle(model,'tacho').quaternion.toArray()).toEqual(angle.toArray());
    expect(model.getObjectByName('SteeringWheel')!.quaternion.toArray()).not.toEqual(source.getObjectByName('SteeringWheel')!.quaternion.toArray());
    cockpit.group.visible = true; body.visible = false; tick(cockpit,car); expect(texture.version).toBe(version);
    body.visible = true; tick(cockpit,car,6); expect(texture.version).toBeGreaterThan(version);
  });

  it('uses explicit exterior relay state and beam/handbrake telemetry rather than grey fallback symbols', () => {
    const { cockpit, model } = cabin(), car = new W204Car(); car.blinker = 1; car.handbrake = true;
    cockpit.setSignals(false,true); cockpit.setHighBeam(true); cockpit.update(car,1/60);
    expect(material(model,'signal_L_PBR').color.getHex()).toBe(0x030803);
    expect(material(model,'signal_R_PBR').color.getHex()).toBe(0x79e76e);
    expect(material(model,'highbeam_PBR').color.getHex()).toBe(0x4b93ff);
    expect(material(model,'parkingbrake_PBR').color.getHex()).toBe(0xf0442c);
    expect(material(model,'signal_R_PBR').alphaTest).toBeGreaterThan(0);
    cockpit.setSignals(false,false); cockpit.setHighBeam(false); car.handbrake = false; cockpit.update(car,1/60);
    expect(material(model,'highbeam_PBR').color.getHex()).toBe(0x010204);
    expect(material(model,'lowbeam_PBR').color.getHex()).toBe(0x75d669);
    expect(material(model,'parkingbrake_PBR').color.getHex()).toBe(0x080201);
  });

  it('shows steady yellow OFF, flashes measured ESP/TC wheel-slip activity and keeps armed systems dark', () => {
    const { cockpit, model } = cabin(), car = new W204Car();
    const tc = material(model,'tcs_PBR'), esp = material(model,'esc_PBR');
    cockpit.update(car,1/60);
    expect(meshWith(model,'tcs_PBR').visible).toBe(true); expect(meshWith(model,'esc_PBR').visible).toBe(true);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.dark); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.dark);
    const tcIcon = tc.map!, espIcon = esp.map!;
    car.tractionControlEnabled = false; car.espEnabled = false;
    tick(cockpit,car,40);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.on); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.on);
    expect(tc.userData.assistState).toBe('off'); expect(esp.userData.assistState).toBe('off');
    expect(tc.map).not.toBe(tcIcon); expect(esp.map).not.toBe(espIcon);
    expect((tc.map as THREE.DataTexture).image.data).not.toEqual((tcIcon as THREE.DataTexture).image.data);
    car.tractionControlEnabled = true; car.espEnabled = true;
    car.throttle = 1; car.rpm = 3000; car.gear = 2; car.slipRear = car.tune.tcSlip + .08; car.esc = .4;
    cockpit.update(car,1/60);
    expect(tc.map).toBe(tcIcon); expect(esp.map).toBe(espIcon);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.on); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.on);
    expect(tc.userData.assistState).toBe('active'); expect(esp.userData.assistState).toBe('active');
    tick(cockpit,car,18);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.dark); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.dark);
    tick(cockpit,car,14);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.on); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.on);
    expect(tcIcon.version).toBe(1); expect(espIcon.version).toBe(1);
    car.slipRear = 0; car.esc = 0; cockpit.update(car,1/60);
    expect(tc.color.getHex()).toBe(W204_ASSIST_LAMP.dark); expect(esp.color.getHex()).toBe(W204_ASSIST_LAMP.dark);
    expect(meshWith(model,'abs_PBR').visible).toBe(false);
  });

  it('does not infer TC from braking/coasting/handbrake/neutral/reverse/shift/limiter slip or ESP from yaw slip alone', () => {
    const car = new W204Car(); car.throttle = 1; car.rpm = 3000; car.gear = 2; car.slipRear = car.tune.tcSlip + .08;
    expect(w204AssistState(car)).toMatchObject({tcOff:false,tcActive:true,espOff:false,espActive:false});
    for (const patch of [{throttle:0},{brake:.4},{handbrake:true},{gear:-1},{gear:0},{shiftT:.1},{rpm:car.tune.redline},{slipRear:-.5}]) {
      const original = Object.fromEntries(Object.keys(patch).map(k => [k,car[k as keyof W204Car]]));
      Object.assign(car,patch); expect(w204AssistState(car).tcActive).toBe(false); Object.assign(car,original);
    }
    car.slipRear = car.tune.tcSlip; expect(w204AssistState(car).tcActive).toBe(false);
    car.slipAngleRear = .8; expect(w204AssistState(car).espActive).toBe(false);
    car.esc = .25; expect(w204AssistState(car).espActive).toBe(true);
    car.espEnabled = false; expect(w204AssistState(car)).toMatchObject({espOff:true,espActive:false});
    car.tractionControlEnabled = false; car.slipRear = .9;
    expect(w204AssistState(car)).toMatchObject({tcOff:true,tcActive:false});
    expect(w204AssistState(new PlayerCar())).toEqual({tcOff:false,tcActive:false,espOff:false,espActive:false});
  });

  it('does not invent assist activity or faults from missing/non-finite telemetry or tuning', () => {
    const car = new W204Car(), tune = { ...car.tune };
    Object.defineProperty(car, 'tune', { value: tune }); // Never mutate the shared W204 tuning.
    car.throttle = 1; car.rpm = 3000; car.gear = 2; car.slipRear = .5; car.esc = .5;
    for (const value of [undefined, Number.NaN, Infinity, -Infinity]) {
      Object.assign(tune, { tractionControl: value, escAssist: value });
      expect(w204AssistState(car)).toEqual({tcOff:false,tcActive:false,espOff:false,espActive:false});
    }
    Object.assign(tune, { tractionControl: 0, escAssist: 0 });
    expect(w204AssistState(car)).toEqual({tcOff:true,tcActive:false,espOff:true,espActive:false});
    Object.assign(tune, { tractionControl: 1, escAssist: 1 });
    for (const value of [undefined, Number.NaN, Infinity, -Infinity]) {
      Object.assign(car, { slipRear: value, esc: value });
      expect(w204AssistState(car)).toEqual({tcOff:false,tcActive:false,espOff:false,espActive:false});
    }
    car.slipRear = .5; car.esc = .5;
    for (const value of [undefined, Number.NaN, Infinity, -Infinity]) {
      Object.assign(tune, { tcSlip: value });
      expect(w204AssistState(car)).toMatchObject({tcOff:false,tcActive:false,espOff:false,espActive:true});
    }
  });

  it('indicates assist activity produced by the real C63 solver, without creating an ABS fault', () => {
    const { cockpit, model } = cabin(), car = new W204Car();
    car.reset(0, 0, 15); car.gear = 2; car.vy = -8; car.r = .7;
    // A genuinely spinning rear axle, not an assigned display slip/ESP value.
    car.omegaR *= 1.5;
    let tcSeen = false, espSeen = false;
    for (let i = 0; i < 120; i++) {
      car.d = car.prevD = 0;
      car.step(1/120, {steer:0,throttle:1,brake:0,manual:true}, 0);
      cockpit.update(car,1/120);
      const state = w204AssistState(car);
      tcSeen ||= state.tcActive; espSeen ||= state.espActive;
      expect(material(model,'tcs_PBR').userData.assistState).toBe(state.tcActive ? 'active' : 'ready');
      expect(material(model,'esc_PBR').userData.assistState).toBe(state.espActive ? 'active' : 'ready');
      expect(meshWith(model,'abs_PBR').visible).toBe(false);
    }
    expect(tcSeen).toBe(true); expect(espSeen).toBe(true);
  });

  it('disposes private resources once on adapter body.clear and leaves the cached GLB untouched', () => {
    const { cockpit, model, body } = cabin(), name = 'c63w204kene_gauges_screen_PBR', screen = meshWith(model,name);
    const texture = display(model), geo = screen.geometry, mat = screen.material as THREE.Material;
    const textureGone = vi.fn(), geometryGone = vi.fn(), materialGone = vi.fn(), sharedGone = vi.fn();
    texture.addEventListener('dispose',textureGone); geo.addEventListener('dispose',geometryGone); mat.addEventListener('dispose',materialGone);
    meshWith(source,name).geometry.addEventListener('dispose',sharedGone); (meshWith(source,name).material as THREE.Material).addEventListener('dispose',sharedGone);
    body.clear(); cockpit.dispose();
    expect(textureGone).toHaveBeenCalledTimes(1); expect(geometryGone).toHaveBeenCalledTimes(1); expect(materialGone).toHaveBeenCalledTimes(1);
    expect(sharedGone).not.toHaveBeenCalled(); expect(screen.geometry).toBe(meshWith(source,name).geometry);
    expect(() => cockpit.update(new W204Car(),1)).not.toThrow();
  });

  it('integrates ghost fading, camera switching and the PlayerView relay/high-beam state after async loading', async () => {
    vi.spyOn(GLTFLoader.prototype,'load').mockImplementation((_url,done) => done({ scene: source } as any));
    const view = new PlayerView(4,0xffffff,new THREE.Texture()), car = new W204Car();
    try {
      view.setGhost(true); view.setCockpit(true); view.setHighBeam(true); await view.ready;
      view.update(1/60,car,new THREE.Vector3(),0);
      const screen = material(view.root,'c63w204kene_gauges_screen_PBR'); expect(screen.opacity).toBeCloseTo(.35);
      expect(material(view.root,'highbeam_PBR').color.getHex()).toBe(0x4b93ff);
      car.blinker = 1;
      for (let i = 0; i < 80; i++) {
        view.update(1/60,car,new THREE.Vector3(),0);
        expect(material(view.root,'signal_L_PBR').color.getHex()).toBe(view.blinkLit ? 0x79e76e : 0x030803);
      }
      view.setGhost(false); view.setCockpit(false); view.setCockpit(true); expect(screen.opacity).toBe(1);
      expect(screen.transparent).toBe(false); expect(screen.depthWrite).toBe(true);
    } finally { view.dispose(); }
  });
});
