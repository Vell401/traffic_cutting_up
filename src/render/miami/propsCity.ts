import * as THREE from 'three';
import { Model } from './propKit';

/*
 * Code-built buildings and port equipment: what gives the Miami districts different faces.
 *
 *   Downtown / Bayfront  round glass tower, balconied condo slab, stepped Deco tower, parking deck
 *   South Beach / Wynwood  Deco corner cafe, arcaded shops, painted warehouse loft
 *   Coral Gables / Grove   tiled bungalow with an arched porch, flat-roofed modern villa with a pool
 *   Port                   container ship, yard gantry, transit shed, tank farm, light mast, cruise terminal
 *
 * Front is -Z; the origin is the centre of the footprint at ground (or keel) level.
 */

export const CITY_PROPS = [
  'tower_round', 'tower_slab', 'tower_deco', 'garage',
  'cafe', 'arcade', 'loft', 'bungalow', 'villa_modern',
  'cargo_ship', 'rtg', 'shed', 'tanks', 'mast', 'terminal',
] as const;

/** Round glass tower on a podium, a white band at every floor, a stepped crown. */
function towerRound(): Model {
  const m = new Model();
  m.box('white', 36, 9, 30, 0, 4.5, 0);
  m.box('glass', 36.3, 4.2, 30.3, 0, 4.4, 0);
  m.cylinder('glass', 13, 13, 88, 0, 53, 0, 20);
  for (let y = 11; y <= 97; y += 3.6) m.ring('white', 13.22, 0.42, 0, y, 0);
  m.cylinder('white', 10.5, 13.3, 3, 0, 98.5, 0, 20);
  m.cylinder('glass', 8, 8, 6, 0, 103, 0, 16);
  m.cylinder('white', 8.4, 8.4, 0.6, 0, 106.3, 0, 16);
  m.cylinder('steel', 0.12, 0.5, 14, 0, 113.5, 0, 6);
  return m;
}

/** Beachfront condominium slab: a glass front behind thirty floors of white balcony. */
function towerSlab(): Model {
  const m = new Model();
  m.box('paint', 32, 100, 15, 0, 50, 1);
  m.box('glass', 31, 97, 0.4, 0, 51, -6.6);
  for (let y = 4.2; y < 100; y += 3.4) m.box('white', 33.6, 0.3, 3.4, 0, y, -7.9);
  for (const x of [-16.5, 16.5]) m.box('white', 0.7, 102, 18.6, x, 51, -0.3);
  for (const x of [-9, 0, 9]) m.box('glass', 5, 94, 0.3, x, 50, 8.6);
  m.box('white', 22, 4.5, 10, 0, 102.2, 1);
  m.box('white', 34, 6, 22, 0, 3, -1);
  m.box('glass', 30, 3.6, 0.3, 0, 2.6, -12.1);
  return m;
}

/** Stepped Art Deco tower: four set-back tiers, vertical window strips, a fin and a needle. */
function towerDeco(): Model {
  const m = new Model();
  const tiers: [number, number, number, number][] = [[30, 15, 22, 0], [24, 21, 18, 15], [18, 16, 14, 36], [11, 9, 9.5, 52]];
  for (const [w, h, d, y] of tiers) {
    m.box('paint', w, h, d, 0, y + h / 2, 0);
    m.box('white', w + 0.7, 0.55, d + 0.7, 0, y + h + 0.1, 0);
    const strips = Math.max(2, Math.round(w / 4.5));
    for (let k = 0; k < strips; k++) {
      const x = (k - (strips - 1) / 2) * (w / strips);
      m.box('glass', 1.7, h - 3.2, 0.3, x, y + h / 2 + 0.3, -d / 2 - 0.06);
      m.box('glass', 1.7, h - 3.2, 0.3, x, y + h / 2 + 0.3, d / 2 + 0.06);
    }
    for (const x of [-w / 2 - 0.06, w / 2 + 0.06]) for (const z of [-d / 4, d / 4]) m.box('glass', 0.3, h - 3.2, 1.7, x, y + h / 2 + 0.3, z);
  }
  m.box('coral', 2.4, 44, 1.3, 0, 36, -11.4);
  m.box('white', 5, 3, 5, 0, 62.5, 0);
  m.cylinder('white', 0.12, 0.8, 13, 0, 70.5, 0, 6);
  return m;
}

