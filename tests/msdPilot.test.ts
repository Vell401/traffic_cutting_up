import { describe, expect, it } from 'vitest';
import source from '../data/moscow/network.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { msdPilotMainlineHeight, msdPilotScope } from '../src/network/msdPilot';
import { roadSampleDistances, sampleEdge, validateNetwork, type NetworkEdge, type Vec3 } from '../src/network/geometry';

const way = (e: NetworkEdge) => Number(e.id.split(':')[1]);
const cross = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function overlap(a: Vec3[], b: Vec3[]): Vec3[] {
  let polygon = a;
  const sign = Math.sign(cross(b[0], b[1], b[2]));
  for (let i = 0; i < 3 && polygon.length; i++) {
    const result: Vec3[] = [], start = b[i], end = b[(i + 1) % 3];
    let previous = polygon.at(-1)!, dp = sign * cross(start, end, previous);
    for (const current of polygon) {
      const dc = sign * cross(start, end, current);
      if ((dp >= 0) !== (dc >= 0)) {
        const t = dp / (dp - dc);
        result.push({ x: previous.x + t * (current.x - previous.x), y: 0, z: previous.z + t * (current.z - previous.z) });
      }
      if (dc >= 0) result.push(current);
      previous = current; dp = dc;
    }
    polygon = result;
  }
  return polygon;
}
const height = (t: Vec3[], p: Vec3) => (t[0].y * cross(p, t[1], t[2]) + t[1].y * cross(t[0], p, t[2])
  + t[2].y * cross(t[0], t[1], p)) / cross(t[0], t[1], t[2]);
function triangles(e: NetworkEdge): Vec3[][] {
  // Match renderer: unframed context has uniform 5m stations, framed roads
  // retain every runtime vertex.
  const ds = e.surfaceFrames ? roadSampleDistances(e) : Array.from({ length: Math.ceil(e.length / 5) + 1 }, (_, i) => Math.min(e.length, i * 5));
  return ds.slice(1).flatMap((s, i) => {
    const a = ds[i], w = sampleEdge(e, a).halfWidth, v = sampleEdge(e, s).halfWidth;
    const p = [sampleEdge(e, a, -w), sampleEdge(e, s, -v), sampleEdge(e, s, v), sampleEdge(e, a, w)];
    return [[p[0], p[1], p[2]], [p[0], p[2], p[3]]];
  });
}

describe('section 01 construction-time vertical pilot', () => {
  const before = createMoscowNetwork(undefined, { pilotVerticalAlignment: false, pilotWidths: false });
  const after = createMoscowNetwork(undefined, { pilotWidths: false });
  const scope = msdPilotScope(after);
  it('has explicit bounded scope and preserves every outside edge and handoff', () => {
    expect(scope.edgeIds.has('osm:809185806:1:3')).toBe(true);
    expect(scope.edgeIds.has('osm:809185806:1:4')).toBe(false);
    expect(scope.throughPairs).toContainEqual(['osm:809185806:1:0', 'osm:809185806:1:1']);
    for (let i = 0; i < after.edges.length; i++) {
      const a = before.edges[i], b = after.edges[i];
      if (!scope.edgeIds.has(b.id)) {
        expect({ ...b, surfaceFrames: undefined, width: undefined }).toEqual({ ...a, surfaceFrames: undefined, width: undefined });
        expect(b.width).toBe(a.width);
        // Frame widths are a separate inference pass: denser sampling inside
        // the pilot can alter an adjacent inferred shoulder's seam taper.
        // The vertical pass itself must preserve every outside point/endpoint.
      }
      expect([b.points[0].x, b.points[0].z, b.points.at(-1)!.x, b.points.at(-1)!.z])
        .toEqual([a.points[0].x, a.points[0].z, a.points.at(-1)!.x, a.points.at(-1)!.z]);
    }
    expect(validateNetwork(after)).toEqual([]);
    for (const e of after.edges) {
      expect(e.points[0].y).toBeCloseTo(after.nodes.find(n => n.id === e.from)!.position.y, 7);
      expect(e.points.at(-1)!.y).toBeCloseTo(after.nodes.find(n => n.id === e.to)!.position.y, 7);
    }
  });
  it('does not apply to supplied custom sources, including a cloned real source', () => {
    const custom = structuredClone(source);
    expect(createMoscowNetwork(custom)).toEqual(createMoscowNetwork(custom, { pilotVerticalAlignment: false }));
  });
  it('keeps dense mainline grades below 6%, without node flattening or height oscillations', () => {
    let peak = 0, jump = 0;
    const main = new Set([809185810, 809185809, 809185806, 809185807, 809185812, 809185811]);
    for (const e of after.edges.filter(e => scope.edgeIds.has(e.id) && main.has(way(e)))) {
      let previous: number | undefined;
      for (const s of roadSampleDistances(e, .5)) {
        const p = sampleEdge(e, s); peak = Math.max(peak, Math.abs(p.grade));
        if (previous !== undefined) jump = Math.max(jump, Math.abs(p.grade - previous));
        previous = p.grade;
        expect(Math.abs(p.y - msdPilotMainlineHeight(p.z))).toBeLessThan(.002);
      }
    }
    for (const [a, b] of scope.throughPairs) {
      const first = after.edges.find(e => e.id === a)!, last = after.edges.find(e => e.id === b)!;
      expect(Math.abs(sampleEdge(first, first.length).grade - sampleEdge(last, 0).grade)).toBeLessThan(.001);
    }
    expect(peak).toBeLessThan(.06); expect(jump).toBeLessThan(.002);
    // One rise, plateau, one descent. Same world alignment on both decks.
    for (let z = -951; z > -1280; z--) expect(msdPilotMainlineHeight(z)).toBeGreaterThanOrEqual(msdPilotMainlineHeight(z + 1));
    for (let z = -1451; z > -1834; z--) expect(msdPilotMainlineHeight(z)).toBeLessThanOrEqual(msdPilotMainlineHeight(z + 1));
    console.info('MSD pilot mainline metrics', { peakGrade: peak, maxSampleGradeJump: jump, editedContextEdges: scope.edgeIds.size });
  });
  it('removes loop hump and clears both actual bridge deck meshes above its ribbon', () => {
    const loop = after.edges.filter(e => way(e) === 809185783);
    expect(loop.every(e => e.points.every(p => Math.abs(p.y - .2) < 1e-5))).toBe(true);
    const lower = loop.flatMap(triangles);
    let minimum = Infinity, intersections = 0;
    for (const e of after.edges.filter(e => [809185809, 809185812].includes(way(e)))) for (const upper of triangles(e)) for (const under of lower) {
      if (Math.max(...upper.map(p => p.x)) < Math.min(...under.map(p => p.x)) || Math.min(...upper.map(p => p.x)) > Math.max(...under.map(p => p.x))
        || Math.max(...upper.map(p => p.z)) < Math.min(...under.map(p => p.z)) || Math.min(...upper.map(p => p.z)) > Math.max(...under.map(p => p.z))) continue;
      const polygon = overlap(upper, under);
      if (polygon.length < 3 || Math.abs(cross(polygon[0], polygon[1], polygon[2])) < 1e-9) continue;
      intersections++;
      for (const p of polygon) minimum = Math.min(minimum, height(upper, p) - .4 - height(under, p));
    }
    expect(intersections).toBeGreaterThan(0); expect(minimum).toBeGreaterThanOrEqual(6);
    console.info('MSD pilot actual deck/loop clearance', { intersections, minimum });
  });
});
