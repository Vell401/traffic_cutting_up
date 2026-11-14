import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MiamiPrototype } from './assets';

/*
 * Light, code-built companions to the modelled Miami kit. The kit's hotels, towers and palms carry
 * tens of thousands of triangles each and can only stand in the front row; these few-hundred-triangle
 * models are what fills a 30 km lap: palm groves, shade trees, villas, shopfronts, beach umbrellas,
 * sailing boats, cruise ships, port cranes, a Ferris wheel.
 *
 * Same conventions as the kit: metres, +Y up, front -Z, origin at the centre of the footprint on the
 * ground (or keel). They reuse the kit's materials where one fits, so they sit in the same light.
 */

/**
 * Materials made here. Everything that is plain painted or natural colour shares one vertex-coloured
 * material ('solid'), so a prop is two or three draws, not one per colour.
 */
export function makePropMaterials(): Map<string, THREE.MeshStandardMaterial> {
  const out = new Map<string, THREE.MeshStandardMaterial>();
  const add = (name: string, color: number, roughness: number, metalness = 0, side: THREE.Side = THREE.FrontSide, vertexColors = false) =>
    out.set(name, new THREE.MeshStandardMaterial({ name, color, roughness, metalness, side, vertexColors }));
  // Tinted per instance: walls, umbrellas, hulls, crane steel.
  add('paint', 0xffffff, 0.62);
  add('solid', 0xffffff, 0.78, 0, THREE.FrontSide, true);
  add('glass', 0x16303c, 0.14, 0.45);
  add('frond', 0x3f7a2c, 0.75, 0, THREE.DoubleSide);
  add('canvas', 0xf4f1e8, 0.8, 0, THREE.DoubleSide);
  return out;
}

/** Colours of the shared 'solid' material, by the name a model asks for. */
const SOLID: Readonly<Record<string, THREE.Color>> = Object.fromEntries(Object.entries({
  terracotta: 0xb4532e,
  canopy: 0x2f6424,
  trunk: 0x7a6248,
  white: 0xf2f1ec,
  steel: 0x8c949a,
  wood: 0x9a6a3c,
  signal: 0xd9541e,
  coral: 0xe9806e,
  mint: 0x7fcfb6,
  ivory: 0xf3e6c8,
  dark: 0x1b2f3a,
}).map(([name, hex]) => [name, new THREE.Color(hex)]));

/** Materials whose colour a placement's tint multiplies. */
export const TINTED = new Set(['paint', 'plaster_ivory', 'plaster_coral', 'plaster_mint']);

class Model {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();
  waterline: number | undefined;

  /** Take ownership of g, move it into place and file it under a material. */
  add(material: string, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0): this {
    // Collapsed tips and poles have no face to take a normal from: give them one, or they shade black.
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) {
      const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      if (l < 1e-6) n.setXYZ(i, 0, 1, 0);
      else if (Math.abs(l - 1) > 1e-4) n.setXYZ(i, n.getX(i) / l, n.getY(i) / l, n.getZ(i) / l);
    }
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    const colour = SOLID[material];
    if (colour) {
      const colours = new Float32Array(n.count * 3);
      for (let i = 0; i < n.count; i++) colour.toArray(colours, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      material = 'solid';
    }
    let list = this.parts.get(material);
    if (!list) this.parts.set(material, list = []);
    list.push(g);
    return this;
  }

