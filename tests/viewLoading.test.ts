import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { View } from '../src/render/view';
import { PlayerView } from '../src/render/playerView';
import type { CarId } from '../src/sim/cars';

vi.mock('../src/render/playerView', async () => {
  const T = await import('three');
  return { PlayerView: class {
    readonly root = new T.Group();
    readonly body = this.root;
    readonly eye = null;
    ready = Promise.resolve();
    constructor(readonly car: CarId) {}
    get hasCockpit() { return this.car === 1; }
    setPaint = vi.fn(); setGhost = vi.fn(); setHighBeam = vi.fn(); setCockpit = vi.fn();
    dispose = vi.fn(() => this.root.removeFromParent());
  } };
});

function harness() {
  const current = new PlayerView(3, 0x123456, new THREE.Texture(), 4.6, 1.9);
  const scene = new THREE.Scene(); scene.add(current.root);
  const renderer = {
    compileAsync: vi.fn(async () => {}), render: vi.fn(),
    getRenderTarget: vi.fn(() => null), setRenderTarget: vi.fn(),
  };
  const sim = { player: { tune: { length: 4.6, width: 1.9 }, ghost: false } };
  const playerViews = new Map([[3 as CarId, { view: current, length: 4.6, width: 1.9 }]]);
  const view = Object.assign(Object.create(View.prototype), {
    playerView: current, playerViews, carPreparations: new WeakMap(),
    remoteSpares: [], onlinePreparation: null, paint: 0x123456, highBeam: false,
    scene, renderer, sim, shadowTex: new THREE.Texture(), camera: new THREE.PerspectiveCamera(),
    tyreEffects: { resetTrails: vi.fn() },
    chase: { mode: 'chase', setRig: vi.fn(() => 'chase') },
  }) as View;
  return { view, current, playerViews, scene, renderer, sim };
}

describe('view car residency and preparation', () => {
  it('reuses a bounded car instance and its materials instead of disposing/rebuilding after every menu choice', () => {
    const { view, current, playerViews, scene } = harness();
    const dispose = vi.spyOn(current, 'dispose');
    view.setCar(2);
    const second = playerViews.get(2)!.view;
    expect(current.root.parent).toBeNull(); expect(second.root.parent).toBe(scene);
    view.setPaint(0xff0000); view.setHighBeam(true);
    view.setCar(3);
    expect(playerViews.get(3)!.view).toBe(current);
    expect(current.root.parent).toBe(scene); expect(second.root.parent).toBeNull();
    expect(current.setPaint).toHaveBeenLastCalledWith(0xff0000);
    expect(current.setHighBeam).toHaveBeenLastCalledWith(true);
    expect(dispose).not.toHaveBeenCalled(); expect(playerViews.size).toBe(2);
    for (const id of [1, 2, 3, 4, 1, 2, 3, 4] as CarId[]) view.setCar(id);
    expect(playerViews.size).toBe(4);
    expect(scene.children).toHaveLength(1); // Old headlights/objects are detached too.
  });

  it('invalidates a cached car when its tuned dimensions have changed', () => {
    const { view, current, sim, playerViews } = harness();
    view.setCar(2); sim.player.tune.length = 5;
    view.setCar(3);
    expect(current.dispose).toHaveBeenCalledTimes(1);
    expect(playerViews.get(3)!.view).not.toBe(current);
    expect(playerViews.get(3)!.length).toBe(5);
  });

  it('waits for attachment, coalesces compiles, and skips already-prepared cached cars', async () => {
    const { view, current, renderer } = harness();
    let attach!: () => void;
    Object.assign(current, { ready: new Promise<void>(resolve => { attach = resolve; }) });
    const task = view.prepareCar(); expect(view.prepareCar()).toBe(task);
    await Promise.resolve(); expect(renderer.compileAsync).not.toHaveBeenCalled();
    attach(); await task;
    expect(renderer.compileAsync).toHaveBeenCalledTimes(1);
    view.setCar(1); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(3); // Both Porsche material sets.
    view.setCar(3); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(3);
  });

  it('does not compile a superseded pending selection and allows preparing it on return', async () => {
    const { view, current, renderer } = harness();
    let attach!: () => void;
    Object.assign(current, { ready: new Promise<void>(resolve => { attach = resolve; }) });
    const task = view.prepareCar(); view.setCar(2); attach(); await task;
    expect(renderer.compileAsync).not.toHaveBeenCalled();
    view.setCar(3); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(1);
  });

  it('prepares online sources just once even when boot/reconnect callers overlap', async () => {
    const { view, renderer } = harness();
    const first = view.prepareOnlineCars(); expect(view.prepareOnlineCars()).toBe(first);
    await first; await view.prepareOnlineCars();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(4);
    expect(renderer.render).toHaveBeenCalledTimes(4);
    expect(renderer.getRenderTarget).toHaveBeenCalledTimes(4);
  });

  it('cleans up failed online warm-up instances and retries without duplicates', async () => {
    const { view, renderer, scene } = harness();
    renderer.compileAsync.mockRejectedValueOnce(new Error('compile'));
    await expect(view.prepareOnlineCars()).resolves.toBeUndefined();
    expect(scene.children).toHaveLength(4); // The other three optional bodies still warm successfully.
    await view.prepareOnlineCars();
    expect(scene.children).toHaveLength(5);
    expect(renderer.compileAsync).toHaveBeenCalledTimes(5);
  });
});
