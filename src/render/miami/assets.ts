import * as THREE from 'three';
import { GLTFLoader, RGBELoader } from 'three-stdlib';

export type MiamiBounds = { min: [number, number, number]; max: [number, number, number] };
export type MiamiTexture = { id: string; path: string; bytes: number; colorSpace: 'sRGB' | 'linear' };
export type MiamiMaterial = {
  name: string; baseColor: [number, number, number, number]; roughness: number; metalness: number;
  emissive?: [number, number, number]; emissiveIntensity?: number; normalScale?: [number, number];
  maps?: Partial<Record<'map' | 'normalMap' | 'roughnessMap', string>>;
};
export type MiamiManifest = {
  schema: number; totalBytes: number; partBatches: number; model: { path: string; bytes: number };
  textures: MiamiTexture[]; materials: MiamiMaterial[];
  prototypes: { name: string; bounds: MiamiBounds; triangles: number; waterline?: number;
    parts: { name: string; material: string; triangles: number }[] }[];
};
export type MiamiPart = { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; name: string };
export type MiamiPrototype = { bounds: MiamiBounds; triangles: number; waterline?: number; parts: MiamiPart[] };

/** The cache is not an owner. Worlds/environment hold leases; the last lease releases the cache too.
 * A cancelled consumer calls dispose() on an unborrowed completion. No borrower disposes maps itself. */
export interface MiamiAssets {
  manifest: MiamiManifest;
  prototypes: ReadonlyMap<string, MiamiPrototype>;
  materials: ReadonlyMap<string, THREE.MeshStandardMaterial>;
  textures: ReadonlyMap<string, THREE.Texture>;
  hdr: THREE.Texture;
  readonly disposed: boolean;
  retain(): () => void;
  dispose(): void;
}

const REQUIRED = ['hotel_deco', 'hotel_colonnade', 'condo_terrace', 'tower_glass', 'tower_setback', 'garage_canopy',
  'palm_coconut', 'palm_royal', 'yacht', 'streetlight', 'bench', 'bollard', 'planter', 'hedge', 'marina_pontoon'];
function local(path: string): string {
  if (!/^\/(models|textures)\/miami\/[\w./-]+$/.test(path) || path.includes('..')) throw Error('Invalid Miami asset path');
  return path;
}
function validate(m: MiamiManifest): void {
  if (m.schema !== 1 || m.totalBytes > 48 * 1024 ** 2 || m.partBatches > 120 || m.textures.length > 48
    || m.prototypes.length !== REQUIRED.length || new Set(m.prototypes.map(p => p.name)).size !== REQUIRED.length
    || REQUIRED.some(n => !m.prototypes.some(p => p.name === n))) throw Error('Invalid Miami kit manifest');
  local(m.model.path); m.textures.forEach(t => local(t.path));
}

