import * as THREE from 'three';
import { WALL_D } from '../config';
import type { MapId } from '../sim/maps';
import { box, FACE_NO_BOTTOM, type Frame, type MeshBuilder } from './meshBuilder';

/** Structurally compatible with the map registry; no simulation dependency. */
export type MapTheme = MapId;

export const MIAMI = {
  water: 0x102b3b,
  ground: new THREE.Color(0x293336),
  lamp: new THREE.Color(1, 0.72, 0.4),
  cyan: new THREE.Color(0.12, 1.05, 1.15),
  pink: new THREE.Color(1.05, 0.18, 0.43),
  cream: new THREE.Color(0xb6ac96),
  trunk: new THREE.Color(0x82735a),
  leaves: new THREE.Color(0x32674b),
  pastel: [0x9ebdb2, 0xd5afa7, 0xc6c2a4, 0xa7b7ca].map(c => new THREE.Color(c).multiplyScalar(0.48)),
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

/** One merged palm, no scene objects per leaf, alpha textures, lights, or per-frame work. */
export function miamiPalm(mb: MeshBuilder, f: Frame, d: number, base: number, height: number, phase: number): void {
  mb.color(MIAMI.trunk);
  for (let i = 0; i < 3; i++) {
    box(mb, f, d + i * 0.13, base + height * (i + 0.5) / 3, 0.21 - i * 0.025, height / 6 + 0.03, 0.21 - i * 0.025, 0, FACE_NO_BOTTOM);
  }
  const cx = f.x + Math.cos(f.th) * (d + 0.26);
  const cz = f.z + Math.sin(f.th) * (d + 0.26);
  const top = base + height;
  for (let leaf = 0; leaf < 8; leaf++) {
    const angle = phase + leaf * Math.PI / 4;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const radius = 3.7 + (leaf % 3) * 0.3;
    mb.color(MIAMI.leaves, 0.8 + (leaf % 3) * 0.15);
    for (let part = 0; part < 3; part++) {
      const a = part / 3, b = (part + 1) / 3;
      const edge = (t: number, side: number) => {
        const width = 0.48 * Math.sin(Math.PI * t) + 0.035;
        return mb.v(cx + dx * radius * t - dz * width * side, top + Math.sin(t * Math.PI) * 0.65 - t * t * 1.7,
          cz + dz * radius * t + dx * width * side, 0, 1, 0);
      };
      const p = edge(a, -1), q = edge(a, 1), r = edge(b, 1), s = edge(b, -1);
      mb.quad(p, q, r, s);
      mb.quad(s, r, q, p); // Thin foliage is visible from the road below and from elevated cameras.
    }
  }
}

/** Stepped parapets, a vertical fin and restrained neon trim; body/windows use the city batch. */
export function miamiDeco(struct: MeshBuilder, glow: MeshBuilder, f: Frame, d: number, base: number,
  width: number, depth: number, height: number, variant: number): void {
  const roof = base + height;
  struct.color(MIAMI.pastel[variant % MIAMI.pastel.length]);
  box(struct, f, d, roof + 0.5, depth / 2 + 0.5, 0.5, width / 2 + 0.5, 0, FACE_NO_BOTTOM);
  box(struct, f, d, roof + 1.4, depth * 0.35, 0.4, width * 0.35, 0, FACE_NO_BOTTOM);
  box(struct, f, d, roof + 2.2, depth * 0.22, 0.4, width * 0.2, 0, FACE_NO_BOTTOM);
  // Road-facing vertical blade gives the low hotels a recognisable Art Deco silhouette.
  box(struct, f, d - Math.sign(d) * depth / 2, base + height * 0.65, 0.35, height * 0.4, 1.2);
  glow.color(variant % 2 ? MIAMI.pink : MIAMI.cyan, 0.7);
  for (const y of [roof - 0.7, roof + 0.4]) box(glow, f, d, y, depth / 2 + 0.56, 0.055, width / 2 + 0.56, 0, FACE_NO_BOTTOM);
  box(glow, f, d - Math.sign(d) * (depth / 2 + 0.36), base + height * 0.68, 0.025, height * 0.23, 0.65);
}
