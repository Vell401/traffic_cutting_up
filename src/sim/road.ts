import { type Rng, range } from '../core/rng';

/*
 * The road is defined by its curvature profile κ(s): long straights and gentle arcs
 * joined by clothoid transitions (curvature changes linearly). Positions and headings
 * are integrated from κ into a table with a 2 m step, stored in 100 m chunks.
 *
 * Heading convention: th = 0 points to -Z (into the screen), th grows when turning right.
 * Forward = (sin th, -cos th) in (x, z); right normal = (cos th, sin th).
 */

export const SAMPLE_DS = 2;
export const CHUNK_SAMPLES = 50;
export const CHUNK_LEN = SAMPLE_DS * CHUNK_SAMPLES;
export const MIN_RADIUS = 1200;
export const MAX_RADIUS = 3000;

export interface RoadPoint {
  x: number;
  z: number;
  th: number;
  k: number;
}

export class RoadChunk {
  index = 0;
  readonly x = new Float64Array(CHUNK_SAMPLES + 1);
  readonly z = new Float64Array(CHUNK_SAMPLES + 1);
  readonly th = new Float64Array(CHUNK_SAMPLES + 1);
  readonly k = new Float64Array(CHUNK_SAMPLES + 1);
  get s0(): number {
    return this.index * CHUNK_LEN;
  }
}

interface Segment {
  len: number;
  k0: number;
  k1: number;
}

export class CurvatureProfile {
  private segs: Segment[] = [];
  private pos = 0;

  constructor(
    private readonly rng: Rng,
    straightStart = 700,
  ) {
    this.segs.push({ len: straightStart, k0: 0, k1: 0 });
  }

  /** Curvature at the current position, then advance by ds. Heading is used to steer the road back toward its base direction. */
  next(ds: number, heading: number): number {
    let seg = this.segs[0];
    while (this.pos >= seg.len) {
      this.pos -= seg.len;
      this.segs.shift();
      if (this.segs.length === 0) this.plan(heading);
      seg = this.segs[0];
    }
    const k = seg.k0 + (seg.k1 - seg.k0) * (this.pos / seg.len);
    this.pos += ds;
    return k;
  }

  private plan(heading: number): void {
    const r = this.rng;
    this.segs.push({ len: range(r, 400, 1500), k0: 0, k1: 0 });

    let sign = r() < 0.5 ? -1 : 1;
    if (heading > 0.35) sign = -1;
    else if (heading < -0.35) sign = 1;
    const k = sign / range(r, MIN_RADIUS, MAX_RADIUS);
    this.segs.push({ len: range(r, 150, 300), k0: 0, k1: k });
    this.segs.push({ len: range(r, 150, 700), k0: k, k1: k });

    if (r() < 0.3) {
      // S-bend: flow straight into an opposite, slightly wider arc.
      const k2 = -sign / range(r, MIN_RADIUS * 1.2, MAX_RADIUS);
      this.segs.push({ len: range(r, 250, 400), k0: k, k1: k2 });
      this.segs.push({ len: range(r, 150, 500), k0: k2, k1: k2 });
      this.segs.push({ len: range(r, 150, 300), k0: k2, k1: 0 });
    } else {
      this.segs.push({ len: range(r, 150, 300), k0: k, k1: 0 });
    }
  }
}

export class Road {
  readonly chunks: RoadChunk[] = [];
  /** Bumps whenever chunks are added or dropped. */
  version = 0;
  private readonly profile: CurvatureProfile;
  private readonly free: RoadChunk[] = [];
  private nextIndex = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastTh = 0;
  private lastK: number;

  constructor(rng: Rng) {
    this.profile = new CurvatureProfile(rng);
    this.lastK = this.profile.next(SAMPLE_DS, 0);
  }

  /** Keep chunks covering [sMin, sMax]. */
  ensure(sMin: number, sMax: number): void {
    let changed = false;
    while (this.nextIndex * CHUNK_LEN < sMax) {
      this.chunks.push(this.generate());
      changed = true;
    }
    while (this.chunks.length > 1 && (this.chunks[0].index + 1) * CHUNK_LEN < sMin) {
      this.free.push(this.chunks.shift()!);
      changed = true;
    }
    if (changed) this.version++;
  }

  get sStart(): number {
    return this.chunks[0].s0;
  }

  get sEnd(): number {
    return this.nextIndex * CHUNK_LEN;
  }

  sample(s: number, out: RoadPoint): RoadPoint {
    const chunks = this.chunks;
    let ci = Math.floor(s / CHUNK_LEN) - chunks[0].index;
    if (ci < 0) ci = 0;
    else if (ci >= chunks.length) ci = chunks.length - 1;
    const c = chunks[ci];
    const u = (s - c.s0) / SAMPLE_DS;
    let i = Math.floor(u);
    if (i < 0) i = 0;
    else if (i > CHUNK_SAMPLES - 1) i = CHUNK_SAMPLES - 1;
    const t = u - i;
    out.x = c.x[i] + (c.x[i + 1] - c.x[i]) * t;
    out.z = c.z[i] + (c.z[i + 1] - c.z[i]) * t;
    out.th = c.th[i] + (c.th[i + 1] - c.th[i]) * t;
    out.k = c.k[i] + (c.k[i + 1] - c.k[i]) * t;
    return out;
  }

  curvature(s: number): number {
    return this.sample(s, scratch).k;
  }

  /** World position of road coordinates (s, d); heading of the road there. */
  toWorld(s: number, d: number, out: RoadPoint): RoadPoint {
    this.sample(s, out);
    out.x += Math.cos(out.th) * d;
    out.z += Math.sin(out.th) * d;
    return out;
  }

  private generate(): RoadChunk {
    const c = this.free.pop() ?? new RoadChunk();
    c.index = this.nextIndex++;
    c.x[0] = this.lastX;
    c.z[0] = this.lastZ;
    c.th[0] = this.lastTh;
    c.k[0] = this.lastK;
    for (let j = 1; j <= CHUNK_SAMPLES; j++) {
      const k = this.profile.next(SAMPLE_DS, c.th[j - 1]);
      const th = c.th[j - 1] + 0.5 * (c.k[j - 1] + k) * SAMPLE_DS;
      const thm = 0.5 * (c.th[j - 1] + th);
      c.k[j] = k;
      c.th[j] = th;
      c.x[j] = c.x[j - 1] + Math.sin(thm) * SAMPLE_DS;
      c.z[j] = c.z[j - 1] - Math.cos(thm) * SAMPLE_DS;
    }
    this.lastX = c.x[CHUNK_SAMPLES];
    this.lastZ = c.z[CHUNK_SAMPLES];
    this.lastTh = c.th[CHUNK_SAMPLES];
    this.lastK = c.k[CHUNK_SAMPLES];
    return c;
  }
}

const scratch: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
