import * as THREE from 'three';
import type { Road } from '../../sim/road';
import { HORIZON, type SkyId } from '../sky';
import type { MiamiAssets } from './assets';

/** Owns the PMREM target, borrows HDR through a lease. Never disposes target.texture separately. */
export class MiamiEnvironment {
  private readonly release: () => void;
  private disposed = false;
  private readonly point = { x: 0, z: 0, th: 0, k: 0 };
  private readonly sunOffset = new THREE.Vector3(-85, 65, 80);
  constructor(readonly assets: MiamiAssets, private readonly reflection: THREE.WebGLRenderTarget) { this.release = assets.retain(); }

  static create(assets: MiamiAssets, renderer: THREE.WebGLRenderer): MiamiEnvironment {
    const generator = new THREE.PMREMGenerator(renderer);
    try { return new MiamiEnvironment(assets, generator.fromEquirectangular(assets.hdr)); }
    finally { generator.dispose(); }
  }

  apply(scene: THREE.Scene, sky: THREE.Group, id: SkyId): void {
    const sunset = id === 'miami-night';
    sky.visible = !sunset; scene.background = sunset ? this.assets.hdr : HORIZON;
    scene.environment = this.reflection.texture; scene.environmentIntensity = sunset ? 0.65 : 0.22;
    scene.backgroundIntensity = 0.7;
    if (sunset && scene.fog instanceof THREE.Fog) { scene.fog.color.setHex(0x92979e); scene.fog.near = 160; scene.fog.far = 900; }
  }

  update(road: Road, s: number, ox: number, oz: number, sun: THREE.DirectionalLight): void {
    const p = road.toWorld(s + 45, 0, this.point);
    sun.target.position.set(p.x - ox, 0, p.z - oz);
    sun.position.copy(sun.target.position).add(this.sunOffset);
    sun.target.updateMatrixWorld();
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.reflection.dispose(); this.release();
  }
}
