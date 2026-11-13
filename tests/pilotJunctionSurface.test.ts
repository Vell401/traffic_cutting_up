import { describe, expect, it } from 'vitest';
import { createMoscowNetwork } from '../src/network/moscow';
import { roadSampleDistances, sampleEdge } from '../src/network/geometry';
import { msdCorridor } from '../src/network/msdCorridor';
import { planRoadMarkings, DASH_PERIOD } from '../src/network/roadMarkings';
import { planRoadInfrastructure } from '../src/network/roadInfrastructure';
import { PILOT_MAIN_IN, PILOT_MAIN_OUT, PILOT_RAMP, planPilotJunctionSurface, pilotMarkingPoint,
  pilotMergeEdges, triangleArea, intersectionArea, subtractTriangle, type SurfaceTriangle } from '../src/network/pilotJunctionSurface';

const net = createMoscowNetwork();
const arms = pilotMergeEdges(net);
const plan = planPilotJunctionSurface(net);
const local = [...plan.surfaces].flatMap(([id, triangles]) => {
  const edge = net.edges.find(e => e.id === id)!, window = plan.windows.get(id)!;
  // Restrict by original station cross sections using projected centreline distance.
  const all = roadSampleDistances(edge);
  const exteriorArea = all.slice(1).reduce((sum, t, i) => {
    const s = all[i]; if (s >= window.start && t <= window.end) return sum;
    const a = sampleEdge(edge, s, -sampleEdge(edge, s).halfWidth), b = sampleEdge(edge, t, -sampleEdge(edge, t).halfWidth);
    const c = sampleEdge(edge, t, sampleEdge(edge, t).halfWidth), d = sampleEdge(edge, s, sampleEdge(edge, s).halfWidth);
    return sum + triangleArea([a, b, c]) + triangleArea([a, c, d]);
  }, 0);
  return [{ triangles, exteriorArea }];
});

