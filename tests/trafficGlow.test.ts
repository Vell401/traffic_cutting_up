import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TRAFFIC_LIGHTING, trafficGlowMaterial, trafficLampLayout } from '../src/render/trafficViewLights';
import { TrafficView } from '../src/render/trafficView';
import { buildModel, type Kind } from '../src/render/trafficModels';
import { MAX_TRAFFIC } from '../src/sim/traffic';
import { VEHICLES } from '../src/sim/vehicles';
import { Sim } from '../src/sim/world';
import { mulberry32 } from '../src/core/rng';

describe('bounded instanced traffic optical glow', () => {
  it('derives four small halos and a rear ground wash from the actual lenses of every traffic type', () => {
    for (const spec of VEHICLES) {
      const model = buildModel(spec.name as Kind), geometry = model.parts[2], layout = trafficLampLayout(geometry);
      expect(layout.map(l => l.role)).toEqual([1,1,2,2,3]);
      const p = geometry.getAttribute('position'), roles = geometry.getAttribute('partRole');
      for (const lamp of layout.filter(l => l.role < 3)) {
        expect(lamp.width).toBeGreaterThan(0); expect(lamp.width).toBeLessThan(1.2);
        expect(lamp.height).toBeGreaterThan(0); expect(lamp.height).toBeLessThan(.8);
        expect(lamp.position.y).toBeGreaterThan(.2);
        const z: number[] = [];
        for (let i=0; i<p.count; i++) if (roles.getX(i) === lamp.role && p.getX(i)*lamp.position.x > 0) z.push(p.getZ(i));
        if (lamp.role === 1) expect(lamp.position.z).toBeLessThan(Math.min(...z));
        else expect(lamp.position.z).toBeGreaterThan(Math.max(...z));
      }
      const wash = layout[4];
      expect(wash.position.y).toBe(TRAFFIC_LIGHTING.washY); expect(wash.position.x).toBeCloseTo(0,4);
      expect(wash.position.z).toBeGreaterThan(Math.max(layout[2].position.z,layout[3].position.z));
      expect(wash.width).toBeGreaterThanOrEqual(1.5); expect(wash.width).toBeLessThanOrEqual(2.6);
      expect(wash.height).toBe(2.2);
      model.parts.forEach(g => g.dispose());
    }
  });

  it('uses one depth-tested draw, brake state and distance culling without creating dynamic lights', () => {
    const view = new TrafficView(new THREE.Texture()), sim = new Sim(mulberry32(39));
    const glows = view.group.getObjectByName('traffic/lamp-glows') as THREE.InstancedMesh;
    const state = glows.geometry.getAttribute('trafficLampState'), material = glows.material as THREE.ShaderMaterial;
    const c = sim.traffic.cars[0]; sim.traffic.cars.forEach(car => { car.active = false; });
    const place = (distance: number) => { c.s = c.prevS = sim.player.s + distance; c.d = c.prevD = sim.player.d; };
    const tick = (ox=0,oz=0) => view.update(sim,1,ox,oz,0);
    try {
      c.active = true; c.spec = VEHICLES[0]; c.braking = true; place(20); tick();
      expect(glows.count).toBe(5); expect(glows.instanceMatrix.count).toBe(MAX_TRAFFIC*TRAFFIC_LIGHTING.instancesPerCar);
      expect([0,1,2,3,4].map(i => state.getX(i))).toEqual([1,1,2,2,3]);
      expect([0,1,2,3,4].map(i => state.getY(i))).toEqual([1,1,1,1,1]);
      expect(material.blending).toBe(THREE.AdditiveBlending); expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false);
      expect(material.fog).toBe(true); expect(material.toneMapped).toBe(false);
      expect(material.vertexShader).toContain('dot(normalize(forward), normalize(-mvPosition.xyz))');
      expect(material.fragmentShader).toContain('alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth)');
      expect(material.vertexShader).toContain('vec4(position.x, 0.0, -position.y, 1.0)');
      expect(material.vertexShader).toContain('smoothstep(45.0, 85.0, length(mvPosition.xyz))');
      expect(glows.geometry.getAttribute('position').count).toBe(4);
      expect(view.group.children.some(o => o instanceof THREE.Light)).toBe(false);
      expect(glows.instanceMatrix.updateRanges).toEqual([{start:0,count:80}]);
      const before = new THREE.Matrix4(), after = new THREE.Matrix4(); glows.getMatrixAt(0,before);
      tick(1000,-2000); glows.getMatrixAt(0,after);
      expect(after.elements[12]).toBeCloseTo(before.elements[12]-1000,3);
      expect(after.elements[14]).toBeCloseTo(before.elements[14]+2000,3);
      glows.getMatrixAt(4,after); expect(after.elements[13]).toBeCloseTo(TRAFFIC_LIGHTING.washY);
      const up = new THREE.Vector3(0,1,0).transformDirection(after); expect(up.y).toBeCloseTo(1,6);
      c.braking = false; tick(); expect(state.getY(4)).toBe(0);
      c.braking = false; place(90); tick(); expect(glows.count).toBe(4); expect(state.getY(2)).toBe(0);
      place(300); tick(); expect(glows.count).toBe(0); expect(glows.visible).toBe(false);
      c.active = false; tick(); expect(glows.count).toBe(0);
    } finally {
      const materials = new Set<THREE.Material>();
      view.group.children.forEach(o => { const m=o as THREE.InstancedMesh; m.geometry.dispose(); materials.add(m.material as THREE.Material); m.dispose(); });
      materials.forEach(m => m.dispose());
    }
  });

  it('fits rear wash and halos for the complete pool into the same single lighting batch', () => {
    const view = new TrafficView(new THREE.Texture()), sim = new Sim(mulberry32(40));
    try {
      for (const c of sim.traffic.cars) {
        c.active=true; c.spec=VEHICLES[0]; c.s=c.prevS=sim.player.s+15; c.d=c.prevD=sim.player.d;
      }
      view.update(sim,1,0,0,0);
      const glows = view.group.getObjectByName('traffic/lamp-glows') as THREE.InstancedMesh;
      expect(glows.count).toBe(MAX_TRAFFIC*TRAFFIC_LIGHTING.instancesPerCar);
      const roles = glows.geometry.getAttribute('trafficLampState');
      expect(Array.from({length:glows.count},(_,i)=>roles.getX(i)).filter(r=>r===3)).toHaveLength(MAX_TRAFFIC);
      expect(view.group.children.filter(o=>o.visible&&(o as THREE.InstancedMesh).count>0)).toHaveLength(5);
    } finally {
      const materials = new Set<THREE.Material>();
      view.group.children.forEach(o => { const m=o as THREE.InstancedMesh; m.geometry.dispose(); materials.add(m.material as THREE.Material); m.dispose(); });
      materials.forEach(m => m.dispose());
    }
  });

  it('keeps the horizontal rear wash attached to interpolated car yaw and road heading, not the camera', () => {
    const view = new TrafficView(new THREE.Texture()), sim = new Sim(mulberry32(41));
    sim.traffic.cars.forEach(car => { car.active = false; });
    const c = sim.traffic.cars[0];
    c.active = true; c.spec = VEHICLES[0]; c.s = c.prevS = 20; c.d = c.prevD = 3;
    sim.player.s = sim.player.prevS = 0; sim.player.d = sim.player.prevD = 0;
    let heading = 0;
    sim.road.toWorld = (s,d,p) => Object.assign(p, {x:d,z:-s,th:heading,k:0});
    const glows = view.group.getObjectByName('traffic/lamp-glows') as THREE.InstancedMesh;
    const body = view.group.getObjectByName('traffic/sedan/lod0/body') as THREE.InstancedMesh;
    const lenses = view.group.getObjectByName('traffic/sedan/lod0/lights') as THREE.InstancedMesh;
    const layout = trafficLampLayout(lenses.geometry);
    const wash = layout.find(lamp => lamp.role === 3)!;
    try {
      for (const roadHeading of [0, .7, -1.2]) for (const yaw of [0, Math.PI/2, -Math.PI/2, Math.PI]) {
        heading = roadHeading; c.prevYaw = yaw - .2; c.yaw = yaw + .6;
        const alpha = .25, ox = 1000, oz = -2000;
        view.update(sim, alpha, ox, oz, 0);
        const carMatrix = new THREE.Matrix4(), washMatrix = new THREE.Matrix4();
        body.getMatrixAt(0, carMatrix); glows.getMatrixAt(4, washMatrix);
        const expected = wash.position.clone().applyMatrix4(carMatrix);
        const center = new THREE.Vector3().setFromMatrixPosition(washMatrix);
        expect(center.distanceTo(expected)).toBeLessThan(.0002);
        expect(center.y).toBeCloseTo(TRAFFIC_LIGHTING.washY,6);
        const rear = new THREE.Vector3(0,0,1).transformDirection(carMatrix);
        const behind = center.clone().sub(new THREE.Vector3().setFromMatrixPosition(carMatrix)); behind.y = 0;
        expect(behind.normalize().dot(rear)).toBeCloseTo(1,6);
        expect(new THREE.Vector3(0,0,1).transformDirection(washMatrix).dot(rear)).toBeCloseTo(1,6);
        // The shader maps plane (x,y) to ground (x,0,-y); every corner stays level.
        for (const x of [-.5,.5]) for (const y of [-.5,.5])
          expect(new THREE.Vector3(x,0,-y).applyMatrix4(washMatrix).y).toBeCloseTo(TRAFFIC_LIGHTING.washY,6);
      }
    } finally {
      const materials = new Set<THREE.Material>();
      view.group.children.forEach(o => { const m=o as THREE.InstancedMesh; m.geometry.dispose(); materials.add(m.material as THREE.Material); m.dispose(); });
      materials.forEach(m => m.dispose());
    }
  });

  it('caps night wash brightness well below a lens while braking increases the red road tint', () => {
    const material = trafficGlowMaterial();
    try {
      const { washTail, washBrake, washOpacity } = TRAFFIC_LIGHTING;
      expect(washOpacity).toBeGreaterThan(0); expect(washOpacity).toBeLessThanOrEqual(.2);
      // Conservative peak added sRGB value on black asphalt, before distance/elevation/fog fading.
      const tail = new THREE.Color(...washTail).convertLinearToSRGB().r * washOpacity;
      const brake = new THREE.Color(...washBrake).convertLinearToSRGB().r * washOpacity;
      expect(tail).toBeGreaterThan(0); expect(brake).toBeGreaterThan(tail * 1.5);
      expect(brake).toBeLessThan(.13);
      expect(washBrake[0]).toBeGreaterThan(washBrake[1] * 20);
      expect(material.vertexShader).toContain(`vec3(${washTail.join(', ')})`);
      expect(material.vertexShader).toContain(`vec3(${washBrake.join(', ')})`);
      expect(material.fragmentShader).toContain(`* ${washOpacity};`);
    } finally { material.dispose(); }
  });
});
