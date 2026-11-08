import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createR34Materials, R34_DECALS, R34_TEXTURE_BUDGET } from './r34Materials';
import type { R34MaterialName } from './r34Materials';

/** Metres; +X right, +Y up, -Z forward. Body suspension must not be applied to wheelRoot. */
const AXLES = [-1.35, 1.315] as const, R = .327, ARCH = .376, TAU = Math.PI * 2;
type V3 = readonly [number, number, number];
type Point = (u: number, v: number) => V3;
type GeometryMap = Partial<Record<R34MaterialName, THREE.BufferGeometry>>;
export const R34_EXTERIOR_BUDGET = Object.freeze({ length: 4.6, width: 1.785, height: 1.36, wheelRadius: R, axles: AXLES, targetTriangles: [70000, 240000] as const, maximumDrawCalls: 44, textures: R34_TEXTURE_BUDGET });
/** Published model-space contract for cabin lining; no other car or shared shape module is changed. */
export const R34_GREENHOUSE = Object.freeze({ windscreenBaseZ: -.62, roofFrontZ: .18, roofRearZ: 1.04, rearGlassBaseZ: 1.66, baseHalfWidth: .755, roofHalfWidth: .657, roofEdgeY: 1.316 });

class Parts {
  private parts = new Map<R34MaterialName, THREE.BufferGeometry[]>();
  add(mat: R34MaterialName, g: THREE.BufferGeometry): void { const list = this.parts.get(mat) ?? []; list.push(g); this.parts.set(mat, list); }
  finish(): GeometryMap {
    const result: GeometryMap = {};
    for (const [mat, list] of this.parts) {
      const flat = list.map(g => g.index ? g.toNonIndexed() : g), merged = mergeGeometries(flat, false)!;
      const g = mergeVertices(merged, .000001); g.name = `R34/shared/${mat}`; g.userData.shared = true; g.computeBoundingBox(); g.computeBoundingSphere(); result[mat] = g;
      merged.dispose(); for (const old of new Set([...list, ...flat])) old.dispose();
    }
    this.parts.clear(); return result;
  }
}
function surface(nx: number, ny: number, point: Point, flip = false): THREE.BufferGeometry {
  const p: number[] = [], uv: number[] = [], index: number[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { p.push(...point(i / nx, j / ny)); uv.push(i / nx, j / ny); }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    index.push(...(flip ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(index); g.computeVertexNormals(); return g;
}
function box(p: Parts, mat: R34MaterialName, size: V3, pos: V3, radius = 0, rotation: V3 = [0, 0, 0]): void {
  const g = radius ? new RoundedBoxGeometry(...size, 1, Math.min(radius, ...size.map(n => n * .45))) : new THREE.BoxGeometry(...size);
  g.rotateX(rotation[0]).rotateY(rotation[1]).rotateZ(rotation[2]).translate(...pos); p.add(mat, g);
}
function beam(p: Parts, mat: R34MaterialName, a: V3, b: V3, radius: number, radial = 8): void {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), axis = end.clone().sub(start);
  const g = new THREE.CylinderGeometry(radius, radius, axis.length(), radial); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize())); g.translate(...start.add(end).multiplyScalar(.5).toArray()); p.add(mat, g);
}
function tube(p: Parts, mat: R34MaterialName, points: V3[], radius: number, segments = 48, radial = 6, closed = false): void {
  p.add(mat, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(...v)), closed, 'centripetal'), segments, radius, radial, closed));
}
function cylinder(p: Parts, mat: R34MaterialName, r: number, depth: number, pos: V3, axis: 'x' | 'z' = 'z', segments = 48): void {
  const g = new THREE.CylinderGeometry(r, r, depth, segments); if (axis === 'x') g.rotateZ(-Math.PI / 2); else g.rotateX(Math.PI / 2); g.translate(...pos); p.add(mat, g);
}
function ring(p: Parts, mat: R34MaterialName, r: number, thickness: number, pos: V3, axis: 'x' | 'z' = 'z', segments = 64): void {
  const g = new THREE.TorusGeometry(r, thickness, 6, segments); if (axis === 'x') g.rotateY(Math.PI / 2); g.translate(...pos); p.add(mat, g);
}
function decal(p: Parts, cell: keyof typeof R34_DECALS, size: readonly [number, number], pos: V3, rotation: V3 = [0, 0, 0]): void {
  const [x, y, w, h] = R34_DECALS[cell], g = new THREE.PlaneGeometry(...size), uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, x + uv.getX(i) * w, 1 - y - h + uv.getY(i) * h);
  g.rotateX(rotation[0]).rotateY(rotation[1]).rotateZ(rotation[2]).translate(...pos); p.add('decal', g);
}
function smooth(a: number, b: number, t: number): number { const v = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1); return v * v * (3 - 2 * v); }
function belt(z: number): number { return .875 - .103 * (1 - smooth(-2.1, -.3, z)) + .061 * smooth(.15, 2.1, z); }
function width(z: number): number { return .865 + .0275 * Math.max(...AXLES.map(a => Math.exp(-(((z - a) / .43) ** 2)))); }
function sideX(z: number, y: number): number {
  const h = THREE.MathUtils.clamp((y - .19) / (belt(z) - .19), 0, 1);
  const pressing = .005 * smooth(.52, .70, h) - .004 * smooth(.76, .98, h);
  const doorHollow = .006 * Math.sin(h * Math.PI) ** 2 * Math.exp(-((z / .85) ** 4));
  return width(z) - .034 * (1 - h) ** 3 - .027 * smooth(.57, 1, h) + .004 * Math.sin(h * Math.PI) + pressing - doorHollow;
}
function crown(t: number): number { return .038 * Math.sqrt(Math.max(0, 1 - t ** 8)); }
function bodyTop(z: number, x: number): number { return belt(z) + crown(x / sideX(z, belt(z))); }
/** A quarter ellipse supplies tangent returns to the flanks. The centre remains characteristically square. */
function sweep(t: number): number { const q = THREE.MathUtils.clamp((Math.abs(t) - .68) / .32, 0, 1); return .26 * (1 - Math.sqrt(Math.max(0, 1 - q * q))); }
function endPoint(rear: boolean, x: number, y: number, depth = 0): V3 {
  const t = x / .865, roll = rear ? -.012 * smooth(.82, .97, y) : .037 * smooth(.56, .81, y) + .022 * (1 - smooth(.17, .27, y));
  const z = (rear ? 1 : -1) * (2.29 - sweep(t)) + roll * (1 - Math.abs(t) ** 12);
  const top = belt(z) + crown(t), rawTop = rear ? .97 : .81;
  const yy = y + smooth(rawTop - .13, rawTop, y) * (top - rawTop);
  return [t * sideX(z, yy), yy, z + (rear ? -depth : depth)];
}

