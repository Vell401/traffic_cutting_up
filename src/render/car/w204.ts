import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { Indicators, type CarParts, type ModelLoad } from './index';
import { cloneInSlices } from './clone';
import { W204Cockpit } from './w204Cockpit';

export const W204_NAME = 'Mercedes-Benz C63 AMG W204';
let source: THREE.Group | null = null;
let pending: Promise<THREE.Group> | null = null;
const W204_BYTES = 21_045_480;
let state: ModelLoad = { name: W204_NAME, loaded: 0, total: W204_BYTES, unpacking: false, done: false, failed: false };
const listeners = new Set<(state: ModelLoad) => void>();
const noop = (): void => {};

/** One immutable source, concurrent progress subscribers, and a fresh request after failure. */
export function preloadW204(emitLoad: (state: ModelLoad) => void = noop): Promise<THREE.Group> {
  if (source) { emitLoad({ ...state }); return Promise.resolve(source); }
  listeners.add(emitLoad);
  if (pending) { emitLoad({ ...state }); return pending; }
   state = { name: W204_NAME, loaded: 0, total: W204_BYTES, unpacking: false, done: false, failed: false };
  const publish = (): void => { for (const listener of listeners) listener({ ...state }); };
  publish();
  // Defer the loader so even synchronous setup failures clear the assigned promise.
  pending = Promise.resolve().then(() => new Promise<THREE.Group>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load('/models/mercedes-w204.glb', gltf => {
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const mat of [mesh.material].flat()) mat.userData.shared = true;
      });
      resolve(gltf.scene);
    }, event => {
      state.loaded = event.loaded;
      state.total = Math.max(event.lengthComputable && event.total > 0 ? event.total : state.total, event.loaded);
      state.unpacking = event.loaded >= state.total;
      publish();
    }, reject);
  })).then(model => {
    source = model;
    state = { ...state, loaded: state.total, unpacking: false, done: true };
    publish(); listeners.clear(); return model;
  }, error => {
    pending = null;
    state = { ...state, unpacking: false, failed: true };
    publish(); listeners.clear(); throw error;
  });
  return pending;
}

export function createW204(paint: number, own: boolean, full: boolean, emitLoad: (state: ModelLoad) => void = noop): CarParts {
  const body = new THREE.Group(), wheelRoot = new THREE.Group();
  const indicators = new Indicators(), tail = new THREE.MeshBasicMaterial();
  const managedMaterials = new Set<THREE.Material>([tail]);
  const copies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const painted = new Set<THREE.MeshStandardMaterial>();
  const hidden: { node: THREE.Object3D; visible: boolean }[] = [];
  const wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean }[] = [];
  const cockpit = own && full ? new W204Cockpit(body) : null;
  let disposed = false, inCockpit = false, steer = 0, spin = 0;
  const applyCockpit = (): void => { for (const item of hidden) item.node.visible = item.visible && !inCockpit; };
  const animate = (): void => {
    for (const wheel of wheels) {
      wheel.pivot.rotation.y = wheel.front ? -steer : 0;
      wheel.spin.rotation.x = -spin;
    }
  };
  const ready = full ? preloadW204(emitLoad).then(async model => {
    if (disposed) return;
    const imported = own ? model.clone(true) : await cloneInSlices(model, () => disposed);
    if (!imported || disposed) return;
    imported.traverse(object => {
      // Hide only glazing in first person: never the combined body/roof mesh or cabin trim.
      if (own && /c63w204kene_(?:windshield|doorglass|rearglass|glassroof)/.test(object.name)) hidden.push({ node: object, visible: object.visible });
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      const next = [mesh.material].flat().map(mat => {
        // Every instance needs its own fade state, including remote-car reveal/ghost materials.
        let finish = copies.get(mat);
        if (!finish) {
          finish = mat.clone() as THREE.MeshStandardMaterial;
          delete finish.userData.shared;
          copies.set(mat, finish); managedMaterials.add(finish);
           const name = mat.name;
           // Exported emission masks stay black until this instance supplies its light state.
           finish.emissiveIntensity = 1;
          if (name === 'W204_BodyPaint') { finish.color.setHex(paint); painted.add(finish); }
          if (/signal[_]l(?:_|\b)/i.test(name)) indicators.add(finish, -1, new THREE.Color(.015,.008,.002));
          else if (/signal[_]r(?:_|\b)/i.test(name)) indicators.add(finish, 1, new THREE.Color(.015,.008,.002));
          else if (/taillights_stop|chmsl/.test(name)) indicators.add(finish, 0, new THREE.Color(.4,.008,.004), new THREE.Color(4,.06,.025));
          else if (/taillights_lowhighbeam/.test(name)) finish.emissive.setRGB(.8,.015,.008);
           else if (/c63_hl_PBR$|c63_hl_running|foglight_PBR/.test(name)) finish.emissive.setRGB(2,1.9,1.7);
           else if (/screen_dorest_PBR$|c63_interior(?:_dash|_alte)?_PBR$/.test(name) && finish.emissiveMap) finish.emissive.setRGB(.25,.25,.25);
          if (finish.transparent) { finish.depthWrite = false; finish.forceSinglePass = true; }
        }
        return finish;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0];
    });
    imported.updateMatrixWorld(true);
    // Keep Mercedes_W204's authored 180° parent intact. Only animation assemblies are reparented.
    const detached = new THREE.Group();
    const calipers: THREE.Object3D[] = [];
    imported.traverse(node => { if (/^brake_caliper_/.test(node.name)) calipers.push(node); });
    for (const corner of ['FL', 'FR', 'RL', 'RR']) {
      const node = imported.getObjectByName(`Wheel_${corner}`);
      if (!node) throw new Error(`W204 missing Wheel_${corner}`);
      const pivot = new THREE.Group(), rolling = new THREE.Group();
      pivot.name = `W204_Steer_${corner}`; rolling.name = `W204_Spin_${corner}`;
      node.getWorldPosition(pivot.position);
      detached.add(pivot); pivot.add(rolling); detached.updateMatrixWorld(true);
      rolling.attach(node);
      const disc = imported.getObjectByName(`Wheel_${corner}_BrakeDisc`);
      if (disc) pivot.attach(disc);
      for (const caliper of calipers) {
        const position = caliper.getWorldPosition(new THREE.Vector3());
        if ((position.x < 0) === (pivot.position.x < 0) && (position.z < 0) === (pivot.position.z < 0)) pivot.attach(caliper);
      }
      wheels.push({ pivot, spin: rolling, front: corner[0] === 'F' });
    }
    cockpit?.attach(imported);
    body.add(imported); wheelRoot.add(detached);
    animate(); applyCockpit();
  }) : Promise.resolve();
  return {
    body, wheelRoot, cockpit, ready, managedMaterials, tail, indicators,
    tailIdle: new THREE.Color(.8,.015,.008), tailBrake: new THREE.Color(4,.06,.025),
    lamp: new THREE.Vector3(0,.70,-2.04), lampX: .600,
    wheels: { update(angle, rolled) { steer = angle; spin = rolled; animate(); } },
    updateCabin(car, dt) { cockpit?.update(car, dt); },
    setPaint(color) { paint = color; for (const mat of painted) mat.color.setHex(color); },
    setCockpit(on) { inCockpit = own && on; applyCockpit(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of managedMaterials) material.dispose();
      // Geometry/textures belong to the cached source and remain available to other cars.
      body.clear(); wheelRoot.clear();
    },
  };
}
