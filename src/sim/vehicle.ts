import { carTune, WALL_D, ROAD_HALF, type CarTune } from '../config';
import { G, clamp, moveTo } from '../core/math';

export interface DriveInput {
  /** -1 (left) .. 1 (right) */
  steer: number;
  throttle: number;
  brake: number;
  /** Analog stick: follow the input almost directly instead of the keyboard ramp. */
  analog?: boolean;
  /** Manual gearbox: gears change only on `shift` requests (else the automatic shifts). */
  manual?: boolean;
  /** Shift request for this step: 1 up, -1 down, 0 none (one step per key press). */
  shift?: number;
  /** Turn signal: 0 off, 1 left, 2 right (cosmetic; others see it online). */
  blinker?: number;
   /** C held: spend the boost reserve on extra push. */
  boost?: boolean;
  /** Shift held: disconnect engine torque from the driven wheels. */
  clutch?: boolean;
  /**
   * Mouse steering: the input is the wheel angle itself, a share of full lock at any speed (the
   * keyboard lock shrinks with speed to match the grip instead).
   */
  direct?: boolean;
  /** Space held: the handbrake locks the rear wheels (and opens the drive to them). */
  handbrake?: boolean;
  tractionControlEnabled?: boolean;
  espEnabled?: boolean;
  /** H held: the horn (cosmetic; others hear it online). */
  horn?: boolean;
}

/** Reverse (gear 0): top speed and pull of the slow kinematic reverse, m/s and m/s². */
export const REVERSE_MAX = 7;
const REVERSE_ACC = 3.2;
/** Boost: extra push (m/s², bypasses the gearbox and the tyres' traction limit), seconds of reserve, seconds to refill, share needed to start again. */
export const BOOST_ACC = 2.2;
const BOOST_SECONDS = 4;
const BOOST_REFILL = 14;
const BOOST_RESTART = 0.15;
/** Handbrake: share of the rear axle's grip its locked wheels pull back with (arcade physics №1). */
const HANDBRAKE_GRIP = 0.95;
/** Yaw assist left while the handbrake is up: the rear may swing out. */
const HANDBRAKE_ASSIST = 0.15;
/** Handbrake below the tyre model's speed range, m/s². */
const HANDBRAKE_DECEL = 6;

/** Engine power available in a manual gear at rpm share x of the redline (the automatic keeps the revs high). */
export const manualPowerShare = (x: number): number => clamp(0.2 + 0.95 * x, 0.3, 1);

/**
 * Yaw-rate tracking gain (1/s) at yawAssist = 1. High enough that the car rotates as soon as the wheel
 * turns and stops rotating as soon as it centres (like a real car's self-aligning steering), so a
 * keyboard lane change ends straight instead of overshooting by 1-3 degrees.
 */
const YAW_GAIN = 16;
/** A barrier contact counts as a new hit only after this long away from the wall. */
export const WALL_REHIT = 0.5;

export const magicFormula = (alpha: number, B: number, C: number): number => Math.sin(C * Math.atan(B * alpha));

/*
 * Player car: dynamic bicycle model integrated directly in road (Frenet) coordinates.
 *   s   – distance along the road centre line
 *   d   – lateral offset, positive to the right
 *   psi – heading relative to the road, positive = pointing right
 *   vx, vy – body-frame velocity (forward, right); r – yaw rate (positive = turning right)
 */
export class PlayerCar {
  /** Physics variant number shown in the menu (1 = grip arcade). */
  readonly physicsId: number = 1;

  constructor(readonly tune: CarTune = carTune) {}

  s = 0;
  d = 0;
  psi = 0;
  vx = 0;
  vy = 0;
  r = 0;

  prevS = 0;
  prevD = 0;
  prevPsi = 0;

  steerIn = 0;
  steerAngle = 0;
  /** Seconds the current keyboard steering direction has been held. */
  protected steerHold = 0;
  throttle = 0;
  brake = 0;
  gear = 1;
  rpm = 900;
  shiftT = 0;
  /** Longitudinal / lateral acceleration felt by the body (for camera and suspension visuals). */
  accLong = 0;
  accLat = 0;
  wheelSpin = 0;

