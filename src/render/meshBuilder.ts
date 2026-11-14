import * as THREE from 'three';
import { CHUNK_SAMPLES, SAMPLE_DS, type RoadChunk } from '../sim/road';

export const ROWS = CHUNK_SAMPLES + 1;

interface BuilderOptions {
  maxVerts: number;
  maxIndices: number;
  uv?: boolean;
  /** vec4 per vertex for the city shader: facade u/v in metres, building seed, lit share (-1 = no windows). */
  win?: boolean;
  /** float per vertex: which layer of a texture array the surface samples (Miami land). */
  layer?: boolean;
}

/**
 * Fixed-capacity geometry writer. A pooled chunk view rewrites its builders on every rebuild and
 * only the used range is drawn and uploaded, so driving never allocates GPU buffers or garbage.
 */
export class MeshBuilder {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly uvs: Float32Array | null;
  private readonly wins: Float32Array | null;
  private readonly layers: Float32Array | null;
  private readonly idx: Uint16Array | Uint32Array;
  private readonly maxVerts: number;
  private nv = 0;
  private ni = 0;
  private overflowed = false;

  r = 1;
  g = 1;
  b = 1;
  /** Current window attribute (city builder only). */
  w0 = 0;
  w1 = 0;
  w2 = 0;
  w3 = -1;
  /** Current texture-array layer (layer builders only). */
  layer = 0;

