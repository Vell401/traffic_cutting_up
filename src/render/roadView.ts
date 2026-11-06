import * as THREE from 'three';
import { LANES, LANE_W, WALL_D, laneCenter } from '../config';
import { smoothstep } from '../core/math';
import { mulberry32, range, type Rng } from '../core/rng';
import { CHUNK_LEN, GROUND_LEVEL, SAMPLE_DS, type LightKind, type Road, type RoadChunk, type RoadPoint } from '../sim/road';
import { makeCityMaterial } from './city';
import {
  ChunkFrames,
  FACE_NO_BOTTOM,
  type Frame,
  MeshBuilder,
  ROWS,
  box,
  cone,
  flatQuad,
  signQuad,
  strip,
} from './meshBuilder';
import type { QualityPreset } from '../settings';
import { HIGHWAY_SIGNS, ROAD_TEX_PERIOD, SIGN_COLS, SIGN_ROWS, TUNNEL_SIGN, makeRadialTexture, makeRoadTexture, makeSignAtlas } from './textures';

/*
 * Each 100 m road chunk is drawn with up to six merged meshes (road, structures, glowing bits,
 * light pools, city, signs). What goes in depends on the chunk's section: open highway, noise
 * walls, viaduct or tunnel, plus gantries and overpasses. Views are pooled and rewritten in place;
 * vertices are chunk-local and the group sits relative to the floating origin.
 */

export const LIGHT_COLOR: Record<LightKind, THREE.Color> = {
  sodium: new THREE.Color(1.0, 0.6, 0.28),
  led: new THREE.Color(0.8, 0.9, 1.0),
};

/** Light pool strength per lamp type: LED is whiter and reads brighter on asphalt. */
const POOL_K: Record<LightKind, number> = { sodium: 0.8, led: 0.42 };

/**
 * Height of light decals above the asphalt. With the 0.5 m near plane the depth buffer still separates
 * 6 cm at ~600 m, so far decals no longer z-fight with the road (that flicker read as ripples).
 */
const DECAL_Y = 0.06;
/** Ambient shade of the road and barriers deep inside a tunnel. */
const TUNNEL_SHADE = 0.45;

/** Outer edge of the barrier / viaduct deck. */
const EDGE = WALL_D + 0.55;
const GROUND_OUT = 420;
const DECK_DEPTH = 1.6;
/** Bridge box girder is deeper than the viaduct slab. */
const BRIDGE_DECK = 2.6;
const PYLON_D = WALL_D + 0.55 + 1.6;
const PYLON_TOP = 48;
const POLE_D = WALL_D + 0.25;
const POLE_H = 9.2;
const ARM_LEN = 2.6;
const HEAD_D = POLE_D - ARM_LEN + 0.15;
const POOL_R = 9;
const LAMP_STEP = 25;
const TUNNEL_H = 6.9;
const TUNNEL_WALL = WALL_D + 0.2;
const TUNNEL_LIGHT_STEP = 6;
const PANEL_D = WALL_D + 0.4;
/** Tunnel safety kit spacing (absolute s, so it is continuous across chunks). */
const EXIT_STEP = 250;
const NICHE_STEP = 125;
const FAN_STEP = 200;
const LANE_SIGNAL_STEP = 300;
/** Nothing of the kit closer than this to a portal. */
const KIT_PORTAL_GAP = 30;
/** Painted band on the tunnel walls, picked per tunnel (null = bare concrete). */
const TUNNEL_STRIPES: (THREE.Color | null)[] = [
  null,
  new THREE.Color(0.08, 0.2, 0.55),
  new THREE.Color(0.07, 0.3, 0.14),
  new THREE.Color(0.55, 0.24, 0.05),
  new THREE.Color(0.5, 0.07, 0.05),
];

/** Jersey barrier cross-section (offset beyond WALL_D, height). */
const PROFILE: [number, number][] = [
  [0, 0],
  [0.08, 0.32],
  [0.18, 0.95],
  [0.45, 0.95],
  [0.55, 0],
];

const COL = {
  barrier: new THREE.Color(0x85888d),
  barrierTop: new THREE.Color(0x9a9da2),
  concrete: new THREE.Color(0x6c6f74),
  ground: new THREE.Color(0x0a0c0f),
  steel: new THREE.Color(0x5f636a),
  panel: new THREE.Color(0x26302f),
  panelTop: new THREE.Color(0x3b4b52),
  tree: new THREE.Color(0x0b1510),
  tunnelWall: new THREE.Color(0.34, 0.33, 0.31),
  tunnelWallLow: new THREE.Color(0.13, 0.13, 0.12),
  tunnelCeil: new THREE.Color(0.045, 0.045, 0.05),
  reflectorR: new THREE.Color(1.3, 1.25, 1.1),
  reflectorL: new THREE.Color(1.5, 0.85, 0.25),
  pylon: new THREE.Color(0x9a9ea5),
  uplight: new THREE.Color(1.5, 1.65, 1.9),
  cable: new THREE.Color(0.75, 0.85, 1.05),
  necklace: new THREE.Color(1.4, 1.5, 1.8),
  aviation: new THREE.Color(4, 0.2, 0.1),
  roadEnd: new THREE.Color(3, 1.4, 0.1),
  hull: new THREE.Color(0x9ea4ad),
  deck: new THREE.Color(0x5a4a3a),
  cabin: new THREE.Color(0x2a2e35),
  yacht: new THREE.Color(0xc4c9d0),
  boatWindow: new THREE.Color(1.8, 1.35, 0.8),
  boatDeck: new THREE.Color(1.3, 1.35, 1.45),
  navRed: new THREE.Color(4, 0.2, 0.15),
  navGreen: new THREE.Color(0.2, 4, 0.5),
  emergency: new THREE.Color(0.2, 1.4, 0.5),
  exitFrame: new THREE.Color(0.25, 2.4, 0.8),
  exitDoor: new THREE.Color(0.07, 0.16, 0.1),
  recess: new THREE.Color(0.02, 0.022, 0.025),
  sosCabinet: new THREE.Color(2.2, 0.8, 0.12),
  sosLamp: new THREE.Color(0.35, 0.7, 3.2),
  fireCabinet: new THREE.Color(2.2, 0.12, 0.08),
  fan: new THREE.Color(0.075, 0.078, 0.085),
  fanFace: new THREE.Color(0.02, 0.02, 0.022),
  ledLine: new THREE.Color(0.3, 1.1, 2.4),
  white: new THREE.Color(1, 1, 1),
};

/** UV rectangle of a sign atlas cell; `inset` keeps only the middle part horizontally. */
function cellUV(cell: number, inset = 0): [number, number, number, number] {
  const col = cell % SIGN_COLS;
  const row = Math.floor(cell / SIGN_COLS);
  return [(col + inset) / SIGN_COLS, 1 - (row + 1) / SIGN_ROWS, (col + 1 - inset) / SIGN_COLS, 1 - row / SIGN_ROWS];
}

