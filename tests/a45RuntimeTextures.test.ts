/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { A45_UNUSED_LAMP_TEXTURES, configureA45Textures, skipUnusedA45LampMaps } from '../src/render/car/a45TexturePolicy';
import { auditModelTextures, readGlb, sha256 } from '../scripts/lib/modelTextureAudit';

const bytes = readFileSync(new URL('../public/models/mercedes-a45s.glb', import.meta.url));
const { asset } = readGlb(bytes);
let baseline: GLTF, optimized: GLTF, audit: ReturnType<typeof auditModelTextures>;
const loaded = { baseline: new Set<number>(), optimized: new Set<number>() };

async function parse(policy: boolean): Promise<GLTF> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  if (policy) configureA45Textures(loader);
  loader.register(parser => ({ name: 'audit-images', loadTexture(index: number) {
    loaded[policy ? 'optimized' : 'baseline'].add(parser.json.textures[index].source);
    return Promise.resolve(new THREE.Texture());
  } }));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

function geometryHash(root: THREE.Object3D): string {
  const digest = createHash('sha256');
  root.traverse(object => {
    digest.update(JSON.stringify([object.name, object.position.toArray(), object.quaternion.toArray(), object.scale.toArray()]));
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      digest.update(name);
      const array = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data.array : (attribute as THREE.BufferAttribute).array;
      digest.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const index = mesh.geometry.index?.array;
    if (index) digest.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  });
  return digest.digest('hex');
}

beforeAll(async () => {
  audit = auditModelTextures(bytes);
  baseline = await parse(false); optimized = await parse(true);
}, 30000);
afterEach(() => vi.unstubAllGlobals());

describe('A45 appearance-preserving runtime texture policy', () => {
  it('keeps the approved GLB, all detailed pixels, geometry, UVs and transforms byte-identical', () => {
    expect(sha256(bytes)).toBe('0f9f6d8bc2f9d67274bb0dbe21ec8d4ed6b8659be0b470e4ed5182269e7bccd4');
    expect(geometryHash(optimized.scene)).toBe(geometryHash(baseline.scene));
    expect(audit.imageRecords.find(image => image.name === 'advan_ad08r_nm.png')!.dimensions).toEqual([8192, 1792]);
  });

  it('skips exactly three front-lamp image decodes and saves 33 MiB of decoded RGBA, without claiming GPU savings', () => {
    const skipped = [...loaded.baseline].filter(index => !loaded.optimized.has(index));
    expect(skipped.sort((a, b) => a - b)).toEqual([...A45_UNUSED_LAMP_TEXTURES]);
    const pixels = skipped.reduce((sum, index) => {
      const dimensions = audit.imageRecords[index].dimensions!;
      return sum + dimensions[0] * dimensions[1];
    }, 0);
    expect(pixels * 4).toBe(33 * 1024 * 1024);
    // Other sources, including the oversized protected tyre detail, are still requested.
    expect(loaded.optimized.has(102)).toBe(true);
    expect(loaded.optimized.size).toBe(loaded.baseline.size - 3);
  });

  it('limits the change to maps on four front-only, already-replaced meshes, preserving the original lamp replacement code', async () => {
    const changed = structuredClone(asset);
    expect(await skipUnusedA45LampMaps(changed)).toBe(true);
    const expected = structuredClone(asset);
    delete expected.materials[61].pbrMetallicRoughness.baseColorTexture;
    delete expected.materials[61].pbrMetallicRoughness.metallicRoughnessTexture;
    delete expected.materials[62].normalTexture;
    expect(changed).toEqual(expected);
    baseline.scene.updateMatrixWorld(true);
    const names: string[] = [];
    baseline.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || !['headlight_chrome_reflector', 'front_refraction_surface_led'].includes(mesh.material.name)) return;
      expect(mesh.getWorldPosition(new THREE.Vector3()).z).toBeLessThan(0);
      names.push(mesh.name);
    });
    expect(names.sort()).toEqual(['SM_Light_F_101024_1', 'SM_Light_F_101026_1', 'SM_Light_F_101053_1', 'SM_Light_F_101055_1']);
    const source = readFileSync(new URL('../src/render/car/index.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    expect(sha256(source.slice(source.indexOf('const A45_HEADLAMP:'), source.indexOf('/** Something that turns'))))
      .toBe('c8b0b661f4a3f0acd7f2c38aad0d55c06822343b264050b58a58654739ccbd0f');
  });

  it('fails closed on changed material/node metadata or unavailable WebCrypto', async () => {
    for (const mutate of [(copy: any) => { copy.nodes[0].translation = [0, 0, 100]; }, (copy: any) => { copy.materials[61].name = 'changed'; }]) {
      const copy = structuredClone(asset); mutate(copy); const expected = structuredClone(copy);
      expect(await skipUnusedA45LampMaps(copy)).toBe(false); expect(copy).toEqual(expected);
    }
    vi.stubGlobal('crypto', undefined);
    const copy = structuredClone(asset);
    expect(await skipUnusedA45LampMaps(copy)).toBe(false); expect(copy).toEqual(asset);
  });

  it('audits actual use, exact decoded duplicates and single-channel roughness instead of deleting protected detail', () => {
    expect(audit.usedMaterials).toBe(77); expect(audit.usedTextures).toBe(109); expect(audit.usedImages).toBe(106);
    expect(audit.imageRecords.filter(image => !image.used).every(image => image.dimensions?.every(size => size === 1))).toBe(true);
    expect(audit.duplicateDecodedImages).toEqual([[3, 75, 80], [55, 72]]);
    expect(audit.constantRoughness).toEqual([]); expect(audit.duplicateSampledRoughness).toEqual([]);
  });
});
