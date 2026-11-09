import { carTune, ROAD_HALF, type CarTune } from '../config';
import { G, clamp, moveTo } from '../core/math';
import { PlayerCar, type DriveInput } from './vehicle';
import { evaluateTMeasy } from './r34/chronoTMeasy';
import { SketchbookSpring, sketchbookKeyTarget } from './r34/sketchbookSteering';

export type R34Tune = CarTune & {
  torqueNm: number; torqueRpm: number; driveEff: number; engineBrakeNm: number;
  engineInertia: number; wheelInertia: number; wheelRadius: number; turboLag: number;
  cgHeight: number; trackWidth: number; loadLag: number; rollFront: number;
  loadSensitivity: number; slipRatioPeak: number; slipAnglePeak: number;
  longGrip: number; rearStiffness: number; lsdLock: number; brakeFront: number;
  /** Keyboard rack assistance, 0 = raw RWD. Never applies forces or edits body state. */
  steerAssist: number;
  /** Rack viscous damping multiplier (not body/yaw damping). */
  steerDamping: number;
  /** Full-key driver torque multiplier. No body slip or heading demand. */
  steerBias: number;
  /** Maximum actual road-wheel steering rate, rad/s. */
  rackRate: number;
  /** Caster/scrub geometry and road-wheel-equivalent inertia/centering spring. */
  mechanicalTrail: number;
  rackInertia: number;
  rackCentering: number;
};

/** Independent ~500 hp RB26 drift build: rear drive, plated LSD and 55-degree angle kit. */
export const r34Tune: R34Tune = {
  ...carTune, gearTopKmh: [100, 150, 205, 255, 300, 345],
  mass: 1510, length: 4.6, width: 1.79, cgToFront: 1.25, cgToRear: 1.415,
  powerKW: 375, torqueNm: 610, torqueRpm: 4200, driveEff: .89, engineBrakeNm: 48,
  engineInertia: .24, wheelInertia: 1.35, wheelRadius: .335, turboLag: .22,
  gripFront: 1.22, gripRear: 1.07, longGrip: 1.10,
  slipRatioPeak: .13913, slipAnglePeak: .14852, rearStiffness: 1.08,
  cgHeight: .49, trackWidth: 1.52, loadLag: .14, rollFront: .53, loadSensitivity: .16,
  lsdLock: .88, brakeDecel: 12, brakeFront: .65, aeroDrag: .47, rollingRes: 7,
  tractionControl: 0, yawAssist: 0,
  maxSteerLow: 55 * Math.PI / 180, steerGripScale: 1.15, steerRate: 5, steerReturn: 7,
  steerAssist: 1, steerDamping: .05, steerBias: 1, rackRate: 3.8,
  mechanicalTrail: .1, rackInertia: 7, rackCentering: 1300,
  redline: 8000, idleRpm: 900, shiftTime: .17,
};

const RPM = Math.PI / 30;

/**
 * Four-contact planar rigid body. Wheel torque creates longitudinal slip; combined slip spends
 * rear lateral capacity and the resulting contact moments rotate the body. No slip/heading/speed
 * equilibrium, artificial yaw moment, drift-state switch, road feedback or low-speed bicycle.
 */
export class R34Car extends PlayerCar {
  override readonly physicsId = 2;
  declare readonly tune: R34Tune;
  /** FL, FR, RL, RR angular velocities, rad/s. */
  readonly omega = [0, 0, 0, 0];
  axLag = 0;
  ayLag = 0;
  turbo = 0;
  /** Telemetry also round-trips, even before the next step. */
  slipRear = 0;
  slipAngleRear = 0;
  forceFront = 0;
  forceRear = 0;
  loadFront = 0;
  loadRear = 0;
  rearWheelspin = 0;
  /** Road-wheel equivalent rack angular velocity and contact torque, both rewindable. */
  rackVelocity = 0;
  rackTorque = 0;
  /** Sum of four external TMeasy aligning moments, included in the body yaw equation. */
  groundMoment = 0;
  readonly keySpring = new SketchbookSpring();

