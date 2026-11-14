import * as THREE from 'three';
import { mulberry32 } from '../../core/rng';
import { SURFACE, SURFACE_COUNT, SURFACE_TILE } from './terrain';

/*
 * Miami ground, water and road surfaces, generated as plain pixel arrays: no canvas, no downloads.
 *
 * Every ground surface is one layer of a texture array, so a whole chunk of land (grass verge,
 * pavers, sand, side streets, planting) is still a single draw. All patterns are periodic in the
 * layer, and a low-frequency grey layer varies their tone across tens of metres so nothing reads
 * as a small repeating tile.
 */

export const SURFACE_SIZE = 256;

/** Tileable value noise: `fx` × `fy` random lattice, smoothly interpolated over a size² image. */
function lattice(seed: number, fx: number, fy: number, size: number, out: Float32Array, gain: number): void {
  const rng = mulberry32(seed);
  const cells = new Float32Array(fx * fy);
  for (let i = 0; i < cells.length; i++) cells[i] = rng();
  for (let y = 0; y < size; y++) {
    const v = (y / size) * fy;
    const y0 = Math.floor(v);
    const ty = v - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % fy) * fx;
    const r1 = ((y0 + 1) % fy) * fx;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * fx;
      const x0 = Math.floor(u);
      const tx = u - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const a = x0 % fx;
      const b = (x0 + 1) % fx;
      const top = cells[r0 + a] + (cells[r0 + b] - cells[r0 + a]) * sx;
      const bottom = cells[r1 + a] + (cells[r1 + b] - cells[r1 + a]) * sx;
      out[y * size + x] += (top + (bottom - top) * sy) * gain;
    }
  }
}