/** Consume/dispose the original GLB resource set, keeping one copied, root-relative geometry per part. */
export function extractMiamiAssets(manifest: MiamiManifest, scene: THREE.Object3D, textures: Map<string, THREE.Texture>, onDispose?: () => void): MiamiAssets {
  const sourceGeometry = new Set<THREE.BufferGeometry>(), sourceMaterials = new Set<THREE.Material>();
  scene.traverse(o => {
    const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
    sourceGeometry.add(mesh.geometry); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => sourceMaterials.add(m));
  });
  const materials = new Map<string, THREE.MeshStandardMaterial>(), prototypes = new Map<string, MiamiPrototype>();
  const geometries = new Set<THREE.BufferGeometry>();
  let refs = 0, disposed = false;
  const dispose = () => {
    if (disposed || refs) return;
    disposed = true;
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); new Set(textures.values()).forEach(t => t.dispose());
    onDispose?.();
  };
  try {
    validate(manifest);
    for (const t of manifest.textures) {
      const texture = textures.get(t.id); if (!texture) throw Error(`Missing Miami texture ${t.id}`);
      texture.name = t.id;
      if (t.path.endsWith('.hdr')) { texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.LinearSRGBColorSpace; }
      else {
        texture.colorSpace = t.colorSpace === 'sRGB' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(1, 1); texture.flipY = false;
      }
      texture.needsUpdate = true;
    }
    for (const def of manifest.materials) {
      const mat = new THREE.MeshStandardMaterial({ name: def.name, roughness: def.roughness, metalness: def.metalness });
      // Manifest/glTF factors are already linear. setHex/convertSRGBToLinear would apply gamma twice.
      mat.color.setRGB(def.baseColor[0], def.baseColor[1], def.baseColor[2], THREE.LinearSRGBColorSpace);
      if (def.emissive) { mat.emissive.fromArray(def.emissive); mat.emissiveIntensity = def.emissiveIntensity ?? 1; }
      for (const [slot, id] of Object.entries(def.maps ?? {})) {
        const map = textures.get(id); if (!map) throw Error(`Missing Miami map ${id}`);
        mat[slot as 'map' | 'normalMap' | 'roughnessMap'] = map;
      }
      if (def.normalScale) mat.normalScale.fromArray(def.normalScale);
      materials.set(def.name, mat);
    }
    scene.updateMatrixWorld(true);
    for (const def of manifest.prototypes) {
      const root = scene.getObjectByName(def.name); if (!root) throw Error(`Missing Miami model ${def.name}`);
      if (!root.matrix.equals(new THREE.Matrix4())) throw Error(`Nonidentity Miami root ${def.name}`);
      const inverse = root.matrixWorld.clone().invert();
      const parts = def.parts.map(part => {
        const mesh = root.getObjectByName(part.name) as THREE.Mesh;
        const material = materials.get(part.material);
        if (!mesh?.isMesh || !material || !mesh.geometry.index || !mesh.geometry.getAttribute('normal') || !mesh.geometry.getAttribute('uv')) throw Error(`Invalid Miami part ${part.name}`);
        const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
        geometries.add(geometry); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        return { name: part.name, geometry, material };
      });
      prototypes.set(def.name, { bounds: def.bounds, triangles: def.triangles, waterline: def.waterline, parts });
    }
    const hdr = textures.get(manifest.textures.find(t => t.path.endsWith('.hdr'))!.id)!;
    return { manifest, prototypes, materials, textures, hdr, get disposed() { return disposed; },
      retain() {
        if (disposed) throw Error('Miami assets already disposed'); refs++;
        let released = false;
        return () => { if (released) return; released = true; refs--; dispose(); };
      }, dispose };
  } catch (error) { dispose(); throw error; }
  finally { sourceGeometry.forEach(g => g.dispose()); sourceMaterials.forEach(m => m.dispose()); }
}

type MiamiIO = {
  manifest(): Promise<MiamiManifest>;
  model(path: string): Promise<THREE.Object3D>;
  texture(def: MiamiTexture): Promise<THREE.Texture>;
};
export function createMiamiAssetLoader(io: MiamiIO): () => Promise<MiamiAssets> {
  let pending: Promise<MiamiAssets> | undefined, cached: MiamiAssets | undefined;
  return () => {
    if (cached?.disposed) { cached = undefined; pending = undefined; }
    return pending ??= (async () => {
      const manifest = await io.manifest(); validate(manifest);
      // AllSettled is intentional: a late texture success after another failure must be freed too.
      const results = await Promise.allSettled([io.model(local(manifest.model.path)), ...manifest.textures.map(t => io.texture(t))]);
      const failure = results.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') {
        const resources = new Set<THREE.Texture | THREE.BufferGeometry | THREE.Material>();
        for (const r of results) if (r.status === 'fulfilled') {
          if (r.value instanceof THREE.Texture) resources.add(r.value);
          else r.value.traverse(o => { const m = o as THREE.Mesh; if (!m.isMesh) return;
            resources.add(m.geometry); (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => resources.add(mat)); });
        }
        resources.forEach(r => r.dispose()); throw failure.reason;
      }
      const values = results.map(r => (r as PromiseFulfilledResult<THREE.Object3D | THREE.Texture>).value);
      let result: MiamiAssets | undefined;
      result = extractMiamiAssets(manifest, values[0] as THREE.Object3D, new Map(manifest.textures.map((t, i) => [t.id, values[i + 1] as THREE.Texture])), () => {
        if (result && cached === result) { cached = undefined; pending = undefined; }
      });
      cached = result;
      return cached;
    })().catch(error => { pending = undefined; throw error; });
  };
}

// No loader is instantiated and no HTTP is issued at module import (including Node test imports).
export const loadMiamiAssets = createMiamiAssetLoader({
  async manifest() {
    const response = await fetch('/models/miami/manifest.json');
    if (!response.ok) throw Error(`Miami manifest: HTTP ${response.status}`);
    return response.json() as Promise<MiamiManifest>;
  },
  async model(path) { return (await new GLTFLoader().loadAsync(path)).scene; },
  async texture(def) { return def.path.endsWith('.hdr') ? new RGBELoader().loadAsync(def.path) : new THREE.TextureLoader().loadAsync(def.path); },
});
