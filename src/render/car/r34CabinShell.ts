/** Cabin-side fit contract for r34Exterior.greenhouse (metres, -Z forward).
 * Deliberately NOT the legacy r34Shape roof. Keep these stations aligned with the
 * exterior windshield/side/roof lofts; cabin trim never invents another aperture.
 */
export type CabinPoint = readonly [number, number, number];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, value: number) => { const t = Math.min(1, Math.max(0, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
function bodyTop(z: number, x: number): number {
  const belt = 0.875 - 0.103 * (1 - smooth(-2.1, -0.3, z)) + 0.061 * smooth(0.15, 2.1, z);
  const width = 0.865 + 0.0275 * Math.max(...[-1.35, 1.315].map(a => Math.exp(-(((z - a) / 0.43) ** 2))));
  const shoulder = width - 0.027;
  return belt + 0.038 * Math.sqrt(Math.max(0, 1 - (x / shoulder) ** 8));
}
function screen(rear: boolean, u: number, v: number): CabinPoint {
  const t = u * 2 - 1, baseZ = rear ? 1.66 : -0.62, top = cabinRoof(u, rear ? 1 : 0);
  return [mix(t * 0.755, top[0], v), mix(bodyTop(baseZ, t * 0.755), top[1], v) + 0.008 * (1 - t * t) * Math.sin(v * Math.PI),
    mix(baseZ, top[2], v) - (rear ? -1 : 1) * 0.018 * (1 - t * t) * Math.sin(v * Math.PI)];
}
export const cabinWindshield = (u: number, v: number): CabinPoint => screen(false, u, v);
export const cabinRearWindow = (u: number, v: number): CabinPoint => screen(true, u, v);
export function cabinSide(side: number, u: number, v: number): CabinPoint {
  const z = -0.62 + 2.28 * u, roof = cabinRoof(side > 0 ? 1 : 0, u);
  return [mix(side * 0.755, roof[0], v) + side * 0.006 * Math.sin(v * Math.PI) * Math.sin(u * Math.PI),
    mix(bodyTop(z, 0.755), roof[1], v), mix(z, roof[2], v)];
}
export function cabinRoof(u: number, v: number): CabinPoint {
  const t = u * 2 - 1, front = 0.18 - 0.035 * (1 - t * t), rear = 1.04 + 0.025 * (1 - t * t);
  return [t * (0.657 - 0.007 * Math.sin(v * Math.PI)), 1.316 + 0.038 * (1 - t * t) + 0.006 * Math.sin(v * Math.PI), mix(front, rear, v)];
}

/** Closed, non-circular upholstered return between the two actual A-pillar edges.
 * The outer half lies beneath the painted skin; the inner half wraps its width,
 * rather than following a displaced circular bar through the glass.
 */
export function cabinPillar(side: number, around: number, along: number): CabinPoint {
  // These are the APERTURE edges, not the common seam of the two exterior
  // surfaces. Using u=0 for both would collapse the lining into another bar.
  const front = cabinWindshield(side < 0 ? 0.034 : 0.966, along), back = cabinSide(side, 0.065, along);
  let t: number, depth: number;
  if (around <= 0.375) { t = around / 0.375; depth = 1; }
  else if (around <= 0.5) { t = 1; depth = 1 - (around - 0.375) / 0.125; }
  else if (around <= 0.875) { t = 1 - (around - 0.5) / 0.375; depth = 0; }
  else { t = 0; depth = (around - 0.875) / 0.125; }
  const roll = Math.sin(t * Math.PI) * depth;
  const inset = 0.002 + depth * 0.006 + roll * 0.013;
  return [front[0] + (back[0] - front[0]) * t - side * inset,
    front[1] + (back[1] - front[1]) * t - (0.002 + depth * 0.007 + roll * 0.006),
    front[2] + (back[2] - front[2]) * t + depth * 0.004];
}

/** Trim sits a consistent 14mm below the crowned roof, inset at the edge. */
export function cabinHeadliner(u: number, v: number): CabinPoint {
  const [x, y, z] = cabinRoof(0.008 + u * 0.984, 0.012 + v * 0.976);
  return [x, y - 0.014, z];
}
