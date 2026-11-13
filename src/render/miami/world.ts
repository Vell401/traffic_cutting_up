import * as THREE from 'three';
import { WALL_D } from '../../config';
import { CHUNK_LEN, type Road, type RoadPoint } from '../../sim/road';
import type { MiamiAssets } from './assets';
import { MIAMI_WATER, miamiGround, miamiPlacements } from './layout';

export const MIAMI_WINDOW = { behind: 100, ahead: 600 } as const;
/** Eight chunks maximum including both ends. Capacities are per prototype, shared by every part. */
export const MIAMI_CAPACITIES = {
  hotel_deco: 24, hotel_colonnade: 24, condo_terrace: 8, tower_glass: 8, tower_setback: 8,
  garage_canopy: 8, palm_coconut: 48, palm_royal: 24, yacht: 24, streetlight: 32,
  bench: 48, bollard: 32, planter: 48, hedge: 32, marina_pontoon: 8,
} as const;

/** Batches borrow immutable extracted geometry/material/maps. Only instance buffers belong here. */
export class MiamiWorld {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, THREE.InstancedMesh[]>();
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
    this.group.name = 'miami/authored-world'; this.release = assets.retain();
    for (const [name, prototype] of assets.prototypes) {
      const capacity = MIAMI_CAPACITIES[name as keyof typeof MIAMI_CAPACITIES];
      if (!capacity) throw Error(`Unbudgeted Miami prototype ${name}`);
      const meshes = prototype.parts.map((part, i) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = part.name; mesh.count = 0; mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Warm exactly the eventual shader/buffer variant even for prototypes absent at spawn.
        mesh.setColorAt(0, this.tint.setRGB(1, 1, 1));
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        // All authored detail stays visible at full resolution. Tiny metal/frame trim is not an
        // extra shadow caster: the physical walls/hulls/foliage still cast the local contact shadows.
        mesh.castShadow = !['frame_ivory', 'metal_satin', 'bronze_dark', 'light_warm'].includes(part.material.name);
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
    this.group.position.set(-ox, 0, -oz);
    if (road === this.road && road.version === this.version && min === this.min && max === this.max) return;
    for (const meshes of this.batches.values()) for (const m of meshes) m.count = 0;
    for (const chunk of road.chunks) {
      if (chunk.index < min || chunk.index > max || chunk.void || chunk.kind === 'tunnel') continue;
      const elevated = chunk.kind === 'bridge' || chunk.kind === 'viaduct';
      for (const p of miamiPlacements(chunk.index)) {
        if (elevated && Math.abs(p.d) < 100 && p.prototype !== 'streetlight') continue;
        const prototype = this.assets.prototypes.get(p.prototype)!, meshes = this.batches.get(p.prototype)!;
        // Use the full AABB (including overhangs/leaflets), never a guessed trunk or building radius.
        const extent = p.scale * (Math.abs(Math.cos(p.heading)) * prototype.bounds.max[0] + Math.abs(Math.sin(p.heading)) * prototype.bounds.max[2]);
        if (Math.abs(p.d) - extent <= WALL_D + 2) throw Error(`Miami road intrusion: ${p.prototype}`);
        if (meshes[0].count >= meshes[0].instanceMatrix.count) throw Error(`Miami capacity exceeded: ${p.prototype}`);
        const along = chunk.s0 + p.s; road.toWorld(along, p.d, this.point);
        const alongExtent = p.scale * (Math.abs(Math.sin(p.heading)) * prototype.bounds.max[0] + Math.abs(Math.cos(p.heading)) * prototype.bounds.max[2]);
        const y = prototype.waterline !== undefined ? MIAMI_WATER - prototype.waterline * p.scale
          : Math.abs(p.d) >= 250 ? MIAMI_WATER + 0.6 : p.prototype === 'streetlight' ? 0
            : Math.min(miamiGround(road, along, p.d), miamiGround(road, along - alongExtent, p.d), miamiGround(road, along + alongExtent, p.d));
        this.transform.position.set(this.point.x, y + p.y, this.point.z);
        // Road th grows clockwise; Three's positive Y rotation sends front -Z toward -X.
        this.transform.rotation.set(0, -this.point.th + p.heading, 0); this.transform.scale.setScalar(p.scale); this.transform.updateMatrix();
        for (const m of meshes) {
          m.setMatrixAt(m.count, this.transform.matrix);
          // Shared PBR remains shared; parcel-scale paint/glazing variation costs no new draws.
          const material = (m.material as THREE.Material).name;
          const parcel = ((chunk.index % 120 + 120) % 120 * 7 + Math.floor(p.s)) % 5;
          this.tint.setRGB(1, 1, 1);
          if (/^(hotel|condo|tower)/.test(p.prototype)) {
            if (material.startsWith('plaster_')) this.tint.setRGB(1 - parcel * .025, .92 + parcel * .018, .87 + parcel * .025);
            if (material === 'glazing_blue') this.tint.setRGB(.68 + parcel * .07, .78 + parcel * .045, .83 + parcel * .035);
          }
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
    this.group.clear(); this.batches.clear(); this.release(); this.road = null;
  }
}
