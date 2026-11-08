import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Cockpit } from './r34Interior';
import type { PlayerCar } from '../../sim/vehicle';
import { Bucket } from './grid';
import { cabinWindshield, cabinRearWindow, cabinSide, cabinPillar, cabinHeadliner, cabinRoof } from './r34CabinShell';
import { acquireCabinMaterials, CabinRaster, CABIN_DIAL_RECTS, cabinLabelRect } from './r34CabinMaterials';
import type { CabinFinish } from './r34CabinMaterials';

/** Independent LHD conversion: deliberately does not use the old RHD EYE/WHEEL constants. */
export const R34_CABIN_LAYOUT = {
  eye: { x: -0.36, y: 1.08, z: 0.7 },
  wheel: { x: -0.36, y: 0.82, z: 0.1, radius: 0.185, tilt: 0.42 },
  cowlZ: -0.6,
} as const;

type Part = 'cabin' | 'wheel' | 'cluster' | 'binnacle' | 'left A-pillar' | 'right A-pillar' | 'roof trim' | 'headliner';
type Entry = { name: string; geometry: THREE.BufferGeometry; material: CabinFinish; part: Part };
type Assets = { entries: Entry[]; needles: THREE.BufferGeometry[]; digital: THREE.BufferGeometry; mfd: THREE.BufferGeometry };
type XYZ = readonly [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);
const CLUSTER: XYZ = [-0.36, 0.845, -0.32];
const DIALS = [{ x: -0.113, y: 0, r: 0.056 }, { x: 0.014, y: 0.003, r: 0.068 }, { x: 0.134, y: 0, r: 0.043 }] as const;

export const R34_CABIN_STEERING = { ratio: 10.5, lock: Math.PI * 3 } as const;

/** Bake many local details into one draw per finish/assembly. Temporary primitive buffers are freed. */
class Assembly {
  private readonly buckets = new Map<string, { bucket: Bucket; material: CabinFinish; part: Part }>();
  add(material: CabinFinish, geometry: THREE.BufferGeometry, position: XYZ = [0, 0, 0], rotation: XYZ = [0, 0, 0], part: Part = 'cabin'): void {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    const key = `${part}:${material}`;
    let b = this.buckets.get(key);
    if (!b) { b = { bucket: new Bucket(), material, part }; this.buckets.set(key, b); }
    b.bucket.addGeometry(geometry);
    geometry.dispose();
  }
  box(material: CabinFinish, size: XYZ, position: XYZ, radius = 0, rotation: XYZ = [0, 0, 0], part: Part = 'cabin'): void {
    const g = radius ? new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map(v => v * 0.48))) : new THREE.BoxGeometry(...size);
    this.add(material, g, position, rotation, part);
  }
  ellipsoid(material: CabinFinish, size: XYZ, position: XYZ, rotation: XYZ = [0, 0, 0], part: Part = 'cabin', segments = 32): void {
    this.add(material, new THREE.SphereGeometry(1, segments, segments / 2).scale(...size), position, rotation, part);
  }
  tube(material: CabinFinish, points: XYZ[], radius: number, segments = 32, radial = 8, part: Part = 'cabin'): void {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    this.add(material, new THREE.TubeGeometry(curve, segments, radius, radial, false), undefined, undefined, part);
  }
  bar(material: CabinFinish, a: XYZ, b: XYZ, radius: number, radial = 12, part: Part = 'cabin'): void {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), delta = bv.clone().sub(av);
    const g = new THREE.CylinderGeometry(radius, radius, delta.length(), radial);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, delta.normalize()));
    this.add(material, g, av.add(bv).multiplyScalar(0.5).toArray() as [number, number, number], undefined, part);
  }
  label(index: number, size: readonly [number, number], position: XYZ, rotation: XYZ = [0, 0, 0], part: Part = 'cabin'): void {
    this.add('atlas', atlasUV(new THREE.PlaneGeometry(...size), cabinLabelRect(index)), position, rotation, part);
  }
  finish(): Entry[] {
    return [...this.buckets].map(([key, b]) => ({ name: `R34 ${key}`, geometry: b.bucket.geometry(), material: b.material, part: b.part }));
  }
}

function atlasUV(g: THREE.BufferGeometry, rect: readonly [number, number, number, number], width = 1024, height = 512): THREE.BufferGeometry {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (rect[0] + uv.getX(i) * rect[2]) / width, 1 - (rect[1] + (1 - uv.getY(i)) * rect[3]) / height);
  }
  return g;
}