  /** Box centred at (x, y, z) with UVs in half-metres per face, like the kit's 2 m photo tiles. */
  box(material: string, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.getAttribute('uv');
    const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let face = 0; face < 6; face++) {
      for (let k = 0; k < 4; k++) {
        const i = face * 4 + k;
        uv.setXY(i, uv.getX(i) * dims[face][0] / 2, uv.getY(i) * dims[face][1] / 2);
      }
    }
    return this.add(material, g, x, y, z, ry);
  }

  cylinder(material: string, top: number, bottom: number, h: number, x = 0, y = 0, z = 0, sides = 8): this {
    return this.add(material, new THREE.CylinderGeometry(top, bottom, h, sides, 1), x, y, z);
  }

  /** Thin beam from a to b (crane booms, stays, spokes). */
  beam(material: string, a: [number, number, number], b: [number, number, number], thickness: number): this {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const length = from.distanceTo(to);
    const g = new THREE.BoxGeometry(thickness, length, thickness);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
    const mid = from.add(to).multiplyScalar(0.5);
    return this.add(material, g, mid.x, mid.y, mid.z);
  }

  /** Hip roof: a four-sided frustum over a w × d rectangle. */
  hip(material: string, w: number, d: number, h: number, x: number, y: number, z: number, ridge = 0.25): this {
    const g = new THREE.CylinderGeometry(ridge * Math.SQRT1_2, Math.SQRT1_2, h, 4, 1);
    g.rotateY(Math.PI / 4);
    g.scale(w, 1, d);
    return this.add(material, g, x, y + h / 2, z);
  }

  build(name: string, materials: ReadonlyMap<string, THREE.MeshStandardMaterial>): MiamiPrototype {
    const parts: MiamiPrototype['parts'] = [];
    const box = new THREE.Box3();
    let triangles = 0;
    for (const [material, list] of this.parts) {
      const mat = materials.get(material);
      if (!mat) throw Error(`Miami prop ${name}: unknown material ${material}`);
      const geometry = mergeGeometries(list, false);
      if (!geometry) throw Error(`Miami prop ${name}: cannot merge ${material}`);
      list.forEach(g => g.dispose());
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      box.union(geometry.boundingBox!);
      triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
      parts.push({ name: `${name}__${material}`, geometry, material: mat });
    }
    // Footprint bounds are symmetric about the origin, as the placement code expects.
    const hx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
    const hz = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
    return { bounds: { min: [-hx, box.min.y, -hz], max: [hx, box.max.y, hz] }, triangles, waterline: this.waterline, parts };
  }
}

/** Curved, tapered trunk: a cylinder whose rings lean further the higher they are. */
function trunk(h: number, r0: number, r1: number, lean: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, 6, 4);
  g.translate(0, h / 2, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setX(i, p.getX(i) + lean * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** One palm frond: a folded strip arching out and drooping at the tip. */
function frond(length: number, width: number, droop: number, lift: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, length, 2, 4);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -length / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = -p.getZ(i) / length;
    const fold = Math.abs(p.getX(i)) / (width / 2);
    // Narrow at both ends, V-folded along the rib, arching up then falling.
    p.setX(i, p.getX(i) * Math.sin(Math.PI * Math.min(0.95, t * 0.9 + 0.1)));
    p.setY(i, lift * Math.sin(t * Math.PI * 0.6) - droop * t * t - fold * 0.18 * width);
  }
  g.computeVertexNormals();
  return g;
}

function palm(model: Model, h: number, lean: number, fronds: number, length: number): void {
  model.add('trunk', trunk(h, 0.27, 0.15, lean));
  for (let k = 0; k < fronds; k++) {
    const angle = (k / fronds) * Math.PI * 2 + (k % 2) * 0.2;
    const upper = k % 3 === 0;
    const g = frond(length * (upper ? 0.82 : 1), 1.05, upper ? 1.1 : 2.4, upper ? 1.5 : 0.7);
    model.add('frond', g, lean, h - 0.1, 0, angle);
  }
}

/** Foliage mass: a low sphere with its rings pushed in and out, so no two crowns share a silhouette. */
function blob(r: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 9, 6);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Position-based, so the duplicated seam vertices move together.
    const k = 1 + 0.2 * Math.sin(x * 2.3 + y * 1.7 + r * 9) * Math.cos(z * 2.1 - y * 1.3 + r * 5);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.scale(sx, sy, sz);
  g.computeVertexNormals();
  return g;
}

export const PROP_NAMES = [
  'palm_lite', 'palm_tall', 'tree', 'bush', 'villa', 'shop', 'umbrella', 'lifeguard',
  'sailboat', 'cruise', 'crane', 'containers', 'wheel',
] as const;
export type PropName = (typeof PROP_NAMES)[number];

