import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALL_D } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { getMap } from '../src/sim/maps';
import { CHUNK_LEN, Road } from '../src/sim/road';
import { makeCityMaterial } from '../src/render/city';
import { MeshBuilder } from '../src/render/meshBuilder';
import { canonicalChunk, MIAMI, miamiChunkSeed, miamiDeco, miamiFacade, miamiLayout, miamiPalm, miamiQuay, PALM_MIN_D } from '../src/render/miami';
import { RoadView } from '../src/render/roadView';
import { FarGround } from '../src/render/scenery';
import { applySky, HORIZON, makeSky, skyPreset } from '../src/render/sky';
import { makeSignAtlas, MIAMI_SIGNS } from '../src/render/textures';
import { QUALITY } from '../src/settings';

const quality = { ...QUALITY.medium, roadTex: 64 };
const text: string[] = [];

// Test real texture dimensions, ownership and atlas labels without requiring a browser canvas.
beforeEach(() => {
  text.length = 0;
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillText: (value: string) => text.push(value),
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} }) }),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function roadFor(theme: 'highway' | 'miami') {
  return new Road(mulberry32(7), getMap(theme).script);
}

function meshes(view: RoadView): THREE.Mesh[] {
  return view.group.children.flatMap(c => c.children as THREE.Mesh[]);
}

function snapshot(view: RoadView) {
  return meshes(view).map(m => {
    const g = m.geometry;
    const index = Array.from(g.index!.array.slice(0, g.drawRange.count));
    const count = index.length ? Math.max(...index) + 1 : 0;
    return { index, attributes: Object.fromEntries(Object.entries(g.attributes).map(([key, a]) =>
      [key, Array.from(a.array.slice(0, count * a.itemSize))])) };
  });
}

/** Roofs in the first land-side row, grouped by the stable window seed of each building. */
function nearRoofs(view: RoadView, heading: number) {
  const city = meshes(view)[3].geometry;
  const p = city.getAttribute('position') as THREE.BufferAttribute;
  const n = city.getAttribute('normal') as THREE.BufferAttribute;
  const win = city.getAttribute('aWin') as THREE.BufferAttribute;
  const roofs = new Map<number, Set<number>>();
  for (let i = 0; i < p.updateRanges[0].count / 3; i++) {
    const d = p.getX(i) * Math.cos(heading) + p.getZ(i) * Math.sin(heading);
    if (d < 22 || d > 100 || n.getY(i) < 0.9 || win.getW(i) >= 0) continue;
    const seed = win.getZ(i);
    if (!roofs.has(seed)) roofs.set(seed, new Set());
    roofs.get(seed)!.add(Math.round(p.getY(i) * 100) / 100);
  }
  return [...roofs.values()].map(values => [...values]);
}