/** A smooth open parametric skin with proper normals and physical-scale texture coordinates. */
function surface(nx: number, ny: number, sample: (u: number, v: number) => XYZ, cut?: (u: number, v: number) => boolean, flip = false): THREE.BufferGeometry {
  const p: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    p.push(...sample(i / nx, j / ny)); uv.push(i / nx, j / ny);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (cut?.((i + 0.5) / nx, (j + 0.5) / ny)) continue;
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    if (flip) indices.push(a, b, c, b, d, c);
    else indices.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function buildDashboard(a: Assembly): void {
  a.add('dash', surface(64, 8, (u, v) => {
    const glass = cabinWindshield(u, 0), x = (u - 0.5) * 1.47;
    return [THREE.MathUtils.lerp(glass[0], x, v), THREE.MathUtils.lerp(glass[1] - 0.009, 0.868 - (Math.abs(x) / 0.755) ** 6 * 0.027, v),
      THREE.MathUtils.lerp(glass[2] + 0.004, -0.575 + 0.012 * Math.cos(x * 3), v)];
  }));
  // Lofted dash wraps around the left instrument hood, not a flat plate across the glass.
  const profile: readonly (readonly [number, number])[] = [
    [-0.575, 0.868], [-0.49, 0.897], [-0.39, 0.914], [-0.29, 0.921],
    [-0.21, 0.923], [-0.125, 0.908], [-0.085, 0.863], [-0.08, 0.78], [-0.095, 0.67], [-0.22, 0.555],
  ];
  const dashSection = new THREE.CatmullRomCurve3(profile.map(([z, y]) => new THREE.Vector3(0, y, z)));
  const dashPoint = (x: number, v: number): XYZ => {
    const p = dashSection.getPoint(v);
    const z = p.z;
    let y = p.y;
    y -= Math.pow(Math.abs(x) / 0.755, 6) * 0.027;
    return [x, y, z + 0.012 * Math.cos(x * 3)];
  };
  // Exact patches around the opening, not a raster-cut hole. All four borders
  // are shared with the binnacle return; there are no stair-step triangles or
  // duplicate skins crossing the gauges.
  for (const [left, right] of [[-0.735, -0.59], [-0.13, 0.735]]) a.add('dash', surface(40, 48, (u, v) => dashPoint(THREE.MathUtils.lerp(left, right, u), v)));
  for (const [start, end] of [[0, 0.29], [0.92, 1]]) a.add('dash', surface(40, 16, (u, v) => dashPoint(-0.59 + u * 0.46, THREE.MathUtils.lerp(start, end, v))));
  // Deep molded return from the curved dashboard's exact opening to a compact
  // tilted instrument cassette. The D-shaped, flat-bottom outline fits the
  // actual dials/LCD rather than hanging a large oval below the instruments.
  const boundary = (u: number): THREE.Vector2 => {
    const th = u * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
    return new THREE.Vector2(Math.sign(cs) * Math.abs(cs) ** 0.6 * 0.2,
      sn >= 0 ? Math.pow(sn, 0.8) * 0.092 : -Math.pow(-sn, 0.55) * 0.112);
  };
  const backing = new THREE.Shape(Array.from({ length: 129 }, (_, i) => boundary(i / 128)));
  a.add('black', new THREE.ShapeGeometry(backing, 1), [0, 0, -0.012], undefined, 'cluster');
  const clusterTransform = new THREE.Matrix4().compose(new THREE.Vector3(...CLUSTER), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, 0)), new THREE.Vector3(1, 1, 1));
  a.add('dash', surface(128, 24, (u, v) => {
    const th = u * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th), m = Math.max(Math.abs(cs), Math.abs(sn));
    const outer = dashPoint(-0.36 + cs / m * 0.23, 0.29 + (1 - sn / m) * 0.315);
    const edge = boundary(u), inner = new THREE.Vector3(edge.x, edge.y, -0.009).applyMatrix4(clusterTransform);
    const t = v * v * (3 - 2 * v);
    return [THREE.MathUtils.lerp(inner.x, outer[0], t), THREE.MathUtils.lerp(inner.y, outer[1], t), THREE.MathUtils.lerp(inner.z, outer[2], v)];
  }), undefined, undefined, 'binnacle');
  a.tube('seam', [[0.19, 0.906, -0.1], [0.38, 0.912, -0.101], [0.58, 0.902, -0.115], [0.735, 0.877, -0.123]], 0.0012, 56, 5);
  // Glove box, latch, knee bolster and curved trim rail.
  // Bowed glovebox door is a recessed piece of the passenger fascia, not an add-on slab.
  const glove = (u: number, v: number): XYZ => {
    const x = 0.231 + u * 0.482, y = 0.622 + v * 0.179;
    return [x, y, -0.078 + 0.021 * Math.sin(u * Math.PI) - 0.027 * (1 - v) ** 2];
  };
  a.add('plastic', surface(40, 16, glove, undefined, true));
  a.tube('black', [...Array.from({ length: 21 }, (_, i) => glove(i / 20, 1)),
    ...Array.from({ length: 12 }, (_, i) => glove(1, 1 - i / 11)),
    ...Array.from({ length: 21 }, (_, i) => glove(1 - i / 20, 0)),
    ...Array.from({ length: 12 }, (_, i) => glove(0, i / 11))], 0.0012, 72, 5);
  a.box('black', [0.109, 0.018, 0.009], [0.47, 0.763, -0.051], 0.003);
  a.box('metal', [0.036, 0.006, 0.004], [0.47, 0.764, -0.045], 0.001);
  a.box('plastic', [0.079, 0.013, 0.005], [0.48, 0.817, -0.074], 0.002);
  a.label(5, [0.075, 0.0094], [0.48, 0.817, -0.071]);
  a.box('leather', [0.39, 0.13, 0.12], [-0.39, 0.64, -0.085], 0.026);
  a.tube('metal', [[-0.74, 0.77, -0.08], [-0.64, 0.77, -0.06], [-0.58, 0.76, -0.055]], 0.002, 20, 6);
  a.tube('metal', [[0.23, 0.807, -0.077], [0.48, 0.813, -0.075], [0.71, 0.799, -0.089]], 0.0015, 40, 6);

  const vent = (x: number, y: number, w: number, h: number, z: number) => {
    a.box('plastic', [w + 0.013, h + 0.014, 0.025], [x, y, z - 0.009], 0.01);
    a.box('black', [w, h, 0.014], [x, y, z], 0.007);
    for (let k = 0; k < 6; k++) a.box('plastic', [w - 0.008, 0.0024, 0.014], [x, y - h * 0.38 + k * h * 0.152, z + 0.009], 0, [-0.18, 0, 0]);
    a.box('metal', [0.009, h * 0.43, 0.006], [x, y, z + 0.018], 0.001);
  };
  vent(-0.666, 0.84, 0.095, 0.066, -0.064);
  vent(0.665, 0.843, 0.112, 0.067, -0.063);
  vent(-0.035, 0.841, 0.105, 0.058, -0.029);
  vent(0.094, 0.841, 0.105, 0.058, -0.029);
  // Cowl demisters sit below the windshield edge, following the actual cowl line.
  for (const x of [-0.45, 0.45]) {
    a.box('black', [0.3, 0.003, 0.026], [x, 0.881, -0.51], 0.003);
    for (let i = 0; i < 18; i++) a.box('plastic', [0.003, 0.004, 0.024], [x - 0.14 + i * 0.0165, 0.884, -0.51]);
  }
  // R34 dash-top MFD pod, raised only 5 cm above the adjacent dashboard.
  a.box('dash', [0.235, 0.092, 0.109], [0.04, 0.946, -0.346], 0.013, [-0.15, 0, 0]);
  a.box('black', [0.206, 0.068, 0.01], [0.04, 0.948, -0.287], 0.004, [-0.15, 0, 0]);
  for (let i = 0; i < 4; i++) a.box('plastic', [0.027, 0.007, 0.009], [-0.023 + i * 0.042, 0.904, -0.286], 0.002);
  a.label(7, [0.148, 0.008], [0.04, 0.915, -0.279]);

  // Sloped centre stack. Every knob, button, CD slot and vent is real geometry.
  // Sculpted stack cheeks flow into the transmission tunnel. The switch panels sit in this skin.
  a.add('plastic', surface(32, 30, (u, v) => {
    const y = 0.547 + v * 0.274, half = 0.139 + 0.012 * Math.sin(v * Math.PI);
    const x = 0.035 + (u * 2 - 1) * half;
    return [x, y, -0.002 + 0.028 * (1 - v) - 0.043 * (Math.abs(u * 2 - 1) ** 5)];
  }, undefined, true));
  for (const side of [-1, 1]) a.add('leather', surface(8, 24, (u, v) => {
    const y = 0.55 + v * 0.267, half = 0.139 + 0.012 * Math.sin(v * Math.PI);
    return [0.035 + side * (half + u * 0.023), y, -0.018 - u * 0.07 + 0.027 * (1 - v)];
  }, undefined, side > 0));
  a.box('black', [0.254, 0.071, 0.015], [0.035, 0.744, 0.019], 0.005);
  a.label(3, [0.13, 0.0163], [0.035, 0.753, 0.028]);
  a.box('black', [0.253, 0.08, 0.015], [0.035, 0.644, 0.028], 0.005);
  a.label(4, [0.15, 0.0188], [0.035, 0.661, 0.039]);
  a.label(6, [0.11, 0.0138], [0.035, 0.61, 0.041]);
  for (const [y, radius] of [[0.748, 0.019], [0.642, 0.016]] as const) for (const x of [-0.07, 0.14]) {
    a.add('metal', new THREE.CylinderGeometry(radius + 0.001, radius + 0.001, 0.009, 32), [x, y, 0.032], [Math.PI / 2, 0, 0]);
    a.add('plastic', new THREE.CylinderGeometry(radius, radius, 0.015, 32), [x, y, 0.04], [Math.PI / 2, 0, 0]);
    for (let k = 0; k < 16; k++) {
      const angle = k * Math.PI / 8;
      a.box('black', [0.0014, 0.004, 0.01], [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, 0.043], 0, [0, 0, angle]);
    }
    a.box('seam', [0.002, 0.007, 0.002], [x, y + radius * 0.58, 0.049]);
  }
  a.box('black', [0.163, 0.0035, 0.008], [0.035, 0.682, 0.038]);
  for (let i = 0; i < 6; i++) {
    a.box('plastic', [0.023, 0.012, 0.009], [-0.044 + i * 0.031, 0.627, 0.041], 0.002);
    a.box('seam', [0.007, 0.001, 0.002], [-0.044 + i * 0.031, 0.628, 0.047]);
  }
  for (let i = 0; i < 5; i++) a.box('plastic', [0.028, 0.015, 0.009], [-0.03 + i * 0.033, 0.717, 0.035], 0.003);
  a.box('red', [0.029, 0.024, 0.012], [0.035, 0.798, 0.003], 0.004);
  const tri = new THREE.Shape([new THREE.Vector2(-0.006, -0.004), new THREE.Vector2(0.006, -0.004), new THREE.Vector2(0, 0.006)]);
  a.add('seam', new THREE.ShapeGeometry(tri), [0.035, 0.798, 0.01]);
  // Ignition barrel on the driver's right, with a modeled key and hanging key loop.
  a.add('metal', new THREE.CylinderGeometry(0.012, 0.012, 0.016, 24), [-0.236, 0.742, 0.004], [Math.PI / 2, 0, 0]);
  a.box('black', [0.015, 0.023, 0.009], [-0.237, 0.73, 0.018], 0.004, [0, 0, -0.2]);
  a.add('metal', new THREE.TorusGeometry(0.01, 0.001, 6, 24), [-0.24, 0.711, 0.023]);
}