/** Build every prop. The caller owns the returned geometries (dispose each part's geometry). */
export function makeMiamiProps(materials: ReadonlyMap<string, THREE.MeshStandardMaterial>): Map<string, MiamiPrototype> {
  const out = new Map<string, MiamiPrototype>();
  const done = (name: PropName, model: Model) => out.set(name, model.build(name, materials));

  {
    const m = new Model();
    palm(m, 8.2, 0.9, 12, 3.6);
    done('palm_lite', m);
  }
  {
    const m = new Model();
    palm(m, 13.5, 0.5, 14, 3.9);
    done('palm_tall', m);
  }
  {
    // Broad shade tree (ficus / gumbo-limbo): short trunk, a wide layered crown.
    const m = new Model();
    m.add('trunk', trunk(4.2, 0.55, 0.32, 0.3));
    m.add('trunk', trunk(2.6, 0.24, 0.14, 1.4), 0.2, 3.2, 0, 2.2);
    m.add('canopy', blob(3.6, 1.25, 0.72, 1.15), 0.4, 6.4, 0.2);
    m.add('canopy', blob(2.7, 1.2, 0.7, 1.1), -2.4, 5.5, 1.2);
    m.add('canopy', blob(2.5, 1.1, 0.7, 1.2), 2.3, 5.3, -1.6);
    m.add('canopy', blob(2.2, 1, 0.75, 1), -0.6, 7.6, -1.2);
    done('tree', m);
  }
  {
    const m = new Model();
    m.add('canopy', blob(1.1, 1.25, 0.8, 1.1), 0, 0.75, 0);
    m.add('canopy', blob(0.8, 1.1, 0.8, 1.2), 0.9, 0.55, 0.5);
    m.add('canopy', blob(0.7, 1.2, 0.85, 1), -0.8, 0.5, -0.5);
    done('bush', m);
  }
  {
    // Mediterranean-revival villa: two-storey block, a lower wing, tiled hip roofs, a porch.
    const m = new Model();
    m.box('paint', 13, 6.6, 9.5, -2, 3.3, 0.5);
    m.box('paint', 7.5, 3.8, 8, 7.2, 1.9, 1.2);
    m.hip('terracotta', 14.6, 11.1, 2.3, -2, 6.6, 0.5);
    m.hip('terracotta', 8.9, 9.4, 1.7, 7.2, 3.8, 1.2);
    // Porch on four columns in front of the door.
    m.box('white', 5.4, 0.3, 2.4, -2, 3.3, -5.4);
    for (const x of [-4.3, -2.8, -1.2, 0.3]) m.cylinder('white', 0.17, 0.2, 3.15, x, 1.58, -6.3);
    m.box('wood', 1.3, 2.4, 0.12, -2, 1.2, -4.28);
    for (const y of [1.9, 5]) for (const x of [-7, -4.6, 0.6, 3]) {
      if (y < 3 && Math.abs(x + 2) < 2.6) continue;
      m.box('glass', 1.3, 1.6, 0.14, x, y, -4.3);
      m.box('white', 1.6, 0.14, 0.24, x, y - 0.9, -4.34);
    }
    m.box('glass', 2.2, 1.5, 0.14, 7.2, 1.9, -2.84);
    m.box('white', 5.2, 2.5, 0.14, 7.2, 1.25, 5.22);
    for (const z of [-2.5, 0.5, 3.5]) m.box('glass', 0.14, 1.6, 1.3, -8.52, 5, z);
    done('villa', m);
  }
  {
    // Low commercial block: glass shopfronts under an awning, a parapet, painted panels on the walls.
    const m = new Model();
    m.box('paint', 26, 6.4, 13, 0, 3.2, 0.5);
    m.box('white', 26.5, 0.5, 13.5, 0, 6.65, 0.5);
    m.box('glass', 22, 2.9, 0.2, 0, 1.75, -6.05);
    for (const x of [-11, -5.5, 0, 5.5, 11]) m.box('white', 0.35, 3.2, 0.3, x, 1.6, -6.1);
    m.box('signal', 23.5, 0.22, 2.2, 0, 3.5, -7.1);
    m.box('mint', 7.2, 2.2, 0.12, -7.2, 5.05, -6.02);
    m.box('coral', 5.4, 2.2, 0.12, 0.2, 5.05, -6.02);
    m.box('ivory', 6.2, 2.2, 0.12, 7.4, 5.05, -6.02);
    m.box('coral', 0.12, 4.6, 9, -13.02, 3, 0.5);
    m.box('mint', 0.12, 4.6, 9, 13.02, 3, 0.5);
    for (const x of [-7, 5]) m.box('steel', 2.4, 1.1, 1.8, x, 7.4, 1.5);
    done('shop', m);
  }
  {
    // Beach set: a parasol and two loungers.
    const m = new Model();
    m.cylinder('steel', 0.03, 0.03, 2.3, 0, 1.15, 0, 5);
    m.add('paint', new THREE.ConeGeometry(1.7, 0.55, 8), 0, 2.35, 0);
    for (const x of [-0.75, 0.75]) {
      m.box('white', 0.62, 0.1, 1.9, x, 0.32, 0.3);
      m.box('white', 0.62, 0.08, 0.7, x, 0.52, -0.85);
    }
    done('umbrella', m);
  }
  {
    // Lifeguard stand: a painted cabin on stilts with a shade roof and a ramp to the sand.
    const m = new Model();
    for (const x of [-1.1, 1.1]) for (const z of [-1.1, 1.1]) m.cylinder('white', 0.09, 0.09, 1.7, x, 0.85, z, 5);
    m.box('wood', 3.6, 0.14, 3.6, 0, 1.7, 0);
    m.box('paint', 2.3, 2.1, 2.3, 0, 2.82, 0.3);
    m.box('white', 3.5, 0.14, 3.5, 0, 3.95, 0);
    m.box('dark', 1.5, 0.8, 0.08, 0, 3.05, -0.88);
    m.box('white', 3.6, 0.07, 0.07, 0, 2.6, -1.78);
    m.add('wood', new THREE.BoxGeometry(1.1, 0.1, 3).rotateX(-0.55), 0, 0.85, 3.05);
    done('lifeguard', m);
  }
  {
    // Sloop under sail. The keel is the origin; the waterline sits 0.55 m above it.
    const m = new Model();
    const hull = new THREE.CylinderGeometry(1, 1, 10.5, 8, 6);
    hull.rotateX(Math.PI / 2);
    const p = hull.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const t = p.getZ(i) / 5.25;
      const k = Math.sqrt(Math.max(0.02, 1 - (t < 0 ? 1.0 : 0.55) * t * t));
      p.setX(i, p.getX(i) * 1.55 * k);
      p.setY(i, Math.min(0.42, p.getY(i) * 0.95 * k));
    }
    hull.computeVertexNormals();
    m.add('paint', hull, 0, 0.95, 0);
    m.box('white', 1.7, 0.5, 3, 0, 1.6, 0.8);
    m.cylinder('steel', 0.06, 0.08, 13, 0, 7.8, -0.8, 5);
    m.beam('steel', [0, 2.6, -0.7], [0, 2.6, 3.8], 0.1);
    const sail = (pts: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
      g.setIndex([0, 1, 2]);
      g.computeVertexNormals();
      return g;
    };
    m.add('canvas', sail([0.05, 2.7, -0.7, 0.3, 2.7, 3.7, 0.05, 13.6, -0.7]));
    m.add('canvas', sail([-0.05, 2.2, -1, -0.5, 1.9, -5, -0.05, 11.5, -1]));
    m.waterline = 0.55;
    done('sailboat', m);
  }
  {
    // Cruise ship, 250 m: tapered hull, a white tower of decks with dark window bands, funnel, lifeboats.
    const m = new Model();
    const hull = new THREE.BoxGeometry(32, 15, 250, 2, 1, 12);
    const p = hull.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const t = p.getZ(i) / 125;
      const k = t < -0.55 ? Math.max(0.04, 1 - ((-t - 0.55) / 0.45) ** 1.6) : t > 0.8 ? 1 - 0.35 * ((t - 0.8) / 0.2) : 1;
      p.setX(i, p.getX(i) * k);
    }
    hull.computeVertexNormals();
    m.add('paint', hull, 0, 7.5, 0);
    m.box('glass', 32.3, 1.2, 150, 0, 11.6, 14);
    let y = 15;
    let len = 196;
    for (let deck = 0; deck < 7; deck++) {
      const w = 31 - deck * 0.5;
      m.box('white', w, 3.2, len, 0, y + 1.6, 12 + deck * 2.5);
      m.box('glass', w + 0.3, 1.25, len - 8, 0, y + 1.9, 12 + deck * 2.5);
      y += 3.2;
      len -= deck < 4 ? 6 : 22;
    }
    m.box('white', 22, 4, 26, 0, y + 2, -52);
    m.box('glass', 22.3, 1.6, 22, 0, y + 2.6, -54);
    m.cylinder('signal', 4.4, 5.6, 13, 0, y + 6.5, 44, 10);
    m.cylinder('steel', 0.4, 0.4, 12, 0, y + 9, -50, 5);
    for (let z = -50; z <= 70; z += 15) for (const x of [-16.4, 16.4]) m.box('signal', 2.2, 2.4, 9.5, x, 17.4, z);
    m.waterline = 8;
    done('cruise', m);
  }
  {
    // Ship-to-shore gantry crane. Front (-Z) is the waterside boom.
    const m = new Model();
    for (const x of [-11, 11]) for (const z of [-9, 9]) m.box('paint', 1.6, 44, 1.6, x, 22, z);
    for (const z of [-9, 9]) {
      m.box('paint', 23.6, 1.8, 1.8, 0, 12, z);
      m.box('paint', 23.6, 1.8, 1.8, 0, 43, z);
    }
    for (const x of [-11, 11]) {
      m.box('paint', 1.4, 1.6, 18, x, 28, 0);
      m.beam('paint', [x, 12, -9], [x, 28, 9], 0.8);
    }
    m.box('paint', 5, 2.2, 84, 0, 45, -22);
    m.box('paint', 1.6, 22, 1.6, 0, 56, -4);
    m.beam('paint', [0, 67, -4], [0, 46.5, -62], 0.5);
    m.beam('paint', [0, 67, -4], [0, 46.5, 18], 0.5);
    m.box('white', 4.4, 3.2, 5.5, 0, 42.3, -30);
    m.box('dark', 4.5, 1.4, 5.6, 0, 42.6, -30);
    m.box('steel', 7, 5, 8, 0, 49, 12);
    done('crane', m);
  }
  {
    // A block of stacked shipping containers.
    const m = new Model();
    const colours = ['coral', 'steel', 'mint', 'signal', 'ivory', 'steel', 'coral', 'mint'];
    let n = 0;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const stack = 2 + ((row * 5 + col * 3) % 3);
        for (let level = 0; level < stack; level++) {
          m.box(colours[n++ % colours.length], 12.2, 2.55, 2.45, (col - 1) * 12.6, 1.3 + level * 2.6, (row - 1) * 2.9);
        }
      }
    }
    done('containers', m);
  }
  {
    // Observation wheel, 56 m: twin rims, spokes, gondolas, an A-frame either side.
    const m = new Model();
    const hub = 30;
    const radius = 26;
    for (const x of [-1.4, 1.4]) {
      m.add('white', new THREE.TorusGeometry(radius, 0.32, 5, 30).rotateY(Math.PI / 2), x, hub, 0);
      for (let k = 0; k < 15; k++) {
        const a = (k / 15) * Math.PI * 2;
        m.beam('white', [x, hub, 0], [x, hub + Math.sin(a) * radius, Math.cos(a) * radius], 0.14);
      }
      m.beam('white', [x * 3.2, 0, -12], [x * 1.4, hub, 0], 0.9);
      m.beam('white', [x * 3.2, 0, 12], [x * 1.4, hub, 0], 0.9);
    }
    m.add('steel', new THREE.CylinderGeometry(1.2, 1.2, 4.4, 10).rotateZ(Math.PI / 2), 0, hub, 0);
    for (let k = 0; k < 15; k++) {
      const a = (k / 15) * Math.PI * 2;
      m.box('dark', 2.2, 2.3, 2.6, 0, hub + Math.sin(a) * radius - 1.6, Math.cos(a) * radius);
      m.box('white', 2.4, 0.3, 2.8, 0, hub + Math.sin(a) * radius - 0.35, Math.cos(a) * radius);
    }
    m.box('white', 12, 1, 30, 0, 0.5, 0);
    done('wheel', m);
  }
  return out;
}