/** Clip the aperture triangulation onto a curvature-spaced lattice before bending the sheet.
 * This preserves exact cutout outlines without recursive thin-triangle tessellation padding. */
function skin(p: Parts, shape: THREE.Shape, rear: boolean): void {
  const raw = new THREE.ShapeGeometry(shape, 8), attr = raw.getAttribute('position'), idx = raw.index!;
  const positions: number[] = [], normals: number[] = [], uv: number[] = [];
  const map = (v: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(...endPoint(rear, v.x, v.y));
  const normal = (v: THREE.Vector2): THREE.Vector3 => {
    const e = .00003, dx = map(new THREE.Vector2(v.x + e, v.y)).sub(map(new THREE.Vector2(v.x - e, v.y))), dy = map(new THREE.Vector2(v.x, v.y + e)).sub(map(new THREE.Vector2(v.x, v.y - e)));
    return dx.cross(dy).normalize().multiplyScalar(rear ? 1 : -1);
  };
  const xs = [-.865, .865];
  for (let i = -12; i <= 12; i++) xs.push(i * .048);
  for (const sign of [-1, 1]) for (let i = 0; i <= 12; i++) xs.push(sign * .865 * (.68 + .32 * Math.sin(i / 12 * Math.PI / 2)));
  const cuts = [...new Set(xs)].sort((a, b) => a - b), top = rear ? .97 : .81;
  const ys = Array.from({ length: 23 }, (_, i) => THREE.MathUtils.lerp(.17, top, i / 22));
  function clip(poly: THREE.Vector2[], axis: 'x' | 'y', value: number, above: boolean): THREE.Vector2[] {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ai = above ? a[axis] >= value : a[axis] <= value, bi = above ? b[axis] >= value : b[axis] <= value;
      if (ai) out.push(a); if (ai !== bi) out.push(a.clone().lerp(b, (value - a[axis]) / (b[axis] - a[axis])));
    }
    return out;
  }
  for (let i = 0; i < idx.count; i += 3) {
    const tri = [0, 1, 2].map(j => new THREE.Vector2(attr.getX(idx.getX(i + j)), attr.getY(idx.getX(i + j))));
    const minX = Math.min(...tri.map(v => v.x)), maxX = Math.max(...tri.map(v => v.x)), minY = Math.min(...tri.map(v => v.y)), maxY = Math.max(...tri.map(v => v.y));
    for (let x = 0; x < cuts.length - 1; x++) {
      if (cuts[x] > maxX || cuts[x + 1] < minX) continue;
      const column = clip(clip(tri, 'x', cuts[x], true), 'x', cuts[x + 1], false);
      for (let y = 0; y < ys.length - 1; y++) {
        if (ys[y] > maxY || ys[y + 1] < minY) continue;
        const poly = clip(clip(column, 'y', ys[y], true), 'y', ys[y + 1], false);
        for (let k = 1; k < poly.length - 1; k++) {
          const a = poly[0], b = poly[k], c = poly[k + 1];
          if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-8) continue;
          for (const v of rear ? [a, b, c] : [a, c, b]) { positions.push(...map(v).toArray()); normals.push(...normal(v).toArray()); uv.push(v.x, v.y); }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); p.add('paint', g); raw.dispose();
  // Actual return walls, not an opaque rectangle pretending to be a recess.
  for (const hole of shape.holes) {
    const points = hole.getSpacedPoints(72);
    const centre = points.reduce((v, q) => v.add(q), new THREE.Vector2()).multiplyScalar(1 / points.length);
    p.add('paint', surface(points.length - 1, 2, (u, v) => { const q = points[Math.round(u * (points.length - 1))].clone().lerp(centre, .03 * v); return endPoint(rear, q.x, q.y, .009 * v); }, !rear));
    p.add('trim', surface(points.length - 1, 2, (u, v) => { const q = points[Math.round(u * (points.length - 1))].clone().lerp(centre, .03 + .025 * v); return endPoint(rear, q.x, q.y, .009 + .076 * v); }, !rear));
  }
}
function aperture(x: number, y: number, w: number, h: number, r: number): THREE.Path {
  const s = new THREE.Path(), l = x - w / 2, b = y - h / 2, right = x + w / 2, top = y + h / 2;
  s.moveTo(l + r, b); s.lineTo(right - r, b); s.quadraticCurveTo(right, b, right, b + r); s.lineTo(right, top - r); s.quadraticCurveTo(right, top, right - r, top); s.lineTo(l + r, top); s.quadraticCurveTo(l, top, l, top - r); s.lineTo(l, b + r); s.quadraticCurveTo(l, b, l + r, b); s.closePath(); return s;
}
function outline(top: number): THREE.Shape {
  const s = new THREE.Shape(); s.moveTo(-.865, .17); s.lineTo(.865, .17); s.lineTo(.865, top); s.lineTo(-.865, top); s.closePath(); return s;
}
function bodyShell(p: Parts): void {
  const cuts = [-2.03, AXLES[0] - ARCH, AXLES[0] + ARCH, AXLES[1] - ARCH, AXLES[1] + ARCH, 2.03];
  for (const sign of [-1, 1]) {
    for (let section = 0; section < cuts.length - 1; section++) {
      const z0 = cuts[section], z1 = cuts[section + 1], axle = section === 1 ? AXLES[0] : section === 3 ? AXLES[1] : undefined;
      const flank = surface(axle === undefined ? Math.ceil((z1 - z0) / .027) : 64, 20, (u, v) => {
        const z = axle === undefined ? THREE.MathUtils.lerp(z0, z1, u) : axle - ARCH * Math.cos(Math.PI * u);
        const bottom = axle === undefined ? .19 : R + ARCH * Math.sin(Math.PI * u), y = THREE.MathUtils.lerp(bottom, belt(z), v);
        return [sign * sideX(z, y), y, z];
      }, sign > 0);
      // Use the sheet's differential normals. Averaged grid normals made the pressing zigzag where
      // the arch's cosine-distributed columns meet ordinary longitudinal columns.
      const fp = flank.getAttribute('position'), fn = flank.getAttribute('normal'), normal = new THREE.Vector3(), e = .0001;
      for (let i = 0; i < fp.count; i++) {
        const y = fp.getY(i), z = fp.getZ(i), dy = (sideX(z, y + e) - sideX(z, y - e)) / (2 * e), dz = (sideX(z + e, y) - sideX(z - e, y)) / (2 * e);
        normal.set(sign, -dy, -dz).normalize(); fn.setXYZ(i, normal.x, normal.y, normal.z);
      }
      p.add('paint', flank);
    }
    for (const axle of AXLES) {
      p.add('paint', surface(64, 4, (u, v) => {
        const a = Math.PI * u, radius = ARCH + v * .012, y = R + radius * Math.sin(a), z = axle - radius * Math.cos(a);
        return [sign * (sideX(z, y) + .004 * Math.sin(v * Math.PI)), y, z];
      }, sign > 0));
      // Rolled lip followed by a deep, CLOSED tub. Front tubs leave room for 55-degree lock.
      p.add('trim', surface(64, 10, (u, v) => {
        const a = Math.PI * u, radius = ARCH + .025 * smooth(0, .35, v), y = R + radius * Math.sin(a), z = axle - radius * Math.cos(a);
        return [sign * THREE.MathUtils.lerp(sideX(z, y) - .003, .36, v), y, z];
      }, sign < 0));
      const wall = new THREE.Shape(); wall.moveTo(-.401, .15 - R); wall.lineTo(.401, .15 - R); wall.lineTo(.401, 0); wall.absarc(0, 0, .401, 0, Math.PI, false); wall.closePath();
      const g = new THREE.ShapeGeometry(wall, 32); g.rotateY(sign * Math.PI / 2).translate(sign * .36, R, axle); p.add('trim', g);
      // Low suspension hardware is visible through the spokes, not the passenger compartment.
      beam(p, 'darkMetal', [sign * .37, .24, axle - .19], [sign * .72, .26, axle], .019);
      beam(p, 'darkMetal', [sign * .37, .24, axle + .19], [sign * .72, .26, axle], .019);
      beam(p, 'darkMetal', [sign * .54, .31, axle], [sign * .51, .69, axle + .025], .022);
      for (let i = 0; i < 6; i++) ring(p, 'darkMetal', .041, .005, [sign * .51, .43 + i * .028, axle], 'z', 24);
      for (const dir of [-1, 1]) {
        const z = axle + dir * ARCH;
        p.add('trim', surface(2, 4, (u, v) => [sign * THREE.MathUtils.lerp(sideX(z, .25), .36, u), .15 + v * (R - .15), z], dir * sign > 0));
      }
    }
    box(p, 'paint', [.055, .075, 1.88], [sign * .843, .19, -.012], .012);
    box(p, 'carbon', [.064, .012, 1.89], [sign * .843, .15, -.012], .003);
    // Shoulder strips leave the centre genuinely open for the independent cockpit.
    p.add('paint', surface(90, 6, (u, v) => {
      const z = -.62 + u * 2.28, x = THREE.MathUtils.lerp(.755, sideX(z, belt(z)), v);
      return [sign * x, bodyTop(z, x), z];
    }, sign < 0));
    const door: V3[] = [[.87, -.48], [.61, -.58], [.26, -.54], [.23, -.42], [.23, .64], [.31, .74], [.90, .75]].map(([y, z]) => [sign * (sideX(z, y) + .0015), y, z]);
    tube(p, 'trim', door, .0016, 72, 5);
    const handleY = .851, handleZ = .59, handleX = sideX(handleZ, handleY);
    box(p, 'trim', [.009, .031, .135], [sign * (handleX + .002), handleY, handleZ], .008);
    box(p, 'paint', [.014, .014, .111], [sign * (handleX + .009), handleY + .003, handleZ], .005);
    if (sign > 0) tube(p, 'trim', Array.from({ length: 24 }, (_, i) => {
      const a = i / 24 * TAU, z = 1.61 + .078 * Math.cos(a), y = .849 + .071 * Math.sin(a);
      return [sideX(z, y) + .001, y, z] as V3;
    }), .0012, 48, 5, true);
    box(p, sign < 0 ? 'left' : 'right', [.007, .019, .067], [sign * (sideX(-.86, .755) + .004), .755, -.86], .006);
  }
  for (const rear of [false, true]) p.add('paint', surface(48, rear ? 20 : 44, (u, v) => {
    const t = u * 2 - 1, start = rear ? 1.66 : -2.29 + sweep(t) + .037 * (1 - Math.abs(t) ** 12), end = rear ? 2.29 - sweep(t) - .012 * (1 - Math.abs(t) ** 12) : -.62, z = THREE.MathUtils.lerp(start, end, v), x = t * sideX(z, belt(z));
    const crease = rear ? 0 : .005 * Math.exp(-(((Math.abs(t) - .64) / .06) ** 2)) * Math.sin(v * Math.PI);
    return [x, belt(z) + crown(t) + crease, z];
  }, true));
  for (const sign of [-1, 1]) tube(p, 'trim', Array.from({ length: 52 }, (_, i) => {
    const z = -2.2 + i / 51 * 1.57, x = sign * sideX(z, belt(z)) * .82;
    return [x, bodyTop(z, x) + .0008, z] as V3;
  }), .0013, 64, 5);
  // A narrow central floor plus engine/sump and rear cradle; never a slab across the arch openings.
  box(p, 'trim', [1.18, .025, 1.83], [0, .157, .01], .004);
  box(p, 'darkMetal', [.65, .11, .72], [0, .24, -1.36], .018);
  box(p, 'darkMetal', [.63, .08, .53], [0, .23, 1.31], .014);
  tube(p, 'metal', [[-.19, .185, -.7], [-.23, .178, .6], [-.48, .19, 1.7], [-.58, .24, 2.16]], .026, 48, 10);
}

function roofPoint(u: number, v: number): V3 {
  const t = u * 2 - 1, z0 = .18 - .035 * (1 - t * t), z1 = 1.04 + .025 * (1 - t * t);
  return [t * (.657 - .007 * Math.sin(v * Math.PI)), 1.316 + .032 * (1 - t * t) + .012 * Math.sin(v * Math.PI), THREE.MathUtils.lerp(z0, z1, v)];
}
function sidePoint(sign: number, u: number, v: number): V3 {
  const z0 = -.62 + 2.28 * u, [rx, ry, rz] = roofPoint(sign > 0 ? 1 : 0, u);
  return [THREE.MathUtils.lerp(sign * .755, rx, v) + sign * .006 * Math.sin(v * Math.PI) * Math.sin(u * Math.PI), THREE.MathUtils.lerp(bodyTop(z0, .755), ry, v), THREE.MathUtils.lerp(z0, rz, v)];
}
function screenPoint(rear: boolean, u: number, v: number): V3 {
  const t = u * 2 - 1, baseZ = rear ? 1.66 : -.62, top = roofPoint(u, rear ? 1 : 0);
  const z = THREE.MathUtils.lerp(baseZ, top[2], v) - (rear ? -1 : 1) * .018 * (1 - t * t) * Math.sin(v * Math.PI);
  return [THREE.MathUtils.lerp(t * .755, top[0], v), THREE.MathUtils.lerp(bodyTop(baseZ, t * .755), top[1], v) + .008 * (1 - t * t) * Math.sin(v * Math.PI), z];
}
/** A cut-out ring of the parent surface: all four edges meet roof/body/adjacent frames exactly. */
function framedWindow(p: Parts, point: Point, bounds: readonly [number, number, number, number], flip: boolean): void {
  const [u0, u1, v0, v1] = bounds;
  const patch = (mat: R34MaterialName, a: number, b: number, c: number, d: number, nx: number, ny: number) => p.add(mat, surface(nx, ny, (u, v) => point(THREE.MathUtils.lerp(a, b, u), THREE.MathUtils.lerp(c, d, v)), flip));
  patch('paint', 0, u0, 0, 1, 4, 24); patch('paint', u1, 1, 0, 1, 5, 24); patch('paint', u0, u1, 0, v0, 40, 3); patch('paint', u0, u1, v1, 1, 40, 4);
  patch('glass', u0, u1, v0, v1, 28, 16);
  for (const [a, b] of [[[u0, v0], [u1, v0]], [[u1, v0], [u1, v1]], [[u1, v1], [u0, v1]], [[u0, v1], [u0, v0]]] as const) {
    const pts = Array.from({ length: 32 }, (_, i) => point(THREE.MathUtils.lerp(a[0], b[0], i / 31), THREE.MathUtils.lerp(a[1], b[1], i / 31)));
    tube(p, 'trim', pts, .0033, 36, 6);
    // Metal/rubber reveal thickness follows the same curve rather than cylinder caps floating in air.
    p.add('trim', surface(32, 1, (u, v) => { const [x, y, z] = point(THREE.MathUtils.lerp(a[0], b[0], u), THREE.MathUtils.lerp(a[1], b[1], u)); return [x * (1 - .015 * v), y - .012 * v, z]; }, flip));
  }
}
function greenhouse(p: Parts, roof: Parts): void {
  roof.add('paint', surface(48, 32, roofPoint, true));
  // Roof hem is a closed narrow return, not separate rails with exposed end caps.
  for (const sign of [-1, 1]) {
    p.add('paint', surface(40, 2, (u, v) => { const [x, y, z] = roofPoint(sign > 0 ? 1 : 0, u); return [x - sign * .009 * v, y - .012 * v, z]; }, sign < 0));
    framedWindow(p, (u, v) => sidePoint(sign, u, v), [.065, .88, .045, .94], sign > 0);
    // Flush B-post: a shaped strip on the glazing, not a black diagonal cylindrical bar.
    p.add('trim', surface(3, 28, (u, v) => { const [x, y, z] = sidePoint(sign, .55 + .02 * u, .045 + v * .895); return [x + sign * .0015, y, z]; }, sign > 0));
    const mirrorBase = sidePoint(sign, .085, .11);
    beam(p, 'trim', mirrorBase, [sign * .925, .951, -.34], .018, 10);
    mirror(p, sign);
  }
  for (const rear of [false, true]) framedWindow(p, (u, v) => screenPoint(rear, u, v), [.034, .966, .045, .945], !rear);
  for (let i = 1; i <= 11; i++) tube(p, 'darkMetal', Array.from({ length: 20 }, (_, j) => {
    const [x, y, z] = screenPoint(true, .055 + j / 19 * .89, .07 + i * .071); return [x, y + .0005, z + .0005] as V3;
  }), .00045, 24, 3);
  for (const sign of [-1, 1]) {
    const arm0 = screenPoint(false, sign < 0 ? .23 : .65, .055), arm1 = screenPoint(false, sign < 0 ? .33 : .76, .12);
    beam(p, 'darkMetal', arm0, arm1, .0045); tube(p, 'trim', [screenPoint(false, sign < 0 ? .17 : .60, .13), screenPoint(false, sign < 0 ? .34 : .78, .14), screenPoint(false, sign < 0 ? .48 : .92, .13)], .005, 28);
  }
}

function mirror(p: Parts, sign: number): void {
  // A hollow-backed rounded wedge. In particular there is NO complete ellipsoid behind the glass:
  // its convex rear would poke through the reflective plane from a cockpit viewing angle.
  const path = aperture(0, 0, .198, .087, .022), perimeter = path.getSpacedPoints(64);
  const point = (q: THREE.Vector2, scale: number, z: number): V3 => [sign * .948 + q.x * scale, .972 + q.y * scale + sign * q.x * .045, z + sign * q.x * .12];
  p.add('paint', surface(64, 12, (u, v) => {
    const q = perimeter[Math.round(u * 64)], scale = v < .5 ? .76 + .24 * Math.sin(v * Math.PI) : 1 - .04 * smooth(.5, 1, v);
    return point(q, scale, THREE.MathUtils.lerp(-.411, -.263, v));
  }));
  // Rounded nose cap faces forward. Rear shell ends at a finite lip around a recessed black reveal.
  const cap = new THREE.ShapeGeometry(new THREE.Shape(path.getPoints(8))), cp = cap.getAttribute('position'), ci = cap.index!;
  for (let i = 0; i < cp.count; i++) cp.setXYZ(i, ...point(new THREE.Vector2(cp.getX(i), cp.getY(i)), .76, -.411));
  for (let i = 0; i < ci.count; i += 3) { const b = ci.getX(i + 1); ci.setX(i + 1, ci.getX(i + 2)); ci.setX(i + 2, b); } cap.computeVertexNormals(); p.add('paint', cap);
  p.add('trim', surface(64, 3, (u, v) => point(perimeter[Math.round(u * 64)], .96 - .105 * v, -.263 - .003 * v)));
  const glass = new THREE.ShapeGeometry(new THREE.Shape(path.getPoints(10))), gp = glass.getAttribute('position');
  for (let i = 0; i < gp.count; i++) gp.setXYZ(i, ...point(new THREE.Vector2(gp.getX(i), gp.getY(i)), .858, -.265));
  glass.computeVertexNormals(); p.add('chrome', glass);
}

function grille(p: Parts, x: number, y: number, w: number, h: number, rear = false, depth = .045): void {
  const point = (xx: number, yy: number) => endPoint(rear, xx, yy, depth);
  for (let i = 0; i <= Math.floor(w / .025); i++) {
    const xx = x - w / 2 + i * .025; beam(p, 'grille', point(xx, y - h / 2), point(xx, y + h / 2), .0012, 4);
  }
  for (let i = 0; i <= Math.floor(h / .025); i++) {
    const yy = y - h / 2 + i * .025;
    tube(p, 'grille', Array.from({ length: 12 }, (_, j) => point(x - w / 2 + j / 11 * w, yy)), .0012, 12, 4);
  }
}
function deformFront(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position'), normal = g.getAttribute('normal'), jacobian = new THREE.Matrix3(), n = new THREE.Vector3(), e = .00003;
  const map = (x: number, y: number, z: number) => new THREE.Vector3(...endPoint(false, x, y, z));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), dx = map(x + e, y, z).sub(map(x - e, y, z)).multiplyScalar(.5 / e), dy = map(x, y + e, z).sub(map(x, y - e, z)).multiplyScalar(.5 / e);
    jacobian.set(dx.x, dy.x, 0, dx.y, dy.y, 0, dx.z, dy.z, 1).invert().transpose(); n.fromBufferAttribute(normal, i).applyMatrix3(jacobian).normalize(); normal.setXYZ(i, n.x, n.y, n.z);
    const out = map(x, y, z); pos.setXYZ(i, out.x, out.y, out.z);
  }
}
function lampOutline(sign: number, inset = 0): THREE.Path {
  const pts: [number, number][] = [[.277 + inset, .672 + inset], [.77 - inset, .686 + inset], [.801 - inset, .702 + inset], [.787 - inset, .793 - inset], [.29 + inset, .798 - inset]];
  return new THREE.Path(pts.map(([x, y]) => new THREE.Vector2(sign * x, y)));
}
function front(p: Parts): void {
  const shape = outline(.81); shape.holes.push(aperture(0, .368, .94, .216, .027)); shape.holes.push(aperture(0, .735, .476, .109, .008));
  for (const sign of [-1, 1]) { shape.holes.push(aperture(sign * .66, .374, .188, .205, .025)); shape.holes.push(lampOutline(sign)); }
  skin(p, shape, false);
  grille(p, 0, .368, .91, .194); grille(p, 0, .735, .45, .092);
  for (const sign of [-1, 1]) grille(p, sign * .66, .374, .165, .18);
  const detail = new Parts();
  box(detail, 'metal', [.835, .184, .049], [0, .367, .11], .009);
  for (let i = 0; i < 18; i++) box(detail, 'metal', [.75, .003, .006], [0, .282 + i * .01, .082]);
  for (const sign of [-1, 1]) {
    box(detail, 'metal', [.042, .183, .058], [sign * .405, .367, .109], .009); box(detail, 'darkMetal', [.015, .191, .012], [sign * .28, .367, .073], .002);
    box(detail, 'trim', [.16, .186, .005], [sign * .66, .374, .091], .01);
    for (let i = 0; i < 2; i++) box(detail, 'carbon', [.154, .01, .065], [sign * .66, .335 + i * .07, .052], .002, [.15, 0, 0]);
    // A fitted angular backing and clear cover carry three different optical elements.
    const backing = new THREE.Shape(lampOutline(sign).getPoints());
    const housing = new THREE.ShapeGeometry(backing, 6); housing.rotateY(Math.PI); // compensate x reflection below
    const hp = housing.getAttribute('position'); for (let i = 0; i < hp.count; i++) hp.setX(i, -hp.getX(i));
    // Reverse winding after reflection; front-facing surfaces point toward -Z.
    const hi = housing.index!; for (let i = 0; i < hi.count; i += 3) { const b = hi.getX(i + 1); hi.setX(i + 1, hi.getX(i + 2)); hi.setX(i + 2, b); }
    housing.translate(0, 0, .057); detail.add('darkMetal', housing);
    for (const [xx, r] of [[.465, .049], [.65, .051]] as const) {
      const x = sign * xx, y = .735;
      detail.add('chrome', surface(48, 10, (u, v) => { const a = u * TAU, rr = r * (.18 + .82 * v); return [x + rr * Math.cos(a), y + rr * Math.sin(a), .057 - .033 * v * v]; }));
      ring(detail, 'chrome', r, .0027, [x, y, .023], 'z', 64);
      cylinder(detail, 'headlight', r * .48, .006, [x, y, .022], 'z', 40);
      const lens = new THREE.SphereGeometry(r * .53, 28, 14); lens.scale(1, 1, .3).translate(x, y, .016); detail.add('lens', lens);
      for (let j = 0; j < 8; j++) { const a = j / 8 * TAU; beam(detail, 'darkMetal', [x + Math.cos(a) * r * .71, y + Math.sin(a) * r * .71, .024], [x + Math.cos(a) * r * .94, y + Math.sin(a) * r * .94, .024], .001, 4); }
    }
    box(detail, 'chrome', [.073, .085, .009], [sign * .334, .735, .027], .008);
    for (let i = 0; i < 6; i++) box(detail, 'darkMetal', [.0014, .073, .003], [sign * (.304 + i * .012), .735, .02]);
    box(detail, sign < 0 ? 'left' : 'right', [.044, .079, .01], [sign * .753, .735, .029], .007);
    for (let i = 0; i < 5; i++) box(detail, 'chrome', [.0014, .072, .004], [sign * (.735 + i * .009), .735, .022]);
    const cover = new THREE.ShapeGeometry(new THREE.Shape(lampOutline(sign, .003).getPoints()), 6); cover.translate(0, 0, .006); detail.add('lens', cover);
    tube(detail, 'trim', [...lampOutline(sign).getSpacedPoints(100).map(q => [q.x, q.y, .009] as V3), [sign * .277, .672, .009]], .0023, 110, 6);
  }
  for (const [name, g] of Object.entries(detail.finish())) { deformFront(g); p.add(name as R34MaterialName, g); }
  p.add('carbon', surface(80, 4, (u, v) => { const t = u * 2 - 1, [x, , z] = endPoint(false, t * .865, .17); return [x, .151 + .008 * v, z - .012 + v * .19]; }, true));
  p.add('carbon', surface(80, 1, (u, v) => { const [x, , z] = endPoint(false, (u * 2 - 1) * .865, .17); return [x, .139 + v * .012, z - .012]; }));
  box(p, 'trim', [.305, .097, .012], [0, .559, -2.297], .004); decal(p, 'plate', [.293, .089], [0, .559, -2.305], [0, Math.PI, 0]); decal(p, 'gtr', [.046, .054], [.123, .736, -2.253], [0, Math.PI, 0]);
  tube(p, 'trim', Array.from({ length: 81 }, (_, i) => endPoint(false, (i / 80 * 2 - 1) * .865, .651, -.0006)), .0012, 96, 5);
}

