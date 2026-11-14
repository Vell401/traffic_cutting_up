import * as THREE from 'three';
import { WALL_D } from '../../config';
import { CHUNK_LEN, type Road, type RoadPoint } from '../../sim/road';
import type { MiamiAssets, MiamiPrototype } from './assets';
import { miamiPeakCounts, miamiPlacements } from './layout';
import { makeMiamiProps, makePropMaterials, TINTED } from './props';
import { MIAMI_WATER, miamiGround } from './terrain';

/** Everything is instanced inside this stretch around the player... */
export const MIAMI_WINDOW = { behind: 100, ahead: 600 } as const;
/** ...except landmarks big enough to be seen through the haze, which arrive already fogged out. */
export const MIAMI_FAR_WINDOW = { behind: 300, ahead: 1300 } as const;
export const MIAMI_LANDMARKS: ReadonlySet<string> = new Set(['cruise', 'crane', 'containers', 'wheel']);

/**
 * Trim, and surfaces that sit inside a wall that already casts (glazing in its reveal, a roof inside
 * its parapet): their shadows are never seen, and each would be one more draw in the shadow pass.
 */
export const NO_SHADOW_MATERIALS: ReadonlySet<string> = new Set(['frame_ivory', 'metal_satin', 'bronze_dark', 'light_warm', 'glazing_blue', 'roof_graphite', 'glass', 'canvas']);
/** Distant or tiny props whose shadows nobody would miss. */
const NO_SHADOW_PROTOTYPES = new Set(['cruise', 'crane', 'containers', 'wheel', 'sailboat', 'bush']);

const chunkSpan = (w: { behind: number; ahead: number }): number => Math.ceil((w.behind + w.ahead) / CHUNK_LEN) + 1;

/**
 * Instanced Miami scenery: the modelled kit plus the code-built props, placed from the canonical
 * layout. Batches borrow the kit's geometry and maps; prop geometry, prop materials and all instance
 * buffers are owned here. Capacities are the exact peak of the layout, so they cannot overflow.
 */
export class MiamiWorld {
  readonly group = new THREE.Group();
  readonly prototypes: ReadonlyMap<string, MiamiPrototype>;
  private readonly batches = new Map<string, THREE.InstancedMesh[]>();
  private readonly props: Map<string, MiamiPrototype>;
  private readonly propMaterials: Map<string, THREE.MeshStandardMaterial>;
  private readonly release: () => void;
  private road: Road | null = null;
  private version = -1;
  private min = Infinity;
  private max = -Infinity;
  private disposed = false;
  private readonly point: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly transform = new THREE.Object3D();
  private readonly tint = new THREE.Color();

