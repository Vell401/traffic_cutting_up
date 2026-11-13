import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { beforeAll, describe, expect, it } from 'vitest';

// These tests consume the delivered binary, not the authoring statistics. A lost
// UV channel, unapplied transform, duplicated material or stale manifest fails here.
const base = 'public/models/miami/';
const names = ['hotel_deco', 'hotel_colonnade', 'condo_terrace', 'tower_glass',
  'tower_setback', 'garage_canopy', 'palm_coconut', 'palm_royal', 'yacht',
  'streetlight', 'bench', 'bollard', 'planter', 'hedge', 'marina_pontoon'];
type Bounds = { min: number[]; max: number[] };
type Part = { name: string; material: string; triangles: number; bounds: Bounds };
type Prototype = { name: string; bounds: Bounds; triangles: number; parts: Part[]; materials: string[] };
type Texture = { id: string; path: string; bytes: number; sha256: string; md5: string;
  width: number; height: number; colorSpace: string; source: { url: string; author: string;
    asset: string; license: string; licenseUrl: string; publishedMd5: string }; derivative: string };
type Manifest = { schema: number; generator: { name: string; version: string; blender: string };
  contract: { units: string; up: string; front: string; pivot: string; textureMode: string };
  model: { path: string; bytes: number; sha256: string; author: string; source: string };
  totalBytes: number; partBatches: number; prototypes: Prototype[]; textures: Texture[];
  materials: { name: string; maps?: Record<string, string>; uvTileMeters?: number }[] };
let manifest: Manifest | undefined;
let gltf: GLTF | undefined;
beforeAll(async () => {
  if (!existsSync(`${base}manifest.json`) || !existsSync(`${base}coastal-kit.glb`)) return;
  manifest = JSON.parse(readFileSync(`${base}manifest.json`, 'utf8')) as Manifest;
  const bytes = readFileSync(`${base}coastal-kit.glb`);
  gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
});
function kit() {
  expect(manifest, 'authored Miami schema1 manifest must exist').toBeDefined();
  expect(gltf, 'actual authored GLB must parse using the game loader').toBeDefined();
  return { manifest: manifest!, gltf: gltf! };
}
function meshes(root: THREE.Object3D) {
  const result: THREE.Mesh[] = [];
  root.traverse(o => { if (o instanceof THREE.Mesh) result.push(o); });
  return result;
}
function bounds(box: THREE.Box3): Bounds { return { min: box.min.toArray(), max: box.max.toArray() }; }
function nearBounds(actual: Bounds, expected: Bounds) {
  for (const end of ['min', 'max'] as const) for (let i = 0; i < 3; i++)
    expect(actual[end][i]).toBeCloseTo(expected[end][i], 3);
}
function imageDimensions(data: Buffer, path: string) {
  if (path.endsWith('.hdr')) {
    const line = data.subarray(0, 1024).toString('ascii').split('\n').find(line => line.startsWith('-Y '))!;
    const [, height, , width] = line.split(' ');
    return { width: Number(width), height: Number(height) };
  }
  expect(data.readUInt16BE(0)).toBe(0xffd8);
  let i = 2;
  while (i < data.length) {
    const code = data.readUInt16BE(i), length = data.readUInt16BE(i + 2);
    if ([0xffc0, 0xffc1, 0xffc2].includes(code)) return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
    i += length + 2;
  }
  throw new Error(`No JPEG dimensions: ${path}`);
}

