import * as THREE from 'three';
import { clamp } from '../../core/math';
import { Bucket, Grid } from './grid';
import { UV_PLAIN, uvFront, uvRear, uvSide, uvTop } from './livery';
import * as S from './r34Shape';

/*
 * R34-style coupe exterior, built once and shared by every car that uses it. Geometry is merged per
 * material: livery paint (body, greenhouse, mirrors, wing), black trim, chrome/lamp housings (vertex
 * shades), lamp emitters, tail lamps, honeycomb grilles, plus the cabin lining for the cockpit view.
 * Car space: x right, y up, z = -f (the car faces -Z).
 */

export const PAINT = 0;
export const TRIM = 1;
export const CHROME = 2;
export const EMIT = 3;
export const TAIL = 4;
export const GRILLE = 5;
export const SHELL = 6;
/** Turn signals, right side (x > 0) and its mirror image: each side blinks with its own material. */
export const IND_R = 7;
export const IND_L = 8;

export interface R34Geometry {
  parts: THREE.BufferGeometry[];
  /** Where the real headlight spot sits. */
  lamp: THREE.Vector3;
}

const NS = 12;
const Q = [0, 0.02, 0.05, S.Q_G, 0.13, 0.19, 0.26, 0.34, 0.43, 0.52, 0.62, 0.72, 0.82, 0.91, 1];
const QG_ROW = 3;
const J_SIDE = 6;
const J_TOP = J_SIDE + NS + 1;
const NJ = J_TOP + Q.length;

/** Body column: f and, at an arch edge, which side of the step it belongs to (-1 skirt, 1 arch). */
interface Col {
  f: number;
  arch: -1 | 0 | 1;
}

function tubColumns(): Col[] {
  const specials: { f: number; enter?: boolean }[] = [{ f: S.F_RW }, { f: S.F_WS }];
  for (const a of S.AXLES) specials.push({ f: a - S.ARCH_R, enter: true }, { f: a + S.ARCH_R, enter: false });
  specials.sort((a, b) => a.f - b.f);
  const step = (f: number) => {
    const af = Math.abs(f);
    if (af > 2.12) return 0.01;
    if (af > 1.95) return 0.025;
    for (const a of S.AXLES) if (Math.abs(f - a) < S.ARCH_R + 0.06) return 0.028;
    return 0.06;
  };
  const cols: Col[] = [];
  const push = (f: number) => {
    const sp = specials.find((s) => Math.abs(s.f - f) < 1e-9);
    if (sp && sp.enter !== undefined) {
      const [a, b] = sp.enter ? ([-1, 1] as const) : ([1, -1] as const);
      cols.push({ f, arch: a }, { f, arch: a }, { f, arch: b }, { f, arch: b });
    } else cols.push({ f, arch: 0 });
  };
  let f = S.F_REAR;
  push(f);
  while (f < S.F_FRONT - 1e-9) {
    let next = Math.min(f + step(f), S.F_FRONT);
    const sp = specials.find((s) => s.f > f + 1e-9 && s.f <= next + 0.006);
    if (sp) next = sp.f;
    else if (S.F_FRONT - next < 0.004) next = S.F_FRONT;
    f = next;
    push(f);
  }
  return cols;
}

function sillY(c: Col): number {
  const base = S.sillBase(c.f);
  if (c.arch < 0) return base;
  if (c.arch > 0) {
    const a = S.AXLES.reduce((m, x) => (Math.abs(c.f - x) < Math.abs(c.f - m) ? x : m));
    const d = c.f - a;
    return Math.max(base, S.ARCH_Y + Math.sqrt(Math.max(0, S.ARCH_R * S.ARCH_R - d * d)));
  }
  return Math.max(base, S.archTop(c.f));
}

/** Half cross-section of the body at a column, bottom centre → flank → top centre. */
function tubSection(c: Col): [number, number][] {
  const f = c.f;
  const ps = S.planS(f);
  const yb = S.yBot(f);
  const ys = sillY(c);
  const sb = S.sillBase(f);
  const belt = S.yBelt(f);
  const wIn = S.W_IN * ps;
  const xs = (y: number) => S.sideX(f, y) * ps;
  const out: [number, number][] = new Array(NJ);
  out[0] = [0, yb];
  out[1] = [wIn, yb];
  out[2] = [wIn, yb];
  out[3] = [wIn, ys];
  out[4] = [wIn, ys];
  out[5] = [xs(ys), ys];
  out[6] = [xs(ys), ys];
  for (let k = 1; k <= NS; k++) {
    const h = 0.5 - 0.5 * Math.cos((Math.PI * k) / NS);
    const y = Math.max(sb + (belt - sb) * h, ys);
    out[J_SIDE + k] = [xs(y), y];
  }
  for (let q = 0; q < Q.length; q++) out[J_TOP + q] = S.topPoint(f, Q[q], [0, 0]) as [number, number];
  return out;
}

