import * as THREE from 'three';
import { LANES, LANE_W, ROAD_HALF, WALL_D, laneCenter } from '../config';

/** Distance along the road covered by one repeat of the road texture (dash period). */
export const ROAD_TEX_PERIOD = 20;

/**
 * Procedural road texture: u spans the full width between the barriers, v one 20 m dash period.
 * Asphalt grain, darker wheel paths, solid edge lines, 8 m dashes every 20 m.
 */
export function makeRoadTexture(anisotropy: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const pxPerM = W / (2 * WALL_D);
  const X = (d: number) => (d + WALL_D) * pxPerM;

  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#323438';
  g.fillRect(0, 0, X(-ROAD_HALF), H);
  g.fillRect(X(ROAD_HALF), 0, W - X(ROAD_HALF), H);

  // Wheel paths: polished, slightly darker bands.
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let l = 0; l < LANES; l++) {
    for (const side of [-0.8, 0.8]) g.fillRect(X(laneCenter(l) + side - 0.35), 0, 0.7 * pxPerM, H);
  }

  // Rumble strips on the shoulders, just outside the edge lines.
  const pxPerS = H / ROAD_TEX_PERIOD;
  for (const side of [-1, 1]) {
    const d0 = side * (ROAD_HALF + 0.2) + (side < 0 ? -0.45 : 0);
    for (let v = 0; v < ROAD_TEX_PERIOD; v += 0.36) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(X(d0), v * pxPerS, 0.45 * pxPerM, 0.16 * pxPerS);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(X(d0), (v + 0.16) * pxPerS, 0.45 * pxPerM, 0.04 * pxPerS);
    }
  }

  // Aggregate grain.
  const img = g.getImageData(0, 0, W, H);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 16 + (Math.random() < 0.015 ? 14 : 0);
    px[i] += n;
    px[i + 1] += n;
    px[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // Markings.
  g.fillStyle = '#e4e2da';
  const solid = (d: number, w: number) => g.fillRect(X(d - w / 2), 0, w * pxPerM, H);
  solid(-ROAD_HALF, 0.2);
  solid(ROAD_HALF, 0.2);
  const dashLen = 8 / ROAD_TEX_PERIOD;
  for (let l = 0; l < LANES - 1; l++) {
    const d = laneCenter(l) + LANE_W / 2;
    g.fillRect(X(d - 0.075), 0, 0.15 * pxPerM, H * dashLen);
  }
  // Worn paint.
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 4000; i++) {
    const v = 170 + Math.random() * 60;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

/** White disc with soft alpha falloff: light pools, blob shadows. */
export function makeRadialTexture(size = 128, falloff = 1.6): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = Math.pow(1 - r, falloff);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fictional destinations for overhead signs. */
const SIGNS: [string, string, string][] = [
  ['HARBOR CITY', 'EXIT 2 km', '↗'],
  ['NORTH RING', 'CENTRAL', '↑'],
  ['AIRPORT', '12 km', '✈'],
  ['BAYSIDE', 'PORT AREA', '↗'],
  ['OLD TOWN', '5 km', '↑'],
  ['RIVERFRONT', 'EXIT 1 km', '↗'],
  ['INDUSTRIAL ZONE', '8 km', '↑'],
  ['WEST LOOP', 'JCT 3 km', '↑'],
];
export const SIGN_COLS = 2;
export const SIGN_ROWS = 4;

/** Atlas of green overhead sign boards (2 × 4 cells, 512 × 256 each). */
export function makeSignAtlas(anisotropy: number): THREE.CanvasTexture {
  const CW = 512;
  const CH = 256;
  const cv = document.createElement('canvas');
  cv.width = CW * SIGN_COLS;
  cv.height = CH * SIGN_ROWS;
  const g = cv.getContext('2d')!;
  SIGNS.forEach(([title, sub, arrow], i) => {
    const x = (i % SIGN_COLS) * CW;
    const y = Math.floor(i / SIGN_COLS) * CH;
    g.fillStyle = '#0f5b37';
    g.fillRect(x, y, CW, CH);
    g.strokeStyle = '#e8efe9';
    g.lineWidth = 8;
    g.strokeRect(x + 14, y + 14, CW - 28, CH - 28);
    g.fillStyle = '#f2f5f2';
    g.textBaseline = 'middle';
    g.font = '700 58px "Segoe UI", Arial, sans-serif';
    g.fillText(title, x + 40, y + 92, CW - 150);
    g.font = '600 44px "Segoe UI", Arial, sans-serif';
    g.fillText(sub, x + 40, y + 176, CW - 150);
    g.font = '700 96px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText(arrow, x + CW - 76, y + CH / 2);
    g.textAlign = 'start';
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}
