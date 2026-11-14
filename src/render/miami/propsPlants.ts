import * as THREE from 'three';
import { PLANT_CELL } from './plantAtlas';
import { Model } from './propKit';

/*
 * The plants of Miami, code-built: five palms, seven trees, six shrubs and grasses.
 *
 *   Palms    coconut (leaning), royal (tall, green crownshaft), Canary date (stout, dense crown),
 *            sabal (fan leaves), areca (a clump of slender stems)
 *   Trees    ficus (round shade tree), banyan (huge, with aerial roots), royal poinciana (flat crown,
 *            flame-coloured on top), flowering tree (tabebuia / jacaranda: tinted pink, yellow, lilac),
 *            Australian pine (tall and narrow), sea grape (low and wide), mangrove (on prop roots)
 *   Shrubs   foliage bush, flowering bush (tinted), agave, bird of paradise, sea oats, areca hedge
 *
 * Each is one draw (flowering ones two): everything samples the plant atlas, the species' colour is in
 * the vertices. Front is -Z, the origin is the foot of the plant.
 */

export const PLANT_PROPS = [
  'palm_lite', 'palm_tall', 'palm_date', 'palm_fan', 'palm_areca',
  'tree', 'banyan', 'poinciana', 'bloom_tree', 'pine', 'seagrape', 'mangrove',
  'bush', 'bush_flower', 'agave', 'banana', 'oats',
] as const;

const C = (hex: number): THREE.Color => new THREE.Color(hex);
const LEAF = {
  coconut: C(0x6ea443), royal: C(0x5b9a40), date: C(0x6f9156), fan: C(0x7a9f55), areca: C(0x8cb84c),
  ficus: C(0x5a9a3e), banyan: C(0x4a8438), poinciana: C(0x6aa640), pine: C(0x5d7f5c), grape: C(0x80ac4c),
  mangrove: C(0x457a3c), bush: C(0x568f3a), agave: C(0x7fa898), banana: C(0x6cb244), oats: C(0xc4b271),
  shaft: C(0x7fae56),
};
const BARK = { palm: C(0xa8937a), royal: C(0xc4bcae), date: C(0x8a7256), tree: C(0x7a6450), pale: C(0x9a8a78) };
const WHITE = C(0xffffff);

/** Curved, tapered trunk: a cylinder whose rings lean further the higher they are. */
function trunk(h: number, r0: number, r1: number, lean: number, sides = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, sides, 4);
  g.translate(0, h / 2, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setX(i, p.getX(i) + lean * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Feather frond: a strip along -Z from the origin, folded along its rib, arching up and drooping to
 * the tip. The atlas cuts the leaflets out of it.
 */
function frond(length: number, width: number, droop: number, lift: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, length, 2, 5);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -length / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = -p.getZ(i) / length;
    const fold = Math.abs(p.getX(i)) / (width / 2);
    p.setY(i, lift * Math.sin(t * Math.PI * 0.6) - droop * t * t - fold * 0.16 * width);
  }
  g.computeVertexNormals();
  return g;
}

/** Crown of feather fronds in tiers: the upper ones stand up, the lower ones hang. */
function crown(m: Model, colour: THREE.Color, x: number, y: number, z: number, count: number, length: number, width: number, hang = 1): void {
  for (let k = 0; k < count; k++) {
    const angle = (k / count) * Math.PI * 2 + (k % 2) * 0.23;
    const tier = k % 3;
    const g = tier === 0 ? frond(length * 0.8, width, 0.9 * hang, 1.6) : tier === 1 ? frond(length, width, 2.3 * hang, 0.8) : frond(length * 0.95, width, 3.4 * hang, 0.35);
    m.leafy(g, PLANT_CELL.frond, colour, x, y, z, angle, [0.78, 1.08]);
  }
}

/** Fan leaf on a stalk: a cupped square the atlas cuts into a pleated fan. */
function fanLeaf(size: number, pitch: number, reach: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(size, size, 2, 2);
  const uv = g.getAttribute('uv');
  // The fan sits in the lower square of its cell.
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 0.5);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -size / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, 0.22 * Math.abs(p.getX(i)) - 0.1 * size * (p.getZ(i) / size) ** 2);
  g.rotateX(pitch);
  g.translate(0, 0, -reach);
  g.computeVertexNormals();
  return g;
}

