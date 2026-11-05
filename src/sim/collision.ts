/*
 * Oriented boxes in the road plane: x along the road, y across it (right positive).
 * rot is the heading relative to the road, positive = turning right.
 */
export interface OBB {
  x: number;
  y: number;
  hx: number;
  hy: number;
  rot: number;
}

export interface Contact {
  /** Unit normal pointing from box A to box B. */
  nx: number;
  ny: number;
  depth: number;
}

const axes = new Float64Array(8);

/** Separating axis test. On overlap fills `out` with the minimum translation axis. */
export function obbOverlap(a: OBB, b: OBB, out: Contact): boolean {
  const ca = Math.cos(a.rot);
  const sa = Math.sin(a.rot);
  const cb = Math.cos(b.rot);
  const sb = Math.sin(b.rot);
  axes[0] = ca; axes[1] = sa;
  axes[2] = -sa; axes[3] = ca;
  axes[4] = cb; axes[5] = sb;
  axes[6] = -sb; axes[7] = cb;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let best = Infinity;
  for (let i = 0; i < 8; i += 2) {
    const ax = axes[i];
    const ay = axes[i + 1];
    const ra = a.hx * Math.abs(ca * ax + sa * ay) + a.hy * Math.abs(-sa * ax + ca * ay);
    const rb = b.hx * Math.abs(cb * ax + sb * ay) + b.hy * Math.abs(-sb * ax + cb * ay);
    const dist = dx * ax + dy * ay;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return false;
    if (overlap < best) {
      best = overlap;
      const sgn = dist < 0 ? -1 : 1;
      out.nx = ax * sgn;
      out.ny = ay * sgn;
    }
  }
  out.depth = best;
  return true;
}