/** Fractal noise in 0..1 with the base lattice fx × fy (unequal values stretch it into grain). */
function fbm(seed: number, fx: number, fy: number, octaves: number, size: number): Float32Array {
  const out = new Float32Array(size * size);
  let gain = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    lattice(seed + o * 101, Math.min(size, fx << o), Math.min(size, fy << o), size, out, gain);
    total += gain;
    gain *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Tileable cells: per pixel the id of the nearest of g × g jittered points and how close the next one is. */
function cells(seed: number, g: number, size: number): { id: Uint16Array; edge: Float32Array } {
  const rng = mulberry32(seed);
  const px = new Float32Array(g * g);
  const py = new Float32Array(g * g);
  for (let i = 0; i < g * g; i++) {
    px[i] = rng();
    py[i] = rng();
  }
  const id = new Uint16Array(size * size);
  const edge = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y / size) * g;
    const cy = Math.floor(v);
    for (let x = 0; x < size; x++) {
      const u = (x / size) * g;
      const cx = Math.floor(u);
      let best = 9;
      let second = 9;
      let which = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const k = (((cy + oy) % g) + g) % g * g + (((cx + ox) % g) + g) % g;
          const dx = cx + ox + px[k] - u;
          const dy = cy + oy + py[k] - v;
          const dist = dx * dx + dy * dy;
          if (dist < best) {
            second = best;
            best = dist;
            which = k;
          } else if (dist < second) second = dist;
        }
      }
      id[y * size + x] = which;
      edge[y * size + x] = Math.sqrt(second) - Math.sqrt(best);
    }
  }
  return { id, edge };
}

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** RGBA bytes of every ground layer: sRGB colour, roughness in alpha. */
export function makeSurfacePixels(size = SURFACE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4 * SURFACE_COUNT);
  const fine = fbm(11, 32, 32, 3, size);
  const mid = fbm(23, 8, 8, 4, size);
  const coarse = fbm(37, 3, 3, 5, size);
  const grain = fbm(41, 64, 4, 3, size);
  const grit = new Float32Array(size * size);
  const rng = mulberry32(53);
  for (let i = 0; i < grit.length; i++) grit[i] = rng();
  const stones = cells(67, 5, size);
  const leaves = cells(71, 14, size);

  const put = (layer: number, i: number, r: number, g: number, b: number, rough: number): void => {
    const o = (layer * size * size + i) * 4;
    out[o] = Math.max(0, Math.min(255, Math.round(r * 255)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
    out[o + 3] = Math.round(rough * 255);
  };

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const f = fine[i] - 0.5;
      const m = mid[i] - 0.5;
      const c = coarse[i] - 0.5;
      const n = grit[i] - 0.5;

      // Concrete: cast slabs 1.5 m square with a fine joint.
      {
        const ju = Math.abs(((u * 2) % 1) - 0.5);
        const jv = Math.abs(((v * 2) % 1) - 0.5);
        const joint = ju > 0.492 || jv > 0.492 ? 0.74 : 1;
        const k = (0.9 + 0.3 * m + 0.16 * f + 0.07 * n) * joint;
        put(SURFACE.concrete, i, 0.7 * k, 0.69 * k, 0.66 * k, 0.9);
      }
      // Pavers: 60 × 30 cm running bond in warm Miami stone.
      {
        const row = Math.floor(v * 8);
        const across = u * 4 + (row % 2) * 0.5;
        const col = Math.floor(across) % 4;
        const fu = across - Math.floor(across);
        const fv = v * 8 - row;
        const joint = fu < 0.035 || fv < 0.07;
        const tone = 0.86 + 0.22 * hash(col * 7 + row * 13) + 0.2 * f + 0.06 * n;
        if (joint) put(SURFACE.pavers, i, 0.45, 0.42, 0.38, 0.95);
        else put(SURFACE.pavers, i, 0.8 * tone, 0.72 * tone, 0.63 * tone, 0.82);
      }
      // Grass: mottled, never one flat green.
      {
        const t = 0.5 + m * 1.6;
        const k = 0.86 + 0.5 * f + 0.14 * n;
        put(SURFACE.grass, i, (0.2 + 0.15 * t) * k, (0.36 + 0.15 * t) * k, (0.12 + 0.07 * t) * k, 0.95);
      }
      // Sand: wind ripples and footprints-scale mottling.
      {
        const ripple = Math.sin((v * 12 + mid[i] * 2.2) * Math.PI * 2) * 0.028;
        const k = 0.95 + 0.14 * c + ripple + 0.07 * n + 0.08 * f;
        put(SURFACE.sand, i, 0.87 * k, 0.8 * k, 0.64 * k, 0.96);
      }
      // Asphalt of side streets and car parks.
      {
        const k = 0.25 + 0.1 * n + 0.07 * f + 0.06 * m;
        put(SURFACE.asphalt, i, k, k, k * 1.03, 0.92);
      }
      // Rock: riprap boulders with dark gaps.
      {
        const tone = 0.52 + 0.4 * hash(stones.id[i] * 3.7);
        const gap = Math.min(1, stones.edge[i] * 9);
        const k = tone * (0.45 + 0.55 * gap) * (0.9 + 0.3 * f);
        put(SURFACE.rock, i, 0.66 * k, 0.62 * k, 0.56 * k, 0.9);
      }
      // Wood: 20 cm deck boards running along the road.
      {
        const board = Math.floor(u * 10);
        const fu = u * 10 - board;
        const tone = (0.8 + 0.34 * hash(board * 5.3)) * (0.86 + 0.5 * (grain[i] - 0.5));
        if (fu < 0.05) put(SURFACE.wood, i, 0.16, 0.11, 0.08, 0.9);
        else put(SURFACE.wood, i, 0.56 * tone, 0.4 * tone, 0.25 * tone, 0.78);
      }
      // Planting: dense groundcover, leaf-sized blobs with shaded gaps.
      {
        const t = hash(leaves.id[i] * 1.9);
        const depth = 0.5 + 0.5 * Math.min(1, leaves.edge[i] * 16);
        const k = depth * (0.85 + 0.4 * f);
        put(SURFACE.planting, i, (0.1 + 0.14 * t) * k, (0.24 + 0.2 * t) * k, (0.08 + 0.07 * t) * k, 0.9);
      }
      // Tiles: 60 cm plaza squares in two creams.
      {
        const col = Math.floor(u * 4);
        const row = Math.floor(v * 4);
        const fu = u * 4 - col;
        const fv = v * 4 - row;
        const joint = fu < 0.03 || fv < 0.03;
        const tone = ((col + row) % 2 ? 0.93 : 1) * (0.94 + 0.1 * hash(col * 3 + row * 11) + 0.14 * f + 0.05 * n);
        if (joint) put(SURFACE.tiles, i, 0.56, 0.53, 0.49, 0.9);
        else put(SURFACE.tiles, i, 0.84 * tone, 0.78 * tone, 0.7 * tone, 0.6);
      }
      // Lawn: mown stripes 2 m wide.
      {
        const stripe = Math.floor(u * 2) % 2 ? 0.93 : 1.05;
        const k = stripe * (0.9 + 0.36 * f + 0.1 * n + 0.2 * m);
        put(SURFACE.lawn, i, 0.25 * k, 0.45 * k, 0.15 * k, 0.95);
      }
      {
        const k = coarse[i];
        put(SURFACE.noise, i, k, k, k, 1);
      }
    }
  }
  return out;
}