/** Body shell (the "tub" under the greenhouse) with both end caps. */
function buildTub(b: Bucket[]): void {
  const cols = tubColumns();
  const g = new Grid(cols.length, NJ);
  const secs = cols.map(tubSection);
  secs.forEach((sec, i) => sec.forEach(([x, y], j) => g.set(i, j, x, y, -cols[i].f)));
  const inCabin = (i: number) => cols[i].f >= S.F_RW - 1e-9 && cols[i + 1].f <= S.F_WS + 1e-9;
  g.emit(
    b,
    (i, j) => {
      if (j < 5) return TRIM;
      if (j >= J_TOP + QG_ROW && inCabin(i)) return -1;
      return PAINT;
    },
    (i, j, bk) => {
      if (bk !== PAINT) return [0, 0];
      const [x, y] = secs[i][j];
      return j <= J_SIDE + NS ? uvSide(cols[i].f, y) : uvTop(cols[i].f, x);
    },
    { mirror: true },
  );
  // End caps: fans over the closing section (front faces -z, rear +z).
  for (const [i, dir] of [[cols.length - 1, -1], [0, 1]] as const) {
    const sec = secs[i];
    const z = -cols[i].f;
    const ring: [number, number][] = [...sec, ...sec.slice().reverse().map(([x, y]) => [-x, y] as [number, number])];
    const cy = (sec[0][1] + sec[NJ - 1][1]) / 2;
    const bk = b[PAINT];
    bk.resetKeys();
    const uv = (x: number, y: number) => (dir < 0 ? uvFront(x, y) : uvRear(x, y));
    const c = bk.vertex(-1, 0, cy, z, 0, 0, dir, ...uv(0, cy));
    for (let k = 0; k < ring.length - 1; k++) {
      const [x0, y0] = ring[k];
      const [x1, y1] = ring[k + 1];
      const cross = x0 * (y1 - cy) - (y0 - cy) * x1;
      if (Math.abs(cross) < 1e-9) continue;
      const v0 = bk.vertex(-1, x0, y0, z, 0, 0, dir, ...uv(x0, y0));
      const v1 = bk.vertex(-1, x1, y1, z, 0, 0, dir, ...uv(x1, y1));
      // cross > 0 winds counter-clockwise seen from +z.
      if (cross > 0 === dir > 0) bk.tri(c, v0, v1);
      else bk.tri(c, v1, v0);
    }
  }
}

/** Greenhouse grid (windshield, side glass, roof, rear window) standing on the body at Q_G. */
const SIDE_S = [0, 0.12, 0.3, 0.5, 0.7, 0.86, 1];
const TOP_Q = [0, 0.04, 0.1, 0.18, 0.28, 0.4, 0.52, 0.64, 0.76, 0.88, 1];
const G_TOP = SIDE_S.length + 1;

function greenhouseGrid(): { g: Grid; fs: number[] } {
  const fs: number[] = [];
  for (let f = S.F_RW; f < S.F_WS - 1e-9; ) {
    fs.push(f);
    const near = Math.min(f - S.F_RW, S.F_WS - f);
    f = Math.min(S.F_WS, f + (near < 0.12 ? 0.015 : 0.035));
  }
  fs.push(S.F_WS);
  const nj = G_TOP + TOP_Q.length;
  const g = new Grid(fs.length, nj);
  fs.forEach((f, i) => {
    const bx = S.baseX(f);
    const by = S.baseY(f);
    const rx = S.railX(f);
    const ry = S.railY(f);
    const bulge = 0.012 * clamp((ry - by) / 0.15, 0, 1);
    SIDE_S.forEach((s, j) => g.set(i, j, bx + (rx - bx) * s + bulge * Math.sin(Math.PI * s), by + (ry - by) * s, -f));
    g.set(i, SIDE_S.length, rx, ry, -f);
    const top = S.roofY(f);
    TOP_Q.forEach((q, j) => g.set(i, G_TOP + j, rx * (1 - q), ry + (top - ry) * S.crownG(q), -f));
  });
  return { g, fs };
}

