import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { View } from '../src/render/view';
import { PlayerView } from '../src/render/playerView';
import type { CarId } from '../src/sim/cars';
import { rendererHarness } from './rendererHarness';

vi.mock('../src/render/playerView', async () => {
  const T = await import('three');
  return { PlayerView: class {
    readonly root = new T.Group();
    readonly body = this.root;
    readonly eye = null;
    ready = Promise.resolve();
    constructor(readonly car: CarId) {}
    get hasCockpit() { return this.car === 1; }
    ghost = false; cockpit = false;
    setPaint = vi.fn(); setHighBeam = vi.fn();
    setGhost = vi.fn((on: boolean) => { this.ghost = on; });
    setCockpit = vi.fn((on: boolean) => { this.cockpit = on; });
    dispose = vi.fn(() => this.root.removeFromParent());
  } };
});

function harness() {
  const current = new PlayerView(3, 0x123456, new THREE.Texture(), 4.6, 1.9);
  const scene = new THREE.Scene(); scene.add(current.root);
  const renderer = rendererHarness();
  const sim = { player: { tune: { length: 4.6, width: 1.9 }, ghost: false } };
  const playerViews = new Map([[3 as CarId, { view: current, length: 4.6, width: 1.9 }]]);
  const view = Object.assign(Object.create(View.prototype), {
    playerView: current, playerViews, carPreparations: new WeakMap(), preparedCars: new WeakSet(),
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
    expect(renderer.render).toHaveBeenCalledTimes(2); // Opaque and spawn-ghost first use.
    expect(renderer.compileAsync).toHaveBeenCalledTimes(2);
    view.setCar(1); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(6); // Both Porsche sets, opaque and ghost.
    view.setCar(3); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(6);
  });

  it('does not compile a superseded pending selection and allows preparing it on return', async () => {
    const { view, current, renderer } = harness();
    let attach!: () => void;
    Object.assign(current, { ready: new Promise<void>(resolve => { attach = resolve; }) });
    const task = view.prepareCar(); view.setCar(2); attach(); await task;
    expect(renderer.compileAsync).not.toHaveBeenCalled();
    view.setCar(3); await view.prepareCar();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(2);
  });

  it.each(['compile', 'draw'])('retries a failed %s, restores cockpit/ghost/bumper state, and does not rebuild an attached instance', async failure => {
    const { view, renderer, playerViews } = harness(); view.setCar(1);
    const player = playerViews.get(1)!.view;
    Object.assign(view, { chase: { mode: 'bumper' } }); player.root.visible = false;
    if (failure === 'draw') renderer.render.mockImplementationOnce(() => { throw new Error('upload'); });
    else renderer.compileAsync.mockRejectedValueOnce(new Error('upload'));
    await expect(view.prepareCar()).rejects.toThrow('upload');
    expect(player.root.visible).toBe(false);
    expect(player.setCockpit).toHaveBeenLastCalledWith(false); expect(player.setGhost).toHaveBeenLastCalledWith(false);
    await view.prepareCar(); expect(playerViews.get(1)!.view).toBe(player);
    expect(renderer.render).toHaveBeenCalledTimes(failure === 'draw' ? 5 : 4);
  });

  it('evicts immutable rejected attachment readiness so same-identity selection reconstructs it', async () => {
    const { view, current, playerViews } = harness();
    Object.assign(current, { ready: Promise.reject(new Error('attachment')) });
    await expect(view.prepareCar()).rejects.toThrow('attachment');
    view.setCar(3); expect(playerViews.get(3)!.view).not.toBe(current);
    expect(current.dispose).toHaveBeenCalledOnce(); await view.prepareCar();
  });

  it('does not reuse an unfinished preparation when switched away and back during compile', async () => {
    const { view, renderer } = harness(); let finish!: () => void;
    renderer.compileAsync.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const old = view.prepareCar(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    view.setCar(2); view.setCar(3);
    const retry = view.prepareCar(); expect(retry).not.toBe(old);
    finish(); await Promise.all([old, retry]);
    expect(renderer.render).toHaveBeenCalledTimes(2); // Superseded compile never draws.
    await view.prepareCar(); expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite in-flight variant programs with a live frame before compileAsync settles', async () => {
    const { view, renderer } = harness(); let finish!: () => void;
    renderer.compileAsync.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const task = view.prepareCar(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(() => view.render(1, 0)).not.toThrow();
    expect(renderer.render).not.toHaveBeenCalled();
    finish(); await task;
  });

  it('prepares online sources just once even when boot/reconnect callers overlap', async () => {
    const { view, renderer } = harness();
    const first = view.prepareOnlineCars(); expect(view.prepareOnlineCars()).toBe(first);
    await first; await view.prepareOnlineCars();
    expect(renderer.compileAsync).toHaveBeenCalledTimes(4);
    expect(renderer.render).toHaveBeenCalledTimes(4);
    expect(renderer.getRenderTarget).toHaveBeenCalledTimes(8); // Both compile and draw restore the target.
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