function buildConsole(a: Assembly): void {
  a.box('carpet', [1.45, 0.055, 1.97], [0, 0.33, 0.51], 0.025);
  a.box('carpet', [1.4, 0.37, 0.075], [0, 0.48, -0.43], 0.02, [-0.35, 0, 0]);
  a.box('leather', [0.257, 0.19, 1.17], [0.015, 0.448, 0.536], 0.036);
  a.box('carbon', [0.236, 0.015, 0.496], [0.015, 0.549, 0.364], 0.014, [-0.03, 0, 0]);
  a.box('plastic', [0.2, 0.064, 0.27], [0.015, 0.568, 0.179], 0.012, [-0.13, 0, 0]);
  a.box('black', [0.147, 0.009, 0.152], [0.015, 0.604, 0.222], 0.024);
  // Leather shifter gaiter with six converging folds, not a bare stick.
  a.add('leather', surface(48, 24, (u, v) => {
    const th = u * Math.PI * 2, r = (0.066 * (1 - v) + 0.014 * v) * (1 + Math.sin(th * 6 + v * 8) * 0.085);
    return [0.015 + Math.cos(th) * r, 0.607 + v * 0.077 + Math.sin(th * 6) * 0.002 * (1 - v), 0.22 + Math.sin(th) * r];
  }));
  a.bar('metal', [0.015, 0.668, 0.22], [0.015, 0.726, 0.215], 0.0075, 20);
  a.ellipsoid('leather', [0.027, 0.031, 0.026], [0.015, 0.738, 0.215], undefined, undefined, 40);
  a.ellipsoid('metal', [0.023, 0.008, 0.022], [0.015, 0.758, 0.215]);
  a.label(2, [0.031, 0.022], [0.015, 0.7665, 0.215], [-Math.PI / 2, 0, 0]);
  a.box('black', [0.048, 0.025, 0.229], [-0.073, 0.555, 0.497], 0.012);
  a.bar('metal', [-0.073, 0.561, 0.578], [-0.073, 0.604, 0.419], 0.009, 16);
  a.bar('leather', [-0.073, 0.604, 0.419], [-0.073, 0.623, 0.345], 0.015, 24);
  a.ellipsoid('metal', [0.009, 0.008, 0.009], [-0.073, 0.624, 0.339]);
  a.box('leather', [0.231, 0.075, 0.3], [0.015, 0.571, 0.84], 0.025);
  a.tube('seam', [[-0.084, 0.607, 0.961], [-0.087, 0.611, 0.751], [0.015, 0.612, 0.708], [0.113, 0.611, 0.751], [0.114, 0.607, 0.961]], 0.001, 52, 5);
  for (const z of [0.61, 0.7]) {
    a.add('black', new THREE.CylinderGeometry(0.031, 0.027, 0.018, 32), [0.061, 0.55, z]);
    a.add('metal', new THREE.TorusGeometry(0.031, 0.0015, 6, 32), [0.061, 0.56, z], [Math.PI / 2, 0, 0]);
  }
  // Driver-side footwell mats, heel plate, clutch/brake/throttle and dead pedal.
  for (const x of [-0.365, 0.365]) {
    a.box('black', [0.43, 0.012, 0.64], [x, 0.369, 0.025], 0.02);
    for (let k = 0; k < 15; k++) a.box('carpet', [0.395, 0.002, 0.004], [x, 0.376, -0.26 + k * 0.04]);
    a.box('metal', [0.2, 0.003, 0.11], [x, 0.379, -0.005], 0.005);
  }
  for (let p = 0; p < 3; p++) {
    const x = -0.527 + p * 0.115, y = p === 2 ? 0.412 : 0.442;
    a.bar('metal', [x, 0.51, -0.339], [x, y, -0.21], 0.007, 12);
    a.box('metal', [p === 2 ? 0.041 : 0.069, 0.09, 0.012], [x, y, -0.197], 0.006, [-0.48, 0, 0]);
    for (let i = 0; i < 5; i++) a.box('black', [p === 2 ? 0.033 : 0.056, 0.004, 0.004], [x, y - 0.033 + i * 0.015, -0.183 - i * 0.007], 0, [-0.48, 0, 0]);
  }
  a.box('plastic', [0.065, 0.14, 0.024], [-0.64, 0.433, -0.22], 0.008, [-0.48, 0, 0.12]);
}

