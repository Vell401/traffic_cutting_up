import * as THREE from 'three';

/** One small, repeatable aggregate tile, shared by every polished carriageway. */
export function createRoadMaterials(anisotropy = 1): Map<string, THREE.MeshStandardMaterial> {
  const size = 256, pixels = new Uint8Array(size * size * 4);
  let seed = 0x4d5344;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Low contrast mineral grains, not oversized cracks or painted-on random spots.
    const grain = (noise() - .5) * 13 + (noise() > .985 ? 9 : 0);
    const base = 64 + grain + 1.4 * Math.sin(x / 23) * Math.sin(y / 31);
    const at = (y * size + x) * 4;
    pixels[at] = base; pixels[at + 1] = base + 1; pixels[at + 2] = base + 2; pixels[at + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = Math.min(8, anisotropy); texture.needsUpdate = true;
  return new Map([
    ['msd:asphalt', new THREE.MeshStandardMaterial({ map: texture, color: '#ffffff', roughness: .96,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 })],
    ['msd:line', new THREE.MeshStandardMaterial({ color: '#f5f5ef', roughness: .8, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })],
  ]);
}
