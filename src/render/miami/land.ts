import * as THREE from 'three';
import { mulberry32, range, type Rng } from '../../core/rng';
import { miamiChunk, miamiZone } from '../../sim/miami';
import { CHUNK_LEN, SAMPLE_DS, type Road, type RoadChunk } from '../../sim/road';
import { ROWS, type ChunkFrames, type Frame, type MeshBuilder } from '../meshBuilder';
import {
  MIAMI_DECK, MIAMI_OUT, MIAMI_SEABED, MIAMI_WALK, MIAMI_WATER, SURFACE,
  miamiGround, miamiIslandHalfWidth, miamiIslandY, miamiIslands, miamiProfileY, miamiScene, miamiSection,
  type MiamiIsland, type MiamiScene, type MiamiSceneId, type MiamiSection, type Surface,
} from './terrain';

/*
 * Everything of one Miami chunk that is not the road itself: the ground on both sides with its
 * surface bands and shore, islands, kerbs, side streets, hedges, seawalls, the downtown people-mover
 * and the cheap facade buildings that fill the blocks behind the modelled front row.
 *
 * All of it is merged into two meshes (land and facades) plus a few painted lines.
 */

export interface LandBuilders {
  /** Ground and solid dressing; has uv (metres) and a texture layer per vertex. */
  land: MeshBuilder;
  /** Unlit paint. */
  glow: MeshBuilder;
  /** Facade buildings (aWin). */
  city: MeshBuilder;
}

interface Ctx extends LandBuilders {
  c: RoadChunk;
  road: Road;
  fr: ChunkFrames;
  /** Road-side ground level per row. */
  gy: Float64Array;
  /** Lap distance of row 0, and the texture v of row 0 (kept small for float precision). */
  lap0: number;
  v0: number;
}

/** Above the water surface by enough to be seen. */
const DRY = MIAMI_WATER + 0.25;
const WHITE: readonly [number, number, number] = [1, 1, 1];
const CITY_SCENES: ReadonlySet<MiamiSceneId> = new Set<MiamiSceneId>(['strip', 'towers', 'arts', 'lush', 'villas']);
/** Outer kerb of the frontage road / where a side street starts, by scene. */
const STREET_FROM: Partial<Record<MiamiSceneId, number>> = { strip: 26, towers: 27, arts: 26.5, lush: 25, villas: 22.5 };
const STREET_HALF = 4.5;

const srgb = (hex: number): THREE.Color => new THREE.Color(hex);
const PASTELS = [0xf3e6d2, 0xf6c9b8, 0xbfe3d4, 0xf7e2a6, 0xbcd9ee, 0xfaf4ea, 0xf2b6c2, 0xd8ecc4].map(srgb);
const OFFICE = [0xdfe6ea, 0xb9c6cf, 0xeef0ee, 0xc9d3d6, 0xa8b7c2, 0xe9e2d6].map(srgb);
const WAREHOUSE = [0xe8dcc8, 0xd9725a, 0x4fb6ad, 0xf0c04a, 0x8f6bb8, 0xcfd3d6, 0xe98fa6, 0x5a8fd0].map(srgb);
const ROOF = srgb(0x8e8f8c);
const PAINT = srgb(0xd8d6cc);

const sec: MiamiSection = { shore: 0, slope: 0, bankFrom: 0, bankTo: 0, drop: 0 };
const frame: Frame = { x: 0, z: 0, th: 0 };
const MAX_POINTS = 16;
const rowD = new Float64Array(ROWS * MAX_POINTS);
const rowY = new Float64Array(ROWS * MAX_POINTS);
const rowShore = new Float64Array(ROWS);

function tint(mb: MeshBuilder, surface: Surface, t: readonly [number, number, number] = WHITE): void {
  mb.layer = surface;
  mb.rgb(t[0], t[1], t[2]);
}

