import { describe, expect, it } from 'vitest';
import { defaultTuning, migrateR34Tuning } from '../src/sim/tuning';

describe('R34-only tune migration', () => {
  it('does not extend the legacy saved schemas with similarly named R34 controls',()=>{
    const defaults=defaultTuning();
    for(const id of ['1','3','4'])for(const key of ['driftAngle','driftBuild','driftRecover','counterSteer','yawResponse'])expect(defaults.cars[id]).not.toHaveProperty(key);
    expect(defaults.cars['2']).toMatchObject({driftAngle:.61,driftBuild:1.6,driftRecover:2.6,counterSteer:.85,yawResponse:9});
  });
  it('replaces the old sedan tune without changing customised A45, Porsche, Grip or traffic', () => {
    const legacy = defaultTuning(); delete legacy.r34Revision;
    legacy.cars['2'].powerKW = 1100; legacy.cars['2'].mass = 2500;
    legacy.cars['3'].powerKW = 800; legacy.cars['3'].brakeDecel = 19;
    legacy.cars['4'].powerKW = 600; legacy.cars['4'].gripRear = 1.8;
    legacy.cars['1'].powerKW = 440;
    legacy.traffic.lanes[0] = [90,110]; legacy.traffic.truckMax = 100;
    const original = structuredClone(legacy), upgraded = migrateR34Tuning(legacy);
    expect(upgraded.r34Revision).toBe(1);
    expect(upgraded.cars['2']).toEqual(defaultTuning().cars['2']);
    for (const id of ['1','3','4']) expect(upgraded.cars[id]).toEqual(original.cars[id]);
    expect(upgraded.traffic).toEqual(original.traffic); expect(legacy).toEqual(original);
  });
  it('does not reset custom R34 settings again after the one-time migration', () => {
    const next = defaultTuning(); next.cars['2'].powerKW = 650;
    expect(migrateR34Tuning(next)).toEqual(next);
  });
  it('rejects an unknown future revision rather than silently resetting other cars', () => {
    const next = defaultTuning(); next.r34Revision = 999;
    expect(() => migrateR34Tuning(next)).toThrow();
  });
});
