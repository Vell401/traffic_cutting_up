/** Traffic vehicle catalogue: hitbox size and mass for the sim; shapes live in render/trafficModels.ts by name. */

export interface VehicleSpec {
  name: string;
  truck: boolean;
  weight: number;
  len: number;
  wid: number;
  mass: number;
  lightY: number;
  colors: number[];
  cargoColors: number[];
  /** Lanes this vehicle may use (0 = fast lane). */
  lanes: number[];
}

const CAR_COLORS = [0xe9ebee, 0xdfe3e6, 0xa7adb5, 0x5a5f66, 0x16181b, 0x1d2a4a, 0x8e1b1b, 0xb9ab8f, 0x2f4f3a];
const CARGO = [0xd9dde2, 0xcfd4da, 0xbfc5cc];
const ALL = [0, 1, 2, 3];

export const VEHICLES: VehicleSpec[] = [
  {
    name: 'sedan', truck: false, weight: 10, len: 4.75, wid: 1.82, mass: 1500,
    lightY: 0.68, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'hatch', truck: false, weight: 22, len: 4.2, wid: 1.78, mass: 1300,
    lightY: 0.7, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'suv', truck: false, weight: 20, len: 4.7, wid: 1.9, mass: 1900,
    lightY: 0.9, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'minivan', truck: false, weight: 12, len: 4.85, wid: 1.85, mass: 1900,
    lightY: 0.8, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'boxTruck', truck: true, weight: 9, len: 8.2, wid: 2.35, mass: 7500,
    lightY: 0.95, colors: [0xf2f4f6, 0xdfe3e8, 0x2f5a9a, 0xc23a3a], cargoColors: CARGO, lanes: [2, 3],
  },
  {
    name: 'semi', truck: true, weight: 5, len: 14.5, wid: 2.5, mass: 18000,
    lightY: 1.0, colors: [0xf2f4f6, 0x9aa3ad, 0x2b2f36, 0x7a1f1f], cargoColors: CARGO, lanes: [2, 3],
  },
  // Append to preserve existing network spec indices; split the former sedan weight 30.
  {
    name: 'sedanClassic', truck: false, weight: 10, len: 4.75, wid: 1.82, mass: 1500,
    lightY: 0.68, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
  {
    name: 'sedanModern', truck: false, weight: 10, len: 4.75, wid: 1.82, mass: 1500,
    lightY: 0.68, colors: CAR_COLORS, cargoColors: [], lanes: ALL,
  },
];