/** Foliage mass: a low sphere with its rings pushed in and out, so no two crowns share a silhouette. */
function blob(r: number, sx: number, sy: number, sz: number, seed = r, around = 9, up = 6): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, around, up);
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  // Wrap the leaf texture round the crown three times (mirrored, so it has no seam): small leaves.
  const uv = g.getAttribute('uv');
  const mirror = (t: number): number => 1 - Math.abs(1 - (t % 2));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, mirror(uv.getX(i) * 3), mirror(uv.getY(i) * 2));
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Position-based, so the duplicated seam vertices move together.
    const k = 1 + 0.2 * Math.sin(x * 2.3 + y * 1.7 + seed * 9) * Math.cos(z * 2.1 - y * 1.3 + seed * 5);
    p.setXYZ(i, x * k * sx, y * k * sy, z * k * sz);
    // Smooth outward normals of the stretched shape: no faceting, no zero normals at the poles.
    const nx = x / (r * sx), ny = y / (r * sy), nz = z / (r * sz);
    const l = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(i, nx / l, ny / l, nz / l);
  }
  return g;
}

/** Blade of an agave or a stiff leaf: a flat tapered spike rising from the origin along its own +Y. */
function spike(length: number, width: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(width, length, 4, 1);
  g.scale(1, 1, 0.28);
  g.translate(0, length / 2, 0);
  return g;
}

function palmCoconut(): Model {
  const m = new Model();
  m.leafy(trunk(8.2, 0.27, 0.15, 0.9), PLANT_CELL.bark, BARK.palm);
  crown(m, LEAF.coconut, 0.9, 8.1, 0, 12, 4.2, 1.5);
  return m;
}

function palmRoyal(): Model {
  const m = new Model();
  m.leafy(trunk(10.6, 0.36, 0.26, 0.25, 8), PLANT_CELL.bark, BARK.royal);
  // The smooth green crownshaft royal palms are known for.
  m.leafy(new THREE.CylinderGeometry(0.2, 0.3, 2.4, 8, 1), PLANT_CELL.plain, LEAF.shaft, 0.25, 11.7, 0);
  crown(m, LEAF.royal, 0.25, 12.8, 0, 14, 4.4, 1.6, 0.9);
  return m;
}

function palmDate(): Model {
  const m = new Model();
  m.leafy(trunk(6.2, 0.52, 0.46, 0.1, 8), PLANT_CELL.bark, BARK.date);
  // The swollen head of old leaf bases under the crown.
  m.leafy(blob(0.85, 1, 1.1, 1), PLANT_CELL.bark, BARK.date, 0.1, 6.5, 0);
  crown(m, LEAF.date, 0.1, 6.9, 0, 22, 4.8, 1.25, 0.75);
  return m;
}

function palmFan(): Model {
  const m = new Model();
  m.leafy(trunk(5.2, 0.3, 0.27, 0.2, 7), PLANT_CELL.bark, BARK.date);
  let n = 0;
  for (const [count, pitch, height] of [[5, 1.05, 5.5], [7, 0.45, 5.3], [7, -0.2, 5.1]] as const) {
    for (let k = 0; k < count; k++) {
      m.leafy(fanLeaf(2.1, pitch, 0.5), PLANT_CELL.fan, LEAF.fan, 0.2, height, 0, (k / count) * Math.PI * 2 + n * 0.4, [0.8, 1.05]);
    }
    n++;
  }
  return m;
}

function palmAreca(): Model {
  const m = new Model();
  for (let k = 0; k < 6; k++) {
    const angle = (k / 6) * Math.PI * 2 + 0.3;
    const h = 3 + ((k * 7) % 5) * 0.55;
    const lean = 0.5 + (k % 3) * 0.3;
    const foot = 0.35;
    m.leafy(trunk(h, 0.085, 0.06, lean, 5), PLANT_CELL.bark, LEAF.shaft, Math.cos(angle) * foot, 0, -Math.sin(angle) * foot, angle);
    // The stem leans along its own +X, which the turn above points outward.
    const tx = Math.cos(angle) * (foot + lean), tz = -Math.sin(angle) * (foot + lean);
    for (let f = 0; f < 5; f++) {
      m.leafy(frond(2.3, 0.95, 1.3 + (f % 2) * 0.7, 0.7), PLANT_CELL.frond, LEAF.areca, tx, h - 0.05, tz, angle + (f / 5) * Math.PI * 2, [0.82, 1.06]);
    }
  }
  return m;
}

