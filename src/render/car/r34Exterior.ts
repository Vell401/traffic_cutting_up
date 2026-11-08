import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createR34Materials, R34_DECALS, R34_TEXTURE_BUDGET } from './r34Materials';
import type { R34MaterialName } from './r34Materials';

/** Metres, +X right, +Y up, -Z forward. Independent of the previous R34 implementation. */
const AXLES = [-1.35, 1.315] as const;
const WHEEL_Y = 0.327;
const ARCH_R = 0.374;
const TAU = Math.PI * 2;
type V3 = readonly [number, number, number];
type GeometryMap = Partial<Record<R34MaterialName, THREE.BufferGeometry>>;

export const R34_EXTERIOR_BUDGET = Object.freeze({
  length: 4.6,
  width: 1.785,
  height: 1.36,
  wheelRadius: WHEEL_Y,
  axles: AXLES,
  targetTriangles: [150000, 350000] as const,
  maximumDrawCalls: 44,
  textures: R34_TEXTURE_BUDGET,
});

/** A build-time collector. The cached output is immutable and shared, not the temporary primitives. */
class Parts {
  private readonly parts = new Map<R34MaterialName, THREE.BufferGeometry[]>();

  add(material: R34MaterialName, geometry: THREE.BufferGeometry): void {
    const list = this.parts.get(material) ?? [];
    list.push(geometry);
    this.parts.set(material, list);
  }

  finish(): GeometryMap {
    const result: GeometryMap = {};
    for (const [name, parts] of this.parts) {
      const flat = parts.map(g => g.index ? g.toNonIndexed() : g);
      const merged = mergeGeometries(flat, false)!;
      const geometry = mergeVertices(merged, 0.000001);
      geometry.name = `R34/shared/${name}`;
      geometry.userData.shared = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      result[name] = geometry;
      merged.dispose();
      for (const g of new Set([...parts, ...flat])) g.dispose();
    }
    this.parts.clear();
    return result;
  }
}

function surface(nx: number, ny: number, point: (u: number, v: number) => V3, flip = false): THREE.BufferGeometry {
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const u = i / nx, v = j / ny;
    positions.push(...point(u, v));
    uv.push(u, v);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    if (flip) indices.push(a, c, b, b, c, d);
    else indices.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function box(p: Parts, mat: R34MaterialName, size: V3, pos: V3, radius = 0.008, rotation?: V3): void {
  const g = radius > 0
    ? new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(radius, ...size.map(v => v * 0.48)))
    : new THREE.BoxGeometry(...size);
  if (rotation) g.rotateX(rotation[0]).rotateY(rotation[1]).rotateZ(rotation[2]);
  g.translate(...pos);
  p.add(mat, g);
}

function beam(p: Parts, mat: R34MaterialName, a: V3, b: V3, radius: number, segments = 10): void {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const axis = end.clone().sub(start);
  const g = new THREE.CylinderGeometry(radius, radius, axis.length(), segments, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
  g.translate(...start.add(end).multiplyScalar(0.5).toArray());
  p.add(mat, g);
}

function tube(p: Parts, mat: R34MaterialName, points: readonly V3[], radius: number, segments = 64, radial = 6, closed = false): void {
  const curve = new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(...v)), closed, 'centripetal');
  p.add(mat, new THREE.TubeGeometry(curve, segments, radius, radial, closed));
}

function ring(p: Parts, mat: R34MaterialName, r: number, thickness: number, pos: V3, axis: 'x' | 'z' = 'z', segments = 72): void {
  const g = new THREE.TorusGeometry(r, thickness, 6, segments);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  g.translate(...pos);
  p.add(mat, g);
}

function cylinder(p: Parts, mat: R34MaterialName, radius: number, depth: number, pos: V3, axis: 'x' | 'z', segments = 64): void {
  const g = new THREE.CylinderGeometry(radius, radius, depth, segments, 1);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else g.rotateX(Math.PI / 2);
  g.translate(...pos);
  p.add(mat, g);
}

function decal(p: Parts, cell: keyof typeof R34_DECALS, size: readonly [number, number], pos: V3, rotation: V3 = [0, 0, 0]): void {
  const [x, y, w, h] = R34_DECALS[cell];
  const g = new THREE.PlaneGeometry(...size);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, x + uv.getX(i) * w, 1 - y - h + uv.getY(i) * h);
  g.rotateX(rotation[0]).rotateY(rotation[1]).rotateZ(rotation[2]).translate(...pos);
  p.add('decal', g);
}

function smooth(a: number, b: number, t: number): number {
  const v = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return v * v * (3 - 2 * v);
}

/** Preserve smooth bevel normals while bending a panel; recomputing on disconnected cap triangles facets it. */
function warpZ(g: THREE.BufferGeometry, offset: number, bend: (x: number, y: number) => number): void {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  const epsilon = 0.0001;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const dx = (bend(x + epsilon, y) - bend(x - epsilon, y)) / (2 * epsilon);
    const dy = (bend(x, y + epsilon) - bend(x, y - epsilon)) / (2 * epsilon);
    const nx = n.getX(i) - dx * n.getZ(i), ny = n.getY(i) - dy * n.getZ(i), nz = n.getZ(i);
    const length = Math.hypot(nx, ny, nz);
    n.setXYZ(i, nx / length, ny / length, nz / length);
    p.setZ(i, p.getZ(i) + offset + bend(x, y));
  }
}

function width(z: number): number {
  const endTaper = 0.075 * smooth(1.9, 2.3, Math.abs(z));
  const flare = Math.max(...AXLES.map(a => Math.exp(-(((z - a) / 0.44) ** 2))));
  return 0.865 + 0.0275 * flare - endTaper;
}

function belt(z: number): number {
  return 0.875 + 0.025 * Math.exp(-(((z - 1.25) / 0.65) ** 2)) - 0.025 * smooth(1.6, 2.3, -z);
}

function sideX(z: number, y: number): number {
  const v = THREE.MathUtils.clamp((y - 0.18) / (belt(z) - 0.18), 0, 1);
  return width(z) - 0.029 * (1 - v) ** 2 - 0.018 * smooth(0.62, 0.94, y) + 0.006 * Math.sin(v * Math.PI);
}