/** Sculpted cushion/back loft: rolled edges, depressed centre and front thigh support. */
function cushionPoint(x: number, u: number, v: number): XYZ {
    const xx = (u - 0.5) * 0.46, z = 0.31 + v * 0.61 + 0.018 * Math.abs(u * 2 - 1) ** 8 * Math.cos(v * Math.PI);
    const edge = Math.pow(Math.abs(u - 0.5) * 2, 4), front = Math.exp(-Math.pow((v - 0.14) / 0.17, 2));
    return [x + xx * (0.96 + Math.sin(v * Math.PI) * 0.04), 0.473 + 0.075 * edge + 0.023 * front - 0.024 * Math.sin(v * Math.PI), z];
}

function seatCushion(x: number): THREE.BufferGeometry {
  return surface(48, 48, (u, v) => cushionPoint(x, u, v));
}

function seatBack(x: number, u: number, v: number): XYZ {
  const s = u * 2 - 1, y = 0.49 + v * 0.594 - 0.021 * Math.abs(s) ** 4 * v ** 20;
  const width = 0.204 + 0.023 * Math.sin(v * Math.PI) - 0.011 * v - 0.014 * v ** 14;
  const bolster = Math.exp(-Math.pow((Math.abs(s) - 0.8) / 0.2, 2));
  const lumbar = Math.sin(v * Math.PI) * 0.026;
  return [x + s * width, y, 0.849 + v * 0.137 - bolster * (0.047 + 0.035 * Math.sin(v * Math.PI)) - lumbar];
}

function buildSeats(a: Assembly): void {
  for (const x of [-0.365, 0.365]) {
    a.box('black', [0.464, 0.1, 0.56], [x, 0.419, 0.615], 0.035);
    for (const dx of [-0.16, 0.16]) {
      a.box('metal', [0.018, 0.024, 0.61], [x + dx, 0.383, 0.602], 0.003);
      for (const z of [0.355, 0.869]) a.add('metal', new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8), [x + dx, 0.4, z]);
    }
    a.add('suede', seatCushion(x));
    // One upholstered back, with continuous molded bolsters and a closed shell.
    // The old separate ellipsoids read as floating sausages in close-up.
    a.add('suede', surface(28, 40, (u, v) => seatBack(x, 0.19 + u * 0.62, v)));
    for (const side of [0, 1]) a.add('leather', surface(14, 40, (u, v) => seatBack(x, side ? 0.81 + u * 0.19 : u * 0.19, v)));
    a.add('leather', surface(40, 40, (u, v) => {
      const p = seatBack(x, u, v);
      return [p[0], p[1], 0.922 + v * 0.137 + 0.013 * Math.sin(u * Math.PI)];
    }, undefined, true));
    for (const edge of [0, 1]) a.add('leather', surface(8, 40, (u, v) => {
      const front = seatBack(x, edge, v), back = 0.922 + v * 0.137;
      return [front[0] + (edge ? 1 : -1) * Math.sin(u * Math.PI) * 0.008, front[1], THREE.MathUtils.lerp(front[2], back, u)];
    }, undefined, edge === 0));
    for (const end of [0, 1]) a.add('leather', surface(40, 8, (u, v) => {
      const front = seatBack(x, u, end), back = 0.922 + end * 0.137 + 0.013 * Math.sin(u * Math.PI);
      return [front[0], front[1] + (end ? 1 : -1) * Math.sin(v * Math.PI) * 0.008, THREE.MathUtils.lerp(front[2], back, v)];
    }, undefined, end === 0));
    // Cushion edge turns down to the base so there is no thin exposed sheet.
    a.add('leather', surface(72, 10, (u, v) => {
      const p = u < 0.25 ? cushionPoint(x, u * 4, 0) : u < 0.5 ? cushionPoint(x, 1, (u - 0.25) * 4)
        : u < 0.75 ? cushionPoint(x, 1 - (u - 0.5) * 4, 1) : cushionPoint(x, 0, 1 - (u - 0.75) * 4);
      return [x + (p[0] - x) * (1 - v * 0.015), THREE.MathUtils.lerp(p[1], 0.431, v), p[2]];
    }));
    for (const side of [-1, 1]) {
      a.tube('seam', [[x + side * 0.158, 0.532, 0.348], [x + side * 0.168, 0.501, 0.55], [x + side * 0.164, 0.501, 0.819]], 0.0012, 48, 5);
      a.tube('seam', Array.from({ length: 25 }, (_, i) => {
        const p = seatBack(x, side < 0 ? 0.19 : 0.81, i / 24);
        return [p[0], p[1], p[2] - 0.001] as XYZ;
      }), 0.001, 40, 5);
      a.bar('metal', [x + side * 0.065, 1.053, 1.002], [x + side * 0.065, 1.143, 1.023], 0.006, 16);
      // Sewn shoulder insert welt, flush with the actual back surface.
      const slot = seatBack(x, side < 0 ? 0.29 : 0.71, 0.84);
      a.box('black', [0.052, 0.019, 0.004], [slot[0], slot[1], slot[2] - 0.001], 0.002, [0.2, 0, 0]);
    }
    a.box('leather', [0.259, 0.155, 0.132], [x, 1.156, 1.019], 0.046, [0.19, 0, 0]);
    a.tube('seam', [[x - 0.104, 1.125, 0.958], [x - 0.102, 1.213, 0.969], [x + 0.102, 1.213, 0.969], [x + 0.104, 1.125, 0.958]], 0.001, 56, 5);
    a.label(0, [0.057, 0.015], [x, 1.126, 0.945], [0, Math.PI, 0]);
    // Perforation stitches across the cushion and back insert.
    for (let j = 0; j < 7; j++) for (const dx of [-0.091, 0.091]) {
      a.box('seam', [0.0008, 0.001, 0.014], [x + dx, 0.479 - 0.017 * Math.sin(j / 6 * Math.PI), 0.4 + j * 0.063]);
    }
    const side = Math.sign(x);
    // Retracted three-point belt and tongue remain sensible when the driver's eye is in the seat.
    const beltGuide = cabinSide(side, 0.56, 0.62);
    a.add('webbing', surface(8, 24, (u, v) => {
      const y = 0.445 + v * (beltGuide[1] - 0.445);
      const base = cabinSide(side, 0.56, 0), top = cabinSide(side, 0.56, 1);
      const anchor = cabinSide(side, 0.56, Math.max(0, (y - base[1]) / (top[1] - base[1])));
      return [anchor[0] - side * 0.016, y, anchor[2] + (u - 0.5) * 0.039];
    }), undefined, undefined);
    a.box('plastic', [0.018, 0.035, 0.064], [beltGuide[0] - side * 0.016, beltGuide[1] - 0.006, beltGuide[2]], 0.006);
    a.box('metal', [0.005, 0.035, 0.027], [side * 0.716, 0.754, 0.504], 0.002);
    a.box('black', [0.032, 0.065, 0.034], [x - side * 0.235, 0.493, 0.816], 0.008, [0, 0, side * 0.15]);
    a.box('red', [0.026, 0.01, 0.025], [x - side * 0.235, 0.528, 0.816], 0.003);
    a.bar('metal', [x - 0.16, 0.414, 0.295], [x + 0.16, 0.414, 0.295], 0.006, 12);
    for (const v of [0.19, 0.34, 0.49, 0.64]) a.tube('seam', Array.from({ length: 17 }, (_, i) => {
      const p = seatBack(x, 0.21 + i / 16 * 0.58, v);
      return [p[0], p[1], p[2] - 0.0007] as XYZ;
    }), 0.00055, 24, 4);
  }
  // Rear coupe bench, divided backrest, stitched pads and central tunnel.
  a.box('leather', [1.29, 0.15, 0.384], [0, 0.551, 1.26], 0.045);
  for (const x of [-0.36, 0.36]) {
    a.ellipsoid('suede', [0.252, 0.056, 0.174], [x, 0.625, 1.251], undefined, undefined, 40);
    a.box('leather', [0.548, 0.299, 0.096], [x, 0.781, 1.474], 0.036, [0.26, 0, 0]);
    a.box('suede', [0.385, 0.239, 0.021], [x, 0.779, 1.412], 0.023, [0.26, 0, 0]);
    a.box('black', [0.033, 0.244, 0.005], [x + Math.sign(x) * 0.212, 0.779, 1.398], 0, [0.26, 0, Math.sign(x) * -0.1]);
    a.box('red', [0.028, 0.018, 0.032], [x - Math.sign(x) * 0.2, 0.64, 1.315], 0.004);
    for (const dx of [-0.185, 0.185]) a.tube('seam', [[x + dx, 0.625, 1.11], [x + dx, 0.653, 1.27], [x + dx, 0.631, 1.389]], 0.001, 32, 5);
  }
  a.box('carpet', [1.28, 0.035, 0.22], [0, 0.969, 1.532], 0.014);
  for (const x of [-0.44, 0.44]) a.add('black', new THREE.CylinderGeometry(0.076, 0.076, 0.004, 40), [x, 0.99, 1.526]);
}

