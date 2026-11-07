import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { damp } from '../../core/math';
import { report } from '../../diag';
import type { CarId } from '../../sim/cars';
import type { PlayerCar } from '../../sim/vehicle';
import { buildCoupe, sideExtrude } from '../carModels';
import { liveryPaint } from './livery';
import { CHROME, EMIT, GRILLE, IND_L, IND_R, PAINT, RIND_L, RIND_R, SHELL, TAIL, TRIM, r34Geometry } from './r34';
import { buildR34Cockpit, type Cockpit } from './r34Interior';
import { LENGTH, TRACK_HALF, AXLES, TYRE_W, WHEEL_R, WIDTH } from './r34Shape';
import { WheelSet, caliper, plainWheel, sportRim, sportTyre, type WheelPos } from './wheels';

export type { Cockpit } from './r34Interior';

export type CameraMode = 'chase' | 'far' | 'cockpit' | 'hood' | 'bumper';

export interface ChaseRig {
  dist: number;
  height: number;
  lookAhead: number;
  lookHeight: number;
  fovMin: number;
  fovMax: number;
  yawLag: number;
}

/** Camera settings that belong to a car (its size, its cockpit). */
export interface CameraRig {
  chase: ChaseRig;
  /** Far chase: added to the chase values. */
  far: { dist: number; height: number; lookAhead: number; lookHeight: number };
  /** Rigid cameras: forward offset from the car centre (m), height, look-at height 30 m ahead. */
  hood: { f: number; y: number; lookHeight: number };
  bumper: { f: number; y: number; lookHeight: number };
  /** First person from the driver's eye: vertical FOV at rest and flat out, look-down pitch (rad). */
  cockpit: { fov: number; fovFast: number; pitch: number } | null;
  /** C cycles through these, in order. */
  modes: CameraMode[];
}

/** Per-car camera rigs. Mutable: the debug panel edits them live. */
export const CAMERA_RIGS: Record<CarId, CameraRig> = {
  1: {
    chase: { dist: 6.6, height: 2.2, lookAhead: 6, lookHeight: 0.9, fovMin: 58, fovMax: 76, yawLag: 7 },
    far: { dist: 2.6, height: 0.9, lookAhead: 2, lookHeight: 0.3 },
    hood: { f: 0.55, y: 1.2, lookHeight: 0.95 },
    bumper: { f: 2.45, y: 0.55, lookHeight: 0.5 },
    cockpit: null,
    modes: ['chase', 'far', 'hood', 'bumper'],
  },
  2: {
    chase: { dist: 6.4, height: 2.05, lookAhead: 6, lookHeight: 0.85, fovMin: 58, fovMax: 76, yawLag: 7 },
    far: { dist: 2.8, height: 0.95, lookAhead: 2, lookHeight: 0.3 },
    hood: { f: 0.8, y: 1.04, lookHeight: 0.9 },
    bumper: { f: 2.42, y: 0.5, lookHeight: 0.45 },
    cockpit: { fov: 64, fovFast: 71, pitch: -0.05 },
    modes: ['chase', 'far', 'cockpit', 'hood', 'bumper'],
  },
  3: {
    chase: { dist: 6.3, height: 2.15, lookAhead: 6, lookHeight: 0.88, fovMin: 58, fovMax: 76, yawLag: 7 },
    far: { dist: 2.8, height: 0.95, lookAhead: 2, lookHeight: 0.3 },
    hood: { f: 0.65, y: 1.12, lookHeight: 0.9 },
    bumper: { f: 2.3, y: 0.52, lookHeight: 0.45 },
    cockpit: { fov: 62, fovFast: 69, pitch: -0.06 },
    modes: ['chase', 'far', 'cockpit', 'hood', 'bumper'],
  },
};

/**
 * Materials every car of a model draws with (the imported A45's, the lit headlamps, the halo) carry this
 * flag: a car must never dispose or fade them. Disposing them when one driver left made every client
 * recompile the shaders of all the others' A45s at once (a freeze for everyone).
 */
export const isShared = (m: THREE.Material): boolean => m.userData.shared === true;

/** A car's own copy of a (possibly shared) material. */
function perCar<T extends THREE.Material>(m: T): T {
  const c = m.clone() as T;
  delete c.userData.shared;
  return c;
}

/** Amber lens unlit, and lit (bright enough to bloom). */
export const INDICATOR_OFF = new THREE.Color(0.11, 0.045, 0.004);
export const INDICATOR_ON = new THREE.Color(4.2, 1.75, 0.08);
/** Lit amber as an emissive (lamps inside an imported model). */
const AMBER_GLOW = new THREE.Color(6, 2.5, 0.12);