function cornerZ(z: number, x: number): number {
  return z - Math.sign(z) * 0.16 * smooth(1.95, 2.28, Math.abs(z)) * (Math.abs(x) / 0.85) ** 3;
}

/** Side surfaces end AT the arch opening, with no invisible cap/fan/underside across the wheel. */
function bodySides(p: Parts): void {
  const cuts = [-2.28, AXLES[0] - ARCH_R, AXLES[0] + ARCH_R, AXLES[1] - ARCH_R, AXLES[1] + ARCH_R, 2.28];
  for (const sign of [-1, 1]) {
    for (let section = 0; section < cuts.length - 1; section++) {
      const z0 = cuts[section], z1 = cuts[section + 1];
      const axle = section === 1 ? AXLES[0] : section === 3 ? AXLES[1] : undefined;
      const nx = Math.ceil((z1 - z0) / 0.022);
      p.add('paint', surface(nx, 20, (u, v) => {
        // Cosine distribution follows the actual circular edge, not a staircase/squared-off hole.
        const z = axle === undefined ? z0 + (z1 - z0) * u : axle - ARCH_R * Math.cos(Math.PI * u);
        const bottom = axle === undefined ? 0.19 : WHEEL_Y + ARCH_R * Math.sin(Math.PI * u);
        const y = bottom + (belt(z) - bottom) * v;
        const crease = 0.0035 * Math.exp(-(((y - 0.785) / 0.035) ** 2));
        const x = sign * (sideX(z, y) + crease);
        return [x, y, cornerZ(z, x)];
      }, sign > 0));
    }
    for (const axle of AXLES) {
      // A rolled metal lip and an inward return. Nothing crosses the cylindrical opening.
      p.add('paint', surface(120, 6, (u, v) => {
        const a = Math.PI * u;
        const r = ARCH_R + v * 0.014;
        const z = axle - r * Math.cos(a), y = WHEEL_Y + r * Math.sin(a);
        return [sign * (sideX(z, y) + 0.007 * Math.sin(v * Math.PI)), y, z];
      }, sign > 0));
      p.add('trim', surface(96, 5, (u, v) => {
        const a = Math.PI * u, z = axle - ARCH_R * Math.cos(a), y = WHEEL_Y + ARCH_R * Math.sin(a);
        return [sign * (sideX(z, y) - v * 0.155), y + 0.003 * v, z];
      }, sign < 0));
      for (const dir of [-1, 1]) {
        const z = axle + dir * ARCH_R;
        box(p, 'paint', [0.018, 0.137, 0.018], [sign * sideX(z, 0.25), 0.258, z], 0.004);
      }
    }
    // V-spec sill with an inset carbon blade. Ends stop before each wheel opening.
    box(p, 'paint', [0.08, 0.105, 1.89], [sign * 0.84, 0.205, -0.012], 0.021);
    box(p, 'carbon', [0.09, 0.02, 1.91], [sign * 0.84, 0.153, -0.01], 0.007);
    // Shoulder top only: the center remains a genuine open passenger compartment.
    p.add('paint', surface(140, 12, (u, v) => {
      const z = -0.69 + u * 1.94;
      const outer = sideX(z, belt(z));
      return [sign * (0.747 + (outer - 0.747) * v), belt(z) + 0.006 * Math.sin(v * Math.PI), z];
    }, sign < 0));
  }
}

function decks(p: Parts): void {
  // A low, broad hood with two sculpted power creases, separate from the upright shoulder flares.
  p.add('paint', surface(88, 48, (u, v) => {
    const z = -2.242 + v * 1.552;
    const x = (u * 2 - 1) * width(z);
    const t = Math.abs(x) / width(z);
    const crown = 0.019 * (1 - t * t);
    const ridge = 0.018 * Math.exp(-(((t - 0.69) / 0.055) ** 2)) * Math.sin(v * Math.PI * 0.85);
    return [x, belt(z) + crown + ridge + 0.011 * (1 - v) ** 4, z + 0.16 * (Math.abs(x) / 0.85) ** 3 * (1 - v) ** 3];
  }, true));
  p.add('paint', surface(80, 36, (u, v) => {
    const z = 1.235 + v * 1.015, t = u * 2 - 1;
    const x = t * width(z);
    return [x, belt(z) + 0.012 * (1 - t * t), z - 0.15 * (Math.abs(x) / 0.85) ** 3 * v ** 3];
  }, true));
  // Bonnet shut line, cowl seal and two shallow NACA-style vents.
  tube(p, 'trim', [[-0.79, 0.89, -0.696], [0, 0.904, -0.696], [0.79, 0.89, -0.696]], 0.0024, 70);
  for (const sign of [-1, 1]) {
    const points: V3[] = [];
    for (let i = 0; i <= 45; i++) {
      const z = -2.16 + i / 45 * 1.44;
      points.push([sign * width(z) * 0.91, belt(z) + 0.0037, z]);
    }
    tube(p, 'trim', points, 0.0019, 90);
    box(p, 'trim', [0.12, 0.005, 0.22], [sign * 0.51, 0.892, -0.91], 0.01);
    for (let i = 0; i < 6; i++) box(p, 'carbon', [0.108, 0.007, 0.012], [sign * 0.51, 0.896, -0.997 + i * 0.033], 0.002);
  }
  // The only underfloor is narrow and between the wheels; it cannot close an arch opening.
  box(p, 'trim', [1.23, 0.025, 1.87], [0, 0.155, 0.025], 0.006);
}