function buildDoorsAndRoof(a: Assembly): void {
  for (const side of [-1, 1]) {
    // Molded door card terminates at the actual glazing belt. Its upper return
    // bridges to the exterior seal instead of leaving a bright painted gap.
    a.add('plastic', surface(56, 26, (u, v) => {
      const station = side > 0 ? 1 - u : u, edge = cabinSide(side, station, 0);
      const y = THREE.MathUtils.lerp(0.385, edge[1] - 0.009, v);
      const arm = Math.exp(-Math.pow((v - 0.55) / 0.15, 2)) * 0.052;
      return [side * (0.735 - arm - 0.012 * Math.sin(station * Math.PI)), y, edge[2]];
    }));
    a.add('leather', surface(48, 8, (u, v) => {
      const edge = cabinSide(side, u, 0);
      return [edge[0] - side * (0.005 + 0.032 * v), edge[1] - 0.008 - 0.006 * Math.sin(v * Math.PI), edge[2]];
    }, undefined, side < 0));
    a.add('suede', surface(42, 16, (u, v) => {
      const z = -0.04 + u * 0.91, endRoll = Math.sin(u * Math.PI) ** 0.4;
      return [side * (0.722 - 0.022 * Math.sin(v * Math.PI)), 0.593 + v * 0.179 * endRoll, z];
    }, undefined, side > 0));
    // Integrated softly tapered pull/armrest, with wrapped ends.
    a.add('leather', surface(48, 20, (u, v) => {
      const th = v * Math.PI * 2, taper = Math.sin(Math.PI * u) ** 0.24;
      return [side * (0.708 - Math.sin(th) * 0.042 * taper), 0.666 + Math.cos(th) * 0.029 * taper, 0.015 + u * 0.634];
    }));
    a.tube('seam', Array.from({ length: 25 }, (_, i) => {
      const u = 0.08 + i / 24 * 0.84, taper = Math.sin(Math.PI * u) ** 0.24;
      return [side * (0.708 - Math.sin(0.9) * 0.042 * taper), 0.666 + Math.cos(0.9) * 0.029 * taper, 0.015 + u * 0.634] as XYZ;
    }), 0.0008, 40, 5);
    a.box('black', [0.021, 0.05, 0.17], [side * 0.723, 0.773, 0.053], 0.012);
    a.box('metal', [0.014, 0.017, 0.109], [side * 0.709, 0.776, 0.051], 0.007, [0.1, 0, 0]);
    a.box('black', [0.065, 0.007, 0.121], [side * 0.691, 0.696, 0.218], 0.007);
    for (let k = 0; k < (side < 0 ? 4 : 1); k++) {
      const z = 0.181 + k * 0.025;
      a.box('plastic', [0.035, 0.009, 0.018], [side * 0.687, 0.704, z], 0.003, [0.1, 0, 0]);
      a.box('seam', [0.008, 0.001, 0.0015], [side * 0.687, 0.709, z]);
    }
    // Door pocket and 3D speaker grille (individual slots merged into one mesh).
    a.box('black', [0.04, 0.085, 0.52], [side * 0.737, 0.461, 0.518], 0.023);
    a.box('plastic', [0.053, 0.047, 0.54], [side * 0.706, 0.43, 0.518], 0.016);
    a.add('black', new THREE.CylinderGeometry(0.079, 0.079, 0.009, 48), [side * 0.727, 0.505, -0.199], [0, 0, Math.PI / 2]);
    a.add('metal', new THREE.TorusGeometry(0.079, 0.0017, 6, 48), [side * 0.717, 0.505, -0.199], [0, Math.PI / 2, 0]);
    for (let row = -10; row <= 10; row++) {
      const half = Math.sqrt(Math.max(0, 0.072 ** 2 - (row * 0.0068) ** 2));
      a.box('plastic', [0.002, 0.0016, half * 2], [side * 0.715, 0.505 + row * 0.0068, -0.199]);
    }
    a.add('black', new THREE.CylinderGeometry(0.022, 0.022, 0.006, 24), [side * 0.735, 0.814, -0.265], [0, 0, Math.PI / 2]);
    // Felt scraper follows the same side-window stations as the painted door top.
    a.tube('black', Array.from({ length: 25 }, (_, i) => {
      const [x, y, z] = cabinSide(side, i / 24, 0); return [x - side * 0.008, y - 0.009, z] as XYZ;
    }), 0.004, 48, 6);
    a.box('metal', [0.079, 0.013, 1.26], [side * 0.754, 0.361, 0.378], 0.006);
    a.label(1, [0.24, 0.03], [side * 0.754, 0.369, 0.378], [-Math.PI / 2, 0, Math.PI / 2]);
    const pillarPart: Part = side < 0 ? 'left A-pillar' : 'right A-pillar';
    a.add('suede', surface(32, 32, (u, v) => cabinPillar(side, u, v)), undefined, undefined, pillarPart);
    // Roof-side upholstery continues from the A-pillar tip into the same rail,
    // then down the B-pillar at u=.67 (not the legacy pillar at z=.95).
    a.add('suede', surface(40, 8, (u, v) => {
      const edge = cabinSide(side, u, 0.94 + v * 0.06);
      return [edge[0] - side * 0.009, edge[1] - 0.01, edge[2] + 0.004 * (1 - u)];
    }), undefined, undefined, 'roof trim');
    a.add('suede', surface(10, 28, (u, v) => {
      const edge = cabinSide(side, 0.56 + (u - 0.5) * 0.02, 0.045 + v * 0.895);
      return [edge[0] - side * 0.013, edge[1] - 0.009, edge[2]];
    }, undefined, side > 0), undefined, undefined, 'roof trim');
    // C-pillar inner return meets rear glass and parcel shelf without an extra bar.
    a.add('suede', surface(12, 28, (u, v) => {
      const edge = cabinSide(side, 0.88, v), rear = cabinRearWindow(side < 0 ? 0.034 : 0.966, v);
      return [THREE.MathUtils.lerp(edge[0], rear[0], u) - side * 0.012,
        THREE.MathUtils.lerp(edge[1], rear[1], u) - 0.012, THREE.MathUtils.lerp(edge[2], rear[2], u)];
    }), undefined, undefined, 'roof trim');
    // Flush grab handle anchored to the rail behind the front seats.
    const grip = cabinSide(side, 0.8, 1);
    a.tube('plastic', [[grip[0] - side * 0.02, grip[1] - 0.02, grip[2] - 0.07],
      [grip[0] - side * 0.036, grip[1] - 0.034, grip[2] - 0.045],
      [grip[0] - side * 0.036, grip[1] - 0.034, grip[2] + 0.045],
      [grip[0] - side * 0.02, grip[1] - 0.02, grip[2] + 0.07]], 0.007, 24, 8);
  }
  a.add('suede', surface(40, 28, cabinHeadliner), undefined, undefined, 'headliner');
  // Front and rear rolled headers close the roof edge and physically join both pillars.
  for (const end of [0, 1]) a.add('suede', surface(48, 10, (u, v) => {
    const point = v > 0.6 ? cabinRoof(u, end === 0 ? (v - 0.6) / 0.4 * 0.035 : 1 - (v - 0.6) / 0.4 * 0.035)
      : end === 0 ? cabinWindshield(u, 0.945 + v / 0.6 * 0.055) : cabinRearWindow(u, 0.945 + v / 0.6 * 0.055);
    return [point[0] * 0.998, point[1] - 0.012, point[2] + (end === 0 ? 0.004 : -0.004)];
  }), undefined, undefined, 'roof trim');
  for (const x of [-0.355, 0.355]) {
    const roof = cabinHeadliner((x / 0.657 + 1) / 2, 0.12), y = roof[1] - 0.02;
    a.box('suede', [0.285, 0.016, 0.119], [x, y, roof[2]], 0.006, [0.015, 0, 0]);
    a.box('plastic', [0.131, 0.003, 0.063], [x, y - 0.01, roof[2]], 0.001);
    for (const dx of [-0.116, 0.116]) a.box('plastic', [0.015, 0.021, 0.028], [x + dx, y + 0.007, roof[2] - 0.045], 0.004);
  }
  a.box('plastic', [0.113, 0.014, 0.089], [0, 1.327, 0.38], 0.006);
  a.box('seam', [0.075, 0.004, 0.039], [0, 1.318, 0.369], 0.001);
  a.box('black', [0.022, 0.006, 0.009], [0, 1.316, 0.407], 0.002);
  // Compact mirror above the eye line, rather than a wide opaque strip across the windscreen.
  a.bar('plastic', [0, 1.328, 0.145], [0, 1.255, 0.125], 0.006, 12);
  a.box('black', [0.218, 0.058, 0.026], [0, 1.245, 0.12], 0.012, [-0.1, -0.15, 0]);
  a.box('glass', [0.2, 0.044, 0.003], [-0.002, 1.245, 0.136], 0.001, [-0.1, -0.15, 0]);
}