export function makeSurfaceTexture(anisotropy = 4): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(makeSurfacePixels(), SURFACE_SIZE, SURFACE_SIZE, SURFACE_COUNT);
  texture.name = 'miami/surfaces';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

function dataTexture(name: string, pixels: Uint8Array, size: number, colorSpace: THREE.ColorSpace, anisotropy: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** One repeat of the road surface is 8 m: two lanes, each with slightly polished wheel tracks. */
export const ROAD_TILE = 8;

export function makeAsphaltPixels(size = 512): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const fine = fbm(83, 64, 64, 3, size);
  const patch = fbm(89, 4, 4, 4, size);
  const rng = mulberry32(97);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Lane centres sit at u = 0.25 and 0.75; tyres run 0.8 m either side of them.
      const lane = (((x / size) * 2) % 1) - 0.5;
      const track = Math.exp(-((Math.abs(lane) - 0.2) ** 2) / 0.006);
      const k = 0.305 + 0.11 * (rng() - 0.5) + 0.08 * (fine[i] - 0.5) + 0.07 * (patch[i] - 0.5) - 0.022 * track;
      const b = Math.max(0, Math.min(255, Math.round(k * 255)));
      const o = i * 4;
      out[o] = b;
      out[o + 1] = b;
      out[o + 2] = Math.min(255, b + 3);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Near-white cast concrete for barriers and structures; vertex colours set the actual tone. */
export function makeConcretePixels(size = 256): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const fine = fbm(103, 32, 32, 3, size);
  const streak = fbm(107, 24, 3, 3, size);
  const rng = mulberry32(109);
  for (let i = 0; i < size * size; i++) {
    const k = 0.9 + 0.1 * (fine[i] - 0.5) + 0.12 * (streak[i] - 0.5) + 0.05 * (rng() - 0.5);
    const b = Math.max(0, Math.min(255, Math.round(k * 255)));
    const o = i * 4;
    out[o] = b;
    out[o + 1] = b;
    out[o + 2] = Math.round(b * 0.985);
    out[o + 3] = 255;
  }
  return out;
}