/**
 * Cylinder lying along the road at frame f (jet fans): `sides` faces plus the cap that faces oncoming
 * traffic. Shaded by hand for the unlit glow material: lighter on top, darker underneath.
 */
function tube(mb: MeshBuilder, f: Frame, d: number, y: number, r: number, half: number, body: THREE.Color, face: THREE.Color, sides = 10): void {
  const rx = Math.cos(f.th);
  const rz = Math.sin(f.th);
  const fx = Math.sin(f.th);
  const fz = -Math.cos(f.th);
  const cx = f.x + rx * d;
  const cz = f.z + rz * d;
  const p = [0, 0, 0];
  const ring = (a: number, along: number) => {
    const ca = Math.cos(a) * r;
    p[0] = cx + rx * ca + fx * along;
    p[1] = y + Math.sin(a) * r;
    p[2] = cz + rz * ca + fz * along;
  };
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const nx = rx * Math.cos(am);
    const ny = Math.sin(am);
    const nz = rz * Math.cos(am);
    mb.color(body, 0.55 + 0.45 * ny);
    ring(a0, -half);
    const a = mb.v(p[0], p[1], p[2], nx, ny, nz);
    ring(a0, half);
    const b = mb.v(p[0], p[1], p[2], nx, ny, nz);
    ring(a1, half);
    const c = mb.v(p[0], p[1], p[2], nx, ny, nz);
    ring(a1, -half);
    const e = mb.v(p[0], p[1], p[2], nx, ny, nz);
    mb.quad(a, b, c, e);
    // Front cap (normal = -forward): a dark grille.
    mb.color(face);
    const o = mb.v(cx - fx * half, y, cz - fz * half, -fx, 0, -fz);
    ring(a0, -half);
    const q0 = mb.v(p[0], p[1], p[2], -fx, 0, -fz);
    ring(a1, -half);
    const q1 = mb.v(p[0], p[1], p[2], -fx, 0, -fz);
    mb.tri(o, q0, q1);
  }
}

/**
 * Vertical prism over a polygon footprint (boat hulls): pts are [across, along] in a frame at (cx, cz)
 * heading th. Sides get `side`, the top `top`; no bottom. Faces are oriented outward whatever the
 * polygon's winding.
 */
function prism(mb: MeshBuilder, cx: number, cz: number, th: number, pts: [number, number][], y0: number, y1: number, side: THREE.Color, top: THREE.Color): void {
  const rx = Math.cos(th);
  const rz = Math.sin(th);
  const fx = Math.sin(th);
  const fz = -Math.cos(th);
  const n = pts.length;
  const X = (p: [number, number]) => cx + rx * p[0] + fx * p[1];
  const Z = (p: [number, number]) => cz + rz * p[0] + fz * p[1];
  let mx = 0;
  let mz = 0;
  for (const p of pts) {
    mx += X(p) / n;
    mz += Z(p) / n;
  }
  mb.color(side);
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % n];
    const ax = X(p);
    const az = Z(p);
    const bx = X(q);
    const bz = Z(q);
    // Edge × up = (-ez, 0, ex): outward when it points away from the centroid.
    let nx = -(bz - az);
    let nz = bx - ax;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const out = nx * ((ax + bx) / 2 - mx) + nz * ((az + bz) / 2 - mz) > 0;
    if (!out) {
      nx = -nx;
      nz = -nz;
    }
    const a0 = mb.v(ax, y0, az, nx, 0, nz);
    const b0 = mb.v(bx, y0, bz, nx, 0, nz);
    const b1 = mb.v(bx, y1, bz, nx, 0, nz);
    const a1 = mb.v(ax, y1, az, nx, 0, nz);
    if (out) mb.quad(a0, b0, b1, a1);
    else mb.quad(b0, a0, a1, b1);
  }
  mb.color(top);
  const c = mb.v(mx, y1, mz, 0, 1, 0);
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % n];
    const a = mb.v(X(p), y1, Z(p), 0, 1, 0);
    const b = mb.v(X(q), y1, Z(q), 0, 1, 0);
    // (a - c) × (b - c) must point up for a front face.
    const up = (Z(p) - mz) * (X(q) - mx) - (X(p) - mx) * (Z(q) - mz) > 0;
    if (up) mb.tri(c, a, b);
    else mb.tri(c, b, a);
  }
}

/** Thin lit cable from a to b: two crossed double-sided ribbons, visible from any angle. */
function cable(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number): void {
  let dx = bx - ax;
  let dy = by - ay;
  let dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  // p1 = dir × up (horizontal), p2 = dir × p1.
  let p1x = -dz;
  let p1z = dx;
  const l1 = Math.hypot(p1x, p1z) || 1;
  p1x /= l1;
  p1z /= l1;
  const p2x = dy * p1z;
  const p2y = dz * p1x - dx * p1z;
  const p2z = -dy * p1x;
  for (const [ux, uy, uz] of [
    [p1x * w, 0, p1z * w],
    [p2x * w, p2y * w, p2z * w],
  ]) {
    const a = mb.v(ax - ux, ay - uy, az - uz, 0, 1, 0);
    const b = mb.v(ax + ux, ay + uy, az + uz, 0, 1, 0);
    const c = mb.v(bx + ux, by + uy, bz + uz, 0, 1, 0);
    const d = mb.v(bx - ux, by - uy, bz - uz, 0, 1, 0);
    mb.quad(a, b, c, d);
    mb.quad(a, d, c, b);
  }
}

export interface LampAnchor {
  s: number;
  d: number;
  y: number;
  spacing: number;
  color: THREE.Color;
}

interface RoadMaterials {
  road: THREE.Material;
  struct: THREE.Material;
  glow: THREE.Material;
  pools: THREE.Material;
  city: THREE.Material;
  signs: THREE.Material;
  water: THREE.Material;
}

const tmpColor = new THREE.Color();

class ChunkView {
  readonly group = new THREE.Group();
  index = -1;
  x0 = 0;
  z0 = 0;
  readonly anchors: LampAnchor[] = [];
  anchorCount = 0;

  private readonly fr = new ChunkFrames();
  private readonly f: Frame = { x: 0, z: 0, th: 0 };
  private readonly f2: Frame = { x: 0, z: 0, th: 0 };
  private readonly gy = new Float64Array(ROWS);
  private readonly faceY = new Float64Array(ROWS);
  private readonly roofY = new Float64Array(ROWS);
  /** Per-row ambient shade of road and barriers: 1 outside, darker inside tunnels, ramped across portals. */
  private readonly shadeRows = new Float64Array(ROWS);
  private readonly road = new MeshBuilder({ maxVerts: ROWS * 2, maxIndices: (ROWS - 1) * 6, uv: true });
  private readonly struct = new MeshBuilder({ maxVerts: 9000, maxIndices: 16000 });
  private readonly glow = new MeshBuilder({ maxVerts: 6000, maxIndices: 9000 });
  private readonly pools = new MeshBuilder({ maxVerts: 400, maxIndices: 600, uv: true });
  private readonly city = new MeshBuilder({ maxVerts: 3000, maxIndices: 4500, win: true });
  private readonly signs = new MeshBuilder({ maxVerts: 160, maxIndices: 240, uv: true });
  private readonly water = new MeshBuilder({ maxVerts: ROWS * 6, maxIndices: (ROWS - 1) * 18 });
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly pairs: [MeshBuilder, THREE.Mesh][];
  private c!: RoadChunk;
  private roadRef!: Road;
  private rng: Rng = Math.random;