function buildWheel(a: Assembly): void {
  const { x, y, z, radius, tilt } = R34_CABIN_LAYOUT.wheel;
  // Steering column uses the same inclined axis as the rotating wheel assembly.
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-tilt, 0, 0)), new THREE.Vector3(1, 1, 1));
  a.add('plastic', new THREE.CylinderGeometry(0.035, 0.042, 0.261, 28).rotateX(Math.PI / 2).translate(0, 0, -0.151).applyMatrix4(transform));
  a.add('black', new RoundedBoxGeometry(0.113, 0.074, 0.16, 2, 0.016).translate(0, -0.008, -0.13).applyMatrix4(transform));
  for (const side of [-1, 1]) {
    a.add('plastic', new THREE.CylinderGeometry(0.005, 0.007, 0.1, 12).rotateZ(Math.PI / 2).translate(side * 0.092, 0.008, -0.067).applyMatrix4(transform));
    a.add('black', new RoundedBoxGeometry(0.039, 0.018, 0.019, 2, 0.004).translate(side * 0.146, 0.008, -0.067).applyMatrix4(transform));
  }
  a.add('leather', new THREE.TorusGeometry(radius, 0.0173, 28, 160), undefined, undefined, 'wheel');
  // Subtle ergonomic thumb swells.
  for (const side of [-1, 1]) a.ellipsoid('leather', [0.019, 0.034, 0.018], [side * 0.178, 0.041, 0], [0, 0, side * 0.32], 'wheel', 32);
  // Individually modeled crossed stitches, merged by material. Two runs around the inner rim.
  for (let i = 0; i < 144; i++) {
    const th = i * Math.PI * 2 / 144;
    for (const s of [-1, 1]) {
      const p0: XYZ = [Math.cos(th - 0.007) * 0.173, Math.sin(th - 0.007) * 0.173, s * 0.011];
      const p1: XYZ = [Math.cos(th + 0.007) * 0.176, Math.sin(th + 0.007) * 0.176, s * 0.014];
      a.bar('seam', p0, p1, 0.00055, 5, 'wheel');
    }
  }
  const spoke = new THREE.Shape([new THREE.Vector2(0.039, 0.027), new THREE.Vector2(0.17, 0.022), new THREE.Vector2(0.163, -0.012), new THREE.Vector2(0.05, -0.037)]);
  for (const side of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(spoke, { depth: 0.011, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.003, bevelThickness: 0.003 });
    if (side < 0) g.rotateY(Math.PI);
    a.add('metal', g, [0, 0, -0.01], undefined, 'wheel');
    a.box('black', [0.062, 0.022, 0.009], [side * 0.107, 0.003, 0.004], 0.007, [0, 0, side * 0.07], 'wheel');
  }
  a.box('metal', [0.042, 0.123, 0.015], [0, -0.109, -0.008], 0.011, [0, 0, 0], 'wheel');
  a.box('black', [0.017, 0.058, 0.009], [0, -0.12, 0.003], 0.005, [0, 0, 0], 'wheel');
  a.ellipsoid('leather', [0.064, 0.054, 0.029], [0, -0.005, 0.008], undefined, 'wheel', 48);
  a.label(0, [0.06, 0.024], [0, 0.008, 0.0405], undefined, 'wheel');
  a.label(5, [0.041, 0.0052], [0, -0.025, 0.039], undefined, 'wheel');
  for (let i = 0; i < 6; i++) {
    const th = i * Math.PI / 3;
    a.add('metal', new THREE.CylinderGeometry(0.0022, 0.0022, 0.002, 6), [Math.cos(th) * 0.056, Math.sin(th) * 0.05, 0.029], [Math.PI / 2, 0, 0], 'wheel');
  }
}

