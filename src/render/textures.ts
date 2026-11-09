import * as THREE from 'three';
import { LANES, LANE_W, ROAD_HALF, WALL_D, laneCenter } from '../config';
import type { MapTheme } from './miami';

/** Distance along the road covered by one repeat of the road texture (dash period). */
export const ROAD_TEX_PERIOD = 20;

/**
 * Procedural road texture: u spans the full width between the barriers, v one 20 m dash period
 * (tiles seamlessly along the road). `size` px square: 1024 on Medium, 2048 on High.
 *
 * Layers: two asphalt tones (lanes / shoulders), large soft tone variation, polished wheel paths,
 * patches and sealed cracks, per-pixel aggregate, rumble strips, worn markings.
 * Anything that is not per-pixel is drawn at y, y-H and y+H so it wraps across the tile seam.
 */
export function makeRoadTexture(anisotropy: number, size = 1024): THREE.CanvasTexture {
  const W = size;
  const H = size;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const pxPerM = W / (2 * WALL_D);
  const pxPerS = H / ROAD_TEX_PERIOD;
  const X = (d: number) => (d + WALL_D) * pxPerM;
  const wrapped = (draw: (dy: number) => void) => {
    for (const dy of [-H, 0, H]) draw(dy);
  };

  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#323438';
  g.fillRect(0, 0, X(-ROAD_HALF), H);
  g.fillRect(X(ROAD_HALF), 0, W - X(ROAD_HALF), H);

  // Large, soft tone variation so the surface is not a flat grey.
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = (2 + Math.random() * 5) * pxPerM;
    const dark = Math.random() < 0.6;
    wrapped((dy) => {
      const grad = g.createRadialGradient(x, y + dy, 0, x, y + dy, r);
      grad.addColorStop(0, dark ? 'rgba(0,0,0,0.10)' : 'rgba(255,250,240,0.05)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y + dy - r, 2 * r, 2 * r);
    });
  }

  // Patches: rectangles of newer, darker asphalt with a slightly lighter seam.
  for (let i = 0; i < 3; i++) {
    const lane = Math.floor(Math.random() * LANES);
    const x = X(laneCenter(lane) - LANE_W * 0.4 + Math.random() * 0.6);
    const w = (1.2 + Math.random() * 1.6) * pxPerM;
    const y = Math.random() * H;
    const h = (1.5 + Math.random() * 4) * pxPerS;
    wrapped((dy) => {
      g.fillStyle = 'rgba(14,15,17,0.32)';
      g.fillRect(x, y + dy, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.lineWidth = Math.max(1, 0.04 * pxPerM);
      g.strokeRect(x, y + dy, w, h);
    });
  }

  // Polished wheel paths.
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let l = 0; l < LANES; l++) {
    for (const side of [-0.8, 0.8]) g.fillRect(X(laneCenter(l) + side - 0.35), 0, 0.7 * pxPerM, H);
  }

  // Sealed cracks: thin dark tar lines wandering mostly along the road.
  g.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const pts: [number, number][] = [];
    let x = Math.random() * W;
    let y = Math.random() * H;
    const n = 4 + Math.floor(Math.random() * 6);
    for (let k = 0; k < n; k++) {
      pts.push([x, y]);
      x += (Math.random() - 0.5) * 0.6 * pxPerM;
      y += (0.3 + Math.random() * 0.9) * pxPerS * (Math.random() < 0.2 ? -1 : 1);
    }
    const width = Math.max(1, (0.015 + Math.random() * 0.03) * pxPerM);
    wrapped((dy) => {
      g.strokeStyle = 'rgba(8,8,10,0.55)';
      g.lineWidth = width;
      g.beginPath();
      pts.forEach(([px, py], k) => (k === 0 ? g.moveTo(px, py + dy) : g.lineTo(px, py + dy)));
      g.stroke();
    });
  }

  // Rumble strips on the shoulders, just outside the edge lines.
  for (const side of [-1, 1]) {
    const d0 = side * (ROAD_HALF + 0.2) + (side < 0 ? -0.45 : 0);
    for (let v = 0; v < ROAD_TEX_PERIOD; v += 0.36) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(X(d0), v * pxPerS, 0.45 * pxPerM, 0.16 * pxPerS);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(X(d0), (v + 0.16) * pxPerS, 0.45 * pxPerM, 0.04 * pxPerS);
    }
  }

  // Aggregate: fine per-pixel grain plus sparse light stones (scaled so 2048 px is not noisier).
  const img = g.getImageData(0, 0, W, H);
  const px = img.data;
  const stones = 0.015 * (1024 / size);
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 16 + (Math.random() < stones ? 14 : 0);
    px[i] += n;
    px[i + 1] += n + 0.5;
    px[i + 2] += n + 1;
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
  const wear = 4000 * (size / 1024) ** 2;
  const dot = size / 1024;
  for (let i = 0; i < wear; i++) {
    const v = 170 + Math.random() * 60;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.random() * W, Math.random() * H, (2 + Math.random() * 3) * dot, (2 + Math.random() * 3) * dot);
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
/** Original coastal place names; atlas dimensions and emergency symbols stay identical. */
export const MIAMI_SIGNS: readonly [string, string, string][] = [
  ['PALM COAST', 'OCEAN DRIVE', '↑'],
  ['BLUE BAY', 'CAUSEWAY', '↑'],
  ['CORAL QUAY', 'MARINA', '↗'],
  ['DECO DISTRICT', 'COAST ROAD', '↑'],
  ['SUNSET ISLES', 'BAY LOOP', '↑'],
  ['PEARL HARBOR', 'YACHT CLUB', '↗'],
  ['SEABREEZE', 'WATERFRONT', '↑'],
  ['LAGOON TUNNEL', 'KEEP LANES', '↑'],
];
export const SIGN_COLS = 2;
export const SIGN_ROWS = 6;
/** Cells 0..7 are overhead destination boards; the tunnel signs follow. */
export const HIGHWAY_SIGNS = SIGNS.length;
export const TUNNEL_SIGN = { exit: 8, sos: 9, lane: 10, fire: 11 } as const;

