import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Part = { source: THREE.Mesh; geometry: THREE.BufferGeometry; layers: number; lastLayers: number; castShadow: boolean; lastCast: boolean;
  vertexOffset: number; indexOffset: number; mirrored: boolean };
type Guard = { node: THREE.Object3D; matrix: THREE.Matrix4 };
type Batch = { mesh: THREE.Mesh; layers: number; shadowOnly: boolean; parts: Part[]; guards: Guard[] };
export const MIAMI_CAR_SHADOW_LAYER = 1;

// These are the actual imported builders' animation pivots, not a heuristic based on mesh order.
// Doors/trunk remain guarded descendants: a future transform/visibility edit falls back losslessly.
const domainName = /^(STEER_HR|SHIFT_[LR]|(?:WHEEL|DISC)_(?:LF|RF|LR|RR)|SUSP_(?:LF|RF)|W204_Spin_(?:FL|FR|RL|RR)|W204_Steer_(?:FL|FR)|SteeringWheel|c63w204kene_needle_(?:speedo|tacho)_Selected)$/;
/** True for the car models whose animated pivots are known by name (A45, W204). */
export const hasCarDomains = (root: THREE.Object3D): boolean =>
  !!(root.getObjectByName('MAIN_BODY') || root.getObjectByName('Mercedes_W204') || root.getObjectByName('W204_Steer_FL'));
/** The animated pivot a mesh belongs to: its nearest named ancestor, or the root. */
export const carDomain = (mesh: THREE.Object3D, root: THREE.Object3D): THREE.Object3D => domain(mesh, root);
function domain(mesh: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
  for (let node = mesh.parent; node; node = node.parent) {
    if (domainName.test(node.name)) return node;
    if (node === root) break;
  }
  return root;
}
function copiedGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const copy = source.clone();
  // The real A45 uses normalized quantized integer POSITION/NORMAL buffers. Transforming those
  // in place would wrap positions outside [-1,1] and re-quantize normals. Decode precisely to
  // shader-input floats first; all other attributes retain their original typed/normalized layout.
  for (const name of ['position', 'normal', 'tangent']) {
    const a = source.getAttribute(name); if (!a) continue;
    const data = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      data[i * a.itemSize] = a.getX(i); data[i * a.itemSize + 1] = a.getY(i); data[i * a.itemSize + 2] = a.getZ(i);
      if (a.itemSize === 4) data[i * a.itemSize + 3] = a.getW(i);
    }
    copy.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
  }
  return copy.applyMatrix4(matrix);
}
function layout(geometry: THREE.BufferGeometry): string {
  return Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) =>
    ['position', 'normal', 'tangent'].includes(name) ? `${name}/${a.itemSize}/decoded-float`
      : `${name}/${a.itemSize}/${a.normalized}/${a.array.constructor.name}/${(a as THREE.BufferAttribute).gpuType}`).join('|');
}

/** Miami opt-in only: immutable private geometry, original nodes/material identities remain alive.
 * Transparent colour draws ALWAYS remain original, in their original object sort order. Their
 * identical-material static shadow/depth draws may consolidate on the sun-only layer: depth has
 * no transparent blend ordering. If any guard changes, restore the exact original draw path.
 * All source triangles remain available for those paths and the existing mandatory GPU warm-up. */
export class MiamiCarBatching {
  readonly batches: Batch[] = [];
  private disposed = false;

  constructor(root: THREE.Object3D, wheelRoot?: THREE.Object3D) {
    this.build(root);
    if (wheelRoot) this.build(wheelRoot);
  }