/** Open-deck car park: slabs, parapets and columns around a shadowed interior, a painted stair tower. */
function garage(): Model {
  const m = new Model();
  m.box('dark', 36.4, 16.2, 26.4, 0, 8.3, 0);
  for (let k = 0; k <= 5; k++) {
    const y = k * 3.3;
    m.box('white', 38, 0.45, 28, 0, y + 0.22, 0);
    if (k === 0) continue;
    for (const z of [-14, 14]) m.box('ivory', 38.2, 1.05, 0.3, 0, y + 0.95, z);
    for (const x of [-19, 19]) m.box('ivory', 0.3, 1.05, 28.2, x, y + 0.95, 0);
  }
  for (const x of [-18.5, -9.2, 0, 9.2, 18.5]) for (const z of [-13.5, 13.5]) m.box('white', 0.9, 16.5, 0.9, x, 8.25, z);
  m.box('paint', 6.5, 21, 6.5, -16, 10.5, -11.5);
  m.box('glass', 2.2, 18, 0.3, -16, 11, -14.8);
  m.box('white', 7.1, 0.6, 7.1, -16, 21.3, -11.5);
  return m;
}

/** Deco corner cafe: a round bay, eyebrow ledges, a striped awning and a sign fin. */
function cafe(): Model {
  const m = new Model();
  m.box('paint', 19, 8, 13, 2.5, 4, 0.5);
  m.cylinder('paint', 6.2, 6.2, 8, -7, 4, -0.5, 12);
  for (const y of [3.9, 8.1]) {
    m.box('white', 19.7, 0.35, 13.7, 2.5, y, 0.5);
    m.cylinder('white', 6.75, 6.75, 0.35, -7, y, -0.5, 12);
  }
  m.box('glass', 16.5, 2.7, 0.25, 3.2, 1.75, -6.05);
  m.ring('glass', 6.28, 2.7, -7, 1.75, -0.5, 12);
  for (const x of [-3, 1.5, 6, 10.5]) m.box('glass', 2.6, 1.7, 0.25, x, 6.1, -6.05);
  m.ring('glass', 6.28, 1.7, -7, 6.1, -0.5, 12);
  // Striped awning over the terrace.
  for (let k = 0; k < 10; k++) m.slab(k % 2 ? 'white' : 'coral', 1.65, 0.12, 2.6, -4.6 + k * 1.65, 3.25, -7.5, 0.22);
  m.box('teal', 0.55, 7.5, 2.4, 9.5, 10.2, -5.2);
  m.box('white', 0.75, 0.5, 2.8, 9.5, 14.1, -5.2);
  m.box('white', 5, 1.2, 4, 4, 9, 2);
  return m;
}

/** Mediterranean shop arcade: a colonnade of round arches under a tiled roof, a corner tower. */
function arcade(): Model {
  const m = new Model();
  m.box('paint', 30, 6.2, 9, 0, 3.1, 2.5);
  m.box('paint', 30, 0.5, 4.4, 0, 4.45, -4.2);
  m.slab('terracotta', 30.6, 0.3, 4.9, 0, 5.15, -4.3, 0.22);
  for (let k = 0; k <= 6; k++) {
    const x = -13.8 + k * 4.6;
    m.cylinder('white', 0.28, 0.33, 3.2, x, 1.6, -6.2, 8);
    m.box('white', 0.8, 0.25, 0.8, x, 3.3, -6.2);
    if (k < 6) m.arch('white', 2.02, 0.2, x + 2.3, 3.25, -6.2);
  }
  m.box('glass', 25, 2.7, 0.25, -1.6, 1.7, -2.05);
  for (const x of [-10, -3.5, 3]) m.box('wood', 1.3, 2.5, 0.3, x, 1.25, -2.1);
  m.hip('terracotta', 31.2, 10.4, 2.3, 0, 6.2, 2.5);
  m.box('paint', 5.6, 13.5, 5.6, 12.2, 6.75, 2.5);
  for (const z of [-0.35, 5.35]) m.box('glass', 1.5, 2.6, 0.2, 12.2, 10.6, z);
  m.hip('terracotta', 6.8, 6.8, 3, 12.2, 13.5, 2.5, 0.03);
  return m;
}

