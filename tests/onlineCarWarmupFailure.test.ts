import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '../src/render/playerView';
import type { View } from '../src/render/view';
import type { CarId } from '../src/sim/cars';
import { rendererHarness } from './rendererHarness';

// Use the real builders, readiness chains and warmup method; only HTTP and GPU work are replaced.
const files = { 1: 'porsche-911', 3: 'mercedes-a45s', 4: 'mercedes-w204' } as const;
const model = (): GLTF => {
  const scene = new THREE.Group();
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 4.6), new THREE.MeshStandardMaterial({ name: 'leather' }));
  cabin.name = 'warm-cabin'; scene.add(cabin);
  for (const corner of ['FL', 'FR', 'RL', 'RR']) {
    const wheel = new THREE.Group();
    wheel.name = `Wheel_${corner}`;
    wheel.position.set(corner[1] === 'L' ? -.8 : .8, .33, corner[0] === 'F' ? -1.3 : 1.3);
    scene.add(wheel);
  }
  return { scene, scenes: [scene], animations: [], cameras: [], asset: { version: '2.0' }, userData: {}, parser: {} } as unknown as GLTF;
};

type Harness = Pick<View, 'scene' | 'prepareOnlineCars'> & { playerView: PlayerView; remoteSpares: PlayerView[] };
let cleanup: (() => void)[];
let failFile: string | undefined;
let holdFile: string | undefined;
let release: (() => void) | undefined;
let requests: string[];

beforeEach(() => {
  vi.resetModules();
  // Exercise browser readiness rather than the Node-only instrument placeholder contract.
  vi.stubGlobal('window', {});
  cleanup = []; requests = []; failFile = holdFile = undefined; release = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((url, done, _progress, error) => {
    requests.push(url);
    const complete = () => {
      if (failFile && (failFile === '*' || url.includes(failFile))) error?.(new Error(`Download failed: ${failFile}`) as unknown as ErrorEvent);
      else done(model());
    };
    // Real loader callbacks run asynchronously, after every consumer has subscribed.
    if (holdFile && url.includes(holdFile)) release = complete;
    else queueMicrotask(complete);
  });
});

// Run the actual boot readiness call site without mounting the unrelated game/UI subsystems.
// The only stripped syntax is its CarId assertion; all branches and awaits are production code.
function bootCallsite(selectedCarDownload: Promise<void>, online: boolean, view: object, waitForCar: object) {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const marker = '// Boot readiness:';
  expect(source).toContain(marker);
  expect(source.indexOf('void selectedCarDownload.catch(() => {});')).toBeLessThan(source.indexOf('const view = new View('));
  const tail = source.slice(source.indexOf(marker)).replace('id as CarId', 'id');
  const run = new Function('loading', 'view', 'waitForCar', 'selectedCarDownload', 'ONLINE', 'report', 'location', 'console',
    `let showSelectedProgress = false; return (async () => { ${tail}\n })();`);
  const loading = { stage: vi.fn().mockResolvedValue(undefined), fail: vi.fn() };
  const reload = vi.fn(), report = vi.fn();
  // The real early boot observer is attached before View construction and before these awaits.
  void selectedCarDownload.catch(() => {});
  const done = run(loading, view, waitForCar, selectedCarDownload, online, report, { reload }, console) as Promise<void>;
  return { done, loading, reload, report };
}