  constructor(tune: R34Tune = r34Tune) { super(tune); }
  override get stateSize(): number { return super.stateSize + 30; }
  override saveState(out: Float64Array, o = 0): number {
    o = super.saveState(out, o);
    for (const w of this.omega) out[o++] = w;
    for (const x of [this.axLag, this.ayLag, this.turbo, this.slipRear, this.slipAngleRear,
      this.forceFront, this.forceRear, this.loadFront, this.loadRear, this.rearWheelspin,
      +this.manual, this.blinker, +this.shiftRefused, +this.handbrake, +this.horn]) out[o++] = x;
    out[o++] = this.rackVelocity; out[o++] = this.rackTorque;
    out[o++] = this.groundMoment;
    return this.keySpring.save(out, o);
  }
  override loadState(src: ArrayLike<number>, o = 0): number {
    o = super.loadState(src, o);
    for (let i = 0; i < 4; i++) this.omega[i] = src[o++];
    this.axLag = src[o++]; this.ayLag = src[o++]; this.turbo = src[o++];
    this.slipRear = src[o++]; this.slipAngleRear = src[o++];
    this.forceFront = src[o++]; this.forceRear = src[o++];
    this.loadFront = src[o++]; this.loadRear = src[o++]; this.rearWheelspin = src[o++];
    this.manual = src[o++] !== 0; this.blinker = src[o++]; this.shiftRefused = src[o++] !== 0;
    this.handbrake = src[o++] !== 0; this.horn = src[o++] !== 0;
    this.rackVelocity = src[o++]; this.rackTorque = src[o++];
    this.groundMoment = src[o++];
    return this.keySpring.load(src, o);
  }
  override reset(s: number, d: number, speed: number): void {
    super.reset(s, d, speed);
    // Match the R34's broader, drift-oriented ratios rather than inheriting the shared 80%
    // spawn schedule (which would put an 80 km/h entry on first gear's wheel-speed limiter).
    this.gear = 1;
    while (this.gear < this.tune.gearTopKmh.length && Math.abs(speed) * 3.6 > this.tune.gearTopKmh[this.gear - 1] * .7) this.gear++;
    this.omega.fill(speed / this.tune.wheelRadius);
    this.axLag = this.ayLag = this.turbo = this.slipRear = this.slipAngleRear = 0;
    this.forceFront = this.forceRear = this.loadFront = this.loadRear = this.rearWheelspin = 0;
    this.rackVelocity = this.rackTorque = 0;
    this.groundMoment = 0;
    this.keySpring.reset();
    this.throttle = this.brake = this.accLong = this.accLat = this.wheelSpin = this.steerHold = 0;
    this.manual = this.shiftRefused = this.handbrake = this.horn = false;
    this.blinker = this.lastWallSide = this.wallImpact = 0;
    this.onShoulder = Math.abs(d) > ROAD_HALF;
    this.rpm = Math.max(this.tune.idleRpm, this.tune.redline * Math.abs(speed) * 3.6 / this.tune.gearTopKmh[this.gear - 1]);
  }

  engineTorque(rpm: number): number {
    const t = this.tune;
    const spool = clamp((rpm - t.idleRpm) / (t.torqueRpm - t.idleRpm), 0, 1);
    return Math.min(t.torqueNm * (.48 + .52 * spool * (2 - spool)), t.powerKW * 1000 / Math.max(rpm * RPM, 1));
  }

  override step(dt: number, inp: DriveInput, kRoad: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.prevS = this.s; this.prevD = this.d; this.prevPsi = this.psi;
    this.controls(inp); this.manual = inp.manual === true; this.shiftRefused = false;
    const stopped = this.speed < .18 && Math.abs(this.r) < .2;
    // Manual R(0) <-> N(-1) <-> 1..N follows the shared gearbox contract, but direction
    // changes use TOTAL speed/yaw rather than vx alone. Neutral never changes body velocity.
    if (this.manual) {
      const shift = inp.shift ?? 0;
      const reverseGate = (this.gear === -1 && shift < 0) || (this.gear === 0 && shift > 0);
      if (reverseGate && !stopped && this.shiftT <= 0) this.shiftRefused = true;
      else {
        const shaftSpeed = Math.abs((this.omega[2] + this.omega[3]) * .5) * this.tune.wheelRadius;
        this.manualShift(shift, this.tune.redline * shaftSpeed * 3.6);
      }
    } else if (stopped) {
      if (this.gear > 0 && inp.brake > .5 && inp.throttle < .05) {
        this.gear = 0; this.shiftT = 0;
      } else if (this.gear === 0 && inp.throttle > .1 && inp.brake < .05) {
        this.gear = 1; this.shiftT = 0;
      }
    }
    this.throttle = clamp(this.gear === 0 ? inp.brake : inp.throttle, 0, 1);
    this.brake = clamp(this.gear === 0 ? inp.throttle : inp.brake, 0, 1);
    // 480 Hz divides 30/60/120/240 Hz clients exactly; wheel contact is solved implicitly.
    const n = Math.max(1, Math.ceil(dt * 480 - 1e-9)), h = dt / n;
    for (let i = 0; i < n; i++) this.integrate(h, inp, kRoad);
    this.resolveWalls(dt);
    this.onShoulder = Math.abs(this.d) > ROAD_HALF;
  }

