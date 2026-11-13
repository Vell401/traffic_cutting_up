import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteCar } from '../src/render/remoteCar';
import { View } from '../src/render/view';
import { PlayerCar } from '../src/sim/vehicle';
import { rendererHarness } from './rendererHarness';

const control = vi.hoisted(() => ({ fail: true, created: 0, disposed: 0 }));
vi.mock('../src/render/playerView', async () => {
  const T = await import('three');
  return { PlayerView: class {
    root = new T.Group();
    ready: Promise<void>;
    constructor() {
      control.created++;
      this.root.add(new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial()));
      this.ready = control.fail ? Promise.reject(new Error('network failed')) : Promise.resolve();
    }
    setPaint() {} update() {}
    dispose() { control.disposed++; this.root.removeFromParent(); }
  } };
});

beforeEach(() => {
  vi.useFakeTimers();
  control.fail = true; control.created = control.disposed = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const renderer = () => rendererHarness() as unknown as THREE.WebGLRenderer;

describe('remote car fallback and retries', () => {
  it('yields between actual lazy texture/geometry uploads, keeping the proxy until all batches finish', async () => {
    control.fail = false;
    const remote = new RemoteCar(1, 0xffffff, new THREE.Texture(), 4.6, 1.9), scene = new THREE.Scene(); scene.add(remote.root);
    const r = rendererHarness(); let draws = 0;
    r.render.mockImplementation(() => {
      draws++; remote.update(1, new PlayerCar(), new THREE.Vector3(), 0, 20);
      expect(remote.root.children[0].visible).toBe(true);
    });
    const task = remote.prepare(r as unknown as THREE.WebGLRenderer, new THREE.PerspectiveCamera(), scene);
    await vi.runAllTimersAsync(); await task;
    expect(draws).toBeGreaterThan(0);
    remote.update(1, new PlayerCar(), new THREE.Vector3(), 0, 20);
    expect(remote.root.children[0].visible).toBe(false); remote.dispose();
  });

  it('does not reveal or retain readiness when disposed during shader preparation', async () => {
    control.fail = false;
    const remote = new RemoteCar(1, 0xffffff, new THREE.Texture(), 4.6, 1.9), r = rendererHarness();
    let finish!: () => void;
    r.compileAsync.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const task = remote.prepare(r as unknown as THREE.WebGLRenderer, new THREE.PerspectiveCamera(), new THREE.Scene());
    await vi.runAllTimersAsync(); remote.dispose(); finish(); await vi.runAllTimersAsync(); await task;
    expect(r.render).not.toHaveBeenCalled(); expect(remote.root.children).toHaveLength(1);
  });

  it('retries an upload failure with a fresh detail while retaining the proxy and renderer state', async () => {
    control.fail = false;
    const remote = new RemoteCar(1, 0xffffff, new THREE.Texture(), 4.6, 1.9), scene = new THREE.Scene(); scene.add(remote.root);
    const r = rendererHarness(), target = r.getRenderTarget(); r.render.mockImplementationOnce(() => { throw new Error('upload'); });
    const failed = expect(remote.prepare(r as unknown as THREE.WebGLRenderer, new THREE.Camera(), scene)).rejects.toThrow('upload');
    await vi.runAllTimersAsync(); await failed;
    expect(remote.root.children).toHaveLength(1); expect(remote.root.children[0].visible).toBe(true);
    expect(r.getRenderTarget()).toBe(target);
    const retry = remote.prepare(r as unknown as THREE.WebGLRenderer, new THREE.Camera(), scene);
    await vi.runAllTimersAsync(); await retry;
    expect(control.created).toBe(2); expect(control.disposed).toBe(1); remote.dispose();
  });
  it('keeps the proxy visible after failure, then fades it only after a successful retry', async () => {
    const remote = new RemoteCar(1, 0xffffff, new THREE.Texture(), 4.6, 1.9);
    const proxy = remote.root.children[0];
    const first = remote.prepare(renderer(), new THREE.PerspectiveCamera(), new THREE.Scene());
    const rejected = expect(first).rejects.toThrow('network failed');
    await vi.runAllTimersAsync(); await rejected;
    remote.update(1, new PlayerCar(), new THREE.Vector3(), 0, 20);
    expect(proxy.visible).toBe(true);
    expect(remote.root.children).toHaveLength(1);
    expect(control.disposed).toBe(1);
    control.fail = false;
    const second = remote.prepare(renderer(), new THREE.PerspectiveCamera(), new THREE.Scene());
    await vi.runAllTimersAsync(); await second;
    remote.update(1, new PlayerCar(), new THREE.Vector3(), 0, 20);
    expect(control.created).toBe(2);
    expect(proxy.visible).toBe(false);
    expect(remote.root.children).toHaveLength(2);
    remote.dispose();
  });

  it('lets View retry after five seconds instead of hammering a failed URL every frame', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const car = new PlayerCar(); car.reset(100, 0, 30);
    const remoteViews = new Map();
    const view = Object.assign(Object.create(View.prototype), {
      time: 0, frame: 0, remoteViews, remoteQueue: Promise.resolve(),
      shadowTex: new THREE.Texture(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: renderer(),
      ptRemote: { x: 0, z: 0, th: 0, k: 0 }, v3: new THREE.Vector3(), ox: 0, oz: 0,
      sim: {
        remotes: [{ id: 7, carId: 1, color: 0xffffff, visible: true, car }],
        road: { toWorld(s: number, d: number, point: { x: number; z: number; th: number }) { point.x = d; point.z = -s; point.th = 0; } },
      },
    }) as { updateRemotes(alpha: number, dt: number, ownS: number): void; remoteQueue: Promise<void>; time: number };
    view.updateRemotes(1, .016, 100);
    await vi.runAllTimersAsync(); await view.remoteQueue;
    expect(remoteViews.get(7).prepared).toBe(false);
    expect(remoteViews.get(7).retryAt).toBe(5);
    view.time = 4.9;
    view.updateRemotes(1, .016, 100);
    await view.remoteQueue;
    expect(control.created).toBe(1);
    control.fail = false;
    view.time = 5;
    view.updateRemotes(1, .016, 100);
    await vi.runAllTimersAsync(); await view.remoteQueue;
    expect(control.created).toBe(2);
    expect(remoteViews.get(7).prepared).toBe(true);
    remoteViews.get(7).view.dispose();
  });
});
