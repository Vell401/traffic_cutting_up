import * as THREE from 'three';

/** Two grid points closer than this (squared, m²) are the same point: the row or column is doubled. */
const SAME = 1e-12;

/**
 * Collects triangles for one material: positions, normals and uvs, indexed. A vertex is shared only
 * within a bucket and only with the same key (grid point and side), so a material change or a crease
 * always splits it.
 */
export class Bucket {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** Vertex colour for the vertices added from now on (written only if `colored`). */
  rgb: [number, number, number] = [1, 1, 1];
  private readonly keys = new Map<number, number>();

  constructor(readonly colored = false) {}

  vertex(key: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    if (key >= 0) {
      const have = this.keys.get(key);
      if (have !== undefined) return have;
    }
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.rgb[0], this.rgb[1], this.rgb[2]);
    if (key >= 0) this.keys.set(key, i);
    return i;
  }

  /** Start a new key space (the next grid never shares vertices with the last one). */
  resetKeys(): void {
    this.keys.clear();
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Add a whole geometry (non-indexed or indexed) as it is; `uv` overrides every vertex's uv. */
  addGeometry(g: THREE.BufferGeometry, uv?: readonly [number, number]): void {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      if (uv) this.uv.push(uv[0], uv[1]);
      else this.uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
      this.col.push(this.rgb[0], this.rgb[1], this.rgb[2]);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.colored) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Surface sampled on a quad grid P[i][j]: i runs along the car, j around the section. Normals come
 * from the neighbours; a row or column repeated at the same position is a crease (each side keeps its
 * own normal, and the zero-area strip between the copies is never drawn).
 */
export class Grid {
  readonly p: Float64Array;
  private nrm: Float64Array | null = null;

  constructor(
    readonly ni: number,
    readonly nj: number,
  ) {
    this.p = new Float64Array(ni * nj * 3);
  }

  set(i: number, j: number, x: number, y: number, z: number): void {
    const k = (i * this.nj + j) * 3;
    this.p[k] = x;
    this.p[k + 1] = y;
    this.p[k + 2] = z;
  }

  /** Copy moved along the vertex normals by d (negative: inward). */
  offset(d: number, flip = false): Grid {
    const n = this.normals(flip);
    const g = new Grid(this.ni, this.nj);
    for (let k = 0; k < this.p.length; k++) g.p[k] = this.p[k] + n[k] * d;
    return g;
  }

  /** Point (i, j) into out[0..2]. */
  at(i: number, j: number, out: number[]): number[] {
    const k = (i * this.nj + j) * 3;
    out[0] = this.p[k];
    out[1] = this.p[k + 1];
    out[2] = this.p[k + 2];
    return out;
  }

  private same(a: number, b: number): boolean {
    const p = this.p;
    const dx = p[a] - p[b];
    const dy = p[a + 1] - p[b + 1];
    const dz = p[a + 2] - p[b + 2];
    return dx * dx + dy * dy + dz * dz < SAME;
  }

  /** Tangent along i (di = 1) or j (di = 0) at (i, j), creases respected. */
  private tangent(i: number, j: number, alongI: boolean, out: number[]): void {
    const n = alongI ? this.ni : this.nj;
    const at = alongI ? i : j;
    const k = (a: number) => (alongI ? a * this.nj + j : i * this.nj + a) * 3;
    const me = k(at);
    const fwdSame = at + 1 < n && this.same(me, k(at + 1));
    const bwdSame = at > 0 && this.same(me, k(at - 1));
    let lo = at;
    let hi = at;
    if (fwdSame && bwdSame) {
      // A point repeated on both sides (the whole strip is one point here): use the next distinct ones.
      hi = at + 1;
      while (hi < n - 1 && this.same(me, k(hi))) hi++;
      lo = at - 1;
      while (lo > 0 && this.same(me, k(lo))) lo--;
    } else if (fwdSame) {
      lo = Math.max(0, at - 1);
    } else if (bwdSame) {
      hi = Math.min(n - 1, at + 1);
    } else {
      lo = Math.max(0, at - 1);
      hi = Math.min(n - 1, at + 1);
    }
    const a = k(lo);
    const b = k(hi);
    out[0] = this.p[b] - this.p[a];
    out[1] = this.p[b + 1] - this.p[a + 1];
    out[2] = this.p[b + 2] - this.p[a + 2];
  }

  /** Vertex normals; `flip` reverses them (the grid order decides which way Ti × Tj points). */
  normals(flip = false): Float64Array {
    const base = (this.nrm ??= this.computeNormals());
    if (!flip) return base;
    const out = new Float64Array(base.length);
    for (let k = 0; k < base.length; k++) out[k] = -base[k];
    return out;
  }

  private computeNormals(): Float64Array {
    const out = new Float64Array(this.ni * this.nj * 3);
    const ti = [0, 0, 0];
    const tj = [0, 0, 0];
    const bad: number[] = [];
    for (let i = 0; i < this.ni; i++) {
      for (let j = 0; j < this.nj; j++) {
        this.tangent(i, j, true, ti);
        this.tangent(i, j, false, tj);
        const nx = ti[1] * tj[2] - ti[2] * tj[1];
        const ny = ti[2] * tj[0] - ti[0] * tj[2];
        const nz = ti[0] * tj[1] - ti[1] * tj[0];
        const l = Math.hypot(nx, ny, nz);
        const k = (i * this.nj + j) * 3;
        if (l < 1e-12) {
          bad.push(i, j);
          continue;
        }
        out[k] = nx / l;
        out[k + 1] = ny / l;
        out[k + 2] = nz / l;
      }
    }
    // Degenerate points (a strip collapsed to a line): borrow the nearest neighbour's normal along j.
    for (let b = 0; b < bad.length; b += 2) {
      const i = bad[b];
      const j = bad[b + 1];
      const k = (i * this.nj + j) * 3;
      search: for (let d = 1; d < this.nj; d++) {
        for (const jj of [j - d, j + d]) {
          if (jj < 0 || jj >= this.nj) continue;
          const kk = (i * this.nj + jj) * 3;
          if (out[kk] !== 0 || out[kk + 1] !== 0 || out[kk + 2] !== 0) {
            out[k] = out[kk];
            out[k + 1] = out[kk + 1];
            out[k + 2] = out[kk + 2];
            break search;
          }
        }
      }
    }
    return out;
  }

  /**
   * Emit the quads into buckets. pick(i, j) chooses the bucket for the quad (i..i+1, j..j+1), or -1 to
   * leave it out; uv(i, j, bucket) maps a vertex. With `mirror` a second copy is emitted at -x (the
   * left side) with the winding reversed.
   */
  emit(
    buckets: Bucket[],
    pick: (i: number, j: number) => number,
    uv: (i: number, j: number, bucket: number) => readonly [number, number],
    opts: { flip?: boolean; mirror?: boolean } = {},
  ): void {
    const nrm = this.normals(opts.flip);
    const p = this.p;
    const nj = this.nj;
    for (const b of buckets) b.resetKeys();
    const sides = opts.mirror ? [1, -1] : [1];
    for (const sx of sides) {
      const vert = (bk: Bucket, b: number, i: number, j: number) => {
        const k = (i * nj + j) * 3;
        const [u, v] = uv(i, j, b);
        return bk.vertex((sx < 0 ? 1 : 0) + 2 * (i * nj + j), p[k] * sx, p[k + 1], p[k + 2], nrm[k] * sx, nrm[k + 1], nrm[k + 2], u, v);
      };
      for (let i = 0; i < this.ni - 1; i++) {
        for (let j = 0; j < nj - 1; j++) {
          const b = pick(i, j);
          if (b < 0) continue;
          const a0 = (i * nj + j) * 3;
          const a1 = ((i + 1) * nj + j) * 3;
          const a2 = ((i + 1) * nj + j + 1) * 3;
          const a3 = (i * nj + j + 1) * 3;
          // Zero-area strips between doubled rows or columns are the creases themselves.
          if ((this.same(a0, a1) && this.same(a3, a2)) || (this.same(a0, a3) && this.same(a1, a2))) continue;
          const bk = buckets[b];
          const v0 = vert(bk, b, i, j);
          const v1 = vert(bk, b, i + 1, j);
          const v2 = vert(bk, b, i + 1, j + 1);
          const v3 = vert(bk, b, i, j + 1);
          const forward = !opts.flip !== sx < 0;
          if (forward) {
            if (!this.same(a0, a1) && !this.same(a1, a2)) bk.tri(v0, v1, v2);
            if (!this.same(a0, a3) && !this.same(a2, a3)) bk.tri(v0, v2, v3);
          } else {
            if (!this.same(a0, a1) && !this.same(a1, a2)) bk.tri(v0, v2, v1);
            if (!this.same(a0, a3) && !this.same(a2, a3)) bk.tri(v0, v3, v2);
          }
        }
      }
    }
  }
}

/** Monotone cubic through (x, y) keys (x ascending): smooth, never overshoots between keys. */
export function curve(keys: readonly (readonly [number, number])[]): (x: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else i = mid;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
