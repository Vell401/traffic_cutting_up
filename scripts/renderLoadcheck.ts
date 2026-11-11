/** Read-only asset/CPU audit: node --import tsx scripts/renderLoadcheck.ts. No browser/GPU timing claims. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { MeshoptDecoder } from 'meshoptimizer';
import { TrafficView } from '../src/render/trafficView';
import { Sim } from '../src/sim/world';
import { VEHICLES } from '../src/sim/vehicles';
import { mulberry32 } from '../src/core/rng';

function imageSize(bytes: Buffer): [number, number] | null {
  if (bytes.toString('ascii', 1, 4) === 'PNG') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 0xff) continue;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
  }
  return null;
}

for (const file of ['porsche-911-irl10.glb', 'mercedes-a45s.glb', 'mercedes-w204.glb']) {
  const bytes = readFileSync(new URL(`../public/models/${file}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const bin = bytes.subarray(28 + jsonLength);
  let imageBytes = 0, texturePixels = 0, unknownImages = 0;
  const dimensions: [number, number][] = [];
  for (const image of asset.images ?? []) {
    const view = asset.bufferViews[image.bufferView];
    const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    imageBytes += data.length;
    const size = imageSize(data);
    if (size) { texturePixels += size[0] * size[1]; dimensions.push(size); }
    else unknownImages++;
  }
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // Parse/decode actual geometry. Image decode and WebGL upload require the browser and are excluded.
  loader.register(() => ({ name: 'audit-headless-images', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const start = performance.now();
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const headlessParseMs = performance.now() - start;
  const geometries = new Set<THREE.BufferGeometry>(), arrays = new Set<ArrayBufferView>();
  let meshes = 0, triangles = 0;
  gltf.scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++; triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
    geometries.add(mesh.geometry);
  });
  for (const geometry of geometries) {
    for (const attribute of Object.values(geometry.attributes)) {
      arrays.add((attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data.array : (attribute as THREE.BufferAttribute).array);
    }
    if (geometry.index) arrays.add(geometry.index.array);
  }
  const clonesMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const cloneStart = performance.now(); gltf.scene.clone(true); clonesMs.push(+(performance.now() - cloneStart).toFixed(2));
  }
  dimensions.sort((a, b) => b[0] * b[1] - a[0] * a[1]);
  console.log(JSON.stringify({
    file, bytes: bytes.length, imageBytes, images: asset.images?.length ?? 0, texturePixels,
    // RGBA8 + full mips is an estimate, not actual VRAM (a source image may have multiple textures).
    rgbaMipEstimateBytes: Math.round(texturePixels * 4 * 4 / 3), unknownImages,
    largestImages: dimensions.slice(0, 3), meshes, triangles,
    geometryBytes: [...arrays].reduce((sum, array) => sum + array.byteLength, 0),
    headlessParseMs: +headlessParseMs.toFixed(2), clonesMs,
  }));
}

for (let run = 0; run < 3; run++) {
  const start = performance.now(), view = new TrafficView(new THREE.Texture());
  const constructionMs = performance.now() - start;
  const sim = new Sim(mulberry32(17));
  sim.traffic.cars.forEach(car => { car.active = false; });
  VEHICLES.forEach((spec, i) => {
    const car = sim.traffic.cars[i];
    car.active = true; car.spec = spec;
    car.s = car.prevS = sim.player.s + 20; car.d = car.prevD = sim.player.d;
  });
  view.update(sim, 1, 0, 0, 0);
  let usedUpdateBytes = 0;
  view.group.traverse(object => {
    const mesh = object as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh || mesh.count === 0) return;
    const signals = mesh.geometry.getAttribute('trafficSignal') as THREE.BufferAttribute | undefined;
    const glowState = mesh.geometry.getAttribute('trafficLampState') as THREE.BufferAttribute | undefined;
    for (const attr of [mesh.instanceMatrix, mesh.instanceColor, signals, glowState]) {
      if (attr) usedUpdateBytes += attr.updateRanges.reduce((sum, range) => sum + range.count * attr.array.BYTES_PER_ELEMENT, 0);
    }
  });
  console.log(JSON.stringify({ trafficRun: run, constructionMs: +constructionMs.toFixed(2), meshes: view.group.children.length, activeCars: VEHICLES.length, usedUpdateBytes }));
  const materials = new Set<THREE.Material>();
  for (const object of view.group.children) {
    const mesh = object as THREE.InstancedMesh;
    mesh.geometry.dispose(); mesh.dispose();
    for (const material of [mesh.material].flat()) materials.add(material);
  }
  materials.forEach(material => material.dispose());
}