/** One ground quad between rows i and i + 1, lateral offsets given as distances from the centre line. */
function groundQuad(ctx: Ctx, side: number, i: number, a0: number, ya0: number, a1: number, ya1: number, b0: number, yb0: number, b1: number, yb1: number): void {
  const { fr, land } = ctx;
  const j = i + 1;
  const dd = a1 - a0 > 1e-3 ? a1 - a0 : b1 - b0;
  const dy = a1 - a0 > 1e-3 ? ya1 - ya0 : yb1 - yb0;
  const len = Math.hypot(dd, dy) || 1;
  const nd = (-dy / len) * side;
  const ny = dd / len;
  const vi = ctx.v0 + i * SAMPLE_DS;
  const vj = vi + SAMPLE_DS;
  const p = land.v(fr.bx[i] + fr.cs[i] * a0 * side, ya0, fr.bz[i] + fr.sn[i] * a0 * side, fr.cs[i] * nd, ny, fr.sn[i] * nd, a0, vi);
  const q = land.v(fr.bx[i] + fr.cs[i] * a1 * side, ya1, fr.bz[i] + fr.sn[i] * a1 * side, fr.cs[i] * nd, ny, fr.sn[i] * nd, a1, vi);
  const r = land.v(fr.bx[j] + fr.cs[j] * b1 * side, yb1, fr.bz[j] + fr.sn[j] * b1 * side, fr.cs[j] * nd, ny, fr.sn[j] * nd, b1, vj);
  const t = land.v(fr.bx[j] + fr.cs[j] * b0 * side, yb0, fr.bz[j] + fr.sn[j] * b0 * side, fr.cs[j] * nd, ny, fr.sn[j] * nd, b0, vj);
  if (side > 0) land.quad(p, q, r, t);
  else land.quad(q, p, t, r);
}

/** The land profile of one side: surface bands out to the shore, then the shore slope. */
function ground(ctx: Ctx, side: number, scene: MiamiScene): void {
  const bands = scene.bands;
  const points = bands.length + 4;
  for (let i = 0; i < ROWS; i++) {
    miamiSection(ctx.lap0 + i * SAMPLE_DS, side, sec);
    const base = ctx.gy[i];
    // Level ground starts at the walkway; where the road-side ground leaves road level it meets the deck face.
    const start = Math.abs(base) > 0.05 ? MIAMI_DECK : MIAMI_WALK;
    const shore = Math.max(sec.shore, start);
    const clampD = (d: number) => (d < start ? start : d > shore ? shore : d);
    const o = i * MAX_POINTS;
    let n = 0;
    rowD[o + n++] = start;
    for (let k = 0; k < bands.length - 1; k++) rowD[o + n++] = clampD(bands[k].to);
    rowD[o + n++] = clampD(sec.bankFrom);
    rowD[o + n++] = clampD(sec.bankTo);
    rowD[o + n++] = shore;
    // Insertion sort: a handful of nearly sorted numbers.
    for (let a = 1; a < n; a++) {
      const value = rowD[o + a];
      let b = a - 1;
      while (b >= 0 && rowD[o + b] > value) {
        rowD[o + b + 1] = rowD[o + b];
        b--;
      }
      rowD[o + b + 1] = value;
    }
    rowD[o + n++] = shore + sec.slope;
    for (let k = 0; k < n; k++) rowY[o + k] = miamiProfileY(base, sec, rowD[o + k]);
    rowShore[i] = shore;
  }
  for (let i = 0; i < ROWS - 1; i++) {
    const a = i * MAX_POINTS;
    const b = a + MAX_POINTS;
    for (let k = 0; k < points - 1; k++) {
      const a0 = rowD[a + k], a1 = rowD[a + k + 1], b0 = rowD[b + k], b1 = rowD[b + k + 1];
      if (a1 - a0 < 1e-3 && b1 - b0 < 1e-3) continue;
      const ya0 = rowY[a + k], ya1 = rowY[a + k + 1], yb0 = rowY[b + k], yb1 = rowY[b + k + 1];
      // Under the opaque bay: never seen.
      if (Math.max(ya0, ya1, yb0, yb1) < MIAMI_WATER - 0.3) continue;
      const wide = a1 - a0 > 1e-3;
      const mid = wide ? (a0 + a1) / 2 : (b0 + b1) / 2;
      if (mid >= (wide ? rowShore[i] : rowShore[i + 1]) - 1e-6) tint(ctx.land, scene.edge, scene.edgeTint);
      else {
        let band = bands[bands.length - 1];
        for (const candidate of bands) if (candidate.to > mid) { band = candidate; break; }
        tint(ctx.land, band.surface, band.tint);
      }
      groundQuad(ctx, side, i, a0, ya0, a1, ya1, b0, yb0, b1, yb1);
    }
  }
}

