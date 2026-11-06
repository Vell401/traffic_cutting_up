import { carTune, ROAD_HALF, type CarTune } from '../config';
import { G, clamp, moveTo } from '../core/math';
import { PlayerCar, type DriveInput } from './vehicle';

/** rpm → rad/s */
const RPM = Math.PI / 30;
/** Handbrake torque on the rear axle, N·m (locks the wheels at any speed). */
const HANDBRAKE_TQ = 4000;
/** Handbrake below the tyre model's speed range, m/s². */
const HANDBRAKE_DECEL = 6;

/**
 * Tunables of physics №2 on top of the shared CarTune fields. CarTune fields keep their meaning:
 * gripFront/gripRear are peak μ of the axle at static load, tireB/tireC shape the tyre curve
 * (peak slip angle = tan(π/2C)/B), powerKW is peak engine power, brakeDecel the full-pedal demand,
 * steerGripScale/maxSteerLow/steerRate/steerReturn the keyboard steering. yawAssist is not used here.
 */
export type DriftTune = CarTune & {
  /** Peak engine torque, N·m (twin-turbo plateau). */
  torqueNm: number;
  /** Torque plateau starts here, rpm (turbo spooled). */
  torqueRpm: number;
  /** Share of peak torque available at idle, 0..1. */
  torqueLow: number;
  /** Above this rpm power fades toward the redline. */
  fadeRpm: number;
  /** Power lost between fadeRpm and the redline, 0..1. */
  fadeLoss: number;
  /** Engine speed held by the converter on a 1st-gear launch, rpm. */
  launchRpm: number;
  /** Driveline efficiency, 0..1. */
  driveEff: number;
  /** Engine drag on the overrun at the redline, N·m (scales with rpm). */
  engineBrakeNm: number;
  /** Engine + gearbox inertia at the crank, kg·m² (reflected to the wheels by ratio²). */
  engineInertia: number;
  /** Rear axle (two wheels, brakes, half-shafts) inertia, kg·m². */
  wheelInertiaRear: number;
  /** Front axle (two wheels, brakes) inertia, kg·m². */
  wheelInertiaFront: number;
  /** Rolling radius, m. */
  wheelRadius: number;
  /** Kickdown: with the pedal floored the gearbox drops a gear if that keeps the revs under this share of the redline. */
  kickdownRpm: number;
  /** Centre of mass height, m. */
  cgHeight: number;
  /** Track width, m. */
  trackWidth: number;
  /** Yaw inertia as a share of m·a·b (the value collisions assume). */
  yawInertia: number;
  /** Suspension: load transfer follows the body accelerations with this time constant, s. */
  loadLag: number;
  /** Share of the lateral load transfer taken by the front axle (roll stiffness distribution), 0..1. */
  rollFront: number;
  /** Tyre load sensitivity: μ drops by this share per 100 % load over the static wheel load. */
  loadSensitivity: number;
  /** Longitudinal slip ratio of peak force. */
  slipRatioPeak: number;
  /** Longitudinal peak μ as a share of the lateral one (tyres grip a little better in line). */
  longGrip: number;
  /** Rear tyre cornering stiffness relative to the front (wider rear tyres): peak slip angle / this. */
  rearStiffness: number;
  /** Limited-slip lock, 0 = open diff (drive limited by the inner wheel), 1 = locked. */
  lsdLock: number;
  /** Brake force share on the front axle, 0..1. */
  brakeFront: number;
  /** ABS keeps the front braking slip ratio under this. */
  absSlip: number;
  /** EBD keeps the rear braking slip ratio under this with the brake pedal down (rear stays planted). */
  ebdSlip: number;
  /**
   * Engine drag control (MSR): off the throttle and off the brakes, engine braking may pull a wheel
   * only this far into braking slip. Without it lifting mid-corner took enough rear grip to make the
   * car swing out and wander.
   */
  dragSlip: number;
  /** Rear slip ratio traction control allows at tractionControl = 1 (lower settings allow tcSlip / tractionControl). */
  tcSlip: number;
  /** ESP Sport strength, 0 = off, 1 = full. */
  escAssist: number;
  /** ESP starts acting at this rear-axle slip angle, rad... */
  escSlip: number;
  /** ...and is fully on this much further, rad. */
  escRange: number;
  /** Above this speed the ESP threshold shrinks as escSpeed / v (down to half): fast slides are caught earlier, m/s. */
  escSpeed: number;
  /** Once engaged, ESP keeps working until the slip angle is below escSlip·this (hysteresis). */
  escRelease: number;
  /** ESP intervention build-up / release rate (hydraulics), 1/s. */
  escRate: number;
  /** ESP looks this far ahead along the slip-angle rate, s. */
  escLead: number;
  /** Largest stabilising yaw moment ESP makes by braking single wheels, N·m. */
  escMoment: number;
  /** Share of engine torque ESP cuts when fully on, 0..1. */
  escCut: number;
  /** Keyboard lock also covers the understeer gradient: extra wheel angle per m/s² of front grip, rad·s²/m. */
  lockUnder: number;
  /** Above this speed the keyboard steering ramp slows as steerRateSpeed / v (heavier at speed), m/s. */
  steerRateSpeed: number;
  /** In a slide the lock widens toward the rear-axle slip angle by this share (room to countersteer). */
  counterSteer: number;
  /** Below this speed the car moves kinematically (tyre model is singular at a standstill), m/s. */
  lowSpeed: number;
  /** Slip ratio denominators never go below this speed, m/s. */
  slipSpeed: number;
  /** Integration substeps per step(). */
  substeps: number;
  /** Engine torque share sent to the front axle (AWD); zero retains rear-wheel drive. */
  frontDrive: number;
  /**
   * Traction control on a driven front axle: its slip limit as a share of the rear one. Lower keeps
   * more front grip for steering under throttle (without it the front wheels spun up when pulling
   * away and the car would not turn).
   */
  frontTc: number;
};

