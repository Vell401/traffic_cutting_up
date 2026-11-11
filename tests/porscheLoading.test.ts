import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildPorsche } from '../src/render/car/porsche';
import { PlayerView } from '../src/render/playerView';

vi.mock('../src/render/car/modelSource', () => ({
  ModelSource: class {
    ready = false;
    load() { return Promise.reject(new Error('model download failed')); }
  },
}));

describe('Porsche download failures', () => {
  it('rejects ready instead of pretending an empty body has loaded', async () => {
    const parts = buildPorsche(0xffffff, false, true, () => {});
    await expect(parts.ready).rejects.toThrow('model download failed');
    parts.dispose?.();
  });

  it('preserves rejection through PlayerView without an unhandled ghost-update promise', async () => {
    const view = new PlayerView(1, 0xffffff, new THREE.Texture(), 4.6, 1.9, false);
    await expect(view.ready).rejects.toThrow('model download failed');
    view.dispose();
  });
});
