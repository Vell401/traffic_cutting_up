import * as THREE from 'three';
import type { MiamiAssets } from './assets';

/** Derived scaffolding materials borrow shared photo maps. Their owner disposes materials only. */
export function makeMiamiMaterials(assets: MiamiAssets) {
  const road = assets.materials.get('asphalt_road')!.clone(); road.vertexColors = true;
  const struct = assets.materials.get('concrete_warm')!.clone(); struct.vertexColors = true; struct.color.setScalar(1);
  const water = new THREE.MeshStandardMaterial({ name: 'miami/bay-water', color: 0x285358,
    roughness: 0.24, metalness: 0.22, normalMap: assets.materials.get('concrete_warm')!.normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22), vertexColors: true });
  return { road, struct, water };
}
