import * as THREE from 'three';
import { WALL_D } from '../config';
import { mulberry32, range } from '../core/rng';
import type { MapId } from '../sim/maps';
import { miamiDistrict, type MiamiDistrict } from '../sim/miami';
import { box, FACE_NO_BOTTOM, type Frame, type MeshBuilder } from './meshBuilder';

/** Rendering theme follows the immutable map registry. */
export type MapTheme = MapId;

export const MIAMI = {
  water: 0x091d2a,
  waterLevel: -8,
  ground: new THREE.Color(0x293336),
  lamp: new THREE.Color(1, 0.72, 0.4),
  cyan: new THREE.Color(0.12, 1.05, 1.15),
  pink: new THREE.Color(1.05, 0.18, 0.43),
  cream: new THREE.Color(0xb6ac96),
  trunk: new THREE.Color(0x82735a),
  leaves: new THREE.Color(0x3c7655),
  pastel: [0xc7d5c8, 0xdbc5b8, 0xd7d3be, 0xb6c6d3].map(c => new THREE.Color(c).multiplyScalar(0.58)),
} as const;

/** Canonical lap index: scenery must not change when the same ring chunk is recycled. */
export function canonicalChunk(index: number, ringLen: number, chunkLen = 100): number {
  if (!Number.isFinite(ringLen) || ringLen <= 0) return index;
  const n = Math.max(1, Math.round(ringLen / chunkLen));
  return ((index % n) + n) % n;
}

export function miamiChunkSeed(index: number, ringLen: number): number {
  return (Math.imul(canonicalChunk(index, ringLen), 0x9e3779b1) ^ 0x4d49414d) >>> 0;
}

/** Includes the full frond canopy, not just the trunk. All palms remain outside the barrier. */
export const PALM_RADIUS = 4.6;
export const PALM_MIN_D = WALL_D + 2 + PALM_RADIUS;

export interface MiamiFacade {
  s: number; d: number; width: number; depth: number; height: number; variant: number; seed: number;
}

/** Independent canonical content stream: adding a boat cannot shuffle hotels, palms or signs. */
export function miamiLayout(index: number, ringLen: number, elevated = false) {
  const canonical = canonicalChunk(index, ringLen);
  const district = miamiDistrict(canonical * 100);
  const rng = mulberry32(miamiChunkSeed(index, ringLen) ^ 0x434f4153);
  const facades: MiamiFacade[] = [];
  const add = (s: number, d: number, w: number, depth: number, h: number) => facades.push({
    s, d, width: w, depth, height: h, variant: Math.floor(rng() * 3), seed: Math.floor(rng() * 100000),
  });
  if (!elevated && district !== 'causeway') {
    if (district === 'downtown') {
      for (const s of [24, 75]) add(s, range(rng, 48, 62), range(rng, 26, 36), range(rng, 24, 32), range(rng, 80, 145));
      add(50, 145, 32, 30, range(rng, 125, 170));
    } else if (district === 'ocean-drive') {
      for (const s of [24, 75]) add(s, range(rng, 43, 53), range(rng, 30, 39), range(rng, 20, 25), range(rng, 12, 23));
      if (canonical % 2 === 0) add(50, 150, 32, 28, range(rng, 34, 55));
    } else {
      add(28, 48, 39, 24, range(rng, 12, 20));
      add(77, 62, 30, 26, range(rng, 22, 34));
      if (canonical % 2 === 0) add(50, 158, 32, 28, range(rng, 35, 65));
    }
  }
  // Broken, distant skyline on actual islands; neither near-bank hotel walls nor towers in water.
  if (canonical % 3 !== 0) add(50, -range(rng, 285, 365), range(rng, 24, 34), 26, range(rng, 65, 125));
  if (elevated && canonical % 2 === 0) add(45, range(rng, 285, 365), 28, 26, range(rng, 55, 115));
  const palms: { s: number; d: number; height: number; phase: number }[] = [];
  if (!elevated && district !== 'causeway') {
    const count = district === 'ocean-drive' ? 3 : 2;
    for (const side of [-1, 1]) for (let i = 0; i < count; i++) palms.push({
      s: 12 + i * (76 / Math.max(1, count - 1)) + range(rng, -3, 3),
      d: side * range(rng, PALM_MIN_D + 1, PALM_MIN_D + 5), height: range(rng, 7.5, 11.5), phase: rng() * Math.PI * 2,
    });
  }
  return { district, facades, palms, pier: district === 'marina' && !elevated && canonical % 2 === 0 };
}

