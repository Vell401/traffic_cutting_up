import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLTFLoader, type GLTF } from 'three-stdlib';
import { actualA45 } from './miamiCarFixture';
import { renderDocument } from './renderCanvas';
import { PlayerView } from '../src/render/playerView';
import { createCar, bodyPhysics } from '../src/sim/physics';
import { RemoteCar } from '../src/render/remoteCar';
import { rendererHarness } from './rendererHarness';
import { MiamiCarBatching, MIAMI_CAR_SHADOW_LAYER } from '../src/render/miami/carBatching';

let gltf: GLTF;
let w204: GLTF;
beforeAll(async () => {
  gltf = await actualA45();
  w204 = await actualA45('mercedes-w204.glb');
  vi.stubGlobal('document', renderDocument);
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((url, done) => { queueMicrotask(() => done(url.includes('w204') ? w204 : gltf)); });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function realCar(optIn = true, own = true) {
  const car = createCar(bodyPhysics(3)); car.reset(300, 0, 0);
  const view = new PlayerView(3, 0x3366ff, new THREE.Texture(), car.tune.length, car.tune.width, own, false, optIn);
  await view.ready; return { view, car };
}
const meshes = (root: THREE.Object3D) => {
  const out: THREE.Mesh[] = []; root.traverseVisible(o => { if ((o as THREE.Mesh).isMesh && o.layers.test(new THREE.Layers())) out.push(o as THREE.Mesh); }); return out;
};
function drawCounts(root: THREE.Object3D) {
  const colour = meshes(root), shadow: THREE.Mesh[] = [], layers = new THREE.Layers(); layers.enable(MIAMI_CAR_SHADOW_LAYER);
  root.traverseVisible(o => { const m = o as THREE.Mesh; if (m.isMesh && m.castShadow && m.layers.test(layers)) shadow.push(m); });
  return { calls: colour.length + shadow.length,
    triangles: [...colour, ...shadow].reduce((n, m) => n + (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3, 0) };
}

describe('Miami lossless static car draws — real A45 builder boundary', () => {
  it('opts in before readiness and removes the real A45 main+sun draw multiplier without dropping triangles or casters', async () => {
    const legacy = await realCar(false), next = await realCar();
    expect(legacy.view.body.getObjectByName('WHEEL_LF')).toBeDefined();
    const before = drawCounts(legacy.view.root), after = drawCounts(next.view.root);
    expect(before.calls).toBe(789); expect(after.calls).toBe(286); // Actual complete A45, colour + sun (not a proxy or unique-kit count).
    expect(after.triangles).toBe(before.triangles);
    legacy.view.dispose(); next.view.dispose();
  });
  it('retains exact material identities and all vertex/index attributes through steering, spin, suspension and camera/paint/brake/signals states', async () => {
    const { view, car } = await realCar(false);
    const batching = new MiamiCarBatching(view.body);
    expect(batching.batches.length).toBeGreaterThan(0);
    for (const [steer, spin, pitch, cockpit, ghost] of [[0,0,0,false,false],[.25,1.2,4,true,false],[-.3,-2,-6,false,false],[.1,3,2,true,true]] as const) {
      car.steerAngle = steer; car.steerIn = Math.sign(steer); car.accLong = pitch; car.accLat = -pitch;
      car.brake = .8; car.blinker = 1; car.gear = steer < 0 ? 2 : 3;
      view.setPaint(0x992244); view.setCockpit(cockpit); view.setGhost(ghost);
      view.wheelAngles.fill(spin); view.update(.04, car, new THREE.Vector3(30, 0, -40), .4);
      batching.update(); view.root.updateMatrixWorld(true);
      let positionError = 0, normalError = 0, changedAttributes = 0, triangles = 0, changedIndices = 0, worst = '';
      for (const batch of batching.batches) for (const part of batch.parts) {
        const source = part.source, expected = source.geometry, actual = batch.mesh.geometry;
        expect(batch.mesh.material).toBe(source.material);
        const normalA = new THREE.Matrix3().getNormalMatrix(source.matrixWorld), normalB = new THREE.Matrix3().getNormalMatrix(batch.mesh.matrixWorld);
        for (let v = 0; v < expected.getAttribute('position').count; v++) {
          const a = new THREE.Vector3().fromBufferAttribute(expected.getAttribute('position'), v).applyMatrix4(source.matrixWorld);
          const b = new THREE.Vector3().fromBufferAttribute(actual.getAttribute('position'), part.vertexOffset + v).applyMatrix4(batch.mesh.matrixWorld);
          if (a.distanceTo(b) > positionError) { positionError = a.distanceTo(b); worst = `${source.name} steer=${steer} ghost=${ghost} at ${v}: ${a.toArray()} / ${b.toArray()}`; }
          const na = new THREE.Vector3().fromBufferAttribute(expected.getAttribute('normal'), v).applyNormalMatrix(normalA);
          const nb = new THREE.Vector3().fromBufferAttribute(actual.getAttribute('normal'), part.vertexOffset + v).applyNormalMatrix(normalB);
          normalError = Math.max(normalError, na.distanceTo(nb));
          for (const name of Object.keys(expected.attributes).filter(n => !['position','normal','tangent'].includes(n))) {
            const x = expected.getAttribute(name), y = actual.getAttribute(name);
            for (let k = 0; k < x.itemSize; k++) if (x.array[v * x.itemSize + k] !== y.array[(part.vertexOffset + v) * y.itemSize + k]) changedAttributes++;
          }
        }
        for (let i = 0; i < expected.index!.count; i += 3) {
          const order = part.mirrored ? [0,2,1] : [0,1,2];
          for (let k = 0; k < 3; k++) if (actual.index!.getX(part.indexOffset + i + k) !== expected.index!.getX(i + order[k]) + part.vertexOffset) changedIndices++;
          triangles++;
        }
      }
      expect(triangles).toBeGreaterThan(400000); expect(positionError, worst).toBeLessThan(0.00001); expect(normalError).toBeLessThan(0.00001); expect(changedAttributes).toBe(0); expect(changedIndices).toBe(0);
      if (ghost) for (const batch of batching.batches) if ((batch.mesh.material as THREE.Material).transparent) expect(batch.mesh.layers.mask).toBe(1 << MIAMI_CAR_SHADOW_LAYER);
    }
    batching.dispose(); view.dispose();
  });
  it('restores originals on authored visibility/local-transform/material changes and transparent ghost sorting, and reuses bounded geometry on return', async () => {
    const { view } = await realCar(false), batcher = new MiamiCarBatching(view.body);
    const batch = batcher.batches.find(b => b.parts.length > 2 && !b.shadowOnly)!, first = batch.parts[0].source;
    const geometry = batch.mesh.geometry, originalLayers = batch.parts[0].layers;
    first.visible = false; batcher.update(); expect(batch.mesh.visible).toBe(false);
    expect(first.layers.mask).toBe(originalLayers); first.visible = true; batcher.update(); expect(batch.mesh.visible).toBe(true);
    first.position.x += .2; batcher.update(); expect(batch.mesh.visible).toBe(false);
    first.position.x -= .2; batcher.update(); expect(batch.mesh.visible).toBe(true);
    view.setGhost(true); batcher.update(); expect(batch.mesh.layers.mask).toBe(1 << MIAMI_CAR_SHADOW_LAYER); expect(first.layers.mask).toBe(originalLayers); expect(first.castShadow).toBe(false);
    view.setGhost(false); batcher.update(); expect(batch.mesh.visible).toBe(true); expect(batch.mesh.geometry).toBe(geometry);
    const dispose = vi.spyOn(geometry, 'dispose'), source = vi.spyOn(first.geometry, 'dispose'), material = vi.spyOn(first.material as THREE.Material, 'dispose');
    batcher.dispose(); batcher.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(source).not.toHaveBeenCalled(); expect(material).not.toHaveBeenCalled(); expect(first.layers.mask).toBe(originalLayers);
    view.dispose();
  });
  it('preserves the exact original transparent colour draw order in ghost/cockpit/bumper states, not a merged approximation', async () => {
    const { view, car } = await realCar(false);
    const original: THREE.Mesh[] = []; view.root.traverse(o => { if ((o as THREE.Mesh).isMesh) original.push(o as THREE.Mesh); });
    const batcher = new MiamiCarBatching(view.body);
    const camera = new THREE.PerspectiveCamera();
    const order = (list: THREE.Mesh[]) => list.filter(m => (m.material as THREE.Material).transparent).map(m => ({ id: m.id, renderOrder: m.renderOrder,
      z: new THREE.Vector3().setFromMatrixPosition(m.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z }))
      .sort((a,b) => a.renderOrder-b.renderOrder || a.z-b.z || a.id-b.id).map(m=>m.id);
    for (const [ghost, cockpit, bumper, x] of [[false,false,false,0],[true,false,false,3],[true,true,false,-2],[false,true,false,0],[false,false,true,0]] as const) {
      view.setGhost(ghost); view.setCockpit(cockpit); view.setVisualsVisible(!bumper);
      view.update(.02, car, new THREE.Vector3(), .2); batcher.update(); view.root.updateMatrixWorld(true);
      camera.position.set(x, cockpit ? 1.16 : 2.15, cockpit ? .17 : 6.3); camera.lookAt(0, 1, -10); camera.updateMatrixWorld(true);
      const expected = bumper ? [] : order(original.filter(m => { for (let n: THREE.Object3D | null=m; n; n=n.parent) if(!n.visible)return false; return true; }));
      expect(order(meshes(view.root))).toEqual(expected);
      for (const m of original.filter(m => (m.material as THREE.Material).transparent)) expect(m.layers.mask).toBe(1);
      for (const b of batcher.batches.filter(b => (b.mesh.material as THREE.Material).transparent)) expect(b.mesh.layers.mask).toBe(2);
    }
    batcher.dispose(); view.dispose();
  });
  it('prepares actual optional remote A45 batches before reveal, preserving shared material/repaint/reveal identities and disposal', async () => {
    const shadow = new THREE.Texture(), remote = new RemoteCar(3, 0x3366ff, shadow, 4.6, 1.9, true);
    const renderer = rendererHarness(); Object.assign(renderer, { initTexture: vi.fn() });
    const scene = new THREE.Scene(); scene.add(remote.root); await remote.prepare(renderer as unknown as THREE.WebGLRenderer, new THREE.PerspectiveCamera(), scene);
    const detail = (remote as unknown as {detail: PlayerView}).detail;
    const batcher = (detail as unknown as {miamiBatching: MiamiCarBatching}).miamiBatching;
    expect(batcher.batches.length).toBeGreaterThan(0);
    for (const b of batcher.batches) for (const p of b.parts) expect(b.mesh.material).toBe(p.source.material);
    const car = createCar(bodyPhysics(3)); car.reset(300, 0, 0); car.steerAngle = -.25;
    remote.setPaint(0x889922); remote.update(.4, car, new THREE.Vector3(0,0,-50), .2, 50);
    expect(drawCounts(detail.root).calls).toBeLessThan(300); expect(renderer.compileAsync).toHaveBeenCalled();
    const privateGeo = batcher.batches.map(b => vi.spyOn(b.mesh.geometry,'dispose'));
    const sharedGeo = vi.spyOn(batcher.batches[0].parts[0].source.geometry,'dispose');
    remote.dispose(); privateGeo.forEach(s=>expect(s).toHaveBeenCalledOnce()); expect(sharedGeo).not.toHaveBeenCalled();
  });
  it('preserves actual authored branch visibility and every paint/brake/signal/ghost material value against an unbatched builder', async () => {
    const baseline = await realCar(false), optimized = await realCar();
    const materialState = (root: THREE.Object3D) => {
      const states = new Map<string,string>(); root.traverse(o => {
        const m = o as THREE.Mesh; if (!m.isMesh || m.name.startsWith('miami/')) return;
        const material=m.material as THREE.MeshStandardMaterial;
        states.set(m.name,JSON.stringify({name:material.name,color:material.color?.toArray(),emissive:material.emissive?.toArray(),opacity:material.opacity,
          transparent:material.transparent,depthWrite:material.depthWrite,side:material.side}));
      }); return [...states].sort(([a],[b])=>a.localeCompare(b));
    };
    for(const ghost of [false,true,false]) {
      for(const entry of [baseline,optimized]) {
        entry.car.brake=.8;entry.car.blinker=-1;entry.car.steerAngle=-.2;entry.car.steerIn=-.5;entry.car.accLong=5;entry.car.accLat=-3;
        entry.view.setPaint(0x445599);entry.view.setGhost(ghost);entry.view.setCockpit(!ghost);entry.view.setHighBeam(true);
        entry.view.body.getObjectByName('COCKPIT_HR')!.visible=!ghost;
        entry.view.update(.04,entry.car,new THREE.Vector3(4,0,8),-.3);entry.view.root.updateMatrixWorld(true);
      }
      expect(materialState(optimized.view.root)).toEqual(materialState(baseline.view.root));
      expect(drawCounts(optimized.view.root).triangles).toBe(drawCounts(baseline.view.root).triangles);
      expect(optimized.view.headlights.map(l=>[l.intensity,l.distance,l.angle])).toEqual(baseline.view.headlights.map(l=>[l.intensity,l.distance,l.angle]));
    }
    baseline.view.dispose();optimized.view.dispose();
  });
  it('does not attach batching after a cancelled real model readiness and does not dispose borrowed source geometry', async () => {
    const source = gltf.scene.getObjectByProperty('isMesh',true) as THREE.Mesh, dispose=vi.spyOn(source.geometry,'dispose');
    const view=new PlayerView(3,0x3366ff,new THREE.Texture(),4.6,1.9,true,false,true);
    view.dispose(); await expect(view.ready).rejects.toThrow('disposed'); await Promise.resolve();
    expect((view as unknown as {miamiBatching: unknown}).miamiBatching).toBeNull();expect(dispose).not.toHaveBeenCalled();
  });
  it('keeps the unfrozen wrapper default/Highway path entirely unbatched with the original actual model draws', async () => {
    const car=createCar(bodyPhysics(3));const view=new PlayerView(3,0x3366ff,new THREE.Texture(),car.tune.length,car.tune.width,true,false);
    await view.ready;expect((view as unknown as {miamiBatching:unknown}).miamiBatching).toBeNull();
    expect(view.root.getObjectByName('miami/static-car-batch')).toBeUndefined();expect(drawCounts(view.root).calls).toBe(789);view.dispose();
  });
  it('consolidates the real W204 static imported body while retaining the independent steering wheel, needles, glazing gates and rolling wheel roots', async () => {
    const car=createCar(bodyPhysics(4));car.reset(300,0,0);
    const baseline=new PlayerView(4,0x3366ff,new THREE.Texture(),car.tune.length,car.tune.width,true,false,false);
    const view=new PlayerView(4,0x3366ff,new THREE.Texture(),car.tune.length,car.tune.width,true,false,true);
    await Promise.all([baseline.ready,view.ready]);
    const batcher=(view as unknown as {miamiBatching: MiamiCarBatching}).miamiBatching;
    expect(batcher.batches.length).toBeGreaterThan(0);
    const wheelRoot=(view as unknown as {parts:{wheelRoot:THREE.Group}}).parts.wheelRoot;
    expect(batcher.batches.some(b=>{for(let n:THREE.Object3D|null=b.mesh;n;n=n.parent)if(n===wheelRoot)return true;return false;})).toBe(true);
    const original=drawCounts(baseline.root), optimized=drawCounts(view.root);
    expect(original.calls).toBeGreaterThan(500);expect(optimized.calls).toBeLessThan(300);expect(optimized.triangles).toBe(original.triangles);
    for(const cockpit of [true,false,true]) {
      car.steerAngle=.2;car.steerIn=.4;car.accLong=3;car.accLat=-4;
      for(const v of [baseline,view]){v.setCockpit(cockpit);v.setPaint(0x889933);v.setGhost(false);v.wheelAngles.fill(1.7);v.update(.04,car,new THREE.Vector3(2,0,-8),.2);v.root.updateMatrixWorld(true);}
      expect(drawCounts(view.root).triangles).toBe(drawCounts(baseline.root).triangles);
      let positionError=0,normalError=0,changedAttributes=0,changedIndices=0;
      for(const batch of batcher.batches)for(const part of batch.parts){
        const g=part.source.geometry,b=batch.mesh.geometry,nA=new THREE.Matrix3().getNormalMatrix(part.source.matrixWorld),nB=new THREE.Matrix3().getNormalMatrix(batch.mesh.matrixWorld);
        expect(part.source.material).toBe(batch.mesh.material);
        for(let i=0;i<g.getAttribute('position').count;i++){
          positionError=Math.max(positionError,new THREE.Vector3().fromBufferAttribute(g.getAttribute('position'),i).applyMatrix4(part.source.matrixWorld)
            .distanceTo(new THREE.Vector3().fromBufferAttribute(b.getAttribute('position'),part.vertexOffset+i).applyMatrix4(batch.mesh.matrixWorld)));
          normalError=Math.max(normalError,new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'),i).applyNormalMatrix(nA)
            .distanceTo(new THREE.Vector3().fromBufferAttribute(b.getAttribute('normal'),part.vertexOffset+i).applyNormalMatrix(nB)));
          for(const name of Object.keys(g.attributes).filter(n=>!['position','normal','tangent'].includes(n))){const a=g.getAttribute(name),c=b.getAttribute(name);
            for(let k=0;k<a.itemSize;k++)if(a.array[i*a.itemSize+k]!==c.array[(part.vertexOffset+i)*c.itemSize+k])changedAttributes++;}
        }
        for(let i=0;i<g.index!.count;i+=3)for(let k=0;k<3;k++)if(b.index!.getX(part.indexOffset+i+k)!==g.index!.getX(i+(part.mirrored?[0,2,1]:[0,1,2])[k])+part.vertexOffset)changedIndices++;
      }
      expect(positionError).toBeLessThan(.00001);expect(normalError).toBeLessThan(.00001);expect(changedAttributes).toBe(0);expect(changedIndices).toBe(0);
      for(const name of ['SteeringWheel','c63w204kene_needle_speedo_Selected','c63w204kene_needle_tacho_Selected','c63w204kene_windshield_Selected']) {
        const a=baseline.body.getObjectByName(name)!,b=view.body.getObjectByName(name)!;expect(a).toBeDefined();expect(b.visible).toBe(a.visible);
        expect(b.matrixWorld.elements).toEqual(a.matrixWorld.elements);
      }
    }
    baseline.dispose();view.dispose();
  });
  it('keeps mirrored winding/normal/tangent and full attributes, refuses incompatible/transparent/dynamic mesh types', () => {
    const root = new THREE.Group(), domain = new THREE.Group(); domain.name = 'MAIN_BODY'; root.add(domain);
    const material = new THREE.MeshStandardMaterial();
    const original: THREE.Mesh[] = [];
    for (const sign of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(), material); m.geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(Array.from({length:24},()=>[1,0,0,-1]).flat(),4));
      m.scale.set(sign * 2, 1.3, .7); m.rotation.set(.1,.2,.3); m.position.x = sign; domain.add(m); original.push(m);
    }
    const transparent = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true })); domain.add(transparent);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), material); hidden.visible = false; domain.add(hidden);
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), material); domain.add(skinned);
    const array = new THREE.Mesh(new THREE.BoxGeometry(), [material,material]); domain.add(array);
    const batcher = new MiamiCarBatching(root); root.scale.set(-1, 2, 1); root.updateMatrixWorld(true);
    expect(batcher.batches).toHaveLength(1); expect(batcher.batches[0].parts).toHaveLength(2);
    expect(transparent.layers.mask).toBe(1); expect(hidden.layers.mask).toBe(1); expect(skinned.layers.mask).toBe(1);expect(array.layers.mask).toBe(1);
    const batch = batcher.batches[0];
    let positionError=0,normalError=0;
    for (const part of batch.parts) {
      const matrix = new THREE.Matrix4().copy(domain.matrixWorld).invert().multiply(part.source.matrixWorld);
      const expected = part.source.geometry.clone().applyMatrix4(matrix);
      expect(Array.from(batch.mesh.geometry.getAttribute('tangent').array.slice(part.vertexOffset*4,(part.vertexOffset+24)*4))).toEqual(Array.from(expected.getAttribute('tangent').array));
      expect(part.mirrored).toBe(part.source.scale.x < 0); expected.dispose();
      const normalA=new THREE.Matrix3().getNormalMatrix(part.source.matrixWorld), normalB=new THREE.Matrix3().getNormalMatrix(batch.mesh.matrixWorld);
      for(let i=0;i<part.source.geometry.index!.count;i+=3) {
        const aOrder=part.source.matrixWorld.determinant()<0?[0,2,1]:[0,1,2], bOrder=batch.mesh.matrixWorld.determinant()<0?[0,2,1]:[0,1,2];
        for(let k=0;k<3;k++) {
          const a=part.source.geometry.index!.getX(i+aOrder[k]), b=batch.mesh.geometry.index!.getX(part.indexOffset+i+bOrder[k]);
          positionError=Math.max(positionError,new THREE.Vector3().fromBufferAttribute(part.source.geometry.getAttribute('position'),a).applyMatrix4(part.source.matrixWorld)
            .distanceTo(new THREE.Vector3().fromBufferAttribute(batch.mesh.geometry.getAttribute('position'),b).applyMatrix4(batch.mesh.matrixWorld)));
          normalError=Math.max(normalError,new THREE.Vector3().fromBufferAttribute(part.source.geometry.getAttribute('normal'),a).applyNormalMatrix(normalA)
            .distanceTo(new THREE.Vector3().fromBufferAttribute(batch.mesh.geometry.getAttribute('normal'),b).applyNormalMatrix(normalB)));
        }
      }
    }
    expect(positionError).toBeLessThan(0.000001); expect(normalError).toBeLessThan(0.000001);
    batcher.dispose();
  });
});