/** Painted warehouse loft: three floors of factory windows, a sawtooth roof, a water tank, murals. */
function loft(): Model {
  const m = new Model();
  m.box('paint', 26, 11.2, 14, 0, 5.6, 0.5);
  for (const y of [3.75, 7.4, 11.25]) m.box('white', 26.4, 0.32, 14.4, 0, y, 0.5);
  for (const y of [2, 5.6, 9.3]) for (let k = 0; k < 6; k++) m.box('glass', 3, y < 3 ? 2.9 : 2.5, 0.25, -10.6 + k * 4.24, y, -6.55);
  for (let k = 0; k < 4; k++) {
    const x = -9.75 + k * 6.5;
    m.slab('steel', 6.7, 0.25, 13.8, x, 12.4, 0.5, 0, 0.33);
    m.box('glass', 0.2, 2, 13.4, x + 3.15, 12.4, 0.5);
  }
  for (const [x, z] of [[7.2, 2.2], [8.8, 2.2], [7.2, 3.8], [8.8, 3.8]]) m.cylinder('steel', 0.08, 0.08, 3, x, 13.6, z, 4);
  m.cylinder('wood', 1.5, 1.5, 2.6, 8, 16.4, 3, 10);
  m.cylinder('steel', 0.1, 1.65, 0.9, 8, 18.15, 3, 10);
  // Murals: big blocks of colour on the gable walls and over the shopfronts.
  m.box('coral', 0.14, 7.6, 6.4, -13.06, 6.2, -2.4);
  m.box('teal', 0.14, 5, 5.4, -13.06, 4.2, 4.2);
  m.box('yellow', 0.14, 6.2, 5, 13.06, 5.4, 3.4);
  m.box('pink', 0.14, 8.2, 6, 13.06, 6.4, -3);
  return m;
}

/** Single-storey Gables bungalow: tiled hips, an arched porch, a chimney, a low garden wall. */
function bungalow(): Model {
  const m = new Model();
  m.box('paint', 13.5, 3.7, 9.5, -2.8, 1.85, 1.5);
  m.box('paint', 7.4, 3.4, 8, 6.6, 1.7, -1);
  m.hip('terracotta', 15.2, 11.2, 2.5, -2.8, 3.7, 1.5);
  m.hip('terracotta', 8.9, 9.5, 2.1, 6.6, 3.4, -1);
  // Porch: three arches on round columns in front of the door.
  m.box('paint', 9.6, 0.45, 2.4, -3.2, 3.3, -4.4);
  m.slab('terracotta', 10, 0.25, 2.9, -3.2, 3.75, -4.6, 0.25);
  for (let k = 0; k <= 3; k++) {
    const x = -7.7 + k * 3;
    m.cylinder('white', 0.22, 0.26, 2.5, x, 1.25, -5.5, 8);
    if (k < 3) m.arch('white', 1.32, 0.16, x + 1.5, 2.45, -5.5);
  }
  m.box('wood', 1.2, 2.3, 0.14, -3.2, 1.15, -3.28);
  for (const x of [-7.4, 1]) {
    m.box('glass', 1.6, 1.5, 0.14, x, 1.9, -3.3);
    for (const side of [-1.05, 1.05]) m.box('teal', 0.45, 1.6, 0.1, x + side, 1.9, -3.34);
  }
  m.box('white', 4.6, 2.3, 0.14, 6.6, 1.15, -5.05);
  m.box('paint', 1.1, 2.6, 1.1, -7, 5.6, 3);
  m.box('white', 1.4, 0.25, 1.4, -7, 7, 3);
  for (const x of [-7.6, 6.4]) m.box('white', 7.2, 0.75, 0.3, x, 0.37, -8.4);
  for (const x of [-11.2, -4, 2.8, 10]) m.box('white', 0.55, 1.05, 0.55, x, 0.52, -8.4);
  return m;
}