  constructor(m: RoadMaterials) {
    const mk = (b: MeshBuilder, mat: THREE.Material, order = 0): [MeshBuilder, THREE.Mesh] => {
      const mesh = new THREE.Mesh(b.geometry, mat);
      mesh.renderOrder = order;
      this.group.add(mesh);
      return [b, mesh];
    };
    this.pairs = [
      mk(this.road, m.road),
      mk(this.struct, m.struct),
      mk(this.glow, m.glow),
      mk(this.city, m.city),
      mk(this.signs, m.signs),
      mk(this.water, m.water),
      mk(this.pools, m.pools, 1),
    ];
    for (let i = 0; i < 48; i++) this.anchors.push({ s: 0, d: 0, y: 0, spacing: 1, color: COL.white });
  }

  build(c: RoadChunk, road: Road): void {
    this.c = c;
    this.roadRef = road;
    this.index = c.index;
    this.x0 = c.x[0];
    this.z0 = c.z[0];
    this.fr.set(c);
    this.rng = mulberry32(c.seed);
    this.anchorCount = 0;
    for (const [b] of this.pairs) b.reset();
    if (c.void) {
      // Past the end of a finite showcase track: nothing to draw.
      for (const [b, mesh] of this.pairs) {
        b.finish();
        mesh.visible = false;
      }
      return;
    }
    for (let i = 0; i < ROWS; i++) {
      this.gy[i] = road.groundY(c.s0 + i * SAMPLE_DS);
      this.shadeRows[i] = this.shade(i * SAMPLE_DS);
    }

    this.buildRoad();
    this.buildBarriers();
    this.buildSides();
    switch (c.kind) {
      case 'tunnel':
        this.buildTunnel();
        break;
      case 'walls':
        this.buildNoiseWalls();
        this.buildLamps();
        break;
      case 'viaduct':
        this.buildViaduct();
        this.buildLamps();
        break;
      case 'bridge':
        this.buildBridge();
        this.buildLamps();
        break;
      default:
        this.buildLamps();
        this.buildTrees();
    }
    if (c.kind !== 'tunnel') this.buildReflectors();
    if (c.gantry) this.buildGantry();
    if (c.overpass) this.buildOverpass();
    if (c.kind !== 'tunnel') this.buildCity();
    if (c.s0 + CHUNK_LEN === road.endS) this.buildRoadEnd();

    for (const [b, mesh] of this.pairs) {
      b.finish();
      mesh.visible = !b.empty;
    }
  }

  private at(s: number): Frame {
    return this.fr.at(s, this.f);
  }

  /** Frame shifted along the road from `f` (used for parts in front of / behind a structure). */
  private shift(f: Frame, along: number): Frame {
    const o = this.f2;
    o.x = f.x + Math.sin(f.th) * along;
    o.z = f.z - Math.cos(f.th) * along;
    o.th = f.th;
    return o;
  }

  private anchor(s: number, d: number, y: number, spacing: number, color: THREE.Color): void {
    if (this.anchorCount >= this.anchors.length) return;
    const a = this.anchors[this.anchorCount++];
    a.s = s;
    a.d = d;
    a.y = y;
    a.spacing = spacing;
    a.color = color;
  }

  /** Absolute positions s = k·step that fall inside this chunk, as local offsets. */
  private *every(step: number, phase = 0): Generator<[number, number]> {
    const s0 = this.c.s0;
    let k = Math.ceil((s0 - phase) / step);
    for (let s = k * step + phase; s < s0 + CHUNK_LEN; s = ++k * step + phase) yield [s - s0, k];
  }

  /**
   * Ambient shade at chunk-local s. Instead of switching at the chunk boundary (a hard line on the
   * asphalt right at the portal) it ramps from 12 m before a tunnel mouth to 22 m inside, both ways.
   */
  private shade(sLocal: number): number {
    const c = this.c;
    // x = metres from the portal into the tunnel (negative = still outside).
    const ramp = (x: number) => 1 + (TUNNEL_SHADE - 1) * smoothstep((x + 12) / 34);
    if (c.kind === 'tunnel') {
      let v = TUNNEL_SHADE;
      if (c.prevKind !== 'tunnel') v = Math.max(v, ramp(sLocal));
      if (c.nextKind !== 'tunnel') v = Math.max(v, ramp(CHUNK_LEN - sLocal));
      return v;
    }
    let v = 1;
    if (c.nextKind === 'tunnel') v = Math.min(v, ramp(sLocal - CHUNK_LEN));
    if (c.prevKind === 'tunnel') v = Math.min(v, ramp(-sLocal));
    return v;
  }

  /** Metres from the nearest open portal into this tunnel chunk (Infinity if none). */
  private intoTunnel(sLocal: number): number {
    const c = this.c;
    let x = Infinity;
    if (c.prevKind !== 'tunnel') x = sLocal;
    if (c.nextKind !== 'tunnel') x = Math.min(x, CHUNK_LEN - sLocal);
    return x;
  }

  private buildRoad(): void {
    const mb = this.road;
    const fr = this.fr;
    const u0 = (-EDGE + WALL_D) / (2 * WALL_D);
    const u1 = (EDGE + WALL_D) / (2 * WALL_D);
    let pa = -1;
    let pb = -1;
    for (let i = 0; i < ROWS; i++) {
      const v = (i * SAMPLE_DS) / ROAD_TEX_PERIOD;
      const cs = fr.cs[i];
      const sn = fr.sn[i];
      const k = this.shadeRows[i];
      mb.rgb(k, k, k);
      const a = mb.v(fr.bx[i] - cs * EDGE, 0, fr.bz[i] - sn * EDGE, 0, 1, 0, u0, v);
      const b = mb.v(fr.bx[i] + cs * EDGE, 0, fr.bz[i] + sn * EDGE, 0, 1, 0, u1, v);
      if (i > 0) mb.quad(pa, pb, b, a);
      pa = a;
      pb = b;
    }
  }

  private buildBarriers(): void {
    const mb = this.struct;
    for (let j = 0; j < PROFILE.length - 1; j++) {
      const [d0, y0] = PROFILE[j];
      const [d1, y1] = PROFILE[j + 1];
      mb.color(y0 > 0 && y0 === y1 ? COL.barrierTop : COL.barrier);
      strip(mb, this.fr, WALL_D + d0, y0, WALL_D + d1, y1, undefined, undefined, 1, this.shadeRows);
      strip(mb, this.fr, -(WALL_D + d1), y1, -(WALL_D + d0), y0, undefined, undefined, 1, this.shadeRows);
    }
  }