function greenhouse(p: Parts, roof: Parts): void {
  const side = (sign: number, u: number, v: number): V3 => {
    const bottomZ = -0.602 + u * 1.642;
    const topZ = -0.225 + u * 0.885;
    return [sign * (0.746 - v * 0.121 + 0.004 * Math.sin(u * Math.PI)), 0.914 + v * 0.408 + Math.sin(u * Math.PI) * 0.007, bottomZ + (topZ - bottomZ) * v];
  };
  const windshield = (u: number, v: number): V3 => {
    const t = u * 2 - 1;
    const w = THREE.MathUtils.lerp(0.739, 0.627, v);
    return [t * w, 0.91 + v * 0.412 + (1 - t * t) * 0.016, -0.705 + v * 0.468 - 0.018 * (1 - t * t)];
  };
  p.add('glass', surface(56, 28, windshield, true));
  for (const u of [0, 1]) {
    const pts = Array.from({ length: 20 }, (_, i) => windshield(u, i / 19));
    tube(p, 'trim', pts, 0.008, 36, 8);
    const sign = u === 0 ? -1 : 1;
    p.add('paint', surface(36, 8, (along, across) => {
      const front = windshield(u, along), back = side(sign, 0, along);
      return [THREE.MathUtils.lerp(front[0], back[0], across) + sign * 0.009 * Math.sin(across * Math.PI), THREE.MathUtils.lerp(front[1], back[1], across) + 0.008 * Math.sin(across * Math.PI), THREE.MathUtils.lerp(front[2], back[2], across)];
    }, sign < 0));
  }
  for (const v of [0, 1]) tube(p, 'trim', Array.from({ length: 32 }, (_, i) => windshield(i / 31, v)), 0.008, 64, 8);

  const rearWindow = (u: number, v: number): V3 => {
    const t = u * 2 - 1, w = THREE.MathUtils.lerp(0.62, 0.744, v);
    return [t * w, 1.324 - v * 0.409 + 0.01 * (1 - t * t), 0.71 + 0.536 * v + 0.012 * (1 - t * t)];
  };
  p.add('glass', surface(48, 24, rearWindow, true));
  for (const u of [0, 1]) {
    const points = Array.from({ length: 24 }, (_, i) => rearWindow(u, i / 23));
    tube(p, 'trim', points, 0.008, 40, 8);
    const sign = u === 0 ? -1 : 1;
    p.add('paint', surface(40, 12, (along, across) => {
      const front = side(sign, 1, along), back = rearWindow(u, 1 - along);
      return [THREE.MathUtils.lerp(front[0], back[0], across) + sign * 0.015 * Math.sin(across * Math.PI), THREE.MathUtils.lerp(front[1], back[1], across) + 0.006 * Math.sin(across * Math.PI), THREE.MathUtils.lerp(front[2], back[2], across)];
    }, sign < 0));
  }
  for (const v of [0, 1]) tube(p, 'trim', Array.from({ length: 30 }, (_, i) => rearWindow(i / 29, v)), 0.008, 48);
  // Fine copper-colored demister wires sit on the glass rather than being painted on the cabin.
  for (let i = 1; i < 13; i++) {
    const v = i / 14;
    tube(p, 'darkMetal', Array.from({ length: 12 }, (_, j) => {
      const [x, y, z] = rearWindow(0.04 + j / 11 * 0.92, v);
      return [x, y + 0.0006, z + 0.0008];
    }), 0.00055, 18, 3);
  }
  roof.add('paint', surface(48, 32, (u, v) => {
    const t = u * 2 - 1, z = -0.249 + v * 0.978;
    return [t * (0.625 - 0.006 * Math.sin(v * Math.PI)), 1.322 + 0.033 * (1 - t * t) + 0.005 * Math.sin(v * Math.PI), z];
  }, true));

  for (const sign of [-1, 1]) {
    // Each side window has its own actual transparent surface, rubber surround and B-pillar.
    p.add('glass', surface(48, 18, (u, v) => side(sign, u, v), sign > 0));
    for (const v of [0, 1]) {
      const pts = Array.from({ length: 40 }, (_, i) => side(sign, i / 39, v));
      tube(p, 'trim', pts, v === 0 ? 0.01 : 0.008, 64, 8);
      if (v === 1) {
        // This rain channel overlaps the roof edge rather than floating above its flat sheet.
        const rail: V3[] = [...pts, [sign * 0.626, 1.323, 0.711]];
        tube(p, 'paint', rail.map(([x, y, z]) => [x + sign * 0.002, y + 0.001, z] as V3), 0.012, 64, 8);
      }
    }
    const b0 = side(sign, 0.67, 0), b1 = side(sign, 0.67, 1);
    beam(p, 'trim', b0, b1, 0.021, 8);
    // Door perimeter follows the sculpted side, including the characteristic high rear handle.
    const yz: readonly (readonly [number, number])[] = [[0.89, -0.66], [0.68, -0.72], [0.28, -0.69], [0.245, -0.56], [0.245, 0.70], [0.30, 0.78], [0.87, 0.79]];
    tube(p, 'trim', yz.map(([y, z]) => [sign * (sideX(z, y) + 0.002), y, z]), 0.0023, 100, 5);
    box(p, 'trim', [0.014, 0.042, 0.153], [sign * 0.867, 0.813, 0.59], 0.013);
    box(p, 'paint', [0.025, 0.021, 0.119], [sign * 0.878, 0.817, 0.59], 0.009);
    cylinder(p, 'chrome', 0.005, 0.003, [sign * 0.893, 0.817, 0.636], 'x', 14);
    // Fuel flap and side repeater are small but properly modeled.
    if (sign > 0) {
      const points = Array.from({ length: 9 }, (_, i) => {
        const a = i / 8 * TAU;
        const z = 1.57 + Math.cos(a) * 0.089, y = 0.79 + Math.sin(a) * 0.072;
        return [sideX(z, y) + 0.003, y, z] as V3;
      });
      tube(p, 'trim', points, 0.0015, 48, 5, true);
    }
    box(p, sign < 0 ? 'left' : 'right', [0.012, 0.024, 0.075], [sign * 0.882, 0.759, -0.846], 0.008);
    // Mirror pedestal, body-colored aerodynamic pod, black surround and reflective rear face.
    beam(p, 'trim', [sign * 0.75, 0.947, -0.514], [sign * 0.936, 0.973, -0.493], 0.028, 12);
    box(p, 'paint', [0.204, 0.103, 0.155], [sign * 0.944, 1.005, -0.49], 0.038, [0, sign * 0.13, 0]);
    box(p, 'trim', [0.168, 0.078, 0.012], [sign * 0.945, 1.003, -0.407], 0.022);
    box(p, 'chrome', [0.148, 0.06, 0.007], [sign * 0.945, 1.005, -0.399], 0.019);
  }
  // Two wipers, on the OUTSIDE of the windshield; jointed arms and rubber blades.
  for (const sign of [-1, 1]) {
    const x = sign * 0.34;
    beam(p, 'darkMetal', [x, 0.929, -0.704], [x + 0.11, 0.972, -0.659], 0.006, 8);
    beam(p, 'darkMetal', [x + 0.11, 0.972, -0.659], [x + 0.22, 0.986, -0.65], 0.005, 8);
    beam(p, 'trim', [x - 0.04, 0.988, -0.653], [x + 0.34, 0.988, -0.653], 0.008, 8);
  }
}

