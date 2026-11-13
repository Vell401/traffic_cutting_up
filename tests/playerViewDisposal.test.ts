import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { PlayerView } from '../src/render/playerView';

it('disposes only the private blob shadow geometry exactly once, never model/shared geometry or its borrowed texture', async () => {
  const texture = new THREE.Texture(), view = new PlayerView(2, 0x3366ff, texture, 4.6, 1.9, true, true);
  await view.ready;
  const shadow = view.root.children[0].children[0] as THREE.Mesh;
  const own = vi.spyOn(shadow.geometry, 'dispose'), tex = vi.spyOn(texture, 'dispose');
  const shared: ReturnType<typeof vi.spyOn>[] = [];
  view.root.traverse(o => { const m = o as THREE.Mesh; if (m.geometry && m !== shadow) shared.push(vi.spyOn(m.geometry, 'dispose')); });
  expect(shared.length).toBeGreaterThan(0);
  view.dispose(); view.dispose();
  expect(own).toHaveBeenCalledOnce(); expect(tex).not.toHaveBeenCalled(); shared.forEach(s => expect(s).not.toHaveBeenCalled());
  texture.dispose();
});
