export const G = 9.81;
export const KMH = 3.6;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential approach. */
export const damp = (cur: number, target: number, rate: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Move toward target by at most maxStep. */
export const moveTo = (cur: number, target: number, maxStep: number): number => {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
};

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export const wrapAngle = (a: number): number => {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

export const dampAngle = (cur: number, target: number, rate: number, dt: number): number =>
  cur + wrapAngle(target - cur) * (1 - Math.exp(-rate * dt));
