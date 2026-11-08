import * as THREE from 'three';

export type R34MaterialName = 'paint' | 'trim' | 'carbon' | 'metal' | 'chrome' | 'grille' | 'glass' | 'lens' | 'headlight' | 'tail' | 'redLens' | 'left' | 'right' | 'decal' | 'tyre' | 'rim' | 'disc' | 'caliper' | 'darkMetal' | 'reverse';
export const R34_DECALS = {
  plate: [0, 0, .5, .25], gtr: [.5, 0, .25, .25], nissan: [.75, 0, .25, .25],
  skyline: [0, .25, .75, .125], vSpec: [0, .375, .5, .125], brembo: [.5, .375, .5, .125], tyre: [0, .5, 1, .125],
} as const;
export const R34_TEXTURE_BUDGET = Object.freeze({ largestDimension: 1024, textureCount: 6, estimatedBytes: Math.ceil((128 ** 2 * 3 + 256 ** 2 * 2 + 1024 ** 2) * 4 * 4 / 3) });
type Textures = Record<'pearl' | 'weave' | 'weaveNormal' | 'rubber' | 'brushed' | 'atlas', THREE.Texture>;
let cached: Textures | undefined;
function noise(x: number, y: number): number {
  let n = Math.imul(x + 11, 374761393) ^ Math.imul(y + 37, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function texture(size: number, pixel: (x: number, y: number) => number[], color = false, draw?: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) bytes.set(pixel(x, y), (y * size + x) * 4);
  let t: THREE.Texture | undefined;
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) { const image = ctx.createImageData(size, size); image.data.set(bytes); ctx.putImageData(image, 0, 0); draw?.(ctx); t = new THREE.CanvasTexture(canvas); }
    } catch { /* Workers and CPU tests need no canvas. */ }
  }
  if (!t) { t = new THREE.DataTexture(bytes, size, size); t.flipY = true; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.userData.shared = true; t.needsUpdate = true;
  return t;
}
function textures(): Textures {
  if (cached) return cached;
  const pearl = texture(128, (x, y) => { const v = 230 + noise(x, y) * 22; return [v, v, v, 255]; }); pearl.repeat.set(20, 20);
  const weave = texture(128, (x, y) => {
    const vertical = (Math.floor(x / 8) + Math.floor(y / 8)) % 4 < 2;
    const v = 30 + 13 * Math.sin(((vertical ? x : y) % 8 + .5) / 8 * Math.PI) + noise(x, y) * 3;
    return [v, v + 1, v + 2, 255];
  }, true);
  const weaveNormal = texture(128, (x, y) => {
    const vertical = (Math.floor(x / 8) + Math.floor(y / 8)) % 4 < 2;
    const slope = Math.cos(((vertical ? x : y) % 8) / 8 * Math.PI) * 15;
    return [128 + (vertical ? slope : 0), 128 + (vertical ? 0 : slope), 254, 255];
  });
  weave.repeat.set(7, 7); weaveNormal.repeat.copy(weave.repeat);
  // Micro-grain only: major tread grooves are geometry, and sidewalls must not inherit tread stripes.
  const rubber = texture(256, (x, y) => { const v = 150 + noise(x, y) * 24; return [v, v, v, 255]; });
  const brushed = texture(256, (x, y) => { const v = 182 + noise(0, y) * 28 + noise(x, y) * 6; return [v, v, v, 255]; });
  const atlas = texture(1024, (x, y) => {
    if (x < 512 && y < 256) {
      const ink = x < 14 || x > 498 || y < 16 || y > 240 || (y > 96 && y < 190 && x > 80 && x < 430 && (Math.floor(x / 30) % 2 === 0 || y > 168));
      return ink ? [28, 42, 34, 255] : [229, 232, 220, 255];
    }
    return [255, 255, 255, 0];
  }, true, ctx => {
    ctx.clearRect(0, 0, 1024, 1024); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e5e8dc'; ctx.fillRect(12, 18, 488, 222); ctx.strokeStyle = '#263c31'; ctx.lineWidth = 6; ctx.strokeRect(18, 24, 476, 210);
    ctx.fillStyle = '#263c31'; ctx.font = '32px sans-serif'; ctx.fillText('YOKOHAMA  34', 256, 64); ctx.font = 'bold 97px monospace'; ctx.fillText('19-99', 256, 158);
    ctx.fillStyle = '#c5cbce'; ctx.font = 'bold italic 66px sans-serif'; ctx.fillText('GT', 640, 71); ctx.fillStyle = '#a91829'; ctx.font = 'bold italic 126px serif'; ctx.fillText('R', 640, 167);
    ctx.strokeStyle = '#cbd1d2'; ctx.lineWidth = 9; ctx.beginPath(); ctx.ellipse(896, 126, 106, 81, 0, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = '#bac2c5'; ctx.fillRect(785, 104, 222, 45);
    ctx.fillStyle = '#20272b'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('NISSAN', 896, 128);
    ctx.fillStyle = '#bdc5cb'; ctx.font = '44px sans-serif'; ctx.fillText('S K Y L I N E', 384, 320); ctx.font = 'italic 38px sans-serif'; ctx.fillText('V·spec II', 256, 447);
    ctx.fillStyle = '#dfd9cd'; ctx.font = 'italic bold 42px sans-serif'; ctx.fillText('brembo', 768, 446);
    ctx.fillStyle = '#777c80'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('SPORT   265 / 35 ZR18', 512, 574);
  });
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  return cached = { pearl, weave, weaveNormal, rubber, brushed, atlas };
}

/** All materials are private to a car. Only the original procedural texture pixels are shared. */
export function createR34Materials(color: number) {
  const t = textures();
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: .52, roughness: .3, roughnessMap: t.pearl, bumpMap: t.pearl, bumpScale: .000045, clearcoat: 1, clearcoatRoughness: .13 });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(.75, .008, .004), toneMapped: false });
  const left = new THREE.MeshBasicMaterial({ color: new THREE.Color(.12, .035, .001), toneMapped: false }), right = left.clone();
  const materials: Record<R34MaterialName, THREE.Material> = {
    paint, tail, left, right,
    trim: new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: .84 }),
    carbon: new THREE.MeshPhysicalMaterial({ color: 0xb2b5b8, map: t.weave, normalMap: t.weaveNormal, normalScale: new THREE.Vector2(.22, .22), metalness: .12, roughness: .43, clearcoat: .8, clearcoatRoughness: .24 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x969fa4, roughnessMap: t.brushed, metalness: .82, roughness: .54 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xbfc6cc, metalness: .96, roughness: .26 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: 0x33393e, metalness: .72, roughness: .48 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x1c2023, metalness: .45, roughness: .64 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x90a7b0, roughness: .1, transparent: true, opacity: .24, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: .08 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xd6e0e2, roughness: .08, transparent: true, opacity: .15, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1 }),
    headlight: new THREE.MeshStandardMaterial({ color: 0xa6b5bf, metalness: .35, roughness: .18, emissive: 0x617480, emissiveIntensity: .5 }),
    redLens: new THREE.MeshPhysicalMaterial({ color: 0x6e0610, metalness: .08, roughness: .24, clearcoat: 1 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0xadb8bb, roughness: .3, metalness: .15 }),
    decal: new THREE.MeshStandardMaterial({ map: t.atlas, transparent: true, alphaTest: .2, roughness: .55, metalness: .15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x202124, roughness: .94, bumpMap: t.rubber, bumpScale: .00022 }),
    rim: new THREE.MeshPhysicalMaterial({ color: 0x687079, metalness: .86, roughness: .34, clearcoat: .35 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x8b9094, metalness: .8, roughness: .56, roughnessMap: t.brushed }),
    caliper: new THREE.MeshStandardMaterial({ color: 0x98763d, metalness: .6, roughness: .39 }),
  };
  for (const [name, material] of Object.entries(materials)) material.name = `R34/${name}`;
  let disposed = false;
  return { materials, paint, tail, left, right, dispose() { if (!disposed) { disposed = true; Object.values(materials).forEach(m => m.dispose()); } } };
}
