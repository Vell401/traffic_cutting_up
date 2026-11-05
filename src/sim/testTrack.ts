import type { CurveStep, RoadScript, SectionStep } from './road';

/*
 * Test showcases: short, finite tracks that each show one road element (or everything in a row).
 * Each starts with a little open road, shows the element and ends at a road-end barrier where the
 * car is brought to a stop. Picked from the test panel.
 */
const R = (radius: number) => 1 / radius;

const GENTLE: CurveStep[] = [
  { len: 250, k0: 0, k1: 0 },
  { len: 150, k0: 0, k1: R(1800) },
  { len: 300, k0: R(1800), k1: R(1800) },
  { len: 150, k0: R(1800), k1: 0 },
  { len: 5000, k0: 0, k1: 0 },
];
const S_BEND: CurveStep[] = [
  { len: 200, k0: 0, k1: 0 },
  { len: 150, k0: 0, k1: -R(1300) },
  { len: 200, k0: -R(1300), k1: -R(1300) },
  { len: 300, k0: -R(1300), k1: R(1500) },
  { len: 200, k0: R(1500), k1: R(1500) },
  { len: 150, k0: R(1500), k1: 0 },
  { len: 5000, k0: 0, k1: 0 },
];
const STRAIGHT: CurveStep[] = [{ len: 10000, k0: 0, k1: 0 }];

export interface Showcase {
  id: string;
  name: string;
  script: RoadScript;
}

const show = (id: string, name: string, sections: SectionStep[], curves = GENTLE): Showcase => ({ id, name, script: { sections, curves } });

export const SHOWCASES: Showcase[] = [
  show('open-sodium', 'Открытая трасса · натрий', [{ kind: 'open', light: 'sodium', chunks: 7 }]),
  show('open-led', 'Открытая трасса · LED', [{ kind: 'open', light: 'led', chunks: 8 }], S_BEND),
  show('gantry', 'Рамы с указателями', [{ kind: 'open', light: 'sodium', chunks: 6, gantry: [2, 4] }], STRAIGHT),
  show('overpass', 'Путепровод', [{ kind: 'open', light: 'led', chunks: 6, overpass: [3] }], STRAIGHT),
  show('walls', 'Шумозащитные стены', [
    { kind: 'open', light: 'sodium', chunks: 2 },
    { kind: 'walls', light: 'sodium', chunks: 5 },
    { kind: 'open', light: 'sodium', chunks: 1 },
  ]),
  show('viaduct', 'Эстакада', [
    { kind: 'open', light: 'led', chunks: 2 },
    { kind: 'viaduct', light: 'led', chunks: 6, gantry: [3] },
    { kind: 'open', light: 'led', chunks: 2 },
  ]),
  show('tunnel-sodium', 'Тоннель · натрий', [
    { kind: 'open', light: 'sodium', chunks: 2 },
    { kind: 'tunnel', light: 'sodium', chunks: 5 },
    { kind: 'open', light: 'sodium', chunks: 2 },
  ], STRAIGHT),
  show('tunnel-led', 'Тоннель · LED', [
    { kind: 'open', light: 'led', chunks: 2 },
    { kind: 'tunnel', light: 'led', chunks: 5 },
    { kind: 'open', light: 'led', chunks: 2 },
  ], S_BEND),
  show('bridge', 'Большой мост', [
    { kind: 'open', light: 'led', chunks: 1 },
    { kind: 'viaduct', light: 'led', chunks: 3 },
    { kind: 'bridge', light: 'led', chunks: 8 },
    { kind: 'viaduct', light: 'led', chunks: 3 },
    { kind: 'open', light: 'led', chunks: 1 },
  ], STRAIGHT),
  show('all', 'Всё подряд (~4 км)', [
    { kind: 'open', light: 'sodium', chunks: 3, gantry: [1] },
    { kind: 'open', light: 'led', chunks: 3, overpass: [1] },
    { kind: 'walls', light: 'sodium', chunks: 3 },
    { kind: 'viaduct', light: 'led', chunks: 3 },
    { kind: 'bridge', light: 'sodium', chunks: 7 },
    { kind: 'viaduct', light: 'sodium', chunks: 3, gantry: [1] },
    { kind: 'open', light: 'sodium', chunks: 2 },
    { kind: 'tunnel', light: 'sodium', chunks: 4 },
    { kind: 'open', light: 'led', chunks: 2 },
    { kind: 'tunnel', light: 'led', chunks: 3 },
    { kind: 'walls', light: 'led', chunks: 3, gantry: [1] },
    { kind: 'open', light: 'led', chunks: 2 },
  ], S_BEND),
];