/** An island: a lateral fan of columns per row, rock or sand on the rim, its own surface on top. */
function island(ctx: Ctx, isl: MiamiIsland): void {
  const rim: Surface = isl.kind === 'beach' ? SURFACE.sand : isl.kind === 'mangrove' ? SURFACE.planting : SURFACE.rock;
  const rimTint: readonly [number, number, number] = isl.kind === 'beach' ? [0.76, 0.72, 0.64] : isl.kind === 'mangrove' ? [0.7, 0.8, 0.6] : WHITE;
  // Columns as fractions: the two outer ones span the rim, the inner ones the flat top.
  const d = new Float64Array(7);
  const y = new Float64Array(7);
  const pd = new Float64Array(7);
  const py = new Float64Array(7);
  let have = false;
  for (let i = 0; i < ROWS; i++) {
    const s = ctx.lap0 + i * SAMPLE_DS;
    const hw = miamiIslandHalfWidth(isl, s);
    if (hw <= 0) {
      have = false;
      continue;
    }
    // Inside this half-width the island is at full height (see RIM in terrain.ts).
    const u2 = 1 - (hw / isl.w) ** 2;
    const pw = isl.w * Math.sqrt(Math.max(0, 0.7 - u2));
    const cols = [-hw, -pw, -pw * 0.5, 0, pw * 0.5, pw, hw];
    for (let k = 0; k < 7; k++) {
      d[k] = isl.d + cols[k];
      y[k] = k === 0 || k === 6 ? MIAMI_SEABED : miamiIslandY(isl, s, d[k]);
    }
    if (have) {
      for (let k = 0; k < 6; k++) {
        if (Math.max(py[k], py[k + 1], y[k], y[k + 1]) < MIAMI_WATER - 0.3) continue;
        if (k === 0 || k === 5) tint(ctx.land, rim, rimTint);
        else tint(ctx.land, isl.surface);
        // Signed lateral offsets: reuse the ground quad with side = +1.
        groundQuad(ctx, 1, i - 1, pd[k], py[k], pd[k + 1], py[k + 1], d[k], y[k], d[k + 1], y[k + 1]);
      }
    }
    pd.set(d);
    py.set(y);
    have = true;
  }
}

/** Box standing on the land at frame f: sides and top, UVs in metres. */
function block(mb: MeshBuilder, f: Frame, d: number, y0: number, y1: number, hx: number, hz: number, bottom = false): void {
  const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
  const cx = f.x + rx * d, cz = f.z + rz * d;
  const corner = (a: number, b: number, y: number, nx: number, ny: number, nz: number, u: number, v: number) =>
    mb.v(cx + rx * a * hx + fx * b * hz, y, cz + rz * a * hx + fz * b * hz, nx, ny, nz, u, v);
  // [normal across, normal along, corner signs of the face's two bottom vertices]
  const sides: [number, number, number, number, number, number, number][] = [
    [1, 0, 1, -1, 1, 1, hz * 2],
    [-1, 0, -1, 1, -1, -1, hz * 2],
    [0, 1, 1, 1, -1, 1, hx * 2],
    [0, -1, -1, -1, 1, -1, hx * 2],
  ];
  for (const [na, nb, a0, b0, a1, b1, width] of sides) {
    const nx = rx * na + fx * nb, nz = rz * na + fz * nb;
    const p = corner(a0, b0, y0, nx, 0, nz, 0, y0);
    const q = corner(a1, b1, y0, nx, 0, nz, width, y0);
    const r = corner(a1, b1, y1, nx, 0, nz, width, y1);
    const t = corner(a0, b0, y1, nx, 0, nz, 0, y1);
    mb.quad(p, q, r, t);
  }
  for (const [y, ny] of bottom ? [[y1, 1], [y0, -1]] : [[y1, 1]]) {
    const p = corner(-1, -1, y, 0, ny, 0, 0, 0);
    const q = corner(1, -1, y, 0, ny, 0, hx * 2, 0);
    const r = corner(1, 1, y, 0, ny, 0, hx * 2, hz * 2);
    const t = corner(-1, 1, y, 0, ny, 0, 0, hz * 2);
    if (ny > 0) mb.quad(p, q, r, t);
    else mb.quad(p, t, r, q);
  }
}

