import { describe, expect, it } from 'vitest';
import { createMoscowNetwork } from '../src/network/moscow';
import { roadSampleDistances, sampleEdge, type NetworkEdge, type Vec3 } from '../src/network/geometry';
import { msdPresentationCorridor } from '../src/network/msdCorridor';
import { MSD_RAMP_CURB_END, msdPilotMainlineHeight, msdRampCurbRange } from '../src/network/msdPilot';
import { emitMsdEnvironment, MSD_ENVIRONMENT, msdTerrain } from '../src/network/msdEnvironment';
import { planRoadInfrastructure } from '../src/network/roadInfrastructure';
import { planRoadMarkings } from '../src/network/roadMarkings';
import { PILOT_DIVERGE_IN, PILOT_DIVERGE_OUT, PILOT_EXIT, intersectionArea, pilotDivergeEdges, planPilotDivergeSurface,
  triangleArea, type SurfaceTriangle } from '../src/network/pilotJunctionSurface';

const net = createMoscowNetwork();
const edge = (id: string) => net.edges.find(e => e.id === id)!;
// Heavy plans once at module scope (as other network suites do), not inside timed tests.
const corridor = msdPresentationCorridor(net);
const paint = planRoadMarkings(net, corridor), infrastructure = planRoadInfrastructure(net, corridor);
const ribbon = (e: NetworkEdge, from = 0, to = e.length): SurfaceTriangle[] => {
  const ds = roadSampleDistances(e).filter(s => s >= from - 1e-9 && s <= to + 1e-9);
  return ds.slice(1).flatMap((t, i) => {
    const s = ds[i], w = sampleEdge(e, s).halfWidth, v = sampleEdge(e, t).halfWidth;
    const a = sampleEdge(e, s, -w), b = sampleEdge(e, t, -v), c = sampleEdge(e, t, v), d = sampleEdge(e, s, w);
    return [[a, b, c], [a, c, d]] as SurfaceTriangle[];
  });
};

