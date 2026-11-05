/** Traffic vehicle catalogue. Size data is shared by the sim (hitboxes) and the grey-box renderer. */

/** Visual box relative to the vehicle centre: base height y, centre offset z (positive = toward the rear). */
export interface Box {
  w: number;
  h: number;
  l: number;
  y: number;
  z: number;
}

export interface VehicleSpec {
  name: string;
  truck: boolean;
  weight: number;
  len: number;
  wid: number;
  mass: number;
  /** box1: body (or truck cab), box2: cabin glass (or cargo). */
  box1: Box;
  box2: Box;
  /** box2 is tinted glass rather than a painted cargo box. */
  glassTop: boolean;
  lightY: number;
  colors: number[];
  cargoColors: number[];
  /** Lanes this vehicle may use (0 = fast lane). */
  lanes: number[];
}

const CAR_COLORS = [0xe9ebee, 0xdfe3e6, 0xa7adb5, 0x5a5f66, 0x16181b, 0x1d2a4a, 0x8e1b1b, 0xb9ab8f, 0x2f4f3a];
const CARGO = [0xf2f4f6, 0xe6e9ec, 0xd5d9de];
const ALL = [0, 1, 2, 3];

export const VEHICLES: VehicleSpec[] = [
  {
    name: 'sedan', truck: false, weight: 30, len: 4.75, wid: 1.82, mass: 1500,
    box1: { w: 1.82, h: 0.62, l: 4.75, y: 0.22, z: 0 },
    box2: { w: 1.56, h: 0.5, l: 2.4, y: 0.84, z: 0.25 },
    glassTop: true, lightY: 0.68, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'hatch', truck: false, weight: 22, len: 4.2, wid: 1.78, mass: 1300,
    box1: { w: 1.78, h: 0.62, l: 4.2, y: 0.2, z: 0 },
    box2: { w: 1.56, h: 0.56, l: 2.3, y: 0.82, z: 0.45 },
    glassTop: true, lightY: 0.7, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'suv', truck: false, weight: 20, len: 4.7, wid: 1.9, mass: 1900,
    box1: { w: 1.9, h: 0.8, l: 4.7, y: 0.3, z: 0 },
    box2: { w: 1.7, h: 0.62, l: 2.9, y: 1.1, z: 0.35 },
    glassTop: true, lightY: 0.9, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'minivan', truck: false, weight: 12, len: 4.85, wid: 1.85, mass: 1900,
    box1: { w: 1.85, h: 0.75, l: 4.85, y: 0.22, z: 0 },
    box2: { w: 1.7, h: 0.85, l: 3.6, y: 0.97, z: 0.3 },
    glassTop: true, lightY: 0.8, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'boxTruck', truck: true, weight: 9, len: 8.2, wid: 2.35, mass: 7500,
    box1: { w: 2.2, h: 1.9, l: 2.0, y: 0.45, z: -3.1 },
    box2: { w: 2.35, h: 2.6, l: 6.0, y: 0.9, z: 1.05 },
    glassTop: false, lightY: 0.95, colors: [0xf2f4f6, 0xdfe3e8, 0x2f5a9a, 0xc23a3a], cargoColors: CARGO, lanes: [2, 3],
  },
  {
    name: 'semi', truck: true, weight: 5, len: 14.5, wid: 2.5, mass: 18000,
    box1: { w: 2.45, h: 2.6, l: 2.4, y: 0.5, z: -6.05 },
    box2: { w: 2.5, h: 2.9, l: 11.6, y: 1.1, z: 1.4 },
    glassTop: false, lightY: 1.0, colors: [0xf2f4f6, 0x9aa3ad, 0x2b2f36, 0x7a1f1f], cargoColors: CARGO, lanes: [2, 3],
  },
];
