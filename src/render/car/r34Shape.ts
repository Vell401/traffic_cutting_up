import { clamp, smoothstep } from '../../core/math';
import { curve } from './grid';

/*
 * The R34-style coupe as functions: side-view lines, plan-view rounding and cross-sections. Every
 * surface (body, greenhouse, interior shell, lamp patches, livery masks) is sampled from these, so
 * they meet exactly.
 *
 * Model space in metres, real proportions (4.60 × 1.785 m, wheelbase 2.665 m, 245/40 R18):
 *   f forward (front bumper +2.30, rear -2.30), x to the right, y up from the ground.
 * The model is right-hand drive like the original (driver on the right).
 */

export const LENGTH = 4.6;
export const WIDTH = 1.785;
export const F_FRONT = 2.3;
export const F_REAR = -2.3;
export const AXLES = [1.35, -1.315] as const;
export const TRACK_HALF = [0.74, 0.745] as const;
export const WHEEL_R = 0.327;
export const TYRE_W = 0.245;
export const ARCH_R = 0.37;
export const ARCH_Y = 0.335;
/** Inner wall of the wheel wells and the underbody edge. */
export const W_IN = 0.56;

/** Greenhouse: windshield base (at the cowl), rear window base (on the deck). */
export const F_WS = 0.6;
export const F_RW = -1.66;
/** Share of the half-width (from the shoulder in) where the greenhouse stands on the body. */
export const Q_G = 0.08;

/** Centreline top: hood, cowl, (under the cabin), deck, tail. */
export const yTop = curve([
  [-2.3, 0.88], [-2.295, 0.91], [-2.28, 0.95], [-2.26, 0.985], [-2.23, 1.01], [-2.18, 1.02], [-2.0, 1.02],
  [-1.66, 1.006], [-1.0, 0.98], [0.3, 0.92], [0.62, 0.885], [1.0, 0.838], [1.5, 0.79], [1.9, 0.757],
  [2.1, 0.742], [2.15, 0.735], [2.18, 0.72], [2.2, 0.7], [2.215, 0.67], [2.23, 0.635], [2.245, 0.6],
  [2.265, 0.575], [2.285, 0.55], [2.3, 0.52],
]);

/** Shoulder line: where the flank turns into the hood / deck. */
export const yBelt = curve([
  [-2.3, 0.86], [-2.29, 0.88], [-2.27, 0.915], [-2.23, 0.94], [-2.15, 0.95], [-1.8, 0.94], [-1.315, 0.925],
  [-0.8, 0.905], [0.0, 0.875], [0.62, 0.84], [1.35, 0.765], [1.9, 0.735], [2.1, 0.722], [2.15, 0.713],
  [2.18, 0.7], [2.2, 0.684], [2.215, 0.655], [2.23, 0.62], [2.245, 0.586], [2.265, 0.561], [2.285, 0.536],
  [2.3, 0.506],
]);

/** Underbody centreline (front air dam and rear valance curl up). */
export const yBot = curve([
  [-2.3, 0.33], [-2.28, 0.3], [-2.2, 0.25], [-2.0, 0.19], [-1.8, 0.16], [1.9, 0.15], [2.15, 0.15], [2.25, 0.17],
  [2.28, 0.2], [2.3, 0.26],
]);

/** Plan view: the corners round off toward the bumpers (scale of every x in the section). */
export function planS(f: number): number {
  const corner = (u: number, end: number) => 1 - (1 - end) * (1 - Math.sqrt(1 - clamp(u, 0, 1) ** 2));
  if (f > 2.02) return corner((f - 2.02) / (F_FRONT - 2.02), 0.74);
  if (f < -2.05) return corner((-2.05 - f) / (-2.05 - F_REAR), 0.84);
  return 1;
}

/** Wheel arch edge height at f (−∞ outside the arches). */
export function archTop(f: number): number {
  let y = -Infinity;
  for (const a of AXLES) {
    const d = f - a;
    if (Math.abs(d) < ARCH_R) y = Math.max(y, ARCH_Y + Math.sqrt(ARCH_R * ARCH_R - d * d));
  }
  return y;
}

/** Lower edge of the flank away from the arches (side skirt, bumper bottoms). */
export const sillBase = (f: number): number => Math.max(0.19, yBot(f) + 0.03);

/** Flank half-width at height y (before plan rounding): flared over the wheels, tucked at the sill, tumblehome to the shoulder. */
export function sideX(f: number, y: number): number {
  let flare = 0;
  for (const a of AXLES) flare = Math.max(flare, 1 - smoothstep((Math.abs(f - a) - 0.4) / 0.3));
  const y0 = sillBase(f);
  const y1 = yBelt(f);
  const h = clamp((y - y0) / Math.max(y1 - y0, 1e-3), 0, 1);
  const tuck = h < 0.18 ? 0.03 * (1 - h / 0.18) ** 2 : 0;
  const tumble = h > 0.55 ? 0.036 * ((h - 0.55) / 0.45) ** 1.6 : 0;
  return 0.872 + 0.0205 * flare - tuck - tumble;
}

/** Hood / deck crown from the shoulder (q = 0) to the centreline (q = 1). */
export const crown = (q: number): number => 1 - (1 - q) ** 3;

/** Greenhouse roof crown from the rail (q = 0) to the centre: the hood's crown continued, so both meet at the cowl. */
const CROWN_G = crown(Q_G);
export const crownG = (q: number): number => (crown(Q_G + (1 - Q_G) * q) - CROWN_G) / (1 - CROWN_G);

/** Shoulder half-width (plan-rounded). */
export const shoulderX = (f: number): number => sideX(f, yBelt(f)) * planS(f);

