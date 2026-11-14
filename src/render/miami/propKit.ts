import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MiamiPrototype } from './assets';
import { makePlantTexture, plantUV, type PlantCell } from './plantAtlas';

/*
 * The small modelling kit the code-built Miami props are made with: a handful of shared materials
 * and a Model that collects primitive geometry per material and merges it into instancing parts.
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
  add('glass', 0x1f4254, 0.12, 0.55);
  add('canvas', 0xf4f1e8, 0.8, 0, THREE.DoubleSide);
  // All vegetation: one atlas (bark, canopy, cut-out leaves), hue from vertex colours. 'bloom' is the
  // same surface for flowering crowns, kept apart only so a placement's tint colours the flowers alone.
  const plants = makePlantTexture();
  for (const name of ['plant', 'bloom']) {
    out.set(name, new THREE.MeshStandardMaterial({
      name, map: plants, alphaTest: 0.4, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82, metalness: 0,
    }));
  }
  return out;
}

/** The generated textures behind makePropMaterials(): dispose them with the materials. */
export function propTextures(materials: ReadonlyMap<string, THREE.MeshStandardMaterial>): THREE.Texture[] {
  return [...new Set([...materials.values()].flatMap(m => (m.map ? [m.map] : [])))];
}

/** Colours of the shared 'solid' material, by the name a model asks for. */
export const SOLID: Readonly<Record<string, THREE.Color>> = Object.fromEntries(Object.entries({
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
  pool: 0x3ec1dc,
  brick: 0x9c5a44,
  sand: 0xd9c7a0,
  navy: 0x1f3550,
  yellow: 0xe3b22a,
  teal: 0x2d8f95,
  pink: 0xf08fb0,
  lime: 0x9acb4a,
  asphalt: 0x3a3c40,
}).map(([name, hex]) => [name, new THREE.Color(hex)]));

/** Materials whose colour a placement's tint multiplies. */
export const TINTED = new Set(['paint', 'bloom', 'plaster_ivory', 'plaster_coral', 'plaster_mint']);

export class Model {
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

  /**
   * Plant geometry: its UVs (0..1) are moved into a cell of the plant atlas and it gets the species'
   * colour, shaded from `shade[0]` at its lowest point to `shade[1]` at its highest (crowns are
   * darker underneath). `material` is 'plant', or 'bloom' for crowns a placement may tint.
   */
  leafy(g: THREE.BufferGeometry, cell: PlantCell, colour: THREE.Color, x = 0, y = 0, z = 0, ry = 0,
    shade: readonly [number, number] = [1, 1], material: 'plant' | 'bloom' = 'plant'): this {
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      const [u, v] = plantUV(cell, Math.min(1, Math.max(0, uv.getX(i))), Math.min(1, Math.max(0, uv.getY(i))));
      uv.setXY(i, u, v);
    }
    const p = g.getAttribute('position');
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < p.count; i++) { low = Math.min(low, p.getY(i)); high = Math.max(high, p.getY(i)); }
    const colours = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const k = shade[0] + (shade[1] - shade[0]) * (high > low ? (p.getY(i) - low) / (high - low) : 1);
      colours[i * 3] = colour.r * k; colours[i * 3 + 1] = colour.g * k; colours[i * 3 + 2] = colour.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return this.add(material, g, x, y, z, ry);
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

  /** Box turned about its own X and Z axes before it is placed (pitched roofs, ramps, awnings). */
  slab(material: string, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, rz = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    return this.add(material, g, x, y, z);
  }

  /** Round arch standing in the XY plane, springing from y, facing along Z. */
  arch(material: string, radius: number, thickness: number, x: number, y: number, z: number): this {
    return this.add(material, new THREE.TorusGeometry(radius, thickness, 4, 8, Math.PI), x, y, z);
  }

  /** Open band around a vertical axis: floor rings of round towers, tank hoops. */
  ring(material: string, radius: number, h: number, x: number, y: number, z: number, sides = 20): this {
    return this.add(material, new THREE.CylinderGeometry(radius, radius, h, sides, 1, true), x, y, z);
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