/** Tangent-space normals of a tileable chop of crossing swells. */
export function makeWaterNormalPixels(size = 256): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const rng = mulberry32(131);
  const waves = Array.from({ length: 14 }, (_, k) => {
    const fx = Math.round((rng() * 2 - 1) * (2 + k));
    const fy = Math.round((rng() * 2 - 1) * (2 + k)) || 1;
    return { fx, fy, phase: rng() * Math.PI * 2, amp: 1 / (1 + Math.hypot(fx, fy)) };
  });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const w of waves) h += Math.sin((x / size * w.fx + y / size * w.fy) * Math.PI * 2 + w.phase) * w.amp;
      height[y * size + x] = h;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = height[y * size + (x + 1) % size] - height[y * size + (x + size - 1) % size];
      const dy = height[((y + 1) % size) * size + x] - height[((y + size - 1) % size) * size + x];
      const nx = -dx * 9;
      const ny = -dy * 9;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      out[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Live values of the water shader: the floating origin (so waves stay put in the world) and time. */
export interface MiamiWaterState {
  readonly origin: { value: THREE.Vector2 };
  readonly time: { value: number };
}

/** Period of the water's world-space offset; both wave scales divide it. */
const WATER_PERIOD = 192;

export interface MiamiMaterials {
  road: THREE.MeshStandardMaterial;
  struct: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  land: THREE.MeshStandardMaterial;
  city: THREE.MeshStandardMaterial;
  /** 0 under the sunset sky, 1 under the night skies: how strongly facade windows are lit. */
  night: { value: number };
  /** Everything generated here; the owner disposes these, never the kit's borrowed maps. */
  textures: THREE.Texture[];
  waterState: MiamiWaterState;
}

/**
 * The generated materials of the Miami road, land and bay. `roadNormal` is the kit's photographed
 * asphalt normal map, borrowed for close-up grain; everything else is made here.
 */
export function makeMiamiMaterials(roadNormal: THREE.Texture | null, anisotropy = 4): MiamiMaterials {
  const asphalt = dataTexture('miami/asphalt', makeAsphaltPixels(), 512, THREE.SRGBColorSpace, anisotropy);
  // Road UVs are metres / 2.
  asphalt.repeat.set(2 / ROAD_TILE, 2 / ROAD_TILE);
  const concrete = dataTexture('miami/concrete', makeConcretePixels(), 256, THREE.SRGBColorSpace, anisotropy);
  const waves = dataTexture('miami/water-normal', makeWaterNormalPixels(), 256, THREE.NoColorSpace, anisotropy);
  const surfaces = makeSurfaceTexture(anisotropy);

  const road = new THREE.MeshStandardMaterial({ name: 'miami/road', map: asphalt, vertexColors: true, roughness: 0.93, metalness: 0 });
  if (roadNormal) {
    road.normalMap = roadNormal;
    road.normalScale.set(0.3, 0.3);
  }
  const struct = new THREE.MeshStandardMaterial({ name: 'miami/structure', map: concrete, vertexColors: true, roughness: 0.86, metalness: 0 });

  const land = new THREE.MeshStandardMaterial({ name: 'miami/land', vertexColors: true, roughness: 1, metalness: 0 });
  land.customProgramCacheKey = () => 'miami-land-v1';
  land.onBeforeCompile = shader => {
    shader.uniforms.miamiSurfaces = { value: surfaces };
    shader.uniforms.miamiTile = { value: SURFACE_TILE.map(t => 1 / t) };
    shader.vertexShader = `attribute float aLayer;
varying float vMiamiLayer;
varying vec2 vMiamiUv;
${shader.vertexShader}`.replace('void main() {', `void main() {
  vMiamiLayer = aLayer;
  vMiamiUv = uv;`);
    shader.fragmentShader = `uniform highp sampler2DArray miamiSurfaces;
uniform float miamiTile[${SURFACE_COUNT}];
varying float vMiamiLayer;
varying vec2 vMiamiUv;
${shader.fragmentShader}`
      .replace('#include <map_fragment>', `
  int miamiLayer = int(vMiamiLayer + 0.5);
  vec4 miamiSurface = texture(miamiSurfaces, vec3(vMiamiUv * miamiTile[miamiLayer], float(miamiLayer)));
  float miamiTone = texture(miamiSurfaces, vec3(vMiamiUv * miamiTile[${SURFACE.noise}], ${SURFACE.noise}.0)).r;
  diffuseColor.rgb *= miamiSurface.rgb * (0.74 + 0.52 * miamiTone);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = miamiSurface.a;`);
  };

  const waterState: MiamiWaterState = { origin: { value: new THREE.Vector2() }, time: { value: 0 } };
  const water = new THREE.MeshStandardMaterial({ name: 'miami/bay-water', color: 0x0f7f8f, roughness: 0.1, metalness: 0.02, envMapIntensity: 0.55, vertexColors: false });
  water.customProgramCacheKey = () => 'miami-water-v1';
  water.onBeforeCompile = shader => {
    shader.uniforms.miamiWaves = { value: waves };
    shader.uniforms.miamiWaterOrigin = waterState.origin;
    shader.uniforms.miamiWaterTime = waterState.time;
    shader.vertexShader = `uniform vec2 miamiWaterOrigin;
varying vec2 vMiamiWater;
${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
  vMiamiWater = (modelMatrix * vec4(position, 1.0)).xz + miamiWaterOrigin;`);
    shader.fragmentShader = `uniform sampler2D miamiWaves;
uniform float miamiWaterTime;
varying vec2 vMiamiWater;
${shader.fragmentShader}`
      .replace('#include <normal_fragment_maps>', `
  {
    // Two scrolling swells; flatten with distance so the far bay does not shimmer.
    vec2 swellA = texture2D(miamiWaves, vMiamiWater / 48.0 + miamiWaterTime * vec2(0.011, 0.006)).xy * 2.0 - 1.0;
    vec2 swellB = texture2D(miamiWaves, vMiamiWater.yx / 12.0 + miamiWaterTime * vec2(-0.021, 0.016)).xy * 2.0 - 1.0;
    float miamiCalm = 1.0 / (1.0 + length(vViewPosition) * 0.012);
    vec2 slope = (swellA * 0.55 + swellB * 0.45) * (0.1 + 0.5 * miamiCalm);
    normal = normalize((viewMatrix * vec4(slope.x, 1.0, slope.y, 0.0)).xyz);
  }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float miamiDepth = texture2D(miamiWaves, vMiamiWater / 640.0).x;
    diffuseColor.rgb *= 0.82 + 0.4 * miamiDepth;
  }`);
  };

  const night = { value: 0 };
  const city = makeFacadeMaterial(night);
  return { road, struct, water, land, city, night, textures: [asphalt, concrete, waves, surfaces], waterState };
}

