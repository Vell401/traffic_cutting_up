/** Remote wheel speeds are presentation telemetry, never authoritative owner state.
 * Four signed int16 values add 8 bytes per remote driver. 1/16 rad/s resolution
 * preserves reverse, independent locking and burnout without full-precision spam. */
export const WHEEL_OMEGA_SCALE = 16;
export const WHEEL_TELEMETRY_BYTES = 8;
export const MAX_WIRE_WHEEL_OMEGA = 32767 / WHEEL_OMEGA_SCALE;

export function encodeWheelOmega(omega: number): number {
  if (!Number.isFinite(omega)) return 0;
  return Math.max(-32767, Math.min(32767, Math.round(omega * WHEEL_OMEGA_SCALE)));
}

export function decodeWheelOmega(value: number): number {
  return value / WHEEL_OMEGA_SCALE;
}
