import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Procedural low-poly vehicles. A body is a side silhouette extruded across the width with a bevel,
 * which already reads as a car at night; the glasshouse is a narrower extrusion on top.
 *
 * Car space: x right, y up, z toward the rear (the vehicle faces -Z), origin on the ground under the
 * centre. Profiles are written as (f, y) with f pointing forward.
 *
 * Parts are merged into one geometry with vertex colours: paint = 1 (multiplied by the per-instance
 * colour), glass and trim are near-black. One traffic type = one instanced mesh.
 */

export const PAINT = 1;
export const GLASS = 0.03;
export const TRIM = 0.1;

type Profile = [number, number][];

function colorize(g: THREE.BufferGeometry, shade: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3).fill(shade);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Side silhouette extruded across `width`, bevelled edges, centred on x. */
export function sideExtrude(profile: Profile, width: number, shade: number, bevel = 0.05): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([f, y]) => new THREE.Vector2(f, y)));
  const bt = bevel > 0 ? Math.min(bevel, width * 0.2) : 0;
  const depth = width - 2 * bt;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bt,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2); // profile forward (+x) → -z, extrusion → x
  g.deleteAttribute('uv');
  return colorize(g, shade);
}

/** Box in car space: size (w, h, l), centre at forward f, height y. */
export function part(w: number, h: number, l: number, f: number, y: number, shade: number, x = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, -f);
  g.deleteAttribute('uv');
  return colorize(g, shade);
}

export interface Axle {
  f: number;
  r: number;
  width: number;
}

export interface VehicleModel {
  /** Painted body with glass and trim baked in as vertex colours. */
  body: THREE.BufferGeometry;
  /** Truck cargo box, coloured separately. */
  cargo: THREE.BufferGeometry | null;
  axles: Axle[];
}

interface CarDef {
  body: Profile;
  glass: Profile;
  glassW: number;
  roof: [number, number, number, number, number]; // fFrom, fTo, yBottom, yTop, width factor
  axles: Axle[];
}

const CARS: Record<string, CarDef> = {
  sedan: {
    body: [[-2.33, 0.36], [-2.37, 0.62], [-2.3, 0.8], [-2.05, 0.9], [-1.25, 0.93], [0.95, 0.95], [2.05, 0.8], [2.35, 0.66], [2.37, 0.42], [2.3, 0.32], [-2.28, 0.3]],
    glass: [[-1.4, 0.9], [-0.75, 1.36], [0.3, 1.38], [1.05, 0.92]],
    glassW: 0.84,
    roof: [-0.7, 0.25, 1.33, 1.42, 0.8],
    axles: [{ f: 1.45, r: 0.33, width: 0.24 }, { f: -1.4, r: 0.33, width: 0.24 }],
  },
  hatch: {
    body: [[-2.08, 0.34], [-2.1, 0.85], [-1.95, 0.95], [0.85, 0.95], [1.8, 0.82], [2.1, 0.66], [2.1, 0.42], [2.02, 0.32], [-2.0, 0.3]],
    glass: [[-1.95, 0.93], [-1.75, 1.42], [0.25, 1.44], [0.95, 0.93]],
    glassW: 0.86,
    roof: [-1.65, 0.2, 1.39, 1.48, 0.8],
    axles: [{ f: 1.3, r: 0.32, width: 0.23 }, { f: -1.3, r: 0.32, width: 0.23 }],
  },
  suv: {
    body: [[-2.32, 0.45], [-2.35, 0.95], [-2.25, 1.08], [0.95, 1.1], [2.0, 1.0], [2.35, 0.85], [2.35, 0.55], [2.25, 0.42], [-2.25, 0.42]],
    glass: [[-2.15, 1.06], [-2.0, 1.72], [0.35, 1.74], [1.05, 1.08]],
    glassW: 0.88,
    roof: [-1.95, 0.3, 1.69, 1.8, 0.84],
    axles: [{ f: 1.45, r: 0.38, width: 0.27 }, { f: -1.45, r: 0.38, width: 0.27 }],
  },
  minivan: {
    body: [[-2.4, 0.36], [-2.42, 0.95], [-2.35, 1.05], [1.2, 1.05], [2.2, 0.95], [2.42, 0.75], [2.42, 0.45], [2.3, 0.33], [-2.3, 0.32]],
    glass: [[-2.3, 1.03], [-2.2, 1.8], [0.75, 1.82], [1.55, 1.05]],
    glassW: 0.9,
    roof: [-2.1, 0.7, 1.77, 1.88, 0.86],
    axles: [{ f: 1.55, r: 0.34, width: 0.24 }, { f: -1.5, r: 0.34, width: 0.24 }],
  },
};

function buildCar(def: CarDef, len: number, wid: number): VehicleModel {
  const [f0, f1, y0, y1, wk] = def.roof;
  const parts = [
    sideExtrude(def.body, wid, PAINT),
    sideExtrude(def.glass, wid * def.glassW, GLASS, 0.03),
    part(wid * wk, y1 - y0, f1 - f0, (f0 + f1) / 2, (y0 + y1) / 2, PAINT),
    // Bumpers, grille and sills in black trim.
    part(wid * 0.98, 0.16, 0.22, -len / 2 + 0.08, 0.42, TRIM),
    part(wid * 0.7, 0.16, 0.12, len / 2 - 0.02, 0.48, TRIM),
    part(wid + 0.02, 0.1, len * 0.42, 0.02, 0.36, TRIM),
  ];
  return { body: mergeGeometries(parts)!, cargo: null, axles: def.axles };
}

