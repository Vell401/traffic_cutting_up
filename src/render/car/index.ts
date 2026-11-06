import * as THREE from 'three';
import type { CarId } from '../../sim/cars';
import { buildCoupe } from '../carModels';
import { liveryPaint } from './livery';
import { CHROME, EMIT, GRILLE, PAINT, SHELL, TAIL, TRIM, r34Geometry } from './r34';
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
};

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

const TAIL_IDLE = new THREE.Color(1.2, 0.05, 0.03);
const TAIL_BRAKE = new THREE.Color(2.6, 0.07, 0.04);

/**
 * Build a car body. `paint` is the body colour of the coupe, the stripe colour of the R34 (its body
 * stays silver). `own`: our car (gets the cockpit when the model has one).
 */
export function buildCar(id: CarId, paint: number, length: number, width: number, own: boolean): CarParts {
  return id === 2 ? buildR34(paint, length, width, own) : buildCoupeParts(paint, length, width);
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
  return { body, wheels, wheelRoot, tail, tailIdle: TAIL_IDLE, tailBrake: TAIL_BRAKE, lamp: new THREE.Vector3(0, 0.65, -L / 2), cockpit: null };
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
  };
}
