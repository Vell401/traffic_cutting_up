import * as THREE from 'three';
import { MIAMI_CAR_SHADOW_LAYER, carDomain, hasCarDomains } from './carBatching';

/*
 * One shadow draw per moving part of a car instead of one per mesh.
 *
 * A detailed car is a hundred-odd meshes, and the sun's shadow pass drew every one of them again:
 * more draw calls for the car's shadow than for the whole Miami scenery. Depth does not care about
 * materials, so here every shadow-casting mesh that shares an animated pivot (the body, each wheel,
 * each brake disc...) is merged, positions only, into a single proxy mesh under that pivot.
 *
 * Nothing about the car itself changes: no mesh, material, flag or layer of the original is touched.
 * The proxies live on the sun-only layer, which is the only layer the Miami shadow camera renders,
 * so the originals simply are not in that pass any more and the proxies are in no other.
 *
 * The proxy is a snapshot. Every node between a mesh and its pivot is watched; if one moves, hides,
 * or stops casting, the proxies are rebuilt (merged geometry is cached per model, so a second car of
 * the same model, or a return to an earlier state, costs nothing).
 */

const PROXY_NAME = 'miami/car-shadow';
const BATCH_NAME = 'miami/static-car-batch';
/** Frames between rebuilds: a change is picked up at once, a node that never settles cannot thrash. */
const COOLDOWN = 30;

const material = new THREE.MeshBasicMaterial({ name: PROXY_NAME });
const cache = new Map<string, { geometry: THREE.BufferGeometry; refs: number }>();

interface Watch { node: THREE.Object3D; visible: boolean; cast: boolean; matrix: THREE.Matrix4 | null }

function mergeable(mesh: THREE.Mesh): boolean {
  return !(mesh as THREE.SkinnedMesh).isSkinnedMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh
    && !mesh.morphTargetInfluences?.length && !!mesh.geometry.getAttribute('position');
}

