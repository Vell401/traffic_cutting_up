import { describe, expect, it } from 'vitest';
import { restoreTuning } from '../server/restoreTuning';
import { defaultTuning } from '../src/sim/tuning';

describe('migrate only the R34 preset without resetting other cars', () => {
  it('removes only the reverted R34 schema and preserves custom A45/Porsche/Grip/traffic', () => {
    const saved = { ...defaultTuning(), r34Revision: 1 };
    saved.cars['2'] = { powerKW: 330, mass: 1560, ...{ driftAngle: .61, driftBuild: 1.6 } };
    saved.cars['3'].powerKW = 700; saved.cars['3'].brakeDecel = 19;
    saved.cars['4'].powerKW = 500; saved.cars['4'].gripRear = 1.8;
    saved.cars['1'].powerKW = 440; saved.traffic.lanes[0] = [90,110];
    const before = structuredClone(saved), restored = restoreTuning(saved);
    expect(restored.r34Revision).toBe(4);
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
  it('upgrades the pre-rework schema while leaving every other saved car value untouched',()=>{
    const old=defaultTuning();delete old.r34Revision;
    old.cars['2']={powerKW:1000,mass:2500};old.cars['3'].mass=1700;old.cars['4'].brakeDecel=18;
    const before=structuredClone(old),restored=restoreTuning(old);
    expect(restored.r34Revision).toBe(4);expect(restored.cars['2']).toEqual(defaultTuning().cars['2']);
    for(const id of ['1','3','4'])expect(restored.cars[id]).toEqual(before.cars[id]);
    expect(restored.traffic).toEqual(before.traffic);expect(old).toEqual(before);
  });
  it('does not silently reset malformed or unknown future settings', () => {
    expect(() => restoreTuning({ ...defaultTuning(), r34Revision: 999 })).toThrow();
    expect(() => restoreTuning({ r34Revision: 1, cars: null })).toThrow();
    const bad = { ...defaultTuning(), r34Revision: 1 }; bad.cars['3'].powerKW = -1;
    expect(() => restoreTuning(bad)).toThrow();
  });
  it('upgrades only untouched revision-3 grip defaults, including when other R34 settings are customized', () => {
    const saved={...defaultTuning(),r34Revision:3};
    Object.assign(saved.cars['2'],{gripFront:1.16,gripRear:.93,longGrip:1.04,powerKW:480,steerAssist:.75});
    saved.cars['3'].powerKW=650;saved.cars['4'].mass=1500;saved.cars['5'].powerKW=520;
    saved.traffic.lanes[0]=[95,105];const before=structuredClone(saved);
    const restored=restoreTuning(saved);
    expect(restored.r34Revision).toBe(4);
    for(const key of ['gripFront','gripRear','longGrip'] as const)expect(restored.cars['2'][key]).toBe(defaultTuning().cars['2'][key]);
    expect(restored.cars['2'].powerKW).toBe(480);expect(restored.cars['2'].steerAssist).toBe(.75);
    for(const id of ['1','3','4','5'])expect(restored.cars[id]).toEqual(before.cars[id]);
    expect(restored.traffic).toEqual(before.traffic);expect(saved).toEqual(before);
    expect(restoreTuning(restored)).toEqual(restored);
  });
  it('preserves explicit revision-3 grip overrides and updates only the remaining old defaults', () => {
    const saved={...defaultTuning(),r34Revision:3};
    Object.assign(saved.cars['2'],{gripFront:1.4,gripRear:1.25,longGrip:1.04});
    const restored=restoreTuning(saved);
    expect(restored.cars['2'].gripFront).toBe(1.4);expect(restored.cars['2'].gripRear).toBe(1.25);
    expect(restored.cars['2'].longGrip).toBe(1.10);
  });
});