/** Recess sides are separate angled surfaces, so there is real parallax through each aperture. */
function recess(p: Parts, x: number, y: number, w: number, h: number, z: number, depth: number): void {
  box(p, 'trim', [w, h, 0.012], [x, y, z + depth], 0.007);
  box(p, 'trim', [0.015, h, depth], [x - w / 2, y, z + depth / 2], 0.003);
  box(p, 'trim', [0.015, h, depth], [x + w / 2, y, z + depth / 2], 0.003);
  box(p, 'trim', [w, 0.015, depth], [x, y - h / 2, z + depth / 2], 0.003);
  box(p, 'trim', [w, 0.015, depth], [x, y + h / 2, z + depth / 2], 0.003);
}

function grille(p: Parts, x: number, y: number, w: number, h: number, z: number): void {
  // Real open metal mesh, merged into one draw call. No alpha-sorted black rectangle.
  const step = 0.026;
  for (let i = 0; i < Math.floor(w / step); i++) {
    const xx = x - w / 2 + step * (i + 0.5);
    beam(p, 'grille', [xx, y - h / 2, z], [xx, y + h / 2, z], 0.0014, 4);
  }
  for (let i = 0; i < Math.floor(h / step); i++) {
    const yy = y - h / 2 + step * (i + 0.5);
    beam(p, 'grille', [x - w / 2, yy, z], [x + w / 2, yy, z], 0.0014, 4);
  }
}

function roundAperture(x: number, y: number, w: number, h: number, r: number): THREE.Path {
  const path = new THREE.Path();
  const l = x - w / 2, b = y - h / 2, right = x + w / 2, top = y + h / 2;
  path.moveTo(l + r, b);
  path.lineTo(right - r, b); path.quadraticCurveTo(right, b, right, b + r);
  path.lineTo(right, top - r); path.quadraticCurveTo(right, top, right - r, top);
  path.lineTo(l + r, top); path.quadraticCurveTo(l, top, l, top - r);
  path.lineTo(l, b + r); path.quadraticCurveTo(l, b, l + r, b);
  path.closePath();
  return path;
}

/** Continuous, radiused bumper skin with real cutouts. It is NOT a stack of intersecting boxes. */
function bumperSkin(p: Parts): void {
  const shape = new THREE.Shape();
  shape.moveTo(-0.786, 0.17);
  shape.quadraticCurveTo(-0.811, 0.172, -0.812, 0.223);
  shape.lineTo(-0.812, 0.595);
  shape.quadraticCurveTo(-0.812, 0.675, -0.795, 0.694);
  shape.lineTo(0.802, 0.694);
  shape.quadraticCurveTo(0.812, 0.675, 0.812, 0.595);
  shape.lineTo(0.812, 0.223);
  shape.quadraticCurveTo(0.811, 0.172, 0.786, 0.17);
  shape.closePath();
  shape.holes.push(roundAperture(0, 0.404, 0.947, 0.237, 0.017));
  for (const sign of [-1, 1]) shape.holes.push(roundAperture(sign * 0.661, 0.412, 0.177, 0.222, 0.019));
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.115, steps: 1, curveSegments: 12, bevelEnabled: true, bevelSegments: 4, bevelThickness: 0.012, bevelSize: 0.011 });
  warpZ(g, -2.257, (x, y) => {
    const sweep = 0.16 * (Math.abs(x) / 0.85) ** 3;
    const chin = 0.014 * (1 - smooth(0.18, 0.36, y));
    return sweep - chin + 0.012 * smooth(0.53, 0.69, y);
  });
  p.add('paint', g);
  // One-piece upper fascia wraps around the lamp and small GT-R grille apertures.
  const upper = new THREE.Shape();
  upper.moveTo(-0.804, 0.688); upper.lineTo(0.804, 0.688);
  upper.quadraticCurveTo(0.828, 0.70, 0.82, 0.846);
  upper.quadraticCurveTo(0.816, 0.865, 0.793, 0.868);
  upper.lineTo(-0.793, 0.868);
  upper.quadraticCurveTo(-0.816, 0.865, -0.82, 0.846);
  upper.quadraticCurveTo(-0.828, 0.70, -0.804, 0.688);
  for (const sign of [-1, 1]) upper.holes.push(roundAperture(sign * 0.535, 0.774, 0.531, 0.158, 0.017));
  upper.holes.push(roundAperture(0, 0.773, 0.475, 0.122, 0.009));
  const nose = new THREE.ExtrudeGeometry(upper, { depth: 0.06, steps: 1, curveSegments: 10, bevelEnabled: true, bevelSegments: 3, bevelThickness: 0.007, bevelSize: 0.005 });
  warpZ(nose, -2.241, x => 0.16 * (Math.abs(x) / 0.85) ** 3);
  p.add('paint', nose);
}

