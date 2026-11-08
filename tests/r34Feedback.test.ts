import { describe, expect, it } from 'vitest';
import { r34ChaseYaw, r34SmokeIntensity } from '../src/render/r34Feedback';

describe('R34 feedback reflects physical slip instead of hiding it', () => {
  it('leaves straight/reverse/standing framing unchanged', () => {
    expect(r34ChaseYaw(.3, 25, 0)).toBe(.3);
    expect(r34ChaseYaw(.3, 0, 0)).toBe(.3);
    expect(r34ChaseYaw(.3, -10, 2)).toBe(.3);
  });
  it('shows most chassis/travel separation in both directions, with bounded spin framing', () => {
    for (const sign of [-1, 1]) {
      const slip = sign * 25 * Math.PI / 180;
      const yaw = r34ChaseYaw(.5, 25, 25 * Math.tan(slip));
      expect(yaw - .5).toBeCloseTo(.7 * slip, 12);
      expect(Math.abs(r34ChaseYaw(.5, 3, sign * 40) - .5)).toBeLessThan(Math.PI / 3);
    }
  });
  it('emits stationary-wheelspin smoke but not free revs or ordinary rolling', () => {
    expect(r34SmokeIntensity(2, .1, 18)).toBe(1);
    expect(r34SmokeIntensity(2, 0, 0)).toBe(0);
    expect(r34SmokeIntensity(.02, 30, .1)).toBe(0);
  });
});
