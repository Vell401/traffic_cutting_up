import { smoothstep } from '../core/math';
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

/*
 * Sections give the drive variety. Each 100 m chunk belongs to one of them:
 *   open    – at grade, street lamps, city behind the barriers
 *   walls   – tall noise barriers on both sides
 *   viaduct – elevated deck, ground ~11 m below, city around and under
 *   tunnel  – enclosed, ceiling light rows, hill above
 *   bridge  – long cable-stayed bridge over water; only ever entered and left via a viaduct,
 *             because the road has to be up in the air before it can cross the bay
 */
export type SectionKind = 'open' | 'walls' | 'viaduct' | 'tunnel' | 'bridge';
export type LightKind = 'sodium' | 'led';

/** Ground height beside the road for each section; changes blend over ±GROUND_BLEND around a boundary. */
export const GROUND_LEVEL: Record<SectionKind, number> = { open: 0, walls: 0, viaduct: -11, tunnel: 12, bridge: -32 };
export const GROUND_BLEND = 60;

const NEXT_KIND: Record<SectionKind, [SectionKind, number][]> = {
  open: [['walls', 2], ['viaduct', 2.2], ['tunnel', 1.4]],
  walls: [['open', 2], ['viaduct', 1.2], ['tunnel', 1.2]],
  viaduct: [['open', 2], ['walls', 1], ['bridge', 1.1]],
  tunnel: [['open', 2], ['walls', 1]],
  bridge: [['viaduct', 1]],
};
/** Section length in chunks. */
const KIND_LEN: Record<SectionKind, [number, number]> = {
  open: [6, 16],
  walls: [4, 10],
  viaduct: [5, 14],
  tunnel: [3, 9],
  bridge: [6, 10],
};

interface SectionSlot {
  kind: SectionKind;
  light: LightKind;
  /** Chunk position within its section and the section's length (bridge pylons need them). */
  index: number;
  length: number;
  /** Past the end of a finite scripted track. */
  end?: boolean;
  /** Set by scripted tracks; random tracks leave them undefined and let the road decide. */
  gantry?: boolean;
  overpass?: boolean;
}

interface Planner {
  next(): SectionSlot;
}

/** One section of a scripted track; gantry/overpass list chunk indexes within the section. */
export interface SectionStep {
  kind: SectionKind;
  light: LightKind;
  chunks: number;
  gantry?: number[];
  overpass?: number[];
}

/** Curvature segment: κ goes linearly from k0 to k1 over len metres. */
export interface CurveStep {
  len: number;
  k0: number;
  k1: number;
}

/** Hand-made track (test showcases, the online ring). Finite unless `loop` or `ring` is set. */
export interface RoadScript {
  sections: SectionStep[];
  curves: CurveStep[];
  loop?: boolean;
  /**
   * Closed ring: one lap (the sections' total length) is generated once and repeated exactly, so the
   * same s modulo the lap length is the same place on every lap. The curves must turn ±2π per lap.
   */
  ring?: boolean;
}

class ScriptedPlanner implements Planner {
  private step = 0;
  private chunk = 0;
  private done = false;

  constructor(
    private readonly steps: SectionStep[],
    private readonly loop: boolean,
  ) {}

  next(): SectionSlot {
    let st = this.steps[this.step];
    if (!this.done && this.chunk >= st.chunks) {
      if (this.step + 1 < this.steps.length || this.loop) {
        this.step = (this.step + 1) % this.steps.length;
        this.chunk = 0;
        st = this.steps[this.step];
      } else {
        this.done = true;
      }
    }
    if (this.done) return { kind: st.kind, light: st.light, index: 0, length: 1, end: true, gantry: false, overpass: false };
    const i = this.chunk++;
    return {
      kind: st.kind,
      light: st.light,
      index: i,
      length: st.chunks,
      gantry: st.gantry?.includes(i) ?? false,
      overpass: st.overpass?.includes(i) ?? false,
    };
  }
}

export class SectionPlanner implements Planner {
  private kind: SectionKind = 'open';
  private light: LightKind = 'sodium';
  private left: number;
  private length: number;

  constructor(
    private readonly rng: Rng,
    openStart = 8,
  ) {
    this.left = this.length = openStart;
  }

  next(): SectionSlot {
    if (this.left <= 0) this.pick();
    this.left--;
    return { kind: this.kind, light: this.light, index: this.length - this.left - 1, length: this.length };
  }

  private pick(): void {
    const r = this.rng;
    const opts = NEXT_KIND[this.kind];
    let total = 0;
    for (const [, w] of opts) total += w;
    let x = r() * total;
    let kind = opts[0][0];
    for (const [k, w] of opts) {
      x -= w;
      if (x <= 0) {
        kind = k;
        break;
      }
    }
    const [lo, hi] = KIND_LEN[kind];
    this.kind = kind;
    this.left = this.length = lo + Math.floor(r() * (hi - lo + 1));
    this.light = r() < 0.5 ? 'sodium' : 'led';
  }
}