  private integrate(h: number, inp: DriveInput, kRoad: number): void {
    const t = this.tune, m = t.mass, a = t.cgToFront, b = t.cgToRear, L = a + b, R = t.wheelRadius;
    const reverse = this.gear === 0;
    if (inp.direct || inp.analog) this.steerIn = clamp(inp.steer, -1, 1);
    else this.rampSteer(h, inp);
    this.keySpring.target = inp.steer === 0 ? this.steerAngle
      : sketchbookKeyTarget(inp.steer, this.vx, this.vy, t.maxSteerLow,
        t.steerGripScale * (1 + .13 * (1 - Math.min(Math.abs(inp.steer), 1)))
          * Math.max(Math.abs(this.vx) / 25, .75));
    this.keySpring.simulate(h);
    if (inp.direct || inp.analog || reverse || t.steerAssist <= 0) {
      // Mouse/gamepad command an angle; keys command driver torque in the assisted rack.
      const target = this.steerIn * t.maxSteerLow;
      const next = moveTo(this.steerAngle, target, t.rackRate * h);
      this.rackVelocity = (next - this.steerAngle) / h;
      this.steerAngle = next;
    } else {
      // Hand pressure begins immediately; 65% of the requested motion retains Sketchbook's
      // weighty spring. Without this small preload a short counter-tap is lost in its cache lag.
      const preload = .2 + .15 * Math.min(Math.abs(inp.steer), 1);
      const handAngle = (1 - preload) * this.keySpring.position + preload * this.keySpring.target;
      const driverError = handAngle - this.steerAngle;
      // A newly reversed key cannot keep pushing the old direction while the spring catches up.
      const driver = inp.steer === 0 ? 0 : (inp.steer > 0 ? Math.max(0, driverError)
        : Math.min(0, driverError)) * (12000 * t.steerBias);
      // Column return assistance unloads near the steering stop, leaving final authority to
      // contact/caster torque. This is a rack-angle torque curve, never a body-slip target.
      const returnUnload = 1 + (this.steerAngle / (t.maxSteerLow * .73)) ** 8;
      const spring = -500 * Math.tanh(this.steerAngle * t.rackCentering / 500) / returnUnload;
      const damping = 55 + t.steerDamping * 200;
      // Semi-implicit physical rack; neutral has no velocity/heading-derived angle target.
      const acceleration = (this.rackTorque * t.steerAssist + driver + spring - damping * this.rackVelocity) / Math.max(.1, t.rackInertia);
      this.rackVelocity = clamp(this.rackVelocity + acceleration * h, -t.rackRate, t.rackRate);
      this.steerAngle = clamp(this.steerAngle + this.rackVelocity * h, -t.maxSteerLow, t.maxSteerLow);
      if (Math.abs(this.steerAngle) === t.maxSteerLow && this.rackVelocity * this.steerAngle > 0) this.rackVelocity = 0;
    }
    const cd = Math.cos(this.steerAngle), sd = Math.sin(this.steerAngle);

    this.shiftT = Math.max(0, this.shiftT - h);
    if (!this.manual && this.gear > 0 && this.shiftT === 0) {
      // Road-speed schedule: spinning tyres alone do not shift out of an intentional burnout.
      const k = t.redline * Math.max(this.vx, 0) * 3.6;
      if (k / t.gearTopKmh[this.gear - 1] > t.redline * .94 && this.gear < t.gearTopKmh.length && this.throttle > .1) {
        this.gear++; this.shiftT = t.shiftTime;
      } else if (this.gear > 1) {
        const lowerRatio = t.redline * RPM * R * 3.6 / t.gearTopKmh[this.gear - 2];
        const lowerRpm = Math.abs((this.omega[2] + this.omega[3]) * .5) * lowerRatio / RPM;
        // A sideways car can have small body vx but a loaded, fast-spinning driveline.
        if (lowerRpm < t.redline * .58) this.gear--;
      }
    }
    const ratio = this.gear === -1 ? 0 : reverse ? t.redline * RPM * R / 7 : t.redline * RPM * R * 3.6 / t.gearTopKmh[this.gear - 1];
    const wr = (this.omega[2] + this.omega[3]) * .5, rpmW = Math.abs(wr) * ratio / RPM;
    this.turbo += (this.throttle - this.turbo) * (1 - Math.exp(-h / Math.max(.01, t.turboLag)));
    const connected = this.gear !== -1 && !inp.clutch && !this.handbrake && this.shiftT <= 0;
    if (connected) {
      this.rpm = clamp(Math.max(rpmW, (this.gear <= 1 ? 900 + this.throttle * 2300 : t.idleRpm)), t.idleRpm, t.redline);
    } else {
      // Free engine angular dynamics, carried by the base serialized rpm field. Clutch/neutral
      // cannot transmit either this torque or this crank inertia to the tyre contact solve.
      const fuel = clamp((t.redline - this.rpm) / (t.redline * .04), 0, 1);
      const crank = this.throttle * this.engineTorque(this.rpm) * (.6 + .4 * this.turbo) * fuel
        - t.engineBrakeNm * (.25 + .75 * this.rpm / t.redline);
      this.rpm = clamp(this.rpm + h * crank / (Math.max(t.engineInertia, .02) * RPM), t.idleRpm, t.redline);
    }
    const boostF = this.updateBoost(h, reverse || !connected ? { ...inp, boost: false } : inp);
    const limiter = clamp((t.redline * 1.025 - rpmW) / (t.redline * .04), 0, 1);
    const drive = !connected ? 0 : this.throttle * this.engineTorque(this.rpm) * (.6 + .4 * this.turbo)
      * t.driveEff * ratio * limiter;
    const drag = !connected ? 0 : (1 - this.throttle) * t.engineBrakeNm * this.rpm / t.redline * ratio;
    const tc = 1 / (1 + Math.max(0, this.slipRear - .13) * (inp.tractionControlEnabled === false ? 0 : t.tractionControl) * 20);
    const axleTorque = (reverse ? -1 : 1) * (drive * tc + (connected ? boostF * R * limiter : 0)) - Math.sign(wr) * drag;
    // Equal/opposite shaft torques conserve drive torque; locking cannot create body yaw itself.
    const lockLimit = 80 + Math.abs(axleTorque) * .45;
    const diff = clamp((this.omega[3] - this.omega[2]) * t.lsdLock * 65, -lockLimit, lockLimit);
    const longTransfer = clamp(m * this.axLag * t.cgHeight / L, -m * G * .35, m * G * .35);
    const fzF = m * G * b / L - longTransfer, fzR = m * G - fzF;
    this.loadFront = fzF; this.loadRear = fzR;
    const latTransfer = m * this.ayLag * t.cgHeight / t.trackWidth;
    let fx = -t.aeroDrag * this.vx * this.speed - t.rollingRes * this.vx, fy = 0, mz = 0;
    this.forceFront = this.forceRear = this.slipRear = this.rearWheelspin = this.rackTorque = this.groundMoment = 0;
    for (let i = 0; i < 4; i++) {
      const front = i < 2, side = i % 2 === 0 ? -1 : 1;
      const x = front ? a : -b, y = side * t.trackWidth * .5;
      const u = this.vx - this.r * y, v = this.vy + this.r * x;
      const uw = front ? u * cd + v * sd : u, vw = front ? -u * sd + v * cd : v;
      const axleLoad = front ? fzF : fzR;
      const transfer = clamp(latTransfer * (front ? t.rollFront : 1 - t.rollFront), -axleLoad * .48, axleLoad * .48);
      const fz = axleLoad * .5 - side * transfer;
      const nominal = m * G * (front ? b : a) / L * .5;
      const den = Math.max(Math.abs(uw), 3);
      const sy = -vw / den;
      const options = { mu: .8 * (front ? t.gripFront : t.gripRear)
          * Math.pow(Math.max(fz / nominal, .05), -t.loadSensitivity),
        longitudinalScale: t.longGrip, longitudinalSlipScale: t.slipRatioPeak / .13913,
        lateralSlipScale: t.slipAnglePeak / .14852, stiffnessScale: front ? 1 : t.rearStiffness,
        // Geometry from vertical tyre deflection (220 kN/m), not a fabricated Mz signal.
        contactPatchLength: 2 * Math.sqrt(R * Math.max(0, fz) / 220000) };
      const torque = front ? 0 : axleTorque * .5 + (i === 2 ? diff : -diff);
      const inertia = t.wheelInertia + (front || !connected ? 0 : t.engineInertia * ratio * ratio * .5);
      const brakeTorque = this.brake * m * t.brakeDecel * R * (front ? t.brakeFront : 1 - t.brakeFront) * .5;
      const kap0 = (this.omega[i] * R - uw) / den;
      // ABS modulates brake pressure; it never clamps slip or body velocity.
      const abs = this.speed > 2 ? clamp((kap0 * Math.sign(uw || 1) + .23) / .11, 0, 1) : 1;
      const braking = brakeTorque * abs + (!front && this.handbrake ? 3600 : 0);
      const free = this.omega[i] + h * torque / inertia;
      // Implicit contact/wheel solve with a Coulomb brake (proximal zero-speed hold).
      // This avoids stiff low-speed oscillation without a kinematic or velocity override.
      let w = this.omega[i];
      for (let j = 0; j < 8; j++) {
        const tire = evaluateTMeasy((w * R - uw) / den, sy, fz, nominal, options);
        const targetW = moveTo(free - h * R * tire.fx / inertia, 0, h * braking / inertia);
        const slope = targetW === 0 ? 0 : Math.max(0, tire.dfxDsx);
        const dw = (targetW - w) / (1 + h * R * R * slope / (den * inertia));
        w += dw;
        if (Math.abs(dw) < 1e-9) break;
      }
      this.omega[i] = w;
      const kappa = (w * R - uw) / den;
      const tire = evaluateTMeasy(kappa, sy, fz, nominal, options);
      const tx = tire.fx, ty = tire.fy;
      const bx = front ? tx * cd - ty * sd : tx, by = front ? tx * sd + ty * cd : ty;
      fx += bx; fy += by; mz += x * by - y * bx + tire.mz;
      this.groundMoment += tire.mz;
      if (front) {
        this.forceFront += by;
        this.rackTorque += tire.mz - t.mechanicalTrail * ty;
      }
      else { this.forceRear += by; this.slipRear += kappa * .5; this.rearWheelspin += (w * R - uw) * .5; }
    }
    this.slipAngleRear = Math.atan2(this.vy - b * this.r, Math.max(Math.abs(this.vx), .5));
    this.accLong = fx / m; this.accLat = fy / m;
    const lag = 1 - Math.exp(-h / Math.max(.01, t.loadLag));
    this.axLag += (this.accLong - this.axLag) * lag; this.ayLag += (this.accLat - this.ayLag) * lag;
    // Same inertia as the existing contact solver: m*a*b. No hidden angular damping.
    const nextR = this.r + mz / (m * a * b) * h, turn = (this.r + nextR) * .5 * h;
    const vx = this.vx + fx / m * h, vy = this.vy + fy / m * h;
    // Exact rotating-frame transport conserves world momentum when contact forces vanish.
    this.vx = vx * Math.cos(turn) + vy * Math.sin(turn);
    this.vy = -vx * Math.sin(turn) + vy * Math.cos(turn);
    this.r = nextR;
    const sDot = this.vAlong / Math.max(.2, 1 - kRoad * this.d);
    this.s += sDot * h; this.d += this.vLat * h; this.psi += turn - kRoad * sDot * h;
    this.wheelSpin += (this.omega[2] + this.omega[3]) * .5 * h;
  }

}
