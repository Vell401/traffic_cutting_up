import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALL_D } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { getMap } from '../src/sim/maps';
import { CHUNK_LEN, Road } from '../src/sim/road';
import { makeCityMaterial } from '../src/render/city';
import { MeshBuilder } from '../src/render/meshBuilder';
import { canonicalChunk, MIAMI, miamiChunkSeed, miamiDeco, miamiPalm, PALM_MIN_D } from '../src/render/miami';
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
afterEach(() => vi.unstubAllGlobals());

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

describe('Miami visual identity and road safety', () => {
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
    for (const side of [-1, 1]) {
      const mb = new MeshBuilder({ maxVerts: 1000, maxIndices: 2000 });
      miamiPalm(mb, { x: 0, z: 0, th: 0 }, side * PALM_MIN_D, 0, 9, 0);
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
  });

  it('rebuilds exactly the same attributes on another lap and keeps floating origin outside geometry', () => {
    const road = roadFor('miami'), v = new RoadView(quality, 4, 'miami');
    road.ensure(0, 12000); v.update(road, 0, 11999, 0, 0);
    const first = snapshot(v);
    road.ensure(12000, 24000); v.update(road, 12000, 23999, 15000, -5000);
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
    v.dispose();
  });

  it('covers all 120 chunks without buffer overflow or additional scene objects/lights/textures', () => {
    const warn = vi.spyOn(console, 'warn');
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
    }
    expect(warn).not.toHaveBeenCalled(); warn.mockRestore(); v.dispose();
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
