import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { cloneInSlices } from '../src/render/car/clone';
import { revealMaterials, RemoteCar } from '../src/render/remoteCar';
import { ResolutionBudget } from '../src/render/resolution';
import { PlayerCar } from '../src/sim/vehicle';

describe('remote model preparation', () => {
  it('clones transforms/hierarchy but shares immutable GPU resources', async () => {
    const source = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.position.set(1, 2, 3); source.add(mesh);
    const copy = (await cloneInSlices(source, () => false))!;
    expect(copy).not.toBe(source);
    const child = copy.children[0] as THREE.Mesh;
    expect(child.position).toEqual(mesh.position);
    expect(child.geometry).toBe(mesh.geometry);
    expect(child.material).toBe(mesh.material);
    expect(await cloneInSlices(source, () => true)).toBeNull();
  });

  it('yields between short chunks and honours cancellation while waiting', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock += 3);
    try {
      const source = new THREE.Group();
      for (let i = 0; i < 10; i++) source.add(new THREE.Group());
      let cancelled = false, done = false;
      const task = cloneInSlices(source, () => cancelled).then(result => { done = true; return result; });
      await Promise.resolve(); expect(done).toBe(false);
      cancelled = true;
      await vi.runAllTimersAsync();
      expect(await task).toBeNull();
    } finally { spy.mockRestore(); vi.useRealTimers(); }
  });

  it('fades without touching other cars, changing transparency, or changing the shader cache key per driver', () => {
    const shared = new THREE.MeshStandardMaterial(); shared.userData.shared = true;
    const make = () => { const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(), shared)); return root; };
    const a = make(), b = make();
    const reveal = revealMaterials(a);
    reveal.value = .5;
    const material = (a.children[0] as THREE.Mesh).material as THREE.Material;
    expect(material).not.toBe(shared);
    expect(material.transparent).toBe(false);
    expect((b.children[0] as THREE.Mesh).material).toBe(shared);
    revealMaterials(b);
    expect(material.customProgramCacheKey()).toBe(((b.children[0] as THREE.Mesh).material as THREE.Material).customProgramCacheKey());
    expect(shared.onBeforeCompile.toString()).not.toContain('remoteReveal');
  });

  it('keeps a cheap silhouette visible without loading the detailed car', () => {
    const remote = new RemoteCar(3, 0xff0000, new THREE.Texture(), 4.6, 1.9);
    const car = new PlayerCar();
    remote.update(.016, car, new THREE.Vector3(10, 0, -5), .3, 400);
    expect(remote.root.position.x).toBe(10);
    expect(remote.root.children[0].visible).toBe(true);
    expect(remote.root.children[0].children.length).toBeLessThan(15);
    remote.dispose();
  });
});

describe('resolution budget', () => {
  const observe = (b: ResolutionBudget, frame = 50, cpu = 5, active = true) => {
    let changed = false;
    for (let i = 0; i < 51; i++) changed = b.observe(frame, cpu, active) || changed;
    return changed;
  };
  it('reduces persistent GPU-bound fill cost and stops at a bounded minimum', () => {
    const b = new ResolutionBudget(2);
    expect(observe(b)).toBe(true); expect(b.ratio).toBe(1.6);
    for (let i = 0; i < 20; i++) observe(b);
    expect(b.ratio).toBe(.75);
  });
  it('ignores loading, background tabs, isolated stalls, CPU load and normal framerates', () => {
    const b = new ResolutionBudget(2);
    expect(b.observe(1000, 5, true)).toBe(false);
    expect(observe(b, 50, 5, false)).toBe(false);
    expect(observe(b, 50, 45)).toBe(false);
    expect(observe(b, 16, 3)).toBe(false);
    expect(b.ratio).toBe(2);
  });
});
