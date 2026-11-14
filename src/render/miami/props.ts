import * as THREE from 'three';
import type { MiamiPrototype } from './assets';
import { CITY_PROPS, cityModels } from './propsCity';
import { PLANT_PROPS, plantModels } from './propsPlants';
import { Model } from './propKit';

export { makePropMaterials, propTextures, TINTED } from './propKit';

/*
 * Light, code-built companions to the modelled Miami kit. The kit's hotels, towers and palms carry
 * tens of thousands of triangles each and can only stand in the front row; these few-hundred-triangle
 * models are what fills a 30 km lap: plants (propsPlants.ts), buildings and port equipment
 * (propsCity.ts), and here villas, shopfronts, beach umbrellas, boats, cranes, a Ferris wheel.
 *
 * Same conventions as the kit: metres, +Y up, front -Z, origin at the centre of the footprint on the
 * ground (or keel). They reuse the kit's materials where one fits, so they sit in the same light.
 */

export const PROP_NAMES: readonly string[] = [
  ...PLANT_PROPS, 'villa', 'shop', 'umbrella', 'lifeguard',
  'sailboat', 'cruise', 'crane', 'containers', 'wheel', ...CITY_PROPS,
];
export type PropName = string;

/** Build every prop. The caller owns the returned geometries (dispose each part's geometry). */
export function makeMiamiProps(materials: ReadonlyMap<string, THREE.MeshStandardMaterial>): Map<string, MiamiPrototype> {
  const out = new Map<string, MiamiPrototype>();
  const done = (name: PropName, model: Model) => out.set(name, model.build(name, materials));

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
      // A raked stem: the keel rises to the waterline as the bow narrows.
      if (t < 0 && p.getY(i) < 0) p.setY(i, p.getY(i) * Math.max(k, 0.12));
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
  // Plants, and buildings and port equipment, live in their own files.
  for (const [name, model] of plantModels()) done(name, model);
  for (const [name, model] of cityModels()) done(name, model);
  return out;
}
