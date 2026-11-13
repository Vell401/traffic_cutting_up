import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMiamiAssetLoader, extractMiamiAssets, type MiamiManifest } from '../src/render/miami/assets';
import { MiamiEnvironment } from '../src/render/miami/environment';

export const manifest = JSON.parse(readFileSync('public/models/miami/manifest.json', 'utf8')) as MiamiManifest;
export function source() {
  const scene = new THREE.Group();
  for (const p of manifest.prototypes) {
    const root = new THREE.Group(); root.name = p.name;
    for (const part of p.parts) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      m.name = part.name; root.add(m);
    }
    scene.add(root);
  }
  return scene;
}
export function assets() {
  return extractMiamiAssets(manifest, source(), new Map(manifest.textures.map(t => [t.id, new THREE.Texture()])));
}

describe('Miami required shared assets', () => {
  it('importing the runtime from Node does not start any asset or third-party HTTP', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); vi.resetModules();
    await import('../src/render/miami/assets'); expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
  });
  it('does no HTTP on import, coalesces pending work, and retries a real rejected request', async () => {
    let attempts = 0;
    const load = createMiamiAssetLoader({
      manifest: async () => { if (++attempts === 1) throw Error('offline'); return manifest; },
      model: async () => source(), texture: async () => new THREE.Texture(),
    });
    const first = load(); expect(load()).toBe(first);
    await expect(first).rejects.toThrow('offline');
    const a = await load(); expect(attempts).toBe(2); expect(await load()).toBe(a);
    const release = a.retain(); release(); release();
    expect((await load())).not.toBe(a);
  });
  it('extracts by semantic name, bakes local transforms once without recentering, and shares exact PBR factors/maps', () => {
    const scene = source(); scene.children.reverse();
    const root = scene.getObjectByName('hotel_deco')!;
    const child = root.children[0] as THREE.Mesh; child.position.x = 3;
    const original = child.geometry.getAttribute('position').getX(0);
    const a = extractMiamiAssets(manifest, scene, new Map(manifest.textures.map(t => [t.id, new THREE.Texture()])));
    expect(a.prototypes.get('hotel_deco')!.parts[0].geometry.getAttribute('position').getX(0)).toBe(original + 3);
    expect(a.materials.get('plaster_coral')!.map).toBe(a.materials.get('plaster_ivory')!.map);
    const coral = a.materials.get('plaster_coral')!;
    expect(coral.roughness).toBe(0.76); // Standard material multiplies factor by roughnessMap.g.
    expect(coral.color.toArray()).toEqual(manifest.materials.find(m => m.name === 'plaster_coral')!.baseColor.slice(0, 3));
    expect(coral.normalScale.toArray()).toEqual([0.22, 0.22]);
    expect(coral.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(coral.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(coral.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
    for (const t of a.textures.values()) if (!t.name.endsWith('hdri')) {
      expect(t.flipY).toBe(false); expect(t.repeat.toArray()).toEqual([1, 1]); expect(t.wrapS).toBe(THREE.RepeatWrapping);
    }
    a.dispose();
  });
  it('cleans fulfilled and late resources on partial failure and disposes shared geometry/materials/maps only once after the last borrower', async () => {
    const texture = new THREE.Texture(), disposed = vi.spyOn(texture, 'dispose');
    let late!: () => void;
    const retry = createMiamiAssetLoader({ manifest: async () => manifest, model: async () => source(),
      texture: async t => {
        if (t.id === manifest.textures[0].id) throw Error('photo');
        if (t.id === manifest.textures[9].id) await new Promise<void>(r => { late = r; });
        return texture;
      },
    });
    const pending = retry(); await vi.waitFor(() => expect(late).toBeTypeOf('function')); late();
    await expect(pending).rejects.toThrow('photo'); expect(disposed).toHaveBeenCalledOnce();
    const a = assets(), maps = [...a.textures.values()].map(t => vi.spyOn(t, 'dispose'));
    const one = a.retain(), two = a.retain(); one(); a.dispose(); maps.forEach(s => expect(s).not.toHaveBeenCalled());
    two(); two(); a.dispose(); maps.forEach(s => expect(s).toHaveBeenCalledOnce());
  });
  it('owns PMREM output, not borrowed HDR/maps, and restores alternative skies', () => {
    const a = assets(), target = new THREE.WebGLRenderTarget(16, 16), dispose = vi.spyOn(target, 'dispose');
    const scene = new THREE.Scene(), sky = new THREE.Group();
    const environment = new MiamiEnvironment(a, target);
    environment.apply(scene, sky, 'miami-night'); expect(scene.background).toBe(a.hdr); expect(sky.visible).toBe(false);
    environment.apply(scene, sky, 'night'); expect(sky.visible).toBe(true); expect(scene.background).not.toBe(a.hdr);
    environment.dispose(); environment.dispose(); expect(dispose).toHaveBeenCalledOnce(); a.dispose();
  });
});