type LampMat = THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;

/**
 * Turn signals and tail lamps that are part of a body: each lamp has its own look when dark (an
 * amber lens, a red tail lamp, a white running light) and when lit. Lamps of an imported model are
 * added when it has loaded. Left = -1, right = 1; side 0 is a tail lamp that brightens on braking.
 */
export class Indicators {
  private readonly lamps: { mat: LampMat; side: number; off: THREE.Color; on: THREE.Color }[] = [];

  /** `off`/`on` default to the amber indicator lens; plain materials change colour, lit ones glow. */
  add(mat: LampMat, side: number, off: THREE.Color = INDICATOR_OFF, on: THREE.Color = 'emissive' in mat ? AMBER_GLOW : INDICATOR_ON): void {
    this.lamps.push({ mat, side, off: off.clone(), on: on.clone() });
    this.paint(this.lamps[this.lamps.length - 1], false);
  }

  /** Remove every lamp made of one of these materials (a placeholder replaced by the real model). */
  drop(mats: readonly THREE.Material[]): void {
    for (let i = this.lamps.length - 1; i >= 0; i--) if (mats.includes(this.lamps[i].mat)) this.lamps.splice(i, 1);
  }

  set(left: boolean, right: boolean, brake: boolean): void {
    for (const l of this.lamps) this.paint(l, l.side < 0 ? left : l.side > 0 ? right : brake);
  }

  private paint(l: { mat: LampMat; off: THREE.Color; on: THREE.Color }, lit: boolean): void {
    const c = 'emissive' in l.mat ? l.mat.emissive : l.mat.color;
    c.copy(lit ? l.on : l.off);
  }
}

/** Small amber lamp boxes [x, y, z, w, h, l] in car space; x < 0 blinks left, x > 0 right. */
function indicatorBoxes(parent: THREE.Object3D, ind: Indicators, spots: readonly (readonly [number, number, number, number, number, number])[]): THREE.Mesh[] {
  const left = new THREE.MeshBasicMaterial();
  const right = new THREE.MeshBasicMaterial();
  ind.add(left, -1);
  ind.add(right, 1);
  return spots.map(([x, y, z, w, h, l]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), x < 0 ? left : right);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  });
}

/*
 * Lamps of the imported A45 (by node name; sides by where they sit): the running-light strip in each
 * headlight and the repeater in each mirror turn amber, so does the LED light guide of each tail lamp;
 * the red tail lamp glass glows and brightens on braking.
 */
const A45_SIGNAL_NODES = new Set([
  'SM_Light_F_101007_1', 'SM_Light_F_101028_1', 'SM_Light_F_101036_1', 'SM_Light_F_101058_1',
  'SK_Trunk_101032_1', 'SK_Trunk_101036_1', 'SM_Light_B_101002_1', 'SM_Light_B_101015_1',
]);
const DRL_WHITE = new THREE.Color(1.6, 1.6, 1.5);
const TAIL_GLOW = new THREE.Color(0.9, 0.03, 0.015);
const TAIL_GLOW_BRAKE = new THREE.Color(3.2, 0.1, 0.04);
const LED_TAIL = new THREE.Color(1.4, 0.05, 0.02);

/*
 * Low and high beams of the imported A45: the model ships them dark (and its front LEDs red). Its lamp
 * parts are alpha-textured glass, which would dim any glow by their transparency, so the LED projectors
 * and diodes get an opaque self-lit material hot enough to bloom a little, the reflectors behind them
 * a softer one, like the lamps of the other cars.
 */
const A45_HEADLAMP: Record<string, THREE.Color> = {
  front_refraction_surface_led: new THREE.Color(5.5, 5.4, 5),
  hi_led: new THREE.Color(4.6, 4.5, 4.2),
  headlight_chrome_reflector: new THREE.Color(1.5, 1.47, 1.38),
};
const headlampMats = new Map<string, THREE.MeshBasicMaterial>();
let headlampHalo: THREE.SpriteMaterial | null = null;

/** Soft glow over a lit headlamp (one shared additive sprite material). */
function haloMaterial(): THREE.SpriteMaterial {
  if (headlampHalo) return headlampHalo;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,252,245,0.7)');
  grad.addColorStop(0.4, 'rgba(255,248,236,0.12)');
  grad.addColorStop(1, 'rgba(255,245,230,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  headlampHalo = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(1.3, 1.28, 1.22), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  headlampHalo.userData.shared = true;
  return headlampHalo;
}