/** Body top surface at (f, q): [x, y]. */
export function topPoint(f: number, q: number, out: number[] = [0, 0]): number[] {
  const yb = yBelt(f);
  out[0] = shoulderX(f) * (1 - q);
  out[1] = yb + (yTop(f) - yb) * crown(q);
  return out;
}

/** Body top height above (f, x) (x within the shoulder). */
export function topY(f: number, x: number): number {
  const q = clamp(1 - Math.abs(x) / shoulderX(f), 0, 1);
  const yb = yBelt(f);
  return yb + (yTop(f) - yb) * crown(q);
}

/** f on the nose slope where the top surface at x drops to height y (the slope falls monotonically with f). */
export function noseF(x: number, y: number): number {
  let lo = 2.05;
  let hi = F_FRONT;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (Math.abs(x) >= shoulderX(m) || topY(m, x) < y) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- greenhouse

/** Greenhouse centreline: windshield, roof, rear window. */
const yCentreMid = curve([
  [-1.5, 1.105], [-1.3, 1.225], [-1.1, 1.31], [-0.95, 1.34], [-0.7, 1.352], [-0.45, 1.345], [-0.3, 1.325],
  [-0.18, 1.285], [0.0, 1.195], [0.3, 1.04],
]);
/** Roof rail: A-pillar, roof edge, C-pillar. */
const yRailMid = curve([
  [-1.5, 1.07], [-1.3, 1.19], [-1.1, 1.275], [-0.95, 1.3], [-0.45, 1.305], [-0.3, 1.29], [-0.18, 1.255],
  [0.0, 1.165], [0.3, 1.01],
]);
const xRailMid = curve([[-1.5, 0.73], [-1.3, 0.69], [-0.95, 0.665], [-0.3, 0.675], [0.0, 0.71], [0.3, 0.74]]);

/** Blend from the body surface (at both ends of the greenhouse) into the free curve between them. */
function ends(f: number, atEnd: (f: number) => number, mid: (f: number) => number): number {
  if (f >= 0.3) return atEnd(F_WS) + (mid(0.3) - atEnd(F_WS)) * ((F_WS - f) / (F_WS - 0.3)) ** 1.05;
  if (f <= -1.5) return atEnd(F_RW) + (mid(-1.5) - atEnd(F_RW)) * ((f - F_RW) / (-1.5 - F_RW)) ** 0.85;
  return mid(f);
}

/** Where the greenhouse stands on the body: [x, y]. */
export const baseX = (f: number): number => shoulderX(f) * (1 - Q_G);
export const baseY = (f: number): number => topY(f, baseX(f));
export const roofY = (f: number): number => ends(f, (g) => yTop(g), yCentreMid);
export const railY = (f: number): number => ends(f, baseY, yRailMid);
export const railX = (f: number): number => ends(f, baseX, xRailMid);

/** Greenhouse top surface (windshield, roof, rear window) height above (f, x). */
export function screenY(f: number, x: number): number {
  const ry = railY(f);
  const q = clamp(1 - Math.abs(x) / railX(f), 0, 1);
  return ry + (roofY(f) - ry) * crownG(q);
}

// ---------------------------------------------------------------- glass outlines (livery and interior share them)

/** A- and C-pillar lines in side view: f where the roof rail passes height y (tabulated). */
export const pillarLines = (() => {
  const N = 64;
  const fa: number[] = [];
  const fc: number[] = [];
  const solve = (y: number, lo: number, hi: number, rising: boolean) => {
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (railY(m) > y === rising) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  };
  for (let k = 0; k <= N; k++) {
    const y = 0.8 + (0.55 * k) / N;
    fa.push(solve(y, -0.45, F_WS, false));
    fc.push(solve(y, F_RW, -0.95, true));
  }
  const at = (arr: number[], y: number) => {
    const t = clamp(((y - 0.8) / 0.55) * N, 0, N);
    const i = Math.min(N - 1, Math.floor(t));
    return arr[i] + (arr[i + 1] - arr[i]) * (t - i);
  };
  return { a: (y: number) => at(fa, y), c: (y: number) => at(fc, y) };
})();

/*
 * Glass outlines as signed margins (m, positive inside); `inset` shrinks the outline (a negative inset
 * grows it into the black rubber frame). The f-only terms come in precomputed: the livery evaluates
 * them per texel column.
 */

/** Side glass (door + quarter): above the belt, under the rail, between the A- and C-pillars. */
export function sideGlassMargin(f: number, y: number, inset: number, baseYf: number, railYf: number, aLineY: number, cLineY: number): number {
  return Math.min(y - (baseYf + 0.012 + inset), railYf - 0.032 - inset - y, aLineY - 0.07 - inset - f, f - (cLineY + 0.15 + inset));
}

/** Windshield in plan view (f, |x|): above the cowl, under the roof header, inside the A-pillars. */
export function windshieldMargin(f: number, x: number, inset: number, railXf: number): number {
  return Math.min(F_WS - 0.035 - inset - f, f - (-0.235 + inset), railXf - 0.055 - inset - Math.abs(x));
}

/** Rear window in plan view. */
export function rearWindowMargin(f: number, x: number, inset: number, railXf: number): number {
  return Math.min(f - (F_RW + 0.035 + inset), -1.0 - inset - f, railXf - 0.075 - inset - Math.abs(x));
}

// ---------------------------------------------------------------- cockpit (right-hand drive)

/** Driver's eye. */
export const EYE = { x: 0.36, y: 1.08, f: -0.7 };
/** Steering wheel centre, rim radius and tilt from vertical (top toward the dash). */
export const WHEEL = { x: 0.36, y: 0.82, f: -0.1, r: 0.185, tilt: 0.42 };