/** Flat patch lying on the ground at frame f (side streets, pads). */
function patch(mb: MeshBuilder, f: Frame, d: number, y: number, hx: number, hz: number): void {
  const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
  const cx = f.x + rx * d, cz = f.z + rz * d;
  const p = mb.v(cx - rx * hx - fx * hz, y, cz - rz * hx - fz * hz, 0, 1, 0, 0, 0);
  const q = mb.v(cx + rx * hx - fx * hz, y, cz + rz * hx - fz * hz, 0, 1, 0, hx * 2, 0);
  const r = mb.v(cx + rx * hx + fx * hz, y, cz + rz * hx + fz * hz, 0, 1, 0, hx * 2, hz * 2);
  const t = mb.v(cx - rx * hx + fx * hz, y, cz - rz * hx + fz * hz, 0, 1, 0, 0, hz * 2);
  mb.quad(p, q, r, t);
}

/**
 * Continuous low wall along the chunk between rows i0 and i1: kerbs, hedges, copings, beams.
 * `inner`/`outer` are distances from the centre line (numbers, or per-row arrays).
 */
function rail(ctx: Ctx, side: number, i0: number, i1: number, inner: number | Float64Array, outer: number | Float64Array,
  bottom: (i: number) => number, height: number, underside = false): void {
  const { fr, land } = ctx;
  const at = (v: number | Float64Array, i: number) => (typeof v === 'number' ? v : v[i]);
  const point = (i: number, ad: number, y: number, nd: number, ny: number, u: number) =>
    land.v(fr.bx[i] + fr.cs[i] * ad * side, y, fr.bz[i] + fr.sn[i] * ad * side, fr.cs[i] * nd * side, ny, fr.sn[i] * nd * side, u, ctx.v0 + i * SAMPLE_DS);
  for (let i = i0; i < i1; i++) {
    const j = i + 1;
    const a0 = at(inner, i), a1 = at(outer, i), b0 = at(inner, j), b1 = at(outer, j);
    const ya = bottom(i), yb = bottom(j);
    const faces: [number, number, number, number, number, number, number, number, number, number][] = [
      // ad at i, y at i (two points), ad at j, y at j, normal across, normal up
      [a0, ya, a0, ya + height, b0, yb, b0, yb + height, -1, 0],
      [a0, ya + height, a1, ya + height, b0, yb + height, b1, yb + height, 0, 1],
      [a1, ya + height, a1, ya, b1, yb + height, b1, yb, 1, 0],
    ];
    if (underside) faces.push([a1, ya, a0, ya, b1, yb, b0, yb, 0, -1]);
    for (const [p0, y0, p1, y1, q0, z0, q1, z1, nd, ny] of faces) {
      const p = point(i, p0, y0, nd, ny, p0 + y0);
      const q = point(i, p1, y1, nd, ny, p1 + y1);
      const r = point(j, q1, z1, nd, ny, q1 + z1);
      const t = point(j, q0, z0, nd, ny, q0 + z0);
      if (side > 0) land.quad(p, q, r, t);
      else land.quad(q, p, t, r);
    }
  }
}

