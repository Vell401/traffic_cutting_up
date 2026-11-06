/*
 * Canvas faces for the cockpit instruments. Angles are canvas angles (clockwise from +x, y down):
 * every dial sweeps 270° from the lower left (135°) to the lower right (45°).
 */
export const DIAL_START = (135 * Math.PI) / 180;
export const DIAL_SWEEP = (270 * Math.PI) / 180;
export const dialAngle = (v: number, min: number, max: number): number => DIAL_START + Math.min(Math.max((v - min) / (max - min), 0), 1.02) * DIAL_SWEEP;

const FONT = '"Chakra Petch", "Segoe UI", Arial, sans-serif';
const FACE = '#07080a';

export interface DialSpec {
  cx: number;
  cy: number;
  r: number;
  min: number;
  max: number;
  /** Value step between numbers, minor ticks per number. */
  numberEvery: number;
  minor: number;
  /** Number shown = value × this (e.g. tach in thousands). */
  label: (v: number) => string;
  redFrom?: number;
  units: string;
}

export function drawDial(g: CanvasRenderingContext2D, d: DialSpec): void {
  const { cx, cy, r } = d;
  // Bezel and face.
  g.fillStyle = '#1d2026';
  g.beginPath();
  g.arc(cx, cy, r + r * 0.06, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = FACE;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // Red zone.
  if (d.redFrom !== undefined) {
    g.strokeStyle = '#d0201a';
    g.lineWidth = r * 0.07;
    g.beginPath();
    g.arc(cx, cy, r * 0.9, dialAngle(d.redFrom, d.min, d.max), dialAngle(d.max, d.min, d.max));
    g.stroke();
  }
  const steps = Math.round((d.max - d.min) / d.numberEvery);
  for (let k = 0; k <= steps * d.minor; k++) {
    const v = d.min + (k / d.minor) * d.numberEvery;
    const a = dialAngle(v, d.min, d.max);
    const major = k % d.minor === 0;
    const red = d.redFrom !== undefined && v >= d.redFrom - 1e-6;
    g.strokeStyle = red ? '#ff4a3a' : '#e9edf2';
    g.lineWidth = major ? r * 0.035 : r * 0.016;
    const r0 = r * (major ? 0.78 : 0.85);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
    g.stroke();
    if (major) {
      g.fillStyle = red ? '#ff4a3a' : '#f2f5f8';
      g.font = `600 ${Math.round(r * 0.19)}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(d.label(v), cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
    }
  }
  g.fillStyle = '#9aa3ad';
  g.font = `500 ${Math.round(r * 0.11)}px ${FONT}`;
  g.textAlign = 'center';
  g.fillText(d.units, cx, cy - r * 0.3);
}

/** Main cluster: speedometer, big tachometer, boost gauge. */
export const CLUSTER_W = 1024;
export const CLUSTER_H = 416;
export const SPEEDO: DialSpec = { cx: 200, cy: 226, r: 152, min: 0, max: 360, numberEvery: 40, minor: 4, label: (v) => String(v), units: 'km/h' };
export const TACH: DialSpec = { cx: 512, cy: 208, r: 196, min: 0, max: 9000, numberEvery: 1000, minor: 4, label: (v) => String(v / 1000), units: '×1000 r/min' };
export const BOOST: DialSpec = { cx: 830, cy: 226, r: 140, min: -1, max: 1.5, numberEvery: 0.5, minor: 5, label: (v) => (v === 0 ? '0' : v.toFixed(1)), units: 'BOOST ×100 kPa' };

export function drawCluster(cv: HTMLCanvasElement, redline: number): void {
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0b0c0f';
  g.fillRect(0, 0, CLUSTER_W, CLUSTER_H);
  drawDial(g, SPEEDO);
  drawDial(g, { ...TACH, redFrom: Math.round(redline / 250) * 250 });
  drawDial(g, BOOST);
}

/** Digital insert in the tach: gear and speed (redrawn only when they change). */
export function drawDigital(cv: HTMLCanvasElement, gear: number, kmh: number, shift: boolean): void {
  const g = cv.getContext('2d')!;
  g.fillStyle = FACE;
  g.fillRect(0, 0, cv.width, cv.height);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = shift ? '#ff5a3c' : '#ffb23e';
  g.font = `700 92px ${FONT}`;
  g.fillText(String(gear), cv.width * 0.3, cv.height * 0.54);
  g.fillStyle = '#e9eef4';
  g.font = `600 52px ${FONT}`;
  g.fillText(String(Math.round(kmh)), cv.width * 0.72, cv.height * 0.5);
  g.fillStyle = '#8c96a1';
  g.font = `500 22px ${FONT}`;
  g.fillText('km/h', cv.width * 0.72, cv.height * 0.84);
}

export interface MfdData {
  boost: number;
  oil: number;
  water: number;
  throttle: number;
}

/** Multi-function display on the dash top: boost, oil and water temperature, throttle bars. */
export function drawMfd(cv: HTMLCanvasElement, d: MfdData): void {
  const g = cv.getContext('2d')!;
  const W = cv.width;
  const H = cv.height;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0a2236');
  grad.addColorStop(1, '#04101b');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const rows: [string, number, string][] = [
    ['BOOST', (d.boost + 1) / 2.5, `${d.boost >= 0 ? '+' : ''}${d.boost.toFixed(2)}`],
    ['OIL', (d.oil - 50) / 90, `${Math.round(d.oil)}°`],
    ['WATER', (d.water - 50) / 70, `${Math.round(d.water)}°`],
    ['THROT', d.throttle, `${Math.round(d.throttle * 100)}%`],
  ];
  const rh = H / rows.length;
  g.textBaseline = 'middle';
  rows.forEach(([name, t, val], i) => {
    const y = rh * (i + 0.5);
    g.fillStyle = '#7fd4ff';
    g.font = `600 ${Math.round(rh * 0.5)}px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(name, 8, y);
    const x0 = W * 0.3;
    const x1 = W * 0.76;
    const segs = 16;
    const lit = Math.round(Math.min(Math.max(t, 0), 1) * segs);
    for (let k = 0; k < segs; k++) {
      g.fillStyle = k < lit ? (k > segs * 0.8 ? '#ff6a3a' : '#ffc43e') : '#13324a';
      const sx = x0 + ((x1 - x0) * k) / segs;
      g.fillRect(sx, y - rh * 0.28, (x1 - x0) / segs - 2, rh * 0.56);
    }
    g.fillStyle = '#e8f4ff';
    g.textAlign = 'right';
    g.fillText(val, W - 6, y);
  });
}

/** Two small pillar gauges side by side (boost, oil pressure). */
export const POD_W = 256;
export const POD_H = 128;
export const POD_BOOST: DialSpec = { cx: 64, cy: 64, r: 58, min: -1, max: 1.5, numberEvery: 0.5, minor: 2, label: (v) => (v === 0 ? '0' : v.toFixed(1)), units: 'BOOST' };
export const POD_OIL: DialSpec = { cx: 192, cy: 64, r: 58, min: 0, max: 10, numberEvery: 2, minor: 2, label: (v) => String(v), units: 'OIL kg/cm²' };

export function drawPod(cv: HTMLCanvasElement): void {
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0b0c0f';
  g.fillRect(0, 0, POD_W, POD_H);
  drawDial(g, POD_BOOST);
  drawDial(g, POD_OIL);
}

/** Centre stack: two vents, the radio, climate knobs, the hazard switch. */
export function drawStack(cv: HTMLCanvasElement): void {
  const g = cv.getContext('2d')!;
  const W = cv.width;
  const H = cv.height;
  g.fillStyle = '#16171a';
  g.fillRect(0, 0, W, H);
  // Vents (top), each a dark opening with horizontal vanes.
  for (const x0 of [W * 0.04, W * 0.52]) {
    const w = W * 0.44;
    const y0 = H * 0.04;
    const h = H * 0.26;
    g.fillStyle = '#050506';
    g.fillRect(x0, y0, w, h);
    g.fillStyle = '#2a2c31';
    for (let k = 1; k < 7; k++) g.fillRect(x0 + 3, y0 + (h * k) / 7 - 2, w - 6, 4);
    g.fillStyle = '#3a3d43';
    g.fillRect(x0 + w / 2 - 6, y0 + h * 0.3, 12, h * 0.4);
  }
  // Hazard switch between the vents.
  g.fillStyle = '#7a1410';
  g.beginPath();
  g.moveTo(W * 0.5, H * 0.33);
  g.lineTo(W * 0.46, H * 0.4);
  g.lineTo(W * 0.54, H * 0.4);
  g.fill();
  // Radio: display and buttons.
  g.fillStyle = '#0b0c0e';
  g.fillRect(W * 0.06, H * 0.45, W * 0.88, H * 0.2);
  g.fillStyle = '#1f6a54';
  g.fillRect(W * 0.32, H * 0.49, W * 0.36, H * 0.07);
  g.fillStyle = '#8ff0c8';
  g.font = `600 ${Math.round(H * 0.05)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('FM  89.7', W * 0.5, H * 0.527);
  g.fillStyle = '#2b2e34';
  for (let k = 0; k < 6; k++) g.fillRect(W * (0.12 + k * 0.13), H * 0.59, W * 0.1, H * 0.035);
  // Climate: three knobs.
  for (const x of [0.2, 0.5, 0.8]) {
    g.fillStyle = '#26282d';
    g.beginPath();
    g.arc(W * x, H * 0.82, H * 0.09, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3e4148';
    g.beginPath();
    g.arc(W * x, H * 0.82, H * 0.065, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e8eaee';
    g.fillRect(W * x - 2, H * 0.745, 4, H * 0.04);
  }
}

/** Round side vent face. */
export function drawVent(cv: HTMLCanvasElement): void {
  const g = cv.getContext('2d')!;
  const W = cv.width;
  g.clearRect(0, 0, W, W);
  g.fillStyle = '#2a2c31';
  g.beginPath();
  g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#050506';
  g.beginPath();
  g.arc(W / 2, W / 2, W * 0.42, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2f3237';
  for (let k = -3; k <= 3; k++) g.fillRect(W * 0.12, W / 2 + k * W * 0.11 - 2, W * 0.76, 4);
}