/**
 * Physics №2 "V8 RWD": a heavy front-engined twin-turbo V8 saloon on road tyres, ESP in Sport mode
 * (≈ Mercedes-AMG C63 / E63 S). The debug panel edits this object live.
 */
export const driftTune: DriftTune = {
  ...carTune,
  mass: 1750,
  // 52/48 front/rear on a 2.84 m wheelbase: the front axle carries b/L.
  cgToFront: 1.363,
  cgToRear: 1.477,
  powerKW: 375,
  gripFront: 1.12,
  // Rear tyres stiff and grippy enough that lifting mid-corner or mid lane change does not make the
  // car wander (before: gripRear 1.2, rearStiffness 1.15: the rear slip angle doubled off the throttle);
  // a little more keyboard lock keeps a quick lane change as quick.
  gripRear: 1.25,
  // Peak at tan(π/2·1.45)/15.2 ≈ 7° slip angle, sliding force ≈ 76 % of peak.
  tireB: 15.2,
  tireC: 1.45,
  aeroDrag: 0.5,
  rollingRes: 5,
  brakeDecel: 9.6,
  maxSteerLow: 0.55,
  steerGripScale: 1.75,
  yawAssist: 0,
  tractionControl: 1,
  redline: 7000,
  idleRpm: 750,
  /** Speed at the redline in each of the 7 gears, km/h (C63-like spread, 7th is the top-speed gear). */
  gearTopKmh: [76, 118, 162, 207, 248, 288, 330],
  shiftTime: 0.15,

  torqueNm: 700,
  torqueRpm: 2000,
  torqueLow: 0.6,
  fadeRpm: 6200,
  fadeLoss: 0.15,
  launchRpm: 2800,
  driveEff: 0.88,
  engineBrakeNm: 90,
  engineInertia: 0.18,
  wheelInertiaRear: 3,
  wheelInertiaFront: 2.4,
  wheelRadius: 0.34,
  kickdownRpm: 0.78,
  cgHeight: 0.5,
  trackWidth: 1.6,
  yawInertia: 1,
  loadLag: 0.1,
  rollFront: 0.56,
  loadSensitivity: 0.18,
  slipRatioPeak: 0.1,
  longGrip: 1.06,
  rearStiffness: 1.3,
  lsdLock: 0.8,
  brakeFront: 0.64,
  absSlip: 0.08,
  ebdSlip: 0.035,
  dragSlip: 0.01,
  tcSlip: 0.13,
  escAssist: 1,
  escSlip: 0.17,
  escRange: 0.08,
  escSpeed: 33,
  escRelease: 0.25,
  escRate: 6,
  escLead: 0.12,
  escMoment: 6000,
  escCut: 0.8,
  lockUnder: 0.0007,
  steerRateSpeed: 22,
  counterSteer: 1,
  lowSpeed: 2.5,
  slipSpeed: 3,
  substeps: 4,
  frontDrive: 0,
  frontTc: 0.6,
};