function hookA45Lamps(model: THREE.Object3D, ind: Indicators): void {
  model.updateMatrixWorld(true);
  const clones = new Map<string, THREE.MeshStandardMaterial>();
  const p = new THREE.Vector3();
  /** Projector positions per side (model space), for the halos. */
  const projectors: THREE.Vector3[][] = [[], []];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const signal = mat.name === 'Signals' || A45_SIGNAL_NODES.has(mesh.name);
    const tail = mat.name === 'tailights_red_glass';
    const head = A45_HEADLAMP[mat.name];
    if (head && !signal) {
      // Headlamp parts at the front (the same LED material also sits in the tail lamps).
      mesh.getWorldPosition(p);
      if (p.z >= 0) return;
      if (mat.name === 'front_refraction_surface_led') projectors[p.x < 0 ? 0 : 1].push(p.clone());
      let m = headlampMats.get(mat.name);
      if (!m) {
        m = new THREE.MeshBasicMaterial({ color: head, name: `${mat.name}_lit` });
        m.userData.shared = true;
        headlampMats.set(mat.name, m);
      }
      mesh.material = m;
      return;
    }
    if (!signal && !tail) return;
    // Materials are shared between both sides and every car using the model: one clone per car,
    // per side and per original material.
    mesh.getWorldPosition(p);
    const side = tail ? 0 : p.x < 0 ? -1 : 1;
    const key = `${mat.uuid}/${side}`;
    let m = clones.get(key);
    if (!m) {
      m = perCar(mat);
      clones.set(key, m);
      const front = mesh.name.startsWith('SM_Light_F');
      const rearLed = mesh.name.startsWith('SK_Trunk') || mesh.name.startsWith('SM_Light_B');
      if (tail) ind.add(m, 0, TAIL_GLOW, TAIL_GLOW_BRAKE);
      else ind.add(m, side, front ? DRL_WHITE : rearLed ? LED_TAIL : m.emissive.clone(), AMBER_GLOW);
    }
    mesh.material = m;
  });
  // A halo just in front of each headlamp, so the lights read as on from a distance too.
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  for (const side of projectors) {
    if (side.length === 0) continue;
    const c = side.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(side.length);
    c.z -= 0.06;
    const halo = new THREE.Sprite(haloMaterial());
    halo.position.copy(c.applyMatrix4(inv));
    halo.scale.setScalar(0.26 / model.scale.x);
    model.add(halo);
  }
}

/** Something that turns and rolls a car's wheels. */
export interface Wheels {
  /** steer: front wheel angle (rad, + = right); spin: rolled angle (rad). */
  update(steer: number, spin: number): void;
}

/*
 * Wheels of the imported A45, laid out like a racing-sim car: WHEEL_xx (tyre and rim) and DISC_xx roll
 * about their x axis, the front ones and SUSP_LF / SUSP_RF (caliper, hub) also turn with the steering.
 * In the model's own frame x points to the car's left and z forward, so a right turn is a negative
 * angle about y.
 */
const CORNERS = ['LF', 'RF', 'LR', 'RR'] as const;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

class ImportedWheels implements Wheels {
  private readonly parts: { node: THREE.Object3D; rest: THREE.Quaternion; front: boolean; rolls: boolean }[] = [];
  private readonly qs = new THREE.Quaternion();
  private readonly qr = new THREE.Quaternion();

  constructor(model: THREE.Object3D) {
    for (const [prefix, rolls] of [['WHEEL_', true], ['DISC_', true], ['SUSP_', false]] as const) {
      for (const c of CORNERS) {
        const node = model.getObjectByName(prefix + c);
        if (node) this.parts.push({ node, rest: node.quaternion.clone(), front: c[1] === 'F', rolls });
      }
    }
  }

  /** The model has wheels of its own to drive. */
  get found(): boolean {
    return this.parts.some((p) => p.rolls);
  }

  update(steer: number, spin: number): void {
    this.qs.setFromAxisAngle(Y_AXIS, -steer);
    this.qr.setFromAxisAngle(X_AXIS_W, spin);
    for (const p of this.parts) {
      if (!p.front && !p.rolls) continue;
      p.node.quaternion.copy(p.rest);
      if (p.front) p.node.quaternion.multiply(this.qs);
      if (p.rolls) p.node.quaternion.multiply(this.qr);
    }
  }
}
const X_AXIS_W = new THREE.Vector3(1, 0, 0);

/** Procedural wheels until the imported model has loaded, then the model's own (no doubled wheels). */
class SwappableWheels implements Wheels {
  constructor(public target: Wheels) {}
  update(steer: number, spin: number): void {
    this.target.update(steer, spin);
  }
}

