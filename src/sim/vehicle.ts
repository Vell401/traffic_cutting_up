import { carTune, WALL_D, ROAD_HALF, type CarTune } from '../config';
import { G, clamp, moveTo } from '../core/math';

export interface DriveInput {
  /** -1 (left) .. 1 (right) */
  steer: number;
  throttle: number;
  brake: number;
  /** Analog stick: follow the input almost directly instead of the keyboard ramp. */
  analog?: boolean;
}

/** Time constant of the heading align assist, s. */
const ALIGN_TAU = 0.3;
/** A barrier contact counts as a new hit only after this long away from the wall. */
const WALL_REHIT = 0.5;

const magicFormula = (alpha: number, B: number, C: number): number => Math.sin(C * Math.atan(B * alpha));

/*
 * Player car: dynamic bicycle model integrated directly in road (Frenet) coordinates.
 *   s   – distance along the road centre line
 *   d   – lateral offset, positive to the right
 *   psi – heading relative to the road, positive = pointing right
 *   vx, vy – body-frame velocity (forward, right); r – yaw rate (positive = turning right)
 */
export class PlayerCar {
  readonly tune: CarTune = carTune;

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
  private wallFreeT = WALL_REHIT;

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
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
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

    const L = t.cgToFront + t.cgToRear;
    const m = t.mass;
    const Iz = m * t.cgToFront * t.cgToRear;
    const v = Math.max(this.vx, 0);

    // Steering: ramped input, lock limited so full input ≈ grip limit at any speed.
    const target = clamp(inp.steer, -1, 1);
    const releasing = Math.abs(target) < Math.abs(this.steerIn) || target * this.steerIn < 0;
    const rate = inp.analog ? 12 : releasing ? t.steerReturn : t.steerRate;
    this.steerIn = moveTo(this.steerIn, target, rate * dt);
    const gripSteer = (t.steerGripScale * t.gripFront * G * L) / Math.max(v * v, 1);
    this.steerAngle = this.steerIn * Math.min(t.maxSteerLow, gripSteer);
    const delta = this.steerAngle;
    const aligning = t.alignAssist > 0 && Math.abs(this.steerIn) < 0.05;

    this.throttle = clamp(inp.throttle, 0, 1);
    this.brake = clamp(inp.brake, 0, 1);

    // Drivetrain: power-limited thrust, automatic gearbox with a short torque cut on upshifts.
    const gears = t.gearTopKmh;
    const gearTop = gears[this.gear - 1] / 3.6;
    this.rpm = Math.max(t.idleRpm, (t.redline * v) / gearTop);
    if (this.shiftT > 0) {
      this.shiftT -= dt;
    } else if (this.rpm > t.redline * 0.97 && this.gear < gears.length && this.throttle > 0.1) {
      this.gear++;
      this.shiftT = t.shiftTime;
    } else if (this.gear > 1 && (t.redline * v) / (gears[this.gear - 2] / 3.6) < t.redline * 0.6) {
      this.gear--;
    }
    const limiter = this.gear === gears.length && this.rpm >= t.redline;
    const Fzf = (m * G * t.cgToRear) / L;
    const Fzr = (m * G * t.cgToFront) / L;
    let drive = 0;
    if (this.shiftT <= 0 && !limiter) {
      drive = this.throttle * Math.min((t.powerKW * 1000) / Math.max(v, 6), t.gripRear * Fzr * 0.95);
    }
    const brakeF = this.brake * m * t.brakeDecel;
    const resist = t.aeroDrag * v * v + t.rollingRes * v;

    if (v > 2.5) {
      const fxRear = drive - brakeF * 0.4;
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

      const fx = fxRear + fxFront * cosd - Fyf * sind - resist;
      const fyFront = Fyf * cosd + fxFront * sind;
      const ax = fx / m + this.vy * this.r;
      const ay = (fyFront + Fyr) / m - v * this.r;
      let rdot = (t.cgToFront * fyFront - t.cgToRear * Fyr) / Iz;

      // Assists. Steering: pull the yaw rate toward the kinematic one (sharp turn-in, no snap oversteer).
      // Released: turn the car back along the road and kill the sideways drift, like a driver catching it.
      if (aligning) {
        const rDes = clamp(kRoad * v - this.psi / ALIGN_TAU, -0.8, 0.8);
        rdot += t.alignAssist * 12 * (rDes - this.r);
      } else {
        const latLimit = (t.gripFront * G) / Math.max(v, 1);
        const rKin = clamp((v * Math.tan(delta)) / L, -latLimit, latLimit);
        rdot += t.yawAssist * 10 * (rKin - this.r);
      }

      this.vx += ax * dt;
      this.vy += ay * dt;
      this.r += rdot * dt;
      if (aligning) {
        const vyRoad = -this.vx * Math.tan(this.psi);
        this.vy += (vyRoad - this.vy) * (1 - Math.exp(-3 * t.alignAssist * dt));
      }
      this.accLong = fx / m;
      this.accLat = (fyFront + Fyr) / m;
    } else {
      // Low speed: kinematic bicycle, the tire model is singular near standstill.
      const fx = drive - resist;
      this.vx += (fx / m) * dt;
      this.vx = Math.max(0, this.vx - this.brake * t.brakeDecel * dt);
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

  private resolveWalls(dt: number): void {
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
