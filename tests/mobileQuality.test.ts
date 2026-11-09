import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadQuality, QUALITY } from '../src/settings';

afterEach(() => vi.unstubAllGlobals());
describe('mobile does not silently sacrifice graphics', () => {
  it.each(['medium', 'high'] as const)('respects explicit %s even with a coarse phone pointer and high DPR', quality => {
    vi.stubGlobal('navigator', { maxTouchPoints: 10, userAgent: 'iPhone' });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('devicePixelRatio', 3);
    vi.stubGlobal('localStorage', { getItem: () => quality });
    expect(loadQuality()).toBe(quality);
    expect(QUALITY.high).toMatchObject({ pixelRatio: 2, msaa: 4, roadTex: 2048, anisotropy: 16 });
  });
});
