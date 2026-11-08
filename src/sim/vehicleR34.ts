import { carTune, ROAD_HALF, type CarTune } from '../config';
import { G, clamp } from '../core/math';
import { PlayerCar, manualPowerShare, type DriveInput } from './vehicle';

/** R34-only reduced-order handling; deliberately independent of DriftCar and its presets. */
export type R34Tune = CarTune & {
  torqueNm: number;
  driveEff: number;
  engineBrakeNm: number;
  brakeAssist: number;
  brakeFront: number;
  longGrip: number;
  frontDrive: number;
  escAssist: number;
  lsdLock: number;
  /** Full-power, neutral-wheel rear slip equilibrium, radians (not a forced heading). */
  driftAngle: number;
  /** Rear breakaway / power-oversteer response, 1/s. */
  driftBuild: number;
  /** Tyre reattachment on lift, 1/s. */
  driftRecover: number;
  /** Opposite steering's authority over the rear slip, rad/s at full input. */
  counterSteer: number;
  /** Body yaw response, 1/s. */
  yawResponse: number;
};

/** Mutable, independent object for the debug panel and authoritative global tuning. */
export const r34Tune: R34Tune = {
  ...carTune,
  gearTopKmh: [67, 109, 154, 204, 259, 315],
  mass: 1560,
  length: 4.6,
  width: 1.79,
  cgToFront: 1.25,
  cgToRear: 1.415,
  powerKW: 330,
  torqueNm: 530,
  driveEff: .89,
  engineBrakeNm: 55,
  gripFront: 1.17,
  gripRear: 1.1,
  longGrip: 1.06,
  frontDrive: 0,
  tractionControl: .18,
  escAssist: .65,
  lsdLock: .9,
  brakeDecel: 10.5,
  brakeAssist: 1.5,
  brakeFront: .64,
  aeroDrag: .47,
  rollingRes: 9,
  maxSteerLow: .6,
  steerGripScale: 1.12,
  steerRate: 9,
  steerReturn: 16,
  yawAssist: 0,
  redline: 8000,
  idleRpm: 900,
  shiftTime: .16,
  driftAngle: .61,
  driftBuild: 1.6,
  driftRecover: 2.6,
  counterSteer: .85,
  yawResponse: 9,
};

const smooth = (lo: number, hi: number, x: number): number => {
  const u = clamp((x - lo) / (hi - lo), 0, 1);
  return u * u * (3 - 2 * u);
};

/**
 * Casual RWD bicycle. Speed, body yaw and rear slip have separate dynamics. Rear breakaway is
 * excited by steering under power (or the handbrake); the saturating rear-tyre moment gives a
 * broad, stable power slide instead of an unstable spin. Countersteer opposes that moment and
 * lifting restores grip progressively. We never target psi, the road curvature or a stored drift
 * direction: the driver still chooses the trajectory, and collisions may freely alter velocity.
 *
 * This is intentionally a game handling model, not the four-contact simulation used by A45/GT3.
 */
export class R34Car extends PlayerCar {
  override readonly physicsId = 2;
  declare readonly tune: R34Tune;
  /** Rear tyre breakaway, 0..1. The only extra dynamical memory. */
  rearRelease = 0;

  constructor(tune: R34Tune = r34Tune) { super(tune); }

  override get stateSize(): number { return super.stateSize + 6; }

  override saveState(out: Float64Array, o = 0): number {
    o = super.saveState(out, o);
    out[o++] = this.rearRelease;
    // Base PlayerCar does not serialize cosmetic controls; include them for complete rewinds.
    out[o++] = this.manual ? 1 : 0;
    out[o++] = this.blinker;
    out[o++] = this.shiftRefused ? 1 : 0;
    out[o++] = this.handbrake ? 1 : 0;
    out[o++] = this.horn ? 1 : 0;
    return o;
  }

  override loadState(src: ArrayLike<number>, o = 0): number {
    o = super.loadState(src, o);
    this.rearRelease = src[o++];
    this.manual = src[o++] !== 0;
    this.blinker = src[o++];
    this.shiftRefused = src[o++] !== 0;
    this.handbrake = src[o++] !== 0;
    this.horn = src[o++] !== 0;
    return o;
  }

  override reset(s: number, d: number, speed: number): void {
    super.reset(s, d, speed);
    this.rearRelease = this.steerHold = 0;
    this.throttle = this.brake = this.accLong = this.accLat = this.wheelSpin = 0;
    this.manual = this.shiftRefused = this.handbrake = this.horn = false;
    this.blinker = this.lastWallSide = this.wallImpact = 0;
    this.onShoulder = Math.abs(d) > ROAD_HALF;
    this.rpm = Math.max(this.tune.idleRpm, this.tune.redline * Math.max(speed, 0) * 3.6 / this.tune.gearTopKmh[this.gear - 1]);
  }