function ficus(): Model {
  const m = new Model();
  m.leafy(trunk(4.2, 0.55, 0.32, 0.3), PLANT_CELL.bark, BARK.tree);
  m.leafy(trunk(2.6, 0.24, 0.14, 1.4), PLANT_CELL.bark, BARK.tree, 0.2, 3.2, 0, 2.2);
  const shade: [number, number] = [0.6, 1.12];
  m.leafy(blob(3.4, 1.2, 0.74, 1.15, 1), PLANT_CELL.leaves, LEAF.ficus, 0.4, 6.4, 0.2, 0, shade);
  m.leafy(blob(2.6, 1.2, 0.72, 1.1, 2), PLANT_CELL.leaves, LEAF.ficus, -2.5, 5.5, 1.3, 1, shade);
  m.leafy(blob(2.4, 1.1, 0.72, 1.2, 3), PLANT_CELL.leaves, LEAF.ficus, 2.4, 5.3, -1.7, 2, shade);
  m.leafy(blob(2.1, 1, 0.78, 1, 4), PLANT_CELL.leaves, LEAF.ficus, -0.6, 7.7, -1.2, 3, shade);
  m.leafy(blob(1.9, 1.1, 0.7, 1, 5), PLANT_CELL.leaves, LEAF.ficus, 1.6, 7.2, 1.9, 4, shade);
  return m;
}

function banyan(): Model {
  const m = new Model();
  m.leafy(trunk(4.6, 1.25, 0.8, 0.2, 8), PLANT_CELL.bark, BARK.tree);
  // Aerial roots dropping from the limbs to the ground.
  for (const [x, z, h] of [[-4.6, 1.2, 4.6], [3.8, -2.6, 4.2], [1.2, 4.4, 4.8], [-2.2, -4, 4.3], [5.4, 2.2, 4.4]]) {
    m.leafy(trunk(h, 0.22, 0.16, 0.25, 5), PLANT_CELL.bark, BARK.tree, x, 0, z, x);
  }
  const shade: [number, number] = [0.55, 1.1];
  m.leafy(blob(4.6, 1.3, 0.7, 1.25, 1), PLANT_CELL.leaves, LEAF.banyan, 0.3, 8.2, 0, 0, shade);
  m.leafy(blob(3.6, 1.3, 0.66, 1.2, 2), PLANT_CELL.leaves, LEAF.banyan, -5.2, 6.6, 1.5, 1, shade);
  m.leafy(blob(3.4, 1.2, 0.66, 1.3, 3), PLANT_CELL.leaves, LEAF.banyan, 4.9, 6.5, -2.4, 2, shade);
  m.leafy(blob(3.2, 1.2, 0.68, 1.2, 4), PLANT_CELL.leaves, LEAF.banyan, 1.4, 6.4, 5, 3, shade);
  m.leafy(blob(3, 1.2, 0.68, 1.2, 5), PLANT_CELL.leaves, LEAF.banyan, -2.4, 6.6, -4.6, 4, shade);
  m.leafy(blob(2.8, 1.1, 0.7, 1.1, 6), PLANT_CELL.leaves, LEAF.banyan, 5.6, 6.9, 2.8, 5, shade);
  m.leafy(blob(2.6, 1.1, 0.72, 1.1, 7), PLANT_CELL.leaves, LEAF.banyan, -1, 10.4, 0.6, 6, shade);
  return m;
}

function poinciana(): Model {
  const m = new Model();
  m.leafy(trunk(3.9, 0.42, 0.26, 0.8), PLANT_CELL.bark, BARK.pale);
  for (const [ry, lean] of [[0.4, 2.6], [2.5, 2.9], [4.4, 2.4]]) m.leafy(trunk(2.2, 0.2, 0.1, lean, 5), PLANT_CELL.bark, BARK.pale, 0.8, 3.6, 0, ry);
  // A wide, flat umbrella: ferny green underneath, in flower on top.
  const under: [number, number] = [0.62, 1.05];
  const places: [number, number, number, number, number][] = [[0.8, 0, 3.4, 1, 6], [-3.2, 1.6, 2.5, 2, 5.5], [4.2, -1.4, 2.6, 3, 5.6], [1.4, 4, 2.4, 4, 5.3], [-0.6, -3.9, 2.5, 5, 5.4]];
  for (const [x, z, r, seed, y] of places) {
    m.leafy(blob(r, 1.25, 0.46, 1.25, seed), PLANT_CELL.leaves, LEAF.poinciana, x, y, z, seed, under);
    // Flame-coloured sprays breaking out of the top of each bough, not a lid over it.
    for (const [dx, dz, k] of [[0.9, 0.4, 0.42], [-1.1, -0.6, 0.36], [0.1, -1.3, 0.3]]) {
      m.leafy(blob(r * k, 1.3, 0.5, 1.3, seed + dx, 6, 4), PLANT_CELL.blossom, WHITE, x + dx * r * 0.5, y + r * 0.36, z + dz * r * 0.5, seed, [0.85, 1.05], 'bloom');
    }
  }
  return m;
}