function buildInstruments(a: Assembly): THREE.BufferGeometry[] {
  const needles = DIALS.map((d, i) => {
    a.add('metal', new THREE.TorusGeometry(d.r + 0.002, 0.0022, 8, 64), [d.x, d.y, 0.005], undefined, 'cluster');
    a.add('black', new THREE.CylinderGeometry(d.r + 0.001, d.r + 0.001, 0.012, 64), [d.x, d.y, -0.003], [Math.PI / 2, 0, 0], 'cluster');
    a.add('atlas', atlasUV(new THREE.CircleGeometry(d.r, 80), CABIN_DIAL_RECTS[i]), [d.x, d.y, 0.004], undefined, 'cluster');
    a.add('black', new THREE.CylinderGeometry(0.006, 0.006, 0.005, 24), [d.x, d.y, 0.011], [Math.PI / 2, 0, 0], 'cluster');
    const r = d.r * 0.88;
    const shape = new THREE.Shape([new THREE.Vector2(-0.011, -0.0017), new THREE.Vector2(r, -0.0006), new THREE.Vector2(r, 0.0006), new THREE.Vector2(-0.011, 0.0017)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.0007, bevelEnabled: false });
    return g;
  });
  a.box('black', [0.161, 0.038, 0.008], [0.012, -0.087, 0.009], 0.003, undefined, 'cluster');
  return needles;
}

let cached: Assets | undefined;
function cabinAssets(): Assets {
  if (!cached) {
    const a = new Assembly();
    buildDashboard(a); buildConsole(a); buildSeats(a); buildDoorsAndRoof(a); buildWheel(a);
    const needles = buildInstruments(a);
    cached = { entries: a.finish(), needles,
      digital: atlasUV(new THREE.PlaneGeometry(0.15, 0.028125), [0, 0, 256, 48], 256, 128),
      mfd: atlasUV(new THREE.PlaneGeometry(0.19, 0.0594), [0, 48, 256, 80], 256, 128),
    };
  }
  // Model-lifetime immutable geometry: never released by one car, including the last current car.
  return cached;
}

function drawReadouts(r: CabinRaster, state: { gear: number; speed: number; odo: number; boost: number; oil: number; water: number; throttle: number }): string {
  const gear = state.gear === 0 ? 'R' : state.gear < 0 ? 'N' : String(state.gear);
  const boost = state.boost.toFixed(2), oil = Math.round(state.oil), water = Math.round(state.water), throttle = Math.round(state.throttle * 100);
  const odo = state.odo.toFixed(1).padStart(8, '0'), speed = Math.round(state.speed).toString().padStart(3, '0');
  const signature = `${gear}/${speed}/${odo}/${boost}/${oil}/${water}/${throttle}`;
  r.rect(0, 0, 256, 128, [8, 15, 17]);
  r.text(`ODO ${odo} KM`, 8, 5, 1, [155, 181, 160]);
  r.text(speed, 8, 20, 3, [222, 233, 219]); r.text('KM/H', 66, 31, 1);
  r.text(`GEAR ${gear}`, 112, 20, 2, [230, 181, 91]);
  r.line(0, 47, 255, 47, [45, 69, 74]);
  r.text('GT-R MULTI FUNCTION DISPLAY', 8, 52, 1, [177, 199, 203]);
  r.text(`BOOST ${boost} BAR`, 8, 66, 2, [232, 160, 73]);
  r.text(`OIL ${oil} C   WATER ${water} C`, 8, 87, 1, [176, 207, 205]);
  r.text(`THROTTLE ${throttle}%`, 8, 101, 1, [176, 207, 205]);
  for (let i = 0; i < 24; i++) r.rect(8 + i * 10, 116, 7, 6, i < throttle * 0.24 ? [87, 161, 156] : [22, 41, 44]);
  return signature;
}

/**
 * Complete LHD R34 cabin. Attach group directly to the body; keep it visible in exterior views.
 * setCockpit only switches live instruments. Private materials are safe for the caller's ghost fade.
 * dispose is idempotent and must replace generic traversal disposal for this subtree.
 */