/*
 * Planar four-contact tire model with load transfer, axle wheel speeds and combined slip.
 *  - Axle loads follow body accelerations through a first-order lag. Lateral load transfer is split
 *    by roll stiffness, then each tire's nonlinear load sensitivity determines axle capacity.
 *  - Front and rear "wheels" spin with inertia; the rear gets engine torque through a 7-speed automatic.
 *    Wheel speed is integrated semi-implicitly (stiff at 120 Hz), so slip does not ring.
 *  - Tyre force: normalised combined slip (κ/κpeak, α/αpeak) through one Pacejka-like curve, so
 *    wheelspin eats rear lateral grip — the source of the small power oversteer.
 *  - TC / ABS / EBD clamp the slip ratio; ESP Sport adds a yaw moment and cuts torque once the rear
 *    axle slides past ~10° (less at high speed). Nothing ever turns the steering wheel.
 */
export class DriftCar extends PlayerCar {
  override readonly physicsId: number = 2;
  declare readonly tune: DriftTune;

  /** Shift request of the current step (manual gearbox). */
  private shiftReq = 0;
  /** Boost push of the current step, N. */
  private boostF = 0;
  /** Rear / front wheel angular speed, rad/s. */
  omegaR = 0;
  omegaF = 0;
  /** Telemetry: rear slip ratio, rear-axle slip angle (rad), ESP intervention 0..1. */
  slipRear = 0;
  slipAngleRear = 0;
  esc = 0;
  /** Signed ESP command (sign of the slide it fights), ramped by escRate. */
  private escCmd = 0;

  /** Lagged body accelerations driving the load transfer, m/s². */
  private axLag = 0;
  private ayLag = 0;
  /** Per-step drivetrain values used by the substeps. */
  private driveTq = 0;
  private dragTq = 0;
  private inertiaR = 1;
  private cosD = 1;
  private sinD = 0;
  /** Scratch outputs of tire() and axleGrip(). */
  private tfx = 0;
  private tfy = 0;
  private tdx = 0;
  private innerGrip = 0;

  constructor(tune: DriftTune = driftTune) {
    super(tune);
  }

  override saveState(out: Float64Array, o = 0): number {
    o = super.saveState(out, o);
    out[o++] = this.omegaR;
    out[o++] = this.omegaF;
    out[o++] = this.slipRear;
    out[o++] = this.slipAngleRear;
    out[o++] = this.esc;
    out[o++] = this.escCmd;
    out[o++] = this.axLag;
    out[o++] = this.ayLag;
    out[o++] = this.driveTq;
    out[o++] = this.dragTq;
    out[o++] = this.inertiaR;
    out[o++] = this.cosD;
    out[o++] = this.sinD;
    out[o++] = this.innerGrip;
    return o;
  }

  override loadState(src: ArrayLike<number>, o = 0): number {
    o = super.loadState(src, o);
    this.omegaR = src[o++];
    this.omegaF = src[o++];
    this.slipRear = src[o++];
    this.slipAngleRear = src[o++];
    this.esc = src[o++];
    this.escCmd = src[o++];
    this.axLag = src[o++];
    this.ayLag = src[o++];
    this.driveTq = src[o++];
    this.dragTq = src[o++];
    this.inertiaR = src[o++];
    this.cosD = src[o++];
    this.sinD = src[o++];
    this.innerGrip = src[o++];
    return o;
  }