/** Flat-roofed modern villa: stacked white volumes, glass walls, a timber screen, a pool on the lawn. */
function villaModern(): Model {
  const m = new Model();
  m.box('paint', 20, 3.4, 10.5, 0, 1.7, 1.5);
  m.box('paint', 13, 3.2, 9, -3, 5.1, 0.2);
  m.box('white', 21.6, 0.36, 12.2, 0, 3.55, 1.2);
  m.box('white', 15.4, 0.36, 11.6, -3, 6.9, -0.4);
  m.box('glass', 9.4, 2.6, 0.22, -4.6, 1.65, -3.78);
  m.box('glass', 12, 2.6, 0.22, -3, 5.1, -4.32);
  m.box('glass', 0.22, 2.6, 6, -9.52, 5.1, 0);
  m.box('wood', 6.2, 3.3, 0.3, 6.4, 1.7, -3.82);
  m.box('dark', 4.2, 2.4, 0.2, 6.4, 1.2, -4);
  for (const x of [-9.4, 3.4]) m.box('white', 0.3, 3.3, 0.3, x, 5.1, -4.9);
  // Pool and its deck between the house and the road.
  m.box('sand', 12, 0.12, 6, -3, 0.06, -8.4);
  m.box('pool', 9, 0.1, 3.6, -3, 0.14, -8.4);
  return m;
}

/** Container ship, 210 m: tapered hull, bays of stacked boxes, the house and funnel aft. */
function cargoShip(): Model {
  const m = new Model();
  const hull = new THREE.BoxGeometry(30, 14, 210, 2, 1, 12);
  const p = hull.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getZ(i) / 105;
    const k = t < -0.6 ? Math.max(0.05, 1 - ((-t - 0.6) / 0.4) ** 1.5) : t > 0.85 ? 1 - 0.3 * ((t - 0.85) / 0.15) : 1;
    p.setX(i, p.getX(i) * k);
    // A raked stem: the keel rises to the waterline as the bow narrows.
    if (t < 0 && p.getY(i) < 0) p.setY(i, p.getY(i) * Math.max(k, 0.12));
  }
  hull.computeVertexNormals();
  m.add('paint', hull, 0, 7, 0);
  m.box('white', 30.3, 0.9, 150, 0, 13.6, 4);
  const colours = ['coral', 'navy', 'teal', 'yellow', 'ivory', 'brick', 'mint', 'steel', 'signal'];
  let n = 0;
  for (let bay = 0; bay < 10; bay++) {
    const z = -62 + bay * 13.4;
    for (let col = 0; col < 3; col++) {
      const levels = 3 + ((bay * 3 + col * 5) % 4);
      m.box(colours[n++ % colours.length], 9.2, levels * 2.6, 12.3, (col - 1) * 9.6, 14 + levels * 1.3, z);
    }
  }
  m.box('white', 27, 21, 13, 0, 24.5, 82);
  m.box('glass', 27.3, 1.8, 13.3, 0, 32.4, 82);
  m.box('white', 33, 2.6, 5, 0, 33.8, 78);
  m.cylinder('signal', 2.6, 3.2, 8, 0, 39, 86, 10);
  m.cylinder('steel', 0.2, 0.3, 9, 0, 40, 77, 5);
  m.cylinder('steel', 0.2, 0.3, 12, 0, 20, -92, 5);
  m.waterline = 9;
  return m;
}

/** Rubber-tyred yard gantry straddling a container block. */
function rtg(): Model {
  const m = new Model();
  for (const x of [-12.6, 12.6]) {
    for (const z of [-5.5, 5.5]) m.box('paint', 1.2, 21, 1.2, x, 11.5, z);
    m.box('paint', 1.2, 1.2, 12.2, x, 13, 0);
    m.box('dark', 2, 1.6, 13.4, x, 0.8, 0);
  }
  for (const z of [-5.5, 5.5]) m.box('paint', 26.6, 1.7, 1.5, 0, 22.2, z);
  m.box('white', 3.6, 2.6, 9.4, 5, 20.4, 0);
  m.box('glass', 3.7, 1.1, 2.4, 5, 19.9, -3.6);
  m.box('steel', 5.4, 0.5, 2.6, 5, 15.5, 0);
  for (const z of [-1, 1]) m.box('steel', 0.1, 4, 0.1, 5, 17.6, z * 0.9);
  return m;
}