function bloomTree(): Model {
  const m = new Model();
  m.leafy(trunk(3.4, 0.3, 0.2, 0.5), PLANT_CELL.bark, BARK.pale);
  for (const [ry, lean] of [[0.8, 1.6], [3.2, 1.8]]) m.leafy(trunk(1.8, 0.14, 0.08, lean, 5), PLANT_CELL.bark, BARK.pale, 0.5, 3.1, 0, ry);
  const shade: [number, number] = [0.7, 1.08];
  m.leafy(blob(2.4, 1.15, 0.9, 1.1, 1), PLANT_CELL.blossom, WHITE, 0.5, 5.3, 0, 0, shade, 'bloom');
  m.leafy(blob(1.8, 1.1, 0.85, 1.1, 2), PLANT_CELL.blossom, WHITE, -1.5, 4.5, 1.1, 1, shade, 'bloom');
  m.leafy(blob(1.7, 1.1, 0.85, 1.1, 3), PLANT_CELL.blossom, WHITE, 2.2, 4.4, -1.1, 2, shade, 'bloom');
  m.leafy(blob(1.5, 1, 0.9, 1, 4), PLANT_CELL.blossom, WHITE, 0.2, 6.6, -0.8, 3, shade, 'bloom');
  return m;
}

/** Australian pine (casuarina): a tall, narrow, feathery column. */
function pine(): Model {
  const m = new Model();
  m.leafy(trunk(13, 0.34, 0.1, 0.3), PLANT_CELL.bark, BARK.tree);
  const shade: [number, number] = [0.62, 1.08];
  for (const [y, r, s] of [[4.4, 1.7, 1], [7.2, 1.6, 2], [9.9, 1.35, 3], [12.4, 1, 4]]) {
    m.leafy(blob(r, 1, 1.5, 1, s), PLANT_CELL.leaves, LEAF.pine, 0.05 * y * 0.3, y, (s % 2 ? 0.25 : -0.25), s, shade);
  }
  return m;
}

/** Sea grape: several low stems under a broad, rounded crown of big leaves. */
function seagrape(): Model {
  const m = new Model();
  for (const [ry, lean] of [[0, 1.3], [2.1, 1.5], [4.2, 1.1]]) m.leafy(trunk(2.2, 0.2, 0.12, lean, 5), PLANT_CELL.bark, BARK.pale, 0, 0, 0, ry);
  const shade: [number, number] = [0.62, 1.1];
  m.leafy(blob(2.6, 1.3, 0.62, 1.2, 1), PLANT_CELL.leaves, LEAF.grape, 0.2, 3, 0, 0, shade);
  m.leafy(blob(2, 1.2, 0.62, 1.2, 2), PLANT_CELL.leaves, LEAF.grape, -2.3, 2.4, 1.2, 1, shade);
  m.leafy(blob(1.9, 1.2, 0.62, 1.1, 3), PLANT_CELL.leaves, LEAF.grape, 2.2, 2.3, -1.3, 2, shade);
  return m;
}

/** Red mangrove: a crown standing on a cage of arching prop roots. */
function mangrove(): Model {
  const m = new Model();
  m.leafy(trunk(2.4, 0.2, 0.14, 0.2, 5), PLANT_CELL.bark, BARK.tree, 0, 1.3, 0);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const g = new THREE.CylinderGeometry(0.05, 0.07, 2.3, 4, 1);
    g.translate(0, -1.15, 0);
    g.rotateZ(-0.75);
    m.leafy(g, PLANT_CELL.bark, BARK.tree, 0, 1.75, 0, a);
  }
  const shade: [number, number] = [0.6, 1.08];
  m.leafy(blob(2.3, 1.2, 0.72, 1.2, 1), PLANT_CELL.leaves, LEAF.mangrove, 0.2, 4.4, 0, 0, shade);
  m.leafy(blob(1.7, 1.2, 0.7, 1.1, 2), PLANT_CELL.leaves, LEAF.mangrove, -1.9, 3.8, 1, 1, shade);
  m.leafy(blob(1.6, 1.1, 0.7, 1.2, 3), PLANT_CELL.leaves, LEAF.mangrove, 1.8, 3.7, -1.1, 2, shade);
  return m;
}