export interface CarParts {
  setPaint(color: number): void;
  /** Pitches and rolls with the suspension. */
  body: THREE.Group;
  /** Wheels (on the root, not on the body). */
  wheels: Wheels;
  wheelRoot: THREE.Group;
  tail: THREE.MeshBasicMaterial;
  tailIdle: THREE.Color;
  tailBrake: THREE.Color;
  /** Headlight beams: height and front (z) of the lamps, car space, and their distance from the centre line. */
  lamp: THREE.Vector3;
  lampX: number;
  indicators: Indicators;
  /** Interior and eye (own R34 only). */
  cockpit: Cockpit | null;
}

let honeycomb: THREE.CanvasTexture | null = null;
function honeycombTexture(): THREE.CanvasTexture {
  if (honeycomb) return honeycomb;
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#3a3c41';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#050506';
  const hex = (cx: number, cy: number, r: number) => {
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.fill();
  };
  for (let row = -1; row < 5; row++) for (let col = -1; col < 5; col++) hex(col * 16 + (row % 2 ? 8 : 0), row * 14 + 6, 7.4);
  honeycomb = new THREE.CanvasTexture(cv);
  honeycomb.wrapS = honeycomb.wrapT = THREE.RepeatWrapping;
  honeycomb.colorSpace = THREE.SRGBColorSpace;
  return honeycomb;
}

let r34Wheel: { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry; caliper: THREE.BufferGeometry } | null = null;
let coupeWheel: { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry } | null = null;
let mercedesModel: THREE.Group | null = null;
let mercedesLoading = false;
const mercedesWaiters = new Set<(model: THREE.Group) => void>();

/** Download state of a heavy car model (the loading indicator shows it). */
export interface ModelLoad {
  name: string;
  /** Bytes so far and in all (the size is known even when the server does not send it). */
  loaded: number;
  total: number;
  /** Downloaded and being unpacked. */
  unpacking: boolean;
  done: boolean;
  failed: boolean;
}

/** Size of mercedes-a45s.glb, for progress when the response has no length. */
const A45_BYTES = 36_172_120;
const modelLoadListeners = new Set<(s: ModelLoad) => void>();

/** Follow heavy model downloads; returns an unsubscribe function. */
export function onModelLoad(fn: (s: ModelLoad) => void): () => void {
  modelLoadListeners.add(fn);
  return () => modelLoadListeners.delete(fn);
}

function emitLoad(s: ModelLoad): void {
  for (const fn of modelLoadListeners) fn(s);
}

/** Start downloading a car's heavy model (on choosing it in the menu, before the run starts). */
export function preloadCar(id: CarId): void {
  if (id === 3) loadMercedesModel(() => {});
}

/** Resolves only after the model is parsed and attached; failed downloads remain retryable. */
export function waitForCar(id: CarId, progress: (fraction: number, unpacking: boolean) => void = () => {}): Promise<void> {
  if (id !== 3 || mercedesModel) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const unsubscribe = onModelLoad(s => {
      progress(s.done ? 1 : Math.min(.99, s.loaded / Math.max(1, s.total)), s.unpacking);
      if (s.failed) { unsubscribe(); reject(new Error(`Cannot load ${s.name}`)); }
      else if (s.done) { unsubscribe(); resolve(); }
    });
    preloadCar(id);
  });
}

function loadMercedesModel(onLoad: (model: THREE.Group) => void): void {
  if (mercedesModel) {
    onLoad(mercedesModel);
    return;
  }
  mercedesWaiters.add(onLoad);
  if (mercedesLoading) return;
  mercedesLoading = true;
  const name = 'Mercedes-AMG A45 S';
  const state: ModelLoad = { name, loaded: 0, total: A45_BYTES, unpacking: false, done: false, failed: false };
  emitLoad(state);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load('/models/mercedes-a45s.glb', ({ scene }) => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.userData.shared = true;
    });
    mercedesModel = scene;
    for (const waiter of mercedesWaiters) waiter(scene);
    mercedesWaiters.clear();
    emitLoad({ ...state, loaded: state.total, unpacking: false, done: true });
  }, (e) => {
    // A compressed response may report its compressed length (or none): never show past 100 %.
    state.total = Math.max(e.lengthComputable && e.total > 0 ? e.total : A45_BYTES, e.loaded);
    state.loaded = e.loaded;
    state.unpacking = e.loaded >= state.total;
    emitLoad({ ...state });
  }, (e) => {
    report('error', 'model load failed: mercedes-a45s.glb', String((e as { message?: string })?.message ?? e));
    mercedesLoading = false;
    mercedesWaiters.clear();
    emitLoad({ ...state, failed: true });
  });
}

