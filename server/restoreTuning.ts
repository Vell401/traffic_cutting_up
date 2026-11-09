import { defaultTuning, validateTuning, type GlobalTuning } from '../src/sim/tuning';

/** Replace only retired R34 presets. Never rebuild another car's saved settings from defaults. */
export function restoreTuning(value: unknown): GlobalTuning {
  const saved = structuredClone(value) as GlobalTuning & { r34Revision?: unknown };
  if (saved && typeof saved === 'object' && (saved.r34Revision === undefined || saved.r34Revision === 1 || saved.r34Revision === 2)) {
    if (!saved.cars || typeof saved.cars !== 'object') throw new Error('Invalid saved vehicle settings');
    saved.r34Revision = 4;
    saved.cars['2'] = defaultTuning().cars['2'];
  }
  if (saved?.r34Revision === 3) {
    if (!saved.cars || typeof saved.cars !== 'object' || !saved.cars['2']) throw new Error('Invalid saved R34 settings');
    // Upgrade only untouched shipped grip values. Keep intentional per-field admin tuning
    // and all other R34 values, rather than replacing an existing customized preset.
    const oldGrip = { gripFront: 1.16, gripRear: .93, longGrip: 1.04 } as const;
    const current = defaultTuning().cars['2'];
    for (const key of Object.keys(oldGrip) as (keyof typeof oldGrip)[]) {
      if (saved.cars['2'][key] === oldGrip[key]) saved.cars['2'][key] = current[key];
    }
    saved.r34Revision = 4;
  }
  // Add the new car without discarding any existing vehicle's persisted tuning.
  if (saved?.cars && typeof saved.cars === 'object' && !Object.hasOwn(saved.cars, '5')) {
    saved.cars['5'] = defaultTuning().cars['5'];
  }
  return validateTuning(saved);
}