function buildGreenhouse(b: Bucket[]): void {
  const { g, fs } = greenhouseGrid();
  const uv = (grid: Grid) => (i: number, j: number) => {
    const p = grid.at(i, j, [0, 0, 0]);
    return j < G_TOP ? uvSide(fs[i], p[1]) : uvTop(fs[i], p[0]);
  };
  const atOuter = uv(g);
  g.emit(b, () => PAINT, atOuter, { mirror: true });
  // Cabin lining: the same surface 2.2 cm in, facing inward; the atlas cuts the glass out of it.
  const lining = g.offset(-0.022);
  lining.emit(b, () => SHELL, (i, j) => atOuter(i, j), { mirror: true, flip: true });
}

// ---------------------------------------------------------------- parts on the surface

/** Patch on the nose slope over x0..x1, between heights lo(x) and hi(x), lifted by `lift`. */
function nosePatch(x0: number, x1: number, lo: (x: number) => number, hi: (x: number) => number, nx: number, ny: number, lift: number): Grid {
  const g = new Grid(nx + 1, ny + 1);
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    for (let j = 0; j <= ny; j++) {
      const y = lo(x) + ((hi(x) - lo(x)) * j) / ny;
      g.set(i, j, x, y, -S.noseF(x, y));
    }
  }
  // i runs right, j up the slope (backwards): Ti × Tj points into the body, hence the flip.
  return g.offset(lift, true);
}

/** Point on the nose slope and its outward normal. */
function noseFrame(x: number, y: number, lift: number): { p: THREE.Vector3; n: THREE.Vector3 } {
  const e = 0.004;
  const p = new THREE.Vector3(x, y, -S.noseF(x, y));
  const px = new THREE.Vector3(x + e, y, -S.noseF(x + e, y)).sub(p);
  const py = new THREE.Vector3(x, y + e, -S.noseF(x, y + e)).sub(p);
  const n = py.cross(px).normalize();
  return { p: p.addScaledVector(n, lift), n };
}

const ZAXIS = new THREE.Vector3(0, 0, 1);
/** A flat part (built facing +z) placed at p facing n. */
function placed(g: THREE.BufferGeometry, p: THREE.Vector3, n: THREE.Vector3): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromUnitVectors(ZAXIS, n), new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(m);
}

const mirrorX = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  const m = g.clone();
  m.scale(-1, 1, 1);
  // Negative scale turns the faces inside out: swap the winding back.
  const idx = m.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
  } else {
    const p = m.getAttribute('position');
    const n = m.getAttribute('normal');
    for (let i = 0; i < p.count; i += 3) {
      for (const attr of [p, n]) {
        if (!attr) continue;
        const t = [attr.getX(i + 1), attr.getY(i + 1), attr.getZ(i + 1)];
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, t[0], t[1], t[2]);
      }
    }
  }
  return m;
};

/** Both sides: the part as given (right) and its mirror (left). */
function pair(bk: Bucket, g: THREE.BufferGeometry, uv?: readonly [number, number]): void {
  bk.addGeometry(g, uv);
  bk.addGeometry(mirrorX(g), uv);
}

/** Profile in side view (f, y) extruded across x0..x1. */
function extrudeX(profile: [number, number][], x0: number, x1: number, bevel = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([f, y]) => new THREE.Vector2(f, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: x1 - x0 - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // Shape x = f → world z = -f; the extrusion runs along world x.
  g.rotateY(Math.PI / 2);
  g.translate(x0 + bevel, 0, 0);
  return g;
}

/** Plan-view outline (x, f) extruded vertically from y0 to y1. */
function extrudeY(outline: [number, number][], y0: number, y1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, f]) => new THREE.Vector2(x, -f)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(Math.PI / 2); // shape y → world z, extrusion → world -y
  g.translate(0, y1, 0);
  return g;
}

function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

const box = (w: number, h: number, l: number, x: number, y: number, f: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, l).translate(x, y, -f);