function bush(): Model {
  const m = new Model();
  const shade: [number, number] = [0.6, 1.1];
  m.leafy(blob(1.1, 1.25, 0.8, 1.1, 1), PLANT_CELL.leaves, LEAF.bush, 0, 0.75, 0, 0, shade);
  m.leafy(blob(0.8, 1.1, 0.8, 1.2, 2), PLANT_CELL.leaves, LEAF.bush, 0.9, 0.55, 0.5, 1, shade);
  m.leafy(blob(0.7, 1.2, 0.85, 1, 3), PLANT_CELL.leaves, LEAF.bush, -0.8, 0.5, -0.5, 2, shade);
  return m;
}

/** Hibiscus / ixora: a green mound in flower (the flowers take the placement's tint). */
function bushFlower(): Model {
  const m = new Model();
  m.leafy(blob(1, 1.25, 0.72, 1.15, 1), PLANT_CELL.leaves, LEAF.bush, 0, 0.6, 0, 0, [0.6, 1.05]);
  const shade: [number, number] = [0.75, 1.08];
  m.leafy(blob(0.82, 1.2, 0.6, 1.1, 2), PLANT_CELL.blossom, WHITE, 0.15, 1.05, 0, 0, shade, 'bloom');
  m.leafy(blob(0.55, 1.1, 0.7, 1.1, 3), PLANT_CELL.blossom, WHITE, -0.85, 0.75, 0.4, 1, shade, 'bloom');
  m.leafy(blob(0.5, 1.1, 0.7, 1.1, 4), PLANT_CELL.blossom, WHITE, 0.9, 0.7, -0.45, 2, shade, 'bloom');
  return m;
}

/** Agave: a rosette of stiff blue-green blades. */
function agave(): Model {
  const m = new Model();
  for (let k = 0; k < 14; k++) {
    const ring = k < 8 ? 0 : 1;
    const a = (k / (ring ? 6 : 8)) * Math.PI * 2 + ring * 0.4;
    const g = spike(ring ? 0.85 : 1.15, 0.16);
    g.rotateZ(ring ? -0.45 : -1.05);
    m.leafy(g, PLANT_CELL.plain, LEAF.agave, 0, 0.08, 0, a, [0.7, 1.1]);
  }
  return m;
}

/** Bird of paradise / banana: big paddle leaves on arching stalks. */
function banana(): Model {
  const m = new Model();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + (k % 2) * 0.3;
    const g = new THREE.PlaneGeometry(1.15, 2.7, 2, 4);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -1.35);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const t = -p.getZ(i) / 2.7;
      p.setY(i, (k % 3 === 0 ? 2.2 : 1.5) * t - 0.9 * t * t - 0.1 * Math.abs(p.getX(i)));
    }
    g.computeVertexNormals();
    m.leafy(g, PLANT_CELL.paddle, LEAF.banana, 0, 0.5 + (k % 3) * 0.25, 0, a, [0.8, 1.08]);
  }
  m.leafy(trunk(1, 0.22, 0.16, 0, 6), PLANT_CELL.plain, LEAF.shaft);
  return m;
}

/** Sea oats / dune grass: three crossed cards of blades. */
function oats(): Model {
  const m = new Model();
  for (let k = 0; k < 3; k++) {
    const g = new THREE.PlaneGeometry(1.5, 1.5, 1, 1);
    g.translate(0, 0.75, 0);
    m.leafy(g, PLANT_CELL.grass, LEAF.oats, (k - 1) * 0.12, 0, (k - 1) * 0.1, (k / 3) * Math.PI + 0.2, [0.75, 1.05]);
  }
  return m;
}

/** Every plant, by prototype name. */
export function plantModels(): [string, Model][] {
  return [
    ['palm_lite', palmCoconut()], ['palm_tall', palmRoyal()], ['palm_date', palmDate()], ['palm_fan', palmFan()], ['palm_areca', palmAreca()],
    ['tree', ficus()], ['banyan', banyan()], ['poinciana', poinciana()], ['bloom_tree', bloomTree()], ['pine', pine()],
    ['seagrape', seagrape()], ['mangrove', mangrove()],
    ['bush', bush()], ['bush_flower', bushFlower()], ['agave', agave()], ['banana', banana()], ['oats', oats()],
  ];
}