/*
 * A45 first-person view. The imported model is laid out like a racing-sim car: the cockpit (COCKPIT_HR)
 * holds the steering wheel STEER_HR, which turns about its own z axis (the tilted column), with the
 * shift paddles SHIFT_L / SHIFT_R on it. The eye sits behind and above the wheel hub; until the model
 * has loaded it waits at a default spot.
 */
const A45_EYE_DEFAULT = new THREE.Vector3(-0.36, 1.16, 0.18);
/** Eye relative to the wheel hub, car space (m): behind it and up. */
const A45_EYE_FROM_WHEEL = new THREE.Vector3(0, 0.27, 0.62);
/** Steering wheel turn per road-wheel angle (a quick AMG rack). */
const A45_STEER_RATIO = 13.5;
/** Steering wheel turn at full input whatever the speed, rad (about 100°). */
const A45_MIN_TURN = 1.75;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

class A45Cockpit implements Cockpit {
  readonly group = new THREE.Group();
  readonly eye = new THREE.Object3D();
  private wheel: THREE.Object3D | null = null;
  private readonly wheelRest = new THREE.Quaternion();
  private paddles: { node: THREE.Object3D; rest: THREE.Quaternion; t: number }[] = [];
  private angle = 0;
  private gear = 1;
  private readonly q = new THREE.Quaternion();

  constructor(body: THREE.Object3D) {
    this.eye.position.copy(A45_EYE_DEFAULT);
    body.add(this.eye, this.group);
  }

  /** The imported model is in place under `body`: find the wheel and put the eye behind it. */
  attach(model: THREE.Object3D, body: THREE.Object3D): void {
    const wheel = model.getObjectByName('STEER_HR');
    if (!wheel) return;
    this.wheel = wheel;
    this.wheelRest.copy(wheel.quaternion);
    this.paddles = ['SHIFT_L', 'SHIFT_R'].flatMap((n) => {
      const node = wheel.getObjectByName(n);
      return node ? [{ node, rest: node.quaternion.clone(), t: 0 }] : [];
    });
    body.updateMatrixWorld(true);
    const hub = wheel.getWorldPosition(new THREE.Vector3());
    body.worldToLocal(hub);
    this.eye.position.copy(hub).add(A45_EYE_FROM_WHEEL);
  }

  update(car: PlayerCar, dt: number): void {
    if (!this.wheel) return;
    // The real wheel angle (road wheels × ratio), but never less than an input-led turn: at speed the
    // keyboard asks for only a few degrees at the road wheels, the hands still move the wheel visibly.
    const real = car.steerAngle * A45_STEER_RATIO;
    const felt = car.steerIn * A45_MIN_TURN;
    const target = Math.abs(real) >= Math.abs(felt) ? real : felt;
    this.angle = damp(this.angle, target, 14, dt);
    this.wheel.quaternion.copy(this.wheelRest).multiply(this.q.setFromAxisAngle(Z_AXIS, this.angle));
    // Paddles: the left one pulled on a downshift, the right one on an upshift.
    if (car.gear !== this.gear) {
      const p = this.paddles[car.gear > this.gear ? 1 : 0];
      if (p) p.t = 0.16;
      this.gear = car.gear;
    }
    for (const p of this.paddles) {
      p.t = Math.max(0, p.t - dt);
      p.node.quaternion.copy(p.rest).multiply(this.q.setFromAxisAngle(X_AXIS, p.t > 0 ? -0.12 : 0));
    }
  }
}

const TAIL_IDLE = new THREE.Color(1.2, 0.05, 0.03);
const R34_REAR_OFF = new THREE.Color(0.75, 0.03, 0.02);
const TAIL_BRAKE = new THREE.Color(2.6, 0.07, 0.04);

/**
 * Build a car body. `paint` is the driver's chosen body colour. R34 livery keeps its contrasting
 * stripes. `own`: our car (gets the cockpit when the model has one). `full`: load the heavy
 * imported model where there is one (every real car, ours or another driver's; not the hidden
 * spares a session builds up front for shader warm-up).
 */
export function buildCar(id: CarId, paint: number, length: number, width: number, own: boolean, full = true): CarParts {
  if (id === 2) return buildR34(paint, length, width, own);
  if (id === 3) return buildMercedesParts(paint, length, width, full, own);
  return buildCoupeParts(paint, length, width);
}

