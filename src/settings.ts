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

/** A numbered start-menu choice (physics, traffic) kept in localStorage. */
function loadChoice<T extends number>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = Number(localStorage.getItem(key));
    return (allowed as readonly number[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

export const loadPhysics = (): 1 | 2 => loadChoice('tcu.physics', [1, 2] as const, 1);
export const savePhysics = (v: 1 | 2): void => saveChoice('tcu.physics', v);
export const loadTraffic = (): 1 | 2 => loadChoice('tcu.traffic', [1, 2] as const, 1);
export const saveTraffic = (v: 1 | 2): void => saveChoice('tcu.traffic', v);
export const loadCar = (): 1 | 2 => loadChoice('tcu.car', [1, 2] as const, 1);
export const saveCar = (v: 1 | 2): void => saveChoice('tcu.car', v);

/** Last camera mode used with each car (the cameras belong to the car). */
export function loadCameraMode(car: number): string {
  try {
    return localStorage.getItem(`tcu.cam.${car}`) ?? '';
  } catch {
    return '';
  }
}

export function saveCameraMode(car: number, mode: string): void {
  try {
    localStorage.setItem(`tcu.cam.${car}`, mode);
  } catch {
    /* storage unavailable */
  }
}

/** Online driver name. */
export function loadName(): string {
  try {
    return localStorage.getItem('tcu.name') ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem('tcu.name', name);
  } catch {
    /* storage unavailable */
  }
}