type Ctx = CanvasRenderingContext2D;

function signFrame(g: Ctx, x: number, y: number, w: number, h: number, bg: string, k: number): void {
  g.fillStyle = bg;
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#f4f7f4';
  g.lineWidth = 10 * k;
  g.strokeRect(x + 12 * k, y + 12 * k, w - 24 * k, h - 24 * k);
}

function signText(g: Ctx, text: string, cx: number, cy: number, size: number): void {
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${size}px "Segoe UI", Arial, sans-serif`;
  g.fillText(text, cx, cy);
  g.textAlign = 'start';
}

/** Polyline with round joints (pictogram limbs). */
function limb(g: Ctx, k: number, ...pts: number[]): void {
  g.beginPath();
  g.moveTo(pts[0] * k, pts[1] * k);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * k, pts[i + 1] * k);
  g.stroke();
}

/** Emergency exit: running figure heading for a door, "EXIT". */
function drawExit(g: Ctx, x: number, y: number, w: number, h: number, k: number): void {
  signFrame(g, x, y, w, h, '#0a8d45', k);
  g.save();
  g.translate(x + 150 * k, y + 128 * k);
  g.strokeStyle = g.fillStyle = '#ffffff';
  g.lineWidth = 9 * k;
  g.strokeRect(-110 * k, -92 * k, 74 * k, 184 * k); // door
  g.lineCap = g.lineJoin = 'round';
  g.lineWidth = 20 * k;
  g.beginPath();
  g.arc(36 * k, -70 * k, 18 * k, 0, Math.PI * 2);
  g.fill();
  limb(g, k, 26, -44, 6, 18); // torso
  limb(g, k, 22, -34, 54, -16, 76, -34); // front arm
  limb(g, k, 22, -34, -4, -20, -24, -40); // back arm
  limb(g, k, 6, 18, 46, 38, 52, 84); // front leg
  limb(g, k, 6, 18, -14, 56, -52, 64); // back leg
  g.restore();
  signText(g, 'EXIT', x + 370 * k, y + 132 * k, 112 * k);
}

/** Emergency phone niche: handset and "SOS". */
function drawSos(g: Ctx, x: number, y: number, w: number, h: number, k: number): void {
  signFrame(g, x, y, w, h, '#1c5fd4', k);
  g.save();
  g.translate(x + 128 * k, y + 132 * k);
  g.strokeStyle = g.fillStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineWidth = 26 * k;
  g.beginPath();
  g.arc(0, 26 * k, 66 * k, Math.PI * 1.08, Math.PI * 1.92);
  g.stroke();
  for (const a of [Math.PI * 1.08, Math.PI * 1.92]) {
    g.beginPath();
    g.ellipse(Math.cos(a) * 66 * k, 26 * k + Math.sin(a) * 66 * k + 12 * k, 30 * k, 16 * k, a + Math.PI / 2, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  signText(g, 'SOS', x + 356 * k, y + 132 * k, 124 * k);
}

/** Lane control signal: green down arrow on black (only the centre square is used). */
function drawLane(g: Ctx, x: number, y: number, w: number, h: number, k: number): void {
  g.fillStyle = '#040506';
  g.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  g.strokeStyle = '#2a2d31';
  g.lineWidth = 8 * k;
  g.strokeRect(cx - 120 * k, cy - 120 * k, 240 * k, 240 * k);
  g.fillStyle = '#39ff7a';
  g.fillRect(cx - 24 * k, cy - 92 * k, 48 * k, 100 * k);
  g.beginPath();
  g.moveTo(cx - 78 * k, cy);
  g.lineTo(cx + 78 * k, cy);
  g.lineTo(cx, cy + 92 * k);
  g.closePath();
  g.fill();
}

/** Fire cabinet: extinguisher and "FIRE". */
function drawFire(g: Ctx, x: number, y: number, w: number, h: number, k: number): void {
  signFrame(g, x, y, w, h, '#c7151f', k);
  g.save();
  g.translate(x + 130 * k, y + 136 * k);
  g.fillStyle = g.strokeStyle = '#ffffff';
  g.beginPath();
  g.roundRect(-30 * k, -50 * k, 60 * k, 132 * k, 22 * k);
  g.fill();
  g.fillRect(-12 * k, -78 * k, 24 * k, 30 * k);
  g.lineWidth = 12 * k;
  g.lineCap = 'round';
  limb(g, k, 8, -70, 58, -84, 70, -40);
  g.restore();
  signText(g, 'FIRE', x + 356 * k, y + 132 * k, 112 * k);
}

/** Atlas of sign boards (2 × 6 cells, 512 × 256 each): destination boards, then tunnel signs. */
export function makeSignAtlas(anisotropy: number, scale = 1, theme: MapTheme = 'highway'): THREE.CanvasTexture {
  const CW = 512 * scale;
  const CH = 256 * scale;
  const cv = document.createElement('canvas');
  cv.width = CW * SIGN_COLS;
  cv.height = CH * SIGN_ROWS;
  const g = cv.getContext('2d')!;
  (theme === 'miami' ? MIAMI_SIGNS : SIGNS).forEach(([title, sub, arrow], i) => {
    const x = (i % SIGN_COLS) * CW;
    const y = Math.floor(i / SIGN_COLS) * CH;
    const k = scale;
    g.fillStyle = theme === 'miami' ? '#14535d' : '#0f5b37';
    g.fillRect(x, y, CW, CH);
    g.strokeStyle = '#e8efe9';
    g.lineWidth = 8 * k;
    g.strokeRect(x + 14 * k, y + 14 * k, CW - 28 * k, CH - 28 * k);
    if (theme === 'miami') {
      g.fillStyle = i % 2 ? '#d999aa' : '#9ed5ce';
      g.fillRect(x + 22 * k, y + CH - 26 * k, CW - 44 * k, 5 * k);
    }
    g.fillStyle = '#f2f5f2';
    g.textBaseline = 'middle';
    g.font = `700 ${58 * k}px "Segoe UI", Arial, sans-serif`;
    g.fillText(title, x + 40 * k, y + 92 * k, CW - 150 * k);
    g.font = `600 ${44 * k}px "Segoe UI", Arial, sans-serif`;
    g.fillText(sub, x + 40 * k, y + 176 * k, CW - 150 * k);
    g.font = `700 ${96 * k}px "Segoe UI", Arial, sans-serif`;
    g.textAlign = 'center';
    g.fillText(arrow, x + CW - 76 * k, y + CH / 2);
    g.textAlign = 'start';
  });
  const cell = (i: number, draw: (g: Ctx, x: number, y: number, w: number, h: number, k: number) => void) =>
    draw(g, (i % SIGN_COLS) * CW, Math.floor(i / SIGN_COLS) * CH, CW, CH, scale);
  cell(TUNNEL_SIGN.exit, drawExit);
  cell(TUNNEL_SIGN.sos, drawSos);
  cell(TUNNEL_SIGN.lane, drawLane);
  cell(TUNNEL_SIGN.fire, drawFire);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}