/** One merged palm, no scene objects per leaf, alpha textures, lights, or per-frame work. */
export function miamiPalm(mb: MeshBuilder, f: Frame, d: number, base: number, height: number, phase: number): void {
  const rootX = f.x + Math.cos(f.th) * d, rootZ = f.z + Math.sin(f.th) * d;
  const bendX = Math.cos(phase) * 0.32, bendZ = Math.sin(phase) * 0.32;
  for (let i = 0; i < 5; i++) {
    const a = i / 5, b = (i + 1) / 5;
    mb.color(MIAMI.trunk, i % 2 ? 0.87 : 1);
    for (let k = 0; k < 6; k++) {
      const t0 = k * Math.PI / 3, t1 = (k + 1) * Math.PI / 3;
      const v = (t: number, angle: number) => mb.v(rootX + bendX * t * t + Math.cos(angle) * (0.24 - t * 0.11),
        base + height * t, rootZ + bendZ * t * t + Math.sin(angle) * (0.24 - t * 0.11), Math.cos(angle), 0.02, Math.sin(angle));
      const p = v(a, t0), q = v(b, t0), r = v(b, t1), s = v(a, t1);
      mb.quad(p, q, r, s);
    }
  }
  const cx = rootX + bendX, cz = rootZ + bendZ;
  const top = base + height;
  for (let leaf = 0; leaf < 8; leaf++) {
    const angle = phase + leaf * Math.PI / 4 + Math.sin(leaf * 2.3) * 0.12;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const radius = 3.5 + (leaf % 3) * 0.32;
    mb.color(MIAMI.leaves, 0.8 + (leaf % 3) * 0.15);
    for (let part = 0; part < 3; part++) {
      const a = part / 3, b = (part + 1) / 3;
      for (const side of [-1, 1]) {
        const edge = (t: number, outer: boolean) => {
          const width = outer ? (0.42 * Math.sin(Math.PI * t) + 0.015) * side : 0;
          return [cx + dx * radius * t - dz * width,
            top + Math.sin(t * Math.PI) * (outer ? 0.42 : 0.86) - t * t * (1.8 + leaf % 2 * 0.35),
            cz + dz * radius * t + dx * width];
        };
        const points = [edge(a, false), edge(a, true), edge(b, true), edge(b, false)];
        const u = points[1].map((v, i) => v - points[0][i]), v = points[3].map((v, i) => v - points[0][i]);
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
        const len = Math.hypot(nx, ny, nz) || 1;
        for (const facing of [1, -1]) {
          const ids = points.map(p => mb.v(p[0], p[1], p[2], nx / len * facing, ny / len * facing, nz / len * facing));
          if (facing > 0) mb.quad(ids[0], ids[1], ids[2], ids[3]);
          else mb.quad(ids[3], ids[2], ids[1], ids[0]);
        }
      }
    }
  }
}

