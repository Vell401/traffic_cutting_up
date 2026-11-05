import * as THREE from 'three';
import { LANE_W, WALL_D } from '../config';
import { mulberry32, range, type Rng } from '../core/rng';
import { CHUNK_LEN, SAMPLE_DS, type LightKind, type Road, type RoadChunk } from '../sim/road';
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
import { ROAD_TEX_PERIOD, SIGN_COLS, SIGN_ROWS, makeRadialTexture, makeRoadTexture, makeSignAtlas } from './textures';

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

/** Outer edge of the barrier / viaduct deck. */
const EDGE = WALL_D + 0.55;
const GROUND_OUT = 420;
const DECK_DEPTH = 1.6;
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
  emergency: new THREE.Color(0.2, 1.4, 0.5),
  white: new THREE.Color(1, 1, 1),
};

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
  private readonly road = new MeshBuilder({ maxVerts: ROWS * 2, maxIndices: (ROWS - 1) * 6, uv: true });
  private readonly struct = new MeshBuilder({ maxVerts: 9000, maxIndices: 16000 });
  private readonly glow = new MeshBuilder({ maxVerts: 6000, maxIndices: 9000 });
  private readonly pools = new MeshBuilder({ maxVerts: 400, maxIndices: 600, uv: true });
  private readonly city = new MeshBuilder({ maxVerts: 3000, maxIndices: 4500, win: true });
  private readonly signs = new MeshBuilder({ maxVerts: 32, maxIndices: 48, uv: true });
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
    for (let i = 0; i < ROWS; i++) this.gy[i] = road.groundY(c.s0 + i * SAMPLE_DS);

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
      default:
        this.buildLamps();
        this.buildTrees();
    }
    if (c.kind !== 'tunnel') this.buildReflectors();
    if (c.gantry) this.buildGantry();
    if (c.overpass) this.buildOverpass();
    if (c.kind !== 'tunnel') this.buildCity();

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

  private buildRoad(): void {
    const mb = this.road;
    const fr = this.fr;
    const tint = this.c.kind === 'tunnel' ? 0.45 : 1;
    mb.rgb(tint, tint, tint);
    const u0 = (-EDGE + WALL_D) / (2 * WALL_D);
    const u1 = (EDGE + WALL_D) / (2 * WALL_D);
    let pa = -1;
    let pb = -1;
    for (let i = 0; i < ROWS; i++) {
      const v = (i * SAMPLE_DS) / ROAD_TEX_PERIOD;
      const cs = fr.cs[i];
      const sn = fr.sn[i];
      const a = mb.v(fr.bx[i] - cs * EDGE, 0, fr.bz[i] - sn * EDGE, 0, 1, 0, u0, v);
      const b = mb.v(fr.bx[i] + cs * EDGE, 0, fr.bz[i] + sn * EDGE, 0, 1, 0, u1, v);
      if (i > 0) mb.quad(pa, pb, b, a);
      pa = a;
      pb = b;
    }
  }

  private buildBarriers(): void {
    const mb = this.struct;
    const k = this.c.kind === 'tunnel' ? 0.45 : 1;
    for (let j = 0; j < PROFILE.length - 1; j++) {
      const [d0, y0] = PROFILE[j];
      const [d1, y1] = PROFILE[j + 1];
      mb.color(y0 > 0 && y0 === y1 ? COL.barrierTop : COL.barrier, k);
      strip(mb, this.fr, WALL_D + d0, y0, WALL_D + d1, y1);
      strip(mb, this.fr, -(WALL_D + d1), y1, -(WALL_D + d0), y0);
    }
  }

  /** Terrain beside the road plus the faces joining it to the deck: retaining walls up, deck slab down. */
  private buildSides(): void {
    const mb = this.struct;
    const gy = this.gy;
    let face = false;
    for (let i = 0; i < ROWS; i++) {
      const y = gy[i];
      this.faceY[i] = y < 0 ? Math.max(y, -DECK_DEPTH) : y;
      if (Math.abs(this.faceY[i]) > 0.01) face = true;
    }
    if (face) {
      mb.color(COL.concrete);
      strip(mb, this.fr, EDGE, 0, EDGE, this.faceY);
      strip(mb, this.fr, -EDGE, this.faceY, -EDGE, 0);
    }
    mb.color(COL.ground);
    strip(mb, this.fr, EDGE, gy, GROUND_OUT, gy);
    strip(mb, this.fr, -GROUND_OUT, gy, -EDGE, gy);

    if (gy.some((y) => y < -DECK_DEPTH)) {
      mb.color(COL.concrete, 0.6);
      strip(mb, this.fr, EDGE, -DECK_DEPTH, -EDGE, -DECK_DEPTH);
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
      flatQuad(this.pools, f, side * HEAD_D, 0.03, POOL_R, POOL_R);
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

    for (const [s, k] of this.every(TUNNEL_LIGHT_STEP)) {
      const f = this.at(s);
      for (const d of [-LANE_W, LANE_W]) {
        g.color(light, 3);
        box(g, f, d, TUNNEL_H - 0.08, 0.16, 0.05, 0.7);
        this.pools.color(light, POOL_K[c.light] * 0.3);
        flatQuad(this.pools, f, d, 0.03, 3.6, 3.6);
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

    // Hill over the tunnel and the portal facades.
    for (let i = 0; i < ROWS; i++) this.roofY[i] = Math.max(this.gy[i], TUNNEL_H + 0.4);
    this.struct.color(COL.ground);
    strip(this.struct, fr, -EDGE, this.roofY, EDGE, this.roofY);
    this.struct.color(COL.concrete);
    if (c.prevKind !== 'tunnel') this.portal(0.8);
    if (c.nextKind !== 'tunnel') this.portal(CHUNK_LEN - 0.8);
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
    const first = Math.floor(rng() * SIGN_COLS * SIGN_ROWS);
    const stride = 1 + Math.floor(rng() * 3);
    for (let b = 0; b < boards.length; b++) {
      const d = boards[b];
      const cell = (first + b * stride) % (SIGN_COLS * SIGN_ROWS);
      const col = cell % SIGN_COLS;
      const row = Math.floor(cell / SIGN_COLS);
      this.signs.rgb(1, 1, 1);
      signQuad(this.signs, front, d, 7.0, hw, hh, col / SIGN_COLS, 1 - (row + 1) / SIGN_ROWS, (col + 1) / SIGN_COLS, 1 - row / SIGN_ROWS);
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

  constructor(anisotropy: number) {
    this.mats = {
      road: new THREE.MeshStandardMaterial({ map: makeRoadTexture(anisotropy), vertexColors: true, roughness: 0.8, metalness: 0 }),
      struct: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
      pools: new THREE.MeshBasicMaterial({
        map: makeRadialTexture(128, 1.8),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Sits 3 cm above the asphalt. No polygonOffset: on ANGLE/D3D11 it pushed the decals under the road.
        depthWrite: false,
      }),
      city: makeCityMaterial(),
      signs: new THREE.MeshBasicMaterial({ map: makeSignAtlas(anisotropy), color: new THREE.Color(0.8, 0.8, 0.8) }),
    };
  }

  /** Make sure chunks covering [sMin, sMax] are built and placed relative to the floating origin. */
  update(road: Road, sMin: number, sMax: number, ox: number, oz: number): void {
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