  private build(root: THREE.Object3D): void {
    if (!root.getObjectByName('MAIN_BODY') && !root.getObjectByName('Mercedes_W204') && !root.getObjectByName('W204_Steer_FL')) return;
    root.updateWorldMatrix(true, true);
    const groups = new Map<THREE.Object3D, Map<THREE.Material, Map<string, THREE.Mesh[]>>>();
    root.traverseVisible(object => {
      const m = object as THREE.Mesh, g = m.geometry;
      if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material)
        || (m.material.transparent && !m.castShadow) || (m.material as THREE.MeshPhysicalMaterial).transmission > 0 || m.morphTargetInfluences?.length
        || (m.material as THREE.MeshStandardMaterial).displacementMap || (m.material as THREE.MeshStandardMaterial).normalMapType === THREE.ObjectSpaceNormalMap
        || m.customDepthMaterial || m.customDistanceMaterial
        || !g.index || !g.getAttribute('position') || !g.getAttribute('normal') || Object.keys(g.morphAttributes).length
        || g.drawRange.start !== 0 || (g.drawRange.count !== Infinity && g.drawRange.count !== g.index.count)
        || m.onBeforeRender !== THREE.Mesh.prototype.onBeforeRender || m.onAfterRender !== THREE.Mesh.prototype.onAfterRender) return;
      const parent = domain(m, root); if (!parent) return;
      let mats = groups.get(parent); if (!mats) groups.set(parent, mats = new Map());
      let layouts = mats.get(m.material); if (!layouts) mats.set(m.material, layouts = new Map());
      const key = `${layout(g)}/${m.layers.mask}/${m.renderOrder}/${m.castShadow}/${m.receiveShadow}/${m.frustumCulled}`;
      const list = layouts.get(key) ?? []; list.push(m); layouts.set(key, list);
    });
    try {
      for (const [parent, mats] of groups) for (const layouts of mats.values()) for (const sources of layouts.values()) {
        if (sources.length < 2) continue;
        const copies: THREE.BufferGeometry[] = [], parts: Part[] = [], guards = new Map<THREE.Object3D, THREE.Matrix4>();
        const inverse = parent.matrixWorld.clone().invert(); let vertexOffset = 0, indexOffset = 0;
        try {
          for (const source of sources) {
            const matrix = new THREE.Matrix4().multiplyMatrices(inverse, source.matrixWorld), mirrored = matrix.determinant() < 0;
            const copy = copiedGeometry(source.geometry, matrix);
            // Three flips frontFace for negative object determinants. Once baked into vertices,
            // reverse index winding to retain that exact convention; do not flip normals/tangent.w.
            if (mirrored) { const index = copy.index!; for (let i = 0; i < index.count; i += 3) {
              const b = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, b);
            } }
            copies.push(copy); parts.push({ source, geometry: source.geometry, layers: source.layers.mask, lastLayers: source.layers.mask,
              castShadow: source.castShadow, lastCast: source.castShadow, vertexOffset, indexOffset, mirrored });
            vertexOffset += copy.getAttribute('position').count; indexOffset += copy.index!.count;
            for (let node: THREE.Object3D | null = source; node && node !== parent; node = node.parent) guards.set(node, node.matrix.clone());
          }
          const geometry = mergeGeometries(copies, false); if (!geometry) throw Error('Incompatible Miami static draw attributes');
          geometry.computeBoundingBox(); geometry.computeBoundingSphere();
          const first = sources[0], mesh = new THREE.Mesh(geometry, first.material);
          mesh.name = 'miami/static-car-batch'; mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
          mesh.renderOrder = first.renderOrder; mesh.frustumCulled = first.frustumCulled; mesh.layers.mask = first.layers.mask;
          parent.add(mesh); this.batches.push({ mesh, layers: first.layers.mask, shadowOnly: (first.material as THREE.Material).transparent,
            parts, guards: [...guards].map(([node, matrix]) => ({ node, matrix })) });
        } finally { copies.forEach(g => g.dispose()); }
      }
      this.update();
    } catch (error) { this.dispose(); throw error; }
  }

  update(): void {
    if (this.disposed) return;
    for (const batch of this.batches) {
      const material = batch.mesh.material as THREE.Material & { transmission?: number };
      let compatible = !(material.transmission && material.transmission > 0);
      for (const { node, matrix } of batch.guards) {
        if (node.matrixAutoUpdate) node.updateMatrix();
        if (!node.visible || !node.matrix.equals(matrix)) compatible = false;
      }
      for (const part of batch.parts) {
        const source = part.source;
        if (source.layers.mask !== part.lastLayers) part.layers = source.layers.mask;
        if (source.castShadow !== part.lastCast) part.castShadow = source.castShadow;
        if (source.material !== material || source.geometry !== part.geometry || part.layers !== batch.layers
          || part.castShadow !== batch.mesh.castShadow || source.receiveShadow !== batch.mesh.receiveShadow
          || source.renderOrder !== batch.mesh.renderOrder || source.frustumCulled !== batch.mesh.frustumCulled) compatible = false;
      }
      batch.mesh.visible = compatible;
      const shadowOnly = batch.shadowOnly || material.transparent;
      batch.mesh.layers.mask = shadowOnly ? 1 << MIAMI_CAR_SHADOW_LAYER : batch.layers;
      for (const part of batch.parts) {
        part.source.layers.mask = compatible && !shadowOnly ? 0 : part.layers;
        part.source.castShadow = compatible && shadowOnly ? false : part.castShadow;
        part.lastLayers = part.source.layers.mask; part.lastCast = part.source.castShadow;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const { mesh, parts } of this.batches) {
      for (const { source, layers, castShadow } of parts) { source.layers.mask = layers; source.castShadow = castShadow; }
      mesh.removeFromParent(); mesh.geometry.dispose(); // Materials/textures/source geometry are borrowed.
    }
    this.batches.length = 0;
  }
}