export function buildR34Cockpit(): Cockpit & { dispose(): void; setCockpit(on: boolean): void } {
  const resources = acquireCabinMaterials(), assets = cabinAssets(), { materials } = resources;
  const group = new THREE.Group(); group.name = 'R34 LHD cabin';
  group.userData.r34Cabin = true;
  const eye = new THREE.Object3D(); eye.name = 'R34 LHD driver eye';
  eye.position.set(R34_CABIN_LAYOUT.eye.x, R34_CABIN_LAYOUT.eye.y, R34_CABIN_LAYOUT.eye.z); group.add(eye);
  const wheelAxis = new THREE.Group(); wheelAxis.name = 'R34 inclined steering axis';
  wheelAxis.position.set(R34_CABIN_LAYOUT.wheel.x, R34_CABIN_LAYOUT.wheel.y, R34_CABIN_LAYOUT.wheel.z);
  wheelAxis.rotation.x = -R34_CABIN_LAYOUT.wheel.tilt; group.add(wheelAxis);
  const wheel = new THREE.Group(); wheel.name = 'R34 animated steering wheel'; wheelAxis.add(wheel);
  const cluster = new THREE.Group(); cluster.name = 'R34 three analog instruments';
  cluster.position.set(...CLUSTER); cluster.rotation.x = -0.2; group.add(cluster);
  const parents: Record<Part, THREE.Group> = { cabin: group, wheel, cluster, binnacle: group,
    'left A-pillar': group, 'right A-pillar': group, 'roof trim': group, headliner: group };
  for (const entry of assets.entries) {
    const mesh = new THREE.Mesh(entry.geometry, materials[entry.material]); mesh.name = entry.name;
    mesh.castShadow = entry.material !== 'atlas'; mesh.receiveShadow = entry.material !== 'atlas';
    parents[entry.part].add(mesh);
  }
  const needles = assets.needles.map((g, i) => {
    const mesh = new THREE.Mesh(g, materials.needle); mesh.name = `R34 ${['speed', 'tach', 'boost'][i]} needle`;
    mesh.position.set(DIALS[i].x, DIALS[i].y, 0.007); cluster.add(mesh); return mesh;
  });
  const raster = new CabinRaster(256, 128), readouts = raster.texture(true); readouts.name = 'R34 private 12Hz readouts';
  const readoutMat = new THREE.MeshBasicMaterial({ map: readouts, toneMapped: false });
  const digital = new THREE.Mesh(assets.digital, readoutMat); digital.name = 'R34 odometer gear speed display';
  digital.position.set(0.012, -0.087, 0.016); cluster.add(digital);
  const mfd = new THREE.Mesh(assets.mfd, readoutMat); mfd.name = 'R34 live MFD';
  mfd.position.set(0.04, 0.948, -0.28); mfd.rotation.x = -0.15; group.add(mfd);
  // Defaults are deliberately visible for a standalone build. Exterior mode keeps analog faces,
  // seats, wheel, dash and trim, but sleeps needles and small dynamic LCD surfaces.
  let cockpit = true, disposed = false, speed = 0, rpm = 900, boost = -0.6, oil = 74, water = 77, steer = 0, odometer = 0;
  let elapsed = 0, lastSignature = '';
  const initial = { gear: 1, speed, odo: odometer, boost, oil, water, throttle: 0 };
  lastSignature = drawReadouts(raster, initial); readouts.needsUpdate = true;
  const setNeedles = () => {
    // Positive right input is clockwise as seen by a driver looking along -z.
    const angle = (value: number, min: number, max: number) => THREE.MathUtils.degToRad(225 - THREE.MathUtils.clamp((value - min) / (max - min), 0, 1) * 270);
    needles[0].rotation.z = angle(speed, 0, 320); needles[1].rotation.z = angle(rpm, 0, 10000); needles[2].rotation.z = angle(boost, -1, 2);
  };
  setNeedles();

  const update = (car: PlayerCar, dt: number): void => {
    if (disposed) return;
    const step = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.25) : 0;
    const actualSpeed = Number.isFinite(car.speed) ? car.speed * 3.6 : 0;
    odometer += actualSpeed / 3600 * step;
    // Match the visible road wheels, including opposite lock and replicated remote steering.
    const target = THREE.MathUtils.clamp((Number.isFinite(car.steerAngle) ? car.steerAngle : 0) * R34_CABIN_STEERING.ratio, -R34_CABIN_STEERING.lock, R34_CABIN_STEERING.lock);
    steer = THREE.MathUtils.damp(steer, target, 18, step); wheel.rotation.z = -steer;
    if (!cockpit || !group.visible || !cluster.visible) return;
    // Do not update expensive instruments when an ancestor body has been hidden either.
    for (let parent = group.parent; parent; parent = parent.parent) if (!parent.visible) return;
    speed = THREE.MathUtils.damp(speed, actualSpeed, 14, step);
    const actualRpm = Number.isFinite(car.rpm) ? car.rpm : 900;
    const throttle = Number.isFinite(car.throttle) ? THREE.MathUtils.clamp(car.throttle, 0, 1) : 0;
    rpm = THREE.MathUtils.damp(rpm, actualRpm, 16, step);
    boost = THREE.MathUtils.damp(boost, THREE.MathUtils.clamp((actualRpm - 2300) / 2600, 0, 1) * throttle * 1.2 - (1 - throttle) * 0.62, 5, step);
    oil = THREE.MathUtils.damp(oil, 84 + rpm / 8000 * 26, 0.04, step);
    water = THREE.MathUtils.damp(water, 80 + rpm / 8000 * 10, 0.03, step);
    setNeedles();
    elapsed += step;
    if (elapsed + 1e-9 < 1 / 12) return;
    elapsed = Math.max(0, elapsed - Math.floor((elapsed + 1e-9) * 12) / 12);
    const state = { gear: car.gear, speed: actualSpeed, odo: odometer, boost, oil, water, throttle };
    const gear = state.gear === 0 ? 'R' : state.gear < 0 ? 'N' : String(state.gear);
    const signature = `${gear}/${Math.round(actualSpeed).toString().padStart(3, '0')}/${odometer.toFixed(1).padStart(8, '0')}/${boost.toFixed(2)}/${Math.round(oil)}/${Math.round(water)}/${Math.round(throttle * 100)}`;
    if (signature !== lastSignature) { lastSignature = drawReadouts(raster, state); readouts.needsUpdate = true; }
  };
  return { group, eye, update, setCockpit(on: boolean) {
    if (disposed) return;
    cockpit = on; digital.visible = mfd.visible = on; needles.forEach(n => { n.visible = on; });
    if (on) elapsed = 1 / 12;
  }, dispose() {
    if (disposed) return;
    disposed = true; group.removeFromParent(); group.clear();
    readoutMat.dispose(); readouts.dispose(); resources.release();
  } };
}