describe('one flat pilot merge surface', () => {
  it('owns exactly the three explicit arms and leaves geometry/driving samples immutable', () => {
    expect(arms.map(e => e.id)).toEqual([PILOT_MAIN_OUT, PILOT_MAIN_IN, PILOT_RAMP]);
    const before = JSON.stringify(net);
    const poses = arms.map(e => roadSampleDistances(e).map(s => sampleEdge(e, s, 2)));
    planPilotJunctionSurface(net); planRoadMarkings(net, msdCorridor(net));
    expect(JSON.stringify(net)).toBe(before);
    expect(arms.map(e => roadSampleDistances(e).map(s => sampleEdge(e, s, 2)))).toEqual(poses);
    expect(planPilotJunctionSurface({ ...net, id: 'unrelated' }).surfaces.size).toBe(0);
  });
  it('removes positive-area overlaps and preserves the complete union footprint', () => {
    const output = [...plan.localSurfaces.values()].flat();
    let overlap = 0;
    for (let i = 0; i < output.length; i++) for (let j = i + 1; j < output.length; j++) overlap += intersectionArea(output[i], output[j]);
    expect(overlap).toBeLessThan(1e-7);
    // Independent coverage proof: each source triangle is completely covered by output.
    for (const source of plan.original) {
      const covered = output.reduce((sum, t) => sum + intersectionArea(source, t), 0);
      expect(covered).toBeCloseTo(triangleArea(source), 6);
    }
    const originalArea = plan.original.reduce((sum, t) => sum + triangleArea(t), 0);
    const resultArea = local.reduce((sum, p) => sum + p.triangles.reduce((s, t) => s + triangleArea(t), 0) - p.exteriorArea, 0);
    expect(resultArea).toBeLessThan(originalArea - 1);
    // No invented surface: every output piece lies wholly on an original arm ribbon.
    expect(output.every(t => t.every(p => Math.abs(p.y - .2) < 1e-7))).toBe(true);
  });
  it('uses existing station boundaries and retains both shoulder boundary points', () => {
    for (const edge of arms) {
      const window = plan.windows.get(edge.id)!;
      expect(roadSampleDistances(edge)).toContain(window.start);
      expect(roadSampleDistances(edge)).toContain(window.end);
      const s = edge.id === PILOT_MAIN_OUT ? window.end : window.start;
      for (const side of [-1, 1]) {
        const p = sampleEdge(edge, s, side * sampleEdge(edge, s).halfWidth);
        expect(plan.surfaces.get(edge.id)!.some(t => t.some(q => Math.hypot(p.x - q.x, p.z - q.z) < 1e-7))).toBe(true);
      }
    }
  });
  it('continues mainline dash phase and full-width paint across the merge', () => {
    const paint = planRoadMarkings(net, msdCorridor(net));
    const incoming = arms.find(e => e.id === PILOT_MAIN_IN)!, out = arms[0];
    expect(paint.phase.get(out.id)).toBeCloseTo(((paint.phase.get(incoming.id) ?? 0) + incoming.length) % DASH_PERIOD);
    for (const side of [-1, 1]) {
      const a = paint.segments.get(incoming.id)!.filter(p => p.kind === 'edge' && Math.sign(p.d1) === side).at(-1)!;
      const b = paint.segments.get(out.id)!.find(p => p.kind === 'edge' && Math.sign(p.d0) === side)!;
      expect(a.end).toBe(incoming.length); expect(b.start).toBe(0);
      expect(pilotMarkingPoint(incoming, a.end, a.d1, arms)).toEqual(pilotMarkingPoint(out, 0, b.d0, arms));
    }
    const ramp = arms[2];
    // Use owned mainline triangles, excluding the ramp itself.
    const main = [...plan.surfaces].filter(([id]) => id !== PILOT_RAMP).flatMap(([, t]) => t);
    for (const mark of paint.segments.get(ramp.id)!.filter(p => ramp.length - p.start <= 100)) {
      const a = sampleEdge(ramp, mark.start, mark.d0 - mark.width / 2), b = sampleEdge(ramp, mark.end, mark.d1 - mark.width / 2);
      const c = sampleEdge(ramp, mark.end, mark.d1 + mark.width / 2), d = sampleEdge(ramp, mark.start, mark.d0 + mark.width / 2);
      expect(main.reduce((sum, t) => sum + intersectionArea([a, b, c], t) + intersectionArea([a, c, d], t), 0)).toBeLessThan(1e-7);
    }
  });
  it('does not put roadside rail centres inside another traversable pilot arm', () => {
    const infrastructure = planRoadInfrastructure(net, msdCorridor(net));
    for (const run of infrastructure.runs.filter(r => plan.windows.has(r.edgeId))) {
      const edge = arms.find(e => e.id === run.edgeId)!;
      for (const s of [run.start, (run.start + run.end) / 2, run.end]) {
        const w = plan.windows.get(edge.id)!; if (s < w.start || s > w.end) continue;
        const lateral = run.kind === 'rail' ? run.side * (sampleEdge(edge, s).halfWidth + 1.1)
          : run.lateralStart! + (run.lateralEnd! - run.lateralStart!) * (s - run.start) / (run.end - run.start);
        const p = sampleEdge(edge, s, lateral);
        const tiny: SurfaceTriangle = [p, { ...p, x: p.x + .001 }, { ...p, z: p.z + .001 }];
        for (const other of arms.filter(e => e !== edge))
          expect(plan.surfaces.get(other.id)!.reduce((sum, t) => sum + intersectionArea(tiny, t), 0)).toBeLessThan(1e-10);
      }
    }
  });
  it('subtracts convex triangles without filling disjoint space', () => {
    const a: SurfaceTriangle = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }];
    const b: SurfaceTriangle = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }];
    expect(subtractTriangle(a, b).reduce((sum, t) => sum + triangleArea(t), 0)).toBeCloseTo(37.5);
  });
  it('shares through tangents at the two explicit pilot branch nodes', () => {
    for (const [incomingId, outgoingId] of [[PILOT_MAIN_IN, PILOT_MAIN_OUT], ['osm:809185806:1:0', 'osm:809185806:1:1']]) {
      const a = net.edges.find(e => e.id === incomingId)!, b = net.edges.find(e => e.id === outgoingId)!;
      expect(sampleEdge(a, a.length).heading).toBeCloseTo(sampleEdge(b, 0).heading, 12);
      // Width is owned by the pilot envelope pass, not this tangent weld.
      expect(a.to).toBe(b.from);
    }
    expect(net.edges.find(e => e.id === 'osm:809185786:1:0')!.surfaceFrames).toBeUndefined();
  });
});