export class RoadChunk {
  index = 0;
  kind: SectionKind = 'open';
  prevKind: SectionKind = 'open';
  nextKind: SectionKind = 'open';
  light: LightKind = 'sodium';
  /** Overhead sign gantry / crossing overpass in the middle of this chunk. */
  gantry = false;
  overpass = false;
  /** Position within the section (0-based) and the section length, in chunks. */
  sectionIndex = 0;
  sectionLen = 1;
  /** Beyond the end of a finite track: nothing is drawn here. */
  void = false;
  /** Seed for the renderer's own randomness (building layout etc.), stable for the chunk's lifetime. */
  seed = 0;
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
    private readonly script?: CurveStep[],
  ) {
    if (script) this.segs.push(...script.map((c) => ({ ...c })));
    else this.segs.push({ len: straightStart, k0: 0, k1: 0 });
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
    if (this.script) {
      this.segs.push(...this.script.map((c) => ({ ...c })));
      return;
    }
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
  /** Where a finite (scripted) track ends; Infinity for the endless road. */
  endS = Infinity;
  /** Lap length of a closed ring; Infinity for open roads. */
  readonly ringLen: number = Infinity;
  /** Heading gained over one lap of the ring (±2π). */
  private ringTurn = 0;
  /** One lap of chunks; chunk i of the ring is a copy of template[i mod n]. */
  private readonly template: RoadChunk[] | null = null;
  private readonly profile: CurvatureProfile;
  private readonly planner: Planner;
  private pending: SectionSlot;
  private lastKind: SectionKind = 'open';
  private sinceGantry = 0;
  private sinceOverpass = 0;
  private readonly free: RoadChunk[] = [];
  private nextIndex = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastTh = 0;
  private lastK: number;

  constructor(
    private readonly rng: Rng,
    script?: RoadScript,
  ) {
    this.profile = new CurvatureProfile(rng, 700, script?.curves);
    this.planner = script ? new ScriptedPlanner(script.sections, !!script.loop) : new SectionPlanner(rng);
    this.pending = this.planner.next();
    this.lastK = this.profile.next(SAMPLE_DS, 0);
    if (script?.ring) {
      let n = 0;
      for (const st of script.sections) n += st.chunks;
      const tpl: RoadChunk[] = [];
      for (let i = 0; i < n; i++) tpl.push(this.generate());
      this.closeRing(tpl);
      this.template = tpl;
      this.ringLen = n * CHUNK_LEN;
      this.nextIndex = 0;
    }
  }

  /**
   * Seal one generated lap into a ring: the neighbours of the first and last chunk wrap around, and the
   * (tiny, numerical) gap between the lap's end and its start is spread along the lap.
   */
  private closeRing(tpl: RoadChunk[]): void {
    const n = tpl.length;
    const first = tpl[0];
    const last = tpl[n - 1];
    first.prevKind = last.kind;
    last.nextKind = first.kind;
    const ex = last.x[CHUNK_SAMPLES] - first.x[0];
    const ez = last.z[CHUNK_SAMPLES] - first.z[0];
    const len = n * CHUNK_LEN;
    for (const c of tpl) {
      for (let j = 0; j <= CHUNK_SAMPLES; j++) {
        const f = (c.s0 + j * SAMPLE_DS) / len;
        c.x[j] -= ex * f;
        c.z[j] -= ez * f;
      }
    }
    this.ringTurn = last.th[CHUNK_SAMPLES] - first.th[0];
  }

  /** Shortest signed distance from b to a along the road (wraps on a ring). */
  rel(a: number, b: number): number {
    const x = a - b;
    const L = this.ringLen;
    return L === Infinity ? x : x - L * Math.round(x / L);
  }

  /** Keep chunks covering [sMin, sMax]. */
  ensure(sMin: number, sMax: number): void {
    let changed = false;
    if (this.template) {
      // A ring can be entered anywhere (and teleported along): start over at sMin when it is not
      // reachable by appending to the chunks we have.
      const first = Math.floor(sMin / CHUNK_LEN);
      if (this.chunks.length === 0 || first > this.nextIndex || first < this.chunks[0].index - 8) {
        while (this.chunks.length > 0) this.free.push(this.chunks.pop()!);
        this.nextIndex = first;
        changed = true;
      }
      while (this.chunks.length > 0 && first < this.chunks[0].index) {
        this.chunks.unshift(this.ringChunk(this.template, this.chunks[0].index - 1));
        changed = true;
      }
    }
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
    if (this.template) return this.sampleRing(this.template, s, out);
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

  /**
   * A ring is sampled straight from its one-lap template, at any s, without loaded chunks: the server
   * (drivers on different laps) and a client compute exactly the same numbers for the same s.
   */
  private sampleRing(tpl: RoadChunk[], s: number, out: RoadPoint): RoadPoint {
    const n = tpl.length;
    const index = Math.floor(s / CHUNK_LEN);
    const c = tpl[((index % n) + n) % n];
    const u = (s - index * CHUNK_LEN) / SAMPLE_DS;
    let i = Math.floor(u);
    if (i < 0) i = 0;
    else if (i > CHUNK_SAMPLES - 1) i = CHUNK_SAMPLES - 1;
    const t = u - i;
    out.x = c.x[i] + (c.x[i + 1] - c.x[i]) * t;
    out.z = c.z[i] + (c.z[i + 1] - c.z[i]) * t;
    out.th = c.th[i] + (c.th[i + 1] - c.th[i]) * t + Math.floor(index / n) * this.ringTurn;
    out.k = c.k[i] + (c.k[i + 1] - c.k[i]) * t;
    return out;
  }

  curvature(s: number): number {
    return this.sample(s, scratch).k;
  }

  chunkAt(s: number): RoadChunk {
    const chunks = this.chunks;
    let ci = Math.floor(s / CHUNK_LEN) - chunks[0].index;
    if (ci < 0) ci = 0;
    else if (ci >= chunks.length) ci = chunks.length - 1;
    return chunks[ci];
  }

  /**
   * Height of the terrain beside the road at s, blended smoothly across section boundaries.
   * Water under a bridge stays flat: the shore slope is done inside the neighbouring viaduct chunk.
   */
  groundY(s: number): number {
    const c = this.chunkAt(s);
    const level = GROUND_LEVEL[c.kind];
    const fromStart = s - c.s0;
    const toEnd = c.s0 + CHUNK_LEN - s;
    if (c.kind === 'bridge') return level;
    if (c.nextKind === 'bridge') return level + (GROUND_LEVEL.bridge - level) * smoothstep(fromStart / CHUNK_LEN);
    if (c.prevKind === 'bridge') return GROUND_LEVEL.bridge + (level - GROUND_LEVEL.bridge) * smoothstep(fromStart / CHUNK_LEN);
    if (fromStart < GROUND_BLEND && GROUND_LEVEL[c.prevKind] !== level) {
      const a = GROUND_LEVEL[c.prevKind];
      return a + (level - a) * smoothstep((fromStart + GROUND_BLEND) / (2 * GROUND_BLEND));
    }
    if (toEnd < GROUND_BLEND && GROUND_LEVEL[c.nextKind] !== level) {
      const b = GROUND_LEVEL[c.nextKind];
      return level + (b - level) * smoothstep((GROUND_BLEND - toEnd) / (2 * GROUND_BLEND));
    }
    return level;
  }

  /** World position of road coordinates (s, d); heading of the road there. */
  toWorld(s: number, d: number, out: RoadPoint): RoadPoint {
    this.sample(s, out);
    out.x += Math.cos(out.th) * d;
    out.z += Math.sin(out.th) * d;
    return out;
  }

  /** Chunk `index` of the ring: a copy of its template chunk, heading continued lap after lap. */
  private ringChunk(tpl: RoadChunk[], index: number): RoadChunk {
    const n = tpl.length;
    const t = tpl[((index % n) + n) % n];
    const dth = Math.floor(index / n) * this.ringTurn;
    const c = this.free.pop() ?? new RoadChunk();
    c.index = index;
    c.kind = t.kind;
    c.prevKind = t.prevKind;
    c.nextKind = t.nextKind;
    c.light = t.light;
    c.gantry = t.gantry;
    c.overpass = t.overpass;
    c.sectionIndex = t.sectionIndex;
    c.sectionLen = t.sectionLen;
    c.void = false;
    c.seed = t.seed;
    c.x.set(t.x);
    c.z.set(t.z);
    c.k.set(t.k);
    for (let j = 0; j <= CHUNK_SAMPLES; j++) c.th[j] = t.th[j] + dth;
    return c;
  }

  private generate(): RoadChunk {
    if (this.template) return this.ringChunk(this.template, this.nextIndex++);
    const c = this.free.pop() ?? new RoadChunk();
    c.index = this.nextIndex++;
    const slot = this.pending;
    this.pending = this.planner.next();
    c.kind = slot.kind;
    c.light = slot.light;
    c.sectionIndex = slot.index;
    c.sectionLen = slot.length;
    c.void = !!slot.end;
    if (c.void && this.endS === Infinity) this.endS = c.s0;
    c.prevKind = this.lastKind;
    c.nextKind = this.pending.kind;
    this.lastKind = slot.kind;
    const stable = c.prevKind === c.kind && c.nextKind === c.kind;
    this.sinceGantry++;
    this.sinceOverpass++;
    c.gantry = c.overpass = false;
    if (slot.gantry !== undefined) {
      c.gantry = slot.gantry;
      c.overpass = !!slot.overpass;
    } else if (stable && c.kind !== 'tunnel' && this.sinceGantry >= 8 && this.rng() < 0.3) {
      c.gantry = true;
      this.sinceGantry = 0;
    } else if (stable && c.kind === 'open' && this.sinceOverpass >= 6 && this.rng() < 0.25) {
      c.overpass = true;
      this.sinceOverpass = 0;
    }
    c.seed = Math.floor(this.rng() * 2 ** 31);
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
