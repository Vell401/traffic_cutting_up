import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import { mulberry32 } from '../src/core/rng';
import { WALL_D } from '../src/config';
import { getMap } from '../src/sim/maps';
import { MIAMI_CHUNKS, MIAMI_LEN, miamiZone } from '../src/sim/miami';
import { Road } from '../src/sim/road';
import { extractMiamiAssets, type MiamiAssets, type MiamiManifest } from '../src/render/miami/assets';
import { MIAMI_PLOTS, miamiFrontage, miamiPeakCounts, miamiPlacements } from '../src/render/miami/layout';
import { PROP_NAMES, TINTED, makeMiamiProps, makePropMaterials } from '../src/render/miami/props';
import { MIAMI_QUAY, MIAMI_WATER, miamiGround } from '../src/render/miami/terrain';
import { MIAMI_FAR_WINDOW, MIAMI_LANDMARKS, MIAMI_WINDOW, MiamiWorld, NO_SHADOW_MATERIALS } from '../src/render/miami/world';

const manifest = JSON.parse(readFileSync('public/models/miami/manifest.json', 'utf8')) as MiamiManifest;
let a: MiamiAssets;
let releaseFixture: () => void;
beforeAll(async () => {
  const b = readFileSync('public/models/miami/coastal-kit.glb');
  const gltf = await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
  a = extractMiamiAssets(manifest, gltf.scene, new Map(manifest.textures.map(t => [t.id, new THREE.Texture()])));
  releaseFixture = a.retain();
});
afterAll(() => releaseFixture());
const road = () => new Road(mulberry32(7), getMap('miami').script);
const batches = (w: MiamiWorld) => w.group.children as THREE.InstancedMesh[];
const output = (w: MiamiWorld) => batches(w).map(m => ({ name: m.name, count: m.count, matrices: [...m.instanceMatrix.array.slice(0, m.count * 16)] }));
const instances = (w: MiamiWorld, prototype: string) => {
  const m = batches(w).find(mesh => mesh.userData.prototype === prototype && mesh.userData.firstPart)!;
  return Array.from({ length: m.count }, (_, i) => {
    const matrix = new THREE.Matrix4(); m.getMatrixAt(i, matrix);
    const position = new THREE.Vector3(), scale = new THREE.Vector3();
    matrix.decompose(position, new THREE.Quaternion(), scale);
    return { position, scale: scale.x };
  });
};

describe('code-built Miami props', () => {
  it('builds every prop as a light, ground-centred model from kit and prop materials', () => {
    const own = makePropMaterials();
    const props = makeMiamiProps(new Map([...a.materials, ...own]));
    expect([...props.keys()].sort()).toEqual([...PROP_NAMES].sort());
    for (const [name, prop] of props) {
      // A few hundred triangles: these are what a 30 km lap is filled with.
      expect(prop.triangles, name).toBeLessThan(1500);
      expect(prop.parts.length, name).toBeLessThanOrEqual(8);
      // On the ground (shrubs root a little into it), never floating or buried.
      expect(prop.bounds.min[1], name).toBeGreaterThanOrEqual(-0.5);
      expect(prop.bounds.min[1], name).toBeLessThanOrEqual(0.5);
      expect(prop.bounds.min[0]).toBeCloseTo(-prop.bounds.max[0], 10);
      expect(prop.bounds.min[2]).toBeCloseTo(-prop.bounds.max[2], 10);
      let triangles = 0;
      for (const part of prop.parts) {
        expect(part.name).toBe(`${name}__${part.material.name}`);
        expect([...a.materials.values(), ...own.values()]).toContain(part.material);
        const g = part.geometry, p = g.getAttribute('position'), n = g.getAttribute('normal');
        expect(g.index).not.toBeNull(); expect(g.getAttribute('uv')).toBeDefined();
        for (let i = 0; i < p.count; i++) {
          expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
          expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)), `${part.name} vertex ${i}`).toBeCloseTo(1, 3);
        }
        triangles += g.index!.count / 3;
      }
      expect(triangles).toBe(prop.triangles);
    }
    // Boats sit on their waterline, not their keel.
    expect(props.get('sailboat')!.waterline).toBeGreaterThan(0);
    expect(props.get('cruise')!.waterline).toBeGreaterThan(0);
    expect(props.get('villa')!.waterline).toBeUndefined();
    expect(props.get('cruise')!.bounds.max[2]).toBeGreaterThan(100);
    expect(props.get('wheel')!.bounds.max[1]).toBeGreaterThan(50);
    for (const prop of props.values()) for (const part of prop.parts) part.geometry.dispose();
    own.forEach(m => m.dispose());
  });
});