interface TruckDef {
  cab: Profile;
  cabW: number;
  glass: Profile;
  chassis: [number, number, number, number, number]; // fFrom, fTo, yBottom, yTop, width
  cargo: [number, number, number, number, number];
  axles: Axle[];
}

const TRUCKS: Record<string, TruckDef> = {
  boxTruck: {
    cab: [[2.1, 0.55], [2.1, 2.55], [3.75, 2.55], [4.1, 1.95], [4.1, 0.55]],
    cabW: 2.2,
    glass: [[3.0, 1.75], [3.0, 2.42], [3.72, 2.42], [4.04, 1.85]],
    chassis: [-4.0, 2.1, 0.55, 0.88, 1.6],
    cargo: [-4.1, 1.95, 0.9, 3.5, 2.35],
    axles: [{ f: 3.35, r: 0.5, width: 0.32 }, { f: -2.6, r: 0.5, width: 0.4 }],
  },
  semi: {
    cab: [[4.65, 0.6], [4.65, 3.1], [6.75, 3.1], [7.25, 2.2], [7.25, 0.6]],
    cabW: 2.45,
    glass: [[5.6, 2.0], [5.6, 2.95], [6.72, 2.95], [7.18, 2.1]],
    chassis: [-7.0, 4.65, 0.6, 1.02, 1.4],
    cargo: [-7.25, 4.4, 1.1, 4.0, 2.5],
    axles: [{ f: 6.2, r: 0.52, width: 0.34 }, { f: -5.6, r: 0.52, width: 0.5 }],
  },
};

function buildTruck(def: TruckDef): VehicleModel {
  const [cf0, cf1, cy0, cy1, cw] = def.chassis;
  const [gf0, gf1, gy0, gy1, gw] = def.cargo;
  const body = mergeGeometries([
    sideExtrude(def.cab, def.cabW, PAINT, 0.06),
    sideExtrude(def.glass, def.cabW + 0.04, GLASS, 0.02),
    part(cw, cy1 - cy0, cf1 - cf0, (cf0 + cf1) / 2, (cy0 + cy1) / 2, TRIM),
    part(def.cabW, 0.32, 0.16, def.cab[3][0] - 0.04, 0.62, TRIM),
  ])!;
  const cargo = part(gw, gy1 - gy0, gf1 - gf0, (gf0 + gf1) / 2, (gy0 + gy1) / 2, PAINT);
  return { body, cargo, axles: def.axles };
}

export function buildVehicle(name: string, len: number, wid: number): VehicleModel {
  if (CARS[name]) return buildCar(CARS[name], len, wid);
  if (TRUCKS[name]) return buildTruck(TRUCKS[name]);
  throw new Error(`no model for vehicle "${name}"`);
}

/** Unit wheel (radius 1, width 1, axis along x): dark tyre with a lighter hub. Scale per instance. */
export function buildWheel(): THREE.BufferGeometry {
  const tyre = new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 10).rotateZ(Math.PI / 2);
  for (const g of [tyre, hub]) g.deleteAttribute('uv');
  return mergeGeometries([colorize(tyre, 0.035), colorize(hub, 0.32)])!;
}

/** Player coupe split by material: paint (clearcoat), glass, black trim. */
export function buildCoupe(len: number, wid: number): { paint: THREE.BufferGeometry; glass: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  const h = len / 2;
  const body: Profile = [[-h + 0.02, 0.3], [-h, 0.62], [-h + 0.08, 0.8], [-h + 0.35, 0.9], [-1.2, 0.92], [0.85, 0.9], [1.95, 0.74], [h - 0.02, 0.58], [h, 0.36], [h - 0.1, 0.26], [-h + 0.1, 0.26]];
  const glass: Profile = [[-1.55, 0.9], [-0.7, 1.27], [0.2, 1.29], [0.95, 0.9]];
  const paint = mergeGeometries([
    sideExtrude(body, wid, 1, 0.06),
    part(wid * 0.76, 0.08, 0.77, -0.235, 1.28, 1),
    part(wid * 0.92, 0.04, 0.32, -h + 0.3, 1.0, 1),
    part(0.12, 0.1, 0.2, 0.75, 1.0, 1, wid / 2 + 0.04),
    part(0.12, 0.1, 0.2, 0.75, 1.0, 1, -wid / 2 - 0.04),
  ])!;
  const glassGeo = sideExtrude(glass, wid * 0.8, 1, 0.04);
  const trim = mergeGeometries([
    part(wid + 0.02, 0.14, 2.0, 0, 0.29, 1),
    part(wid * 0.85, 0.16, 0.2, -h + 0.1, 0.32, 1),
    part(wid * 0.9, 0.05, 0.2, h - 0.08, 0.27, 1),
    part(0.05, 0.12, 0.08, -h + 0.3, 0.92, 1, 0.55),
    part(0.05, 0.12, 0.08, -h + 0.3, 0.92, 1, -0.55),
  ])!;
  return { paint, glass: glassGeo, trim };
}