function front(p: Parts): void {
  // The aggressive, squared R34 nose is constructed around its open apertures, not over a solid box.
  bumperSkin(p);
  // Swept splitter follows the bumper planform instead of projecting as a rectangular shelf.
  p.add('carbon', surface(72, 4, (u, v) => {
    const x = (u * 2 - 1) * 0.833;
    const front = -2.303 + 0.16 * (Math.abs(x) / 0.833) ** 3;
    return [x, 0.15, THREE.MathUtils.lerp(front, -2.045, v)];
  }, true));
  p.add('carbon', surface(72, 2, (u, v) => {
    const x = (u * 2 - 1) * 0.833;
    return [x, 0.137 + v * 0.013, -2.303 + 0.16 * (Math.abs(x) / 0.833) ** 3];
  }, true));
  for (const sign of [-1, 1]) {
    recess(p, sign * 0.66, 0.411, 0.171, 0.215, -2.17, 0.125);
    grille(p, sign * 0.66, 0.411, 0.154, 0.193, -2.139);
    // Angled air-guide inside the brake duct.
    box(p, 'carbon', [0.148, 0.013, 0.116], [sign * 0.66, 0.392, -2.154], 0.002, [0.16, 0, 0]);
  }
  recess(p, 0, 0.402, 0.944, 0.23, -2.244, 0.164);
  box(p, 'metal', [0.835, 0.207, 0.068], [0, 0.4, -2.112], 0.011);
  // Closely spaced intercooler cooling fins, end tanks, plumbing and retaining straps.
  for (let i = 0; i < 19; i++) box(p, 'metal', [0.746, 0.004, 0.008], [0, 0.309 + i * 0.0101, -2.152], 0.001);
  for (const sign of [-1, 1]) {
    box(p, 'chrome', [0.045, 0.205, 0.073], [sign * 0.407, 0.4, -2.105], 0.013);
    cylinder(p, 'metal', 0.038, 0.095, [sign * 0.455, 0.405, -2.071], 'x', 32);
    box(p, 'darkMetal', [0.018, 0.212, 0.012], [sign * 0.274, 0.4, -2.16], 0.002);
  }
  grille(p, 0, 0.403, 0.932, 0.221, -2.187);
  recess(p, 0, 0.77, 0.478, 0.125, -2.213, 0.092);
  grille(p, 0, 0.77, 0.463, 0.112, -2.192);
  decal(p, 'gtr', [0.062, 0.071], [0.119, 0.771, -2.223], [0, Math.PI, 0]);
  box(p, 'trim', [0.32, 0.112, 0.016], [0, 0.574, -2.3], 0.006);
  decal(p, 'plate', [0.305, 0.104], [0, 0.574, -2.31], [0, Math.PI, 0]);
  for (const sign of [-1, 1]) headlamp(p, sign);
}

function headlamp(parent: Parts, sign: number): void {
  const p = new Parts();
  const x = sign * 0.535;
  box(p, 'trim', [0.533, 0.178, 0.111], [x, 0.772, -2.157], 0.025);
  box(p, 'chrome', [0.505, 0.15, 0.012], [x, 0.772, -2.215], 0.022);
  box(p, 'darkMetal', [0.477, 0.129, 0.016], [x, 0.774, -2.227], 0.019);
  for (let i = 0; i < 2; i++) {
    const xx = x + sign * (-0.119 + i * 0.208);
    const r = i === 0 ? 0.054 : 0.059;
    // Reflector bowls are actually concave, with their own metal bevel and projector glass.
    p.add('chrome', surface(64, 12, (u, v) => {
      const a = u * TAU, rr = r * (0.26 + 0.74 * v);
      return [xx + Math.cos(a) * rr, 0.774 + Math.sin(a) * rr, -2.217 - 0.025 * v * v];
    }));
    ring(p, 'chrome', r, 0.004, [xx, 0.774, -2.244]);
    cylinder(p, 'headlight', r * 0.55, 0.007, [xx, 0.774, -2.244], 'z', 48);
    const lens = new THREE.SphereGeometry(r * 0.59, 40, 20);
    lens.scale(1, 1, 0.24).translate(xx, 0.774, -2.25);
    p.add('lens', lens);
    for (let j = 0; j < 7; j++) {
      const a = j / 7 * TAU;
      beam(p, 'darkMetal', [xx + Math.cos(a) * r * 0.74, 0.774 + Math.sin(a) * r * 0.74, -2.243], [xx + Math.cos(a) * r * 0.94, 0.774 + Math.sin(a) * r * 0.94, -2.244], 0.0011, 4);
    }
  }
  // The inboard high-beam reflector is rectangular; the outboard two elements are round optics.
  box(p, 'chrome', [0.059, 0.103, 0.012], [sign * 0.303, 0.774, -2.24], 0.01);
  for (let j = 0; j < 5; j++) box(p, 'darkMetal', [0.002, 0.091, 0.003], [sign * (0.28 + j * 0.011), 0.774, -2.248], 0.0005);
  box(p, sign < 0 ? 'left' : 'right', [0.055, 0.114, 0.016], [sign * 0.763, 0.773, -2.227], 0.012);
  for (let j = 0; j < 6; j++) box(p, 'chrome', [0.003, 0.095, 0.007], [sign * (0.742 + j * 0.008), 0.773, -2.24], 0.001);
  box(p, 'lens', [0.522, 0.166, 0.027], [x, 0.773, -2.26], 0.023);
  for (const [mat, g] of Object.entries(p.finish())) {
    warpZ(g, 0, x => 0.16 * (Math.abs(x) / 0.85) ** 3);
    parent.add(mat as R34MaterialName, g);
  }
}