  override step(dt: number, inp: DriveInput, kRoad: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.prevS = this.s;
    this.prevD = this.d;
    this.prevPsi = this.psi;
    const wasReverse = this.gear === 0;
    if (this.reverse(dt, inp, kRoad)) {
      this.rearRelease = 0;
      return;
    }
    const t = this.tune;
    this.controls(inp);
    this.throttle = clamp(inp.throttle, 0, 1);
    this.brake = clamp(inp.brake, 0, 1);
    this.manual = inp.manual === true;
    this.shiftRefused = false;
    this.rampSteer(dt, inp, clamp(38 / Math.max(this.speed, 1), .6, 1));
    const boostAcc = this.updateBoost(dt, inp) / t.mass;
    // X out of reverse selects first; do not apply that same key press a second time as an upshift.
    const driveAcc = this.drivetrain(dt, wasReverse ? 0 : inp.shift ?? 0);

    // Fixed maximum integration interval also handles larger offline frame steps without ringing.
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.integrate(h, inp, kRoad, driveAcc, boostAcc);
    this.resolveWalls(dt);
    this.onShoulder = Math.abs(this.d) > ROAD_HALF;
  }

  /** Uses the existing shift/reverse contract but has no dependency on another car's drivetrain. */
  private drivetrain(dt: number, shift: number): number {
    const t = this.tune;
    const v = this.speed;
    const gears = t.gearTopKmh;
    const k = t.redline * v * 3.6;
    if (this.shiftT > 0) this.shiftT = Math.max(0, this.shiftT - dt);
    if (this.manual) {
      this.manualShift(shift, k);
    } else if (this.shiftT <= 0) {
      if (k / gears[this.gear - 1] > t.redline * .96 && this.throttle > .1 && this.gear < gears.length) {
        this.gear++;
        this.shiftT = t.shiftTime;
      } else if (this.gear > 1 && k / gears[this.gear - 2] < t.redline * .58) {
        this.gear--;
      }
    }
    const wheelRpm = k / gears[this.gear - 1];
    this.rpm = clamp(Math.max(wheelRpm, this.gear === 1 ? 900 + this.throttle * 2300 : 0), t.idleRpm, t.redline);
    if (this.shiftT > 0 || wheelRpm >= t.redline || this.handbrake) return 0;
    const share = this.manual ? manualPowerShare(Math.max(wheelRpm / t.redline, this.gear === 1 ? .55 : 0)) : 1;
    const ratio = t.redline * Math.PI / 30 * .34 * 3.6 / gears[this.gear - 1];
    const torqueForce = t.torqueNm * ratio * t.driveEff / .34;
    const powerForce = t.powerKW * 1000 * t.driveEff / Math.max(v, 6);
    const rearLoad = t.cgToFront / (t.cgToFront + t.cgToRear);
    const traction = G * t.longGrip * (t.gripRear * rearLoad * (1 - t.frontDrive) + t.gripFront * t.frontDrive);
    return this.throttle * Math.min(torqueForce * share / t.mass, powerForce * share / t.mass, traction);
  }