  onShoulder = false;
  /** -1 touching the left barrier, 1 the right one, 0 free. */
  wallSide = 0;
  /** Set on the step a new barrier contact starts. */
  wallHit = false;
  wallImpact = 0;
  protected wallFreeT = WALL_REHIT;
  protected lastWallSide = 0;
  /** Online spawn protection: traffic ignores the car and contacts are off. Not part of the physics state. */
  ghost = false;
  /** Boost reserve 0..1 and whether it is being spent (both carried step to step). */
  boost = 1;
  boostOn = false;
  /** Gearbox mode of the last step, the turn signal shown, a refused downshift (would over-rev). Cosmetic. */
  manual = false;
  blinker = 0;
  shiftRefused = false;
  /** Handbrake and horn of the last step (the horn is heard by others online). */
  handbrake = false;
  horn = false;

  /**
   * Every value step() carries from one call to the next, in a fixed order: the server sends it so a
   * client can rewind its predicted car to the confirmed state and replay its newer inputs. Returns
   * the index after the last value written.
   */
  saveState(out: Float64Array, o = 0): number {
    out[o++] = this.s;
    out[o++] = this.d;
    out[o++] = this.psi;
    out[o++] = this.vx;
    out[o++] = this.vy;
    out[o++] = this.r;
    out[o++] = this.prevS;
    out[o++] = this.prevD;
    out[o++] = this.prevPsi;
    out[o++] = this.steerIn;
    out[o++] = this.steerAngle;
    out[o++] = this.steerHold;
    out[o++] = this.throttle;
    out[o++] = this.brake;
    out[o++] = this.gear;
    out[o++] = this.rpm;
    out[o++] = this.shiftT;
    out[o++] = this.accLong;
    out[o++] = this.accLat;
    out[o++] = this.wheelSpin;
    out[o++] = this.onShoulder ? 1 : 0;
    out[o++] = this.wallSide;
    out[o++] = this.wallHit ? 1 : 0;
    out[o++] = this.wallImpact;
    out[o++] = this.wallFreeT;
    out[o++] = this.lastWallSide;
    out[o++] = this.boost;
    out[o++] = this.boostOn ? 1 : 0;
    return o;
  }

  /** Inverse of saveState(). Returns the index after the last value read. */
  loadState(src: ArrayLike<number>, o = 0): number {
    this.s = src[o++];
    this.d = src[o++];
    this.psi = src[o++];
    this.vx = src[o++];
    this.vy = src[o++];
    this.r = src[o++];
    this.prevS = src[o++];
    this.prevD = src[o++];
    this.prevPsi = src[o++];
    this.steerIn = src[o++];
    this.steerAngle = src[o++];
    this.steerHold = src[o++];
    this.throttle = src[o++];
    this.brake = src[o++];
    this.gear = src[o++];
    this.rpm = src[o++];
    this.shiftT = src[o++];
    this.accLong = src[o++];
    this.accLat = src[o++];
    this.wheelSpin = src[o++];
    this.onShoulder = src[o++] !== 0;
    this.wallSide = src[o++];
    this.wallHit = src[o++] !== 0;
    this.wallImpact = src[o++];
    this.wallFreeT = src[o++];
    this.lastWallSide = src[o++];
    this.boost = src[o++];
    this.boostOn = src[o++] !== 0;
    return o;
  }

  /** Number of values saveState() writes. */
  get stateSize(): number {
    return 28;
  }

