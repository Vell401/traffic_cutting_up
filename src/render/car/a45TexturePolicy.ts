import type { GLTFLoader } from 'three-stdlib';

// These three maps never reach a draw: hookA45Lamps replaces both front-only materials with the
// existing untextured, self-lit materials. Keep every source image/geometry byte unchanged.
export const A45_UNUSED_LAMP_TEXTURES = [89, 90, 91] as const;
const APPROVED_METADATA = 'b3eee81f14f029c2b0191c74b4955f64f7aa0fce767d46c04b5543d1a2f589e9';

interface MaterialDef {
  name?: string;
  normalTexture?: unknown;
  pbrMetallicRoughness?: { baseColorTexture?: unknown; metallicRoughnessTexture?: unknown };
}
interface AssetDef {
  scene?: number;
  scenes?: unknown[];
  nodes?: unknown[];
  meshes?: unknown[];
  materials?: MaterialDef[];
  textures?: unknown[];
  images?: unknown[];
}

/** Fail closed on new/rearranged assets or unavailable WebCrypto: load the original maps instead. */
export async function skipUnusedA45LampMaps(asset: AssetDef): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return false;
  const { scene, scenes, nodes, meshes, materials, textures, images } = asset;
  const metadata = JSON.stringify({ scene, scenes, nodes, meshes, materials, textures, images });
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metadata)); }
  catch { return false; }
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== APPROVED_METADATA) return false;
  const reflector = materials!.find(material => material.name === 'headlight_chrome_reflector')!;
  const projector = materials!.find(material => material.name === 'front_refraction_surface_led')!;
  delete reflector.pbrMetallicRoughness!.baseColorTexture;
  delete reflector.pbrMetallicRoughness!.metallicRoughnessTexture;
  delete projector.normalTexture;
  return true;
}

export function configureA45Textures(loader: GLTFLoader): void {
  loader.register(parser => ({
    name: 'traffic-a45-unused-lamp-maps',
    beforeRoot: async () => { await skipUnusedA45LampMaps(parser.json); },
  }));
}