  private integrate(h: number, inp: DriveInput, kRoad: number, driveAcc: number, boostAcc: number): void {
    const t = this.tune;
    const speed = this.speed;
    const L = t.cgToFront + t.cgToRear;
    // Deriving slip from actual velocity, rather than storing a drift pose, preserves collision impulses.
    const slip = -Math.atan2(this.vy, Math.max(this.vx, .1));
    const moving = smooth(7, 15, speed);
    const powered = smooth(.4, .85, this.throttle) * (1 - this.brake);
    const rwd = (1 - t.frontDrive) * (1 - .35 * t.tractionControl) * (.7 + .3 * t.lsdLock);
    const held = inp.analog || inp.direct ? 1 : smooth(.08, .24, this.steerHold);
    const initiate = powered * smooth(.3, .85, Math.abs(this.steerIn)) * held;
    // A side-slip impulse is not wheelspin. Sustain an already released rear axle, but do not
    // turn a traffic impact into a new powered drift solely because it changed body velocity.
    const sustain = smooth(.08, .22, Math.abs(slip)) * smooth(.25, .6, this.throttle) * smooth(.1, .4, this.rearRelease);
    const request = moving * rwd * Math.max(initiate, sustain, this.handbrake ? 1 : 0);
    const releaseRate = request > this.rearRelease ? t.driftBuild * 3 : t.driftRecover;
    this.rearRelease += (request - this.rearRelease) * (1 - Math.exp(-releaseRate * h));

    const sliding = smooth(.025, .28, Math.abs(slip)) * moving;
    const grip = G * (t.gripFront * .6 + t.gripRear * .4);
    const lock = Math.min(t.maxSteerLow, t.steerGripScale * grip * L / Math.max(speed * speed, 1));
    // Additional opposite lock is available during a slide; zero input is always zero wheel angle.
    const opposite = this.steerIn * slip < 0;
    this.steerAngle = this.steerIn * (inp.direct ? t.maxSteerLow : Math.min(t.maxSteerLow, lock + (opposite ? Math.abs(slip) * .8 : 0)));
    const wheel = inp.direct ? clamp(this.steerAngle / Math.max(lock, .01), -2, 2) : this.steerIn;
    const counter = opposite ? wheel : 0;
    const angle = Math.max(.15, t.driftAngle);
    const seed = .95 * wheel * Math.exp(-Math.abs(slip) / .18);
    const growth = 2.2 * this.throttle - .45;
    // Small corrections chiefly place the trajectory; a committed opposite key also catches the
    // rear. That leaves a useful balancing window instead of cancelling every slide on first tap.
    const counterMoment = t.counterSteer * counter * (.35 + .65 * Math.min(1, Math.abs(counter)));
    const rearMoment = seed + slip * (growth - 1.7 * (slip / angle) ** 2) + counterMoment;
    let slipRate = this.rearRelease * t.driftBuild / 1.6 * rearMoment;
    slipRate -= (1 - this.rearRelease + this.brake * (1.5 - t.brakeFront)) * t.driftRecover * slip;
    // A straight handbrake pull cannot invent a direction. Existing yaw/steering swings the rear.
    if (this.handbrake) slipRate += moving * .95 * (wheel + Math.tanh(this.r * 2)) * Math.exp(-Math.abs(slip) / .6);
    // Soft restoring moment outside the useful drift envelope (no heading clamp / road alignment).
    const excess = Math.max(0, Math.abs(slip) - angle * 1.12);
    slipRate -= Math.sign(slip) * excess * excess * (12 + 10 * t.escAssist);
    slipRate = clamp(slipRate, -1.6, 1.6);

    const gripYaw = speed * Math.tan(this.steerAngle) / L;
    // Countersteer retains enough trajectory authority to balance a slide along a straight road,
    // rather than forcing every powered drift into an ever-tightening circle.
    const travelDemand = wheel * (1 - .1 * sliding) + .65 * Math.sin(slip) * sliding;
    const travelYaw = grip / Math.max(speed, 3) * clamp(t.steerGripScale * travelDemand, -1.12, 1.12);
    const pathYaw = gripYaw * (1 - moving) + travelYaw * moving;
    const yawTarget = pathYaw + slipRate;
    this.r += (yawTarget - this.r) * (1 - Math.exp(-t.yawResponse * h));
    // Finite tyre acceleration: slip cannot change faster than the available sideways impulse.
    const latRate = grip * 1.25 / Math.max(speed, 3);
    slipRate = clamp(slipRate, this.r - latRate, this.r + latRate);
    // Initial breakaway cannot push the trajectory opposite the turn. During countersteer the
    // tyres may still point into the travel direction, so leave their recovery impulse available.
    if (wheel * slip >= 0) {
      if (wheel > 0 && slipRate > this.r) slipRate = this.r;
      else if (wheel < 0 && slipRate < this.r) slipRate = this.r;
    }
    if (speed < 3) slipRate = -slip * t.driftRecover * 2;
    const nextSlip = slip + slipRate * h;

    const resist = (t.aeroDrag * speed * speed + t.rollingRes * speed) / t.mass;
    const overrun = (1 - this.throttle) * t.engineBrakeNm / t.mass * 7;
    const scrub = .85 * Math.sin(slip) ** 2 * speed / 20;
    const brakeAcc = this.brake * (t.brakeDecel + t.brakeAssist) + (this.handbrake ? 5.5 : 0);
    const acceleration = driveAcc + boostAcc - resist - overrun - scrub - brakeAcc;
    const nextSpeed = Math.max(0, speed + acceleration * h);
    this.vx = nextSpeed * Math.cos(nextSlip);
    this.vy = -nextSpeed * Math.sin(nextSlip);
    this.accLong = acceleration;
    this.accLat = speed * (this.r - slipRate);
    if (nextSpeed < .01) {
      this.vx = this.vy = this.r = 0;
      this.rearRelease = 0;
    }

    const vA = this.vAlong;
    // Valid road geometry stays far from the Frenet singularity; guard collision/out-of-map states.
    const sDot = vA / Math.max(.2, 1 - kRoad * this.d);
    this.s += sDot * h;
    this.d += this.vLat * h;
    this.psi += (this.r - kRoad * sDot) * h;
    this.wheelSpin += nextSpeed / .34 * (1 + this.rearRelease * this.throttle * .18) * h;
  }
}
