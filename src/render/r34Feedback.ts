import { clamp } from '../core/math';

/** R34 chase framing blends toward actual travel, without touching the simulated chassis yaw. */
export function r34ChaseYaw(bodyYaw: number, vx: number, vy: number): number {
  const movingForward = clamp((vx - 2) / 8, 0, 1);
  const slip = clamp(Math.atan2(vy, Math.max(vx, .1)), -Math.PI / 3, Math.PI / 3);
  return bodyYaw + .7 * movingForward * slip;
}

/** Tyre scrub includes wheel overspeed: a stationary burnout must not disappear visually. */
export function r34SmokeIntensity(slip: number, speed: number, wheelOverspeed: number): number {
  return Math.min(1, Math.max(0, (slip - .1) / .5))
    * Math.min(1, Math.hypot(speed, wheelOverspeed) / 4);
}
