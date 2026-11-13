/** Shared derivative at a height control, measured per horizontal metre.
 * The smaller same-sign secant is deliberately conservative: the resulting
 * cubic stays within its endpoint heights, including next to a flat plateau.
 */
export function boundedGrade(left: number, right: number): number {
  return left * right > 0 ? Math.sign(left) * Math.min(Math.abs(left), Math.abs(right)) : 0;
}

export function verticalProfile(a: number, b: number, length: number, startGrade: number, endGrade: number) {
  if (![a, b, length, startGrade, endGrade].every(Number.isFinite) || length <= 0) {
    throw new RangeError('Vertical profile requires finite heights, grades and positive length');
  }
  const delta = b - a;
  let height = (t: number) => {
    if (t === 0) return a;
    if (t === 1) return b;
    return a + delta * t * t * (3 - 2 * t)
      + length * (startGrade * t * (1 - t) ** 2 - endGrade * t * t * (1 - t));
  };
  // A cubic has linear second derivative: its endpoint maximum bounds the
  // difference between adjacent sampled chord grades as well as the tangent.
  let curvature = Math.max(Math.abs(6 * delta - length * (4 * startGrade + 2 * endGrade)),
    Math.abs(-6 * delta + length * (2 * startGrade + 4 * endGrade))) / length ** 2;
  const secant = delta / length;
  const c = 3 * (startGrade + endGrade - 2 * secant), d = 6 * secant - 4 * startGrade - 2 * endGrade;
  const vertex = c ? -d / (2 * c) : 0;
  const peak = Math.max(Math.abs(startGrade), Math.abs(endGrade),
    vertex > 0 && vertex < 1 ? Math.abs(startGrade + d * vertex + c * vertex ** 2) : 0);
  const limit = Math.max(.124, Math.abs(secant) * 1.01, Math.abs(startGrade), Math.abs(endGrade));
  if (peak > limit) {
    // A single cubic can increase a near-limit source grade by 50%. Instead
    // use two quadratic Hermite transitions and a constant-grade middle. Their
    // integrated area still equals delta, and their shared grades are exact.
    const q = Math.max(1e-6, Math.min(.25, (limit - Math.abs(secant)) / (2 * limit)));
    const middle = (secant - q * (startGrade + endGrade) / 2) / (1 - q);
    height = t => {
      if (t === 0) return a;
      if (t === 1) return b;
      if (t < q) return a + length * (startGrade * t + (middle - startGrade) * t * t / (2 * q));
      if (t > 1 - q) {
        const u = 1 - t;
        return b - length * (endGrade * u + (middle - endGrade) * u * u / (2 * q));
      }
      return a + length * (q * (startGrade + middle) / 2 + (t - q) * middle);
    };
    curvature = Math.max(Math.abs(middle - startGrade), Math.abs(middle - endGrade)) / (q * length);
  }
  const steps = Math.max(1, Math.ceil(length / 5), Math.ceil(length * curvature / .002));
  if (!Number.isFinite(steps) || steps > 100_000) {
    throw new RangeError('Vertical profile exceeds the 100000-segment sampling budget');
  }
  // Tiny endpoint chords expose the shared analytic tangent to sampleEdge,
  // rather than introducing a visible finite-sampling seam at way boundaries.
  const epsilon = Math.min(1e-5 / length, .25 / steps);
  const fractions = [epsilon, ...Array.from({ length: steps - 1 }, (_, i) => (i + 1) / steps), 1 - epsilon, 1];
  return { height, fractions };
}