function buildMercedesParts(paint: number, L: number, W: number, importedModel: boolean, own: boolean): CarParts {
  const body = new THREE.Group();
  const cockpit = own ? new A45Cockpit(body) : null;
  const shell = new THREE.Group();
  const scale = new THREE.Vector3(W / 1.85, 1, L / 4.42);
  shell.scale.copy(scale);
  body.add(shell);
  const paintMat = new THREE.MeshPhysicalMaterial({ color: paint, metalness: 0.52, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.055 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x080b10, metalness: 0.55, roughness: 0.12 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.62, metalness: 0.28 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xc1c6cc, metalness: 0.88, roughness: 0.22 });
  const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.45, 2.25) });
  const tail = new THREE.MeshBasicMaterial({ color: TAIL_IDLE.clone() });
  const box = (w: number, h: number, l: number, mat: THREE.Material, x: number, y: number, z: number, group = shell) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  const profile: [number, number][] = [
    [-2.21, 0.3], [-2.21, 0.66], [-2.08, 0.84], [-1.85, 0.93], [-1.15, 0.95],
    [0.9, 0.95], [1.6, 0.9], [2.08, 0.78], [2.21, 0.62], [2.21, 0.35], [2.08, 0.27], [-2.05, 0.27],
  ];
  const glazing: [number, number][] = [
    [-1.48, 0.92], [-1.24, 1.29], [-0.98, 1.39], [0.45, 1.39], [0.78, 1.31],
    [1.55, 0.91], [0.88, 0.91], [-0.9, 0.94],
  ];
  shell.add(new THREE.Mesh(sideExtrude(profile, 1.85, 1, 0.065), paintMat));
  shell.add(new THREE.Mesh(sideExtrude(glazing, 1.48, 1, 0.025), glassMat));
  // Low roof and upright rear hatch establish the compact AMG hatchback silhouette.
  box(1.42, 0.12, 1.38, paintMat, 0, 1.37, -0.18);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.035, 0.86), glassMat);
  windshield.position.set(0, 1.17, -0.92);
  windshield.rotation.x = -0.5;
  shell.add(windshield);
  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.035, 0.72), glassMat);
  rearGlass.position.set(0, 1.16, 0.98);
  rearGlass.rotation.x = 0.65;
  shell.add(rearGlass);
  // Panamericana grille, twin intake openings, side skirts and quad exhausts.
  box(0.88, 0.38, 0.045, trimMat, 0, 0.56, -2.205);
  for (let i = -4; i <= 4; i++) box(0.035, 0.34, 0.012, chromeMat, i * 0.088, 0.56, -2.231);
  box(0.38, 0.18, 0.06, trimMat, -0.62, 0.48, -2.18);
  box(0.38, 0.18, 0.06, trimMat, 0.62, 0.48, -2.18);
  box(1.78, 0.12, 3.15, trimMat, 0, 0.36, 0.03);
  box(1.7, 0.16, 0.17, trimMat, 0, 0.38, 2.13);
  for (const x of [-0.62, -0.42, 0.42, 0.62]) {
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.12, 12).rotateX(Math.PI / 2), chromeMat);
    exhaust.position.set(x, 0.39, 2.19);
    shell.add(exhaust);
  }
  box(0.52, 0.07, 0.055, tail, -0.59, 0.72, 2.15);
  box(0.52, 0.07, 0.055, tail, 0.59, 0.72, 2.15);
  box(0.46, 0.08, 0.055, headMat, -0.62, 0.67, -2.15);
  box(0.46, 0.08, 0.055, headMat, 0.62, 0.67, -2.15);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 0.28), paintMat);
  spoiler.position.set(0, 1.48, 1.9);
  shell.add(spoiler);
  const wheelGeo = sportTyre(0.34, 0.245, 0.2286);
  const rimGeo = sportRim(0.2286, 0.245);
  const wheelPos: WheelPos[] = [
    { x: -0.805, y: 0.34, z: -1.36, front: true }, { x: 0.805, y: 0.34, z: -1.36, front: true },
    { x: -0.805, y: 0.34, z: 1.36, front: false }, { x: 0.805, y: 0.34, z: 1.36, front: false },
  ];
  const wheels = new WheelSet({
    tyre: wheelGeo, rim: rimGeo, fixed: null,
    tyreMat: new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.9 }),
    rimMat: new THREE.MeshStandardMaterial({ color: 0xd4d7dc, metalness: 0.9, roughness: 0.25 }),
    fixedMat: null,
  }, wheelPos);
  const wheelRoot = new THREE.Group();
  wheelRoot.scale.copy(scale);
  wheelRoot.add(wheels.group);
  const wheelDrive = new SwappableWheels(wheels);
  // Placeholder turn signals for the procedural shell; the imported model brings its own lamps.
  const indicators = new Indicators();
  const placeholders = indicatorBoxes(body, indicators, [
    [-(W / 2 - 0.13), 0.66, -L / 2 + 0.06, 0.12, 0.045, 0.06],
    [W / 2 - 0.13, 0.66, -L / 2 + 0.06, 0.12, 0.045, 0.06],
    [-(W / 2 - 0.1), 0.84, L / 2 - 0.08, 0.1, 0.05, 0.06],
    [W / 2 - 0.1, 0.84, L / 2 - 0.08, 0.1, 0.05, 0.06],
  ]);
  // Last: with the model already cached this runs at once and swaps the placeholders out.
  if (importedModel) loadMercedesModel((model) => {
    const imported = model.clone(true);
    // Paint belongs to each driver; other drivers can still share glass, trim and interiors.
    {
      const copies = new Map<THREE.Material, THREE.Material>();
      imported.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const painted = mesh.material.name === 'EXT_Carpaint' || mesh.material.name === 'INT_Carpaint';
        if (!own && !painted) return;
        let c = copies.get(mesh.material);
        if (!c) copies.set(mesh.material, (c = perCar(mesh.material)));
        mesh.material = c;
        if (painted) {
          const finish = c as THREE.MeshStandardMaterial;
          finish.color.setHex(paint);
          finish.userData.bodyPaint = true;
        }
      });
    }
    imported.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(imported);
    const size = bounds.getSize(new THREE.Vector3());
    // Keep the source proportions and fit its wheelbase direction to the car spec.
    const fit = L / size.z;
    imported.scale.setScalar(fit);
    imported.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(imported);
    imported.position.set(-(scaled.min.x + scaled.max.x) / 2, -scaled.min.y, -(scaled.min.z + scaled.max.z) / 2);
    body.remove(shell);
    shell.clear();
    for (const m of placeholders) body.remove(m);
    indicators.drop(placeholders.map((m) => m.material as THREE.Material));
    hookA45Lamps(imported, indicators);
    body.add(imported);
    cockpit?.attach(imported, body);
    // The model brings its own wheels: drive those and drop the procedural set.
    const modelWheels = new ImportedWheels(imported);
    if (modelWheels.found) {
      wheelRoot.remove(wheels.group);
      wheelDrive.target = modelWheels;
    }
  });
  // Beams from the projectors (±0.61 m, 0.66 m up), just ahead of the lamp glass.
  return { body, wheels: wheelDrive, wheelRoot, tail, tailIdle: TAIL_IDLE, tailBrake: TAIL_BRAKE, lamp: new THREE.Vector3(0, 0.66, -2.16), lampX: 0.61, cockpit, indicators,
    setPaint(color) {
      paint = color; paintMat.color.setHex(color);
      body.traverse(o => {
        const material = (o as THREE.Mesh).material;
        for (const m of Array.isArray(material) ? material : material ? [material] : [])
          if (m.userData.bodyPaint) (m as THREE.MeshStandardMaterial).color.setHex(color);
      });
    },
  };
}