  reset(s: number, d: number, speed: number): void {
    this.s = this.prevS = s;
    this.d = this.prevD = d;
    this.psi = this.prevPsi = 0;
    this.vx = speed;
    this.vy = 0;
    this.r = 0;
    this.steerIn = 0;
    this.steerAngle = 0;
    this.shiftT = 0;
    this.gear = 1;
    while (this.gear < this.tune.gearTopKmh.length && speed * 3.6 > this.tune.gearTopKmh[this.gear - 1] * 0.8) this.gear++;
    this.wallSide = 0;
    this.wallHit = false;
    this.wallFreeT = WALL_REHIT;
    this.boost = 1;
    this.boostOn = false;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /** Barrier side being rubbed (contact within the last 0.12 s; contacts flicker between steps), else 0. */
  get scrapeSide(): number {
    return this.wallFreeT < 0.12 ? this.lastWallSide : 0;
  }

  /** Speed along the road (what traffic and scoring compare against). */
  get vAlong(): number {
    return this.vx * Math.cos(this.psi) - this.vy * Math.sin(this.psi);
  }

  get vLat(): number {
    return this.vx * Math.sin(this.psi) + this.vy * Math.cos(this.psi);
  }

  /** Half of the car's footprint measured across the road. */
  halfExtentD(): number {
    const t = this.tune;
    return (t.width / 2) * Math.abs(Math.cos(this.psi)) + (t.length / 2) * Math.abs(Math.sin(this.psi));
  }

  /** Overwrite the velocity from road-frame components (used by collision responses). */
  setRoadVelocity(vA: number, vL: number): void {
    const cp = Math.cos(this.psi);
    const sp = Math.sin(this.psi);
    this.vx = vA * cp + vL * sp;
    this.vy = -vA * sp + vL * cp;
  }

  step(dt: number, inp: DriveInput, kRoad: number): void {
    const t = this.tune;
    this.prevS = this.s;
    this.prevD = this.d;
    this.prevPsi = this.psi;
    this.manual = inp.manual === true;
    if (this.manual) this.applyManualShift(inp);
    if (this.reverse(dt, inp, kRoad)) return;
    const boostF = this.updateBoost(dt, inp);

    const L = t.cgToFront + t.cgToRear;
    const m = t.mass;
    const Iz = m * t.cgToFront * t.cgToRear;
    const v = Math.max(this.vx, 0);

    // Steering: ramped input, lock limited so full input ≈ grip limit at any speed (the mouse turns
    // the wheel itself: full lock at any speed).
    this.rampSteer(dt, inp);
    const gripSteer = (t.steerGripScale * t.gripFront * G * L) / Math.max(v * v, 1);
    this.steerAngle = this.steerIn * (inp.direct ? t.maxSteerLow : Math.min(t.maxSteerLow, gripSteer));
    const delta = this.steerAngle;
    const hb = this.controls(inp);

    this.throttle = clamp(inp.throttle, 0, 1);
    this.brake = clamp(inp.brake, 0, 1);

    // Drivetrain: power-limited thrust, a gearbox with a short torque cut on upshifts. The automatic
    // shifts by itself; the manual one only on requests, and then the revs matter (power share by rpm,
    // the limiter in any gear).
    const gears = t.gearTopKmh;
    // Engine rpm in gear g is k / (top speed of g, km/h).
    const k = t.redline * v * 3.6;
    this.manual = inp.manual === true;
    this.rpm = this.gear === -1 || inp.clutch ? t.idleRpm + this.throttle * (t.redline - t.idleRpm) : Math.max(t.idleRpm, k / gears[Math.max(0, this.gear - 1)]);
    if (this.manual) {
      if (this.shiftT > 0) this.shiftT = Math.max(0, this.shiftT - dt);
      if ((inp.shift ?? 0) !== 0 && this.shiftT <= 0) this.manualShift(inp.shift!, k);
      this.rpm = this.gear === -1 || inp.clutch ? t.idleRpm + this.throttle * (t.redline - t.idleRpm) : Math.max(t.idleRpm, k / gears[Math.max(0, this.gear - 1)]);
    } else if (this.shiftT > 0) {
      this.shiftT -= dt;
    } else if (this.rpm > t.redline * 0.97 && this.gear < gears.length && this.throttle > 0.1) {
      this.gear++;
      this.shiftT = t.shiftTime;
    } else if (this.gear > 1 && k / gears[this.gear - 2] < t.redline * 0.6) {
      this.gear--;
    }
    const limiter = (this.manual || this.gear === gears.length) && this.rpm >= t.redline;
    const Fzf = (m * G * t.cgToRear) / L;
    const Fzr = (m * G * t.cgToFront) / L;
    let drive = 0;
    if (this.gear !== -1 && !inp.clutch && this.shiftT <= 0 && !limiter && !hb) {
      // Manual: clutch slip holds the revs up in first, otherwise a too-high gear pulls weakly.
      const share = this.manual ? manualPowerShare(Math.max(this.rpm / t.redline, this.gear === 1 ? 0.55 : 0)) : 1;
      drive = this.throttle * Math.min((t.powerKW * 1000 * share) / Math.max(v, 6), this.tractionLimit(v, delta, Fzr, L));
    }
    const brakeF = this.brake * m * t.brakeDecel;
    const resist = t.aeroDrag * v * v + t.rollingRes * v;

    if (v > 2.5) {
      // Handbrake: the locked rear wheels drag at about their grip, which leaves them little to hold sideways.
      const fxRear = drive - brakeF * 0.4 - (hb ? HANDBRAKE_GRIP * t.gripRear * Fzr : 0);
      const fxFront = -brakeF * 0.6;
      // Friction circle: longitudinal force eats into lateral capacity.
      const Df0 = t.gripFront * Fzf;
      const Dr0 = t.gripRear * Fzr;
      const Df = Math.sqrt(Math.max(Df0 * Df0 * 0.05, Df0 * Df0 - fxFront * fxFront));
      const Dr = Math.sqrt(Math.max(Dr0 * Dr0 * 0.05, Dr0 * Dr0 - fxRear * fxRear));
      const af = Math.atan2(this.vy + t.cgToFront * this.r, v) - delta;
      const ar = Math.atan2(this.vy - t.cgToRear * this.r, v);
      const Fyf = -Df * magicFormula(af, t.tireB, t.tireC);
      const Fyr = -Dr * magicFormula(ar, t.tireB, t.tireC);
      const cosd = Math.cos(delta);
      const sind = Math.sin(delta);

      const fx = fxRear + fxFront * cosd - Fyf * sind - resist + boostF;
      const fyFront = Fyf * cosd + fxFront * sind;
      const ax = fx / m + this.vy * this.r;
      const ay = (fyFront + Fyr) / m - v * this.r;
      let rdot = (t.cgToFront * fyFront - t.cgToRear * Fyr) / Iz;

      // Stability assist: pulls the yaw rate toward what the front wheels ask for (sharper turn-in,
      // no snap oversteer). It never steers by itself: with the wheel straight it only stops the rotation.
      const latLimit = (t.gripFront * G) / Math.max(v, 1);
      const rKin = clamp((v * Math.tan(delta)) / L, -latLimit, latLimit);
      rdot += t.yawAssist * (hb ? HANDBRAKE_ASSIST : 1) * YAW_GAIN * (rKin - this.r);

      this.vx += ax * dt;
      this.vy += ay * dt;
      this.r += rdot * dt;
      this.accLong = fx / m;
      this.accLat = (fyFront + Fyr) / m;
    } else {
      // Low speed: kinematic bicycle, the tire model is singular near standstill.
      const fx = drive - resist + boostF;
      this.vx += (fx / m) * dt;
      this.vx = Math.max(0, this.vx - (this.brake * t.brakeDecel + (hb ? HANDBRAKE_DECEL : 0)) * dt);
      this.vy = 0;
      this.r = (Math.max(this.vx, 0) * Math.tan(delta)) / L;
      this.accLong = fx / m;
      this.accLat = 0;
    }
    if (this.vx < 0) this.vx = 0;

    // Integrate in road coordinates.
    const cp = Math.cos(this.psi);
    const sp = Math.sin(this.psi);
    const vA = this.vx * cp - this.vy * sp;
    const vL = this.vx * sp + this.vy * cp;
    const sDot = vA / (1 - kRoad * this.d);
    this.s += sDot * dt;
    this.d += vL * dt;
    this.psi += (this.r - kRoad * sDot) * dt;
    this.wheelSpin += (this.vx / 0.34) * dt;

    this.resolveWalls(dt);
    this.onShoulder = Math.abs(this.d) > ROAD_HALF;
  }

  /**
   * Steering input ramp (shared by the physics variants): updates steerIn from the raw input.
   * Keyboard ramp is progressive: a tap gives a small angle for fine corrections, holding the key
   * speeds the ramp up to full rate within ~0.15 s. Releasing snaps back to centre.
   * pressScale scales the keyboard press rate (1 = as tuned).
   */
  /**
   * Direction: holding the brake at a standstill engages reverse (gear 0), the throttle at a
   * standstill (or X in manual) goes back to first; Z in first at a standstill also selects reverse.
   * In reverse this runs the step and returns true.
   */
  protected reverse(dt: number, inp: DriveInput, kRoad: number): boolean {
    // Forward needs the car fully stopped before reverse goes in; out of reverse a nearly stopped car is enough.
    if (inp.manual && this.gear === 0) {
      this.controls(inp);
      this.stepReverse(dt, inp, kRoad);
      return true;
    }
    if (!inp.manual && this.gear !== 0 && this.vx < 1e-3 && (inp.brake > 0.5 && inp.throttle < 0.05)) {
      this.gear = 0;
      this.shiftT = 0;
    } else if (!inp.manual && this.gear === 0 && this.vx > -0.3 && (inp.throttle > 0.1 && inp.brake < 0.05)) {
      this.gear = 1;
      this.vx = Math.max(this.vx, 0);
    }
    if (this.gear !== 0) return false;
    this.manual = inp.manual === true;
    this.controls(inp);
    this.shiftRefused = false;
    this.boostOn = false;
    this.boost = Math.min(1, this.boost + dt / BOOST_REFILL);
    this.stepReverse(dt, inp, kRoad);
    return true;
  }

  protected applyManualShift(inp: DriveInput): void {
    if (!inp.manual) return;
    if (this.shiftT > 0) this.shiftT = Math.max(0, this.shiftT - 1 / 120);
    if ((inp.shift ?? 0) === 0 || this.shiftT > 0) return;
    const dir = inp.shift!;
    const stopped = Math.abs(this.vx) < 0.3;
    if (this.gear === 0 && !stopped) return;
    if (this.gear === 0 && dir > 0) this.gear = -1;
    else if (this.gear === 0 && dir < 0) return;
    else if (this.gear === -1 && dir > 0) this.gear = 1;
    else if (this.gear === -1 && dir < 0) this.gear = 0;
    else if (this.gear === 1 && dir < 0) this.gear = -1;
    else if (this.gear > 0) {
      const k = this.tune.redline * Math.max(this.vx, 0) * 3.6;
      this.manualShift(dir, k);
      return;
    } else return;
    this.shiftT = this.tune.shiftTime;
  }

  /** Reverse: a slow kinematic bicycle backwards. The brake pedal drives, the throttle stops the car. */
  protected stepReverse(dt: number, inp: DriveInput, kRoad: number): void {
    const t = this.tune;
    const L = t.cgToFront + t.cgToRear;
    this.rampSteer(dt, inp);
    this.steerAngle = this.steerIn * t.maxSteerLow;
    this.throttle = clamp(inp.brake, 0, 1);
    this.brake = clamp(inp.throttle, 0, 1);
    const v0 = this.vx;
    let vx = this.vx;
    if (vx > -REVERSE_MAX) vx = Math.max(-REVERSE_MAX, vx - this.throttle * REVERSE_ACC * dt);
    vx = Math.min(0, vx + (this.brake * t.brakeDecel + (this.handbrake ? HANDBRAKE_DECEL : 0)) * dt);
    if (this.throttle < 0.05) vx = moveTo(vx, 0, 0.8 * dt);
    this.vx = vx;
    this.vy = 0;
    this.r = (vx * Math.tan(this.steerAngle)) / L;
    this.accLong = (vx - v0) / dt;
    this.accLat = 0;
    this.rpm = t.idleRpm + (t.redline * 0.45 - t.idleRpm) * (-vx / REVERSE_MAX);
    const cp = Math.cos(this.psi);
    const sp = Math.sin(this.psi);
    const sDot = (vx * cp) / (1 - kRoad * this.d);
    this.s += sDot * dt;
    this.d += vx * sp * dt;
    this.psi += (this.r - kRoad * sDot) * dt;
    this.wheelSpin += (vx / 0.34) * dt;
    this.resolveWalls(dt);
    this.onShoulder = Math.abs(this.d) > ROAD_HALF;
  }

  /** Turn signal, horn and handbrake of this step; returns the handbrake. */
  protected controls(inp: DriveInput): boolean {
    this.blinker = inp.blinker ?? 0;
    this.horn = inp.horn === true;
    this.handbrake = inp.handbrake === true;
    return this.handbrake;
  }

  /**
   * Boost (Shift with the throttle down): extra push from a reserve that lasts about 4 s and refills
   * in about 14 s; once empty it starts again only with some reserve back. Returns the force, N.
   */
  protected updateBoost(dt: number, inp: DriveInput): number {
    const want = inp.boost === true && clamp(inp.throttle, 0, 1) > 0.3;
    this.boostOn = want && this.boost > (this.boostOn ? 0 : BOOST_RESTART);
    if (this.boostOn) this.boost = Math.max(0, this.boost - dt / BOOST_SECONDS);
    else this.boost = Math.min(1, this.boost + dt / BOOST_REFILL);
    return this.boostOn ? this.tune.mass * BOOST_ACC : 0;
  }

  /**
   * Manual gearbox request: up (not past top gear) or down, refused when the lower gear would take
   * the engine past the redline. One shift at a time. k: rpm in a gear = k / its top speed (km/h).
   */
  protected manualShift(dir: number, k: number): void {
    this.shiftRefused = false;
    const t = this.tune;
    if (dir === 0 || this.shiftT > 0) return;
    if (dir > 0 && this.gear === 0) {
      this.gear = -1;
      this.shiftT = t.shiftTime;
    } else if (dir > 0 && this.gear === -1) {
      this.gear = 1;
      this.shiftT = t.shiftTime;
    } else if (dir < 0 && this.gear === 1) {
      this.gear = -1;
      this.shiftT = t.shiftTime;
    } else if (dir < 0 && this.gear === -1 && Math.abs(this.vx) < 0.3) {
      this.gear = 0;
      this.shiftT = t.shiftTime;
    } else if (dir > 0 && this.gear > 0 && this.gear < t.gearTopKmh.length) {
      this.gear++;
      this.shiftT = t.shiftTime;
    } else if (dir < 0 && this.gear > 1) {
      if (k / t.gearTopKmh[this.gear - 2] > t.redline * 1.02) {
        this.shiftRefused = true;
        return;
      }
      this.gear--;
      // A blipped downshift is quicker than an upshift.
      this.shiftT = t.shiftTime * 0.6;
    }
  }

  protected rampSteer(dt: number, inp: DriveInput, pressScale = 1): void {
    const t = this.tune;
    const target = clamp(inp.steer, -1, 1);
    const releasing = Math.abs(target) < Math.abs(this.steerIn) || target * this.steerIn < 0;
    this.steerHold = target !== 0 && !releasing ? this.steerHold + dt : 0;
    const press = t.steerRate * pressScale * (0.4 + 0.6 * Math.min(1, this.steerHold / 0.15));
    const rate = inp.analog ? 14 : releasing ? t.steerReturn : press;
    this.steerIn = moveTo(this.steerIn, target, rate * dt);
  }

  /**
   * Traction control: the most rear-wheel thrust that still leaves the rear tires enough grip for the
   * cornering the driver asks for, cut further if the rear is already sliding. Without it, full throttle
   * below ~150 km/h used up the whole friction circle and the car pivoted instead of turning.
   */
  protected tractionLimit(v: number, delta: number, Fzr: number, L: number): number {
    const t = this.tune;
    const Dr0 = t.gripRear * Fzr;
    const raw = 0.95 * Dr0;
    if (t.tractionControl <= 0) return raw;
    const ayDemand = Math.min(t.gripFront * G, (v * v * Math.abs(Math.tan(delta))) / L);
    const fyrDemand = (t.mass * ayDemand * t.cgToFront) / L;
    let cap = 0.9 * Math.sqrt(Math.max(0, Dr0 * Dr0 - fyrDemand * fyrDemand));
    if (v > 2.5) {
      const slip = Math.abs(Math.atan2(this.vy - t.cgToRear * this.r, v));
      cap *= clamp(1 - (slip - 0.06) / 0.08, 0.15, 1);
    }
    return raw + (Math.min(raw, cap) - raw) * t.tractionControl;
  }

  protected resolveWalls(dt: number): void {
    const ext = this.halfExtentD();
    let side = 0;
    if (this.d + ext > WALL_D) {
      side = 1;
      this.d = WALL_D - ext;
    } else if (this.d - ext < -WALL_D) {
      side = -1;
      this.d = -WALL_D + ext;
    }
    const touching = side !== 0 || Math.abs(this.d) + ext > WALL_D - 0.05;
    this.wallHit = touching && this.wallFreeT >= WALL_REHIT;
    this.wallFreeT = touching ? 0 : this.wallFreeT + dt;
    this.wallImpact = 0;
    this.wallSide = side;
    if (side === 0) return;
    this.lastWallSide = side;

    let vA = this.vAlong;
    let vL = this.vLat;
    const into = vL * side;
    if (into > 0) {
      if (this.wallHit) this.wallImpact = into;
      vL = -side * into * 0.25;
      vA -= Math.sign(vA) * Math.min(Math.abs(vA), into * 0.8);
    }
    vA *= 1 - 0.35 * dt;
    if (this.psi * side > 0) this.psi -= this.psi * Math.min(1, 6 * dt);
    this.r *= 1 - Math.min(1, 8 * dt);
    this.setRoadVelocity(vA, vL);
  }
}
