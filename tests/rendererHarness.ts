import * as THREE from 'three';
import { vi } from 'vitest';

/** Stateful GPU boundary: real scene traversal is asserted by each consumer. */
export function rendererHarness() {
  let target: THREE.WebGLRenderTarget | null = new THREE.WebGLRenderTarget(16, 16);
  const viewport = new THREE.Vector4(2, 3, 40, 50), scissor = new THREE.Vector4(4, 5, 20, 30);
  const color = new THREE.Color(0x123456);
  let alpha = .7, scissorTest = true;
  return {
    autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: false,
    xr: { enabled: true }, shadowMap: { autoUpdate: false },
    compileAsync: vi.fn(async (_scene?: THREE.Object3D, _camera?: THREE.Camera) => {}), render: vi.fn(), initTexture: vi.fn(),
    getRenderTarget: vi.fn(() => target),
    getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 1,
    setRenderTarget: vi.fn((value: THREE.WebGLRenderTarget | null) => { target = value; viewport.set(0, 0, 4, 4); scissor.set(0, 0, 4, 4); }),
    getViewport: (out: THREE.Vector4) => out.copy(viewport),
    setViewport: (v: THREE.Vector4 | number, y?: number, w?: number, h?: number) => typeof v === 'number' ? viewport.set(v, y!, w!, h!) : viewport.copy(v),
    getScissor: (out: THREE.Vector4) => out.copy(scissor),
    setScissor: (v: THREE.Vector4 | number, y?: number, w?: number, h?: number) => typeof v === 'number' ? scissor.set(v, y!, w!, h!) : scissor.copy(v),
    getScissorTest: () => scissorTest, setScissorTest: (value: boolean) => { scissorTest = value; },
    getClearColor: (out: THREE.Color) => out.copy(color), getClearAlpha: () => alpha,
    setClearColor: (value: THREE.ColorRepresentation, a = 1) => { color.set(value); alpha = a; },
  };
}