function rear(p: Parts): void {
  const skin = new THREE.Shape();
  skin.moveTo(-0.772, 0.196);
  skin.quadraticCurveTo(-0.812, 0.196, -0.812, 0.25);
  skin.lineTo(-0.812, 0.793);
  skin.quadraticCurveTo(-0.812, 0.868, -0.785, 0.878);
  skin.lineTo(0.785, 0.878);
  skin.quadraticCurveTo(0.812, 0.868, 0.812, 0.793);
  skin.lineTo(0.812, 0.25);
  skin.quadraticCurveTo(0.812, 0.196, 0.772, 0.196);
  skin.closePath();
  for (const sign of [-1, 1]) skin.holes.push(roundAperture(sign * 0.521, 0.687, 0.526, 0.228, 0.022));
  skin.holes.push(roundAperture(0, 0.563, 0.356, 0.137, 0.012));
  const rearSkin = new THREE.ExtrudeGeometry(skin, { depth: 0.12, steps: 1, curveSegments: 12, bevelEnabled: true, bevelSegments: 4, bevelThickness: 0.011, bevelSize: 0.013 });
  warpZ(rearSkin, 2.156, (x, y) => -0.15 * (Math.abs(x) / 0.85) ** 3 - 0.012 * smooth(0.81, 0.88, y));
  p.add('paint', rearSkin);
  // A subtle molded bumper shut line instead of separate rectangular bumper bricks.
  tube(p, 'trim', Array.from({ length: 40 }, (_, i) => {
    const x = -0.8 + i / 39 * 1.6;
    return [x, 0.433, 2.288 - 0.15 * (Math.abs(x) / 0.85) ** 3] as V3;
  }), 0.0016, 64, 5);
  for (const sign of [-1, 1]) {
    const lampParts = new Parts();
    box(lampParts, 'trim', [0.524, 0.233, 0.047], [sign * 0.521, 0.687, 2.244], 0.023);
    for (let i = 0; i < 2; i++) {
      const x = sign * (i === 0 ? 0.385 : 0.652), r = i === 0 ? 0.083 : 0.102;
      cylinder(lampParts, 'trim', r + 0.01, 0.022, [x, 0.69, 2.269], 'z', 96);
      cylinder(lampParts, 'redLens', r, 0.026, [x, 0.69, 2.283], 'z', 96);
      ring(lampParts, 'chrome', r + 0.001, 0.0028, [x, 0.69, 2.299]);
      ring(lampParts, 'tail', r * 0.77, r * 0.12, [x, 0.69, 2.303]);
      ring(lampParts, 'tail', r * 0.48, r * 0.047, [x, 0.69, 2.307]);
      cylinder(lampParts, i === 0 ? sign < 0 ? 'left' : 'right' : 'redLens', r * 0.30, 0.007, [x, 0.69, 2.312], 'z', 48);
      // Radial molded prisms and rings remain visible when the lights are not braking.
      for (let j = 0; j < 32; j++) {
        const a = j / 32 * TAU;
        beam(lampParts, 'redLens', [x + Math.cos(a) * r * 0.37, 0.69 + Math.sin(a) * r * 0.37, 2.314], [x + Math.cos(a) * r * 0.94, 0.69 + Math.sin(a) * r * 0.94, 2.303], 0.0015, 4);
      }
    }
    for (const [mat, g] of Object.entries(lampParts.finish())) {
      warpZ(g, 0, x => -0.15 * (Math.abs(x) / 0.85) ** 3);
      p.add(mat as R34MaterialName, g);
    }
    box(p, 'reverse', [0.119, 0.035, 0.016], [sign * 0.625, 0.468, 2.229], 0.007);
    box(p, 'redLens', [0.12, 0.022, 0.011], [sign * 0.672, 0.316, 2.22], 0.004);
  }
  box(p, 'trim', [0.352, 0.14, 0.025], [0, 0.563, 2.281], 0.009);
  decal(p, 'plate', [0.329, 0.119], [0, 0.565, 2.297]);
  decal(p, 'skyline', [0.367, 0.042], [0, 0.749, 2.294]);
  decal(p, 'nissan', [0.054, 0.054], [0, 0.839, 2.29]);
  decal(p, 'gtr', [0.065, 0.07], [0.249, 0.617, 2.295]);
  decal(p, 'vSpec', [0.126, 0.028], [-0.275, 0.572, 2.294]);
  box(p, 'tail', [0.268, 0.015, 0.018], [0, 0.955, 1.21], 0.005);
  tube(p, 'trim', [[-0.794, 0.895, 1.29], [-0.807, 0.887, 1.9], [-0.76, 0.873, 2.18], [0, 0.889, 2.18], [0.76, 0.873, 2.18], [0.807, 0.887, 1.9], [0.794, 0.895, 1.29]], 0.002, 140, 5);
  // Diffuser tray, five vertical fins, heat shield, and twin-wall single exhaust outlet.
  box(p, 'carbon', [1.374, 0.033, 0.394], [0, 0.168, 2.08], 0.009, [-0.07, 0, 0]);
  for (let i = -2; i <= 2; i++) box(p, 'carbon', [0.013, 0.095, 0.35], [i * 0.239, 0.176, 2.09], 0.003);
  box(p, 'metal', [0.269, 0.054, 0.26], [-0.584, 0.24, 2.104], 0.018);
  cylinder(p, 'darkMetal', 0.076, 0.231, [-0.582, 0.237, 2.196], 'z', 96);
  ring(p, 'chrome', 0.072, 0.006, [-0.582, 0.237, 2.318]);
  cylinder(p, 'trim', 0.061, 0.006, [-0.582, 0.237, 2.302], 'z', 64);
  ring(p, 'metal', 0.047, 0.005, [-0.582, 0.237, 2.307]);
}

function wing(p: Parts): void {
  // Bolted, slotted uprights and a curved aerofoil make the wing look adjustable, not like a picnic bench.
  for (const sign of [-1, 1]) {
    box(p, 'paint', [0.115, 0.036, 0.224], [sign * 0.546, 0.925, 1.883], 0.013);
    box(p, 'darkMetal', [0.037, 0.252, 0.124], [sign * 0.546, 1.056, 1.893], 0.012, [0.18, 0, 0]);
    box(p, 'trim', [0.041, 0.12, 0.027], [sign * 0.546, 1.065, 1.887], 0.012, [0.18, 0, 0]);
    for (let i = 0; i < 3; i++) cylinder(p, 'chrome', 0.006, 0.044, [sign * 0.546, 0.995 + i * 0.057, 1.898], 'x', 12);
    box(p, 'paint', [0.033, 0.132, 0.356], [sign * 0.76, 1.201, 1.90], 0.011, [0.04, 0, sign * 0.035]);
    for (const z of [1.79, 2.00]) cylinder(p, 'chrome', 0.004, 0.036, [sign * 0.76, 1.2, z], 'x', 10);
  }
  // Closed airfoil profile with a rounded leading edge, finite trailing edge and subtle span crown.
  const chord = 0.306;
  const profile: [number, number][] = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    profile.push([t, Math.sin(Math.PI * t) * 0.027 + 0.007]);
  }
  for (let i = 30; i >= 0; i--) {
    const t = i / 30;
    profile.push([t, -Math.sin(Math.PI * t) * 0.014 - 0.006]);
  }
  p.add('carbon', surface(32, profile.length - 1, (u, v) => {
    const k = Math.round(v * (profile.length - 1)), [t, yy] = profile[k];
    const x = (u * 2 - 1) * 0.75;
    return [x, 1.195 + yy + 0.015 * (1 - (x / 0.75) ** 2) + t * 0.01, 1.746 + t * chord];
  }, true));
  beam(p, 'paint', [-0.746, 1.201, 1.746], [0.746, 1.201, 1.746], 0.011, 12);
}

/** Wheel profiles revolve about X. The outside face of the cached wheel points to +X. */
function revolve(profile: readonly (readonly [number, number])[], segments = 192): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments).rotateZ(-Math.PI / 2);
}