describe('boot readiness call site', () => {
  it('reaches first-frame preparation when every optional imported model download fails', async () => {
    failFile = '*';
    const { view } = await harness();
    const { waitForCar } = await import('../src/render/car');
    const render = vi.fn(), prepareCar = vi.fn().mockResolvedValue(undefined);
    const boot = bootCallsite(Promise.resolve(), true, {
      prepareOnlineCars: () => view.prepareOnlineCars(), render, prepareCar,
    }, waitForCar);
    await expect(boot.done).resolves.toBeUndefined();
    expect(view.remoteSpares).toHaveLength(0);
    expect(requests).toHaveLength(0); // Boot no longer initiates any optional model download.
    expect(render).toHaveBeenCalledTimes(1);
    expect(prepareCar).toHaveBeenCalledTimes(1);
    expect(boot.loading.fail).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps a selected failure honest and retries only on the reload gesture (online=%s)', async online => {
    const view = { prepareOnlineCars: vi.fn(), render: vi.fn(), prepareCar: vi.fn() };
    const waitForCar = vi.fn();
    const boot = bootCallsite(Promise.reject(new Error('Selected model unavailable')), online, view, waitForCar);
    let completed = false;
    void boot.done.then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(boot.loading.fail).toHaveBeenCalledTimes(1);
    expect(boot.loading.fail).toHaveBeenCalledWith(expect.stringContaining('выбранный автомобиль'), expect.any(Function));
    expect(completed).toBe(false); // boot.ts cannot finish() over the failure screen.
    expect(waitForCar).not.toHaveBeenCalled();
    expect(view.prepareOnlineCars).not.toHaveBeenCalled();
    expect(view.render).not.toHaveBeenCalled();
    expect(boot.reload).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(boot.loading.fail).toHaveBeenCalledTimes(1);
    boot.loading.fail.mock.calls[0][1]();
    expect(boot.reload).toHaveBeenCalledTimes(1);
  });

  it('also explains selected attachment/preparation failure instead of completing a missing car', async () => {
    const view = { prepareOnlineCars: vi.fn(), render: vi.fn(), prepareCar: vi.fn().mockRejectedValue(new Error('Selected attachment failed')) };
    const boot = bootCallsite(Promise.resolve(), true, view, vi.fn().mockResolvedValue(undefined));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(boot.loading.fail).toHaveBeenCalledTimes(1);
    expect(boot.report).toHaveBeenCalledWith('error', 'Selected car startup preparation failed', 'Error: Selected attachment failed');
    expect(view.prepareCar).toHaveBeenCalledTimes(1);
  });
});

