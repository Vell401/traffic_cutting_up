import * as THREE from 'three';

/** All artwork is original and deterministic. No network, DOM, or renderer is required to build a car. */
export type R34MaterialName =
  | 'paint' | 'trim' | 'carbon' | 'metal' | 'chrome' | 'grille' | 'glass' | 'lens'
  | 'headlight' | 'tail' | 'redLens' | 'left' | 'right' | 'decal' | 'tyre' | 'rim'
  | 'disc' | 'caliper' | 'darkMetal' | 'reverse';

export interface R34MaterialSet {
  materials: Record<R34MaterialName, THREE.Material>;
  paint: THREE.MeshPhysicalMaterial;
  tail: THREE.MeshBasicMaterial;
  left: THREE.MeshBasicMaterial;
  right: THREE.MeshBasicMaterial;
  dispose(): void;
}

interface TextureSet {
  pearl: THREE.Texture;
  carbon: THREE.Texture;
  carbonRelief: THREE.Texture;
  carbonNormal: THREE.Texture;
  rubber: THREE.Texture;
  brushed: THREE.Texture;
  decals: THREE.Texture;
}

export const R34_TEXTURE_BUDGET = Object.freeze({
  largestDimension: 1024,
  textureCount: 7,
  /** RGBA8 including a complete mip chain; textures remain cached for all cars. */
  estimatedBytes: Math.ceil((128 ** 2 + 256 ** 2 * 4 + 512 ** 2 + 1024 ** 2) * 4 * 4 / 3),
});

let textures: TextureSet | undefined;

function hash(x: number, y: number): number {
  let n = Math.imul(x + 11, 374761393) ^ Math.imul(y + 37, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** CanvasTexture in the browser, byte-identical procedural pixels in headless/CPU-only tests. */
function imageTexture(
  size: number,
  sample: (x: number, y: number) => readonly [number, number, number, number],
  color = false,
  draw?: (ctx: CanvasRenderingContext2D) => void,
): THREE.Texture {
  const bytes = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) bytes.set(sample(x, y), (y * size + x) * 4);
  let texture: THREE.Texture | undefined;
  // JSDOM, workers and SSR may have a document but no working 2D canvas implementation.
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(size, size);
        image.data.set(bytes);
        ctx.putImageData(image, 0, 0);
        draw?.(ctx);
        texture = new THREE.CanvasTexture(canvas);
      }
    } catch { /* Use the deterministic CPU texture below. */ }
  }
  if (!texture) {
    texture = new THREE.DataTexture(new Uint8Array(bytes.buffer), size, size, THREE.RGBAFormat);
    texture.flipY = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.needsUpdate = true;
  }
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.userData.shared = true;
  return texture;
}

/** Atlas cells are deliberately generous so mip levels do not bleed across adjacent lettering. */
export const R34_DECALS = Object.freeze({
  plate: [0, 0, 0.5, 0.25],
  gtr: [0.5, 0, 0.25, 0.25],
  skyline: [0, 0.25, 0.75, 0.125],
  tyre: [0, 0.5, 1, 0.125],
  brembo: [0.5, 0.375, 0.5, 0.125],
  nissan: [0.75, 0, 0.25, 0.25],
  vSpec: [0, 0.375, 0.5, 0.125],
} satisfies Record<string, readonly number[]>);

