import * as T from 'three';
import { describe, it, expect } from 'vitest';
import { buildModel, catalog, defaults, type Kind, type LOD } from '../src/render/trafficModels';
import { VEHICLES } from '../src/sim/vehicles';

describe('traffic lab assets',()=>{
  for(const kind of Object.keys(catalog) as Kind[]) {
    it(`${kind}: compatible dimensions, valid indexed geometry and declining LOD budgets`,()=>{
      const d=catalog[kind],spec=VEHICLES.find(v=>v.name===kind)!;
      expect(d.length).toBe(spec.len);expect(d.width).toBe(spec.wid);
      let previous=Infinity;
      for(const lod of [0,1,2] as LOD[]) {
        const m=buildModel(kind,lod);
        expect(m.parts.length).toBe(3);expect(m.triangles).toBeLessThan(previous);expect(m.triangles).toBeLessThan(6500);previous=m.triangles;
        for(const g of m.parts) {
          expect(g.groups.length).toBe(0);
          const p=g.getAttribute('position'),n=g.getAttribute('normal');
          expect(g.index).not.toBeNull();expect(g.getAttribute('color').count).toBe(p.count);
          for(const x of p.array)expect(Number.isFinite(x)).toBe(true);
          for(let i=0;i<n.count;i++)expect(Math.hypot(n.getX(i),n.getY(i),n.getZ(i))).toBeCloseTo(1,3);
          for(const i of g.index!.array)expect(i).toBeLessThan(p.count);
          expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(-.001);
          expect(g.boundingBox!.max.z-g.boundingBox!.min.z).toBeLessThan(d.length+.3);
          g.dispose();
        }
      }
    });
    it(`${kind}: extreme editable proportions stay finite`,()=>{
      for(const value of [.9,1.1]) {const m=buildModel(kind,0,{...defaults,height:value,wheelScale:value});for(const g of m.parts){expect([...g.getAttribute('position').array].every(Number.isFinite)).toBe(true);g.dispose();}}
    });
  }
});

// Regression: the former end-cap rows used different heights from the side shell,
// leaving visible slits just inside the outer rear/front corners.
describe('closed traffic body joins',()=>{
  for(const kind of Object.keys(catalog) as Kind[])it(`${kind}: both end corners and wheel tubs block rays`,()=>{
    const d=catalog[kind],truck=kind==='semi'||kind==='boxTruck',hw=(d.width-(truck?.18:0))/2;
    const belt=truck?(kind==='semi'?1.84:1.61):kind==='suv'?1.08:kind==='minivan'?1.03:.88;
    const bottom=truck?.48:kind==='suv'?.32:.23;
    for(const lod of [0,1,2] as LOD[]){
      const model=buildModel(kind,lod),mat=new T.MeshBasicMaterial({side:T.DoubleSide});
      const meshes=model.parts.map(g=>new T.Mesh(g,mat));
      const ray=new T.Raycaster();
      for(const side of [-1,1])for(const end of [-1,1]){
        const f=end===1?d.length/2:truck?d.cabinRear:-d.length/2;
        const top=belt-(end===1?.14:truck?0:.035);
        for(const t of [.4,.5,.65]){
          const y=T.MathUtils.lerp(bottom,top,t);
          ray.set(new T.Vector3(side*hw*.88*.995,y,-f-end*.05),new T.Vector3(0,0,end));
          const hit=ray.intersectObject(meshes[0],false)[0];
          expect(hit,`${kind} LOD ${lod} corner ${side}/${end}`).toBeDefined();
          expect(hit.distance).toBeCloseTo(.05,3);
        }
      }
      for(const side of [-1,1]){
        const r=d.wheel,f=d.front+r+.025;
        ray.set(new T.Vector3(side*(hw+.05),r+.04,-f),new T.Vector3(-side,0,0));
        const hit=ray.intersectObjects(meshes,false)[0];
        expect(hit).toBeDefined();expect(hit.distance).toBeLessThan(.4);
      }
      model.parts.forEach(g=>g.dispose());mat.dispose();
    }
  });
});