function buildCoupeParts(paint: number, L: number, W: number): CarParts {
  const body = new THREE.Group();
  const paintMat = new THREE.MeshPhysicalMaterial({ color: paint, metalness: 0.5, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.06 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.75 });
  const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.3) });
  const tail = new THREE.MeshBasicMaterial({ color: TAIL_IDLE.clone() });
  const box = (w: number, h: number, l: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    m.position.set(x, y, z);
    body.add(m);
  };
  const coupe = buildCoupe(L, W);
  body.add(new THREE.Mesh(coupe.paint, paintMat), new THREE.Mesh(coupe.glass, glassMat), new THREE.Mesh(coupe.trim, trimMat));
  // Lamps sit just proud of the bevelled body surface.
  box(0.46, 0.08, 0.06, tail, -0.6, 0.7, L / 2 + 0.04);
  box(0.46, 0.08, 0.06, tail, 0.6, 0.7, L / 2 + 0.04);
  box(0.8, 0.025, 0.05, tail, 0, 0.72, L / 2 + 0.05);
  box(0.42, 0.06, 0.06, headMat, -0.62, 0.6, -L / 2 - 0.01);
  box(0.42, 0.06, 0.06, headMat, 0.62, 0.6, -L / 2 - 0.01);

  coupeWheel ??= plainWheel(0.34, 0.26);
  const pos: WheelPos[] = [
    { x: -0.84, y: 0.34, z: -1.32, front: true },
    { x: 0.84, y: 0.34, z: -1.32, front: true },
    { x: -0.84, y: 0.34, z: 1.42, front: false },
    { x: 0.84, y: 0.34, z: 1.42, front: false },
  ];
  const wheels = new WheelSet(
    {
      tyre: coupeWheel.tyre,
      rim: coupeWheel.rim,
      fixed: null,
      tyreMat: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92 }),
      rimMat: new THREE.MeshStandardMaterial({ color: 0xa7adb5, metalness: 0.85, roughness: 0.28 }),
      fixedMat: null,
    },
    pos,
  );
  const wheelRoot = new THREE.Group();
  wheelRoot.add(wheels.group);
  const indicators = new Indicators();
  indicatorBoxes(body, indicators, [
    [-0.86, 0.58, -L / 2 + 0.01, 0.12, 0.05, 0.05],
    [0.86, 0.58, -L / 2 + 0.01, 0.12, 0.05, 0.05],
    [-0.88, 0.7, L / 2 + 0.03, 0.09, 0.08, 0.05],
    [0.88, 0.7, L / 2 + 0.03, 0.09, 0.08, 0.05],
  ]);
  return { body, wheels, wheelRoot, tail, tailIdle: TAIL_IDLE, tailBrake: TAIL_BRAKE, lamp: new THREE.Vector3(0, 0.6, -L / 2 - 0.08), lampX: 0.62, cockpit: null, indicators, setPaint: color => { paintMat.color.setHex(color); } };
}

