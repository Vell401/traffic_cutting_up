import { describe, expect, it } from 'vitest';
import { decodeWheelOmega, encodeWheelOmega, MAX_WIRE_WHEEL_OMEGA, WHEEL_TELEMETRY_BYTES } from '../src/online/wheelTelemetry';

describe('compact signed remote wheel presentation telemetry', () => {
  it('preserves rolling, reverse, a stopped wheel and high-speed burnout independently', () => {
    expect([80, -60, 0, 280.5].map(value => decodeWheelOmega(encodeWheelOmega(value)))).toEqual([80, -60, 0, 280.5]);
    expect(WHEEL_TELEMETRY_BYTES).toBe(8);
  });
  it('has at most half a quantization step of error in its usable range', () => {
    for (let i = -2000; i <= 2000; i += 7.137) {
      expect(Math.abs(decodeWheelOmega(encodeWheelOmega(i)) - i)).toBeLessThanOrEqual(1 / 32 + 1e-12);
    }
  });
  it('bounds malformed or excessive telemetry without overflow or NaN', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(encodeWheelOmega(value)).toBe(0);
    expect(decodeWheelOmega(encodeWheelOmega(1e9))).toBe(MAX_WIRE_WHEEL_OMEGA);
    expect(decodeWheelOmega(encodeWheelOmega(-1e9))).toBe(-MAX_WIRE_WHEEL_OMEGA);
  });
});