  /** Terrain beside the road plus the faces joining it to the deck: retaining walls up, deck slab down. */
  private buildSides(): void {
    const mb = this.struct;
    const gy = this.gy;
    const bridge = this.c.kind === 'bridge';
    const deck = bridge ? BRIDGE_DECK : DECK_DEPTH;
    let face = false;
    for (let i = 0; i < ROWS; i++) {
      const y = gy[i];
      this.faceY[i] = y < 0 ? Math.max(y, -deck) : y;
      if (Math.abs(this.faceY[i]) > 0.01) face = true;
    }
    if (face) {
      mb.color(COL.concrete);
      strip(mb, this.fr, EDGE, 0, EDGE, this.faceY);
      strip(mb, this.fr, -EDGE, this.faceY, -EDGE, 0);
    }
    // Under a bridge the "ground" is open water with its own glossy material.
    const ground = bridge ? this.water.color(COL.white) : mb.color(COL.ground);
    strip(ground, this.fr, EDGE, gy, GROUND_OUT, gy);
    strip(ground, this.fr, -GROUND_OUT, gy, -EDGE, gy);
    if (bridge) strip(ground, this.fr, -EDGE, gy, EDGE, gy);

    if (gy.some((y) => y < -deck)) {
      mb.color(COL.concrete, 0.6);
      strip(mb, this.fr, EDGE, -deck, -EDGE, -deck);
    }
  }

  /** Railing, necklace lights and, at two points of the span, the cable-stayed pylons. */
  private buildBridge(): void {
    const c = this.c;
    const fr = this.fr;
    const mb = this.struct;
    mb.color(COL.steel);
    strip(mb, fr, WALL_D + 0.31, 1.2, WALL_D + 0.31, 1.3);
    strip(mb, fr, -(WALL_D + 0.31), 1.3, -(WALL_D + 0.31), 1.2);
    for (const [s] of this.every(5)) {
      const f = this.at(s);
      box(mb, f, WALL_D + 0.31, 1.1, 0.03, 0.18, 0.03);
      box(mb, f, -(WALL_D + 0.31), 1.1, 0.03, 0.18, 0.03);
    }
    this.glow.color(COL.necklace);
    for (const [s] of this.every(8)) {
      const f = this.at(s);
      box(this.glow, f, EDGE + 0.03, 0.85, 0.04, 0.06, 0.12);
      box(this.glow, f, -(EDGE + 0.03), 0.85, 0.04, 0.06, 0.12);
    }
    if (c.sectionLen >= 6 && (c.sectionIndex === 2 || c.sectionIndex === c.sectionLen - 3)) this.pylon(50);
  }

  /** H-shaped pylon from the water to ~48 m above the deck, uplit, with fans of lit stay cables. */
  private pylon(sLocal: number): void {
    const c = this.c;
    const mb = this.struct;
    const g = this.glow;
    const f0 = this.at(sLocal);
    const f: Frame = { x: f0.x, z: f0.z, th: f0.th };
    const base = GROUND_LEVEL.bridge;
    mb.color(COL.pylon);
    for (const side of [-1, 1]) {
      box(mb, f, side * PYLON_D, base / 2, 1.5, -base / 2, 2.2, 0, 0b110111);
      box(mb, f, side * PYLON_D, PYLON_TOP / 2, 1.0, PYLON_TOP / 2, 1.5);
      box(mb, f, side * PYLON_D, PYLON_TOP + 1, 1.2, 1, 1.7);
      g.color(COL.uplight);
      box(g, f, side * (PYLON_D - 1.03), PYLON_TOP / 2 + 1, 0.04, PYLON_TOP / 2 - 2, 0.25);
      box(g, f, side * (PYLON_D + 1.03), PYLON_TOP / 2 + 1, 0.04, PYLON_TOP / 2 - 2, 0.25);
      g.color(COL.aviation);
      box(g, f, side * PYLON_D, PYLON_TOP + 2.2, 0.25, 0.15, 0.25);
      // Reflection of the uplights on the water, stretched toward the approaching driver.
      this.pools.color(COL.uplight, 0.18);
      flatQuad(this.pools, this.shift(f, -40), side * PYLON_D, base + 0.08, 1.6, 40);
    }
    mb.color(COL.pylon, 0.9);
    box(mb, f, 0, 17, PYLON_D + 1, 1, 1.2);
    box(mb, f, 0, 41, PYLON_D + 0.8, 1.2, 1.2);
    box(mb, f, 0, -BRIDGE_DECK - 0.8, PYLON_D + 1.4, 0.8, 1.6);

    // Stay cables: the highest anchor on the pylon goes to the farthest deck anchor.
    g.color(COL.cable);
    const rx = Math.cos(f.th);
    const rz = Math.sin(f.th);
    for (const side of [-1, 1]) {
      const px = f.x + rx * side * (PYLON_D - 0.4);
      const pz = f.z + rz * side * (PYLON_D - 0.4);
      for (const dir of [-1, 1]) {
        for (let k = 0; k < 6; k++) {
          const sAbs = c.s0 + sLocal + dir * (24 + k * 20);
          this.roadRef.toWorld(sAbs, side * (EDGE - 0.35), this.pt);
          cable(g, px, 30 + k * 3, pz, this.pt.x - this.x0, 1.3, this.pt.z - this.z0, 0.07);
        }
      }
    }
  }

  /** Concrete blocks with amber lamps across the road where a showcase track ends. */
  private buildRoadEnd(): void {
    const f = this.at(CHUNK_LEN - 4);
    this.struct.color(COL.concrete);
    for (let d = -WALL_D + 0.7; d <= WALL_D - 0.6; d += 1.35) {
      box(this.struct, f, d, 0.45, 0.6, 0.45, 0.35);
      this.glow.color(COL.roadEnd);
      box(this.glow, f, d, 1.0, 0.12, 0.1, 0.12);
    }
  }

  private buildLamps(): void {
    const light = LIGHT_COLOR[this.c.light];
    for (const [s, k] of this.every(LAMP_STEP)) {
      const side = k % 2 === 0 ? 1 : -1;
      const f = this.at(s);
      this.struct.color(COL.steel);
      box(this.struct, f, side * POLE_D, POLE_H / 2, 0.11, POLE_H / 2, 0.11);
      box(this.struct, f, side * (POLE_D - ARM_LEN / 2), POLE_H - 0.1, ARM_LEN / 2, 0.06, 0.07);
      this.glow.color(light, 2.4);
      box(this.glow, f, side * HEAD_D, POLE_H - 0.22, 0.38, 0.06, 0.17);
      this.pools.color(light, POOL_K[this.c.light]);
      flatQuad(this.pools, f, side * HEAD_D, DECAL_Y, POOL_R, POOL_R);
      this.anchor(this.c.s0 + s, side * HEAD_D, POLE_H - 0.5, LAMP_STEP, light);
    }
  }