/** Transit shed: a long clad warehouse with roller doors under a shallow roof. */
function shed(): Model {
  const m = new Model();
  m.box('paint', 60, 8, 26, 0, 4, 0);
  m.box('signal', 60.2, 0.9, 26.2, 0, 7.1, 0);
  m.hip('steel', 61.4, 27.4, 2.8, 0, 8, 0, 0.62);
  for (let k = 0; k < 7; k++) m.box('dark', 5.6, 5.4, 0.25, -25.2 + k * 8.4, 2.7, -13.05);
  for (let k = 0; k < 7; k++) m.box('white', 6, 0.3, 0.4, -25.2 + k * 8.4, 5.6, -13.1);
  for (const x of [-18, 0, 18]) m.cylinder('steel', 1, 1, 1.4, x, 10.4, 0, 8);
  return m;
}

/** Tank farm: three storage tanks with shallow domes, hoops, a pipe rack between them. */
function tanks(): Model {
  const m = new Model();
  for (const [x, z, r] of [[-14, 3, 9], [8, -4, 8], [22, 9, 6.5]] as const) {
    m.cylinder('white', r, r, 13, x, 6.5, z, 16);
    m.cylinder('white', 0.6, r, 1.6, x, 13.8, z, 16);
    m.ring('signal', r + 0.06, 0.7, x, 11.4, z, 16);
    m.ring('steel', r + 0.06, 0.3, x, 4, z, 16);
  }
  m.box('steel', 30, 0.5, 0.8, 4, 3, 0);
  for (const x of [-8, 0, 8, 16]) m.box('steel', 0.3, 3, 0.3, x, 1.5, 0);
  return m;
}

/** High-mast yard light. */
function mast(): Model {
  const m = new Model();
  m.cylinder('steel', 0.22, 0.5, 34, 0, 17, 0, 6);
  m.cylinder('steel', 2.4, 2.4, 0.3, 0, 34, 0, 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    m.box('white', 0.9, 0.35, 0.6, Math.cos(a) * 2.3, 33.7, Math.sin(a) * 2.3, -a);
  }
  return m;
}

/** Cruise terminal: a long glass hall under a white roof that lifts toward the ships, boarding towers. */
function terminal(): Model {
  const m = new Model();
  m.box('white', 100, 1.4, 28, 0, 0.7, 0);
  m.box('glass', 96, 9, 24, 0, 5.9, 0);
  for (let k = 0; k < 9; k++) m.box('white', 0.9, 9.4, 25, -44 + k * 11, 6, 0);
  m.slab('white', 104, 0.9, 17, 0, 12.4, -7.6, -0.16);
  m.slab('white', 104, 0.9, 17, 0, 11.3, 7.8, 0.08);
  for (const x of [-30, 30]) {
    m.box('white', 5.5, 17, 5.5, x, 8.5, -17);
    m.box('glass', 5.7, 3, 5.7, x, 14.5, -17);
    m.box('white', 3, 2.6, 14, x, 13.6, -27);
  }
  return m;
}

/** Every model of this file, by prototype name. */
export function cityModels(): [string, Model][] {
  return [
    ['tower_round', towerRound()], ['tower_slab', towerSlab()], ['tower_deco', towerDeco()], ['garage', garage()],
    ['cafe', cafe()], ['arcade', arcade()], ['loft', loft()], ['bungalow', bungalow()], ['villa_modern', villaModern()],
    ['cargo_ship', cargoShip()], ['rtg', rtg()], ['shed', shed()], ['tanks', tanks()], ['mast', mast()], ['terminal', terminal()],
  ];
}
