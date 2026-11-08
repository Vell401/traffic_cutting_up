import { defaultTuning, validateTuning, type GlobalTuning } from '../src/sim/tuning';

/** Replace only retired R34 presets. Never rebuild another car's saved settings from defaults. */
export function restoreTuning(value: unknown): GlobalTuning {
  const saved = structuredClone(value) as GlobalTuning & { r34Revision?: unknown };
  if (saved && typeof saved === 'object' && (saved.r34Revision === undefined || saved.r34Revision === 1 || saved.r34Revision === 2)) {
    if (!saved.cars || typeof saved.cars !== 'object') throw new Error('Invalid saved vehicle settings');
    saved.r34Revision = 3;
    saved.cars['2'] = defaultTuning().cars['2'];
  }
  return validateTuning(saved);
}
