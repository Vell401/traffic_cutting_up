import * as T from 'three';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { TrafficView } from '../src/render/trafficView';
import { TrafficCar, MAX_TRAFFIC } from '../src/sim/traffic';
import { VEHICLES } from '../src/sim/vehicles';
import { Sim } from '../src/sim/world';
import { mulberry32 } from '../src/core/rng';

describe('game traffic assets', () => {
  let view: TrafficView, sim: Sim;
  const mesh = (name: string) => view.group.getObjectByName(name) as T.InstancedMesh;
  const body = (name: string, lod = 0) => mesh(`traffic/${name}/lod${lod}/body`);
  const tick = (time = 0, ox = 0, oz = 0) => view.update(sim, 1, ox, oz, time);
  const place = (c: TrafficCar, distance: number) => { c.s = c.prevS = sim.player.s + distance; c.d = c.prevD = sim.player.d; };
  beforeAll(() => {
    view = new TrafficView(new T.Texture());
    sim = new Sim(mulberry32(17));
    sim.traffic.cars.forEach(c => { c.active = false; });
  });
  afterAll(() => {
    const materials = new Set<T.Material>();
    view.group.children.forEach(o => { const m = o as T.InstancedMesh; m.geometry.dispose(); materials.add(m.material as T.Material); m.dispose(); });
    materials.forEach(m => m.dispose());
  });
  it('renders all eight types with independently controlled paint, cargo, brakes and hazards', () => {
    VEHICLES.forEach((spec, i) => {
      const c = sim.traffic.cars[i];
      c.active = true; c.spec = spec; c.color = 0x8e1b1b; c.color2 = 0xd9dde2;
      c.braking = i % 2 === 0; c.blink = i % 3 === 0 ? 2 : i % 3 === 1 ? -1 : 1;
      place(c, 20);
    });
    tick();
    VEHICLES.forEach((spec, i) => {
      expect(body(spec.name).count).toBe(1);
      const colour = new T.Color();
      body(spec.name).getColorAt(0, colour);
      expect(colour.getHex()).toBe(0x8e1b1b);
      const details = mesh(`traffic/${spec.name}/lod0/details`);
      details.getColorAt(0, colour); expect(colour.getHex()).toBe(0xd9dde2);
      const roles = [...details.geometry.getAttribute('partRole').array];
      expect(roles.includes(1)).toBe(spec.truck);
      const lights = mesh(`traffic/${spec.name}/lod0/lights`).geometry;
      const state = lights.getAttribute('trafficSignal');
      expect([state.getX(0), state.getY(0), state.getZ(0)]).toEqual([i % 2 === 0 ? 1 : 0, i % 3 !== 2 ? 1 : 0, i % 3 !== 1 ? 1 : 0]);
      // Each LOD retains headlights, rear lamps, and front/rear indicators on both sides.
      for (const lod of [0, 1, 2]) {
        const g = mesh(`traffic/${spec.name}/lod${lod}/lights`).geometry;
        const role = g.getAttribute('partRole'), p = g.getAttribute('position');
        expect(new Set(role.array)).toEqual(new Set([1, 2, 3, 4]));
        for (const r of [3, 4]) for (const end of [-1, 1])
          expect(Array.from({length:role.count}, (_,j) => role.getX(j) === r && p.getZ(j) * end > 0).some(Boolean)).toBe(true);
      }
    });
    tick(.5);
    for (const spec of VEHICLES) {
      const a = mesh(`traffic/${spec.name}/lod0/lights`).geometry.getAttribute('trafficSignal');
      expect(a.getY(0)).toBe(0); expect(a.getZ(0)).toBe(0);
    }
  });
  it('keeps LOD stable at thresholds, resets reused slots and survives origin shifts', () => {
    sim.traffic.cars.forEach(c => { c.active = false; });
    const c = sim.traffic.cars[0]; c.active = true; c.spec = VEHICLES[0]; c.gen++;
    for (const [distance, lod] of [[20,0],[47,0],[55,1],[45,1],[140,2],[120,2],[100,1],[35,0]]) {
      place(c, distance); tick(); expect(body('sedan',lod).count).toBe(1);
      expect([0,1,2].reduce((n,l) => n + body('sedan',l).count,0)).toBe(1);
    }
    place(c, 47); c.gen++; tick(); expect(body('sedan',1).count).toBe(1);
    const before = new T.Matrix4(), after = new T.Matrix4(); body('sedan',1).getMatrixAt(0,before);
    tick(0, 1000, -2000); body('sedan',1).getMatrixAt(0,after);
    expect(after.elements[12]).toBeCloseTo(before.elements[12]-1000,3);
    expect(after.elements[14]).toBeCloseTo(before.elements[14]+2000,3);
    c.active = false; tick(); expect(body('sedan',1).visible).toBe(false);
    expect(mesh('traffic/shadows').count).toBe(0);
  });
  it('fits the expanded full car pool, including twelve wheels per semi, in three geometry batches', () => {
    sim.traffic.cars.forEach(c => { c.active = true; c.spec = VEHICLES[5]; c.gen++; place(c,20); });
    tick();
    expect(body('semi').count).toBe(MAX_TRAFFIC);
    expect(mesh('traffic/semi/lod0/details').count).toBe(MAX_TRAFFIC);
    expect(mesh('traffic/shadows').count).toBe(MAX_TRAFFIC);
    const active = view.group.children.filter(o => o.visible && (o as T.InstancedMesh).count > 0);
    expect(active.map(mesh => mesh.name).sort()).toEqual([
      'traffic/lamp-glows', 'traffic/semi/lod0/body', 'traffic/semi/lod0/details', 'traffic/semi/lod0/lights', 'traffic/shadows',
    ]);
  });
  it('uploads only occupied matrix/colour/signal ranges, never the unused pool or constant lamp colours', () => {
    sim.traffic.cars.forEach(c => { c.active = false; });
    const car = sim.traffic.cars[0];
    car.active = true; car.spec = VEHICLES[0]; car.gen++; place(car, 20); tick();
    for (const part of ['body', 'details', 'lights']) {
      const m = mesh(`traffic/sedan/lod0/${part}`);
      expect(m.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
      if (part !== 'lights') expect(m.instanceColor!.updateRanges).toEqual([{ start: 0, count: 3 }]);
      else {
        expect(m.instanceColor!.version).toBe(0);
        expect((m.geometry.getAttribute('trafficSignal') as T.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 3 }]);
      }
    }
    const shadows = mesh('traffic/shadows');
    expect(shadows.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
    const glows = mesh('traffic/lamp-glows');
    expect(glows.instanceMatrix.updateRanges).toEqual([{ start: 0, count: glows.count * 16 }]);
    const version = shadows.instanceMatrix.version;
    car.active = false; tick();
    expect(shadows.count).toBe(0); expect(shadows.instanceMatrix.version).toBe(version);
  });
});
