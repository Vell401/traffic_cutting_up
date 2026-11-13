import * as THREE from 'three';
import { expect, it } from 'vitest';
import { WebGLObjects } from 'three/src/renderers/webgl/WebGLObjects.js';
import { TrafficView } from '../src/render/trafficView';
import { Sim } from '../src/sim/world';
import { mulberry32 } from '../src/core/rng';
import { VEHICLES } from '../src/sim/vehicles';

const parts = (v: TrafficView, type = 'sedan', lod = 0) => ['body','details','lights'].map(p => v.group.getObjectByName(`traffic/${type}/lod${lod}/${p}`) as THREE.InstancedMesh);
function cleanup(v: TrafficView) {
  const meshes = [...v.group.children] as THREE.InstancedMesh[], materials = new Set(meshes.map(m => m.material as THREE.Material));
  meshes.forEach(m => { m.geometry.dispose(); m.dispose(); }); materials.forEach(m => m.dispose());
}
it('shares one matrix stream only within a type/LOD/view, writing and dirtying it once with unchanged transforms/signals', () => {
  const a = new TrafficView(new THREE.Texture()), b = new TrafficView(new THREE.Texture()), sim = new Sim(mulberry32(7));
  sim.traffic.cars.forEach(c => { c.active = false; }); const c = sim.traffic.cars[0]; c.active = true; c.spec = VEHICLES[0];
  try {
    const unique = new Set<THREE.InstancedBufferAttribute>();
    for (const view of [a,b]) for (const spec of VEHICLES) for (const lod of [0,1,2]) {
      const batch = parts(view, spec.name, lod);
      expect(batch[1].instanceMatrix).toBe(batch[0].instanceMatrix); expect(batch[2].instanceMatrix).toBe(batch[0].instanceMatrix);
      unique.add(batch[0].instanceMatrix);
    }
    expect(unique.size).toBe(48);
    expect([...parts(a)[0].instanceMatrix.array.slice(16,32)]).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    for (const [distance, lod, ox, oz] of [[20,0,0,0],[55,1,1000,-2000],[140,2,-3000,4000],[30,0,0,0]]) {
      c.s = c.prevS = sim.player.s + distance; c.d = c.prevD = sim.player.d; c.yaw = c.prevYaw = .2; c.gen++;
      const batch = parts(a, 'sedan', lod), version = batch[0].instanceMatrix.version;
      a.update(sim, 1, ox, oz, 0);
      expect(batch[0].instanceMatrix.version).toBe(version + 1);
      const p = sim.road.toWorld(c.s, c.d, { x:0,z:0,th:0,k:0 });
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(p.x-ox,0,p.z-oz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -(p.th+.2)), new THREE.Vector3(1,1,1));
      expect([...batch[0].instanceMatrix.array.slice(0,16)]).toEqual([...new Float32Array(matrix.elements)]);
      expect(batch[0].instanceMatrix.updateRanges).toEqual([{ start:0,count:16 }]);
    }
  } finally { cleanup(a); cleanup(b); }
});

it.each([1,3].flatMap(rendered => [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]].map(order => ({ rendered, order }))))('keeps live sibling buffers for disposal order $order with $rendered rendered parts', ({ rendered, order }) => {
  const view = new TrafficView(new THREE.Texture()), [body, details, lights] = parts(view);
  const [first,second,last] = order.map(i => [body,details,lights][i]);
  const buffers = new Set<THREE.BufferAttribute>(), removed: THREE.BufferAttribute[] = [];
  const boundary = [{ ARRAY_BUFFER: 34962 }, { get: (_o: unknown, g: unknown) => g, update: () => {} }, {
    update: (a: THREE.BufferAttribute) => buffers.add(a),
    remove: (a: THREE.BufferAttribute) => { if (buffers.delete(a)) removed.push(a); },
  }, { releaseStatesOfObject: () => {} }, { render: { frame: 1 } }] as unknown as ConstructorParameters<typeof WebGLObjects>;
  const objects = new WebGLObjects(...boundary);
  const sim = new Sim(mulberry32(7)); sim.traffic.cars.forEach(c => { c.active = false; });
  const c = sim.traffic.cars[0]; c.active = true; c.spec = VEHICLES[0]; c.s = c.prevS = sim.player.s + 20;
  try {
    view.update(sim, 1, 0, 0, 0); [body,details,lights].slice(0,rendered).forEach(m => objects.update(m));
    const shared = last.instanceMatrix;
    first.dispose(); first.dispose(); expect(buffers.has(shared)).toBe(true); expect(removed.filter(a => a === shared)).toHaveLength(0);
    const before = [...shared.array.slice(0,16)]; view.update(sim, 1, 10, -20, 0);
    expect([...last.instanceMatrix.array.slice(0,16)]).not.toEqual(before);
    expect(second.instanceMatrix).toBe(last.instanceMatrix);
    second.dispose(); expect(buffers.has(shared)).toBe(true);
    last.dispose(); last.dispose(); expect(buffers.has(shared)).toBe(false); expect(removed.filter(a => a === shared)).toHaveLength(1);
  } finally {
    [body,details,lights].forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }); cleanup(view);
  }
});

it('preserves every occupied transform/paint/signal byte for the full pool across type/LOD generation reuse and rebases', () => {
  const view = new TrafficView(new THREE.Texture()), sim = new Sim(mulberry32(7));
  try {
    for (const [generation,ox,oz,time] of [[1,0,0,0],[2,1000,-2000,.5],[3,-3000,4000,0]]) {
      sim.traffic.cars.forEach((c,i) => {
        c.active = true; c.spec = VEHICLES[(i+generation)%8]; c.gen++;
        c.s = c.prevS = sim.player.s + [20,70,180][(i+generation)%3]; c.d = c.prevD = sim.player.d;
        c.yaw = c.prevYaw = (i%7)*.1; c.color = 0x123456+i; c.color2 = 0x654321-i; c.braking = i%2===0; c.blink = (i%4-1) as -1|0|1|2;
      });
      view.update(sim,1,ox,oz,time);
      const used = new Map<string,number>();
      sim.traffic.cars.forEach((c,i) => {
        const lod = (i+generation)%3, key = `${c.spec.name}/${lod}`, slot = used.get(key) ?? 0; used.set(key,slot+1);
        const [body,details,lights] = parts(view,c.spec.name,lod), p = sim.road.toWorld(c.s,c.d,{x:0,z:0,th:0,k:0});
        const expected = new Float32Array(new THREE.Matrix4().compose(new THREE.Vector3(p.x-ox,0,p.z-oz),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-(p.th+c.yaw)),new THREE.Vector3(1,1,1)).elements);
        for (const m of [body,details,lights]) expect(m.instanceMatrix.array.slice(slot*16,slot*16+16)).toEqual(expected);
        for (const [m,color] of [[body,c.color],[details,c.color2]] as const) expect(m.instanceColor!.array.slice(slot*3,slot*3+3)).toEqual(new Float32Array(new THREE.Color(color).toArray()));
        const signals = lights.geometry.getAttribute('trafficSignal');
        expect([...signals.array.slice(slot*3,slot*3+3)]).toEqual([Number(c.braking),Number(time===0&&(c.blink===-1||c.blink===2)),Number(time===0&&(c.blink===1||c.blink===2))]);
      });
      for (const [key,count] of used) { const [type,lod] = key.split('/'); for (const m of parts(view,type,Number(lod))) expect(m.count).toBe(count); }
    }
  } finally { cleanup(view); }
});
