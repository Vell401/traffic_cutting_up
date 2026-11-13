import { roadSampleDistances, sampleEdge, type NetworkEdge, type Vec3 } from './geometry';

export interface LateralBounds { min: number; max: number }
const ribbons = new WeakMap<NetworkEdge, Vec3[][]>();

/** The same vertex-aligned strips as render.ts, not infinite projected road lines. */
function triangles(edge: NetworkEdge): Vec3[][] {
  let result = ribbons.get(edge);
  if (!result) {
    result = [];
    const stations = edge.surfaceFrames ? roadSampleDistances(edge) : Array.from({ length: Math.ceil(edge.length / 5) + 1 }, (_, i) => Math.min(edge.length, i * 5));
    for (let i = 0; i < stations.length - 1; i++) {
      const s = stations[i];
      if (s > 65 && edge.length - s > 70) continue;
      const end = stations[i + 1];
      const a = sampleEdge(edge, s, -sampleEdge(edge, s).halfWidth);
      const b = sampleEdge(edge, end, -sampleEdge(edge, end).halfWidth);
      const c = sampleEdge(edge, end, sampleEdge(edge, end).halfWidth);
      const d = sampleEdge(edge, s, sampleEdge(edge, s).halfWidth);
      result.push([a, b, c], [a, c, d]);
    }
    ribbons.set(edge, result);
  }
  return result;
}

export function adjoining(a: NetworkEdge, b: NetworkEdge): boolean {
  const p = sampleEdge(a, a.length), q = sampleEdge(b, 0);
  return a.to === b.from && Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) <= .5;
}

/** Cross-section of the connected, same-level ribbon union. Only the selected
 * movement and recorded entry are supplied by the caller; nearby roads never qualify.
 * Intersecting sections over the whole body keeps a finite car off the outer verge.
 */
export function movementBounds(edge: NetworkEdge, s: number, neighbors: NetworkEdge[], halfLength = 0): LateralBounds {
  const center = sampleEdge(edge, s);
  let min = -Infinity, max = Infinity;
  const count = Math.max(1, Math.ceil(halfLength * 2));
  for (let i = 0; i <= count; i++) {
    const along = -halfLength + 2 * halfLength * i / count;
    const at = sampleEdge(edge, s + along);
    const origin = { x: center.x + Math.sin(center.heading) * along, y: at.y, z: center.z - Math.cos(center.heading) * along };
    const intervals: LateralBounds[] = [{ min: -at.halfWidth, max: at.halfWidth }];
    for (const neighbor of neighbors) for (const triangle of triangles(neighbor)) {
      const hits: number[] = [];
      const coords = triangle.map(p => ({
        along: (p.x - origin.x) * Math.sin(center.heading) - (p.z - origin.z) * Math.cos(center.heading),
        d: (p.x - origin.x) * Math.cos(center.heading) + (p.z - origin.z) * Math.sin(center.heading), y: p.y,
      }));
      for (let j = 0; j < 3; j++) {
        const a = coords[j], b = coords[(j + 1) % 3];
        if (a.along * b.along > 0 || Math.abs(a.along - b.along) < 1e-9) continue;
        const t = a.along / (a.along - b.along);
        if (Math.abs(a.y + (b.y - a.y) * t - origin.y) <= 1) hits.push(a.d + (b.d - a.d) * t);
      }
      if (hits.length >= 2) intervals.push({ min: Math.min(...hits), max: Math.max(...hits) });
    }
    intervals.sort((a, b) => a.min - b.min);
    let section = { min: -at.halfWidth, max: at.halfWidth };
    // Multiple triangles may form a chain; never fill a disconnected lateral gap.
    for (let pass = 0; pass < intervals.length; pass++) {
      let changed = false;
      for (const interval of intervals) if (interval.min <= section.max + 1e-6 && interval.max >= section.min - 1e-6) {
        const lo = Math.min(section.min, interval.min), hi = Math.max(section.max, interval.max);
        changed ||= lo !== section.min || hi !== section.max;
        section = { min: lo, max: hi };
      }
      if (!changed) break;
    }
    min = Math.max(min, section.min); max = Math.min(max, section.max);
  }
  return { min, max };
}