  private buildReflectors(): void {
    for (const [s] of this.every(12)) {
      const f = this.at(s);
      this.glow.color(COL.reflectorR);
      box(this.glow, f, WALL_D + 0.31, 1.02, 0.08, 0.045, 0.03);
      this.glow.color(COL.reflectorL);
      box(this.glow, f, -(WALL_D + 0.31), 1.02, 0.08, 0.045, 0.03);
    }
  }

  private buildTunnel(): void {
    const c = this.c;
    const light = LIGHT_COLOR[c.light];
    const fr = this.fr;
    const g = this.glow;
    const wall = tmpColor.copy(COL.tunnelWall).multiply(light);
    const low = COL.tunnelWallLow.clone().multiply(light);
    const ceil = COL.tunnelCeil;
    const TW = TUNNEL_WALL;
    const HX = TW - 1.3;
    // Baked lighting: unlit vertex-coloured shell, brighter toward the light rows.
    strip(g, fr, TW, 0.95, TW, 5.4, low, wall);
    strip(g, fr, TW, 5.4, HX, TUNNEL_H, wall, ceil);
    strip(g, fr, -TW, 5.4, -TW, 0.95, wall, low);
    strip(g, fr, -HX, TUNNEL_H, -TW, 5.4, ceil, wall);
    strip(g, fr, HX, TUNNEL_H, -HX, TUNNEL_H, ceil, ceil);

    // Light on the asphalt: one continuous soft band under each light row. Separate pools every 6 m
    // summed into a high-frequency striped pattern that shimmered at speed.
    for (const d of [-LANE_W, LANE_W]) {
      this.pools.color(light, POOL_K[c.light] * 0.55);
      this.glowBand(d, 4.2);
    }
    for (const [s, k] of this.every(TUNNEL_LIGHT_STEP)) {
      const f = this.at(s);
      for (const d of [-LANE_W, LANE_W]) {
        g.color(light, 3);
        box(g, f, d, TUNNEL_H - 0.08, 0.16, 0.05, 0.7);
      }
      if (k % 2 === 0) this.anchor(c.s0 + s, 0, TUNNEL_H - 0.4, TUNNEL_LIGHT_STEP * 2, light);
    }
    for (const [s, k] of this.every(12)) {
      const f = this.at(s);
      g.color(COL.reflectorR);
      box(g, f, TW - 0.03, 1.15, 0.03, 0.05, 0.12);
      g.color(COL.reflectorL);
      box(g, f, -(TW - 0.03), 1.15, 0.03, 0.05, 0.12);
      if (k % 4 === 0) {
        g.color(COL.emergency);
        box(g, f, TW - 0.04, 2.3, 0.04, 0.18, 0.3);
      }
    }

    this.buildTunnelKit();

    // Hill over the tunnel and the portal facades.
    for (let i = 0; i < ROWS; i++) this.roofY[i] = Math.max(this.gy[i], TUNNEL_H + 0.4);
    this.struct.color(COL.ground);
    strip(this.struct, fr, -EDGE, this.roofY, EDGE, this.roofY);
    this.struct.color(COL.concrete);
    if (c.prevKind !== 'tunnel') this.portal(0.8);
    if (c.nextKind !== 'tunnel') this.portal(CHUNK_LEN - 0.8);
  }

  /**
   * Tunnel safety kit so tunnels don't all look the same: emergency exits with lit doors and EXIT
   * signs, SOS / fire niches, jet fans, lane control signals, and per-tunnel wall paint and LED lines.
   */
  private buildTunnelKit(): void {
    const c = this.c;
    const g = this.glow;
    const fr = this.fr;
    const TW = TUNNEL_WALL;
    const clear = (s: number) => this.intoTunnel(s) > KIT_PORTAL_GAP;

    // Per-tunnel look, seeded by where the section starts so every chunk of it agrees.
    const look = mulberry32(Math.imul(Math.round(c.s0 - c.sectionIndex * CHUNK_LEN), 0x9e3779b1));
    const paint = TUNNEL_STRIPES[Math.floor(look() * TUNNEL_STRIPES.length)];
    // Paint is lit by the tunnel lamps like the wall around it (sodium turns it muddy, LED keeps it clean).
    const stripe = paint && paint.clone().multiply(LIGHT_COLOR[c.light]).multiplyScalar(0.6);
    const led = look() < 0.5;
    for (const side of [-1, 1]) {
      // Strips are one-sided: list the lower edge first on the right wall, the upper one on the left.
      const d = side * (TW - 0.01);
      const band = (lo: number, hi: number, col: THREE.Color) =>
        side > 0 ? strip(g, fr, d, lo, d, hi, col, col) : strip(g, fr, d, hi, d, lo, col, col);
      if (stripe) band(1.45, 1.95, stripe);
      if (led) band(1.0, 1.07, COL.ledLine);
    }

    for (const [s, k] of this.every(EXIT_STEP, 120)) if (clear(s)) this.exitDoor(s, k % 2 === 0 ? 1 : -1);
    for (const [s, k] of this.every(NICHE_STEP, 55)) if (clear(s)) this.niche(s, k % 2 === 0);
    for (const [s] of this.every(FAN_STEP, 70)) {
      if (!clear(s)) continue;
      const f = this.at(s);
      for (const d of [-6.4, 6.4]) {
        g.color(COL.fan, 0.8);
        box(g, f, d, TUNNEL_H - 0.18, 0.08, 0.18, 0.9);
        tube(g, f, d, TUNNEL_H - 0.95, 0.6, 2.1, COL.fan, COL.fanFace);
      }
    }
    for (const [s] of this.every(LANE_SIGNAL_STEP, 180)) {
      if (!clear(s)) continue;
      const f = this.at(s);
      const [u0, v0, u1, v1] = cellUV(TUNNEL_SIGN.lane, 0.25);
      for (let l = 0; l < LANES; l++) {
        const d = laneCenter(l);
        g.color(COL.recess);
        box(g, f, d, TUNNEL_H - 0.75, 0.5, 0.5, 0.15);
        box(g, f, d, TUNNEL_H - 0.12, 0.05, 0.12, 0.05);
        this.signs.rgb(1.9, 1.9, 1.9);
        signQuad(this.signs, this.shift(f, -0.17), d, TUNNEL_H - 0.75, 0.42, 0.42, u0, v0, u1, v1);
      }
    }
  }

  /** Lit sign board sticking out of the tunnel wall, facing oncoming traffic. */
  private wallSign(s: number, side: number, cell: number): void {
    const f = this.at(s);
    const d = side * (TUNNEL_WALL - 0.95);
    this.glow.color(COL.recess);
    box(this.glow, f, side * (TUNNEL_WALL - 0.5), 4.78, 0.5, 0.03, 0.03);
    box(this.glow, this.shift(f, 0.03), d, 4.3, 0.78, 0.4, 0.025);
    const [u0, v0, u1, v1] = cellUV(cell);
    this.signs.rgb(2, 2, 2);
    signQuad(this.signs, this.shift(f, -0.01), d, 4.3, 0.75, 0.375, u0, v0, u1, v1);
  }

