import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { View } from '../src/render/view';
import { RoadView } from '../src/render/roadView';
import { QUALITY } from '../src/settings';
import { Road } from '../src/sim/road';
import { getMap } from '../src/sim/maps';
import { mulberry32 } from '../src/core/rng';
import { rendererHarness } from './rendererHarness';
import { renderDocument } from './renderCanvas';
import { makeSky } from '../src/render/sky';
import { extractMiamiAssets, loadMiamiAssets, type MiamiManifest } from '../src/render/miami/assets';

vi.mock('../src/render/miami/assets', async original => ({ ...await original<object>(), loadMiamiAssets: vi.fn() }));
beforeEach(() => vi.stubGlobal('document', renderDocument));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const manifest = JSON.parse(readFileSync('public/models/miami/manifest.json', 'utf8')) as MiamiManifest;
function assets() {
  const source = new THREE.Group();
  for (const p of manifest.prototypes) {
    const root = new THREE.Group(); root.name = p.name; source.add(root);
    for (const part of p.parts) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); mesh.name = part.name; root.add(mesh); }
  }
  return extractMiamiAssets(manifest, source, new Map(manifest.textures.map(t => [t.id, new THREE.Texture()])));
}
function harness(theme: 'miami' | 'highway') {
  const road = new Road(mulberry32(7), getMap(theme).script); road.ensure(0, 1800);
  const renderer = rendererHarness(); Object.assign(renderer, { initTexture: vi.fn(), shadowMap: { enabled: false } });
  const view = Object.assign(Object.create(View.prototype), {
    scene: new THREE.Scene(), renderer, camera: new THREE.PerspectiveCamera(),
    sim: { map: { theme }, road, player: { s: 300 } }, ox: 0, oz: 0, time: 0,
    roadView: new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, theme, theme === 'miami' ? 'assets' : 'legacy'),
    farGround: { setMiamiMaterial: vi.fn() }, sky: makeSky(), hemi: new THREE.HemisphereLight(), moon: new THREE.DirectionalLight(),
    skyId: 'miami-night', environmentGeneration: 0, environmentDisposed: false,
    makeMiamiEnvironment: vi.fn(a => ({ apply: vi.fn(), update: vi.fn(), dispose: vi.fn(), assets: a })),
  }) as View;
  view.scene.fog = new THREE.Fog(0, 70, 950);
  return { view, renderer };
}
describe('required environment readiness', () => {
  it('is a true no-op on Highway and preserves the default RoadView output/material path', async () => {
    const { view, renderer } = harness('highway'); await view.prepareEnvironment();
    expect(loadMiamiAssets).not.toHaveBeenCalled(); expect(renderer.compileAsync).not.toHaveBeenCalled();
    const r = new Road(mulberry32(7), getMap('highway').script); r.ensure(0, 500);
    const normal = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4);
    const explicit = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'highway');
    normal.update(r, 0, 499, 0, 0); explicit.update(r, 0, 499, 0, 0);
    for (let i = 0; i < normal.group.children.length; i++) {
      const x = normal.group.children[i].children as THREE.Mesh[], y = explicit.group.children[i].children as THREE.Mesh[];
      x.forEach((m, j) => { expect(m.geometry.getAttribute('position').array).toEqual(y[j].geometry.getAttribute('position').array);
        expect((m.material as THREE.MeshStandardMaterial).type).toBe((y[j].material as THREE.MeshStandardMaterial).type); });
    }
    normal.dispose(); explicit.dispose();
  });
  it('awaits attach, compile and actual uploads, coalesces, and retries required failures without releasing readiness early', async () => {
    const { view, renderer } = harness('miami'); const a = assets();
    let attach!: () => void, compiled!: () => void;
    vi.mocked(loadMiamiAssets).mockImplementationOnce(() => new Promise(resolve => { attach = () => resolve(a); }));
    renderer.compileAsync.mockImplementationOnce(() => new Promise<void>(resolve => { compiled = resolve; }));
    let ready = false; const pending = view.prepareEnvironment(); expect(view.prepareEnvironment()).toBe(pending);
    void pending.then(() => { ready = true; }); await Promise.resolve(); expect(ready).toBe(false);
    attach(); await vi.waitFor(() => expect(compiled).toBeTypeOf('function')); expect(ready).toBe(false); expect(renderer.render).not.toHaveBeenCalled();
    compiled(); await pending; expect(ready).toBe(true); expect(renderer.render).toHaveBeenCalled();
    const calls = renderer.compileAsync.mock.calls.length; await view.prepareEnvironment(); expect(renderer.compileAsync).toHaveBeenCalledTimes(calls);
    view.disposeEnvironment();
    const retry = harness('miami'); vi.mocked(loadMiamiAssets).mockRejectedValueOnce(Error('required')).mockImplementationOnce(async () => assets());
    await expect(retry.view.prepareEnvironment()).rejects.toThrow('required');
    await retry.view.prepareEnvironment(); expect(retry.renderer.render).toHaveBeenCalled(); retry.view.disposeEnvironment();
  });
  it('rejects late completion after cancellation without attaching resources or reporting success', async () => {
    const { view, renderer } = harness('miami'); const a = assets(), disposed = vi.spyOn(a, 'dispose');
    let complete!: () => void;
    vi.mocked(loadMiamiAssets).mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve(a); }));
    const pending = view.prepareEnvironment(); view.disposeEnvironment(); complete();
    await expect(pending).rejects.toThrow('cancelled'); expect(renderer.compileAsync).not.toHaveBeenCalled(); expect(disposed).toHaveBeenCalled();
  });
  it('a cancelled first consumer cannot free a coalesced completion before another live consumer claims it', async () => {
    const first = harness('miami'), second = harness('miami'), a = assets();
    let complete!: () => void;
    const shared = new Promise<ReturnType<typeof assets>>(r => { complete = () => r(a); });
    vi.mocked(loadMiamiAssets).mockImplementation(() => shared);
    const cancelled = first.view.prepareEnvironment(), active = second.view.prepareEnvironment();
    first.view.disposeEnvironment(); complete();
    const results = await Promise.allSettled([cancelled, active]);
    expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('fulfilled');
    expect(a.disposed).toBe(false); second.view.disposeEnvironment(); expect(a.disposed).toBe(true);
  });
  it('disposes its local shadow render target once as well as borrowed environment resources', () => {
    const { view } = harness('miami');
    const sun = (view as unknown as { moon: THREE.DirectionalLight }).moon;
    sun.shadow.map = new THREE.WebGLRenderTarget(16, 16); const dispose = vi.spyOn(sun.shadow.map, 'dispose');
    sun.castShadow = true; view.scene.add(sun.target);
    view.disposeEnvironment(); view.disposeEnvironment(); expect(dispose).toHaveBeenCalledOnce(); expect(sun.target.parent).toBeNull();
  });
  it('does not resolve cancelled compile/upload or reuse a rejected GPU preparation as readiness', async () => {
    const { view, renderer } = harness('miami'); vi.mocked(loadMiamiAssets).mockResolvedValueOnce(assets());
    renderer.render.mockImplementationOnce(() => { throw Error('world upload'); });
    await expect(view.prepareEnvironment()).rejects.toThrow('world upload');
    vi.mocked(loadMiamiAssets).mockResolvedValueOnce(assets());
    await view.prepareEnvironment(); expect(renderer.compileAsync.mock.calls.length).toBeGreaterThan(1); view.disposeEnvironment();
    const late = harness('miami'); vi.mocked(loadMiamiAssets).mockResolvedValueOnce(assets());
    let finish!: () => void;
    late.renderer.compileAsync.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const pending = late.view.prepareEnvironment(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    late.view.disposeEnvironment(); finish(); await expect(pending).rejects.toThrow('cancelled'); expect(late.renderer.render).not.toHaveBeenCalled();
  });
  it('supports the authored streetlight feet on a continuous outside-barrier walkway even over bay spans', () => {
    const r = new Road(mulberry32(7), getMap('miami').script); r.ensure(3000, 3200);
    const v = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami', 'assets'); v.update(r, 3000, 3099, 0, 0);
    v.group.updateMatrixWorld(true);
    const p = r.toWorld(3050, 14.2, { x: 0, z: 0, th: 0, k: 0 });
    const ray = new THREE.Raycaster(new THREE.Vector3(p.x, 2, p.z), new THREE.Vector3(0, -1, 0), 0, 4);
    const hit = ray.intersectObject(v.group.children[0].children[1], false)[0]; expect(hit?.point.y).toBeCloseTo(0, 3); v.dispose();
  });
  it('connects the flat marina boardwalk to the authored lower floating pontoon with an upward-facing gangway', () => {
    const r = new Road(mulberry32(7), getMap('miami').script); r.ensure(6000, 6300);
    const v = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami', 'assets'); v.update(r, 6100, 6199, 0, 0); v.group.updateMatrixWorld(true);
    const p = r.toWorld(6150, -98.5, { x: 0, z: 0, th: 0, k: 0 });
    const ray = new THREE.Raycaster(new THREE.Vector3(p.x, -6, p.z), new THREE.Vector3(0, -1, 0), 0, 2);
    const hit = ray.intersectObject(v.group.children[0].children[1], false)[0];
    expect(hit).toBeDefined(); expect(hit.point.y).toBeGreaterThan(-7.58); expect(hit.point.y).toBeLessThan(-7); expect(hit.face!.normal.y).toBeGreaterThan(0.9); v.dispose();
  });
  it('production scaffolding has no legacy city/trees/boats/lamps but keeps identical road positions, barrier prefix and anchors', () => {
    const r = new Road(mulberry32(7), getMap('miami').script); r.ensure(0, 1000);
    const old = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami');
    const fresh = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami', 'assets');
    old.update(r, 300, 399, 0, 0); fresh.update(r, 300, 399, 0, 0);
    const x = old.group.children[0].children as THREE.Mesh[], y = fresh.group.children[0].children as THREE.Mesh[];
    expect(y[3].visible).toBe(false); expect(y[0].geometry.getAttribute('position').array).toEqual(x[0].geometry.getAttribute('position').array);
    expect(y[1].geometry.getAttribute('position').array.slice(0, 2448)).toEqual(x[1].geometry.getAttribute('position').array.slice(0, 2448));
    const aa: unknown[] = [], bb: unknown[] = []; old.collectAnchors(300, 399, aa as never); fresh.collectAnchors(300, 399, bb as never); expect(bb).toEqual(aa);
    old.dispose(); fresh.dispose();
  });
});
