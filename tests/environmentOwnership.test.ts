import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { View } from '../src/render/view';
import { QUALITY } from '../src/settings';
import { Sim } from '../src/sim/world';
import { mulberry32 } from '../src/core/rng';
import { renderDocument } from './renderCanvas';

const boundary = vi.hoisted(() => ({ capture: vi.fn(), dispose: vi.fn() }));
vi.mock('three', async original => {
  const T = await original<typeof THREE>();
  return { ...T,
    WebGLRenderer: class {
      info = { autoReset: true }; capabilities = { getMaxAnisotropy: () => 4 };
      setPixelRatio() {} getPixelRatio() { return 1; } setSize() {}
    },
    PMREMGenerator: class { fromScene = boundary.capture; dispose = boundary.dispose; },
  };
});
// Postprocessing is the other GPU boundary, not part of PMREM source ownership.
vi.mock('../src/render/post', () => ({ Post: class { setSize() {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.capture.mockReset(); boundary.dispose.mockReset(); });

it.each([false, true])('ends temporary room geometry/material/instance lifetimes on capture success/failure (%s), keeping the output alive', fail => {
  vi.stubGlobal('document', renderDocument);
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener: () => {} });
  const output = new THREE.WebGLRenderTarget(256,256), outputDispose = vi.spyOn(output, 'dispose'), texDispose = vi.spyOn(output.texture, 'dispose');
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh>();
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  boundary.capture.mockImplementation((room: RoomEnvironment, sigma: number) => {
    expect(room).toBeInstanceOf(RoomEnvironment); expect(sigma).toBe(.04);
    room.traverse(o => {
      if (!(o as THREE.Mesh).isMesh) return;
      const m = o as THREE.Mesh; resources.add(m.geometry); resources.add(m.material as THREE.Material);
      if ((o as THREE.InstancedMesh).isInstancedMesh) resources.add(o as THREE.InstancedMesh);
    });
    for (const r of resources) spies.push(vi.spyOn(r, 'dispose'));
    if (fail) throw new Error('capture failed');
    return output;
  });
  if (fail) expect(() => new View({} as HTMLCanvasElement, new Sim(mulberry32(7)), QUALITY.medium, 2)).toThrow('capture failed');
  else {
    const v = new View({} as HTMLCanvasElement, new Sim(mulberry32(7)), QUALITY.medium, 2);
    expect(v.scene.environment).toBe(output.texture); expect(v.scene.environmentIntensity).toBe(.12);
  }
  expect(resources.size).toBe(10); spies.forEach(s => expect(s).toHaveBeenCalledOnce());
  expect(boundary.dispose).toHaveBeenCalledOnce(); expect(outputDispose).not.toHaveBeenCalled(); expect(texDispose).not.toHaveBeenCalled();
  output.dispose();
});