describe('Miami visual identity and road safety', () => {
  it.each([
    [300, 'ocean-drive', 8, 30],
    [6000, 'marina', 8, 40],
    [8600, 'downtown', 65, 180],
  ] as const)('builds district-specific occupied facade setbacks at %s (%s)', (s, _district, min, max) => {
    const road = roadFor('miami'); road.ensure(s, s + 100);
    const v = new RoadView(quality, 4, 'miami'); v.update(road, s, s + 99, 0, 0);
    const roofs = nearRoofs(v, road.chunkAt(s).th[0]);
    expect(roofs.length).toBeGreaterThan(0);
    expect(roofs.every(levels => levels.length >= 2)).toBe(true);
    const highest = Math.max(...roofs.flat());
    expect(highest).toBeGreaterThanOrEqual(min);
    expect(highest).toBeLessThan(max);
    v.dispose();
  });

  it('keeps causeway near banks open and all bay surfaces on one level across bridge approaches', () => {
    const road = roadFor('miami'); road.ensure(0, 12000);
    const v = new RoadView(quality, 4, 'miami'); v.update(road, 0, 11999, 0, 0);
    for (let c = 0; c < 120; c++) {
      const p = meshes(v)[c * 7 + 5].geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.updateRanges[0].count / 3; i++) expect(p.getY(i)).toBe(-8);
    }
    const causeway = new RoadView(quality, 4, 'miami'); causeway.update(road, 2300, 2399, 0, 0);
    expect(nearRoofs(causeway, road.chunkAt(2300).th[0])).toHaveLength(0);
    causeway.dispose(); v.dispose();
  });

  it.each([[300, -62], [6000, -42], [8600, -62]])('brings the marina quay closer to the road without filling the bay at %s', (s, shore) => {
    const road = roadFor('miami'); road.ensure(s, s + 100);
    const v = new RoadView(quality, 4, 'miami'); v.update(road, s, s + 99, 0, 0);
    const p = meshes(v)[5].geometry.getAttribute('position') as THREE.BufferAttribute;
    const th = road.chunkAt(s).th[0];
    expect(p.getX(1) * Math.cos(th) + p.getZ(1) * Math.sin(th)).toBeCloseTo(shore, 4);
    v.dispose();
  });

  it('distinguishes three hotel silhouettes rather than recolouring one parapet', () => {
    const silhouettes = [0, 1, 2].map(variant => {
      const struct = new MeshBuilder({ maxVerts: 1500, maxIndices: 3000 });
      const glow = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
      miamiDeco(struct, glow, { x: 0, z: 0, th: 0 }, 43, -0.5, 36, 24, 23, variant);
      struct.finish();
      const p = struct.geometry.getAttribute('position') as THREE.BufferAttribute;
      const shape = Array.from(p.array.slice(0, p.updateRanges[0].count));
      struct.geometry.dispose(); glow.geometry.dispose();
      return JSON.stringify(shape);
    });
    expect(new Set(silhouettes).size).toBe(3);
  });

  it('gives palm crowns folded, shaded fronds instead of flat upward normals', () => {
    const mb = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
    miamiPalm(mb, { x: 0, z: 0, th: 0 }, PALM_MIN_D, 0, 9, 0);
    mb.finish();
    const p = mb.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = mb.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const folded = Array.from({ length: p.updateRanges[0].count / 3 }, (_, i) => i)
      .filter(i => p.getY(i) > 7 && Math.abs(n.getY(i)) < 0.95 && Math.abs(n.getY(i)) > 0.1);
    expect(folded.length).toBeGreaterThan(24);
    mb.geometry.dispose();
  });

  it('bounds every district facade, quay and pier outside the road/spawn shoulder', () => {
    for (const index of [3, 23, 60, 86]) {
      const layout = miamiLayout(index, 12000);
      const city = new MeshBuilder({ maxVerts: 3000, maxIndices: 4500, win: true });
      const struct = new MeshBuilder({ maxVerts: 9000, maxIndices: 16000 });
      const glow = new MeshBuilder({ maxVerts: 6000, maxIndices: 9000 });
      for (const facade of layout.facades) miamiFacade(city, struct, glow, { x: 0, z: -facade.s, th: 0 }, 0, facade, layout.district);
      miamiQuay(struct, glow, { x: 0, z: -50, th: 0 }, 0, true);
      for (const mb of [city, struct, glow]) {
        mb.finish();
        const p = mb.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.updateRanges[0].count / 3; i++) expect(Math.abs(p.getX(i))).toBeGreaterThan(WALL_D + 2);
        mb.geometry.dispose();
      }
    }
  });

  it('faces the sloped marina gangway upward so it remains visible from the active road', () => {
    const struct = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
    const glow = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
    miamiQuay(struct, glow, { x: 0, z: 0, th: 0 }, 0, true);
    struct.finish();
    const p = struct.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = struct.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const index = struct.geometry.index!;
    let rampTriangles = 0;
    for (let i = 0; i < struct.geometry.drawRange.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      if (n.getY(a) < 0.1 || n.getY(a) > 0.99) continue;
      const ab = new THREE.Vector3().fromBufferAttribute(p, b).sub(new THREE.Vector3().fromBufferAttribute(p, a));
      const ac = new THREE.Vector3().fromBufferAttribute(p, c).sub(new THREE.Vector3().fromBufferAttribute(p, a));
      expect(ab.cross(ac).y).toBeGreaterThan(0);
      rampTriangles++;
    }
    expect(rampTriangles).toBe(2);
    struct.geometry.dispose(); glow.geometry.dispose();
  });

  it('sinks near-building foundations into the lowest portal-approach terrain under their footprint', () => {
    const road = roadFor('miami'); road.ensure(9300, 11000);
    for (const s of [9500, 10600]) {
      const v = new RoadView(quality, 4, 'miami'); v.update(road, s, s + 99, 0, 0);
      const city = meshes(v)[3].geometry;
      const p = city.getAttribute('position') as THREE.BufferAttribute;
      const win = city.getAttribute('aWin') as THREE.BufferAttribute;
      for (const facade of miamiLayout(s / 100, 12000).facades.filter(f => f.d < 100 && f.d > 0)) {
        const bottom = Math.min(...Array.from({ length: p.updateRanges[0].count / 3 }, (_, i) => i)
          .filter(i => win.getZ(i) === facade.seed).map(i => p.getY(i)));
        const ground = Math.min(road.groundY(s + facade.s - facade.width / 2), road.groundY(s + facade.s + facade.width / 2));
        expect(bottom).toBeLessThan(ground);
      }
      v.dispose();
    }
  });
  it('has a distinct blue night preset without changing midnight/night or their transitions', () => {
    expect(skyPreset('midnight').horizon).toBe(0x0a0a12);
    expect(skyPreset('night').horizon).toBe(0x1c1a2c);
    const sky = makeSky(), preset = skyPreset('miami-night');
    expect(preset.id).toBe('miami-night');
    expect(preset.hemi).toBeGreaterThan(skyPreset('night').hemi);
    applySky(sky, preset);
    expect(HORIZON.getHex()).toBe(preset.horizon);
    applySky(sky, skyPreset('night'));
    expect(HORIZON.getHex()).toBe(0x1c1a2c);
  });

  it('uses coastal destinations in the same three-texture budget, preserving safety symbols', () => {
    const atlas = makeSignAtlas(4, 1, 'miami');
    expect(atlas.image.width).toBe(1024);
    expect(atlas.image.height).toBe(1536);
    for (const [label] of MIAMI_SIGNS) expect(text).toContain(label);
    for (const label of ['EXIT', 'SOS', 'FIRE']) expect(text).toContain(label);
    atlas.dispose();
  });

  it('keeps every palm canopy outside barriers, even facing toward the spawn shoulder', () => {
    for (const side of [-1, 1]) for (const phase of [0, Math.PI / 3, Math.PI]) for (const height of [7.5, 11.5]) {
      const mb = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
      miamiPalm(mb, { x: 0, z: 0, th: 0 }, side * PALM_MIN_D, 0, height, phase);
      mb.finish();
      const p = mb.geometry.getAttribute('position') as THREE.BufferAttribute;
      const used = p.updateRanges[0].count / 3;
      for (let i = 0; i < used; i++) expect(p.getX(i) * side).toBeGreaterThan(WALL_D + 1.5);
      expect(mb.geometry.boundingSphere!.radius).toBeGreaterThan(4);
      mb.geometry.dispose();
    }
  });

  it('preserves the road/barrier geometry prefix, default highway, and its material colours', () => {
    const road = roadFor('highway'); road.ensure(0, 300);
    const normal = new RoadView(quality, 4), highway = new RoadView(quality, 4, 'highway');
    const miami = new RoadView(quality, 4, 'miami');
    for (const v of [normal, highway, miami]) v.update(road, 0, 299, 0, 0);
    expect(snapshot(normal)).toEqual(snapshot(highway));
    const original = meshes(normal), coastal = meshes(miami);
    for (let c = 0; c < 3; c++) {
      expect(coastal[c * 7].geometry.getAttribute('position').array).toEqual(original[c * 7].geometry.getAttribute('position').array);
      // Barrier cross-section is emitted first: 4 profile strips × 2 sides × 51 rows × 2 vertices.
      const barrierFloats = 4 * 2 * 51 * 2 * 3;
      for (const key of ['position', 'normal', 'color']) {
        expect(coastal[c * 7 + 1].geometry.getAttribute(key).array.slice(0, barrierFloats))
          .toEqual(original[c * 7 + 1].geometry.getAttribute(key).array.slice(0, barrierFloats));
      }
    }
    const water = original[5].material as THREE.MeshStandardMaterial;
    expect(water.color.getHex()).toBe(0x060c16);
    for (const v of [normal, highway, miami]) v.dispose();
  });

  it('keeps hotel parapets and neon fins outside the protected road/spawn envelope', () => {
    const struct = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
    const glow = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
    for (const side of [-1, 1]) {
      struct.reset(); glow.reset();
      miamiDeco(struct, glow, { x: 0, z: 0, th: 0 }, side * 43, -0.5, 36, 24, 23, 1);
      for (const mb of [struct, glow]) {
        mb.finish();
        const p = mb.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let n = 0; n < p.updateRanges[0].count / 3; n++) expect(p.getX(n) * side).toBeGreaterThan(WALL_D + 2);
      }
    }
    struct.geometry.dispose(); glow.geometry.dispose();
  });
});