function wheelGeometry(): { rolling: GeometryMap; fixed: GeometryMap } {
  const rolling = new Parts(), fixed = new Parts();
  const profile: [number, number][] = [];
  // Smooth shoulder/sidewall curves, plus four circumferential rain grooves cut into the actual mesh.
  profile.push([0.233, -0.12], [0.253, -0.126], [0.282, -0.129], [0.300, -0.126], [0.314, -0.117], [0.323, -0.099]);
  for (let i = 0; i <= 32; i++) {
    const x = -0.09 + i / 32 * 0.18;
    let r = 0.327 - (x / 0.115) ** 4 * 0.003;
    if ([-0.065, -0.022, 0.022, 0.065].some(g => Math.abs(x - g) < 0.0044)) r -= 0.004;
    profile.push([r, x]);
  }
  profile.push([0.323, 0.099], [0.314, 0.117], [0.300, 0.126], [0.282, 0.129], [0.253, 0.126], [0.233, 0.12]);
  rolling.add('tyre', revolve(profile, 128));
  // Tread shoulders have modeled diagonal blocks, not just a smooth black torus.
  for (let i = 0; i < 112; i++) for (const sign of [-1, 1]) {
    const angle = i / 112 * TAU;
    const g = new THREE.BoxGeometry(0.037, 0.0028, 0.009);
    g.rotateY(sign * 0.42).translate(sign * 0.096, 0.321, 0).rotateX(angle);
    rolling.add('tyre', g);
  }
  for (const side of [-1, 1]) {
    ring(rolling, 'tyre', 0.265, 0.0015, [side * 0.129, 0, 0], 'x', 96);
    ring(rolling, 'tyre', 0.304, 0.001, [side * 0.124, 0, 0], 'x', 96);
  }
  // Arced sidewall lettering is mapped as short tangential atlas segments, not a floating billboard.
  const lettering = new THREE.PlaneGeometry(0.38, 0.025, 40, 1);
  const lp = lettering.getAttribute('position'), lu = lettering.getAttribute('uv');
  const [dx, dy, dw, dh] = R34_DECALS.tyre;
  for (let i = 0; i < lp.count; i++) {
    const a = lp.getX(i) / 0.285, r = 0.282 + lp.getY(i);
    lp.setXYZ(i, 0.1303, Math.cos(a) * r, Math.sin(a) * r);
    lu.setXY(i, dx + lu.getX(i) * dw, 1 - dy - dh + lu.getY(i) * dh);
  }
  lettering.computeVertexNormals();
  rolling.add('decal', lettering);
  const lower = lettering.clone().rotateX(Math.PI);
  rolling.add('decal', lower);
  // Deep barrel, machined flanges and two contrasting lips.
  rolling.add('darkMetal', revolve([[0.222, -0.113], [0.219, -0.105], [0.219, 0.089], [0.226, 0.116]], 192));
  rolling.add('rim', revolve([[0.228, -0.12], [0.237, -0.119], [0.237, -0.111], [0.228, -0.103]], 192));
  rolling.add('rim', revolve([[0.222, 0.093], [0.228, 0.111], [0.237, 0.116], [0.239, 0.123], [0.233, 0.129], [0.224, 0.124]], 192));
  ring(rolling, 'chrome', 0.232, 0.002, [0.128, 0, 0], 'x', 128);
  // Twelve tapered, curved forged spokes in six close pairs. Every spoke has a real bevel.
  for (let pair = 0; pair < 6; pair++) for (const split of [-1, 1]) {
    const angle = pair / 6 * TAU + split * 0.067;
    const shape = new THREE.Shape();
    shape.moveTo(0.045, -0.011);
    shape.bezierCurveTo(0.09, -0.013, 0.17, -0.010, 0.225, -0.007);
    shape.lineTo(0.225, 0.008);
    shape.bezierCurveTo(0.17, 0.014, 0.09, 0.016, 0.045, 0.012);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.002, bevelSegments: 2, curveSegments: 8, steps: 3 });
    const pp = g.getAttribute('position');
    for (let i = 0; i < pp.count; i++) {
      const r = pp.getX(i), lateral = pp.getY(i), depth = pp.getZ(i);
      const x = 0.065 + (r / 0.225) ** 1.4 * 0.042 + depth;
      pp.setXYZ(i, x, r * Math.cos(angle) - lateral * Math.sin(angle), r * Math.sin(angle) + lateral * Math.cos(angle));
    }
    g.computeVertexNormals();
    rolling.add('rim', g);
  }
  rolling.add('rim', revolve([[0.064, 0.058], [0.068, 0.085], [0.058, 0.1], [0.031, 0.1]], 96));
  cylinder(rolling, 'darkMetal', 0.029, 0.012, [0.107, 0, 0], 'x', 64);
  ring(rolling, 'chrome', 0.029, 0.0017, [0.114, 0, 0], 'x', 64);
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU;
    cylinder(rolling, 'trim', 0.010, 0.009, [0.105, Math.cos(a) * 0.046, Math.sin(a) * 0.046], 'x', 24);
    cylinder(rolling, 'chrome', 0.0067, 0.016, [0.11, Math.cos(a) * 0.046, Math.sin(a) * 0.046], 'x', 6);
  }
  // Tire valve stem, visible in a gap between spoke pairs.
  beam(rolling, 'trim', [0.108, 0.134, 0.164], [0.127, 0.134, 0.164], 0.004, 10);
  // Vented/drilled rotor: two friction rings, internal vanes, a separate anodized hat and bolt circle.
  for (const x of [-0.028, -0.006]) {
    rolling.add('disc', revolve([[0.085, x], [0.179, x], [0.182, x + 0.003], [0.179, x + 0.007], [0.085, x + 0.007]], 224));
  }
  rolling.add('darkMetal', revolve([[0.035, -0.028], [0.084, -0.028], [0.087, -0.004], [0.074, 0.013], [0.035, 0.013]], 96));
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * TAU;
    const g = new THREE.BoxGeometry(0.018, 0.0035, 0.087);
    g.translate(-0.012, 0, 0.131).rotateX(a);
    rolling.add('darkMetal', g);
  }
  // Recessed dark drill bores and machined countersink rings on the visible friction face.
  for (let row = 0; row < 3; row++) for (let i = 0; i < 36; i++) {
    const a = (i + row * 0.26) / 36 * TAU, r = 0.108 + row * 0.027;
    cylinder(rolling, 'darkMetal', 0.0027, 0.0007, [0.0017, Math.cos(a) * r, Math.sin(a) * r], 'x', 8);
  }
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU;
    cylinder(rolling, 'chrome', 0.004, 0.009, [0.013, Math.cos(a) * 0.068, Math.sin(a) * 0.068], 'x', 6);
  }
  // Caliper is in a separate non-rolling bucket: it steers but never rotates with the tyre.
  box(fixed, 'caliper', [0.085, 0.147, 0.076], [0.004, 0.033, 0.162], 0.02, [0.20, 0, 0]);
  for (const y of [-0.003, 0.061]) box(fixed, 'caliper', [0.095, 0.033, 0.061], [0.006, y, 0.155], 0.012);
  box(fixed, 'darkMetal', [0.04, 0.1, 0.017], [0.004, 0.032, 0.124], 0.005);
  decal(fixed, 'brembo', [0.078, 0.025], [0.054, 0.033, 0.164], [0, Math.PI / 2, Math.PI / 2]);
  return { rolling: rolling.finish(), fixed: fixed.finish() };
}