function rear(p: Parts): void {
  const shape = outline(.97); for (const sign of [-1, 1]) shape.holes.push(aperture(sign * .51, .798, .524, .214, .025)); shape.holes.push(aperture(0, .607, .353, .127, .016)); shape.holes.push(aperture(-.59, .26, .177, .155, .049)); skin(p, shape, true);
  for (const sign of [-1, 1]) {
    // Body-coloured individual round recesses, not a silver rectangular billboard.
    for (const [x0, r] of [[.382, .074], [.642, .09]] as const) {
      const [x, y, z] = endPoint(true, sign * x0, .798, -.006);
      cylinder(p, 'trim', r + .012, .025, [x, y, z - .006], 'z', 64); cylinder(p, 'redLens', r, .016, [x, y, z + .006], 'z', 64);
      ring(p, 'redLens', r * .95, .003, [x, y, z + .016]); ring(p, 'tail', r * .73, r * .12, [x, y, z + .018]); ring(p, 'redLens', r * .39, .004, [x, y, z + .022]);
      cylinder(p, x0 < .5 ? sign < 0 ? 'left' : 'right' : 'redLens', r * .29, .004, [x, y, z + .02], 'z', 40);
      for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; beam(p, 'redLens', [x + Math.cos(a) * r * .4, y + Math.sin(a) * r * .4, z + .021], [x + Math.cos(a) * r * .91, y + Math.sin(a) * r * .91, z + .016], .0012, 4); }
    }
    // Dark recess connects the two lamps and fills the entire actual body cutout.
    const pts = aperture(sign * .51, .798, .524, .214, .025).getPoints(8), backing = new THREE.ShapeGeometry(new THREE.Shape(pts));
    const bp = backing.getAttribute('position'); for (let i = 0; i < bp.count; i++) { const q = endPoint(true, bp.getX(i), bp.getY(i), .025); bp.setXYZ(i, ...q); } backing.computeVertexNormals(); p.add('trim', backing);
    const q = endPoint(true, sign * .65, .49, -.003); box(p, 'reverse', [.107, .033, .009], q, .006);
    const r = endPoint(true, sign * .68, .319, -.004); box(p, 'redLens', [.104, .018, .008], r, .003);
  }
  box(p, 'trim', [.348, .124, .014], [0, .607, 2.274], .005); decal(p, 'plate', [.328, .112], [0, .607, 2.286]); decal(p, 'skyline', [.355, .035], [0, .901, 2.293]); decal(p, 'nissan', [.048, .048], [0, .965, 2.294]); decal(p, 'gtr', [.056, .061], [.24, .688, 2.285]); decal(p, 'vSpec', [.105, .024], [-.25, .606, 2.287]);
  tube(p, 'trim', Array.from({ length: 65 }, (_, i) => endPoint(true, (i / 64 * 2 - 1) * .865, .456, -.001)), .0014, 72, 5);
  tube(p, 'trim', [[-.71, bodyTop(1.68, .71), 1.68], [-.76, bodyTop(2.05, .76) + .001, 2.05], [-.69, bodyTop(2.22, .69) + .001, 2.22], [0, bodyTop(2.22, 0) + .001, 2.22], [.69, bodyTop(2.22, .69) + .001, 2.22], [.76, bodyTop(2.05, .76) + .001, 2.05], [.71, bodyTop(1.68, .71), 1.68]], .0015, 100, 5);
  box(p, 'carbon', [1.25, .023, .35], [0, .167, 2.09], .005, [-.08, 0, 0]); for (let i = -2; i <= 2; i++) box(p, 'carbon', [.009, .061, .3], [i * .23, .169, 2.09], .002);
  cylinder(p, 'darkMetal', .066, .26, [-.58, .257, 2.14], 'z', 64); ring(p, 'metal', .063, .004, [-.58, .257, 2.277]); cylinder(p, 'trim', .055, .005, [-.58, .257, 2.253], 'z', 48); ring(p, 'darkMetal', .046, .003, [-.58, .257, 2.272]);
}
function wing(p: Parts): void {
  for (const sign of [-1, 1]) {
    box(p, 'paint', [.105, .026, .18], [sign * .54, .986, 1.91], .01);
    const s = new THREE.Shape();
    s.moveTo(1.825, .999); s.quadraticCurveTo(1.855, .99, 1.918, .999); s.lineTo(1.985, 1.19); s.quadraticCurveTo(1.93, 1.203, 1.86, 1.19); s.lineTo(1.825, .999);
    s.holes.push(aperture(1.899, 1.103, .041, .105, .017));
    const g = new THREE.ExtrudeGeometry(s, { depth: .032, bevelEnabled: true, bevelThickness: .003, bevelSize: .003, bevelSegments: 2, steps: 1 }); g.rotateY(-Math.PI / 2).translate(sign * .54 + .016, 0, 0); p.add('paint', g);
    for (const y of [1.027, 1.172]) cylinder(p, 'metal', .0045, .041, [sign * .54, y, 1.885 + (y - 1.027) * .2], 'x', 10);
    box(p, 'darkMetal', [.043, .018, .143], [sign * .54, 1.187, 1.91], .003);
    box(p, 'paint', [.021, .103, .29], [sign * .745, 1.215, 1.91], .008);
    for (const z of [1.85, 1.97]) cylinder(p, 'chrome', .0038, .025, [sign * .745, 1.217, z], 'x', 10);
  }
  const profile: [number, number][] = [];
  for (let i = 0; i <= 24; i++) { const t = i / 24; profile.push([t, .008 + .021 * Math.sin(t * Math.PI)]); }
  for (let i = 24; i >= 0; i--) { const t = i / 24; profile.push([t, -.004 - .009 * Math.sin(t * Math.PI)]); }
  p.add('carbon', surface(28, profile.length - 1, (u, v) => { const [t, yy] = profile[Math.round(v * (profile.length - 1))], x = (u * 2 - 1) * .735; return [x, 1.198 + yy + .009 * (1 - (x / .735) ** 2), 1.77 + t * .28]; }, true));
}