/** Stepped parapets, a vertical fin and restrained neon trim; body/windows use the city batch. */
export function miamiDeco(struct: MeshBuilder, glow: MeshBuilder, f: Frame, d: number, base: number,
  width: number, depth: number, height: number, variant: number): void {
  const roof = base + height;
  struct.color(MIAMI.pastel[variant % MIAMI.pastel.length]);
  const style = variant % 3;
  box(struct, f, d, roof + 0.35, depth / 2 + 0.35, 0.35, width / 2 + 0.35, 0, FACE_NO_BOTTOM);
  box(struct, f, d, roof + 1.05, depth * (style === 1 ? 0.18 : 0.34), 0.35, width * (style === 2 ? 0.16 : 0.34), 0, FACE_NO_BOTTOM);
  if (style === 0) box(struct, f, d, roof + 1.75, depth * 0.2, 0.35, width * 0.2, 0, FACE_NO_BOTTOM);
  // Road-facing vertical blade gives the low hotels a recognisable Art Deco silhouette.
  const front = d - Math.sign(d) * depth / 2;
  box(struct, f, front, base + height * 0.65, 0.35, height * 0.4, style === 1 ? 2 : 0.8);
  // Pale balcony slabs / eyebrow bands make structure readable without glowing every roof edge.
  struct.color(MIAMI.cream, 0.8);
  for (let y = 3.5; y < height - 1; y += 3.5) {
    box(struct, f, front - Math.sign(d) * 0.5, base + y, 1.05, 0.12, width * (style === 2 ? 0.32 : 0.43), 0, FACE_NO_BOTTOM);
  }
  glow.color(variant % 2 ? MIAMI.pink : MIAMI.cyan, 0.45);
  box(glow, f, front - Math.sign(d) * 0.37, roof - 0.4, 0.035, 0.045, width * 0.42);
  box(glow, f, d - Math.sign(d) * (depth / 2 + 0.36), base + height * 0.68, 0.025, height * 0.23, 0.65);
}

/** Occupied setbacks, not just boxes wearing the same stepped roof ornament. */
export function miamiFacade(city: MeshBuilder, struct: MeshBuilder, glow: MeshBuilder, f: Frame, base: number,
  facade: MiamiFacade, district: MiamiDistrict): void {
  const { d, width, depth, height, variant, seed } = facade;
  const tower = height > 45;
  const tiers = tower
    ? [[1, 1, 0.16, 0], [variant === 1 ? 0.5 : 0.72, 0.68, 0.66, variant === 2 ? 0.12 : 0], [0.43, 0.46, 0.18, variant === 2 ? 0.18 : 0]]
    : [[1, 1, variant === 2 ? 0.55 : 0.72, 0], [variant === 1 ? 0.55 : 0.78, 0.72, variant === 2 ? 0.45 : 0.28, variant === 1 ? 0.17 : 0]];
  const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
  let y0 = base;
  city.w2 = seed;
  for (let tier = 0; tier < tiers.length; tier++) {
    const [sw, sd, sh, shift] = tiers[tier];
    const w = width * sw, dep = depth * sd, h = height * sh;
    const cx = f.x + rx * d + fx * width * shift, cz = f.z + rz * d + fz * width * shift;
    city.color(MIAMI.pastel[(variant + (district === 'marina' ? 2 : 0)) % 4], tower ? 0.43 : 0.9);
    const faces = [[rx, rz, fx * w / 2, fz * w / 2, w, dep / 2],
      [-rx, -rz, -fx * w / 2, -fz * w / 2, w, dep / 2],
      [fx, fz, -rx * dep / 2, -rz * dep / 2, dep, w / 2],
      [-fx, -fz, rx * dep / 2, rz * dep / 2, dep, w / 2]];
    for (const [nx, nz, hx, hz, faceWidth, off] of faces) {
      city.w3 = tower ? 0.37 : 0.28;
      const ids = [[-1, 0], [1, 0], [1, 1], [-1, 1]].map(([a, b]) => {
        city.w0 = (a + 1) * faceWidth / 2; city.w1 = y0 - base + b * h;
        return city.v(cx + nx * off + a * hx, y0 + b * h, cz + nz * off + a * hz, nx, 0, nz);
      });
      city.quad(ids[0], ids[1], ids[2], ids[3]);
    }
    city.w3 = -1; city.w0 = city.w1 = 0;
    const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
      city.v(cx + a * rx * dep / 2 + b * fx * w / 2, y0 + h, cz + a * rz * dep / 2 + b * fz * w / 2, 0, 1, 0));
    city.quad(ids[0], ids[1], ids[2], ids[3]);
    if (tower) {
      struct.color(MIAMI.cream, 0.5);
      box(struct, { x: cx, z: cz, th: f.th }, 0, y0 + h + 0.12, dep / 2 + 0.16, 0.12, w / 2 + 0.16, 0, FACE_NO_BOTTOM);
    }
    y0 += h;
  }
  if (!tower) {
    // Trim follows the actual upper setback footprint instead of floating over the old full box.
    const last = tiers[tiers.length - 1];
    const topFrame = { x: f.x + fx * width * last[3], z: f.z + fz * width * last[3], th: f.th };
    miamiDeco(struct, glow, topFrame, d, y0 - height * last[2], width * last[0], depth * last[1], height * last[2], variant);
    struct.color(MIAMI.cream, 0.85);
    box(struct, f, d - Math.sign(d) * (depth / 2 + 0.7), base + 3.1, 1.4, 0.18, width * 0.42, 0, FACE_NO_BOTTOM);
  }
}

