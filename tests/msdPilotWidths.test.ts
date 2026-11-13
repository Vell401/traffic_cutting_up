import { describe, expect, it } from 'vitest';
import { applyMsdPilotWidths } from '../src/network/msdPilotWidths';
import { createMoscowNetwork } from '../src/network/moscow';
import { prepareRoadFrames } from '../src/network/roadFrames';
import { sampleEdge, type NetworkEdge } from '../src/network/geometry';

function fixture() {
  const n = createMoscowNetwork(undefined, { pilotWidths: false });
  for (const e of n.edges) delete e.surfaceFrames;
  return n;
}
const width = (e: NetworkEdge) => e.width ?? e.lanes * 3.6 + 3;

describe('section 01 mainline width continuity', () => {
  it('removes the first merge and bridge shoulder steps in both directions, without changing other geometry', () => {
    const n = fixture(), before = structuredClone(n);
    const finish = applyMsdPilotWidths(n, new Set(n.edges.map(e => e.id)));
    const changed = n.edges.filter((e, i) => e.width !== before.edges[i].width);
    expect(changed.length).toBeGreaterThan(10);
    prepareRoadFrames(n);
    const outsideFrames = new Map(n.edges.filter(e => !changed.includes(e)).map(e => [e.id, structuredClone(e.surfaceFrames)]));
    finish();
    const enabled = createMoscowNetwork(undefined, { pilotWidths: true });
    expect(enabled.edges.map(e => e.width)).toEqual(n.edges.map(e => e.width));
    for (const e of changed) {
      expect(enabled.edges.find(b => b.id === e.id)!.surfaceFrames!.map(f => f.halfWidth))
        .toEqual(e.surfaceFrames!.map(f => f.halfWidth));
    }
    for (const e of changed) {
      expect(e.width).toBeCloseTo(11.3);
      expect(e.points).toEqual(before.edges.find(b => b.id === e.id)!.points);
      for (const f of e.surfaceFrames!) expect(f.halfWidth).toBeGreaterThanOrEqual(5.65 - 1e-10);
      for (const next of changed.filter(b => b.from === e.to)) {
        expect(e.surfaceFrames!.at(-1)!.halfWidth).toBe(next.surfaceFrames![0].halfWidth);
      }
      for (let s = 1; s <= e.length; s++) {
        expect(Math.abs(sampleEdge(e, s).halfWidth - sampleEdge(e, s - 1).halfWidth)).toBeLessThan(.025);
      }
    }
    for (const e of n.edges.filter(e => !changed.includes(e))) {
      expect(e.width).toBe(before.edges.find(b => b.id === e.id)!.width);
      expect(e.surfaceFrames).toEqual(outsideFrames.get(e.id));
    }
    const end = n.edges.find(e => e.id === 'osm:809185806:1:3')!;
    const buffer = n.edges.find(e => e.id === 'osm:809185806:1:4')!;
    expect(end.surfaceFrames!.at(-1)!.halfWidth).toBe(buffer.surfaceFrames![0].halfWidth);
    expect(width(buffer)).toBeCloseTo(13.8);
    for (const e of changed) for (const start of [true, false]) {
      const neighbours = n.edges.filter(other => start ? other.to === e.from : other.from === e.to);
      const sameSide = n.edges.filter(other => start ? other.from === e.from : other.to === e.to);
      if (neighbours.length !== 1 || sameSide.length !== 1) continue;
      const other = neighbours[0];
      if (changed.includes(other) || !other.surfaceFrames) continue;
      const a = start ? e.surfaceFrames![0] : e.surfaceFrames!.at(-1)!;
      const b = start ? other.surfaceFrames!.at(-1)! : other.surfaceFrames![0];
      expect(a.halfWidth).toBe(b.halfWidth);
      for (const side of [-1, 1]) {
        const p = sampleEdge(e, start ? 0 : e.length, side * a.halfWidth);
        const q = sampleEdge(other, start ? other.length : 0, side * b.halfWidth);
        expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(1e-7);
      }
    }
  });

  it('leaves explicit widths, lane counts, ramps, other maps and already-built frames alone', () => {
    const n = fixture(), inferred = new Set(n.edges.filter(e => e.width === undefined).map(e => e.id));
    const e = n.edges.find(e => e.id === 'osm:809185810:1:0')!;
    e.width = 12.5;
    applyMsdPilotWidths(n, inferred);
    expect(e.width).toBe(12.5);
    const lanes = n.edges.find(e => e.id === 'osm:809185809:1:0')!;
    lanes.lanes = 4; delete lanes.width;
    applyMsdPilotWidths(n, new Set(n.edges.map(e => e.id)));
    expect(lanes.width).toBeUndefined();
    const other = fixture(); other.id = 'other';
    const snapshot = structuredClone(other);
    applyMsdPilotWidths(other, new Set(other.edges.map(e => e.id)))();
    expect(other).toEqual(snapshot);
    expect(() => applyMsdPilotWidths(createMoscowNetwork(), new Set(n.edges.map(e => e.id)))).toThrow(/before preparing/);
  });

  it('keeps positive median clearance between paired mainline envelopes on the actual pilot geometry', () => {
    const n = fixture();
    const finish = applyMsdPilotWidths(n, new Set(n.edges.map(e => e.id)));
    prepareRoadFrames(n); finish();
    const north = n.edges.filter(e => /osm:(809185810|809185809|809185806):/.test(e.id) && !e.id.endsWith(':4'));
    const south = n.edges.filter(e => /osm:(809185811|809185812|809185807):/.test(e.id));
    let checked = 0;
    for (const e of north) for (let s = 0; s <= e.length; s += 5) {
      const p = sampleEdge(e, s);
      let nearest = Infinity, halfWidth = 0;
      for (const other of south) for (let i = 1; i < other.points.length; i++) {
        const a = other.points[i - 1], b = other.points[i], dx = b.x - a.x, dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if ((dx * Math.sin(p.heading) - dz * Math.cos(p.heading)) / length > -.98) continue;
        const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / length ** 2;
        if (t < 0 || t > 1) continue;
        const distance = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
        if (distance < nearest) {
          nearest = distance;
          halfWidth = other.surfaceFrames![i - 1].halfWidth * (1 - t) + other.surfaceFrames![i].halfWidth * t;
        }
      }
      if (nearest < 20) { expect(nearest - p.halfWidth - halfWidth, `${e.id} s=${s} z=${p.z} separation=${nearest} widths=${p.halfWidth},${halfWidth}`).toBeGreaterThanOrEqual(.5); checked++; }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