  /** Emergency exit: dark recess, green-lit door frame, guide lights in the barrier and an EXIT sign. */
  private exitDoor(s: number, side: number): void {
    const g = this.glow;
    const f = this.at(s);
    const TW = TUNNEL_WALL;
    g.color(COL.recess);
    box(g, f, side * (TW - 0.02), 2.2, 0.03, 1.25, 0.95);
    g.color(COL.exitDoor);
    box(g, f, side * (TW - 0.05), 2.05, 0.02, 1.05, 0.7);
    g.color(COL.exitFrame);
    box(g, f, side * (TW - 0.06), 3.22, 0.03, 0.05, 0.85);
    for (const off of [-0.82, 0.82]) box(g, this.shift(f, off), side * (TW - 0.06), 2.1, 0.03, 1.15, 0.04);
    g.color(COL.exitFrame, 1.4);
    box(g, f, side * (TW - 0.06), 3.62, 0.03, 0.2, 0.6);
    // Evacuation guide lights on the barrier top leading to the door.
    g.color(COL.emergency, 1.6);
    for (let a = -18; a <= 18; a += 3) {
      if (Math.abs(a) < 2) continue;
      box(g, this.shift(f, a), side * (WALL_D + 0.3), 0.97, 0.05, 0.03, 0.12);
    }
    this.pools.color(COL.emergency, 0.35);
    flatQuad(this.pools, f, side * (WALL_D - 0.6), DECAL_Y, 2.4, 3);
    if (s >= 6) this.wallSign(s - 6, side, TUNNEL_SIGN.exit);
  }

  /** Emergency phone (SOS) or fire extinguisher niche on the right wall. */
  private niche(s: number, sos: boolean): void {
    const g = this.glow;
    const f = this.at(s);
    const TW = TUNNEL_WALL;
    g.color(COL.recess);
    box(g, f, TW - 0.02, 2.0, 0.03, 1.05, 0.8);
    g.color(sos ? COL.sosCabinet : COL.fireCabinet);
    box(g, f, TW - 0.06, 1.75, 0.04, 0.42, 0.34);
    g.color(sos ? COL.sosLamp : COL.fireCabinet, 1.3);
    box(g, f, TW - 0.06, 3.25, 0.05, 0.08, 0.08);
    this.pools.color(sos ? COL.sosCabinet : COL.fireCabinet, 0.12);
    flatQuad(this.pools, f, WALL_D - 0.6, DECAL_Y, 2, 2.4);
    if (s >= 5) this.wallSign(s - 5, 1, sos ? TUNNEL_SIGN.sos : TUNNEL_SIGN.fire);
  }

  /** Soft light band along the chunk at offset d: the radial texture's middle row gives the falloff across. */
  private glowBand(d: number, halfW: number): void {
    const mb = this.pools;
    const fr = this.fr;
    const r0 = mb.r;
    const g0 = mb.g;
    const b0 = mb.b;
    let pa = -1;
    let pb = -1;
    for (let i = 0; i < ROWS; i++) {
      const cs = fr.cs[i];
      const sn = fr.sn[i];
      // Fade the band in over the first metres past a portal so the lit asphalt has no hard edge.
      const k = smoothstep(this.intoTunnel(i * SAMPLE_DS) / 10);
      mb.rgb(r0 * k, g0 * k, b0 * k);
      const a = mb.v(fr.bx[i] + cs * (d - halfW), DECAL_Y, fr.bz[i] + sn * (d - halfW), 0, 1, 0, 0, 0.5);
      const b = mb.v(fr.bx[i] + cs * (d + halfW), DECAL_Y, fr.bz[i] + sn * (d + halfW), 0, 1, 0, 1, 0.5);
      if (i > 0) mb.quad(pa, pb, b, a);
      pa = a;
      pb = b;
    }
    mb.rgb(r0, g0, b0);
  }

  private portal(s: number): void {
    const f = this.at(s);
    const mb = this.struct;
    const TW = TUNNEL_WALL;
    box(mb, f, TW + 4.5, 6.75, 4.5, 6.75, 0.8);
    box(mb, f, -(TW + 4.5), 6.75, 4.5, 6.75, 0.8);
    box(mb, f, 0, (TUNNEL_H + 13.5) / 2, TW + 0.01, (13.5 - TUNNEL_H) / 2, 0.8);
  }

  private buildNoiseWalls(): void {
    const mb = this.struct;
    const fr = this.fr;
    const P = PANEL_D;
    mb.color(COL.panel);
    strip(mb, fr, P, 0.95, P, 3.9);
    strip(mb, fr, -P, 3.9, -P, 0.95);
    strip(mb, fr, P + 0.06, 5.3, P + 0.06, 0.95);
    strip(mb, fr, -(P + 0.06), 0.95, -(P + 0.06), 5.3);
    mb.color(COL.panelTop);
    strip(mb, fr, P, 3.9, P, 5.3);
    strip(mb, fr, -P, 5.3, -P, 3.9);
    mb.color(COL.steel);
    for (const [s] of this.every(5)) {
      const f = this.at(s);
      box(mb, f, P + 0.03, 3.15, 0.09, 2.2, 0.09);
      box(mb, f, -(P + 0.03), 3.15, 0.09, 2.2, 0.09);
    }
  }

  private buildViaduct(): void {
    const mb = this.struct;
    mb.color(COL.concrete, 0.75);
    for (const [s] of this.every(30)) {
      const y = this.roadRef.groundY(this.c.s0 + s);
      if (y > -3) continue;
      const f = this.at(s);
      const top = -DECK_DEPTH - 0.9;
      for (const side of [-1, 1]) box(mb, f, side * 5.5, (y + top) / 2, 0.7, (top - y) / 2, 0.9, 0, FACE_NO_BOTTOM);
      box(mb, f, 0, -DECK_DEPTH - 0.45, EDGE - 0.4, 0.45, 1.0);
    }
  }

  private buildTrees(): void {
    const rng = this.rng;
    const mb = this.struct;
    mb.color(COL.tree);
    for (const side of [-1, 1]) {
      for (let n = 0; n < 5; n++) {
        const s = range(rng, 2, 98);
        const d = side * range(rng, 18, 36);
        const h = range(rng, 4, 8);
        const f = this.at(s);
        const x = f.x + Math.cos(f.th) * d;
        const z = f.z + Math.sin(f.th) * d;
        cone(mb, x, this.roadRef.groundY(this.c.s0 + s) - 0.2, z, h * 0.28, h);
      }
    }
  }

