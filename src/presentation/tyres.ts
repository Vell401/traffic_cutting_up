import { G, clamp, smoothstep } from '../core/math';
import type { CarTune } from '../config';

/** Read-only presentation input; no physics methods, forces or serialized state are changed. */
export interface TyreFeedbackSource {
  readonly vx: number;
  readonly vy: number;
  readonly r: number;
  readonly steerAngle: number;
  readonly tune: Readonly<CarTune & {
    wheelRadius?: number; trackWidth?: number; cgHeight?: number; rollFront?: number;
    downforceFront?: number; downforceRear?: number;
  }>;
  readonly omega?: ArrayLike<number>;
  /** Observer-only four-wheel telemetry; overrides unstepped native omega on remote car instances.
   * Local cars have no overlay and use native omega directly.
   */
  readonly visualWheelOmega?: ArrayLike<number>;
  readonly omegaF?: number;
  readonly omegaR?: number;
}

export interface WheelTyreFeedback {
  /** Signed rad/s and m/s, in this wheel's forward/right contact frame. */
  omega: number;
  rollingSpeed: number;
  contactLongitudinal: number;
  contactLateral: number;
  /** rollingSpeed - contactLongitudinal; positive = forward wheelspin. */
  longitudinalSlipSpeed: number;
  lateralSlipSpeed: number;
  /** Estimated vertical load, N (presentation only, not a tyre force). */
  normalLoad: number;
  /** Both intensities are 0..1, instantaneous (consumers own any temporal smoothing). */
  slipIntensity: number;
  smokeIntensity: number;
}

export interface TyreFeedback {
  /** Nonnegative body speed, m/s. Wheel/contact speeds retain their signs. */
  speed: number;
  /** Stable FL, FR, RL, RR tuple. */
  wheels: [WheelTyreFeedback, WheelTyreFeedback, WheelTyreFeedback, WheelTyreFeedback];
  rollingIntensity: number;
  squealIntensity: number;
  /** Load × slip-speed proxy, N m/s; not simulated dissipated power. */
  slipPower: number;
}

function createWheel(): WheelTyreFeedback {
  return { omega: 0, rollingSpeed: 0, contactLongitudinal: 0, contactLateral: 0,
    longitudinalSlipSpeed: 0, lateralSlipSpeed: 0, normalLoad: 0, slipIntensity: 0, smokeIntensity: 0 };
}

export function createTyreFeedback(): TyreFeedback {
  return { speed: 0, wheels: [createWheel(), createWheel(), createWheel(), createWheel()],
    rollingIntensity: 0, squealIntensity: 0, slipPower: 0 };
}

const finite = (v: number | undefined, fallback = 0): number => Number.isFinite(v) ? v! : fallback;

/** Allocation-free and pure except for the caller-owned output buffer. No pedal/handbrake guesses. */
export function sampleTyreFeedback(car: TyreFeedbackSource, out: TyreFeedback): TyreFeedback {
  const t = car.tune;
  const vx = finite(car.vx), vy = finite(car.vy), yaw = finite(car.r);
  const radius = Math.max(.1, finite(t.wheelRadius, .34));
  const track = Math.max(.5, finite(t.trackWidth, t.width * .85));
  const a = t.cgToFront, b = t.cgToRear, length = Math.max(.5, a + b);
  const mg = Math.max(1, t.mass * G), height = finite(t.cgHeight, .45);
  // Legacy axle models keep lagged load telemetry TS-private. Read only when available;
  // do not require private members in the public structural input contract.
  const ax = 'axLag' in car && typeof car.axLag === 'number' ? finite(car.axLag) : 0;
  const ay = 'ayLag' in car && typeof car.ayLag === 'number' ? finite(car.ayLag) : 0;
  const transfer = clamp(t.mass * ax * height / length, -mg * .35, mg * .35);
  const frontLoad = Math.max(mg * .1, mg * b / length - transfer) + finite(t.downforceFront) * vx * vx;
  const rearLoad = Math.max(mg * .1, mg * a / length + transfer) + finite(t.downforceRear) * vx * vx;
  const lateralTransfer = t.mass * ay * height / track;
  const roll = clamp(finite(t.rollFront, .5), 0, 1);
  const cs = Math.cos(finite(car.steerAngle)), sn = Math.sin(finite(car.steerAngle));
  out.speed = Math.hypot(vx, vy);
  out.rollingIntensity = out.squealIntensity = out.slipPower = 0;
  for (let i = 0; i < 4; i++) {
    const w = out.wheels[i], front = i < 2, side = i % 2 === 0 ? -1 : 1;
    const u = vx - yaw * side * track * .5, v = vy + yaw * (front ? a : -b);
    w.contactLongitudinal = front ? u * cs + v * sn : u;
    w.contactLateral = front ? -u * sn + v * cs : v;
    // Observer telemetry overrides unstepped remote native wheels; local cars have no overlay.
    // Then use native wheels or legacy axle telemetry. Arcade has no wheel dynamics:
    // match the signed contact speed rather than inventing wheel lock from controls.
    const omega = car.visualWheelOmega?.[i] ?? car.omega?.[i] ?? (front ? car.omegaF : car.omegaR);
    w.omega = finite(omega, w.contactLongitudinal / radius);
    w.rollingSpeed = w.omega * radius;
    w.longitudinalSlipSpeed = w.rollingSpeed - w.contactLongitudinal;
    w.lateralSlipSpeed = w.contactLateral;
    const axle = front ? frontLoad : rearLoad;
    const lat = clamp(lateralTransfer * (front ? roll : 1 - roll), -axle * .48, axle * .48);
    w.normalLoad = Math.max(0, axle * .5 - side * lat);
    const load = clamp(w.normalLoad / (mg * .25), 0, 1.6);
    const slip = Math.hypot(w.longitudinalSlipSpeed, w.lateralSlipSpeed);
    const contactSpeed = Math.hypot(w.contactLongitudinal, w.contactLateral);
    w.slipIntensity = smoothstep((slip - .35 - contactSpeed * .018) / (2 + contactSpeed * .045)) * Math.min(1, load);
    w.smokeIntensity = smoothstep((slip - 2) / 10) * smoothstep((w.normalLoad * slip - 3500) / 35000);
    out.rollingIntensity += smoothstep(contactSpeed / 60) * Math.min(1, load) * .25;
    out.squealIntensity += w.slipIntensity * .25;
    out.slipPower += w.normalLoad * slip;
  }
  return out;
}