describe('physical Miami asset delivery contract', () => {
  it('delivers all fifteen metre-scale, bottom-centred, -Z-front prototypes without staging transforms', () => {
    const { manifest: m, gltf: g } = kit();
    expect(m.schema).toBe(1);
    expect(m.contract).toMatchObject({ units: 'metres', up: '+Y', front: '-Z', pivot: 'bottom-centre', textureMode: 'runtime-shared' });
    expect(g.scene.children.map(o => o.name).sort()).toEqual([...names].sort());
    expect(m.prototypes.map(p => p.name).sort()).toEqual([...names].sort());
    expect(g.animations).toHaveLength(0);
    for (const root of g.scene.children) {
      expect(root.position.toArray()).toEqual([0, 0, 0]);
      expect(root.scale.toArray()).toEqual([1, 1, 1]);
      expect(root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      for (const mesh of meshes(root)) expect(mesh.matrix.equals(new THREE.Matrix4())).toBe(true);
      const b = bounds(new THREE.Box3().setFromObject(root));
      expect(b.min[1]).toBeCloseTo(0, 3);
      expect(b.min[0] + b.max[0]).toBeCloseTo(0, 3);
      expect(b.min[2] + b.max[2]).toBeCloseTo(0, 3);
      expect(b.max[1]).toBeGreaterThan(0.3);
      expect(b.max[1]).toBeLessThan(110);
      nearBounds(b, m.prototypes.find(p => p.name === root.name)!.bounds);
    }
    const height = (name: string) => new THREE.Box3().setFromObject(g.scene.getObjectByName(name)!).max.y;
    expect(height('bench')).toBeGreaterThan(0.7); expect(height('bench')).toBeLessThan(1.2);
    expect(height('streetlight')).toBeGreaterThan(6); expect(height('streetlight')).toBeLessThan(10);
    expect(height('hotel_deco')).toBeGreaterThan(18);
    expect(height('tower_glass')).toBeGreaterThan(65);
  });

  it('contains finite, indexed, nondegenerate geometry with unit normals and spatial UVs in every part', () => {
    const { gltf: g } = kit();
    for (const mesh of meshes(g.scene)) {
      const geometry = mesh.geometry, pos = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv'), index = geometry.index!;
      expect(pos.count).toBeGreaterThan(12); expect(index).not.toBeNull(); expect(index.count % 3).toBe(0);
      expect(normals.count).toBe(pos.count); expect(uv.count).toBe(pos.count);
      for (const attr of [pos, normals, uv]) expect([...attr.array].every(Number.isFinite)).toBe(true);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, normalError = 0;
      for (let i = 0; i < pos.count; i++) {
        normalError = Math.max(normalError, Math.abs(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) - 1));
        uMin = Math.min(uMin, uv.getX(i)); uMax = Math.max(uMax, uv.getX(i));
        vMin = Math.min(vMin, uv.getY(i)); vMax = Math.max(vMax, uv.getY(i));
      }
      expect(normalError).toBeLessThan(0.001);
      expect(uMax - uMin).toBeGreaterThan(0.01); expect(vMax - vMin).toBeGreaterThan(0.01);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      let degenerate = 0, invalidIndices = 0;
      for (let i = 0; i < index.count; i += 3) {
        for (let j = 0; j < 3; j++) if (index.getX(i + j) >= pos.count || index.getX(i + j) < 0) invalidIndices++;
        a.fromBufferAttribute(pos, index.getX(i)); b.fromBufferAttribute(pos, index.getX(i + 1)); c.fromBufferAttribute(pos, index.getX(i + 2));
        if (b.sub(a).cross(c.sub(a)).lengthSq() < 1e-16) degenerate++;
      }
      expect(invalidIndices).toBe(0);
      expect(degenerate / (index.count / 3)).toBeLessThan(0.002);
    }
  });

  it('matches independently parsed triangle/part bounds and shares material objects across prototypes', () => {
    const { manifest: m, gltf: g } = kit();
    const shared = new Map<string, THREE.Material>(), uses = new Map<string, number>();
    let totalParts = 0;
    for (const p of m.prototypes) {
      const parts = meshes(g.scene.getObjectByName(p.name)!);
      expect(parts.length).toBe(p.parts.length);
      let triangles = 0;
      for (const mesh of parts) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        expect(Array.isArray(mesh.material)).toBe(false);
        expect(mat.isMeshStandardMaterial).toBe(true);
        expect(mat.map).toBeNull(); // Exactly one shared external map set; never 15 embedded copies.
        if (shared.has(mat.name)) expect(mat).toBe(shared.get(mat.name));
        shared.set(mat.name, mat); uses.set(mat.name, (uses.get(mat.name) ?? 0) + 1);
        const part = p.parts.find(x => x.name === mesh.name)!;
        expect(part, `part manifest for ${mesh.name}`).toBeDefined();
        expect(part.material).toBe(mat.name);
        expect(part.triangles).toBe(mesh.geometry.index!.count / 3);
        nearBounds(bounds(new THREE.Box3().setFromObject(mesh)), part.bounds);
        triangles += part.triangles;
      }
      expect(triangles).toBe(p.triangles); totalParts += parts.length;
      expect(parts.map(x => (x.material as THREE.Material).name).sort()).toEqual([...p.materials].sort());
    }
    expect(totalParts).toBe(m.partBatches); expect(totalParts).toBeLessThanOrEqual(120);
    expect([...uses.values()].filter(n => n > 1).length).toBeGreaterThanOrEqual(8);
  });

  it('contains volumetric facades, separate feathered crowns and a shaped non-box yacht hull', () => {
    const { gltf: g } = kit();
    const part = (root: string, material: string) => meshes(g.scene.getObjectByName(root)!).find(x => (x.material as THREE.Material).name === material)!;
    const unique = (mesh: THREE.Mesh, axis: 'X' | 'Y' | 'Z') => {
      const p = mesh.geometry.getAttribute('position');
      return new Set(Array.from({ length: p.count }, (_, i) => Math.round(p[`get${axis}`](i) * 1000)));
    };
    for (const name of ['hotel_deco', 'hotel_colonnade', 'condo_terrace', 'tower_glass', 'tower_setback']) {
      const glass = part(name, 'glazing_blue');
      expect(glass, `${name} must have physical glazing`).toBeDefined();
      expect(unique(glass, 'Z').size).toBeGreaterThan(5);
      // Six or more real rows have at least twelve aperture edges. Do not count
      // microscopic glass-edge bevel subdivisions as additional facade detail.
      expect(unique(glass, 'Y').size).toBeGreaterThanOrEqual(12);
      expect(part(name, 'frame_ivory').geometry.index!.count).toBeGreaterThan(1000);
    }
    for (const name of ['palm_coconut', 'palm_royal']) {
      const leaves = part(name, 'palm_leaf');
      expect(leaves.geometry.index!.count / 3).toBeGreaterThan(2500);
      expect(unique(leaves, 'Y').size).toBeGreaterThan(400);
      expect(unique(part(name, 'palm_bark'), 'X').size).toBeGreaterThan(100);
    }
    const hull = part('yacht', 'hull_pearl');
    expect(unique(hull, 'X').size).toBeGreaterThan(30);
    expect(unique(hull, 'Z').size).toBeGreaterThan(20);
    expect(part('yacht', 'metal_satin').geometry.index!.count).toBeGreaterThan(600);
    // Independently establish actual front orientation, not only a metadata string.
    const blade = new THREE.Box3().setFromObject(part('hotel_deco', 'plaster_mint'));
    expect(blade.max.z).toBeLessThan(0);
    const pos = hull.geometry.getAttribute('position');
    let bowZ = Infinity;
    for (let i = 0; i < pos.count; i++) bowZ = Math.min(bowZ, pos.getZ(i));
    const bowXs = Array.from({ length: pos.count }, (_, i) => i).filter(i => Math.abs(pos.getZ(i) - bowZ) < 0.001).map(i => pos.getX(i));
    expect(Math.max(...bowXs) - Math.min(...bowXs)).toBeLessThan(0.15);
  });

  it('self-hosts bounded verified photos with original source, author, CC0, dimensions and exact checksums', () => {
    const { manifest: m } = kit();
    expect(m.textures.length).toBeGreaterThanOrEqual(7); expect(m.textures.length).toBeLessThanOrEqual(48);
    const paths = new Set<string>();
    for (const t of m.textures) {
      expect(t.path.startsWith('/textures/miami/')).toBe(true); expect(paths.has(t.path)).toBe(false); paths.add(t.path);
      const data = readFileSync(`public${t.path}`);
      expect(data.length).toBe(t.bytes); expect(createHash('sha256').update(data).digest('hex')).toBe(t.sha256);
      expect(createHash('md5').update(data).digest('hex')).toBe(t.md5); expect(t.md5).toBe(t.source.publishedMd5);
      expect(t.source.url).toMatch(/^https:\/\/dl.polyhaven.org\//); expect(t.source.author.length).toBeGreaterThan(2);
      expect(t.source.asset.length).toBeGreaterThan(2); expect(t.source.license).toBe('CC0-1.0');
      expect(t.source.licenseUrl).toBe('https://polyhaven.com/license'); expect(t.derivative).toBe('none; byte-identical published original');
      expect(t.width).toBeGreaterThanOrEqual(1024); expect(t.width).toBeLessThanOrEqual(2048);
      expect(t.height).toBeGreaterThanOrEqual(512); expect(t.height).toBeLessThanOrEqual(2048);
      expect(imageDimensions(data, t.path)).toEqual({ width: t.width, height: t.height });
      expect(['sRGB', 'linear']).toContain(t.colorSpace);
    }
    expect(m.textures.some(t => t.source.asset === 'kloppenheim_06_puresky' && t.path.endsWith('.hdr'))).toBe(true);
  });

  it('gives runtime one unambiguous shared PBR texture assignment with physical-scale UVs', () => {
    const { manifest: m } = kit();
    const ids = new Set(m.textures.map(t => t.id));
    for (const name of ['plaster_ivory', 'plaster_coral', 'concrete_warm', 'asphalt_road']) {
      const material = m.materials.find(x => x.name === name)!;
      expect(material, name).toBeDefined();
      expect(material.uvTileMeters).toBe(2);
      for (const channel of ['map', 'normalMap', 'roughnessMap']) {
        expect(ids.has(material.maps![channel])).toBe(true);
        const tex = m.textures.find(t => t.id === material.maps![channel])!;
        expect(tex.colorSpace).toBe(channel === 'map' ? 'sRGB' : 'linear');
      }
    }
  });

  it('keeps the real initial model+photos below 48 MiB and preserves reproducible authoring source', () => {
    const { manifest: m } = kit();
    const model = readFileSync(`public${m.model.path}`);
    expect(model.length).toBe(m.model.bytes); expect(createHash('sha256').update(model).digest('hex')).toBe(m.model.sha256);
    const bytes = model.length + m.textures.reduce((sum, t) => sum + statSync(`public${t.path}`).size, 0);
    expect(bytes).toBe(m.totalBytes); expect(bytes + statSync(`${base}manifest.json`).size).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(m.model.author).toBe('Traffic Cutting Up project'); expect(m.model.source).toBe('project-authored in Blender; no extracted game models');
    expect(m.generator.blender).toMatch(/^4\.5\./);
    expect(readFileSync('assets/miami/coastal-kit.blend').subarray(0, 7).toString()).toBe('BLENDER');
    expect(statSync('scripts/blender/build_miami.py').size).toBeGreaterThan(4000);
  });
});
