import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';

/** Real delivered buffers/material definitions. Only native image decoding is substituted in Node,
 * exactly as the existing imported-car tests; no geometry, hierarchy or material factor proxy. */
export async function actualA45(file = 'mercedes-a45s.glb'): Promise<GLTF> {
  const bytes = readFileSync(`public/models/${file}`);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register(() => ({ name: 'headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}
