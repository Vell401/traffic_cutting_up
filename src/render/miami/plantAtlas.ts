import * as THREE from 'three';
import { cells, fbm } from './surfaces';

/*
 * One generated texture for all Miami vegetation, so every plant is a single draw.
 *
 * Eight cells, 128 × 256 px each, greyscale + alpha: the hue comes from vertex colours (each species
 * its own green) and, for flowering crowns, from the instance tint. The left half is opaque surfaces
 * (bark, leaf canopy, plain, blossom), the right half alpha cut-outs (feather frond, fan leaf,
 * paddle leaf, grass), so the two kinds do not bleed into each other in the small mip levels.
 */

export const PLANT_SIZE = 512;
const COLS = 4;
const ROWS = 2;
const CELL_W = PLANT_SIZE / COLS;
const CELL_H = PLANT_SIZE / ROWS;

/** [column, row] of each cell. */
export const PLANT_CELL = {
  bark: [0, 0],
  leaves: [1, 0],
  plain: [0, 1],
  blossom: [1, 1],
  frond: [2, 0],
  fan: [3, 0],
  paddle: [2, 1],
  grass: [3, 1],
} as const;
export type PlantCell = (typeof PLANT_CELL)[keyof typeof PLANT_CELL];

/** UV rectangle of a cell, pulled in from its edges so filtering never samples a neighbour. */
export function plantUV(cell: PlantCell, u: number, v: number, inset = 0.05): [number, number] {
  return [(cell[0] + inset + u * (1 - 2 * inset)) / COLS, (cell[1] + inset * 0.5 + v * (1 - inset)) / ROWS];
}

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const fract = (x: number): number => x - Math.floor(x);

/** Luminance and coverage of the feather (pinnate) frond: a rib with ragged leaflets angled to the tip. */
function frond(u: number, v: number): [number, number] {
  const x = u * 2 - 1;
  const ax = Math.abs(x);
  const side = x < 0 ? 0 : 57;
  const q = v * 30 + ax * 9;
  const leaflet = Math.floor(q);
  const envelope = Math.sin(Math.PI * Math.min(1, v * 0.92 + 0.06)) ** 0.55 * (0.72 + 0.28 * hash(leaflet + side));
  const rib = ax < 0.04 * (1.2 - v) && v < 0.97;
  const blade = fract(q) < 0.62 && ax < envelope * 0.96 && v > 0.03;
  return [rib ? 0.95 : 0.6 + 0.26 * (1 - ax) + 0.14 * hash(leaflet * 1.7 + side), rib || blade ? 1 : 0];
}

/** Fan (palmate) leaf, in the lower square of its cell: pleated segments with pointed tips. */
function fan(u: number, v: number): [number, number] {
  if (v > 0.5) return [0.75, 0];
  const x = u - 0.5;
  const y = v * 2 - 0.04;
  const r = Math.hypot(x, y) / 0.5;
  const angle = Math.atan2(x, y);
  if (r > 1 || Math.abs(angle) > 1.5 || y < 0) return [0.75, 0];
  const segment = ((angle + 1.5) / 3) * 22;
  const within = fract(segment);
  const tip = 0.7 + 0.3 * (1 - Math.abs(2 * within - 1)) ** 0.8;
  const open = r < 0.52 || (within > 0.13 && within < 0.87);
  return [0.62 + 0.3 * Math.cos(within * Math.PI * 2) * 0.5 + 0.14 * r, open && r < tip ? 1 : 0];
}

/** Paddle leaf (banana, bird of paradise): a broad blade with a midrib, side veins and wind tears. */
function paddle(u: number, v: number): [number, number] {
  const x = u * 2 - 1;
  const ax = Math.abs(x);
  const width = 0.94 * Math.sin(Math.PI * (v * 0.93 + 0.035)) ** 0.8;
  const q = v * 24 + ax * 5;
  const torn = fract(q + hash(Math.floor(q)) * 0.4) < 0.07 && ax > 0.28 + 0.4 * hash(Math.floor(q) + 3);
  const lum = ax < 0.06 ? 0.98 : 0.66 + 0.2 * fract(q) + 0.1 * (1 - ax);
  return [lum, ax < width && !torn && v > 0.02 && v < 0.985 ? 1 : 0];
}