function buildFront(b: Bucket[]): void {
  // Headlights: angular housings on the nose slope with two projectors each.
  const hx0 = 0.335;
  const hx1 = 0.75;
  const t = (x: number) => (x - hx0) / (hx1 - hx0);
  const hi = (x: number) => 0.703 - 0.008 * t(x);
  const lo = (x: number) => 0.614 + 0.016 * t(x) + 0.036 * Math.max(0, 1 - t(x) / 0.22);
  // Smoked housing (reads as a dark shape on the silver nose), polished projector rings.
  b[CHROME].rgb = [0.1, 0.11, 0.13];
  nosePatch(hx0, hx1, lo, hi, 14, 5, 0.004).emit(b, () => CHROME, () => [0, 0], { mirror: true, flip: true });
  b[CHROME].resetKeys();
  for (const x of [0.455, 0.655]) {
    const y = (lo(x) + hi(x)) / 2;
    const { p, n } = noseFrame(x, y, 0.009);
    b[CHROME].rgb = [0.9, 0.92, 0.95];
    pair(b[CHROME], placed(new THREE.RingGeometry(0.03, 0.041, 24), p.clone().addScaledVector(n, -0.001), n));
    b[EMIT].rgb = [3.4, 3.3, 3.05];
    pair(b[EMIT], placed(new THREE.CircleGeometry(0.03, 24), p, n));
  }
  // Turn signals at the corners under the headlights (right side; the left one is its mirror image).
  nosePatch(0.6, 0.735, () => 0.578, () => 0.596, 4, 1, 0.004).emit(b, () => IND_R, () => [0, 0], { flip: true });
  // Upper grille between the headlights.
  const gx = (x: number) => [x * 9, 0] as [number, number];
  const grille = nosePatch(0, 0.27, () => 0.622, (x) => 0.694 - 0.01 * (x / 0.27), 6, 3, 0.003);
  grille.emit(b, () => GRILLE, (i, j) => {
    const p = grille.at(i, j, [0, 0, 0]);
    return [gx(p[0])[0], p[1] * 9];
  }, { mirror: true, flip: true });

  // Bumper face: big centre intake and two side intakes (honeycomb), set just proud of the face.
  const zf = -S.F_FRONT - 0.002;
  // Outlines are given as seen from the front; turning the shape to face -z mirrors x, so pre-mirror.
  const intake = (pts: [number, number][], x: number, y: number) => {
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([px, py]) => new THREE.Vector2(-px, py))), 6);
    g.rotateY(Math.PI);
    g.translate(x, y, zf);
    const p = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) * 9, p.getY(i) * 9);
    return g;
  };
  b[GRILLE].addGeometry(intake(roundRect(0.64, 0.13, 0.035).getPoints(4).map((v) => [v.x, v.y]), 0, 0.36));
  const side: [number, number][] = [[-0.085, -0.05], [0.075, -0.055], [0.095, 0.05], [-0.085, 0.055]];
  b[GRILLE].addGeometry(intake(side, 0.5, 0.36));
  b[GRILLE].addGeometry(intake(side.map(([x, y]) => [-x, y]), -0.5, 0.36));
  // Splitter under the bumper.
  b[TRIM].addGeometry(
    extrudeY(
      [[-0.79, 2.1], [0.79, 2.1], [0.81, 2.24], [0.7, 2.338], [-0.7, 2.338], [-0.81, 2.24]],
      0.142,
      0.158,
    ),
  );
}

function buildRear(b: Bucket[]): void {
  const zr = -S.F_REAR;
  // Four round tail lamps: dark housing, polished bezel, ring lens with a darker centre.
  for (const x of [0.385, 0.6]) {
    const y = 0.785;
    const housing = new THREE.CylinderGeometry(0.076, 0.079, 0.026, 32, 1, true).rotateX(Math.PI / 2).translate(x, y, zr + 0.011);
    b[CHROME].rgb = [0.2, 0.2, 0.22];
    pair(b[CHROME], housing);
    b[CHROME].rgb = [0.95, 0.96, 0.98];
    pair(b[CHROME], new THREE.RingGeometry(0.066, 0.077, 32).translate(x, y, zr + 0.025));
    pair(b[CHROME], new THREE.RingGeometry(0.026, 0.031, 24).translate(x, y, zr + 0.0265));
    b[TAIL].rgb = [1, 1, 1];
    pair(b[TAIL], new THREE.RingGeometry(0.031, 0.066, 32).translate(x, y, zr + 0.024));
    b[TAIL].rgb = [0.5, 0.5, 0.5];
    pair(b[TAIL], new THREE.CircleGeometry(0.026, 20).translate(x, y, zr + 0.024));
  }
  // Diffuser with fins, single big exhaust on the right.
  b[TRIM].addGeometry(new THREE.BoxGeometry(1.12, 0.014, 0.3).rotateX(-0.12).translate(0, 0.3, 2.18));
  for (const x of [-0.36, -0.12, 0.12, 0.36]) b[TRIM].addGeometry(box(0.008, 0.06, 0.26, x, 0.27, -2.2));
  b[CHROME].rgb = [0.85, 0.86, 0.88];
  b[CHROME].addGeometry(new THREE.CylinderGeometry(0.052, 0.05, 0.16, 28, 1, true).rotateX(Math.PI / 2).translate(0.42, 0.3, zr - 0.03));
  b[CHROME].rgb = [0.05, 0.05, 0.05];
  b[CHROME].addGeometry(new THREE.CircleGeometry(0.048, 20).translate(0.42, 0.3, zr + 0.01));
}

