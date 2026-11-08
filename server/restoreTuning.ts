import { defaultTuning, validateTuning, type GlobalTuning } from '../src/sim/tuning';

/** Read settings left by the reverted R34 release without resetting other cars to defaults. */
export function restoreTuning(value: unknown): GlobalTuning {
  const saved = structuredClone(value) as GlobalTuning & { r34Revision?: unknown };
  if (saved && typeof saved === 'object' && saved.r34Revision === 1) {
    if (!saved.cars || typeof saved.cars !== 'object') throw new Error('Invalid saved vehicle settings');
    delete saved.r34Revision;
    saved.cars['2'] = defaultTuning().cars['2'];
  }
  return validateTuning(saved);
}