  override get stateSize(): number {
    return super.stateSize + 14;
  }

  override reset(s: number, d: number, speed: number): void {
    super.reset(s, d, speed);
    const t = this.tune;
    this.omegaR = this.omegaF = speed / t.wheelRadius;
    this.axLag = this.ayLag = 0;
    this.slipRear = this.slipAngleRear = this.esc = this.escCmd = 0;
    this.accLong = this.accLat = 0;
    this.rpm = Math.max(t.idleRpm, (t.redline * speed * 3.6) / t.gearTopKmh[this.gear - 1]);
  }

  override step(dt: number, inp: DriveInput, kRoad: number): void {
    const t = this.tune;
    this.prevS = this.s;
    this.prevD = this.d;
    this.prevPsi = this.psi;

    const L = t.cgToFront + t.cgToRear;
    const v = Math.max(this.vx, 0);
    this.rampSteer(dt, inp, clamp(t.steerRateSpeed / Math.max(v, 1), 0.4, 1));
    if (this.reverse(dt, inp, kRoad)) {
      this.omegaR = this.omegaF = this.vx / t.wheelRadius;
      this.slipRear = this.slipAngleRear = this.esc = this.escCmd = 0;
      this.axLag = this.accLong;
      this.ayLag = 0;
      this.driveTq = this.dragTq = 0;
      return;
    }
    this.boostF = this.updateBoost(dt, inp);
    this.throttle = clamp(inp.throttle, 0, 1);
    this.brake = clamp(inp.brake, 0, 1);
    this.manual = inp.manual === true;
    this.controls(inp);
    this.shiftReq = inp.shift ?? 0;

    // Steering lock: grip-matched like №1 (plus the understeer gradient) so full input reaches about
    // the grip limit at any speed, but measured from the direction the rear axle travels when it
    // slides — countersteer can follow the slide. Never moves by itself: zero input is zero angle.
    const lock = Math.min(t.maxSteerLow, t.gripFront * G * ((t.steerGripScale * L) / Math.max(v * v, 1) + t.lockUnder));
    const slide = v > t.lowSpeed ? Math.atan2(this.vy - t.cgToRear * this.r, v) * t.counterSteer : 0;
    // The mouse turns the wheel itself: full lock at any speed.
    const lockRight = inp.direct ? t.maxSteerLow : Math.min(t.maxSteerLow, lock + Math.max(0, slide));
    const lockLeft = inp.direct ? t.maxSteerLow : Math.min(t.maxSteerLow, lock - Math.min(0, slide));
    this.steerAngle = this.steerIn * (this.steerIn > 0 ? lockRight : lockLeft);
    this.cosD = Math.cos(this.steerAngle);
    this.sinD = Math.sin(this.steerAngle);

    this.drivetrain(dt);

    const n = Math.max(1, Math.round(t.substeps));
    const h = dt / n;
    const lagK = 1 - Math.exp(-h / t.loadLag);
    for (let i = 0; i < n; i++) this.substep(h, kRoad, lagK);

    this.resolveWalls(dt);
    this.onShoulder = Math.abs(this.d) > ROAD_HALF;
  }

  /** Engine torque at full throttle, N·m: turbo spool, 700 N·m plateau, constant power, fade. */
  engineTorque(rpm: number): number {
    const t = this.tune;
    const spool = clamp((rpm - t.idleRpm) / (t.torqueRpm - t.idleRpm), 0, 1);
    let tq = t.torqueNm * (t.torqueLow + (1 - t.torqueLow) * spool * (2 - spool));
    tq = Math.min(tq, (t.powerKW * 1000) / Math.max(rpm * RPM, 1));
    if (rpm > t.fadeRpm) tq *= 1 - t.fadeLoss * clamp((rpm - t.fadeRpm) / (t.redline - t.fadeRpm), 0, 1);
    return tq;
  }