  constructor(o: BuilderOptions) {
    this.maxVerts = o.maxVerts;
    this.pos = new Float32Array(o.maxVerts * 3);
    this.nrm = new Float32Array(o.maxVerts * 3);
    this.col = new Float32Array(o.maxVerts * 3);
    this.uvs = o.uv ? new Float32Array(o.maxVerts * 2) : null;
    this.wins = o.win ? new Float32Array(o.maxVerts * 4) : null;
    this.layers = o.layer ? new Float32Array(o.maxVerts) : null;
    this.idx = o.maxVerts > 65535 ? new Uint32Array(o.maxIndices) : new Uint16Array(o.maxIndices);
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    if (this.uvs) g.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    if (this.wins) g.setAttribute('aWin', new THREE.BufferAttribute(this.wins, 4).setUsage(THREE.DynamicDrawUsage));
    if (this.layers) g.setAttribute('aLayer', new THREE.BufferAttribute(this.layers, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere();
  }

  get empty(): boolean {
    return this.ni === 0;
  }

  reset(): void {
    this.nv = 0;
    this.ni = 0;
  }

  color(c: THREE.Color, k = 1): this {
    this.r = c.r * k;
    this.g = c.g * k;
    this.b = c.b * k;
    return this;
  }

  rgb(r: number, g: number, b: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, uv = 0): number {
    if (this.nv >= this.maxVerts) {
      if (!this.overflowed) console.warn('MeshBuilder capacity exceeded');
      this.overflowed = true;
      return -1;
    }
    const i = this.nv;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nrm[o] = nx;
    this.nrm[o + 1] = ny;
    this.nrm[o + 2] = nz;
    this.col[o] = this.r;
    this.col[o + 1] = this.g;
    this.col[o + 2] = this.b;
    if (this.uvs) {
      this.uvs[i * 2] = u;
      this.uvs[i * 2 + 1] = uv;
    }
    if (this.wins) {
      this.wins[i * 4] = this.w0;
      this.wins[i * 4 + 1] = this.w1;
      this.wins[i * 4 + 2] = this.w2;
      this.wins[i * 4 + 3] = this.w3;
    }
    if (this.layers) this.layers[i] = this.layer;
    this.nv++;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (a < 0 || b < 0 || c < 0 || this.ni + 3 > this.idx.length) return;
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Upload the used range and update draw range and bounds. */
  finish(): void {
    const g = this.geometry;
    g.setDrawRange(0, this.ni);
    for (const name of ['position', 'normal', 'color', 'uv', 'aWin', 'aLayer']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.nv * a.itemSize);
      a.needsUpdate = true;
    }
    const index = g.index!;
    index.clearUpdateRanges();
    index.addUpdateRange(0, this.ni);
    index.needsUpdate = true;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = this.pos;
    for (let i = 0; i < this.nv * 3; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const s = g.boundingSphere!;
    if (this.nv === 0) {
      s.set(s.center.set(0, 0, 0), 0);
      return;
    }
    s.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    s.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  }
}

/** Position and heading on the road, relative to the chunk origin. */
export interface Frame {
  x: number;
  z: number;
  th: number;
}

/** Per-row road frames of one chunk, in chunk-local coordinates. */
export class ChunkFrames {
  readonly bx = new Float64Array(ROWS);
  readonly bz = new Float64Array(ROWS);
  readonly cs = new Float64Array(ROWS);
  readonly sn = new Float64Array(ROWS);
  private c: RoadChunk | null = null;

  set(c: RoadChunk): void {
    this.c = c;
    for (let i = 0; i < ROWS; i++) {
      this.bx[i] = c.x[i] - c.x[0];
      this.bz[i] = c.z[i] - c.z[0];
      this.cs[i] = Math.cos(c.th[i]);
      this.sn[i] = Math.sin(c.th[i]);
    }
  }

  /** Frame at local distance s (0..100). */
  at(s: number, out: Frame): Frame {
    const c = this.c!;
    const u = Math.min(Math.max(s / SAMPLE_DS, 0), CHUNK_SAMPLES);
    const i = Math.min(Math.floor(u), CHUNK_SAMPLES - 1);
    const t = u - i;
    out.x = this.bx[i] + (this.bx[i + 1] - this.bx[i]) * t;
    out.z = this.bz[i] + (this.bz[i + 1] - this.bz[i]) * t;
    out.th = c.th[i] + (c.th[i + 1] - c.th[i]) * t;
    return out;
  }
}

/**
 * Ribbon along the chunk between cross-section points a=(dA, yA) and b=(dB, yB); heights may vary per row.
 * Faces along (-Δy, Δd) of a→b: list right-side profiles outward and mirror + swap them for the left side.
 * Optional per-end colours make vertical gradients (baked lighting).
 */
export function strip(
  mb: MeshBuilder,
  fr: ChunkFrames,
  dA: number,
  yA: number | Float64Array,
  dB: number,
  yB: number | Float64Array,
  colA?: THREE.Color,
  colB?: THREE.Color,
  colK = 1,
  /** Optional per-row brightness (e.g. shade ramp at tunnel portals). */
  rowK?: Float64Array,
): void {
  let prevA = -1;
  let prevB = -1;
  const r0 = mb.r;
  const g0 = mb.g;
  const b0 = mb.b;
  for (let i = 0; i < ROWS; i++) {
    const ya = typeof yA === 'number' ? yA : yA[i];
    const yb = typeof yB === 'number' ? yB : yB[i];
    const dd = dB - dA;
    const dy = yb - ya;
    const len = Math.hypot(dd, dy);
    const nd = len > 1e-6 ? -dy / len : 0;
    const ny = len > 1e-6 ? dd / len : 1;
    const cs = fr.cs[i];
    const sn = fr.sn[i];
    const bx = fr.bx[i];
    const bz = fr.bz[i];
    const k = rowK ? rowK[i] : 1;
    if (colA) mb.color(colA, colK * k);
    else if (rowK) mb.rgb(r0 * k, g0 * k, b0 * k);
    const a = mb.v(bx + cs * dA, ya, bz + sn * dA, cs * nd, ny, sn * nd);
    if (colB) mb.color(colB, colK * k);
    else if (rowK) mb.rgb(r0 * k, g0 * k, b0 * k);
    const b = mb.v(bx + cs * dB, yb, bz + sn * dB, cs * nd, ny, sn * nd);
    if (i > 0) mb.quad(prevA, prevB, b, a);
    prevA = a;
    prevB = b;
  }
  mb.r = r0;
  mb.g = g0;
  mb.b = b0;
}

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Box aligned with the road at frame f: hx across (right), hy up, hz along (forward).
 * `yaw` turns it further around the vertical axis.
 */
export function box(
  mb: MeshBuilder,
  f: Frame,
  d: number,
  y: number,
  hx: number,
  hy: number,
  hz: number,
  yaw = 0,
  faces = 0b111111,
): void {
  const th = f.th + yaw;
  const rx = Math.cos(th);
  const rz = Math.sin(th);
  const fx = Math.sin(th);
  const fz = -Math.cos(th);
  const cx = f.x + Math.cos(f.th) * d;
  const cz = f.z + Math.sin(f.th) * d;
  // [normal axis, e1, e2] with e1 × e2 along the normal; axes: R right, U up, F forward.
  const R = [rx * hx, 0, rz * hx];
  const U = [0, hy, 0];
  const F = [fx * hz, 0, fz * hz];
  const N = [rx, 0, rz, 0, 1, 0, fx, 0, fz];
  const defs: [number[], number, number[], number[]][] = [
    [R, 0, F, U],
    [R, 0, U, F],
    [U, 1, R, F],
    [U, 1, F, R],
    [F, 2, U, R],
    [F, 2, R, U],
  ];
  for (let k = 0; k < 6; k++) {
    if (!(faces & (1 << k))) continue;
    const [axis, ni, e1, e2] = defs[k];
    const sign = k % 2 === 0 ? 1 : -1;
    const nx = N[ni * 3] * sign;
    const ny = N[ni * 3 + 1] * sign;
    const nz = N[ni * 3 + 2] * sign;
    const ox = cx + axis[0] * sign;
    const oy = y + axis[1] * sign;
    const oz = cz + axis[2] * sign;
    const ids = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const [s1, s2] = CORNERS[c];
      ids[c] = mb.v(
        ox + s1 * e1[0] + s2 * e2[0],
        oy + s1 * e1[1] + s2 * e2[1],
        oz + s1 * e1[2] + s2 * e2[2],
        nx,
        ny,
        nz,
        (s1 + 1) / 2,
        (s2 + 1) / 2,
      );
    }
    mb.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}
export const FACE_NO_BOTTOM = 0b110111;

/** Flat quad lying on the ground (decals): hr across, hf along the road. */
export function flatQuad(mb: MeshBuilder, f: Frame, d: number, y: number, hr: number, hf: number): void {
  const rx = Math.cos(f.th);
  const rz = Math.sin(f.th);
  const fx = Math.sin(f.th);
  const fz = -Math.cos(f.th);
  const cx = f.x + rx * d;
  const cz = f.z + rz * d;
  const ids = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const [s1, s2] = CORNERS[c];
    ids[c] = mb.v(cx + s1 * rx * hr + s2 * fx * hf, y, cz + s1 * rz * hr + s2 * fz * hf, 0, 1, 0, (s1 + 1) / 2, (s2 + 1) / 2);
  }
  mb.quad(ids[0], ids[1], ids[2], ids[3]);
}

/** Upright quad facing oncoming traffic (normal = -forward), uv rectangle [u0,v0]-[u1,v1]. */
export function signQuad(
  mb: MeshBuilder,
  f: Frame,
  d: number,
  y: number,
  hw: number,
  hh: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): void {
  const rx = Math.cos(f.th);
  const rz = Math.sin(f.th);
  const cx = f.x + rx * d;
  const cz = f.z + rz * d;
  const nx = -Math.sin(f.th);
  const nz = Math.cos(f.th);
  const a = mb.v(cx - rx * hw, y - hh, cz - rz * hw, nx, 0, nz, u0, v0);
  const b = mb.v(cx + rx * hw, y - hh, cz + rz * hw, nx, 0, nz, u1, v0);
  const c = mb.v(cx + rx * hw, y + hh, cz + rz * hw, nx, 0, nz, u1, v1);
  const e = mb.v(cx - rx * hw, y + hh, cz - rz * hw, nx, 0, nz, u0, v1);
  mb.quad(a, b, c, e);
}

/** Low-poly conifer silhouette (pyramid, no base). */
export function cone(mb: MeshBuilder, x: number, y: number, z: number, radius: number, height: number, sides = 6): void {
  const ax = x;
  const ay = y + height;
  const az = z;
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2;
    const x0 = x + Math.cos(a0) * radius;
    const z0 = z + Math.sin(a0) * radius;
    const x1 = x + Math.cos(a1) * radius;
    const z1 = z + Math.sin(a1) * radius;
    // Normal of the face (apex, p1, p0) pointing outward.
    const ux = x1 - ax, uy = y - ay, uz = z1 - az;
    const vx = x0 - ax, vy = y - ay, vz = z0 - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i0 = mb.v(ax, ay, az, nx, ny, nz);
    const i1 = mb.v(x1, y, z1, nx, ny, nz);
    const i2 = mb.v(x0, y, z0, nx, ny, nz);
    mb.tri(i0, i1, i2);
  }
}