/** Keep the water pattern fixed in the world while the scene's floating origin moves under it. */
export function setMiamiWater(state: MiamiWaterState, ox: number, oz: number, time: number): void {
  state.origin.value.set(ox % WATER_PERIOD, oz % WATER_PERIOD);
  state.time.value = time;
}

/**
 * Daylight facades for the buildings behind the modelled front row: a lit, fogged standard material
 * whose windows come from a procedural grid in facade metres (aWin.xy), styled per building by its
 * seed (aWin.z). aWin.w < 0 marks roofs. A dozen triangles per building fills the skyline.
 */
export function makeFacadeMaterial(night: { value: number } = { value: 0 }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ name: 'miami/facade', vertexColors: true, roughness: 0.8, metalness: 0 });
  material.customProgramCacheKey = () => 'miami-facade-v1';
  material.onBeforeCompile = shader => {
    shader.uniforms.miamiNight = night;
    shader.vertexShader = `attribute vec4 aWin;
varying vec4 vMiamiWin;
${shader.vertexShader}`.replace('void main() {', `void main() {
  vMiamiWin = aWin;`);
    shader.fragmentShader = `varying vec4 vMiamiWin;
uniform float miamiNight;
float miamiGlass = 0.0;
vec3 miamiLit = vec3(0.0);
float miamiHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vMiamiWin.w >= 0.0) {
    float seed = floor(vMiamiWin.z + 0.5);
    float style = fract(seed * 0.381966);
    vec2 pitch = style < 0.4 ? vec2(3.2, 3.3) : style < 0.75 ? vec2(6.4, 3.3) : vec2(1.6, 3.6);
    vec2 g = vMiamiWin.xy / pitch;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    // Punched windows, ribbon glazing or a curtain wall, by building.
    float wx = style < 0.4 ? step(0.2, f.x) * step(f.x, 0.8) : style < 0.75 ? step(0.04, f.x) * step(f.x, 0.96) : step(0.06, f.x);
    float wy = step(style < 0.75 ? 0.3 : 0.1, f.y) * step(f.y, style < 0.75 ? 0.8 : 0.94);
    float win = wx * wy * step(4.0, vMiamiWin.y);
    // Past the point where a floor is a pixel or two, show the facade's average instead of moire.
    float detail = clamp(1.4 - max(fwidth(g.x), fwidth(g.y)) * 2.2, 0.0, 1.0);
    float share = style < 0.4 ? 0.3 : style < 0.75 ? 0.46 : 0.78;
    float blind = miamiHash(cell + seed * 7.13);
    vec3 glass = mix(vec3(0.03, 0.07, 0.1), vec3(0.2, 0.33, 0.42), 0.25 + 0.5 * blind);
    miamiGlass = mix(share, win, detail);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, miamiGlass);
    // After dark some rooms are lit: warm mostly, a few cool, stable per window.
    float on = step(miamiHash(cell * 1.31 + seed * 3.7), 0.38) * miamiGlass;
    miamiLit = mix(vec3(1.0, 0.7, 0.4), vec3(0.72, 0.84, 1.0), step(0.8, blind)) * on * (0.5 + blind);
    // Ground floor: a darker arcade / shopfront band.
    diffuseColor.rgb *= mix(0.62, 1.0, step(4.0, vMiamiWin.y));
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.12, miamiGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += miamiLit * miamiNight * 1.6;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = mix(metalnessFactor, 0.55, miamiGlass);`);
  };
  return material;
}
