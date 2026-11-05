import * as THREE from 'three';
import { WALL_D } from '../config';
import { CHUNK_LEN, CHUNK_SAMPLES, SAMPLE_DS, type Road, type RoadChunk } from '../sim/road';
import { ROAD_TEX_PERIOD, makeRadialTexture, makeRoadTexture } from './textures';

/*
 * Road chunks are rendered as a few merged meshes each (road, structure, lamp heads, light pools).
 * Every chunk has the same topology, so views are pooled and only their vertex data is rewritten:
 * no allocations while driving. Vertices are chunk-local; the group is placed relative to the
 * floating origin, so float32 precision never degrades however far you drive.
 */

const ROWS = CHUNK_SAMPLES + 1;

/** Jersey barrier cross-section (offset beyond WALL_D, height). */
const PROFILE: [number, number][] = [
  [0, 0],
  [0.08, 0.32],
  [0.18, 0.95],
  [0.45, 0.95],
  [0.55, 0],
];
const ROAD_EDGE = WALL_D + 0.55;
const GROUND_OUT = WALL_D + 160;
const GROUND_Y = -0.02;

const WALL_COLOR = new THREE.Color(0x85888d);
const WALL_TOP_COLOR = new THREE.Color(0x9a9da2);
const GROUND_COLOR = new THREE.Color(0x0a0c0f);
const POLE_COLOR = new THREE.Color(0x5f636a);

const LAMPS = [
  { s: 0, side: 1 },
  { s: 25, side: -1 },
  { s: 50, side: 1 },
  { s: 75, side: -1 },
];
const POLE_D = WALL_D + 0.31;
const POLE_H = 9.2;
const ARM_LEN = 2.6;
const HEAD_D = POLE_D - ARM_LEN + 0.15;
const POOL_R = 9;

interface Strip {
  a: [number, number];
  b: [number, number];
  color: THREE.Color;
}

/*
 * Winding: for vertices a, b on each row, triangles (a_i, b_i, a_i+1) face along (-Δy, Δd) of a→b.
 * Right-side strips go outward; mirrored left strips swap a and b to keep facing the same way.
 */
const STRIPS: Strip[] = (() => {
  const out: Strip[] = [];
  for (let j = 0; j < PROFILE.length - 1; j++) {
    const p0 = PROFILE[j];
    const p1 = PROFILE[j + 1];
    const color = p0[1] > 0 && p0[1] === p1[1] ? WALL_TOP_COLOR : WALL_COLOR;
    out.push({ a: [WALL_D + p0[0], p0[1]], b: [WALL_D + p1[0], p1[1]], color });
    out.push({ a: [-(WALL_D + p1[0]), p1[1]], b: [-(WALL_D + p0[0]), p0[1]], color });
  }
  out.push({ a: [ROAD_EDGE, GROUND_Y], b: [GROUND_OUT, GROUND_Y], color: GROUND_COLOR });
  out.push({ a: [-GROUND_OUT, GROUND_Y], b: [-ROAD_EDGE, GROUND_Y], color: GROUND_COLOR });
  return out;
})();

const STRIP_VERTS = ROWS * 2;
const STRIP_INDICES = (ROWS - 1) * 6;
const BOX_VERTS = 24;
const BOX_INDICES = 36;

function alloc(verts: number, indices: number, uv: boolean, color: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
  if (color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  return g;
}

function stripIndices(idx: THREE.TypedArray, at: number, v0: number): number {
  for (let i = 0; i < ROWS - 1; i++) {
    const a = v0 + i * 2;
    idx[at++] = a;
    idx[at++] = a + 1;
    idx[at++] = a + 2;
    idx[at++] = a + 1;
    idx[at++] = a + 3;
    idx[at++] = a + 2;
  }
  return at;
}

function quadIndices(idx: THREE.TypedArray, at: number, v0: number, quads: number): number {
  for (let q = 0; q < quads; q++) {
    const b = v0 + q * 4;
    idx[at++] = b;
    idx[at++] = b + 1;
    idx[at++] = b + 2;
    idx[at++] = b;
    idx[at++] = b + 2;
    idx[at++] = b + 3;
  }
  return at;
}

function fillColor(col: THREE.TypedArray, v0: number, count: number, c: THREE.Color): void {
  for (let v = v0; v < v0 + count; v++) {
    col[v * 3] = c.r;
    col[v * 3 + 1] = c.g;
    col[v * 3 + 2] = c.b;
  }
}

function writeStrip(
  pos: THREE.TypedArray,
  nrm: THREE.TypedArray,
  v0: number,
  c: RoadChunk,
  a: [number, number],
  b: [number, number],
): void {
  const dd = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dd, dy);
  const nd = -dy / len;
  const ny = dd / len;
  const x0 = c.x[0];
  const z0 = c.z[0];
  for (let i = 0; i < ROWS; i++) {
    const cs = Math.cos(c.th[i]);
    const sn = Math.sin(c.th[i]);
    const bx = c.x[i] - x0;
    const bz = c.z[i] - z0;
    const va = (v0 + i * 2) * 3;
    const vb = va + 3;
    pos[va] = bx + cs * a[0];
    pos[va + 1] = a[1];
    pos[va + 2] = bz + sn * a[0];
    pos[vb] = bx + cs * b[0];
    pos[vb + 1] = b[1];
    pos[vb + 2] = bz + sn * b[0];
    nrm[va] = nrm[vb] = cs * nd;
    nrm[va + 1] = nrm[vb + 1] = ny;
    nrm[va + 2] = nrm[vb + 2] = sn * nd;
  }
}