afterEach(async () => {
  for (const dispose of cleanup.reverse()) dispose();
  release?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function harness(car: CarId = 2) {
  const { PlayerView } = await import('../src/render/playerView');
  const { View } = await import('../src/render/view');
  const shadowTex = new THREE.Texture();
  const selected = new PlayerView(car, 0x123456, shadowTex, 4.6, 1.9);
  const renderer = rendererHarness();
  const view = Object.assign(Object.create(View.prototype), {
    playerView: selected, remoteSpares: [], shadowTex, renderer,
    playerViews: new Map([[car, { view: selected, length: 4.6, width: 1.9 }]]),
    carPreparations: new WeakMap(), preparedCars: new WeakSet(), sim: { player: { ghost: false } }, chase: { mode: 'bumper' },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
  }) as Harness;
  view.scene.add(selected.root);
  cleanup.push(() => { selected.dispose(); for (const spare of view.remoteSpares) spare.dispose(); shadowTex.dispose(); });
  return { view, selected, renderer, PlayerView };
}

describe('optional online car warmup failure', () => {
  it('warms real selected Porsche exterior/cockpit opaque/ghost materials after attachment and restores bumper state', async () => {
    const g = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : () => {}, set: () => true,
    });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => g }) });
    const { view, selected, renderer } = await harness(1);
    selected.root.visible = false; selected.setCockpit(false);
    const ghostStates: boolean[] = [], cockpitStates: boolean[] = [], materialTypes: string[] = [];
    const ghost = vi.spyOn(selected, 'setGhost'), cockpit = vi.spyOn(selected, 'setCockpit');
    renderer.render.mockImplementation(() => {
      expect(selected.body.children.length).toBeGreaterThan(0); expect(selected.root.visible).toBe(true);
      ghostStates.push(ghost.mock.lastCall![0]); cockpitStates.push(cockpit.mock.lastCall![0]);
      materialTypes.push(((selected.body.getObjectByName('warm-cabin') as THREE.Mesh).material as THREE.Material).type);
      selected.root.traverse(o => { expect(o.visible).toBe(true); expect(o.frustumCulled).toBe(false); });
    });
    await (view as unknown as View).prepareCar();
    expect(ghostStates).toEqual([false, true, false, true]); expect(cockpitStates).toEqual([false, false, true, true]);
    expect(materialTypes).toEqual(['MeshStandardMaterial', 'MeshStandardMaterial', 'MeshLambertMaterial', 'MeshLambertMaterial']);
    expect(selected.root.visible).toBe(false); expect(ghost).toHaveBeenLastCalledWith(false); expect(cockpit).toHaveBeenLastCalledWith(false);
    const material = (selected.body.getObjectByProperty('isMesh', true) as THREE.Mesh).material as THREE.Material;
    expect(material.opacity).toBe(material.userData.baseOpacity); expect(material.transparent).toBe(material.userData.baseTransparent);
    expect(material.depthWrite).toBe(material.userData.baseDepthWrite);
  });
  it.each([1, 3, 4] as const)('does not block the selected R34 when only model %i rejects', async id => {
    failFile = files[id];
    const { view, selected, renderer } = await harness();
    await expect(view.prepareOnlineCars()).resolves.toBeUndefined();
    expect(view.remoteSpares.map(spare => spare.car)).toEqual([1, 2, 3, 4].filter(car => car !== id));
    expect(renderer.compileAsync).toHaveBeenCalledTimes(3);
    expect(view.scene.children).toHaveLength(4);
    expect(selected.root.parent).toBe(view.scene);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`(${id})`), expect.any(Error));
    // Flush the formerly unhandled PlayerView/car-index .then() branches too.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('retries only the failed spare and retains the three already warmed bodies', async () => {
    failFile = files[4];
    const { view, renderer } = await harness();
    await view.prepareOnlineCars();
    const retained = [...view.remoteSpares];
    failFile = undefined;
    await view.prepareOnlineCars();
    expect(view.remoteSpares).toHaveLength(4);
    expect(view.remoteSpares.slice(0, 3)).toEqual(retained);
    expect(view.remoteSpares[3].body.children.length).toBeGreaterThan(0);
    expect(renderer.compileAsync).toHaveBeenCalledTimes(4);
    expect(requests.filter(url => url.includes(files[4]))).toHaveLength(2);
    expect(requests.filter(url => url.includes(files[1]))).toHaveLength(1);
  });

  it.each([1, 3, 4] as const)('exposes selected-model %i failure, then a fresh instance attaches on retry', async id => {
    failFile = files[id];
    const { view, selected, renderer, PlayerView } = await harness(id);
    const explanation = 'Download failed';
    await expect(selected.ready).rejects.toThrow(explanation);
    await expect(view.prepareOnlineCars()).rejects.toThrow(explanation);
    expect(view.remoteSpares).toHaveLength(0);
    expect(renderer.compileAsync).not.toHaveBeenCalled();
    selected.dispose();
    failFile = undefined;
    const retry = new PlayerView(id, 0x123456, new THREE.Texture(), 4.6, 1.9, false);
    cleanup.push(() => retry.dispose());
    await expect(retry.ready).resolves.toBeUndefined();
    expect(retry.body.children.length).toBeGreaterThan(0);
    expect(requests.filter(url => url.includes(files[id]))).toHaveLength(2);
  });

  it.each([1, 3, 4] as const)('cancels a disposed model %i waiter and does not attach its late result', async id => {
    holdFile = files[id];
    const { selected } = await harness(id);
    await Promise.resolve(); // W204 defers starting its loader by one microtask.
    const refresh = vi.spyOn(selected as unknown as { findWheelContacts(): void }, 'findWheelContacts');
    selected.setGhost(true);
    selected.dispose(); selected.dispose();
    await expect(selected.ready).rejects.toMatchObject({ name: 'AbortError' });
    const children = selected.body.children.length;
    release?.(); release = undefined;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(selected.root.parent).toBeNull();
    expect(selected.body.children).toHaveLength(children);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('removes a spare whose shader compilation fails and still warms subsequent models', async () => {
    const { view, renderer } = await harness();
    renderer.compileAsync.mockRejectedValueOnce(new Error('GPU compilation failed'));
    await expect(view.prepareOnlineCars()).resolves.toBeUndefined();
    expect(view.remoteSpares.map(spare => spare.car)).toEqual([2, 3, 4]);
    expect(view.scene.children).toHaveLength(4);
  });
});
/// <reference types="node" />
import { readFileSync } from 'node:fs';
