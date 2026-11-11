import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSource, type ModelLoad } from '../src/render/car/modelSource';
import { preloadCar, waitForCar } from '../src/render/car';
import { loadPorsche } from '../src/render/car/porsche';

const gltf = (): GLTF => {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  return { scene } as GLTF;
};
afterEach(() => vi.restoreAllMocks());

describe('parsed model source cache', () => {
  it('coalesces requests, replays progress, and retains parsed geometry/textures after completion', async () => {
    const asset = gltf(), prepare = vi.fn();
    let done!: (asset: GLTF) => void, progress!: (event: ProgressEvent) => void;
    const loader = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, onLoad, onProgress) => {
      done = onLoad; progress = onProgress!;
    });
    const source = new ModelSource('test', '/test.glb', 100, prepare);
    const a: ModelLoad[] = [], b: ModelLoad[] = [], late: ModelLoad[] = [];
    const first = source.load(s => a.push(s)), second = source.load(s => b.push(s));
    expect(first).toBe(second);
    await Promise.resolve();
    progress({ loaded: 50, total: 0, lengthComputable: false } as ProgressEvent);
    const third = source.load(s => late.push(s));
    expect(third).toBe(first); expect(late[0]).toMatchObject({ loaded: 50, total: 100 });
    progress({ loaded: 100, total: 100, lengthComputable: true } as ProgressEvent);
    done(asset);
    expect(await first).toBe(asset.scene);
    expect(source.ready).toBe(true); expect(prepare).toHaveBeenCalledTimes(1);
    for (const events of [a, b, late]) {
      expect(events.some(s => s.unpacking)).toBe(true);
      expect(events.at(-1)).toMatchObject({ loaded: 100, done: true, failed: false });
    }
    const replay: ModelLoad[] = [];
    expect(await source.load(s => { replay.push(s); s.loaded = -1; })).toBe(asset.scene);
    expect(await source.load()).toBe(asset.scene);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a.at(-1)!.loaded).toBe(100); expect(replay).toHaveLength(1);
    expect((asset.scene.children[0] as THREE.Mesh).material).toHaveProperty('userData.shared', true);
  });

  it.each(['callback', 'synchronous', 'preparation'] as const)('retries a %s failure instead of caching a rejection', async failure => {
    const asset = gltf();
    const loader = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementationOnce((_url, done, _progress, fail) => {
      if (failure === 'synchronous') throw new Error('offline');
      if (failure === 'callback') fail!(new Error('offline') as unknown as ErrorEvent);
      else done(asset);
    }).mockImplementation((_url, done) => done(asset));
    const prepare = vi.fn(() => {});
    if (failure === 'preparation') prepare.mockImplementationOnce(() => { throw new Error('offline'); });
    const source = new ModelSource('test', '/test.glb', 100, prepare), events: ModelLoad[] = [];
    await expect(source.load(s => events.push(s))).rejects.toThrow('offline');
    expect(events.at(-1)).toMatchObject({ failed: true, done: false, unpacking: false });
    expect(source.ready).toBe(false);
    const eventCount = events.length;
    expect(await source.load()).toBe(asset.scene);
    expect(events).toHaveLength(eventCount); // Failed-attempt subscribers have been released.
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('handles compressed response lengths without progress above 100%', async () => {
    vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, done, progress) => {
      progress!({ loaded: 20, total: 20, lengthComputable: true } as ProgressEvent); done(gltf());
    });
    const events: ModelLoad[] = [];
    await new ModelSource('compressed', '/test.glb', 100).load(s => events.push(s));
    expect(events.at(-1)).toMatchObject({ loaded: 20, total: 20, done: true });
    expect(events.every(s => s.loaded <= s.total)).toBe(true);
  });
});

describe('car preload adapters', () => {
  it('reuses Porsche preload progress for late callers and the parsed source for future selections', async () => {
    let done!: (asset: GLTF) => void;
    const loader = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, onLoad) => { done = onLoad; });
    const first = loadPorsche(() => {}), replay: ModelLoad[] = [];
    expect(loadPorsche(s => replay.push(s))).toBe(first);
    expect(replay[0].total).toBe(11_139_228);
    await Promise.resolve(); done(gltf()); await first;
    expect(replay.at(-1)!.done).toBe(true);
    await loadPorsche(() => {});
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('shares A45 menu/boot requests, settles failures and permits retry without a new request after success', async () => {
    const loader = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementationOnce((_url, _done, _progress, fail) => {
      fail!(new Error('offline') as unknown as ErrorEvent);
    }).mockImplementation((_url, done) => done(gltf()));
    preloadCar(3);
    await expect(waitForCar(3)).rejects.toThrow('offline');
    const progress = vi.fn();
    await Promise.all([waitForCar(3, progress), waitForCar(3)]);
    expect(progress).toHaveBeenLastCalledWith(1, false);
    await waitForCar(3); preloadCar(3);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