/** Seawall furniture and mooring infrastructure, all well beyond the protected shoulder. */
export function miamiQuay(struct: MeshBuilder, glow: MeshBuilder, f: Frame, ground: number, pier = false, shore = 62): void {
  const shifted = (along: number): Frame => ({ x: f.x + Math.sin(f.th) * along, z: f.z - Math.cos(f.th) * along, th: f.th });
  if (pier) {
    const deck = MIAMI.waterLevel + 0.75;
    struct.color(MIAMI.trunk, 0.75);
    box(struct, f, -(shore + 22), deck, 16, 0.18, 1.7, 0, FACE_NO_BOTTOM);
    for (const d of [7, 17, 27, 37].map(offset => -(shore + offset))) {
      struct.color(MIAMI.trunk, 0.6);
      for (const along of [-1.4, 1.4]) box(struct, shifted(along), d, deck - 0.5, 0.15, 1.2, 0.15);
      glow.color(MIAMI.lamp, 0.65);
      box(glow, f, d, deck + 0.3, 0.09, 0.12, 0.09);
    }
    // Sloping gangway joins the high seawall to the floating dock, rather than a detached finger.
    const rx = Math.cos(f.th), rz = Math.sin(f.th), fx = Math.sin(f.th), fz = -Math.cos(f.th);
    const dy = ground + 0.15 - (deck + 0.2), length = Math.hypot(11, dy);
    struct.color(MIAMI.cream, 0.65);
    const points = [[3 - shore, -1.2, ground + 0.15], [-8 - shore, -1.2, deck + 0.2], [-8 - shore, 1.2, deck + 0.2], [3 - shore, 1.2, ground + 0.15]];
    const ids = points.map(([d, a, y]) => struct.v(f.x + rx * d + fx * a, y, f.z + rz * d + fz * a, -rx * dy / length, 11 / length, -rz * dy / length));
    struct.quad(ids[3], ids[2], ids[1], ids[0]);
    return;
  }
  struct.color(MIAMI.cream, 0.55);
  box(struct, f, 5 - shore, ground + 0.1, 4.5, 0.1, 25, 0, FACE_NO_BOTTOM);
  struct.color(MIAMI.trunk, 0.65);
  for (const along of [-20, -10, 0, 10, 20]) box(struct, shifted(along), 1 - shore, ground + 0.6, 0.06, 0.6, 0.06);
  box(struct, f, 1 - shore, ground + 1.15, 0.055, 0.045, 25);
  box(struct, f, 1 - shore, ground + 0.65, 0.04, 0.03, 25);
  // Low bollards, not another avenue of neon poles or point lights.
  struct.color(MIAMI.cream, 0.7);
  box(struct, f, 11 - shore, ground + 0.55, 0.18, 0.55, 0.18);
  glow.color(MIAMI.lamp, 0.85);
  box(glow, f, 11 - shore, ground + 1.06, 0.15, 0.04, 0.15);
}