/** Facade building: four window walls (aWin = facade metres, seed, 0) and a flat roof. */
function tower(city: MeshBuilder, f: Frame, d: number, base: number, width: number, depth: number, height: number, color: THREE.Color, seed: number): void {
  const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
  const cx = f.x + rx * d, cz = f.z + rz * d;
  const hx = depth / 2, hz = width / 2;
  city.color(color);
  city.w2 = seed;
  const faces: [number, number, number, number, number, number][] = [
    [rx, rz, fx * hz, fz * hz, width, hx],
    [-rx, -rz, -fx * hz, -fz * hz, width, hx],
    [fx, fz, -rx * hx, -rz * hx, depth, hz],
    [-fx, -fz, rx * hx, rz * hx, depth, hz],
  ];
  for (const [nx, nz, ax, az, span, off] of faces) {
    const ox = cx + nx * off, oz = cz + nz * off;
    city.w3 = 0;
    const ids = [0, 0, 0, 0];
    const corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) {
      const [sh, sv] = corners[k];
      city.w0 = ((sh + 1) / 2) * span;
      city.w1 = sv * height;
      ids[k] = city.v(ox + sh * ax, base + sv * height, oz + sh * az, nx, 0, nz);
    }
    city.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  city.w3 = -1;
  city.w0 = city.w1 = 0;
  city.color(ROOF);
  const top = base + height;
  const p = city.v(cx - rx * hx - fx * hz, top, cz - rz * hx - fz * hz, 0, 1, 0);
  const q = city.v(cx + rx * hx - fx * hz, top, cz + rz * hx - fz * hz, 0, 1, 0);
  const r = city.v(cx + rx * hx + fx * hz, top, cz + rz * hx + fz * hz, 0, 1, 0);
  const t = city.v(cx - rx * hx + fx * hz, top, cz - rz * hx + fz * hz, 0, 1, 0);
  city.quad(p, q, r, t);
}

/** [nearest, farthest offset, min/max height, min/max width, min/max gap, colours] of one row of blocks. */
type Row = readonly [number, number, number, number, number, number, number, number, readonly THREE.Color[]];

const ROWS_BY_SCENE: Partial<Record<MiamiSceneId, readonly Row[]>> = {
  strip: [
    [88, 112, 14, 42, 22, 40, 4, 12, PASTELS],
    [150, 230, 18, 70, 24, 44, 6, 22, PASTELS],
    [280, 420, 26, 110, 26, 46, 10, 34, PASTELS],
    [480, 660, 40, 150, 28, 48, 20, 60, OFFICE],
  ],
  towers: [
    [100, 128, 45, 120, 26, 40, 5, 12, OFFICE],
    [165, 240, 60, 190, 28, 44, 6, 20, OFFICE],
    [290, 430, 70, 240, 30, 48, 8, 30, OFFICE],
    [500, 660, 50, 200, 30, 50, 16, 50, OFFICE],
  ],
  arts: [
    [86, 110, 6, 13, 30, 52, 3, 10, WAREHOUSE],
    [140, 220, 7, 22, 30, 56, 5, 18, WAREHOUSE],
    [280, 420, 16, 60, 28, 46, 10, 36, PASTELS],
    [480, 660, 30, 120, 28, 48, 24, 70, OFFICE],
  ],
  lush: [
    [110, 190, 12, 44, 24, 40, 14, 40, PASTELS],
    [270, 420, 18, 80, 26, 44, 20, 60, PASTELS],
  ],
  villas: [[300, 460, 14, 44, 24, 40, 30, 80, PASTELS]],
  golf: [[480, 660, 24, 70, 28, 44, 60, 140, PASTELS]],
};
/** The city across the water: far shore blocks seen from causeways, the marina and the bay park. */
const FAR_COAST: readonly Row[] = [
  [520, 590, 24, 110, 28, 46, 14, 44, OFFICE],
  [610, 680, 40, 190, 30, 50, 20, 60, OFFICE],
];
const FAR_FROM = 470;
const FAR_TOP = MIAMI_WATER + 0.9;

