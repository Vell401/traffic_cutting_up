import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALL_D } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { getMap } from '../src/sim/maps';
import { MIAMI_CHUNKS, MIAMI_LEN, miamiZone } from '../src/sim/miami';
import { CHUNK_LEN, Road } from '../src/sim/road';
import { MeshBuilder } from '../src/render/meshBuilder';
import { canonicalChunk, miamiChunkSeed } from '../src/render/miami';
import { makeMiamiMaterials, makeSurfacePixels, setMiamiWater, SURFACE_SIZE } from '../src/render/miami/surfaces';
import {
  MIAMI_DECK, MIAMI_ISLANDS, MIAMI_OUT, MIAMI_QUAY, MIAMI_WATER, SURFACE, SURFACE_COUNT, SURFACE_TILE,
  miamiGround, miamiIslandY, miamiScene,
} from '../src/render/miami/terrain';
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

const roadFor = (theme: 'highway' | 'miami') => new Road(mulberry32(7), getMap(theme).script);
const meshes = (view: RoadView): THREE.Mesh[] => view.group.children.flatMap(c => c.children as THREE.Mesh[]);
/** Meshes of one chunk of the production (kit) road view: road, structure, glow, city, signs, water, pools, land. */
const LAND = 7, CITY = 3;

function snapshot(view: RoadView) {
  return meshes(view).map(m => {
    const g = m.geometry;
    const index = Array.from(g.index!.array.slice(0, g.drawRange.count));
    const count = index.length ? Math.max(...index) + 1 : 0;
    return { index, attributes: Object.fromEntries(Object.entries(g.attributes).map(([key, a]) =>
      [key, Array.from(a.array.slice(0, count * a.itemSize))])) };
  });
}

/** Height of the first upward surface of a mesh under road coordinates (s, d). */
function surfaceAt(road: Road, mesh: THREE.Mesh, s: number, d: number): number | undefined {
  const p = road.toWorld(s, d, { x: 0, z: 0, th: 0, k: 0 });
  const ray = new THREE.Raycaster(new THREE.Vector3(p.x, 60, p.z), new THREE.Vector3(0, -1, 0));
  return ray.intersectObject(mesh, false).find(h => h.face && h.face.normal.y > 0.5)?.point.y;
}

