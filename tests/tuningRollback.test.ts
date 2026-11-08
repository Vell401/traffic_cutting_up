import { describe, expect, it } from 'vitest';
import { restoreTuning } from '../server/restoreTuning';
import { defaultTuning } from '../src/sim/tuning';

describe('restore pre-R34-rework tuning without resetting other cars', () => {
  it('removes only the reverted R34 schema and preserves custom A45/Porsche/Grip/traffic', () => {
    const saved = { ...defaultTuning(), r34Revision: 1 };
    saved.cars['2'] = { powerKW: 330, mass: 1560, ...{ driftAngle: .61, driftBuild: 1.6 } };
    saved.cars['3'].powerKW = 700; saved.cars['3'].brakeDecel = 19;
    saved.cars['4'].powerKW = 500; saved.cars['4'].gripRear = 1.8;
    saved.cars['1'].powerKW = 440; saved.traffic.lanes[0] = [90,110];
    const before = structuredClone(saved), restored = restoreTuning(saved);
    expect(restored).not.toHaveProperty('r34Revision');
    expect(restored.cars['2']).toEqual(defaultTuning().cars['2']);
    for (const id of ['1','3','4']) expect(restored.cars[id]).toEqual(before.cars[id]);
    expect(restored.traffic).toEqual(before.traffic);
    expect(saved).toEqual(before);
  });
  it('keeps valid original settings unchanged and is idempotent', () => {
    const original = defaultTuning(); original.cars['3'].powerKW = 600;
    expect(restoreTuning(original)).toEqual(original);
    expect(restoreTuning(restoreTuning(original))).toEqual(original);
  });
  it('does not silently reset malformed or unknown future settings', () => {
    expect(() => restoreTuning({ ...defaultTuning(), r34Revision: 999 })).toThrow();
    expect(() => restoreTuning({ r34Revision: 1, cars: null })).toThrow();
    const bad = { ...defaultTuning(), r34Revision: 1 }; bad.cars['3'].powerKW = -1;
    expect(() => restoreTuning(bad)).toThrow();
  });
});