function blocks(ctx: Ctx, side: number, rows: readonly Row[], rng: Rng, onFarCoast: boolean): void {
  const zone = miamiZone(ctx.c.index);
  for (const [dMin, dMax, hMin, hMax, wMin, wMax, gMin, gMax, colours] of rows) {
    let s = range(rng, 0, 16);
    for (;;) {
      const width = range(rng, wMin, wMax);
      const centre = s + width / 2;
      if (centre > CHUNK_LEN - 3) break;
      s += width + range(rng, gMin, gMax);
      const d = range(rng, dMin, dMax);
      const depth = range(rng, 18, 34);
      // Taller toward the middle of a district, so a district has a skyline, not a flat comb.
      const profile = 0.6 + 0.4 * Math.sin((zone.run + centre / CHUNK_LEN) / zone.runLength * Math.PI);
      const height = hMin + (hMax - hMin) * rng() ** 1.6 * profile;
      const colour = colours[Math.floor(rng() * colours.length)];
      const seed = Math.floor(rng() * 997);
      // Leave side streets and the crossing overpass clear.
      if (!onFarCoast && dMin < 130 && (centre - width / 2 < STREET_HALF + 1 || centre + width / 2 > CHUNK_LEN - STREET_HALF - 1)) continue;
      if (zone.overpass && dMin < 130 && Math.abs(centre - 50) < width / 2 + 12) continue;
      let base = onFarCoast ? FAR_TOP : Math.min(
        miamiGround(ctx.road, ctx.c.s0 + centre, side * d),
        miamiGround(ctx.road, ctx.c.s0 + centre - width / 2, side * d),
        miamiGround(ctx.road, ctx.c.s0 + centre + width / 2, side * d));
      if (!onFarCoast && base < DRY) continue;
      base -= 0.4;
      tower(ctx.city, ctx.fr.at(centre, frame), side * d, base, width, depth, height, colour, seed);
    }
  }
}

/** Land across the bay, far enough to sit in the haze: gives causeways and quays a far shore. */
function farCoast(ctx: Ctx, side: number, rng: Rng): void {
  tint(ctx.land, SURFACE.rock);
  for (let i = 0; i < ROWS - 1; i++) groundQuad(ctx, side, i, FAR_FROM, MIAMI_SEABED, FAR_FROM + 24, FAR_TOP, FAR_FROM, MIAMI_SEABED, FAR_FROM + 24, FAR_TOP);
  tint(ctx.land, SURFACE.grass, [0.8, 0.86, 0.78]);
  for (let i = 0; i < ROWS - 1; i += 5) {
    const j = Math.min(i + 5, ROWS - 1);
    const { fr, land } = ctx;
    const a = FAR_FROM + 24, b = MIAMI_OUT;
    const p = land.v(fr.bx[i] + fr.cs[i] * a * side, FAR_TOP, fr.bz[i] + fr.sn[i] * a * side, 0, 1, 0, a, ctx.v0 + i * SAMPLE_DS);
    const q = land.v(fr.bx[i] + fr.cs[i] * b * side, FAR_TOP, fr.bz[i] + fr.sn[i] * b * side, 0, 1, 0, b, ctx.v0 + i * SAMPLE_DS);
    const r = land.v(fr.bx[j] + fr.cs[j] * b * side, FAR_TOP, fr.bz[j] + fr.sn[j] * b * side, 0, 1, 0, b, ctx.v0 + j * SAMPLE_DS);
    const t = land.v(fr.bx[j] + fr.cs[j] * a * side, FAR_TOP, fr.bz[j] + fr.sn[j] * a * side, 0, 1, 0, a, ctx.v0 + j * SAMPLE_DS);
    if (side > 0) land.quad(p, q, r, t);
    else land.quad(q, p, t, r);
  }
  blocks(ctx, side, FAR_COAST, rng, true);
}

/** Rows of this chunk where the road-side ground is level with the road (no portal hill, no shore dip). */
function levelRows(ctx: Ctx, from: number, to: number): [number, number] | null {
  let i0 = Math.ceil(from / SAMPLE_DS), i1 = Math.floor(to / SAMPLE_DS);
  while (i0 < i1 && Math.abs(ctx.gy[i0]) > 0.02) i0++;
  while (i1 > i0 && Math.abs(ctx.gy[i1]) > 0.02) i1--;
  return i1 - i0 >= 2 ? [i0, i1] : null;
}

const levelAt = (ctx: Ctx, s: number): boolean => Math.abs(ctx.gy[Math.round(s / SAMPLE_DS)]) < 0.02;