  private buildGantry(): void {
    const rng = this.rng;
    const mb = this.struct;
    const f = this.at(50);
    const half = WALL_D + 0.3;
    mb.color(COL.steel);
    box(mb, f, half, 4.4, 0.16, 3.45, 0.16);
    box(mb, f, -half, 4.4, 0.16, 3.45, 0.16);
    box(mb, f, 0, 6.2, half, 0.1, 0.1);
    box(mb, f, 0, 7.75, half, 0.1, 0.1);

    const boards = rng() < 0.5 ? [-LANE_W, LANE_W] : [-5.4, 0, 5.4];
    const hw = boards.length === 2 ? 2.6 : 2.4;
    const hh = hw / 2;
    const front = this.shift(f, -0.3);
    const first = Math.floor(rng() * HIGHWAY_SIGNS);
    const stride = 1 + Math.floor(rng() * 3);
    for (let b = 0; b < boards.length; b++) {
      const d = boards[b];
      const [u0, v0, u1, v1] = cellUV((first + b * stride) % HIGHWAY_SIGNS);
      this.signs.rgb(1, 1, 1);
      signQuad(this.signs, front, d, 7.0, hw, hh, u0, v0, u1, v1);
      this.glow.color(COL.white, 1.6);
      box(this.glow, front, d, 7.0 + hh + 0.12, hw * 0.6, 0.03, 0.06);
    }
  }

  private buildOverpass(): void {
    const mb = this.struct;
    const f = this.at(50);
    const light = LIGHT_COLOR[this.c.light];
    mb.color(COL.concrete);
    box(mb, f, 0, 7.6, 48, 0.7, 7);
    for (const off of [-6.8, 6.8]) box(mb, this.shift(f, off), 0, 8.8, 48, 0.5, 0.2);
    const f0 = this.at(50);
    for (const dd of [WALL_D + 2.6, 26]) {
      for (const side of [-1, 1]) box(mb, f0, side * dd, 3.45, 0.8, 3.45, 2.6, 0, FACE_NO_BOTTOM);
    }
    for (const side of [-1, 1]) box(mb, f0, side * 46, 4.2, 2, 4.2, 7.5, 0, FACE_NO_BOTTOM);
    const front = this.shift(this.at(50), -7.05);
    this.glow.color(light, 2);
    for (let d = -42; d <= 42; d += 6) box(this.glow, front, d, 7.05, 0.25, 0.05, 0.02);
  }

  private buildCity(): void {
    const rng = this.rng;
    if (this.c.kind === 'bridge') {
      this.buildBoats();
      return;
    }
    const rows: [number, number, number, number][] = [
      [40, 80, 8, 28],
      [95, 170, 18, 60],
      [190, 300, 30, 110],
    ];
    for (const side of [-1, 1]) {
      rows.forEach(([dMin, dMax, hMin, hMax], r) => {
        if (r === 0 && this.c.overpass) return;
        let s = range(rng, 0, 20);
        while (s < CHUNK_LEN) {
          const w = range(rng, 14, 32);
          const sc = s + w / 2;
          if (sc > CHUNK_LEN - 2) break;
          this.building(sc, side * range(rng, dMin, dMax), w, range(rng, 12, 28), range(rng, hMin, hMax));
          s += w + range(rng, 4, 18);
        }
      });
      if (rng() < 0.5) this.building(range(rng, 10, 90), side * range(rng, 380, 650), range(rng, 25, 45), range(rng, 25, 45), range(rng, 80, 190));
    }
  }

  /** Open water under the bridge: a few boats with cabin, deck and navigation lights. */
  private buildBoats(): void {
    const rng = this.rng;
    for (const side of [-1, 1]) {
      if (rng() < 0.8) this.boat(range(rng, 10, 90), side * range(rng, 110, 480), rng);
    }
  }

  /** A yacht or a sailboat with a pointed bow (no barges: a box hull read as a floating block). */
  private boat(sLocal: number, d: number, rng: Rng): void {
    const f0 = this.at(sLocal);
    const cx = f0.x + Math.cos(f0.th) * d;
    const cz = f0.z + Math.sin(f0.th) * d;
    const th = f0.th + range(rng, -0.7, 0.7) + (rng() < 0.5 ? Math.PI : 0);
    const fx = Math.sin(th);
    const fz = -Math.cos(th);
    const sail = rng() < 0.4;
    const len = sail ? range(rng, 11, 16) : range(rng, 20, 34);
    const wid = len * (sail ? 0.3 : 0.24);
    const water = GROUND_LEVEL.bridge;
    const deck = water + (sail ? 1.1 : 1.8);
    const at = (along: number): Frame => ({ x: cx + fx * along, z: cz + fz * along, th });

    // Hull: stern transom, straight sides, then a pointed bow.
    const w = wid / 2;
    const hull: [number, number][] = [
      [-w, -len / 2],
      [w, -len / 2],
      [w, len * 0.12],
      [w * 0.55, len * 0.36],
      [0, len / 2],
      [-w * 0.55, len * 0.36],
      [-w, len * 0.12],
    ];
    prism(this.struct, cx, cz, th, hull, water - 0.2, deck, COL.hull, COL.deck);
    this.glow.color(COL.boatDeck, 0.5);
    for (let k = 0; k < hull.length; k++) {
      // Thin lit rub rail along the deck edge.
      const [x0, a0] = hull[k];
      const [x1, a1] = hull[(k + 1) % hull.length];
      const ax = cx + Math.cos(th) * x0 + fx * a0;
      const az = cz + Math.sin(th) * x0 + fz * a0;
      const bx = cx + Math.cos(th) * x1 + fx * a1;
      const bz = cz + Math.sin(th) * x1 + fz * a1;
      cable(this.glow, ax, deck + 0.05, az, bx, deck + 0.05, bz, 0.05);
    }

    if (sail) {
      // Small cabin, tall mast with a white top light, side lights at the bow.
      this.struct.color(COL.cabin);
      box(this.struct, at(-len * 0.08), 0, deck + 0.45, w * 0.55, 0.45, len * 0.16);
      this.glow.color(COL.boatWindow, 0.8);
      for (const side of [-1, 1]) box(this.glow, at(-len * 0.08), side * (w * 0.55 + 0.02), deck + 0.5, 0.03, 0.12, len * 0.12);
      const mastH = len * 1.25;
      this.struct.color(COL.steel);
      box(this.struct, at(len * 0.08), 0, deck + mastH / 2, 0.1, mastH / 2, 0.1);
      this.glow.color(COL.white, 3);
      box(this.glow, at(len * 0.08), 0, deck + mastH + 0.2, 0.22, 0.22, 0.22);
    } else {
      // Motor yacht: two stepped decks of saloon windows and a flybridge.
      const cab = -len * 0.08;
      this.struct.color(COL.yacht);
      box(this.struct, at(cab), 0, deck + 1.1, w * 0.8, 1.1, len * 0.3);
      box(this.struct, at(cab - len * 0.06), 0, deck + 2.9, w * 0.62, 0.7, len * 0.18);
      this.glow.color(COL.boatWindow);
      for (const side of [-1, 1]) {
        box(this.glow, at(cab), side * (w * 0.8 + 0.02), deck + 1.2, 0.04, 0.35, len * 0.26);
        box(this.glow, at(cab - len * 0.06), side * (w * 0.62 + 0.02), deck + 2.95, 0.04, 0.25, len * 0.15);
      }
      this.glow.color(COL.boatDeck);
      for (let a = -len / 2 + 2; a < len * 0.3; a += 3.5) {
        box(this.glow, at(a), w - 0.15, deck + 0.12, 0.12, 0.12, 0.12);
        box(this.glow, at(a), -(w - 0.15), deck + 0.12, 0.12, 0.12, 0.12);
      }
      this.glow.color(COL.white, 3);
      box(this.glow, at(cab - len * 0.06), 0, deck + 5.2, 0.25, 0.25, 0.25);
    }
    this.glow.color(COL.navRed);
    box(this.glow, at(len * 0.3), -w * 0.7, deck + 0.4, 0.22, 0.22, 0.22);
    this.glow.color(COL.navGreen);
    box(this.glow, at(len * 0.3), w * 0.7, deck + 0.4, 0.22, 0.22, 0.22);

    // Their reflections stretch across the water toward the road.
    this.pools.color(COL.boatWindow, sail ? 0.18 : 0.3);
    flatQuad(this.pools, f0, d - Math.sign(d) * 14, water + 0.08, 14, len * 0.3);
  }