  constructor(readonly assets: MiamiAssets) {
    this.group.name = 'miami/world';
    this.release = assets.retain();
    this.propMaterials = makePropMaterials();
    this.props = makeMiamiProps(new Map([...assets.materials, ...this.propMaterials]));
    this.prototypes = new Map([...assets.prototypes, ...this.props]);
    const near = miamiPeakCounts(chunkSpan(MIAMI_WINDOW));
    const far = miamiPeakCounts(chunkSpan(MIAMI_FAR_WINDOW));
    for (const [name, prototype] of this.prototypes) {
      const capacity = (MIAMI_LANDMARKS.has(name) ? far : near).get(name) ?? 0;
      // A prototype the layout never uses needs no batch at all.
      if (!capacity) continue;
      const meshes = prototype.parts.map((part, i) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = part.name; mesh.count = 0; mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Warm exactly the eventual shader/buffer variant even for prototypes absent at spawn.
        mesh.setColorAt(0, this.tint.setRGB(1, 1, 1));
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = !NO_SHADOW_PROTOTYPES.has(name) && !NO_SHADOW_MATERIALS.has(part.material.name);
        mesh.receiveShadow = true;
        mesh.userData.prototype = name; mesh.userData.firstPart = i === 0;
        this.group.add(mesh); return mesh;
      });
      this.batches.set(name, meshes);
    }
  }

  update(road: Road, s: number, ox: number, oz: number, _time: number): void {
    if (this.disposed) return;
    const min = Math.floor((s - MIAMI_WINDOW.behind) / CHUNK_LEN), max = Math.floor((s + MIAMI_WINDOW.ahead) / CHUNK_LEN);
    const farMin = Math.floor((s - MIAMI_FAR_WINDOW.behind) / CHUNK_LEN), farMax = Math.floor((s + MIAMI_FAR_WINDOW.ahead) / CHUNK_LEN);
    this.group.position.set(-ox, 0, -oz);
    if (road === this.road && road.version === this.version && min === this.min && max === this.max) return;
    for (const meshes of this.batches.values()) for (const m of meshes) m.count = 0;
    for (const chunk of road.chunks) {
      if (chunk.index < farMin || chunk.index > farMax || chunk.void || chunk.kind === 'tunnel') continue;
      const close = chunk.index >= min && chunk.index <= max;
      for (const p of miamiPlacements(chunk.index)) {
        if (!close && !MIAMI_LANDMARKS.has(p.prototype)) continue;
        const prototype = this.prototypes.get(p.prototype), meshes = this.batches.get(p.prototype);
        if (!prototype || !meshes) throw Error(`Unknown Miami prototype ${p.prototype}`);
        // Use the full AABB (including overhangs/leaflets), never a guessed trunk or building radius.
        const cos = Math.abs(Math.cos(p.heading)), sin = Math.abs(Math.sin(p.heading));
        const extent = p.scale * (cos * prototype.bounds.max[0] + sin * prototype.bounds.max[2]);
        if (Math.abs(p.d) - extent <= WALL_D + 2) throw Error(`Miami road intrusion: ${p.prototype}`);
        if (meshes[0].count >= meshes[0].instanceMatrix.count) throw Error(`Miami capacity exceeded: ${p.prototype}`);
        const along = chunk.s0 + p.s;
        let y: number;
        if (prototype.waterline !== undefined) {
          // Afloat; never aground on a shore the blended coastline moved under it.
          if (miamiGround(road, along, p.d) > MIAMI_WATER - 0.5) continue;
          y = MIAMI_WATER - prototype.waterline * p.scale;
        } else if (p.prototype === 'streetlight') y = 0;
        else {
          y = miamiGround(road, along, p.d);
          const alongExtent = p.scale * (sin * prototype.bounds.max[0] + cos * prototype.bounds.max[2]);
          // Wide footprints stand on the lowest ground under them, not only under their centre.
          if (alongExtent > 4) y = Math.min(y, miamiGround(road, along - alongExtent, p.d), miamiGround(road, along + alongExtent, p.d));
          if (y < MIAMI_WATER + 0.25) continue;
        }
        road.toWorld(along, p.d, this.point);
        this.transform.position.set(this.point.x, y + p.y, this.point.z);
        // Road th grows clockwise; Three's positive Y rotation sends front -Z toward -X.
        this.transform.rotation.set(0, -this.point.th + p.heading, 0); this.transform.scale.setScalar(p.scale); this.transform.updateMatrix();
        for (const m of meshes) {
          m.setMatrixAt(m.count, this.transform.matrix);
          if (p.tint !== 0xffffff && TINTED.has((m.material as THREE.Material).name)) this.tint.setHex(p.tint);
          else this.tint.setRGB(1, 1, 1);
          m.setColorAt(m.count++, this.tint);
        }
      }
    }
    for (const meshes of this.batches.values()) for (const m of meshes) {
      m.visible = m.count > 0; m.instanceMatrix.needsUpdate = true; m.computeBoundingBox(); m.computeBoundingSphere();
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.road = road; this.version = road.version; this.min = min; this.max = max;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.group.removeFromParent(); this.group.children.forEach(o => (o as THREE.InstancedMesh).dispose());
    for (const prototype of this.props.values()) for (const part of prototype.parts) part.geometry.dispose();
    this.propMaterials.forEach(m => m.dispose());
    this.group.clear(); this.batches.clear(); this.release(); this.road = null;
  }
}