/** Side street leaving the frontage road at a chunk boundary, 9 m wide across the two chunks. */
function sideStreets(ctx: Ctx, side: number, scene: MiamiScene): void {
  const from = STREET_FROM[scene.id];
  if (from === undefined) return;
  const to = 340;
  for (const [s, neighbour] of [[STREET_HALF / 2, ctx.c.index - 1], [CHUNK_LEN - STREET_HALF / 2, ctx.c.index + 1]] as const) {
    if (!CITY_SCENES.has(miamiScene(neighbour, side).id) || !levelAt(ctx, s)) continue;
    const f = ctx.fr.at(s, frame);
    tint(ctx.land, SURFACE.asphalt, [0.95, 0.95, 0.97]);
    patch(ctx.land, f, side * (from + to) / 2, 0.05, (to - from) / 2, STREET_HALF / 2);
    // Zebra where the sidewalk crosses the mouth of the side street.
    ctx.glow.color(PAINT, 0.75);
    for (let k = 0; k < 4; k++) {
      const along = s + (k - 1.5) * 1.05;
      if (along < 0.3 || along > CHUNK_LEN - 0.3) continue;
      const g = ctx.fr.at(along, frame);
      const rx = Math.cos(g.th), rz = Math.sin(g.th), fx = Math.sin(g.th), fz = -Math.cos(g.th);
      const cx = g.x + rx * side * (from + 2.2), cz = g.z + rz * side * (from + 2.2);
      const p = ctx.glow.v(cx - rx * 1.6 - fx * 0.25, 0.085, cz - rz * 1.6 - fz * 0.25, 0, 1, 0);
      const q = ctx.glow.v(cx + rx * 1.6 - fx * 0.25, 0.085, cz + rz * 1.6 - fz * 0.25, 0, 1, 0);
      const r = ctx.glow.v(cx + rx * 1.6 + fx * 0.25, 0.085, cz + rz * 1.6 + fz * 0.25, 0, 1, 0);
      const t = ctx.glow.v(cx - rx * 1.6 + fx * 0.25, 0.085, cz - rz * 1.6 + fz * 0.25, 0, 1, 0);
      ctx.glow.quad(p, q, r, t);
    }
  }
}

/** Kerbs of the frontage road and painted parking bays along its outer edge. */
function frontage(ctx: Ctx, side: number, inner: number, outer: number): void {
  const rows = levelRows(ctx, 0, CHUNK_LEN);
  if (!rows) return;
  tint(ctx.land, SURFACE.concrete, [0.92, 0.92, 0.9]);
  rail(ctx, side, rows[0], rows[1], inner - 0.3, inner, () => 0, 0.15);
  const street = Math.ceil((STREET_HALF + 0.5) / SAMPLE_DS);
  const i0 = Math.max(rows[0], street), i1 = Math.min(rows[1], ROWS - 1 - street);
  if (i1 > i0) rail(ctx, side, i0, i1, outer, outer + 0.3, () => 0, 0.15);
  ctx.glow.color(PAINT, 0.7);
  for (let s = 9; s <= CHUNK_LEN - 9; s += 6) {
    if (!levelAt(ctx, s)) continue;
    const f = ctx.fr.at(s, frame);
    const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
    const cx = f.x + rx * side * (outer - 1.15), cz = f.z + rz * side * (outer - 1.15);
    const p = ctx.glow.v(cx - rx * 1.1 - fx * 0.06, 0.03, cz - rz * 1.1 - fz * 0.06, 0, 1, 0);
    const q = ctx.glow.v(cx + rx * 1.1 - fx * 0.06, 0.03, cz + rz * 1.1 - fz * 0.06, 0, 1, 0);
    const r = ctx.glow.v(cx + rx * 1.1 + fx * 0.06, 0.03, cz + rz * 1.1 + fz * 0.06, 0, 1, 0);
    const t = ctx.glow.v(cx - rx * 1.1 + fx * 0.06, 0.03, cz - rz * 1.1 + fz * 0.06, 0, 1, 0);
    ctx.glow.quad(p, q, r, t);
  }
}

/** Clipped hedge along the verge, with openings at driveways and side streets. */
function hedge(ctx: Ctx, side: number, inner: number, outer: number, height: number): void {
  tint(ctx.land, SURFACE.planting, [0.8, 0.95, 0.75]);
  for (const [from, to] of [[7, 46], [54, 93]]) {
    const rows = levelRows(ctx, from, to);
    if (rows) rail(ctx, side, rows[0], rows[1], inner, outer, () => 0, height);
  }
}