  /** Box building with window attributes: faces carry facade metres, the roof has none. */
  private building(s: number, d: number, w: number, depth: number, h: number): void {
    const mb = this.city;
    const rng = this.rng;
    const f = this.at(s);
    const base = this.roadRef.groundY(this.c.s0 + s) - 0.5;
    const rx = Math.cos(f.th);
    const rz = Math.sin(f.th);
    const fx = Math.sin(f.th);
    const fz = -Math.cos(f.th);
    const cx = f.x + rx * d;
    const cz = f.z + rz * d;
    const hx = depth / 2;
    const hz = w / 2;
    const tone = range(rng, 0.012, 0.03);
    mb.rgb(tone, tone * 0.98, tone * 1.08);
    mb.w2 = Math.floor(rng() * 997);
    const lit = range(rng, 0.18, 0.55);

    // [normal, horizontal axis (n = H × U), face width]
    const faces: [number, number, number, number, number][] = [
      [rx, rz, fx * hz, fz * hz, w],
      [-rx, -rz, -fx * hz, -fz * hz, w],
      [fx, fz, -rx * hx, -rz * hx, depth],
      [-fx, -fz, rx * hx, rz * hx, depth],
    ];
    for (const [nx, nz, hX, hZ, width] of faces) {
      const off = Math.abs(nx * rx + nz * rz) > 0.5 ? hx : hz;
      const ox = cx + nx * off;
      const oz = cz + nz * off;
      mb.w3 = lit;
      const ids = [0, 0, 0, 0];
      const corners = [
        [-1, 0],
        [1, 0],
        [1, 1],
        [-1, 1],
      ];
      for (let k = 0; k < 4; k++) {
        const [sh, sv] = corners[k];
        mb.w0 = ((sh + 1) / 2) * width;
        mb.w1 = sv * h;
        ids[k] = mb.v(ox + sh * hX, base + sv * h, oz + sh * hZ, nx, 0, nz);
      }
      mb.quad(ids[0], ids[1], ids[2], ids[3]);
    }
    mb.w3 = -1;
    mb.w0 = mb.w1 = 0;
    const top = base + h;
    const ids = [0, 0, 0, 0];
    const roof = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let k = 0; k < 4; k++) {
      const [a, b] = roof[k];
      ids[k] = mb.v(cx + a * rx * hx + b * fx * hz, top, cz + a * rz * hx + b * fz * hz, 0, 1, 0);
    }
    mb.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

export class RoadView {
  readonly group = new THREE.Group();
  private readonly mats: RoadMaterials;
  private readonly live = new Map<number, ChunkView>();
  private readonly free: ChunkView[] = [];
  private road: Road | null = null;

  constructor(q: QualityPreset, maxAnisotropy: number) {
    const anisotropy = Math.min(q.anisotropy, maxAnisotropy);
    this.mats = {
      road: new THREE.MeshStandardMaterial({ map: makeRoadTexture(anisotropy, q.roadTex), vertexColors: true, roughness: 0.8, metalness: 0 }),
      struct: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
      pools: new THREE.MeshBasicMaterial({
        map: makeRadialTexture(128, 1.8),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Lifted by DECAL_Y instead of polygonOffset: on ANGLE/D3D11 the offset pushed decals under the road.
        depthWrite: false,
      }),
      city: makeCityMaterial(),
      // Vertex colour sets the brightness: gantry boards 1, lit tunnel signs ~2 (they bloom a little).
      signs: new THREE.MeshBasicMaterial({ map: makeSignAtlas(anisotropy, q.signScale), color: new THREE.Color(0.8, 0.8, 0.8), vertexColors: true }),
      // Dark glossy water: catches the moon and the lamp lights as highlights.
      water: new THREE.MeshStandardMaterial({ color: 0x060c16, vertexColors: true, roughness: 0.16, metalness: 0.6 }),
    };
  }

  /** Make sure chunks covering [sMin, sMax] are built and placed relative to the floating origin. */
  update(road: Road, sMin: number, sMax: number, ox: number, oz: number): void {
    if (road !== this.road) {
      // A new track (test showcase) restarts chunk indices: drop every view of the old one.
      for (const v of this.live.values()) {
        this.group.remove(v.group);
        this.free.push(v);
      }
      this.live.clear();
      this.road = road;
    }
    const iMin = Math.max(Math.floor(sMin / CHUNK_LEN), road.chunks[0].index);
    const iMax = Math.floor(sMax / CHUNK_LEN);
    for (const [idx, v] of this.live) {
      if (idx < iMin || idx > iMax) {
        this.live.delete(idx);
        this.group.remove(v.group);
        this.free.push(v);
      }
    }
    for (const c of road.chunks) {
      if (c.index < iMin || c.index > iMax) continue;
      let v = this.live.get(c.index);
      if (!v) {
        v = this.free.pop() ?? new ChunkView(this.mats);
        v.build(c, road);
        this.live.set(c.index, v);
        this.group.add(v.group);
      }
      v.group.position.set(v.x0 - ox, 0, v.z0 - oz);
    }
  }

  /** Lamp positions (absolute s) of the built chunks within [sMin, sMax]. */
  collectAnchors(sMin: number, sMax: number, out: LampAnchor[]): void {
    for (const v of this.live.values()) {
      for (let i = 0; i < v.anchorCount; i++) {
        const a = v.anchors[i];
        if (a.s >= sMin && a.s <= sMax) out.push(a);
      }
    }
  }
}