describe('canonical scenery, pooling and resource budgets', () => {
  it('seeds by canonical ring chunk and theme; negative and future laps agree', () => {
    expect(canonicalChunk(121, 12000)).toBe(1);
    expect(canonicalChunk(-119, 12000)).toBe(1);
    expect(miamiChunkSeed(1, 12000)).toBe(miamiChunkSeed(241, 12000));
    expect(miamiChunkSeed(1, 12000)).not.toBe(miamiChunkSeed(2, 12000));
    for (const index of [3, 23, 60, 86]) {
      expect(miamiLayout(index - 120, 12000)).toEqual(miamiLayout(index, 12000));
      expect(miamiLayout(index + 240, 12000)).toEqual(miamiLayout(index, 12000));
    }
    expect(miamiLayout(3, 12000).district).toBe('ocean-drive');
    expect(miamiLayout(23, 12000).district).toBe('causeway');
    expect(miamiLayout(60, 12000).district).toBe('marina');
    expect(miamiLayout(86, 12000).district).toBe('downtown');
    expect(miamiLayout(60, 12000).pier).toBe(true);
    expect(miamiLayout(3, 12000).pier).toBe(false);
    expect(miamiLayout(60, 12000).facades).not.toEqual(miamiLayout(61, 12000).facades);
  });

  it('rebuilds exactly the same attributes on another lap and keeps floating origin outside geometry', () => {
    const road = roadFor('miami'), v = new RoadView(quality, 4, 'miami');
    road.ensure(0, 12000); v.update(road, 0, 11999, 0, 0);
    const first = snapshot(v);
    for (const lap of [-1, 1, 8]) {
      const start = lap * 12000;
      road.ensure(start, start + 12000); v.update(road, start, start + 11999, 15000, -5000);
      const second = snapshot(v);
      for (let i = 0; i < first.length; i++) {
        expect(second[i].index).toEqual(first[i].index);
        for (const key of Object.keys(first[i].attributes)) {
          if (key !== 'position' && key !== 'normal') expect(second[i].attributes[key]).toEqual(first[i].attributes[key]);
          else {
            const a = first[i].attributes[key], b = second[i].attributes[key];
            expect(b.length).toBe(a.length);
            let error = 0;
            for (let n = 0; n < a.length; n++) error = Math.max(error, Math.abs(b[n] - a[n]));
            expect(error).toBeLessThan(0.00005);
          }
        }
      }
    }
    v.dispose();
  });

  it('covers all 120 chunks without buffer overflow or additional scene objects/lights/textures', () => {
    const warn = vi.spyOn(console, 'warn');
    // MeshBuilder silently rejects excess indices: count real triangle attempts as well as warnings.
    const attempts = new Map<THREE.BufferGeometry, number>();
    const tri = MeshBuilder.prototype.tri;
    const triangleSpy = vi.spyOn(MeshBuilder.prototype, 'tri').mockImplementation(function (this: MeshBuilder, a, b, c) {
      attempts.set(this.geometry, (attempts.get(this.geometry) ?? 0) + 3);
      expect(Math.min(a, b, c)).toBeGreaterThanOrEqual(0);
      return tri.call(this, a, b, c);
    });
    const road = roadFor('miami'); road.ensure(0, 12000);
    const v = new RoadView(quality, 4, 'miami'); v.update(road, 0, 11999, 0, 0);
    expect(v.group.children).toHaveLength(120);
    const all = meshes(v), materials = new Set(all.map(m => m.material));
    expect(all).toHaveLength(120 * 7);
    expect(materials.size).toBe(7);
    expect(new Set([...materials].flatMap(m => (m as THREE.MeshBasicMaterial).map ?? [])).size).toBe(3);
    for (const m of all) {
      expect(m.frustumCulled).toBe(true);
      expect(m.geometry.boundingSphere!.radius).toBeGreaterThanOrEqual(0);
      expect(m.geometry.drawRange.count / 3).toBeLessThan(6000);
      expect(m.geometry.drawRange.count).toBe(attempts.get(m.geometry) ?? 0);
      for (const a of Object.values(m.geometry.attributes)) {
        const attribute = a as THREE.BufferAttribute;
        const used = attribute.updateRanges[0].count;
        expect(used).toBeLessThanOrEqual(attribute.array.length);
        expect(Array.from(attribute.array.slice(0, used)).every(Number.isFinite)).toBe(true);
      }
    }
    expect(warn).not.toHaveBeenCalled(); triangleSpy.mockRestore(); warn.mockRestore(); v.dispose();
  });

  it('disposes live/pooled geometry and owned materials/textures once, not per recycled chunk', () => {
    const road = roadFor('miami'); road.ensure(0, 500);
    const v = new RoadView(quality, 4, 'miami'); v.update(road, 0, 499, 0, 0);
    const initial = meshes(v), geometry = initial.map(m => vi.spyOn(m.geometry, 'dispose'));
    const materials = [...new Set(initial.map(m => m.material as THREE.Material))];
    const materialSpies = materials.map(m => vi.spyOn(m, 'dispose'));
    const textures = materials.flatMap(m => (m as THREE.MeshBasicMaterial).map ?? []);
    const textureSpies = textures.map(t => vi.spyOn(t, 'dispose'));
    v.update(road, 300, 499, 1000, 1000); // Three chunks now pooled rather than live.
    for (const spy of [...geometry, ...materialSpies, ...textureSpies]) expect(spy).not.toHaveBeenCalled();
    v.dispose(); v.dispose();
    for (const spy of [...geometry, ...materialSpies, ...textureSpies]) expect(spy).toHaveBeenCalledTimes(1);
    expect(v.group.children).toHaveLength(0);
  });

  it('gives Miami bay water and warmer windows without sharing mutable material ownership', () => {
    const road = roadFor('miami'); road.ensure(0, CHUNK_LEN);
    const original = new FarGround(), coast = new FarGround('miami');
    original.update(road, 0, new THREE.Vector3()); coast.update(road, 0, new THREE.Vector3());
    expect((original.mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x0a0c0f);
    expect((coast.mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(MIAMI.water);
    const a = makeCityMaterial(), b = makeCityMaterial('miami');
    expect(a.uniforms.coastal.value).toBe(0); expect(b.uniforms.coastal.value).toBe(1);
    original.dispose(); coast.dispose(); a.dispose(); b.dispose();
  });
});
