/// <reference types="node" />
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { getMap } from '../src/sim/maps';
import { Road } from '../src/sim/road';
import { RoadView } from '../src/render/roadView';
import { QUALITY } from '../src/settings';
import { renderDocument } from './renderCanvas';
import { referenceRoadUpdate, roadOutput } from '../scripts/roadViewPerfcheck';

beforeEach(() => vi.stubGlobal('document', renderDocument));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const road = () => new Road(mulberry32(7), getMap('miami').script);
const view = () => new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami');
function snapshot(v: RoadView) {
  return v.group.children.map(c => ({ position: c.position.toArray(), meshes: c.children.map(o => {
    const m = o as THREE.Mesh, hash = createHash('sha256');
    const index = m.geometry.index!.array.slice(0, m.geometry.drawRange.count);
    const vertices = index.length ? Math.max(...index) + 1 : 0;
    hash.update(Buffer.from(index.buffer, index.byteOffset, index.byteLength));
    for (const a of Object.values(m.geometry.attributes)) {
      const used = a.array.slice(0, vertices * a.itemSize);
      hash.update(Buffer.from(used.buffer, used.byteOffset, used.byteLength));
    }
    return { geometry: m.geometry, material: m.material, hash: hash.digest('hex'), range: { ...m.geometry.drawRange }, visible: m.visible };
  }) }));
}

describe('RoadView scheduling', () => {
  it('matches every allocated baseline buffer byte/transform through identical recycling, origin shifts, teleports and replacement', () => {
    const r = road(), actual = view(), reference = view(); r.ensure(0,700);
    for (const v of [actual,reference]) v.update(r,0,499,0,0);
    for (const [start, ox, oz] of [[0,0,0],[0,200,-300],[200,200,-300],[24300,1000,-2000],[-12000,-900,1000],[0,0,0]]) {
      r.ensure(start,start+700); actual.update(r,start,start+499,ox,oz); referenceRoadUpdate(reference,r,start,start+499,ox,oz);
      expect(roadOutput(actual)).toBe(roadOutput(reference));
    }
    const replacement = road(); replacement.ensure(0,700);
    actual.update(replacement,0,499,0,0); referenceRoadUpdate(reference,replacement,0,499,0,0);
    expect(roadOutput(actual)).toBe(roadOutput(reference)); actual.dispose(); reference.dispose();
  });
  it('skips reconciliation and transform writes for identical index range/version/origin', () => {
    const r = road(), v = view(); r.ensure(0, 500); v.update(r, 0, 499, 0, 0);
    const before = snapshot(v), writes = v.group.children.map(c => vi.spyOn(c.position, 'set'));
    const scan = vi.spyOn(r.chunks, Symbol.iterator);
    v.update(r, 1, 498, 0, 0); v.update(r, 1, 498, 0, 0);
    expect(scan).not.toHaveBeenCalled(); writes.forEach(s => expect(s).not.toHaveBeenCalled());
    expect(snapshot(v)).toEqual(before); v.dispose();
  });

  it('origin-only invalidation repositions every live chunk without scanning/rebuilding content', () => {
    const r = road(), v = view(); r.ensure(0, 500); v.update(r, 0, 499, 0, 0);
    const before = snapshot(v), scan = vi.spyOn(r.chunks, Symbol.iterator);
    v.update(r, 0, 499, 1000, -2000);
    expect(scan).not.toHaveBeenCalled();
    const after = snapshot(v);
    after.forEach((c, i) => {
      expect(c.position).toEqual([before[i].position[0] - 1000, 0, before[i].position[2] + 2000]);
      expect(c.meshes).toEqual(before[i].meshes);
    }); v.dispose();
  });

  it('invalidates road identity even at identical indexes/version and reconciles same-index replacement on version changes', () => {
    const a = road(), b = road(), v = view(); a.ensure(0, 300); b.ensure(0, 300);
    v.update(a, 0, 299, 0, 0);
    b.chunks[0].light = a.chunks[0].light === 'led' ? 'sodium' : 'led';
    const expected = view(); expected.update(b, 0, 299, 0, 0);
    v.update(b, 0, 299, 0, 0); expect(snapshot(v).map(c => c.meshes.map(m => m.hash))).toEqual(snapshot(expected).map(c => c.meshes.map(m => m.hash)));
    const old = snapshot(v)[0].meshes.map(m => m.hash);
    b.chunks[0] = a.chunks[0]; b.version++;
    v.update(b, 0, 299, 0, 0);
    expect(snapshot(v)[0].meshes.map(m => m.hash)).not.toEqual(old);
    v.dispose(); expected.dispose();
  });

  it('matches a fresh scene through range recycling, teleports, negative laps and empty transitions', () => {
    const r = road(), v = view();
    for (const [start, end, ox, oz] of [[0,499,0,0],[200,699,30,-40],[24300,24799,500,-600],[-12000,-11501,-900,1000],[0,299,0,0]]) {
      r.ensure(start, end + 1); v.update(r, start, end, ox, oz);
      const fresh = view(); fresh.update(r, start, end, ox, oz);
      const output = (w: RoadView) => snapshot(w).map(c => ({ position: c.position, meshes: c.meshes.map(({ hash, range, visible }) => ({ hash, range, visible })) })).sort((a,b) => a.position[2] - b.position[2]);
      expect(output(v)).toEqual(output(fresh)); fresh.dispose();
    }
    r.chunks.length = 0; r.version++;
    expect(() => v.update(r, 0, 299, 0, 0)).not.toThrow(); expect(v.group.children).toHaveLength(0);
    v.update(r, 0, 299, 0, 0); r.ensure(-12000, -11700); v.update(r, -12000, -11701, 3, 4);
    expect(v.group.children).toHaveLength(3); v.dispose();
  });
});
