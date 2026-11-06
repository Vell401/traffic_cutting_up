import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import type { CarId } from '../../sim/cars';
import { buildCoupe, sideExtrude } from '../carModels';
import { liveryPaint } from './livery';
import { CHROME, EMIT, GRILLE, IND_L, IND_R, PAINT, SHELL, TAIL, TRIM, r34Geometry } from './r34';
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
    cockpit: null,
    modes: ['chase', 'far', 'hood', 'bumper'],
  },
};

/** Turn signal lamps of one car, one material per side (PlayerView switches their colour). */
export interface Indicators {
  left: THREE.MeshBasicMaterial;
  right: THREE.MeshBasicMaterial;
}

/** Amber lens unlit, and lit (bright enough to bloom). */
export const INDICATOR_OFF = new THREE.Color(0.11, 0.045, 0.004);
export const INDICATOR_ON = new THREE.Color(4.2, 1.75, 0.08);

function indicatorMats(): Indicators {
  return { left: new THREE.MeshBasicMaterial({ color: INDICATOR_OFF.clone() }), right: new THREE.MeshBasicMaterial({ color: INDICATOR_OFF.clone() }) };
}

/** Small lamp boxes [x, y, z, w, h, l] in car space; x < 0 blinks left, x > 0 right. */
function indicatorBoxes(parent: THREE.Object3D, ind: Indicators, spots: readonly (readonly [number, number, number, number, number, number])[]): void {
  for (const [x, y, z, w, h, l] of spots) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), x < 0 ? ind.left : ind.right);
    m.position.set(x, y, z);
    parent.add(m);
  }
}

export interface CarParts {
  /** Pitches and rolls with the suspension. */
  body: THREE.Group;
  /** Wheels (on the root, not on the body). */
  wheels: WheelSet;
  wheelRoot: THREE.Group;
  tail: THREE.MeshBasicMaterial;
  tailIdle: THREE.Color;
  tailBrake: THREE.Color;
  /** Headlight spot position, car space. */
  lamp: THREE.Vector3;
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

function loadMercedesModel(onLoad: (model: THREE.Group) => void): void {
  if (mercedesModel) {
    onLoad(mercedesModel);
    return;
  }
  mercedesWaiters.add(onLoad);
  if (mercedesLoading) return;
  mercedesLoading = true;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load('/models/mercedes-a45s.glb', ({ scene }) => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    mercedesModel = scene;
    for (const waiter of mercedesWaiters) waiter(scene);
    mercedesWaiters.clear();
  }, undefined, () => {
    mercedesLoading = false;
    mercedesWaiters.clear();
  });
}

const TAIL_IDLE = new THREE.Color(1.2, 0.05, 0.03);
const TAIL_BRAKE = new THREE.Color(2.6, 0.07, 0.04);

/**
 * Build a car body. `paint` is the body colour of the coupe, the stripe colour of the R34 (its body
 * stays silver). `own`: our car (gets the cockpit when the model has one). `full`: load the heavy
 * imported model where there is one (every real car, ours or another driver's; not the hidden
 * spares a session builds up front for shader warm-up).
 */
export function buildCar(id: CarId, paint: number, length: number, width: number, own: boolean, full = true): CarParts {
  if (id === 2) return buildR34(paint, length, width, own);
  if (id === 3) return buildMercedesParts(paint, length, width, full);
  return buildCoupeParts(paint, length, width);
}

function buildMercedesParts(paint: number, L: number, W: number, importedModel: boolean): CarParts {
  const body = new THREE.Group();
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
  if (importedModel) loadMercedesModel((model) => {
    const imported = model.clone(true);
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
    body.add(imported);
  });
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
  // Turn signals on the body itself (the imported model replaces the procedural shell, not these).
  const indicators = indicatorMats();
  indicatorBoxes(body, indicators, [
    [-(W / 2 - 0.13), 0.66, -L / 2 + 0.06, 0.12, 0.045, 0.06],
    [W / 2 - 0.13, 0.66, -L / 2 + 0.06, 0.12, 0.045, 0.06],
    [-(W / 2 - 0.1), 0.84, L / 2 - 0.08, 0.1, 0.05, 0.06],
    [W / 2 - 0.1, 0.84, L / 2 - 0.08, 0.1, 0.05, 0.06],
  ]);
  return { body, wheels, wheelRoot, tail, tailIdle: TAIL_IDLE, tailBrake: TAIL_BRAKE, lamp: new THREE.Vector3(0, 0.7, -2.05), cockpit: null, indicators };
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
  const indicators = indicatorMats();
  indicatorBoxes(body, indicators, [
    [-0.86, 0.58, -L / 2 + 0.01, 0.12, 0.05, 0.05],
    [0.86, 0.58, -L / 2 + 0.01, 0.12, 0.05, 0.05],
    [-0.88, 0.7, L / 2 + 0.03, 0.09, 0.08, 0.05],
    [0.88, 0.7, L / 2 + 0.03, 0.09, 0.08, 0.05],
  ]);
  return { body, wheels, wheelRoot, tail, tailIdle: TAIL_IDLE, tailBrake: TAIL_BRAKE, lamp: new THREE.Vector3(0, 0.65, -L / 2), cockpit: null, indicators };
}

function buildR34(stripe: number, L: number, W: number, own: boolean): CarParts {
  const geo = r34Geometry();
  const body = new THREE.Group();
  // Real proportions fitted to the hitbox (≈ +6 % width: a wide-body stance).
  const scale = new THREE.Vector3(W / WIDTH, 1, L / LENGTH);
  const model = new THREE.Group();
  model.scale.copy(scale);
  body.add(model);

  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 0.06, 0.035), vertexColors: true });
  const mats: (THREE.Material | null)[] = [];
  mats[PAINT] = liveryPaint(0xc4c9d0, stripe);
  mats[TRIM] = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.62 });
  mats[CHROME] = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: 0.16 });
  mats[EMIT] = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  mats[TAIL] = tail;
  mats[GRILLE] = new THREE.MeshStandardMaterial({ color: 0x9a9da3, map: honeycombTexture(), roughness: 0.8, metalness: 0.2 });
  mats[SHELL] = null;
  const indicators = indicatorMats();
  mats[IND_L] = indicators.left;
  mats[IND_R] = indicators.right;
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
    wheels,
    wheelRoot,
    tail,
    tailIdle: new THREE.Color(1.4, 0.06, 0.035),
    tailBrake: new THREE.Color(3.4, 0.1, 0.05),
    lamp: geo.lamp.clone().multiply(scale),
    cockpit,
    indicators,
  };
}