interface CachedGeometry {
  body: GeometryMap;
  roof: GeometryMap;
  rolling: GeometryMap;
  fixed: GeometryMap;
}
let cached: CachedGeometry | undefined;

function geometry(): CachedGeometry {
  if (cached) return cached;
  const p = new Parts(), roof = new Parts();
  bodySides(p);
  decks(p);
  greenhouse(p, roof);
  front(p);
  rear(p);
  wing(p);
  cached = { body: p.finish(), roof: roof.finish(), ...wheelGeometry() };
  return cached;
}

export interface R34Exterior {
  body: THREE.Group;
  wheelRoot: THREE.Group;
  wheels: { update(steer: number, spin: number): void };
  tail: THREE.MeshBasicMaterial;
  tailIdle: THREE.Color;
  tailBrake: THREE.Color;
  indicators: { set(left: boolean, right: boolean, brake: boolean): void };
  setPaint(color: number): void;
  setCockpit(on: boolean): void;
  dispose(): void;
}

/**
 * Caller adds body and wheelRoot as SIBLINGS. Suspend/roll the body only, not the road wheels.
 * Immutable geometry/textures are retained; dispose releases this car's materials and instance buffers.
 */
export function buildR34Exterior(paint: number): R34Exterior {
  const geo = geometry(), look = createR34Materials(paint);
  const body = new THREE.Group(), wheelRoot = new THREE.Group(), roof = new THREE.Group();
  body.name = 'R34/exterior'; wheelRoot.name = 'R34/road-wheels'; roof.name = 'R34/roof';
  function add(parts: GeometryMap, parent: THREE.Group): void {
    for (const [name, g] of Object.entries(parts)) {
      const mesh = new THREE.Mesh(g, look.materials[name as R34MaterialName]);
      mesh.name = `R34/${name}`;
      mesh.castShadow = name !== 'glass' && name !== 'lens';
      mesh.receiveShadow = name !== 'glass' && name !== 'lens';
      if (name === 'glass' || name === 'lens') mesh.renderOrder = 2;
      parent.add(mesh);
    }
  }
  add(geo.body, body); add(geo.roof, roof); body.add(roof);
  const rolling: THREE.InstancedMesh[] = [], fixed: THREE.InstancedMesh[] = [];
  for (const [parts, dest] of [[geo.rolling, rolling], [geo.fixed, fixed]] as const) {
    for (const [name, g] of Object.entries(parts)) {
      const mesh = new THREE.InstancedMesh(g, look.materials[name as R34MaterialName], 4);
      mesh.name = `R34/wheels/${name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true; mesh.receiveShadow = true;
      wheelRoot.add(mesh); dest.push(mesh);
    }
  }
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), spinQ = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1);
  const xAxis = new THREE.Vector3(1, 0, 0), yAxis = new THREE.Vector3(0, 1, 0);
  const leftFixed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const wheels = {
    update(steer: number, spin: number) {
      for (let i = 0; i < 4; i++) {
        const front = i < 2, left = i % 2 === 0;
        pos.set(left ? -0.763 : 0.763, WHEEL_Y, front ? AXLES[0] : AXLES[1]);
        rotation.setFromAxisAngle(yAxis, front ? -steer : 0);
        if (left) rotation.multiply(leftFixed);
        matrix.compose(pos, rotation, scale);
        for (const m of fixed) m.setMatrixAt(i, matrix);
        rotation.setFromAxisAngle(yAxis, (front ? -steer : 0) + (left ? Math.PI : 0));
        spinQ.setFromAxisAngle(xAxis, left ? spin : -spin);
        rotation.multiply(spinQ);
        matrix.compose(pos, rotation, scale);
        for (const m of rolling) m.setMatrixAt(i, matrix);
      }
      for (const mesh of [...rolling, ...fixed]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    },
  };
  wheels.update(0, 0);
  const tailIdle = new THREE.Color(0.9, 0.012, 0.008), tailBrake = new THREE.Color(3.9, 0.055, 0.025);
  const amberOff = new THREE.Color(0.17, 0.055, 0.002), amberOn = new THREE.Color(4.5, 1.8, 0.035);
  let disposed = false;
  return {
    body, wheelRoot, wheels, tail: look.tail, tailIdle, tailBrake,
    indicators: {
      set(left, right, brake) {
        look.left.color.copy(left ? amberOn : amberOff);
        look.right.color.copy(right ? amberOn : amberOff);
        look.tail.color.copy(brake ? tailBrake : tailIdle);
      },
    },
    setPaint(color) { look.paint.color.setHex(color); },
    // The physical exterior roof is hidden only for the local cockpit camera; glazing stays clear.
    setCockpit(on) { roof.visible = !on; },
    dispose() {
      if (disposed) return;
      disposed = true;
      look.dispose();
      for (const mesh of [...rolling, ...fixed]) mesh.dispose();
      body.removeFromParent(); wheelRoot.removeFromParent();
    },
  };
}