describe('Miami layout', () => {
  it('is canonical: the same frozen placements on every lap, and different from block to block', () => {
    for (const i of [3, 40, 80, 150, 210, 290]) {
      expect(miamiPlacements(i + MIAMI_CHUNKS)).toBe(miamiPlacements(i));
      expect(miamiPlacements(i - 2 * MIAMI_CHUNKS)).toBe(miamiPlacements(i));
      expect(Object.isFrozen(miamiPlacements(i))).toBe(true);
      expect(miamiPlacements(i)).not.toEqual(miamiPlacements(i + 1));
    }
  });

  it('fills every block of open road on both sides, and leaves no causeway without boats or islands', () => {
    const quiet: string[] = [];
    for (let i = 0; i < MIAMI_CHUNKS; i++) {
      const zone = miamiZone(i), all = miamiPlacements(i);
      if (zone.kind === 'tunnel') { expect(all).toHaveLength(0); continue; }
      for (const p of all) { expect(p.s).toBeGreaterThanOrEqual(0); expect(p.s).toBeLessThan(100); expect(p.scale).toBeGreaterThan(0.4); }
      const scenery = all.filter(p => p.prototype !== 'streetlight');
      if (zone.kind === 'open') {
        // Something to look at every few metres: at least a dozen pieces per side per 100 m.
        // (Under a crossing overpass the middle of the block is kept clear.)
        for (const side of [-1, 1]) if (scenery.filter(p => Math.sign(p.d) === side).length < (zone.overpass ? 6 : 12)) quiet.push(`${i} ${zone.district} side ${side}`);
        // And something tall on each side: a building, a tree or a palm.
        for (const side of [-1, 1]) {
          expect(scenery.some(p => Math.sign(p.d) === side && /^(hotel|condo|tower|villa|shop|palm|tree)/.test(p.prototype)), `${i} side ${side}`).toBe(true);
        }
      }
    }
    expect(quiet).toEqual([]);
    // Causeways: over any 500 m of bridge or viaduct there are boats or island life in view.
    for (let i = 0; i < MIAMI_CHUNKS; i++) {
      const kinds = Array.from({ length: 5 }, (_, k) => miamiZone(i + k).kind);
      if (!kinds.every(kind => kind === 'bridge' || kind === 'viaduct')) continue;
      const scenery = Array.from({ length: 5 }, (_, k) => miamiPlacements(i + k)).flat().filter(p => p.prototype !== 'streetlight');
      expect(scenery.length, `causeway at chunk ${i}`).toBeGreaterThanOrEqual(4);
    }
    // The landmarks of the lap exist.
    const count = (name: string) => Array.from({ length: MIAMI_CHUNKS }, (_, i) => miamiPlacements(i)).flat().filter(p => p.prototype === name).length;
    expect(count('wheel')).toBe(1);
    expect(count('cruise')).toBeGreaterThanOrEqual(4);
    expect(count('crane')).toBeGreaterThanOrEqual(10);
    expect(count('lifeguard')).toBeGreaterThanOrEqual(8);
    expect(count('marina_pontoon')).toBe(28);
  });

  it('keeps modelled frontage on its plots, clear of side streets and of each other', () => {
    expect(MIAMI_PLOTS).toEqual([20, 50, 80]);
    for (let i = 0; i < MIAMI_CHUNKS; i++) for (const side of [-1, 1]) {
      const spans = [...miamiFrontage(i, side)].sort((p, q) => p[0] - q[0]);
      for (const [from, to] of spans) { expect(from).toBeGreaterThan(0); expect(to).toBeLessThan(100); expect(to).toBeGreaterThan(from); }
      for (let k = 1; k < spans.length; k++) expect(spans[k][0], `chunk ${i} side ${side}`).toBeGreaterThanOrEqual(spans[k - 1][1]);
      if (miamiZone(i).overpass) for (const [from, to] of spans) expect(to < 44 || from > 56).toBe(true);
    }
  });
});