interface Frame {
  x: number;
  z: number;
  th: number;
}

/** Chunk-local position and heading at local distance s. */
function frameAt(c: RoadChunk, s: number, out: Frame): Frame {
  const u = s / SAMPLE_DS;
  const i = Math.min(Math.floor(u), CHUNK_SAMPLES - 1);
  const t = u - i;
  out.x = c.x[i] + (c.x[i + 1] - c.x[i]) * t - c.x[0];
  out.z = c.z[i] + (c.z[i + 1] - c.z[i]) * t - c.z[0];
  out.th = c.th[i] + (c.th[i + 1] - c.th[i]) * t;
  return out;
}

/** Oriented box: right axis (hx), up (hy), forward (hz). */
function writeBox(
  pos: THREE.TypedArray,
  nrm: THREE.TypedArray,
  v0: number,
  f: Frame,
  d: number,
  y: number,
  hx: number,
  hy: number,
  hz: number,
): void {
  const rx = Math.cos(f.th);
  const rz = Math.sin(f.th);
  const fx = Math.sin(f.th);
  const fz = -Math.cos(f.th);
  const cx = f.x + rx * d;
  const cz = f.z + rz * d;
  const R = [rx * hx, 0, rz * hx];
  const U = [0, hy, 0];
  const F = [fx * hz, 0, fz * hz];
  const neg = (v: number[]) => [-v[0], -v[1], -v[2]];
  // [normal, e1, e2] with e1 × e2 along the normal.
  const faces = [
    [R, F, U],
    [neg(R), U, F],
    [U, R, F],
    [neg(U), F, R],
    [F, U, R],
    [neg(F), R, U],
  ];
  let v = v0;
  for (const [n, e1, e2] of faces) {
    const nl = Math.hypot(n[0], n[1], n[2]);
    for (const [s1, s2] of CORNERS) {
      const o = v * 3;
      pos[o] = cx + n[0] + s1 * e1[0] + s2 * e2[0];
      pos[o + 1] = y + n[1] + s1 * e1[1] + s2 * e2[1];
      pos[o + 2] = cz + n[2] + s1 * e1[2] + s2 * e2[2];
      nrm[o] = n[0] / nl;
      nrm[o + 1] = n[1] / nl;
      nrm[o + 2] = n[2] / nl;
      v++;
    }
  }
}
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

interface RoadMaterials {
  road: THREE.Material;
  struct: THREE.Material;
  head: THREE.Material;
  pool: THREE.Material;
}

class ChunkView {
  readonly group = new THREE.Group();
  index = -1;
  x0 = 0;
  z0 = 0;
  private readonly road = alloc(STRIP_VERTS, STRIP_INDICES, true, false);
  private readonly struct: THREE.BufferGeometry;
  private readonly heads = alloc(LAMPS.length * BOX_VERTS, LAMPS.length * BOX_INDICES, false, false);
  private readonly pools = alloc(LAMPS.length * 4, LAMPS.length * 6, true, false);
  private readonly frame: Frame = { x: 0, z: 0, th: 0 };

  constructor(mats: RoadMaterials) {
    stripIndices(this.road.index!.array, 0, 0);

    const boxes = LAMPS.length * 2;
    const structVerts = STRIPS.length * STRIP_VERTS + boxes * BOX_VERTS;
    this.struct = alloc(structVerts, STRIPS.length * STRIP_INDICES + boxes * BOX_INDICES, false, true);
    const sIdx = this.struct.index!.array;
    const col = this.struct.getAttribute('color').array;
    let at = 0;
    STRIPS.forEach((st, k) => {
      at = stripIndices(sIdx, at, k * STRIP_VERTS);
      fillColor(col, k * STRIP_VERTS, STRIP_VERTS, st.color);
    });
    const boxV0 = STRIPS.length * STRIP_VERTS;
    quadIndices(sIdx, at, boxV0, boxes * 6);
    fillColor(col, boxV0, boxes * BOX_VERTS, POLE_COLOR);

    quadIndices(this.heads.index!.array, 0, 0, LAMPS.length * 6);
    quadIndices(this.pools.index!.array, 0, 0, LAMPS.length);
    const puv = this.pools.getAttribute('uv').array;
    for (let q = 0; q < LAMPS.length; q++) puv.set([0, 0, 1, 0, 1, 1, 0, 1], q * 8);

    const road = new THREE.Mesh(this.road, mats.road);
    const struct = new THREE.Mesh(this.struct, mats.struct);
    const heads = new THREE.Mesh(this.heads, mats.head);
    const pools = new THREE.Mesh(this.pools, mats.pool);
    pools.renderOrder = 1;
    this.group.add(road, struct, heads, pools);
  }