describe('Miami terrain model', () => {
  const road = roadFor('miami');
  road.ensure(-400, MIAMI_LEN + 400);

  it('gives every district its own pair of scenes, with open water on causeways and a hill over tunnels', () => {
    const at = (s: number) => [miamiScene(s / 100, -1).id, miamiScene(s / 100, 1).id];
    expect(at(500)).toEqual(['beach', 'strip']);
    expect(at(4000)).toEqual(['bay', 'bay']);
    expect(at(5400)).toEqual(['park', 'park']);
    expect(at(7600)).toEqual(['towers', 'towers']);
    expect(at(10500)).toEqual(['hill', 'hill']);
    expect(at(11500)).toEqual(['arts', 'arts']);
    expect(at(15000)).toEqual(['quay', 'lush']);
    expect(at(18000)).toEqual(['bay', 'bay']);
    expect(at(21000)).toEqual(['dunes', 'golf']);
    expect(at(24500)).toEqual(['villas', 'villas']);
    expect(at(28500)).toEqual(['park', 'towers']);
    for (let i = 0; i < MIAMI_CHUNKS; i++) for (const side of [-1, 1]) {
      const scene = miamiScene(i, side), kind = miamiZone(i).kind;
      expect(scene).toBe(miamiScene(i + MIAMI_CHUNKS, side));
      expect(scene).toBe(miamiScene(i - 2 * MIAMI_CHUNKS, side));
      if (kind === 'viaduct' || kind === 'bridge') expect(scene.id).toBe('bay');
      if (kind === 'tunnel') expect(scene.id).toBe('hill');
      // Bands run outward in order and cover the land to its edge.
      let previous = 15.5;
      for (const band of scene.bands) { expect(band.to).toBeGreaterThan(previous); previous = band.to; }
      expect(previous).toBe(MIAMI_OUT);
    }
  });

  it('is one continuous ground: no steps across chunk boundaries or along the shore, on either side', () => {
    let worst = 0, where = '';
    for (let i = 0; i < MIAMI_CHUNKS; i++) {
      const s = i * CHUNK_LEN;
      for (const d of [16, 20, 27, 33, 47.5, 49, 61, 90, 111, 125, 150, 200, 320, 500, 690]) for (const side of [-1, 1]) {
        const step = Math.abs(miamiGround(road, s - 0.01, side * d) - miamiGround(road, s + 0.01, side * d));
        if (step > worst) { worst = step; where = `s=${s} d=${side * d}`; }
      }
    }
    expect(worst, where).toBeLessThan(0.03);
    // Across the section the profile is continuous too (the quay wall is steep, not a tear).
    for (const s of [550, 15050, 21050, 28550]) for (const side of [-1, 1]) {
      for (let d = 15.6; d < 300; d += 0.05) {
        expect(Math.abs(miamiGround(road, s, side * (d + 0.05)) - miamiGround(road, s, side * d))).toBeLessThan(0.2);
      }
    }
  });

  it('puts the right ground in the right place: beach to the surf, marina boardwalk at the water, dry city, open bay', () => {
    // South Beach: level promenade, sand sloping down, surf past the shore; hotels on dry land.
    expect(miamiGround(road, 550, -25)).toBe(0);
    expect(miamiGround(road, 550, -100)).toBeLessThan(0);
    expect(miamiGround(road, 550, -100)).toBeGreaterThan(MIAMI_WATER);
    expect(miamiGround(road, 550, -160)).toBeLessThan(MIAMI_WATER);
    expect(miamiGround(road, 550, 400)).toBe(0);
    // Marina: upper promenade at road level, boardwalk just above the water, then the bay.
    expect(miamiGround(road, 15050, -20)).toBe(0);
    expect(miamiGround(road, 15050, -40)).toBeCloseTo(MIAMI_QUAY, 10);
    expect(miamiGround(road, 15050, -52)).toBeLessThan(MIAMI_WATER);
    // Causeway: water from the deck out, except on the islands.
    expect(miamiGround(road, 18300, 60)).toBeLessThan(MIAMI_WATER);
    expect(miamiGround(road, 18300, -340)).toBeGreaterThan(MIAMI_WATER + 1);
    // Tunnel: a hill over the road.
    expect(miamiGround(road, 10500, 60)).toBeGreaterThan(8);
    // Under a causeway the bay has one floor, however deep the road-side level of the section is.
    expect(miamiGround(road, 17499.99, -200)).toBe(miamiGround(road, 17500.01, -200));
  });

  it('keeps every island in the water of a causeway or off a shore, clear of the road', () => {
    for (const island of MIAMI_ISLANDS) {
      expect(Math.abs(island.d) - island.w).toBeGreaterThan(WALL_D + 2);
      expect(island.top).toBeGreaterThan(MIAMI_WATER + 0.5);
      expect(miamiIslandY(island, island.s, island.d)).toBe(island.top);
      expect(miamiIslandY(island, island.s + island.len + 1, island.d)).toBeLessThan(MIAMI_WATER);
      expect(miamiIslandY(island, island.s, island.d + island.w + 1)).toBeLessThan(MIAMI_WATER);
      // Seen whole: the same island one lap later is the same island.
      expect(miamiIslandY(island, island.s + MIAMI_LEN, island.d)).toBe(island.top);
      // It stands in water, not on top of the mainland profile.
      const side = Math.sign(island.d);
      const scene = miamiScene(Math.floor(island.s / CHUNK_LEN), side);
      expect(scene.shore).toBeLessThan(Math.abs(island.d) - island.w);
    }
  });
});

