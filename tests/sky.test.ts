import { describe, expect, it } from 'vitest';
import { HORIZON, SKY_PRESETS, applySky, makeSky, skyPreset, skySwatch } from '../src/render/sky';

describe('sky presets', () => {
  it('has distinct presets, the night one first (the default), and falls back to it', () => {
    expect(SKY_PRESETS[0].id).toBe('night');
    expect(new Set(SKY_PRESETS.map((p) => p.id)).size).toBe(SKY_PRESETS.length);
    expect(skyPreset('no-such-sky').id).toBe('night');
    for (const p of SKY_PRESETS) expect(skySwatch(p)).toMatch(/^linear-gradient\(180deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 72%, #[0-9a-f]{6} 100%\)$/);
  });

  it('repaints the dome, the stars and the shared horizon colour', () => {
    const sky = makeSky();
    const neon = skyPreset('neon');
    applySky(sky, neon);
    expect(HORIZON.getHex()).toBe(neon.horizon);
    const dome = sky.getObjectByName('sky/dome') as unknown as { material: { uniforms: { top: { value: { getHex(): number } }; glow: { value: { getHex(): number } } } } };
    expect(dome.material.uniforms.top.value.getHex()).toBe(neon.top);
    expect(dome.material.uniforms.glow.value.getHex()).toBe(neon.glow);
    applySky(sky, skyPreset('night'));
    expect(HORIZON.getHex()).toBe(0x1c1a2c);
  });
});