function getTextures(): TextureSet {
  if (textures) return textures;
  const pearl = imageTexture(128, (x, y) => {
    const v = 224 + Math.round(hash(x, y) * 28);
    return [v, v, v, 255];
  });
  pearl.repeat.set(18, 18);
  const carbon = imageTexture(256, (x, y) => {
    const a = Math.floor(x / 8), b = Math.floor(y / 8);
    const vertical = (a + b) % 4 < 2;
    const thread = vertical ? x % 8 : y % 8;
    const v = 25 + Math.sin((thread + 0.5) / 8 * Math.PI) * 17 + hash(x, y) * 5;
    return [v, v + 2, v + 3, 255];
  }, true);
  const carbonRelief = imageTexture(256, (x, y) => {
    const vertical = (Math.floor(x / 8) + Math.floor(y / 8)) % 4 < 2;
    const v = 115 + Math.sin(((vertical ? x : y) % 8) / 8 * Math.PI) * 29;
    return [v, v, v, 255];
  });
  const carbonNormal = imageTexture(256, (x, y) => {
    const vertical = (Math.floor(x / 8) + Math.floor(y / 8)) % 4 < 2;
    const slope = Math.cos(((vertical ? x : y) % 8) / 8 * Math.PI) * 28;
    return [128 + (vertical ? slope : 0), 128 + (vertical ? 0 : slope), 251, 255];
  });
  for (const texture of [carbon, carbonRelief, carbonNormal]) texture.repeat.set(5, 5);
  const rubber = imageTexture(512, (x, y) => {
    const channel = x % 128 < 8;
    const diagonal = (y + Math.floor(x / 128) * 33 + x * 0.7) % 66 < 4;
    const v = channel || diagonal ? 40 : 150 + hash(x, y) * 32;
    return [v, v, v, 255];
  });
  const brushed = imageTexture(256, (x, y) => {
    const v = 150 + hash(0, y) * 64 + hash(x, y) * 11;
    return [v, v, v, 255];
  });
  const decals = imageTexture(1024, (x, y) => {
    // CPU fallback keeps plates legible as actual graphic patterns, even without font rendering.
    if (x < 512 && y < 256) {
      const border = x < 18 || x > 494 || y < 20 || y > 236;
      const glyph = y > 97 && y < 186 && x > 76 && x < 436 && (Math.floor(x / 30) % 2 === 0 || y > 165);
      return border || glyph ? [24, 40, 34, 255] : [226, 229, 217, 255];
    }
    return [255, 255, 255, 0];
  }, true, (ctx) => {
    ctx.clearRect(0, 0, 1024, 1024);
    ctx.fillStyle = '#e9ece4'; ctx.fillRect(12, 18, 488, 222);
    ctx.strokeStyle = '#253b30'; ctx.lineWidth = 6; ctx.strokeRect(18, 24, 476, 210);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#263b30'; ctx.font = '32px sans-serif'; ctx.fillText('YOKOHAMA  34', 256, 64);
    ctx.font = 'bold 97px monospace'; ctx.fillText('19-99', 256, 158);
    ctx.fillStyle = '#e2e6ea'; ctx.font = 'bold italic 66px sans-serif'; ctx.fillText('GT', 640, 71);
    ctx.fillStyle = '#bd142b'; ctx.font = 'bold italic 126px serif'; ctx.fillText('R', 640, 167);
    ctx.strokeStyle = '#e4e8e9'; ctx.lineWidth = 9; ctx.beginPath(); ctx.ellipse(896, 126, 106, 81, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ced3d5'; ctx.fillRect(785, 104, 222, 45);
    ctx.fillStyle = '#151a1d'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('NISSAN', 896, 128);
    ctx.fillStyle = '#c5c9ce'; ctx.font = '44px sans-serif'; ctx.fillText('S K Y L I N E', 384, 320);
    ctx.font = 'italic 38px sans-serif'; ctx.fillText('V·spec II', 256, 447);
    ctx.fillStyle = '#eee7dc'; ctx.font = 'italic bold 42px sans-serif'; ctx.fillText('brembo', 768, 446);
    ctx.fillStyle = '#93989a'; ctx.font = 'bold 44px sans-serif'; ctx.fillText('ADVAN   SPORT   265 / 35 ZR18', 512, 574);
  });
  decals.wrapS = decals.wrapT = THREE.ClampToEdgeWrapping;
  textures = { pearl, carbon, carbonRelief, carbonNormal, rubber, brushed, decals };
  return textures;
}

/** Materials are ALWAYS per-car. In particular, private paint is never tagged as shared. */
export function createR34Materials(color: number): R34MaterialSet {
  const t = getTextures();
  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.62, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.16,
    roughnessMap: t.pearl, bumpMap: t.pearl, bumpScale: 0.00012,
    iridescence: 0.12, iridescenceIOR: 1.32, iridescenceThicknessMinimum: 100, iridescenceThicknessMaximum: 160,
  });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.012, 0.008), toneMapped: false });
  const left = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.17, 0.055, 0.002), toneMapped: false });
  const right = left.clone();
  const materials: R34MaterialSet['materials'] = {
    paint,
    trim: new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.74 }),
    carbon: new THREE.MeshPhysicalMaterial({ color: 0x9aa3af, map: t.carbon, normalMap: t.carbonNormal, normalScale: new THREE.Vector2(0.28, 0.28), roughnessMap: t.carbonRelief, roughness: 0.56, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.25 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb4bfc4, metalness: 0.92, roughness: 0.39, roughnessMap: t.brushed }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd7e0e9, metalness: 0.98, roughness: 0.18 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x171c20, metalness: 0.5, roughness: 0.55 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xa9c2cc, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.07 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xd4e5f1, transparent: true, opacity: 0.13, roughness: 0.06, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1 }),
    headlight: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.1, 2.3, 2.65), toneMapped: false }),
    tail,
    redLens: new THREE.MeshPhysicalMaterial({ color: 0x8b0812, roughness: 0.22, metalness: 0.12, clearcoat: 1 }),
    left, right,
    decal: new THREE.MeshStandardMaterial({ map: t.decals, transparent: true, alphaTest: 0.2, roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x202227, roughness: 0.92, bumpMap: t.rubber, bumpScale: 0.0012 }),
    rim: new THREE.MeshPhysicalMaterial({ color: 0x737d87, metalness: 0.93, roughness: 0.28, clearcoat: 0.5 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x9da1a6, metalness: 0.88, roughness: 0.52, roughnessMap: t.brushed }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xb78a40, metalness: 0.65, roughness: 0.35 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: 0x343c46, metalness: 0.85, roughness: 0.42 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0xc9d2d4, emissive: 0x1c2328, roughness: 0.3 }),
  };
  for (const [name, material] of Object.entries(materials)) material.name = `R34/${name}`;
  let disposed = false;
  return {
    materials, paint, tail, left, right,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
