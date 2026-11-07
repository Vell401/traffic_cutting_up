/*
 * Road layout and all gameplay tunables in one place.
 * The tune objects are mutable on purpose: the debug panel edits them live.
 */

export const LANES = 4;
/** Lane width, m (a little wider than the usual 3.75: room to cut between cars that drift in their lanes). */
export const LANE_W = 4;
/** Half width of the paved lanes (edge line). */
export const ROAD_HALF = (LANES * LANE_W) / 2;
export const SHOULDER = 2.5;
/** Lateral offset of the inner face of the concrete barrier. */
export const WALL_D = ROAD_HALF + SHOULDER;

/** Lane 0 is the leftmost (fast) lane; d grows to the driver's right. */
export const laneCenter = (lane: number): number => -ROAD_HALF + LANE_W * (lane + 0.5);

export const SIM_HZ = 120;

export const carTune = {
  mass: 1500,
  cgToFront: 1.25,
  cgToRear: 1.45,
  length: 4.6,
  width: 1.9,
  powerKW: 340,
  gripFront: 1.3,
  gripRear: 1.4,
  /** Simplified Pacejka shape: Fy = D·sin(C·atan(B·α)). */
  tireB: 15,
  tireC: 1.45,
  /** ½·ρ·Cd·A, N per (m/s)². */
  aeroDrag: 0.38,
  /** N per m/s. */
  rollingRes: 14,
  /** Full-brake deceleration, m/s² (still capped by tire grip). */
  // Strengthened twice (11 → 14.3 → 17.9): 100 → 0 km/h in about 21 m.
  brakeDecel: 17.9,
  /** Wheel angle at a standstill, rad. Above ~20 km/h grip-limited steering takes over. */
  maxSteerLow: 0.55,
  /** Full steering lock asks for this fraction of the grip limit, so the input feels the same at any speed. */
  steerGripScale: 1.5,
  /** Keyboard steering ramp, full lock per second (reached after ~0.15 s of holding; taps are gentler). */
  steerRate: 12,
  /** Self-centring speed when the key is released or reversed. */
  steerReturn: 24,
  /** Yaw follows the wheel and stops when it centres; kills snap oversteer (0..1). */
  yawAssist: 1,
  /** Cuts rear thrust so cornering grip survives full throttle (0 = off, 1 = full). */
  tractionControl: 0.9,
  redline: 7600,
  idleRpm: 900,
  /** Speed at the redline in each gear. */
  gearTopKmh: [70, 112, 155, 202, 255, 318],
  shiftTime: 0.14,
};
export type CarTune = typeof carTune;

export const trafficTune = {
  /** Cars per kilometre per lane. */
  density: 7,
  /** Desired speed range per lane, km/h (lane 0 = fast lane). */
  laneSpeedKmh: [
    [112, 132],
    [100, 120],
    [88, 106],
    [76, 94],
  ] as [number, number][],
  rudeShare: 0.08,
  /** Share of lane-change decisions that happen without a reason. */
  whim: 0.08,
  blinkerTime: 1.2,
  laneChangeTime: 3.2,
  idmT: 1.3,
  idmS0: 3,
  idmA: 1.5,
  idmB: 3,
};

export const scoreTune = {
  /** Below this speed nothing is scored and the combo timer runs twice as fast. */
  minSpeedKmh: 100,
  /** Lateral gap (m) under which a pass counts as a near miss. */
  nearGap: 1.0,
  minRelKmh: 20,
  splitGap: 1.3,
  comboTime: 4,
  multPerCombo: 0.25,
  multMax: 10,
  basePoints: 150,
  closeBonus: 450,
  splitPoints: 400,
  truckFactor: 1.5,
  speedPointsPerKmh: 0.12,
  /** After a crash the new run ignores further contacts for this long. */
  runGrace: 2,
};