function buildWing(b: Bucket[]): void {
  const deck = (f: number) => S.topY(f, 0.56) - 0.01;
  // Uprights: swept struts from the deck to the blade.
  const strut: [number, number][] = [[-1.99, deck(-1.99)], [-2.09, deck(-2.09)], [-2.13, 1.18], [-2.05, 1.18]];
  pair(b[PAINT], extrudeX(strut, 0.54, 0.575, 0.004), UV_PLAIN);
  // Blade: cambered airfoil, slight angle of attack (trailing edge up).
  const chord = 0.27;
  const lead = -1.96;
  const foil: [number, number][] = [];
  const N = 14;
  const camber = (u: number) => 1.175 + 0.022 * u + 0.012 * Math.sin(Math.PI * u);
  const thick = (u: number) => 0.07 * (1.48 * Math.sqrt(u) - 0.63 * u - 1.758 * u * u + 1.42 * u ** 3 - 0.5 * u ** 4);
  for (let k = 0; k <= N; k++) {
    const u = (1 - Math.cos((Math.PI * k) / N)) / 2;
    foil.push([lead - u * chord, camber(u) + thick(u) / 2]);
  }
  for (let k = N - 1; k > 0; k--) {
    const u = (1 - Math.cos((Math.PI * k) / N)) / 2;
    foil.push([lead - u * chord, camber(u) - thick(u) / 2]);
  }
  b[PAINT].addGeometry(extrudeX(foil, -0.7, 0.7), UV_PLAIN);
  // End plates and a gurney strip.
  const plate: [number, number][] = [[-1.94, 1.13], [-2.25, 1.12], [-2.27, 1.23], [-2.0, 1.215]];
  pair(b[PAINT], extrudeX(plate, 0.7, 0.708), UV_PLAIN);
  b[TRIM].addGeometry(box(1.4, 0.014, 0.006, 0, camber(1) + 0.012, lead - chord + 0.004));
}

function buildSides(b: Bucket[]): void {
  // Door mirrors: body-colour housing, dark glass facing back, black arm.
  const mf = 0.47;
  const housing = new THREE.ExtrudeGeometry(roundRect(0.165, 0.098, 0.035), { depth: 0.05, bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.012, bevelSegments: 3, curveSegments: 4 });
  housing.translate(0.955, 1.0, -mf - 0.025);
  pair(b[PAINT], housing, UV_PLAIN);
  const glass = new THREE.ShapeGeometry(roundRect(0.15, 0.084, 0.03), 4).translate(0.955, 1.0, -mf + 0.0395);
  b[CHROME].rgb = [0.2, 0.22, 0.25];
  pair(b[CHROME], glass);
  pair(b[TRIM], box(0.13, 0.026, 0.045, 0.82, 0.955, mf));
  // Door handles.
  b[CHROME].rgb = [0.8, 0.82, 0.85];
  const hy = 0.85;
  pair(b[CHROME], box(0.012, 0.016, 0.13, S.sideX(-0.4, hy) + 0.004, hy, -0.4));
  // Side repeaters on the front fenders (blink with the turn signals).
  const my = 0.6;
  b[IND_R].addGeometry(box(0.01, 0.022, 0.07, S.sideX(1.85, my) * S.planS(1.85) + 0.003, my, 1.85));
  // Rear turn signals: amber strips low on the tail, under the outer lamps.
  b[IND_R].addGeometry(new THREE.PlaneGeometry(0.17, 0.04).translate(0.585, 0.655, -S.F_REAR + 0.003));
  // Wipers resting at the base of the windshield.
  for (const [x0, x1] of [[-0.12, 0.58], [-0.62, 0.02]]) {
    const xm = (x0 + x1) / 2;
    const f = S.F_WS - 0.07;
    b[TRIM].addGeometry(box(x1 - x0, 0.012, 0.018, xm, S.screenY(f, xm) + 0.014, f));
  }
}

let cached: R34Geometry | null = null;

/** Exterior and cabin lining geometry, built once. */
export function r34Geometry(): R34Geometry {
  if (cached) return cached;
  const b = [new Bucket(), new Bucket(), new Bucket(true), new Bucket(true), new Bucket(true), new Bucket(), new Bucket(), new Bucket(), new Bucket()];
  buildTub(b);
  buildGreenhouse(b);
  buildFront(b);
  buildRear(b);
  buildWing(b);
  buildSides(b);
  const parts = b.map((bk) => bk.geometry());
  parts[IND_L] = mirrorX(parts[IND_R]);
  cached = { parts, lamp: new THREE.Vector3(0, 0.66, -2.2) };
  return cached;
}
