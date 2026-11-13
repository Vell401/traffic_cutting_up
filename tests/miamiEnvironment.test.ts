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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flushMicrotasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

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
  it.each(['model', 'map', 'HDR'] as const)('rejects a failed %s and completes a coalesced retry before old siblings settle, then frees only old resources once', async failed => {
    const oldModel = deferred<THREE.Group>();
    const oldMaps = manifest.textures.map(() => deferred<THREE.Texture>());
    const oldScene = source();
    const oldTextures = manifest.textures.map(() => new THREE.Texture());
    // Shared IDs/meshes must not turn eventual failed-job cleanup into duplicate disposal.
    oldTextures[3] = oldTextures[2];
    const oldResources = new Set<THREE.Texture | THREE.BufferGeometry | THREE.Material>(oldTextures);
    const oldClones: ReturnType<typeof vi.spyOn>[] = [];
    oldScene.traverse(o => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      oldResources.add(mesh.geometry); oldResources.add(mesh.material as THREE.Material);
      oldClones.push(vi.spyOn(mesh.geometry, 'clone'));
    });
    const oldDisposals = new Map([...oldResources].map(r => [r, vi.spyOn(r, 'dispose')]));
    const newScene = source();
    const newTextures = manifest.textures.map(() => new THREE.Texture());
    const newDisposals = newTextures.map(t => vi.spyOn(t, 'dispose'));
    let attempts = 0;
    const load = createMiamiAssetLoader({
      manifest: async () => { attempts++; return manifest; },
      model: () => attempts === 1 ? oldModel.promise : Promise.resolve(newScene),
      texture: def => {
        const index = manifest.textures.findIndex(t => t.id === def.id);
        return attempts === 1 ? oldMaps[index].promise : Promise.resolve(newTextures[index]);
      },
    });
    const first = load(); expect(load()).toBe(first);
    let state = 'pending';
    void first.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
    await flushMicrotasks();
    oldMaps[1].resolve(oldTextures[1]); // Already loaded before another required request fails.
    await flushMicrotasks();
    const error = Error(`${failed} HTTP 503`);
    if (failed === 'model') oldModel.reject(error);
    else oldMaps[failed === 'map' ? 0 : 9].reject(error);
    await flushMicrotasks();
    expect(state, 'required failure must reach callers before stalled siblings are released').toBe('rejected');
    await expect(first).rejects.toBe(error);
    expect(oldDisposals.get(oldTextures[1])).toHaveBeenCalledOnce();

    const retry = load(); expect(retry).not.toBe(first); expect(load()).toBe(retry);
    const live = await retry; // Every other old request is deliberately still pending here.
    const release = live.retain();
    const liveResources = new Set<THREE.Material | THREE.BufferGeometry>([
      ...live.materials.values(),
      ...[...live.prototypes.values()].flatMap(p => p.parts.map(part => part.geometry)),
    ]);
    const liveDisposals = [...liveResources].map(resource => vi.spyOn(resource, 'dispose'));
    expect(attempts).toBe(2); expect(await load()).toBe(live);
    newDisposals.forEach(spy => expect(spy).not.toHaveBeenCalled());

    if (failed !== 'model') oldModel.resolve(oldScene);
    for (let i = 0; i < oldMaps.length; i++) if (!(failed === 'map' && i === 0) && !(failed === 'HDR' && i === 9)) oldMaps[i].resolve(oldTextures[i]);
    await flushMicrotasks();
    for (const [resource, spy] of oldDisposals) {
      const returned = resource instanceof THREE.Texture
        ? oldTextures.some((texture, i) => texture === resource && !(failed === 'map' && i === 0) && !(failed === 'HDR' && i === 9))
        : failed !== 'model';
      expect(spy).toHaveBeenCalledTimes(returned ? 1 : 0);
    }
    oldClones.forEach(spy => expect(spy).not.toHaveBeenCalled()); // Late GLB is freed, never extracted/attached.
    expect(live.disposed).toBe(false); expect(await load()).toBe(live); expect(attempts).toBe(2);
    newDisposals.forEach(spy => expect(spy).not.toHaveBeenCalled());
    liveDisposals.forEach(spy => expect(spy).not.toHaveBeenCalled());
    release(); [...newDisposals, ...liveDisposals].forEach(spy => expect(spy).toHaveBeenCalledOnce());
  });
  it('consumes source, copied geometry and maps once on extraction failure, then permits a clean retry', async () => {
    const invalid = source(); invalid.children[1].name = 'missing_semantic_root';
    const sourceDisposals: ReturnType<typeof vi.spyOn>[] = [];
    invalid.traverse(o => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      sourceDisposals.push(vi.spyOn(mesh.geometry, 'dispose'), vi.spyOn(mesh.material as THREE.Material, 'dispose'));
    });
    const maps = manifest.textures.map(() => new THREE.Texture());
    const mapDisposals = maps.map(t => vi.spyOn(t, 'dispose'));
    const copies: ReturnType<typeof vi.spyOn>[] = [];
    const original = THREE.BufferGeometry.prototype.clone;
    const clone = vi.spyOn(THREE.BufferGeometry.prototype, 'clone').mockImplementation(function (this: THREE.BufferGeometry) {
      const copy = original.call(this); copies.push(vi.spyOn(copy, 'dispose')); return copy;
    });
    let attempts = 0;
    const load = createMiamiAssetLoader({
      manifest: async () => { attempts++; return manifest; },
      model: async () => attempts === 1 ? invalid : source(),
      texture: async def => attempts === 1 ? maps[manifest.textures.findIndex(t => t.id === def.id)] : new THREE.Texture(),
    });
    try {
      await expect(load()).rejects.toThrow('Missing Miami model hotel_colonnade');
      expect(copies.length).toBeGreaterThan(0);
      [...sourceDisposals, ...mapDisposals, ...copies].forEach(spy => expect(spy).toHaveBeenCalledOnce());
      const live = await load(); expect(attempts).toBe(2); live.dispose();
      [...sourceDisposals, ...mapDisposals].forEach(spy => expect(spy).toHaveBeenCalledOnce());
    } finally { clone.mockRestore(); }
  });
  it('handles a second late old rejection without clearing a newer in-flight retry', async () => {
    const lateOldHDR = deferred<THREE.Texture>();
    const retryModel = deferred<THREE.Group>();
    const oldMaps = manifest.textures.map(() => new THREE.Texture());
    const oldDisposals = oldMaps.map(t => vi.spyOn(t, 'dispose'));
    const nextMaps = manifest.textures.map(() => new THREE.Texture());
    const nextDisposals = nextMaps.map(t => vi.spyOn(t, 'dispose'));
    let attempts = 0;
    const load = createMiamiAssetLoader({
      manifest: async () => { attempts++; return manifest; },
      model: () => attempts === 1 ? Promise.reject(Error('GLB HTTP 503')) : retryModel.promise,
      texture: def => {
        const i = manifest.textures.findIndex(t => t.id === def.id);
        return attempts === 1 ? i === 9 ? lateOldHDR.promise : Promise.resolve(oldMaps[i]) : Promise.resolve(nextMaps[i]);
      },
    });
    await expect(load()).rejects.toThrow('GLB HTTP 503');
    const retry = load(); expect(load()).toBe(retry);
    await flushMicrotasks();
    lateOldHDR.reject(Error('late old HDR failure'));
    await flushMicrotasks();
    expect(load()).toBe(retry); expect(attempts).toBe(2);
    retryModel.resolve(source());
    const live = await retry;
    expect(await load()).toBe(live); nextDisposals.forEach(spy => expect(spy).not.toHaveBeenCalled());
    oldDisposals.slice(0, 9).forEach(spy => expect(spy).toHaveBeenCalledOnce()); expect(oldDisposals[9]).not.toHaveBeenCalled();
    live.dispose(); nextDisposals.forEach(spy => expect(spy).toHaveBeenCalledOnce());
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
    const pending = retry();
    const rejected = expect(pending).rejects.toThrow('photo'); // Observe the now-prompt failure immediately.
    await vi.waitFor(() => expect(late).toBeTypeOf('function')); late();
    await rejected; await flushMicrotasks(); expect(disposed).toHaveBeenCalledOnce();
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
