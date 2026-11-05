/** Graphics quality presets, chosen in the menu and kept in localStorage. */
export type Quality = 'medium' | 'high';

export interface QualityPreset {
  /** Cap on devicePixelRatio. */
  pixelRatio: number;
  msaa: number;
  anisotropy: number;
  /** Road texture size (px, square). */
  roadTex: number;
  /** Overhead sign atlas resolution multiplier. */
  signScale: number;
  bloomLevels: number;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  medium: { pixelRatio: 1, msaa: 2, anisotropy: 4, roadTex: 1024, signScale: 1, bloomLevels: 4 },
  high: { pixelRatio: 2, msaa: 4, anisotropy: 16, roadTex: 2048, signScale: 2, bloomLevels: 6 },
};

const KEY = 'tcu.quality';

export function loadQuality(): Quality {
  try {
    return localStorage.getItem(KEY) === 'medium' ? 'medium' : 'high';
  } catch {
    return 'high';
  }
}

export function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}