  /**
   * Gearbox (automatic: shifts on rear wheel speed, kickdown; manual: on requests only), rpm and the
   * wheel torques for this step. The fuel cut at the redline works in every gear.
   */
  private drivetrain(dt: number): void {
    const t = this.tune;
    const gears = t.gearTopKmh;
    // Engine rpm the rear wheel speed asks for is k / (gear top speed).
    const k = t.redline * this.omegaR * t.wheelRadius * 3.6;
    let rpmW = k / gears[this.gear - 1];
    // Upshift point follows the pedal: 97 % of the redline flat out, earlier when cruising.
    if (this.manual) {
      if (this.shiftT > 0) this.shiftT -= dt;
      this.manualShift(this.shiftReq, k);
    } else if (this.shiftT > 0) {
      this.shiftT -= dt;
    } else if (rpmW > t.redline * (0.68 + 0.29 * this.throttle) && this.gear < gears.length && this.throttle > 0.1) {
      this.gear++;
      this.shiftT = t.shiftTime;
    } else if (this.gear > 1) {
      const lower = k / gears[this.gear - 2];
      if (lower < t.redline * 0.6) {
        this.gear--;
      } else if (this.throttle > 0.9 && lower < t.redline * t.kickdownRpm) {
        this.gear--;
        this.shiftT = t.shiftTime * 0.5;
      }
    }
    rpmW = k / gears[this.gear - 1];
    let rpm = Math.max(t.idleRpm, rpmW);
    if (this.gear === 1) rpm = Math.max(rpm, t.idleRpm + this.throttle * (t.launchRpm - t.idleRpm));
    this.rpm = Math.min(rpm, t.redline);

    // Engine rad/s per wheel rad/s in this gear.
    const ratio = (t.redline * RPM * t.wheelRadius * 3.6) / gears[this.gear - 1];
    const shifting = this.shiftT > 0;
    const cut = shifting || rpmW >= t.redline;
    this.driveTq = cut ? 0 : this.throttle * this.engineTorque(this.rpm) * t.driveEff * ratio;
    this.dragTq = shifting ? 0 : (1 - this.throttle) * t.engineBrakeNm * (this.rpm / t.redline) * ratio;
    this.inertiaR = t.wheelInertiaRear + t.engineInertia * ratio * ratio;
  }