  build(c: RoadChunk): void {
    this.index = c.index;
    this.x0 = c.x[0];
    this.z0 = c.z[0];

    // Road surface + uv (u across the full width, v along one dash period).
    {
      const pos = this.road.getAttribute('position').array;
      const nrm = this.road.getAttribute('normal').array;
      const uv = this.road.getAttribute('uv').array;
      writeStrip(pos, nrm, 0, c, [-ROAD_EDGE, 0], [ROAD_EDGE, 0]);
      const u0 = (-ROAD_EDGE + WALL_D) / (2 * WALL_D);
      const u1 = (ROAD_EDGE + WALL_D) / (2 * WALL_D);
      for (let i = 0; i < ROWS; i++) {
        const v = (i * SAMPLE_DS) / ROAD_TEX_PERIOD;
        uv[i * 4] = u0;
        uv[i * 4 + 1] = v;
        uv[i * 4 + 2] = u1;
        uv[i * 4 + 3] = v;
      }
    }

    // Barriers, ground, lamp poles.
    {
      const pos = this.struct.getAttribute('position').array;
      const nrm = this.struct.getAttribute('normal').array;
      STRIPS.forEach((st, k) => writeStrip(pos, nrm, k * STRIP_VERTS, c, st.a, st.b));
      let v = STRIPS.length * STRIP_VERTS;
      for (const lamp of LAMPS) {
        const f = frameAt(c, lamp.s, this.frame);
        writeBox(pos, nrm, v, f, lamp.side * POLE_D, POLE_H / 2, 0.11, POLE_H / 2, 0.11);
        v += BOX_VERTS;
        writeBox(pos, nrm, v, f, lamp.side * (POLE_D - ARM_LEN / 2), POLE_H - 0.1, ARM_LEN / 2, 0.06, 0.07);
        v += BOX_VERTS;
      }
    }

    // Lamp heads and light pools.
    {
      const pos = this.heads.getAttribute('position').array;
      const nrm = this.heads.getAttribute('normal').array;
      const ppos = this.pools.getAttribute('position').array;
      const pnrm = this.pools.getAttribute('normal').array;
      LAMPS.forEach((lamp, q) => {
        const f = frameAt(c, lamp.s, this.frame);
        writeBox(pos, nrm, q * BOX_VERTS, f, lamp.side * HEAD_D, POLE_H - 0.22, 0.38, 0.06, 0.17);
        const rx = Math.cos(f.th) * POOL_R;
        const rz = Math.sin(f.th) * POOL_R;
        const fx = Math.sin(f.th) * POOL_R;
        const fz = -Math.cos(f.th) * POOL_R;
        const cx = f.x + Math.cos(f.th) * lamp.side * HEAD_D;
        const cz = f.z + Math.sin(f.th) * lamp.side * HEAD_D;
        CORNERS.forEach(([s1, s2], k) => {
          const o = (q * 4 + k) * 3;
          ppos[o] = cx + s1 * rx + s2 * fx;
          ppos[o + 1] = 0.03;
          ppos[o + 2] = cz + s1 * rz + s2 * fz;
          pnrm[o] = 0;
          pnrm[o + 1] = 1;
          pnrm[o + 2] = 0;
        });
      });
    }

    for (const g of [this.road, this.struct, this.heads, this.pools]) {
      g.getAttribute('position').needsUpdate = true;
      g.getAttribute('normal').needsUpdate = true;
      const uv = g.getAttribute('uv');
      if (uv) uv.needsUpdate = true;
      g.computeBoundingSphere();
    }
  }
}

export class RoadView {
  readonly group = new THREE.Group();
  private readonly mats: RoadMaterials;
  private readonly live = new Map<number, ChunkView>();
  private readonly free: ChunkView[] = [];

  constructor(anisotropy: number, lampColor: THREE.Color) {
    const pool = new THREE.MeshBasicMaterial({
      map: makeRadialTexture(128, 1.8),
      color: lampColor.clone().multiplyScalar(0.8),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mats = {
      road: new THREE.MeshStandardMaterial({ map: makeRoadTexture(anisotropy), roughness: 0.8, metalness: 0 }),
      struct: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
      head: new THREE.MeshBasicMaterial({ color: lampColor.clone().multiplyScalar(2.2) }),
      pool,
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
        v.build(c);
        this.live.set(c.index, v);
        this.group.add(v.group);
      }
      v.group.position.set(v.x0 - ox, 0, v.z0 - oz);
    }
  }
}