function buildR34(paint: number, L: number, W: number, own: boolean): CarParts {
  const geo = r34Geometry();
  const body = new THREE.Group();
  // Real proportions fitted to the hitbox (≈ +6 % width: a wide-body stance).
  const scale = new THREE.Vector3(W / WIDTH, 1, L / LENGTH);
  const model = new THREE.Group();
  model.scale.copy(scale);
  body.add(model);

  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 0.06, 0.035), vertexColors: true });
  const mats: (THREE.Material | null)[] = [];
  mats[PAINT] = liveryPaint(paint, 0x172238);
  mats[TRIM] = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.62 });
  mats[CHROME] = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: 0.16 });
  mats[EMIT] = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  mats[TAIL] = tail;
  mats[GRILLE] = new THREE.MeshStandardMaterial({ color: 0x9a9da3, map: honeycombTexture(), roughness: 0.8, metalness: 0.2 });
  mats[SHELL] = null;
  const indicators = new Indicators();
  const indL = new THREE.MeshBasicMaterial();
  const indR = new THREE.MeshBasicMaterial();
  const rearL = new THREE.MeshBasicMaterial();
  const rearR = new THREE.MeshBasicMaterial();
  indicators.add(indL, -1);
  indicators.add(indR, 1);
  // The centres of the inner round tail lamps: red like the rest of the lamp, amber when blinking.
  indicators.add(rearL, -1, R34_REAR_OFF);
  indicators.add(rearR, 1, R34_REAR_OFF);
  mats[IND_L] = indL;
  mats[IND_R] = indR;
  mats[RIND_L] = rearL;
  mats[RIND_R] = rearR;
  geo.parts.forEach((g, i) => {
    const m = mats[i];
    if (m && g.index && g.index.count > 0) model.add(new THREE.Mesh(g, m));
  });

  r34Wheel ??= { tyre: sportTyre(WHEEL_R, TYRE_W, 0.2286), rim: sportRim(0.2286, TYRE_W), caliper: caliper() };
  const pos: WheelPos[] = [];
  AXLES.forEach((f, k) => {
    for (const side of [-1, 1]) pos.push({ x: side * TRACK_HALF[k], y: WHEEL_R, z: -f, front: k === 0 });
  });
  const wheels = new WheelSet(
    {
      tyre: r34Wheel.tyre,
      rim: r34Wheel.rim,
      fixed: r34Wheel.caliper,
      tyreMat: new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.9 }),
      rimMat: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.92, roughness: 0.26 }),
      fixedMat: new THREE.MeshStandardMaterial({ color: 0xc8161b, roughness: 0.45, metalness: 0.2 }),
    },
    pos,
  );
  const wheelRoot = new THREE.Group();
  wheelRoot.scale.copy(scale);
  wheelRoot.add(wheels.group);

  let cockpit: Cockpit | null = null;
  if (own) {
    cockpit = buildR34Cockpit(geo.parts[SHELL]);
    model.add(cockpit.group);
  }
  return {
    body,
    setPaint: color => { (mats[PAINT] as THREE.MeshStandardMaterial).color.setHex(color); },
    wheels,
    wheelRoot,
    tail,
    tailIdle: new THREE.Color(1.4, 0.06, 0.035),
    tailBrake: new THREE.Color(3.4, 0.1, 0.05),
    lamp: geo.lamp.clone().multiply(scale).setZ(geo.lamp.z * scale.z - 0.06),
    lampX: 0.6 * scale.x,
    cockpit,
    indicators,
  };
}