/** Seawall coping at the water's edge of quays and parks; the shore distance varies per row. */
function coping(ctx: Ctx, side: number, gap: boolean): void {
  const inner = new Float64Array(ROWS), outer = new Float64Array(ROWS), y = new Float64Array(ROWS);
  for (let i = 0; i < ROWS; i++) {
    miamiSection(ctx.lap0 + i * SAMPLE_DS, side, sec);
    outer[i] = sec.shore + 0.15;
    inner[i] = sec.shore - 0.45;
    y[i] = miamiProfileY(ctx.gy[i], sec, sec.shore - 0.45);
  }
  tint(ctx.land, SURFACE.concrete, [0.95, 0.93, 0.88]);
  const spans: [number, number][] = gap ? [[0, 23], [27, ROWS - 1]] : [[0, ROWS - 1]];
  for (const [i0, i1] of spans) {
    let from = i0;
    for (let i = i0; i <= i1; i++) {
      const ok = y[i] > DRY && inner[i] > MIAMI_WALK + 2;
      if (ok && i < i1) continue;
      const end = ok ? i : i - 1;
      if (end - from >= 1) rail(ctx, side, from, end, inner, outer, k => y[k], 0.45);
      from = i + 1;
    }
  }
}

/** Downtown people-mover: an elevated guideway on columns over the plaza, with a parked train. */
function peopleMover(ctx: Ctx, side: number): void {
  const rows = levelRows(ctx, 0, CHUNK_LEN);
  if (!rows || rows[0] > 0 || rows[1] < ROWS - 1) return;
  const d = 34;
  tint(ctx.land, SURFACE.concrete, [0.9, 0.9, 0.9]);
  rail(ctx, side, 0, ROWS - 1, d - 1.5, d + 1.5, () => 8.4, 1, true);
  for (const s of [12.5, 37.5, 62.5, 87.5]) block(ctx.land, ctx.fr.at(s, frame), side * d, -0.2, 8.4, 0.75, 0.75);
  if (miamiChunk(ctx.c.index) % 3 === 0) {
    for (const s of [38, 50.5]) {
      const f = ctx.fr.at(s, frame);
      tint(ctx.land, SURFACE.tiles, [1.1, 1.12, 1.15]);
      block(ctx.land, f, side * d, 9.5, 12.4, 1.35, 5.8, true);
      tint(ctx.land, SURFACE.asphalt, [0.35, 0.5, 0.7]);
      block(ctx.land, f, side * d, 10.7, 11.8, 1.38, 5.2);
    }
  }
}

export function buildMiamiLand(c: RoadChunk, road: Road, fr: ChunkFrames, gy: Float64Array, builders: LandBuilders): void {
  const index = miamiChunk(c.index);
  const ctx: Ctx = { ...builders, c, road, fr, gy, lap0: index * CHUNK_LEN, v0: (index % 12) * CHUNK_LEN };
  for (const side of [-1, 1]) {
    const scene = miamiScene(c.index, side);
    const rng = mulberry32((Math.imul(index + 1, 0x9e3779b1) ^ (side > 0 ? 0x4c414e44 : 0x1d5a3c7b)) >>> 0);
    ground(ctx, side, scene);
    if (c.kind === 'tunnel') continue;

    const rows = ROWS_BY_SCENE[scene.id];
    if (rows) blocks(ctx, side, rows, rng, false);
    if (scene.shore < 400 && scene.id !== 'beach' && scene.id !== 'dunes') farCoast(ctx, side, rng);

    sideStreets(ctx, side, scene);
    switch (scene.id) {
      case 'strip':
        frontage(ctx, side, 18.5, 26);
        break;
      case 'towers':
        frontage(ctx, side, 18.5, 27);
        if (side < 0 && !miamiZone(c.index).overpass) peopleMover(ctx, side);
        break;
      case 'arts':
        frontage(ctx, side, 18, 26.5);
        break;
      case 'lush':
        hedge(ctx, side, 20.4, 21.6, 1.3);
        break;
      case 'golf':
        hedge(ctx, side, 27.6, 29, 1.5);
        break;
      case 'villas':
        hedge(ctx, side, 23.2, 24.4, 1.4);
        break;
      case 'quay':
        coping(ctx, side, true);
        break;
      case 'park':
        coping(ctx, side, false);
        break;
      default:
    }
  }
  for (const isl of miamiIslands(c.index)) island(ctx, isl);
}