  private substep(h: number, kRoad: number, lagK: number): void {
    const t = this.tune;
    const a = t.cgToFront;
    const b = t.cgToRear;
    const L = a + b;
    const m = t.mass;
    const R = t.wheelRadius;
    const mg = m * G;
    const vx = this.vx;
    const v = Math.max(vx, 0);

    // Axle loads from the lagged accelerations, peak forces with load sensitivity.
    const dLong = (m * this.axLag * t.cgHeight) / L;
    const fzF = Math.max(0.1 * mg, (mg * b) / L - dLong);
    const fzR = Math.max(0.1 * mg, (mg * a) / L + dLong);
    const dLat = (m * this.ayLag * t.cgHeight) / t.trackWidth;
    const gripF = this.axleGrip(fzF, dLat * t.rollFront, t.gripFront, (mg * b) / L / 2);
    const gripR = this.axleGrip(fzR, dLat * (1 - t.rollFront), t.gripRear, (mg * a) / L / 2);
    // Open diff: drive limited by twice the inner wheel; the LSD locks most of that back.
    const gripRx = gripR + (Math.min(gripR, 2 * this.innerGrip) - gripR) * (1 - t.lsdLock);
    const resist = t.aeroDrag * v * v + t.rollingRes * v;

    if (vx < t.lowSpeed) {
      // Kinematic bicycle near a standstill.
      const hb = this.handbrake;
      const driveGrip = (hb ? 0 : gripRx) + (t.frontDrive > 0 ? gripF : 0);
      const fx = Math.min((this.driveTq * (hb ? t.frontDrive : 1)) / R, 0.95 * driveGrip) - resist + this.boostF;
      this.vx += (fx / m) * h;
      this.vx = Math.max(0, this.vx - (this.brake * t.brakeDecel + (hb ? HANDBRAKE_DECEL : 0)) * h);
      this.vy = 0;
      this.r = (this.vx * this.sinD) / (this.cosD * L);
      this.omegaR = this.omegaF = this.vx / R;
      this.axLag += (fx / m - this.axLag) * lagK;
      this.ayLag += (this.vx * this.r - this.ayLag) * lagK;
      this.accLong = fx / m;
      this.accLat = 0;
      this.slipRear = this.slipAngleRear = this.esc = this.escCmd = 0;
    } else {
      const cosd = this.cosD;
      const sind = this.sinD;
      const vyF = this.vy + a * this.r;
      const vwF = vx * cosd + vyF * sind;
      const alphaF = Math.atan2(vyF, vx) - this.steerAngle;
      const alphaR = Math.atan2(this.vy - b * this.r, vx);
      const denF = Math.max(vwF, t.slipSpeed);
      const denR = Math.max(vx, t.slipSpeed);
      const kapF = (this.omegaF * R - vwF) / denF;
      const kapR = (this.omegaR * R - vx) / denR;
      this.tire(kapF, alphaF, gripF * t.longGrip, gripF, 1);
      const fxF = this.tfx;
      const fyF = this.tfy;
      const kF = this.tdx;
      this.tire(kapR, alphaR, gripRx * t.longGrip, gripR, t.rearStiffness);
      const fxR = this.tfx;
      const fyR = this.tfy;
      const kR = this.tdx;
      const fxFront = fxF * cosd - fyF * sind;
      const fyFront = fxF * sind + fyF * cosd;
      let fx = fxFront + fxR - resist + this.boostF;
      const fy = fyFront + fyR;
      let mz = a * fyFront - b * fyR;
      const Iz = m * a * b * t.yawInertia;

      // ESP Sport: once the rear slides past escSlip (looking escLead ahead) it brakes single wheels
      // against the slide and cuts torque, and keeps at it until the slide is nearly gone. Pressure
      // builds at escRate. Grip driving never triggers it.
      const slipRate = (fy / m - vx * this.r - (b * mz) / Iz) / vx;
      const pred = alphaR + t.escLead * slipRate;
      const thr = t.escSlip * clamp(t.escSpeed / vx, 0.5, 1) * (this.escCmd !== 0 ? t.escRelease : 1);
      // The handbrake is a request to slide: ESP stands back while it is up.
      const want = this.handbrake ? 0 : Math.sign(pred) * t.escAssist * clamp((Math.abs(pred) - thr) / t.escRange, 0, 1);
      this.escCmd = moveTo(this.escCmd, want, t.escRate * h);
      const u = Math.abs(this.escCmd);
      const mEsp = this.escCmd * t.escMoment;
      mz += mEsp;
      fx -= Math.abs(mEsp) / t.trackWidth;

      this.vx += (fx / m + this.vy * this.r) * h;
      this.vy += (fy / m - vx * this.r) * h;
      this.r += (mz / Iz) * h;

      // Wheels: semi-implicit in the tyre's slip stiffness (dFx/dω ≥ 0), explicit past the peak.
      const tc = t.tractionControl;
      let kLim = tc > 0 ? t.tcSlip / tc : 1e3;
      kLim += (0.03 - kLim) * u;
      const brakeTq = this.brake * m * t.brakeDecel * R;
      // Handbrake: the drive to the rear opens (clutch / AWD coupling) and the rear brakes lock.
      const hb = this.handbrake;
      const driveFront = this.driveTq * t.frontDrive;
      const driveRear = hb ? 0 : this.driveTq - driveFront;
      // Engine braking reaches the wheels the way the drive does (all-wheel drive: both axles).
      const dragFront = this.dragTq * t.frontDrive;
      const dragRear = hb ? 0 : this.dragTq - dragFront;
      const coasting = this.brake < 0.02;

      const kr = Math.max(0, kR / t.slipRatioPeak) * (R / denR);
      const ir = this.inertiaR + h * R * kr;
      let wr = this.omegaR + (h * (driveRear * (1 - t.escCut * u) - dragRear - R * fxR)) / ir;
      wr = Math.max(0, wr - (h * (brakeTq * (1 - t.brakeFront) + (hb ? HANDBRAKE_TQ : 0))) / ir);
      const rearSlipMin = hb ? 1 : coasting ? t.dragSlip : t.ebdSlip;
      this.omegaR = clamp(wr, (vx - rearSlipMin * denR) / R, (vx + kLim * denR) / R);
      const kf = Math.max(0, kF / t.slipRatioPeak) * (R / denF);
      const iff = t.wheelInertiaFront + h * R * kf;
      let wf = this.omegaF + (h * (driveFront * (1 - t.escCut * u) - dragFront - R * fxF)) / iff;
      wf = Math.max(0, wf - (h * brakeTq * t.brakeFront) / iff);
      this.omegaF = Math.max(wf, (vwF - (coasting ? t.dragSlip : t.absSlip) * denF) / R);
      if (t.frontDrive > 0) this.omegaF = Math.min(this.omegaF, (vwF + kLim * t.frontTc * denF) / R);

      this.axLag += (fx / m - this.axLag) * lagK;
      this.ayLag += (fy / m - this.ayLag) * lagK;
      this.accLong = fx / m;
      this.accLat = fy / m;
      this.slipRear = kapR;
      this.slipAngleRear = alphaR;
      this.esc = u;
    }
    if (this.vx < 0) this.vx = 0;

    // Integrate in road coordinates.
    const cp = Math.cos(this.psi);
    const sp = Math.sin(this.psi);
    const vA = this.vx * cp - this.vy * sp;
    const vL = this.vx * sp + this.vy * cp;
    const sDot = vA / (1 - kRoad * this.d);
    this.s += sDot * h;
    this.d += vL * h;
    this.psi += (this.r - kRoad * sDot) * h;
    this.wheelSpin += this.omegaR * h;
  }

