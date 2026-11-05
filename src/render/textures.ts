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

  // Aggregate grain.
  const img = g.getImageData(0, 0, W, H);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 26 + (Math.random() < 0.02 ? 22 : 0);
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
