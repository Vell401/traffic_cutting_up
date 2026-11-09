import { clamp } from '../core/math';
import { DriftCar, driftTune, type DriftTune } from './vehicleDrift';
import type { DriveInput } from './vehicle';

/** Default c63amg_dorest.pc, not the Performance/507 variants.
 * Source: mods_to_convert/MercedesW204/vehicles/c63w204kene/*.jbeam.
 * The source uses reused 4.4-petrol part names: normalize its torque shape to the
 * stock M156's nominal 610 Nm / 336 kW rather than importing its inflated output.
 * Mass is provisional; tyre, balance and assistance coefficients are game tuning.
 */
export const W204_GEARS = [4.37, 2.86, 1.92, 1.37, 1, .82, .73] as const;
export const W204_REVERSE = 3.41;
export const W204_FINAL_DRIVE = 3.231;
export const w204Tune: DriftTune = {
  ...driftTune,
  mass: 1800, length: 4.70, width: 1.8,
  cgToFront: 1.3248, cgToRear: 1.4352, // provisional 52/48, wheelbase 2.76 m
  powerKW: 336, torqueNm: 610, torqueRpm: 5000, torqueLow: .45,
  redline: 7200, idleRpm: 750, fadeRpm: 6800, fadeLoss: 0,
  wheelRadius: .325,
  gearTopKmh: W204_GEARS.map(r => 7200 * Math.PI / 30 * .325 * 3.6 / (r * W204_FINAL_DRIVE)),
  shiftTime: .18, launchRpm: 2200, driveEff: .88, kickdownRpm: .84,
  engineInertia: .16, engineBrakeNm: 46,
  wheelInertiaFront: 2.4, wheelInertiaRear: 3,
  frontDrive: 0, gripFront: 1.12, gripRear: 1.25,
  rearStiffness: 1.3, longGrip: 1.06,
  cgHeight: .51, trackWidth: 1.57, yawInertia: 1.03,
  loadLag: .1, rollFront: .56, lsdLock: .8,
  brakeDecel: 12.5, brakeAssist: 1.2, brakeFront: .64,
  steerGripScale: 1.65, maxSteerLow: .55, steerRateSpeed: 22,
  aeroDrag: .46, rollingRes: 7,
};

// Original base-engine JBeam samples (before intake/exhaust/friction modifiers).
const TORQUE = [[0, 0], [500, 260], [1000, 332.7], [1500, 469.1],
  [2000, 537.3], [2500, 578.2], [3000, 605.5], [3500, 624.9],
  [4000, 639.5], [4500, 650.9], [5000, 660], [5500, 633.4],
  [6000, 564.7], [6500, 523.6], [7000, 481], [7200, 447.1]] as const;

export class W204Car extends DriftCar {
  override readonly physicsId = 5;
  constructor() { super(w204Tune); }

  override engineTorque(rpm: number): number {
    const r = clamp(rpm, 0, this.tune.redline);
    let raw: number = TORQUE[TORQUE.length - 1][1];
    for (let i = 1; i < TORQUE.length; i++) {
      const [hi, tq] = TORQUE[i], [lo, prev] = TORQUE[i - 1];
      if (r <= hi) { raw = prev + (tq - prev) * (r - lo) / (hi - lo); break; }
    }
    return Math.min(raw * this.tune.torqueNm / 660, this.tune.powerKW * 1000 / Math.max(1, r * Math.PI / 30));
  }

  protected override stepReverse(dt: number, inp: DriveInput, kRoad: number): void {
    // Keep the game's low-speed parking reverse; use the actual 7AT ratio for instruments/audio.
    super.stepReverse(dt, inp, kRoad);
    this.rpm = clamp(Math.abs(this.vx) / this.tune.wheelRadius * W204_REVERSE * W204_FINAL_DRIVE * 30 / Math.PI,
      this.tune.idleRpm, this.tune.redline);
  }
}