describe('section-01 exit diverge at 1575.7 m', () => {
  const plan = planPilotDivergeSurface(net);
  it('uses the three explicit arms and owns each overlapping fragment once', () => {
    expect(pilotDivergeEdges(net).map(e => e.id)).toEqual([PILOT_DIVERGE_IN, PILOT_DIVERGE_OUT, PILOT_EXIT]);
    const output = [...plan.localSurfaces.values()].flat();
    let overlap = 0;
    for (let i = 0; i < output.length; i++) for (let j = i + 1; j < output.length; j++) overlap += intersectionArea(output[i], output[j]);
    expect(overlap).toBeLessThan(1e-6);
    for (const source of plan.original) {
      expect(output.reduce((sum, t) => sum + intersectionArea(source, t), 0)).toBeCloseTo(triangleArea(source), 5);
    }
    // The exit genuinely lost asphalt to the mainline: it is no longer a stacked ribbon.
    const exitArea = (plan.surfaces.get(PILOT_EXIT) ?? []).reduce((sum, t) => sum + triangleArea(t), 0);
    expect(exitArea).toBeLessThan(ribbon(edge(PILOT_EXIT)).reduce((sum, t) => sum + triangleArea(t), 0) - 50);
  });
  it('keeps the deceleration lane on the mainline plane wherever their footprints overlap', () => {
    const exit = edge(PILOT_EXIT);
    let checked = 0;
    for (const s of roadSampleDistances(exit, 1)) {
      const p = sampleEdge(exit, s);
      expect(Math.abs(p.y - msdPilotMainlineHeight(p.z))).toBeLessThan(1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
    // The remainder eases to the immutable outside handoff without a hump.
    const rest = edge('osm:809185786:1:1');
    for (const s of roadSampleDistances(rest, .5)) expect(Math.abs(sampleEdge(rest, s).grade)).toBeLessThan(.04);
  });
  it('keeps exit paint off the mainline throat and continues mainline dash phase', () => {
    const main = [...ribbon(edge(PILOT_DIVERGE_IN)), ...ribbon(edge(PILOT_DIVERGE_OUT), 0, 100)];
    const exit = edge(PILOT_EXIT);
    for (const mark of paint.segments.get(PILOT_EXIT)!) {
      const a = sampleEdge(exit, mark.start, mark.d0 - mark.width / 2), b = sampleEdge(exit, mark.end, mark.d1 - mark.width / 2);
      const c = sampleEdge(exit, mark.end, mark.d1 + mark.width / 2), d = sampleEdge(exit, mark.start, mark.d0 + mark.width / 2);
      expect(main.reduce((sum, t) => sum + intersectionArea([a, b, c], t) + intersectionArea([a, c, d], t), 0)).toBeLessThan(1e-7);
    }
    // No isolated paint crumbs: contiguous pieces (split only at vertices) form ≥0.4 m runs.
    const pieces = paint.segments.get(PILOT_EXIT)!.map(m => ({ key: `${m.kind}:${Math.round(m.d0 * 10)}`, start: m.start, end: m.end }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.start - b.start);
    const runs: Array<{ key: string; start: number; end: number }> = [];
    for (const p of pieces) { const last = runs.at(-1); if (last && last.key === p.key && Math.abs(last.end - p.start) < 1e-6) last.end = p.end; else runs.push({ ...p }); }
    for (const run of runs) expect(run.end - run.start, run.key).toBeGreaterThan(.4);
    const into = edge(PILOT_DIVERGE_IN);
    expect(paint.phase.get(PILOT_DIVERGE_OUT)).toBeCloseTo(((paint.phase.get(into.id) ?? 0) + into.length) % 12, 6);
    // Mainline keeps both edge lines continuous through the diverge.
    for (const id of [PILOT_DIVERGE_IN, PILOT_DIVERGE_OUT]) for (const side of [-1, 1]) {
      const runs = paint.segments.get(id)!.filter(m => m.kind === 'edge' && Math.sign(m.d0) === side);
      expect(runs[0].start).toBe(0); expect(runs.at(-1)!.end).toBeCloseTo(edge(id).length, 7);
    }
  });
});

describe('section-01 entry ramp roadside (road frames, curbs)', () => {
  it('replaces guardrails and paint only on the observed curbed section', () => {
    const ramp = net.edges.filter(e => e.id.startsWith('osm:1207836341:1:'));
    let curbed = 0;
    for (const e of ramp) {
      const range = msdRampCurbRange(net, e);
      if (!range) continue;
      curbed += range[1] - range[0];
      for (const run of infrastructure.runs.filter(r => r.edgeId === e.id)) expect(run.start).toBeGreaterThanOrEqual(range[1] - 1e-7);
      for (const mark of paint.segments.get(e.id) ?? []) expect(mark.end).toBeGreaterThan(range[1]);
    }
    expect(curbed).toBeCloseTo(MSD_RAMP_CURB_END, 6);
    expect(infrastructure.coverage.curbReplacedMeters).toBeCloseTo(2 * MSD_RAMP_CURB_END, 6);
    // Guardrails remain after the curbed section, near the merge.
    expect(infrastructure.runs.some(r => r.edgeId === 'osm:1207836341:1:6')).toBe(true);
  });
});

describe('section-01 environment', () => {
  const terrain = msdTerrain(net);
  const boxes: Array<{ material: string; center: Vec3; height: number }> = [];
  let triangles = 0;
  const stats = emitMsdEnvironment(net, () => { triangles++; }, (material, center, _w, height) => { boxes.push({ material, center, height }); });
  it('never lets drawn terrain rise through any road surface', () => {
    let checked = 0, worst = Infinity;
    const x1 = terrain.x0 + (terrain.nx - 1) * terrain.step, z1 = terrain.z0 + (terrain.nz - 1) * terrain.step;
    for (const e of net.edges) {
      if (e.kind === 'tunnel' || e.kind === 'parking') continue;
      for (const s of roadSampleDistances(e, 3)) {
        const p = sampleEdge(e, s);
        if (p.x < terrain.x0 + 50 || p.x > x1 - 50 || p.z < terrain.z0 + 50 || p.z > z1 - 50) continue;
        for (const f of [-1, -.5, 0, .5, 1]) {
          const q = sampleEdge(e, s, f * p.halfWidth);
          if (!terrain.emitted(q.x, q.z)) continue; // no terrain drawn here (outside corridor, tunnel bore)
          // Bridges: compare with the 0.4 m deck underside, not the driving surface.
          const gap = q.y - (e.kind === 'bridge' ? .4 : 0) - terrain.height(q.x, q.z);
          worst = Math.min(worst, gap); checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(worst).toBeGreaterThan(.02);
    console.info('MSD terrain/road clearance', { samples: checked, minimumGap: worst });
  });
  it('raises embankments under elevated road but keeps the loop open under the bridge', () => {
    // Highest non-bridge northbound approach sample (before the 1334 m bridge).
    const road = edge('osm:809185810:1:2'), top = roadSampleDistances(road, 2).reduce((a, s) => sampleEdge(road, s).y > sampleEdge(road, a).y ? s : a, 0);
    const approach = sampleEdge(road, top), side = sampleEdge(road, top, approach.halfWidth + 1);
    expect(approach.y).toBeGreaterThan(3);
    expect(terrain.height(side.x, side.z)).toBeGreaterThan(approach.y - 1.5);
    const loop = net.edges.filter(e => e.id.startsWith('osm:809185783:'));
    for (const e of loop) for (const s of roadSampleDistances(e, 5)) {
      const p = sampleEdge(e, s); expect(terrain.height(p.x, p.z)).toBeLessThan(p.y - .2);
    }
  });
  it('places OSM features and lamp columns off every carriageway', () => {
    expect(stats.buildings).toBeGreaterThan(400);
    expect(stats.trees).toBeGreaterThan(500);
    expect(stats.railways).toBe(MSD_ENVIRONMENT.railways.length);
    expect(stats.lampPosts).toBeGreaterThan(60);
    const columns = boxes.filter(b => b.material === 'env:steel' && Math.abs(b.height - 10.4) < 1e-9);
    expect(columns.length).toBe(stats.lampPosts);
    for (const c of columns) expect(terrain.occupied(c.center.x, c.center.z, .1)).toBe(false);
    for (const b of MSD_ENVIRONMENT.buildings.slice(0, 200)) {
      const [x, z] = b.ring[0];
      if (terrain.occupied(x, z)) continue; // skipped by the emitter, counted separately
      expect(Number.isFinite(terrain.height(x, z))).toBe(true);
    }
    expect(triangles).toBeGreaterThan(100000);
    console.info('MSD environment', { ...stats, triangles, boxes: boxes.length });
  });
});
