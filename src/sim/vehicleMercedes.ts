import { DriftCar, driftTune, type DriftTune } from './vehicleDrift';

/** Approximate A45 S 4MATIC+ tune using the mod's advertised mass and output. */
export const mercedesTune: DriftTune = {
  ...driftTune,
  mass: 1605,
  cgToFront: 1.32,
  cgToRear: 1.36,
  length: 4.42,
  width: 1.85,
  powerKW: 495,
  gripFront: 1.28,
  // Planted off the throttle too (before: 1.3 / 1.04, lifting tucked the nose in by half again).
  gripRear: 1.35,
  tireB: 16,
  tireC: 1.42,
  aeroDrag: 0.46,
  rollingRes: 8,
  brakeDecel: 11.2,
  tractionControl: 0.92,
  redline: 7200,
  idleRpm: 850,
  gearTopKmh: [54, 82, 112, 148, 185, 225, 270, 325],
  torqueNm: 900,
  frontDrive: 0.32,
  torqueRpm: 2500,
  torqueLow: 0.58,
  fadeRpm: 6500,
  fadeLoss: 0.18,
  launchRpm: 3200,
  driveEff: 0.86,
  engineBrakeNm: 75,
  engineInertia: 0.16,
  wheelInertiaRear: 2.8,
  wheelInertiaFront: 2.8,
  wheelRadius: 0.34,
  kickdownRpm: 0.82,
  cgHeight: 0.49,
  trackWidth: 1.61,
  yawInertia: 0.96,
  loadLag: 0.075,
  rollFront: 0.59,
  loadSensitivity: 0.16,
  slipRatioPeak: 0.095,
  longGrip: 1.08,
  rearStiffness: 1.26,
  lsdLock: 0.92,
  brakeFront: 0.62,
  absSlip: 0.075,
  ebdSlip: 0.035,
  tcSlip: 0.1,
  escAssist: 0.9,
  escSlip: 0.2,
  escRange: 0.09,
  escSpeed: 35,
  escRelease: 0.25,
  escRate: 7,
  escLead: 0.1,
  escMoment: 5200,
  escCut: 0.72,
  steerGripScale: 1.35,
  lockUnder: 0.00055,
  steerRateSpeed: 25,
  counterSteer: 0.8,
  substeps: 4,
};

export class MercedesCar extends DriftCar {
  override readonly physicsId = 3;
  declare readonly tune: DriftTune;

  constructor() {
    super(mercedesTune);
  }
}
