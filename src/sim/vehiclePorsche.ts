import { DriftCar, driftTune, type DriftTune } from './vehicleDrift';

/** 992 GT3 RS: rear-engine balance, 7-speed PDK and a road/track tyre tune.
 * Engine/mass/wheelbase follow Porsche's technical data; tyre/assistance values are game tuning.
 * https://newsroom.porsche.com/en/2022/products/porsche-911-gt3-rs-world-premiere-29177.html
 */
export const porscheTune: DriftTune = {
  ...driftTune,
  mass: 1450, length: 4.57, width: 1.9,
  cgToFront: 1.50, cgToRear: .957,
  powerKW: 386, torqueNm: 465, torqueRpm: 6300, torqueLow: .62,
  redline: 9000, idleRpm: 900, fadeRpm: 8500, fadeLoss: .035,
  gearTopKmh: [72, 119, 165, 207, 244, 281, 318],
  shiftTime: .085, launchRpm: 4300, driveEff: .91, kickdownRpm: .88,
  engineBrakeNm: 65, engineInertia: .12,
  wheelRadius: .349, wheelInertiaFront: 2.1, wheelInertiaRear: 2.5,
  frontDrive: 0, gripFront: 1.54, gripRear: 1.66,
  tireB: 17.5, tireC: 1.4, rearStiffness: 1.08, longGrip: 1.07,
  cgHeight: .43, trackWidth: 1.65, yawInertia: .94,
  loadLag: .065, rollFront: .48, loadSensitivity: .14,
  lsdLock: .86, tractionControl: 1, tcSlip: .085,
  brakeDecel: 15.8, brakeAssist: 1.0, brakeFront: .59,
  absSlip: .085, ebdSlip: .065, cbcCut: .7,
  steerRate: 14, steerReturn: 27, steerRateSpeed: 25,
  steerGripScale: 1.4, maxSteerLow: .51, lockUnder: .0003,
  counterSteer: .7, escAssist: .95, escSlip: .145, escRange: .085,
  escSpeed: 38, escMoment: 5400, escRate: 8, escLead: .12,
  aeroDrag: .54, rollingRes: 7,
  // Moderate road-mode aero; axle forces grow with v² instead of artificial yaw damping.
  downforceFront: .23, downforceRear: .37,
};

export class PorscheCar extends DriftCar {
  override readonly physicsId = 4;
  constructor() { super(porscheTune); }
}