describe('instanced Miami world', () => {
  it('keeps every transformed model bound clear of the protected road on the whole lap', () => {
    const w = new MiamiWorld(a);
    for (let i = 0; i < MIAMI_CHUNKS; i++) for (const p of miamiPlacements(i)) {
      const prototype = w.prototypes.get(p.prototype);
      expect(prototype, p.prototype).toBeDefined();
      const extent = p.scale * (Math.abs(Math.cos(p.heading)) * prototype!.bounds.max[0] + Math.abs(Math.sin(p.heading)) * prototype!.bounds.max[2]);
      expect(Math.abs(p.d) - extent, `${p.prototype} in chunk ${i}`).toBeGreaterThan(WALL_D + 2);
    }
    w.dispose();
  });

  it('sizes every batch to the exact peak of the layout and stays inside the triangle budget on the whole lap', () => {
    const r = road(), w = new MiamiWorld(a); r.ensure(-400, MIAMI_LEN + 1500);
    const near = miamiPeakCounts(8), far = miamiPeakCounts(17);
    for (const m of batches(w)) {
      const name = m.userData.prototype as string;
      expect(m.instanceMatrix.count).toBe((MIAMI_LANDMARKS.has(name) ? far : near).get(name));
    }
    expect(batches(w).length).toBeLessThanOrEqual(130);
    let worst = 0, most = 0;
    for (let s = 0; s < MIAMI_LEN; s += 100) {
      w.update(r, s, 0, 0, 0);
      let triangles = 0, shadowTriangles = 0, placed = 0;
      for (const m of batches(w)) {
        expect(m.count).toBeLessThanOrEqual(m.instanceMatrix.count);
        expect(m.visible).toBe(m.count > 0);
        triangles += m.geometry.index!.count / 3 * m.count;
        if (m.castShadow) shadowTriangles += m.geometry.index!.count / 3 * m.count;
        if (m.userData.firstPart) placed += m.count;
      }
      worst = Math.max(worst, triangles + shadowTriangles); most = Math.max(most, placed);
    }
    // Colour pass plus a complete shadow pass of everything that casts.
    expect(worst).toBeLessThan(3_000_000);
    expect(most).toBeLessThan(1800);
    expect(MIAMI_WINDOW.ahead).toBeGreaterThanOrEqual(600); w.dispose();
  }, 120_000);

  it('borrows kit geometry, owns prop geometry, and keeps trim and far landmarks out of the shadow pass', () => {
    const w = new MiamiWorld(a);
    const names = new Set(batches(w).map(m => m.userData.prototype as string));
    for (const name of ['hotel_deco', 'tower_glass', 'palm_coconut', 'yacht', 'palm_lite', 'tree', 'villa', 'shop', 'umbrella', 'sailboat', 'cruise', 'crane', 'wheel']) expect(names).toContain(name);
    for (const m of batches(w)) {
      const name = m.userData.prototype as string, kit = a.prototypes.get(name);
      expect(m.geometry).toBe(w.prototypes.get(name)!.parts.find(p => p.name === m.name)!.geometry);
      expect(m.receiveShadow).toBe(true);
      const material = (m.material as THREE.Material).name;
      if (kit) expect(m.castShadow).toBe(!NO_SHADOW_MATERIALS.has(material));
      // Walls, structure, trunks, foliage and hulls always cast.
      if (/^(plaster_|concrete_warm|palm_|hedge_leaf|hull_pearl|teak_deck)/.test(material)) expect(m.castShadow).toBe(true);
      if (MIAMI_LANDMARKS.has(name)) expect(m.castShadow).toBe(false);
      expect(m.instanceColor).not.toBeNull();
    }
    w.dispose();
  });

  it('does no steady-frame rebuilding, rebase only moves the group, and invalidates road/version/range/empty transitions', () => {
    const r = road(); r.ensure(0, 1800); const w = new MiamiWorld(a); w.update(r, 300, 0, 0, 0);
    const initial = output(w), scan = vi.spyOn(r.chunks, Symbol.iterator);
    w.update(r, 301, 0, 0, 10); expect(scan).not.toHaveBeenCalled(); expect(output(w)).toEqual(initial);
    w.update(r, 300, 1000, -2000, 20); expect(scan).not.toHaveBeenCalled(); expect(output(w)).toEqual(initial);
    expect(w.group.position.toArray()).toEqual([-1000, 0, 2000]);
    for (const s of [800, -29800, 30200]) {
      r.ensure(s - 400, s + 1800); w.update(r, s, 9, 10, 0);
      const fresh = new MiamiWorld(a); fresh.update(r, s, 9, 10, 0); expect(output(w)).toEqual(output(fresh)); fresh.dispose();
    }
    const next = road(); next.ensure(0, 1800); w.update(next, 300, 0, 0, 0); expect(output(w)).toEqual(initial);
    next.chunks.length = 0; next.version++; w.update(next, 300, 0, 0, 0); expect(batches(w).every(m => m.count === 0)).toBe(true);
    next.ensure(0, 1800); w.update(next, 300, 0, 0, 0); expect(output(w)).toEqual(initial); w.dispose();
  });

  it('floats boats on their waterline and stands everything else on dry ground, never in the bay', () => {
    const r = road(), w = new MiamiWorld(a);
    for (const s of [500, 2950, 3900, 5400, 7250, 15000, 16850, 19400, 21000, 28500]) {
      r.ensure(s - 500, s + 1800); w.update(r, s, 0, 0, 0);
      for (const name of ['yacht', 'sailboat', 'cruise', 'marina_pontoon']) {
        const waterline = w.prototypes.get(name)!.waterline!;
        for (const boat of instances(w, name)) expect(boat.position.y + waterline * boat.scale).toBeCloseTo(MIAMI_WATER, 6);
      }
      for (const name of ['hotel_deco', 'hotel_colonnade', 'condo_terrace', 'tower_glass', 'tower_setback', 'villa', 'shop', 'palm_lite', 'palm_tall', 'tree', 'umbrella', 'bench', 'crane']) {
        if (!batches(w).some(m => m.userData.prototype === name)) continue;
        for (const item of instances(w, name)) expect(item.position.y, `${name} at s=${s}`).toBeGreaterThanOrEqual(MIAMI_WATER + 0.25);
      }
      for (const light of instances(w, 'streetlight')) expect(light.position.y).toBe(0);
    }
    // Marina: benches on the lower boardwalk, yachts in their berths past the seawall.
    r.ensure(14500, 17000); w.update(r, 15000, 0, 0, 0);
    expect(instances(w, 'bench').some(bench => Math.abs(bench.position.y - MIAMI_QUAY) < 1e-6)).toBe(true);
    expect(instances(w, 'yacht').length).toBeGreaterThanOrEqual(10);
    expect(miamiGround(r, 15029, -61)).toBeLessThan(MIAMI_WATER);
    w.dispose();
  });

  it('brings landmarks in from beyond the haze while ordinary scenery stays in the close window', () => {
    const r = road(), w = new MiamiWorld(a);
    expect(MIAMI_FAR_WINDOW.ahead).toBeGreaterThan(900); // The fog is complete by 900 m.
    // The port cranes of the first causeway stand 3.7-4.6 km into the lap.
    r.ensure(2000, 5000); w.update(r, 2700, 0, 0, 0);
    const far = instances(w, 'crane');
    w.update(r, 3400, 0, 0, 0);
    const near = instances(w, 'crane');
    w.update(r, 2700, 0, 0, 0);
    expect(far.length).toBeGreaterThan(0);
    // Nothing ordinary beyond the close window from here: no villas of the islands yet.
    expect(batches(w).find(m => m.userData.prototype === 'villa' && m.userData.firstPart)!.count).toBe(0);
    w.update(r, 3400, 0, 0, 0);
    expect(batches(w).find(m => m.userData.prototype === 'villa' && m.userData.firstPart)!.count).toBeGreaterThan(0);
    expect(near.length).toBeGreaterThanOrEqual(far.length);
    w.dispose();
  });

  it('tints only paintable surfaces, per placement', () => {
    const r = road(); r.ensure(11000, 13500); const w = new MiamiWorld(a); w.update(r, 11500, 0, 0, 0);
    const colours = (m: THREE.InstancedMesh) => Array.from({ length: m.count }, (_, i) => { const c = new THREE.Color(); m.getColorAt(i, c); return c.getHex(); });
    const paint = batches(w).find(m => m.name === 'shop__paint')!, glass = batches(w).find(m => m.name === 'shop__glass')!;
    expect(TINTED.has('paint')).toBe(true);
    expect(paint.count).toBeGreaterThan(10);
    // Wynwood: many colours of shopfront, the same clear glass in all of them.
    expect(new Set(colours(paint)).size).toBeGreaterThan(4);
    expect(new Set(colours(glass))).toEqual(new Set([0xffffff]));
    w.dispose();
  });

  it('disposes instance buffers and prop geometry once but leaves borrowed kit geometry alive while another world uses it', () => {
    const first = new MiamiWorld(a), second = new MiamiWorld(a);
    const instanceSpies = batches(first).map(m => vi.spyOn(m, 'dispose'));
    const kit = batches(first).filter(m => a.prototypes.has(m.userData.prototype)).map(m => vi.spyOn(m.geometry, 'dispose'));
    const props = batches(first).filter(m => !a.prototypes.has(m.userData.prototype)).map(m => vi.spyOn(m.geometry, 'dispose'));
    const otherProps = batches(second).filter(m => !a.prototypes.has(m.userData.prototype)).map(m => vi.spyOn(m.geometry, 'dispose'));
    first.dispose(); first.dispose(); instanceSpies.forEach(s => expect(s).toHaveBeenCalledOnce());
    props.forEach((s, i) => expect(s, `prop geometry ${i} of ${props.length}`).toHaveBeenCalledOnce());
    otherProps.forEach(s => expect(s).not.toHaveBeenCalled());
    kit.forEach(s => expect(s).not.toHaveBeenCalled()); expect(first.group.children).toHaveLength(0);
    second.dispose(); kit.forEach(s => expect(s).not.toHaveBeenCalled());
    otherProps.forEach(s => expect(s).toHaveBeenCalledOnce());
    releaseFixture(); kit.forEach(s => expect(s).toHaveBeenCalledOnce());
  });
});
