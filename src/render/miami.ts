import * as THREE from 'three';
import type { MapId } from '../sim/maps';

/** Rendering theme follows the immutable map registry. */
export type MapTheme = MapId;

/** Miami accents shared with the generic road builder (lamp light, tunnel paint). */
export const MIAMI = {
  lamp: new THREE.Color(1, 0.72, 0.4),
  cyan: new THREE.Color(0.12, 1.05, 1.15),
  pink: new THREE.Color(1.05, 0.18, 0.43),
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
