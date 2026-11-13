import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { prepareObject, prepareObjectBatched } from '../src/render/prepareObject';
import { rendererHarness } from './rendererHarness';

describe('offscreen object preparation', () => {
  it.each([false, true])('draws hidden/non-culled attached resources after compilation and restores state (draw throws=%s)', async throws => {
    const r = rendererHarness(), scene = new THREE.Scene(), root = new THREE.Group(), camera = new THREE.PerspectiveCamera();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    hidden.visible = false; root.visible = false; root.add(hidden); scene.add(root);
    const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(other);
    const oldTarget = r.getRenderTarget();
    const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    let compiled = false;
    r.compileAsync.mockImplementation(async (s) => {
      expect(s).toBe(scene); // An attached root + targetScene would count its headlights twice in Three.
      expect(r.getRenderTarget()?.width).toBe(4); // Compile the same output variant that will be drawn.
      expect(root.parent).toBe(scene); expect(root.visible && hidden.visible).toBe(true); compiled = true;
    });
    r.render.mockImplementation((s, c) => {
      expect(compiled).toBe(true); expect(s).toBe(scene); expect(c).toBe(camera);
      expect(root.visible && hidden.visible).toBe(true); expect(hidden.frustumCulled).toBe(false);
      expect(other.visible).toBe(false); expect(r.getRenderTarget()).not.toBe(oldTarget);
      expect(r.getScissorTest()).toBe(false); expect(r.xr.enabled).toBe(false);
      if (throws) throw new Error('upload');
    });
    const task = prepareObject(r as unknown as THREE.WebGLRenderer, scene, camera, root);
    if (throws) await expect(task).rejects.toThrow('upload'); else await task;
    expect(r.render).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); dispose.mockRestore();
    expect(r.getRenderTarget()).toBe(oldTarget); expect(r.setRenderTarget).toHaveBeenLastCalledWith(oldTarget, 2, 1);
    expect(r.getViewport(new THREE.Vector4()).toArray()).toEqual([2, 3, 40, 50]);
    expect(r.getScissor(new THREE.Vector4()).toArray()).toEqual([4, 5, 20, 30]);
    expect(r.getScissorTest()).toBe(true); expect(r.getClearColor(new THREE.Color()).getHex()).toBe(0x123456);
    expect(r.getClearAlpha()).toBe(.7); expect(r.autoClear).toBe(false); expect(r.xr.enabled).toBe(true);
    expect(root.visible || hidden.visible).toBe(false); expect(hidden.frustumCulled).toBe(true); expect(other.visible).toBe(true);
  });

  it('does not mutate draw state or draw when shader compilation rejects', async () => {
    const r = rendererHarness(); r.compileAsync.mockRejectedValueOnce(new Error('shader'));
    const scene = new THREE.Scene(), root = new THREE.Group(), target = r.getRenderTarget(); root.visible = false; root.layers.mask = 4; scene.add(root);
    await expect(prepareObject(r as unknown as THREE.WebGLRenderer, scene, new THREE.Camera(), root)).rejects.toThrow('shader');
    expect(r.render).not.toHaveBeenCalled(); expect(r.getRenderTarget()).toBe(target);
    expect(root.visible).toBe(false); expect(root.frustumCulled).toBe(true); expect(root.layers.mask).toBe(4);
  });

  it('uploads textures individually and yields between bounded mesh draws, including nested meshes', async () => {
    vi.useFakeTimers();
    try {
      const r = rendererHarness(), scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
      const meshes: THREE.Mesh[] = [];
      for (let i = 0; i < 17; i++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
        (i === 16 ? meshes[7] : root).add(mesh); meshes.push(mesh);
      }
      const turns: string[] = [], drawn = new Set<THREE.Object3D>();
      r.initTexture.mockImplementation(() => { turns.push('texture'); setTimeout(() => turns.push('yield'), 0); });
      const camera = new THREE.Camera();
      r.render.mockImplementation(() => {
        let count = 0;
        scene.traverseVisible(o => { if ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers)) { drawn.add(o); count++; } });
        expect(count).toBeLessThanOrEqual(8); turns.push('draw'); setTimeout(() => turns.push('yield'), 0);
      });
      const task = prepareObjectBatched(r as unknown as THREE.WebGLRenderer, scene, camera, root, () => true);
      await vi.runAllTimersAsync(); await task;
      expect(r.initTexture).toHaveBeenCalledTimes(17); expect(r.render).toHaveBeenCalledTimes(3);
      expect(drawn.size).toBe(17); expect(turns.slice(0, 4)).toEqual(['texture', 'yield', 'texture', 'yield']);
      expect(turns.slice(-6)).toEqual(['draw', 'yield', 'draw', 'yield', 'draw', 'yield']);
    } finally { vi.useRealTimers(); }
  });

  it('serializes overlapping compile/draw jobs on one renderer without holding mutated state across awaits', async () => {
    const r = rendererHarness(), scene = new THREE.Scene(), root = new THREE.Group(), camera = new THREE.Camera(); scene.add(root);
    const previous = r.getRenderTarget(); let finish!: () => void;
    const order: string[] = [];
    r.compileAsync.mockImplementationOnce(() => { order.push('compile1'); return new Promise<void>(resolve => { finish = resolve; }); });
    r.compileAsync.mockImplementationOnce(async () => { order.push('compile2'); });
    r.render.mockImplementation(() => { order.push('draw'); });
    const first = prepareObject(r as unknown as THREE.WebGLRenderer, scene, camera, root);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const second = prepareObject(r as unknown as THREE.WebGLRenderer, scene, camera, root);
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['compile1']); expect(r.getRenderTarget()).toBe(previous);
    finish(); await Promise.all([first, second]); expect(order).toEqual(['compile1', 'draw', 'compile2', 'draw']);
  });
});
