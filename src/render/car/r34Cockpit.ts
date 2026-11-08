import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Cockpit } from './r34Interior';
import type { PlayerCar } from '../../sim/vehicle';
import { Bucket } from './grid';
import * as S from './r34Shape';
import { acquireCabinMaterials, CabinRaster, CABIN_DIAL_RECTS, cabinLabelRect } from './r34CabinMaterials';
import type { CabinFinish } from './r34CabinMaterials';

/** Independent LHD conversion: deliberately does not use the old RHD EYE/WHEEL constants. */
export const R34_CABIN_LAYOUT = {
  eye: { x: -0.36, y: 1.08, z: 0.7 },
  wheel: { x: -0.36, y: 0.82, z: 0.1, radius: 0.185, tilt: 0.42 },
  cowlZ: -0.6,
} as const;

type Part = 'cabin' | 'wheel' | 'cluster';
type Entry = { name: string; geometry: THREE.BufferGeometry; material: CabinFinish; part: Part };
type Assets = { entries: Entry[]; needles: THREE.BufferGeometry[]; digital: THREE.BufferGeometry; mfd: THREE.BufferGeometry };
type XYZ = readonly [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);
const CLUSTER: XYZ = [-0.36, 0.856, -0.19];
const DIALS = [{ x: -0.113, y: 0, r: 0.06 }, { x: 0.025, y: 0.003, r: 0.075 }, { x: 0.153, y: 0, r: 0.046 }] as const;

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
    const g = radius ? new RoundedBoxGeometry(...size, 2, radius) : new THREE.BoxGeometry(...size);
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
function surface(nx: number, ny: number, sample: (u: number, v: number) => XYZ, cut?: (u: number, v: number) => boolean): THREE.BufferGeometry {
  const p: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    p.push(...sample(i / nx, j / ny)); uv.push(i / nx, j / ny);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (cut?.((i + 0.5) / nx, (j + 0.5) / ny)) continue;
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function buildDashboard(a: Assembly): void {
  // Lofted dash wraps around the left instrument hood, not a flat plate across the glass.
  const profile: readonly (readonly [number, number])[] = [
    [-0.575, 0.868], [-0.49, 0.897], [-0.39, 0.914], [-0.29, 0.921],
    [-0.21, 0.923], [-0.125, 0.908], [-0.085, 0.863], [-0.08, 0.78], [-0.095, 0.67], [-0.22, 0.555],
  ];
  a.add('dash', surface(120, 54, (u, v) => {
    const x = (u - 0.5) * 1.51, t = v * (profile.length - 1), j = Math.min(profile.length - 2, Math.floor(t)), f = t - j;
    const z = THREE.MathUtils.lerp(profile[j][0], profile[j + 1][0], f);
    let y = THREE.MathUtils.lerp(profile[j][1], profile[j + 1][1], f);
    const binnacle = Math.exp(-Math.pow((x + 0.355) / 0.235, 6));
    y += binnacle * Math.exp(-Math.pow((v - 0.44) / 0.16, 4)) * 0.074;
    y -= Math.pow(Math.abs(x) / 0.755, 6) * 0.027;
    return [x, y, z + 0.012 * Math.cos(x * 3)];
  }, (u, v) => {
    const x = (u - 0.5) * 1.51;
    return x > -0.569 && x < -0.143 && v > 0.59 && v < 0.89;
  }));
  // Black recessed cluster backing; polished lips never cross the forward view above y=1.0.
  a.box('black', [0.406, 0.211, 0.036], [-0.35, 0.85, -0.217], 0.021, [-0.2, 0, 0]);
  a.tube('leather', [[-0.565, 0.799, -0.151], [-0.564, 0.933, -0.191], [-0.48, 0.987, -0.238], [-0.3, 0.994, -0.243], [-0.163, 0.956, -0.22], [-0.145, 0.8, -0.15]], 0.009, 72, 10);
  a.tube('seam', [[-0.739, 0.881, -0.1], [-0.62, 0.912, -0.115], [-0.56, 0.953, -0.18], [-0.47, 0.982, -0.22], [-0.29, 0.989, -0.23], [-0.17, 0.953, -0.2]], 0.001, 100, 5);
  a.tube('seam', [[0.19, 0.906, -0.1], [0.38, 0.912, -0.101], [0.58, 0.902, -0.115], [0.735, 0.877, -0.123]], 0.0012, 56, 5);
  // Glove box, latch, knee bolster and curved trim rail.
  a.box('plastic', [0.493, 0.185, 0.068], [0.475, 0.716, -0.09], 0.018);
  a.box('black', [0.109, 0.018, 0.009], [0.47, 0.763, -0.051], 0.003);
  a.box('metal', [0.036, 0.006, 0.004], [0.47, 0.764, -0.045], 0.001);
  a.label(5, [0.075, 0.0094], [0.48, 0.817, -0.045]);
  a.box('leather', [0.39, 0.13, 0.12], [-0.39, 0.64, -0.085], 0.026);
  a.tube('metal', [[-0.74, 0.77, -0.08], [-0.64, 0.77, -0.06], [-0.58, 0.76, -0.055]], 0.002, 20, 6);
  a.tube('metal', [[0.23, 0.807, -0.041], [0.48, 0.813, -0.039], [0.71, 0.799, -0.066]], 0.002, 40, 6);

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
  a.box('carbon', [0.29, 0.28, 0.055], [0.035, 0.684, -0.018], 0.012, [-0.1, 0, 0]);
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
function seatCushion(x: number): THREE.BufferGeometry {
  return surface(48, 48, (u, v) => {
    const xx = (u - 0.5) * 0.46, z = 0.31 + v * 0.61;
    const edge = Math.pow(Math.abs(u - 0.5) * 2, 4), front = Math.exp(-Math.pow((v - 0.14) / 0.17, 2));
    return [x + xx * (0.96 + Math.sin(v * Math.PI) * 0.04), 0.473 + 0.075 * edge + 0.023 * front - 0.024 * Math.sin(v * Math.PI), z];
  });
}

function buildSeats(a: Assembly): void {
  for (const x of [-0.365, 0.365]) {
    a.box('black', [0.464, 0.1, 0.56], [x, 0.419, 0.615], 0.035);
    for (const dx of [-0.16, 0.16]) {
      a.box('metal', [0.018, 0.024, 0.61], [x + dx, 0.383, 0.602], 0.003);
      for (const z of [0.355, 0.869]) a.add('metal', new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8), [x + dx, 0.4, z]);
    }
    a.add('suede', seatCushion(x));
    // Back faces forward (-z); shoulder wings widen above lumbar and tuck at the headrest.
    a.add('suede', surface(48, 56, (u, v) => {
      const y = 0.49 + v * 0.594, width = 0.197 + 0.04 * Math.sin(v * Math.PI) - 0.02 * v;
      const edge = Math.pow(Math.abs(u - 0.5) * 2, 4);
      return [x + (u - 0.5) * width * 2, y, 0.849 + v * 0.137 - edge * 0.077 - Math.sin(v * Math.PI) * 0.026];
    }));
    a.box('leather', [0.42, 0.568, 0.083], [x, 0.798, 0.982], 0.04, [0.215, 0, 0]);
    for (const side of [-1, 1]) {
      // Separate soft side bolsters with continuous curvature, not intersecting boxes.
      a.ellipsoid('leather', [0.058, 0.056, 0.269], [x + side * 0.197, 0.511, 0.61], [0, 0, side * -0.12], undefined, 48);
      a.ellipsoid('leather', [0.062, 0.255, 0.068], [x + side * 0.184, 0.798, 0.88], [0.2, 0, side * -0.07], undefined, 48);
      a.ellipsoid('leather', [0.081, 0.075, 0.072], [x + side * 0.18, 1.015, 0.93], [0.1, 0, side * 0.25], undefined, 32);
      a.tube('seam', [[x + side * 0.158, 0.532, 0.348], [x + side * 0.168, 0.501, 0.55], [x + side * 0.164, 0.501, 0.819]], 0.0012, 48, 5);
      a.tube('seam', [[x + side * 0.152, 0.554, 0.832], [x + side * 0.162, 0.798, 0.844], [x + side * 0.164, 1.027, 0.91]], 0.0012, 54, 5);
      a.bar('metal', [x + side * 0.065, 1.053, 1.002], [x + side * 0.065, 1.143, 1.023], 0.006, 16);
      a.box('black', [0.065, 0.029, 0.024], [x + side * 0.092, 0.987, 0.913], 0.009, [0.2, 0, 0]);
      a.box('metal', [0.057, 0.02, 0.004], [x + side * 0.092, 0.987, 0.898], 0.006, [0.2, 0, 0]);
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
    a.box('black', [0.037, 0.39, 0.003], [side * 0.688, 0.873, 0.88], 0, [0.1, 0, side * 0.08]);
    a.box('metal', [0.051, 0.034, 0.014], [side * 0.681, 1.073, 0.863], 0.006);
    a.box('metal', [0.027, 0.042, 0.004], [side * 0.688, 0.763, 0.872], 0.004);
    a.box('black', [0.032, 0.065, 0.034], [x - side * 0.235, 0.493, 0.816], 0.008, [0, 0, side * 0.15]);
    a.box('red', [0.026, 0.01, 0.025], [x - side * 0.235, 0.528, 0.816], 0.003);
    a.bar('metal', [x - 0.16, 0.414, 0.295], [x + 0.16, 0.414, 0.295], 0.006, 12);
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
    a.add('plastic', surface(66, 28, (u, v) => {
      const z = -0.44 + (side > 0 ? 1 - u : u) * 1.55, f = -z;
      const y = THREE.MathUtils.lerp(0.385, S.baseY(f) - 0.012, v);
      const bulge = Math.exp(-Math.pow((v - 0.58) / 0.16, 2)) * 0.048;
      return [side * (S.baseX(f) - 0.038 - bulge), y, z];
    }));
    a.box('suede', [0.023, 0.19, 0.89], [side * 0.742, 0.651, 0.37], 0.022);
    a.box('leather', [0.092, 0.059, 0.62], [side * 0.697, 0.662, 0.329], 0.021, [0, side * 0.035, 0]);
    a.tube('seam', [[side * 0.652, 0.681, 0.068], [side * 0.65, 0.691, 0.25], [side * 0.661, 0.686, 0.591]], 0.0013, 60, 5);
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
    a.tube('black', [[side * 0.773, 0.864, -0.44], [side * 0.757, 0.879, 0.17], [side * 0.766, 0.896, 0.77], [side * 0.764, 0.899, 1.08]], 0.008, 72, 8);
    a.box('metal', [0.079, 0.013, 1.26], [side * 0.754, 0.361, 0.378], 0.006);
    a.label(1, [0.24, 0.03], [side * 0.754, 0.369, 0.378], [-Math.PI / 2, 0, Math.PI / 2]);
    // A-pillars sampled on the existing greenhouse edge; no freestanding windshield obstruction.
    const aPillar: XYZ[] = [];
    for (let i = 0; i <= 12; i++) {
      const f = THREE.MathUtils.lerp(0.555, -0.275, i / 12);
      aPillar.push([side * (S.railX(f) - 0.02), S.railY(f) - 0.018, -f]);
    }
    a.tube('suede', aPillar, 0.019, 60, 10);
    a.tube('black', aPillar.map(([x, y, z]) => [x + side * 0.014, y - 0.006, z]), 0.004, 60, 6);
    a.tube('suede', [[side * 0.725, 0.899, 0.94], [side * 0.681, 1.069, 0.95], [side * 0.645, 1.263, 0.95]], 0.025, 30, 10);
    a.tube('suede', [[side * 0.634, 1.268, 1.02], [side * 0.667, 1.174, 1.26], [side * 0.714, 1.04, 1.49]], 0.035, 40, 10);
    a.tube('plastic', [[side * 0.611, 1.278, 0.62], [side * 0.599, 1.289, 0.76], [side * 0.608, 1.271, 0.88]], 0.009, 30, 10);
  }
  // Headliner follows roof only (f=-.31..-.99); it does not fill either glass aperture.
  a.add('suede', surface(48, 32, (u, v) => {
    const f = -0.31 - v * 0.68, x = (u - 0.5) * (S.railX(f) - 0.018) * 2;
    return [x, S.screenY(f, x) - 0.021, -f];
  }));
  for (const x of [-0.355, 0.355]) {
    const y = S.screenY(-0.365, x) - 0.041;
    a.box('suede', [0.304, 0.018, 0.119], [x, y, 0.365], 0.014, [0.12, 0, 0]);
    a.box('plastic', [0.131, 0.004, 0.063], [x, y - 0.012, 0.365], 0.007);
    for (const dx of [-0.124, 0.124]) a.box('plastic', [0.017, 0.023, 0.033], [x + dx, y + 0.009, 0.323], 0.004);
  }
  a.box('plastic', [0.113, 0.014, 0.089], [0, 1.315, 0.6], 0.012);
  a.box('seam', [0.075, 0.004, 0.039], [0, 1.306, 0.589], 0.006);
  a.box('black', [0.022, 0.006, 0.009], [0, 1.304, 0.627], 0.003);
  // Compact mirror above the eye line, rather than a wide opaque strip across the windscreen.
  a.bar('plastic', [0, 1.287, 0.258], [0, 1.225, 0.247], 0.008, 12);
  a.box('black', [0.243, 0.063, 0.031], [0, 1.217, 0.249], 0.018, [-0.1, -0.15, 0]);
  a.box('glass', [0.222, 0.047, 0.003], [-0.002, 1.217, 0.266], 0.012, [-0.1, -0.15, 0]);
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
  a.ellipsoid('leather', [0.071, 0.067, 0.032], [0, 0, 0.008], undefined, 'wheel', 48);
  a.label(0, [0.06, 0.024], [0, 0.008, 0.0405], undefined, 'wheel');
  a.label(5, [0.041, 0.0052], [0, -0.025, 0.039], undefined, 'wheel');
  for (let i = 0; i < 6; i++) {
    const th = i * Math.PI / 3;
    a.add('metal', new THREE.CylinderGeometry(0.0022, 0.0022, 0.002, 6), [Math.cos(th) * 0.056, Math.sin(th) * 0.05, 0.029], [Math.PI / 2, 0, 0], 'wheel');
  }
}

function buildInstruments(a: Assembly): THREE.BufferGeometry[] {
  return DIALS.map((d, i) => {
    a.add('metal', new THREE.TorusGeometry(d.r + 0.002, 0.0022, 8, 64), [d.x, d.y, 0.005], undefined, 'cluster');
    a.add('black', new THREE.CylinderGeometry(d.r + 0.001, d.r + 0.001, 0.012, 64), [d.x, d.y, -0.003], [Math.PI / 2, 0, 0], 'cluster');
    a.add('atlas', atlasUV(new THREE.CircleGeometry(d.r, 80), CABIN_DIAL_RECTS[i]), [d.x, d.y, 0.004], undefined, 'cluster');
    a.add('black', new THREE.CylinderGeometry(0.006, 0.006, 0.005, 24), [d.x, d.y, 0.011], [Math.PI / 2, 0, 0], 'cluster');
    const r = d.r * 0.88;
    const shape = new THREE.Shape([new THREE.Vector2(-0.011, -0.0017), new THREE.Vector2(r, -0.0006), new THREE.Vector2(r, 0.0006), new THREE.Vector2(-0.011, 0.0017)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.0007, bevelEnabled: false });
    return g;
  });
}

let cached: Assets | undefined;
function cabinAssets(): Assets {
  if (!cached) {
    const a = new Assembly();
    buildDashboard(a); buildConsole(a); buildSeats(a); buildDoorsAndRoof(a); buildWheel(a);
    const needles = buildInstruments(a);
    cached = { entries: a.finish(), needles,
      digital: atlasUV(new THREE.PlaneGeometry(0.238, 0.0446), [0, 0, 256, 48], 256, 128),
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
export function buildR34Cockpit(): Cockpit & { dispose(): void; setCockpit?(on: boolean): void } {
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
  const parents = { cabin: group, wheel, cluster };
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
  digital.position.set(0.015, -0.088, 0.016); cluster.add(digital);
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
    const actualSpeed = Number.isFinite(car.vAlong) ? Math.abs(car.vAlong) * 3.6 : 0;
    odometer += actualSpeed / 3600 * step;
    // Match the visible road wheels, including opposite lock and replicated remote steering.
    const target = THREE.MathUtils.clamp((Number.isFinite(car.steerAngle) ? car.steerAngle : 0) * 10.5, -2.55, 2.55);
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