function revolve(profile: readonly (readonly [number, number])[], segments = 96): THREE.BufferGeometry { return new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments).rotateZ(-Math.PI / 2); }
function wheelGeometry(): { rolling: GeometryMap; fixed: GeometryMap } {
  const rolling = new Parts(), fixed = new Parts(), profile: [number, number][] = [[.233, -.117], [.253, -.123], [.281, -.129], [.301, -.126], [.315, -.114], [.324, -.095]];
  for (const x of [-.09, -.078, -.069, -.067, -.061, -.059, -.04, -.027, -.025, -.019, -.017, 0, .017, .019, .025, .027, .04, .059, .061, .067, .069, .078, .09]) {
    let r = .327 - .002 * (x / .09) ** 4; if ([-.064, -.022, .022, .064].some(g => Math.abs(x - g) < .0035)) r -= .004; profile.push([r, x]);
  }
  profile.push([.324, .095], [.315, .114], [.301, .126], [.281, .129], [.253, .123], [.233, .117]);
  // Tread sipes are depressions in the radial surface, not little boxes glued onto a torus.
  const tyre = surface(144, profile.length - 1, (u, v) => {
    const [base, x] = profile[Math.round(v * (profile.length - 1))], a = u * TAU;
    const phase = (u * 48 + (x > 0 ? x : -x) * 8) % 1, tread = Math.abs(x) < .105 && base > .32;
    const r = base - (tread ? .0021 * (1 - smooth(.04, .23, Math.min(phase, 1 - phase))) : 0);
    return [x, Math.cos(a) * r, Math.sin(a) * r];
  });
  tyre.userData.feature = 'grooved-tyre'; rolling.add('tyre', tyre);
  for (const side of [-1, 1]) { ring(rolling, 'tyre', .265, .001, [side * .13, 0, 0], 'x', 64); ring(rolling, 'tyre', .304, .0008, [side * .125, 0, 0], 'x', 64); }
  const lettering = new THREE.PlaneGeometry(.34, .022, 40, 1), lp = lettering.getAttribute('position'), lu = lettering.getAttribute('uv'), [dx, dy, dw, dh] = R34_DECALS.tyre;
  for (let i = 0; i < lp.count; i++) { const a = lp.getX(i) / .283, r = .282 + lp.getY(i); lp.setXYZ(i, .1302, Math.cos(a) * r, -Math.sin(a) * r); lu.setXY(i, dx + lu.getX(i) * dw, 1 - dy - dh + lu.getY(i) * dh); }
  lettering.computeVertexNormals(); rolling.add('decal', lettering); rolling.add('decal', lettering.clone().rotateX(Math.PI));
  rolling.add('darkMetal', revolve([[.227, .116], [.219, .095], [.219, -.105], [.223, -.111], [.226, -.107], [.223, .092], [.229, .114], [.227, .116]]));
  rolling.add('rim', revolve([[.23, -.116], [.237, -.115], [.237, -.108], [.228, -.102]])); rolling.add('rim', revolve([[.221, .092], [.228, .112], [.237, .117], [.238, .124], [.231, .129], [.223, .122]])); ring(rolling, 'metal', .232, .0014, [.127, 0, 0], 'x', 96);
  // Six concave forged spokes: closed bevelled castings, not over-tessellated flat bars.
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU, shape = new THREE.Shape(); shape.moveTo(.042, -.016); shape.bezierCurveTo(.1, -.021, .17, -.018, .225, -.011); shape.lineTo(.225, .011); shape.bezierCurveTo(.17, .018, .1, .022, .042, .016); shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: .012, steps: 1, bevelEnabled: true, bevelSize: .002, bevelThickness: .002, bevelSegments: 2, curveSegments: 6 }), pos = g.getAttribute('position');
    for (let j = 0; j < pos.count; j++) { const r = pos.getX(j), lateral = pos.getY(j), depth = pos.getZ(j); pos.setXYZ(j, .065 + .045 * (r / .225) ** 1.6 + depth, r * Math.cos(a) - lateral * Math.sin(a), r * Math.sin(a) + lateral * Math.cos(a)); } g.computeVertexNormals(); rolling.add('rim', g);
  }
  rolling.add('rim', revolve([[.063, .059], [.068, .083], [.057, .1], [.03, .1]], 64)); cylinder(rolling, 'darkMetal', .028, .01, [.105, 0, 0], 'x', 40); ring(rolling, 'metal', .027, .0014, [.111, 0, 0], 'x', 48);
  for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; cylinder(rolling, 'trim', .009, .007, [.103, Math.cos(a) * .045, Math.sin(a) * .045], 'x', 16); cylinder(rolling, 'metal', .0064, .013, [.109, Math.cos(a) * .045, Math.sin(a) * .045], 'x', 6); }
  beam(rolling, 'trim', [.111, .137, .163], [.127, .137, .163], .0035);
  for (const x of [-.028, -.006]) rolling.add('disc', revolve([[.084, x], [.178, x], [.181, x + .003], [.178, x + .007], [.084, x + .007]], 128));
  rolling.add('darkMetal', revolve([[.034, -.028], [.084, -.028], [.086, -.004], [.073, .013], [.034, .013]], 64));
  for (let i = 0; i < 48; i++) { const g = new THREE.BoxGeometry(.017, .0035, .082); g.translate(-.012, 0, .13).rotateX(i / 48 * TAU); rolling.add('darkMetal', g); }
  for (let row = 0; row < 3; row++) for (let i = 0; i < 28; i++) { const a = (i + row * .27) / 28 * TAU, r = .107 + row * .027; cylinder(rolling, 'darkMetal', .0025, .0007, [.0016, Math.cos(a) * r, Math.sin(a) * r], 'x', 8); }
  box(fixed, 'caliper', [.079, .141, .071], [.005, 0, .157], .018, [.2, 0, 0]); for (const y of [-.033, .033]) box(fixed, 'caliper', [.088, .031, .058], [.007, y, .152], .01); decal(fixed, 'brembo', [.073, .022], [.053, 0, .158], [0, Math.PI / 2, Math.PI / 2]);
  return { rolling: rolling.finish(), fixed: fixed.finish() };
}
let cached: { body: GeometryMap; roof: GeometryMap; rolling: GeometryMap; fixed: GeometryMap } | undefined;
function geometry() {
  if (!cached) { const p = new Parts(), roof = new Parts(); bodyShell(p); greenhouse(p, roof); front(p); rear(p); wing(p); cached = { body: p.finish(), roof: roof.finish(), ...wheelGeometry() }; }
  return cached;
}
export interface R34Exterior {
  body: THREE.Group; wheelRoot: THREE.Group; wheels: { update(steer: number, spin: number): void }; tail: THREE.MeshBasicMaterial; tailIdle: THREE.Color; tailBrake: THREE.Color;
  indicators: { set(left: boolean, right: boolean, brake: boolean): void }; setPaint(color: number): void; setCockpit(on: boolean): void; dispose(): void;
}
export function buildR34Exterior(paint: number): R34Exterior {
  const geo = geometry(), look = createR34Materials(paint), body = new THREE.Group(), roof = new THREE.Group(), wheelRoot = new THREE.Group();
  body.name = 'R34/exterior'; roof.name = 'R34/roof'; wheelRoot.name = 'R34/road-wheels';
  function add(parts: GeometryMap, dest: THREE.Group): void {
    for (const [name, g] of Object.entries(parts)) { const mesh = new THREE.Mesh(g, look.materials[name as R34MaterialName]); mesh.name = `R34/${name}`; mesh.castShadow = mesh.receiveShadow = name !== 'glass' && name !== 'lens'; if (name === 'glass' || name === 'lens') mesh.renderOrder = 2; dest.add(mesh); }
  }
  add(geo.body, body); add(geo.roof, roof); body.add(roof);
  const rolling: THREE.InstancedMesh[] = [], fixed: THREE.InstancedMesh[] = [];
  for (const [parts, dest] of [[geo.rolling, rolling], [geo.fixed, fixed]] as const) for (const [name, g] of Object.entries(parts)) {
    const mesh = new THREE.InstancedMesh(g, look.materials[name as R34MaterialName], 4); mesh.name = `R34/wheels/${name}`; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.castShadow = mesh.receiveShadow = true; wheelRoot.add(mesh); dest.push(mesh);
  }
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), spinQ = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1), xAxis = new THREE.Vector3(1, 0, 0), yAxis = new THREE.Vector3(0, 1, 0);
  const leftFixed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const wheels = { update(steer: number, spin: number) {
    for (let i = 0; i < 4; i++) {
      const front = i < 2, left = i % 2 === 0;
      position.set(left ? -.763 : .763, R, front ? AXLES[0] : AXLES[1]);
      // Mirror the fixed brakes without moving the left caliper to the opposite side of the axle.
      rotation.setFromAxisAngle(yAxis, front ? -steer : 0); if (left) rotation.multiply(leftFixed);
      matrix.compose(position, rotation, scale); fixed.forEach(m => m.setMatrixAt(i, matrix));
      rotation.setFromAxisAngle(yAxis, (front ? -steer : 0) + (left ? Math.PI : 0));
      spinQ.setFromAxisAngle(xAxis, left ? spin : -spin); rotation.multiply(spinQ); matrix.compose(position, rotation, scale); rolling.forEach(m => m.setMatrixAt(i, matrix));
    }
    for (const mesh of [...rolling, ...fixed]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
  } }; wheels.update(0, 0);
  const tailIdle = new THREE.Color(.75, .008, .004), tailBrake = new THREE.Color(3.3, .035, .014), off = new THREE.Color(.12, .035, .001), on = new THREE.Color(4, 1.5, .025); let disposed = false;
  return { body, wheelRoot, wheels, tail: look.tail, tailIdle, tailBrake, indicators: { set(left, right, brake) { look.left.color.copy(left ? on : off); look.right.color.copy(right ? on : off); look.tail.color.copy(brake ? tailBrake : tailIdle); } }, setPaint(color) { look.paint.color.setHex(color); }, setCockpit(on) { roof.visible = !on; }, dispose() { if (!disposed) { disposed = true; look.dispose(); [...rolling, ...fixed].forEach(m => m.dispose()); body.removeFromParent(); wheelRoot.removeFromParent(); } } };
}