/** Positions (decoded to floats: car models ship quantised) of `sources` in their pivot's space, one index. */
function merge(sources: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]): THREE.BufferGeometry {
  let vertices = 0, indices = 0;
  for (const { mesh } of sources) {
    const count = mesh.geometry.getAttribute('position').count;
    vertices += count;
    indices += mesh.geometry.index ? mesh.geometry.index.count : count;
  }
  const position = new Float32Array(vertices * 3);
  const index = new Uint32Array(indices);
  const v = new THREE.Vector3();
  let vo = 0, io = 0;
  for (const { mesh, matrix } of sources) {
    const p = mesh.geometry.getAttribute('position'), source = mesh.geometry.index;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      position[(vo + i) * 3] = v.x; position[(vo + i) * 3 + 1] = v.y; position[(vo + i) * 3 + 2] = v.z;
    }
    const n = source ? source.count : p.count;
    // A mirrored part flips its facing; keep the winding the renderer would have used for it.
    const mirrored = matrix.determinant() < 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = source ? source.getX(i) : i, b = source ? source.getX(i + 1) : i + 1, c = source ? source.getX(i + 2) : i + 2;
      index[io + i] = vo + a; index[io + i + 1] = vo + (mirrored ? c : b); index[io + i + 2] = vo + (mirrored ? b : c);
    }
    vo += p.count; io += n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export class CarShadowProxy {
  readonly proxies: THREE.Mesh[] = [];
  private readonly roots: THREE.Object3D[];
  private readonly keys: string[] = [];
  private readonly watched: Watch[] = [];
  /** Casters that cannot be merged (instanced, skinned): put on the sun layer as they are. */
  private readonly direct: { mesh: THREE.Object3D; mask: number }[] = [];
  /** Nodes caught moving after a snapshot: whatever hangs under them is never merged again. */
  private readonly restless = new Set<THREE.Object3D>();
  private wait = 0;
  private disposed = false;

  constructor(...roots: (THREE.Object3D | undefined)[]) {
    this.roots = roots.filter((r): r is THREE.Object3D => !!r);
    this.build();
  }

  /** Call once per frame (after anything that toggles parts): rebuilds if the snapshot went stale. */
  update(): void {
    if (this.disposed) return;
    if (this.wait > 0) { this.wait--; return; }
    for (const w of this.watched) {
      const moved = !!w.matrix && !w.node.matrix.equals(w.matrix);
      if (moved || w.node.visible !== w.visible || (w.node as THREE.Mesh).castShadow !== w.cast) {
        if (moved) this.restless.add(w.node);
        // Build the new snapshot before letting go of the old one, so shared geometry stays cached.
        const proxies = this.proxies.splice(0), keys = this.keys.splice(0);
        this.restore(); this.watched.length = 0;
        this.build();
        this.release(proxies, keys);
        this.wait = COOLDOWN;
        return;
      }
    }
  }

  private build(): void {
    const seen = new Set<THREE.Object3D>();
    const watch = (node: THREE.Object3D, matrix: boolean): void => {
      if (seen.has(node)) return;
      seen.add(node);
      this.watched.push({ node, visible: node.visible, cast: (node as THREE.Mesh).castShadow, matrix: matrix ? node.matrix.clone() : null });
    };
    for (const root of this.roots) {
      root.updateWorldMatrix(true, true);
      // Known models have named animated pivots; an unknown one is merged per parent node, which is
      // always safe: whatever moves that parent moves its proxy.
      const named = hasCarDomains(root);
      const groups = new Map<THREE.Object3D, { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]>();
      root.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || mesh.name === PROXY_NAME || mesh.name === BATCH_NAME) return;
        const pivot = named ? carDomain(mesh, root) : mesh.parent ?? root;
        // Seen and casting, judged up to the pivot: above it visibility is inherited by the proxy.
        let shown = true, still = true;
        for (let node: THREE.Object3D | null = mesh; node && node !== pivot; node = node.parent) {
          if (this.restless.has(node)) still = false; else watch(node, true);
          if (!node.visible) shown = false;
        }
        if (!shown || !mesh.castShadow) return;
        if (!still || !mergeable(mesh)) {
          if (!this.direct.some(d => d.mesh === mesh)) { this.direct.push({ mesh, mask: mesh.layers.mask }); mesh.layers.enable(MIAMI_CAR_SHADOW_LAYER); }
          return;
        }
        const list = groups.get(pivot) ?? [];
        list.push({ mesh, matrix: new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld.clone().invert(), mesh.matrixWorld) });
        groups.set(pivot, list);
      });
      for (const [pivot, sources] of groups) {
        const key = sources.map(({ mesh, matrix }) => `${mesh.geometry.uuid}:${matrix.elements.map(e => e.toFixed(5)).join(',')}`).join('|');
        let entry = cache.get(key);
        if (!entry) cache.set(key, entry = { geometry: merge(sources), refs: 0 });
        entry.refs++;
        const proxy = new THREE.Mesh(entry.geometry, material);
        proxy.name = PROXY_NAME;
        proxy.layers.set(MIAMI_CAR_SHADOW_LAYER);
        proxy.castShadow = true;
        proxy.matrixAutoUpdate = false;
        pivot.add(proxy);
        this.proxies.push(proxy); this.keys.push(key);
      }
    }
  }

  private release(proxies: THREE.Mesh[], keys: string[]): void {
    for (const [i, proxy] of proxies.entries()) {
      proxy.removeFromParent();
      const entry = cache.get(keys[i]);
      if (entry && --entry.refs <= 0) { entry.geometry.dispose(); cache.delete(keys[i]); }
    }
  }

  private restore(): void {
    for (const { mesh, mask } of this.direct) mesh.layers.mask = mask;
    this.direct.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release(this.proxies.splice(0), this.keys.splice(0));
    this.restore();
    this.watched.length = 0; this.restless.clear();
  }
}