describe('Miami generated surfaces', () => {
  it('generates every ground layer deterministically, textured rather than flat, with a roughness channel', () => {
    const a = makeSurfacePixels(), b = makeSurfacePixels();
    const layer = SURFACE_SIZE * SURFACE_SIZE * 4;
    expect(a.length).toBe(layer * SURFACE_COUNT);
    expect(b).toEqual(a);
    expect(SURFACE_TILE).toHaveLength(SURFACE_COUNT);
    for (const tile of SURFACE_TILE) expect(1200 / tile).toBe(Math.round(1200 / tile));
    const means: number[][] = [];
    for (let l = 0; l < SURFACE_COUNT; l++) {
      const sum = [0, 0, 0];
      let min = 255, max = 0;
      for (let i = l * layer; i < (l + 1) * layer; i += 4) {
        sum[0] += a[i]; sum[1] += a[i + 1]; sum[2] += a[i + 2];
        min = Math.min(min, a[i + 1]); max = Math.max(max, a[i + 1]);
        expect(a[i + 3]).toBeGreaterThan(100);
      }
      // No flat fills: every layer has visible grain.
      expect(max - min).toBeGreaterThan(20);
      means.push(sum.map(v => v / (layer / 4)));
    }
    // Greens are green, sand is light and warm, asphalt is dark and neutral.
    for (const green of [SURFACE.grass, SURFACE.planting, SURFACE.lawn]) expect(means[green][1]).toBeGreaterThan(means[green][0] * 1.3);
    expect(means[SURFACE.sand][0]).toBeGreaterThan(190);
    expect(means[SURFACE.sand][0]).toBeGreaterThan(means[SURFACE.sand][2]);
    expect(means[SURFACE.asphalt][0]).toBeLessThan(90);
    expect(Math.abs(means[SURFACE.asphalt][0] - means[SURFACE.asphalt][1])).toBeLessThan(3);
  });

  it('owns its generated textures and patches land, water and facade shaders without touching kit maps', () => {
    const normal = new THREE.Texture();
    const m = makeMiamiMaterials(normal, 4);
    expect(m.textures).toHaveLength(4);
    expect(m.road.map).toBe(m.textures[0]);
    expect(m.road.normalMap).toBe(normal);
    expect(m.textures).not.toContain(normal);
    expect(m.struct.map).toBe(m.textures[1]);
    const compile = (material: THREE.Material) => {
      const shader = { ...THREE.ShaderLib.standard, uniforms: {} as Record<string, THREE.IUniform> };
      material.onBeforeCompile(shader as Parameters<THREE.Material['onBeforeCompile']>[0], {} as THREE.WebGLRenderer);
      return shader;
    };
    const land = compile(m.land);
    expect(land.uniforms.miamiSurfaces.value).toBe(m.textures[3]);
    expect(land.uniforms.miamiTile.value).toHaveLength(SURFACE_COUNT);
    expect(land.vertexShader).toContain('attribute float aLayer');
    expect(land.fragmentShader).toContain('sampler2DArray');
    expect(land.fragmentShader).not.toContain('#include <map_fragment>');
    const water = compile(m.water);
    expect(water.uniforms.miamiWaves.value).toBe(m.textures[2]);
    expect(water.fragmentShader).not.toContain('#include <normal_fragment_maps>');
    setMiamiWater(m.waterState, 1000 * 192 + 5, -7, 12);
    expect(water.uniforms.miamiWaterOrigin.value.x).toBeCloseTo(5, 6);
    expect(water.uniforms.miamiWaterOrigin.value.y).toBeCloseTo(-7, 6);
    expect(water.uniforms.miamiWaterTime.value).toBe(12);
    const city = compile(m.city);
    expect(city.vertexShader).toContain('attribute vec4 aWin');
    expect(city.uniforms.miamiNight).toBe(m.night);
    for (const material of [m.land, m.water, m.city]) expect(material.customProgramCacheKey()).toMatch(/^miami-/);
    for (const material of [m.road, m.struct, m.land, m.water, m.city]) material.dispose();
    m.textures.forEach(t => t.dispose());
  });

  it('sets the far disc to the bay level for Miami and leaves the highway ground alone', () => {
    const road = roadFor('miami'); road.ensure(0, CHUNK_LEN);
    const original = new FarGround(), coast = new FarGround('miami');
    original.update(road, 0, new THREE.Vector3()); coast.update(road, 0, new THREE.Vector3());
    expect((original.mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x0a0c0f);
    expect(coast.mesh.position.y).toBe(MIAMI_WATER);
    const water = new THREE.MeshStandardMaterial();
    coast.setMiamiMaterial(water); coast.update(road, 0, new THREE.Vector3(3, 0, 4));
    expect(coast.mesh.material).toBe(water);
    expect(coast.mesh.position.toArray()).toEqual([3, MIAMI_WATER, 4]);
    original.dispose(); coast.dispose(); water.dispose();
  });
});

describe('Miami land built by the road view', () => {
  it('draws the ground where the terrain model says it is, in every kind of district', () => {
    const road = roadFor('miami');
    const v = new RoadView(quality, 4, 'miami', 'assets');
    const probes: [number, number[]][] = [
      [550, [-18, -24, -29, -45, -90, 17, 22, 28, 45, 64, 120, 400]],
      [5450, [-30, -60, 30, 60]],
      [7650, [-17, -22, -30, -60, -78, 17, 22, 30, 60, 78, 300]],
      [15050, [-20, -28, -40, -47, 18, 23.5, 30, 60, 78, 200]],
      [21050, [-20, -25.5, -40, -90, 20, 25.5, 60, 300]],
      [24550, [-18, -21, -40, -76, 18, 21, 40, 76, 300]],
      [28550, [-20, -25, -50, -78, 22, 30, 60]],
    ];
    for (const [s, ds] of probes) {
      road.ensure(s - 300, s + 300);
      const first = Math.floor(s / 100) * 100;
      v.update(road, first, first + 99, 0, 0); v.group.updateMatrixWorld(true);
      const land = v.group.children[0].children[LAND] as THREE.Mesh;
      for (const d of ds) {
        const y = surfaceAt(road, land, s, d);
        expect(y, `no ground at s=${s} d=${d}`).toBeDefined();
        expect(y!).toBeCloseTo(miamiGround(road, s, d), 2);
      }
    }
    v.dispose();
  });

  it('raises islands out of the bay and draws nothing but water between them and the deck', () => {
    const road = roadFor('miami'); road.ensure(3600, 4300);
    const v = new RoadView(quality, 4, 'miami', 'assets'); v.update(road, 3900, 3999, 0, 0); v.group.updateMatrixWorld(true);
    const land = v.group.children[0].children[LAND] as THREE.Mesh;
    expect(surfaceAt(road, land, 3950, -235)).toBeCloseTo(MIAMI_WATER + 1.3, 3);
    // The port is a built pier: higher, and flat almost to its quay wall.
    expect(surfaceAt(road, land, 3950, 310)).toBeCloseTo(MIAMI_WATER + 1.9, 3);
    expect(surfaceAt(road, land, 3950, 310 - 150 * 0.9)).toBeCloseTo(MIAMI_WATER + 1.9, 3);
    // Open channel: anything drawn there is under the water plane.
    for (const d of [-60, -100, 60, 120]) expect(surfaceAt(road, land, 3950, d) ?? -Infinity).toBeLessThan(MIAMI_WATER);
    v.dispose();
  });

  it('replaces noise barriers with low garden and mural walls: nothing tall beside the road in walled sections', () => {
    const road = roadFor('miami');
    const miami = new RoadView(quality, 4, 'miami', 'assets'), plain = new RoadView(quality, 4, 'miami');
    const top = (mesh: THREE.Mesh) => {
      const p = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      let y = -Infinity;
      for (let i = 0; i < p.updateRanges[0].count / 3; i++) y = Math.max(y, p.getY(i));
      return y;
    };
    // Wynwood (mural wall) and Coral Gables (coral-stone wall with bougainvillea).
    for (const s of [12700, 25700]) {
      expect(miamiZone(s / 100).kind).toBe('walls');
      road.ensure(s - 300, s + 300);
      miami.update(road, s, s + 99, 0, 0); plain.update(road, s, s + 99, 0, 0);
      const structure = miami.group.children[0].children[1] as THREE.Mesh, land = miami.group.children[0].children[LAND] as THREE.Mesh;
      // The plain builder still stands 5.3 m panels on the barrier; Miami has only the barrier itself...
      expect(top(plain.group.children[0].children[1] as THREE.Mesh)).toBeGreaterThan(5);
      expect(top(structure)).toBeLessThan(1);
      // ...and a wall on the walkway low enough to see the palms and houses over.
      expect(top(land)).toBeGreaterThan(1.4);
      expect(top(land)).toBeLessThan(2.7);
      const layers = land.geometry.getAttribute('aLayer') as THREE.BufferAttribute;
      const used = new Set(Array.from({ length: layers.updateRanges[0].count }, (_, i) => layers.getX(i)));
      if (s > 20000) expect(used).toContain(SURFACE.flowers);
    }
    miami.dispose(); plain.dispose();
  });

  it('lays flower beds in parks and gardens and sand bunkers on the golf course', () => {
    const road = roadFor('miami');
    const v = new RoadView(quality, 4, 'miami', 'assets');
    const layersIn = (from: number, to: number) => {
      road.ensure(from - 300, to + 300); v.update(road, from, to - 1, 0, 0);
      const used = new Set<number>();
      for (const chunk of v.group.children) {
        const layers = (chunk.children[LAND] as THREE.Mesh).geometry.getAttribute('aLayer') as THREE.BufferAttribute;
        for (let i = 0; i < layers.updateRanges[0].count; i++) used.add(layers.getX(i));
      }
      return used;
    };
    // Bayfront park, Coral Gables gardens, the Grove: flowers. South Beach's hotel strip has none.
    for (const s of [28400, 24400, 15000]) expect(layersIn(s, s + 400), `flowers from ${s}`).toContain(SURFACE.flowers);
    expect(layersIn(400, 800)).not.toContain(SURFACE.flowers);
    // Key Biscayne: the land side is all lawn, so any sand there is a bunker; the ocean side has the beach.
    road.ensure(20700, 21500); v.update(road, 21000, 21399, 0, 0); v.group.updateMatrixWorld(true);
    let bunkers = 0;
    for (const chunk of v.group.children) {
      const land = chunk.children[LAND] as THREE.Mesh;
      const layers = land.geometry.getAttribute('aLayer') as THREE.BufferAttribute, uv = land.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const p = land.geometry.getAttribute('position') as THREE.BufferAttribute;
      // Bed vertices carry their signed lateral offset in u: positive is the golf side.
      for (let i = 0; i < layers.updateRanges[0].count; i++) if (layers.getX(i) === SURFACE.sand && uv.getX(i) > 30 && Math.abs(p.getY(i) - 0.1) < 1e-3) bunkers++;
    }
    expect(bunkers).toBeGreaterThan(30);
    v.dispose();
  });

  it('keeps all land, dressing and facade geometry outside the barrier, never in the road corridor', () => {
    const road = roadFor('miami');
    const v = new RoadView(quality, 4, 'miami', 'assets');
    for (const s of [300, 2700, 7400, 12200, 13700, 15100, 22300, 28700]) {
      road.ensure(s - 300, s + 300);
      // Straight chunks only: there the lateral offset of a vertex is a plain projection.
      expect(road.curvature(s)).toBe(0); expect(road.curvature(s + 100)).toBe(0);
      v.update(road, s, s + 99, 0, 0);
      const th = road.chunkAt(s).th[0];
      for (const index of [LAND, CITY]) {
        const g = (v.group.children[0].children[index] as THREE.Mesh).geometry;
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        let nearest = Infinity;
        for (let i = 0; i < p.updateRanges[0].count / 3; i++) nearest = Math.min(nearest, Math.abs(p.getX(i) * Math.cos(th) + p.getZ(i) * Math.sin(th)));
        expect(nearest, `s=${s} mesh ${index}`).toBeGreaterThanOrEqual(MIAMI_DECK - 1e-3);
      }
    }
    v.dispose();
  });

  it('covers all 300 chunks without buffer overflow, with a land mesh per chunk and only real ground layers', () => {
    const warn = vi.spyOn(console, 'warn');
    // MeshBuilder silently rejects excess indices: count real triangle attempts as well as warnings.
    const attempts = new Map<THREE.BufferGeometry, number>();
    const tri = MeshBuilder.prototype.tri;
    const triangleSpy = vi.spyOn(MeshBuilder.prototype, 'tri').mockImplementation(function (this: MeshBuilder, a, b, c) {
      attempts.set(this.geometry, (attempts.get(this.geometry) ?? 0) + 3);
      expect(Math.min(a, b, c)).toBeGreaterThanOrEqual(0);
      return tri.call(this, a, b, c);
    });
    const road = roadFor('miami'); road.ensure(0, MIAMI_LEN);
    const v = new RoadView(quality, 4, 'miami', 'assets'); v.update(road, 0, MIAMI_LEN - 1, 0, 0);
    expect(v.group.children).toHaveLength(MIAMI_CHUNKS);
    const all = meshes(v), materials = new Set(all.map(m => m.material));
    expect(all).toHaveLength(MIAMI_CHUNKS * 8);
    expect(materials.size).toBe(8);
    let facades = 0;
    for (const [n, m] of all.entries()) {
      expect(m.geometry.drawRange.count).toBe(attempts.get(m.geometry) ?? 0);
      for (const a of Object.values(m.geometry.attributes)) {
        const attribute = a as THREE.BufferAttribute;
        const used = attribute.updateRanges[0].count;
        expect(used).toBeLessThanOrEqual(attribute.array.length);
        expect(Array.from(attribute.array.slice(0, used)).every(Number.isFinite)).toBe(true);
      }
      const chunk = Math.floor(n / 8), kind = miamiZone(chunk).kind;
      if (n % 8 === LAND) {
        // Land everywhere there is land; a causeway far from any island may be all water.
        if (kind === 'open' || kind === 'walls' || kind === 'tunnel') expect(m.visible, `no land in chunk ${chunk}`).toBe(true);
        const layers = m.geometry.getAttribute('aLayer') as THREE.BufferAttribute;
        for (let i = 0; i < layers.updateRanges[0].count; i++) {
          expect(Number.isInteger(layers.getX(i))).toBe(true);
          expect(layers.getX(i)).toBeGreaterThanOrEqual(0);
          expect(layers.getX(i)).toBeLessThan(SURFACE.noise);
        }
        expect(m.receiveShadow).toBe(true);
      }
      if (n % 8 === CITY && m.visible) facades++;
      // The legacy per-chunk water mesh is gone: the bay is the single far disc.
      if (n % 8 === 5) expect(m.visible).toBe(false);
    }
    // Facade blocks behind the front row or across the water nearly everywhere outside tunnels.
    expect(facades).toBeGreaterThan(MIAMI_CHUNKS * 0.75);
    expect(warn).not.toHaveBeenCalled(); triangleSpy.mockRestore(); warn.mockRestore(); v.dispose();
  }, 120_000);

  it('rebuilds exactly the same attributes on another lap and keeps the floating origin outside geometry', () => {
    const road = roadFor('miami'), v = new RoadView(quality, 4, 'miami', 'assets');
    // The lap seam and the stretch either side of it: Bayfront into South Beach.
    road.ensure(-900, 900); v.update(road, -800, 799, 0, 0);
    const first = snapshot(v);
    for (const lap of [-1, 1, 8]) {
      const start = lap * MIAMI_LEN;
      road.ensure(start - 900, start + 900); v.update(road, start - 800, start + 799, 15000, -5000);
      const second = snapshot(v);
      expect(second.length).toBe(first.length);
      for (let i = 0; i < first.length; i++) {
        expect(second[i].index).toEqual(first[i].index);
        for (const key of Object.keys(first[i].attributes)) {
          // Positions, normals and the UVs projected from them are chunk-local floats: equal to rounding.
          if (key !== 'position' && key !== 'normal' && key !== 'uv') expect(second[i].attributes[key]).toEqual(first[i].attributes[key]);
          else {
            const a = first[i].attributes[key], b = second[i].attributes[key];
            expect(b.length).toBe(a.length);
            let error = 0;
            for (let n = 0; n < a.length; n++) error = Math.max(error, Math.abs(b[n] - a[n]));
            expect(error).toBeLessThan(0.0005);
          }
        }
      }
    }
    v.dispose();
  });

  it('disposes live/pooled geometry and owned materials/textures once, not per recycled chunk', () => {
    const road = roadFor('miami'); road.ensure(0, 500);
    const v = new RoadView(quality, 4, 'miami', 'assets'); v.update(road, 0, 499, 0, 0);
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
});

describe('Miami identity shared with the highway builder', () => {
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

  it('signs the districts of the lap in the same three-texture budget, preserving safety symbols', () => {
    const atlas = makeSignAtlas(4, 1, 'miami');
    expect(atlas.image.width).toBe(1024);
    expect(atlas.image.height).toBe(1536);
    expect(MIAMI_SIGNS).toHaveLength(8);
    for (const [label] of MIAMI_SIGNS) expect(text).toContain(label);
    for (const label of ['EXIT', 'SOS', 'FIRE']) expect(text).toContain(label);
    atlas.dispose();
  });

  it('seeds by canonical ring chunk; negative and future laps agree', () => {
    expect(canonicalChunk(301, MIAMI_LEN)).toBe(1);
    expect(canonicalChunk(-299, MIAMI_LEN)).toBe(1);
    expect(miamiChunkSeed(1, MIAMI_LEN)).toBe(miamiChunkSeed(601, MIAMI_LEN));
    expect(miamiChunkSeed(1, MIAMI_LEN)).not.toBe(miamiChunkSeed(2, MIAMI_LEN));
  });

  it('preserves the road/barrier geometry prefix, default highway, and its material colours', () => {
    const road = roadFor('highway'); road.ensure(0, 300);
    const normal = new RoadView(quality, 4), highway = new RoadView(quality, 4, 'highway');
    const miami = new RoadView(quality, 4, 'miami', 'assets');
    for (const v of [normal, highway, miami]) v.update(road, 0, 299, 0, 0);
    expect(snapshot(normal)).toEqual(snapshot(highway));
    const original = meshes(normal), coastal = meshes(miami);
    expect(original).toHaveLength(3 * 7);
    expect(coastal).toHaveLength(3 * 8);
    for (let c = 0; c < 3; c++) {
      // The road surface keeps its exact positions: Miami changes its texture mapping, never its shape.
      expect(coastal[c * 8].geometry.getAttribute('position').array).toEqual(original[c * 7].geometry.getAttribute('position').array);
      // Barrier cross-section is emitted first: 4 profile strips × 2 sides × 51 rows × 2 vertices.
      const barrierFloats = 4 * 2 * 51 * 2 * 3;
      for (const key of ['position', 'normal', 'color']) {
        expect(coastal[c * 8 + 1].geometry.getAttribute(key).array.slice(0, barrierFloats))
          .toEqual(original[c * 7 + 1].geometry.getAttribute(key).array.slice(0, barrierFloats));
      }
    }
    const water = original[5].material as THREE.MeshStandardMaterial;
    expect(water.color.getHex()).toBe(0x060c16);
    for (const v of [normal, highway, miami]) v.dispose();
  });
});