const BLADES = Array.from({ length: 11 }, (_, k) => ({
  root: 0.5 + (hash(k * 3.1) - 0.5) * 0.3,
  lean: (hash(k * 5.7) - 0.5) * 0.9,
  length: 0.55 + 0.42 * hash(k * 7.3),
  width: 0.035 + 0.03 * hash(k * 9.1),
  seed: hash(k * 11.9) < 0.45,
}));

/** Tuft of grass blades fanning out of one root, some carrying a seed head (sea oats). */
function grass(u: number, v: number): [number, number] {
  let alpha = 0;
  let lum = 0.7;
  for (const blade of BLADES) {
    if (v > blade.length) continue;
    const t = v / blade.length;
    const centre = blade.root + blade.lean * t * t * 0.5;
    const dx = Math.abs(u - centre);
    if (dx < blade.width * (1 - t * 0.85)) {
      alpha = 1;
      lum = 0.62 + 0.32 * t;
    }
    if (blade.seed && t > 0.78 && dx < blade.width * 2.4 * Math.sin(Math.PI * (t - 0.78) / 0.22) ** 0.6) {
      alpha = 1;
      lum = 0.98;
    }
  }
  return [lum, alpha];
}

/** RGBA bytes of the atlas: luminance in RGB, coverage in alpha. */
export function makePlantPixels(): Uint8Array {
  const out = new Uint8Array(PLANT_SIZE * PLANT_SIZE * 4);
  const leafCells = cells(211, 20, CELL_H);
  const petalCells = cells(223, 26, CELL_H);
  const dapple = fbm(229, 3, 3, 3, CELL_H);
  const grain = fbm(227, 6, 40, 3, CELL_H);
  const put = (cell: PlantCell, x: number, y: number, lum: number, alpha: number): void => {
    const o = ((cell[1] * CELL_H + y) * PLANT_SIZE + cell[0] * CELL_W + x) * 4;
    const b = Math.max(0, Math.min(255, Math.round(lum * 255)));
    out[o] = out[o + 1] = out[o + 2] = b;
    out[o + 3] = Math.round(alpha * 255);
  };
  for (let y = 0; y < CELL_H; y++) {
    const v = (y + 0.5) / CELL_H;
    for (let x = 0; x < CELL_W; x++) {
      const u = (x + 0.5) / CELL_W;
      // The noise fields are square (CELL_H²): the cell samples their left half, two texels per pixel across.
      const i = y * CELL_H + x * 2;
      // Bark: growth rings along the trunk over a fibrous grain.
      put(PLANT_CELL.bark, x, y, 0.8 + 0.06 * Math.sin(v * Math.PI * 2 * 22 + grain[i] * 5) + 0.22 * (grain[i] - 0.5), 1);
      // Leaf canopy: overlapping leaf-sized patches, darker in the gaps between them.
      // Small leaves in soft clumps of light and shade; the gaps between them only slightly darker.
      put(PLANT_CELL.leaves, x, y, (0.72 + 0.2 * hash(leafCells.id[i] * 1.3)) * (0.86 + 0.14 * Math.min(1, leafCells.edge[i] * 14)) * (0.82 + 0.36 * dapple[i]), 1);
      put(PLANT_CELL.plain, x, y, 1, 1);
      // Blossom: a froth of petals with shadowed gaps.
      put(PLANT_CELL.blossom, x, y, (0.78 + 0.22 * hash(petalCells.id[i] * 2.1)) * (0.8 + 0.2 * Math.min(1, petalCells.edge[i] * 18)) * (0.86 + 0.28 * dapple[i]), 1);
      put(PLANT_CELL.frond, x, y, ...frond(u, v));
      put(PLANT_CELL.fan, x, y, ...fan(u, v));
      put(PLANT_CELL.paddle, x, y, ...paddle(u, v));
      put(PLANT_CELL.grass, x, y, ...grass(u, v));
    }
  }
  return out;
}

export function makePlantTexture(anisotropy = 4): THREE.DataTexture {
  const texture = new THREE.DataTexture(makePlantPixels(), PLANT_SIZE, PLANT_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'miami/plants';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