  /**
   * Peak force of both axle tires after lateral load transfer. Per-tire load sensitivity reduces total
   * axle capacity and records the inner tire capacity for the differential.
   */
  private axleGrip(fz: number, dLat: number, mu: number, fNom: number): number {
    const ls = this.tune.loadSensitivity;
    const half = fz * 0.5;
    const tr = Math.min(Math.abs(dLat), half);
    const fin = half - tr;
    const fout = half + tr;
    this.innerGrip = mu * Math.max(0.4, 1 - ls * (fin / fNom - 1)) * fin;
    return this.innerGrip + mu * Math.max(0.4, 1 - ls * (fout / fNom - 1)) * fout;
  }

  /**
   * Combined-slip tyre: normalised slip s = |(κ/κpeak, α/αpeak)| through sin(C·atan(B·s)) (peak 1 at s = 1),
   * force split along the slip direction (friction ellipse with radii Dx, Dy).
   * Writes Fx (along the wheel), Fy (lateral, against α) and dFx/d(κ/κpeak).
   */
  private tire(kappa: number, alpha: number, dx: number, dy: number, stiff: number): void {
    const C = this.tune.tireC;
    const Bn = Math.tan(Math.PI / (2 * C));
    const sx = kappa / this.tune.slipRatioPeak;
    const sy = (alpha * this.tune.tireB * stiff) / Bn;
    const s2 = sx * sx + sy * sy;
    if (s2 < 1e-12) {
      this.tfx = dx * C * Bn * sx;
      this.tfy = -dy * C * Bn * sy;
      this.tdx = dx * C * Bn;
      return;
    }
    const s = Math.sqrt(s2);
    const at = Math.atan(Bn * s);
    const g = Math.sin(C * at) / s;
    const fp = (Math.cos(C * at) * C * Bn) / (1 + Bn * Bn * s2);
    this.tfx = dx * g * sx;
    this.tfy = -dy * g * sy;
    this.tdx = (dx * (fp * sx * sx + g * sy * sy)) / s2;
  }
}
