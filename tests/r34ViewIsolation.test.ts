import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PlayerView } from '../src/render/playerView';
import { PlayerCar } from '../src/sim/vehicle';

function materials(view:PlayerView):THREE.Material[]{
  const result=new Set<THREE.Material>();
  view.root.traverse(o=>{const m=(o as THREE.Mesh).material;if(m)for(const material of [m].flat())result.add(material);});
  return [...result];
}
describe('R34-only rendering integration',()=>{
  it('keeps the cabin visible, restores ghost properties and does not repaint or dispose another instance',()=>{
    const a=new PlayerView(2,0x244dab,new THREE.Texture(),4.6,1.79,true);
    const b=new PlayerView(2,0x994b26,new THREE.Texture(),4.6,1.79,false);
    try{
      expect(a.eye!.position.x).toBeLessThan(-.3);expect(b.eye).toBeNull();
      a.setCockpit(false);expect(a.eye!.parent!.visible).toBe(true);
      const original=materials(a).map(material=>({material,opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite}));
      const otherColors=materials(b).map(m=>(m as THREE.MeshStandardMaterial).color?.getHex());
      a.setGhost(true);a.setCockpit(true);a.setCockpit(false);
      for(const entry of original)if(!entry.material.userData.shared)expect(entry.material.opacity).toBeCloseTo(entry.opacity*.35);
      a.setGhost(false);
      for(const e of original){expect(e.material.opacity).toBe(e.opacity);expect(e.material.transparent).toBe(e.transparent);expect(e.material.depthWrite).toBe(e.depthWrite);}
      a.setPaint(0x315b42);
      expect(materials(b).map(m=>(m as THREE.MeshStandardMaterial).color?.getHex())).toEqual(otherColors);
      const counts=new Map<THREE.Material,number>();
      for(const material of materials(a)){counts.set(material,0);material.addEventListener('dispose',()=>counts.set(material,counts.get(material)!+1));}
      a.dispose();for(const[material,count]of counts)if(!material.userData.shared)expect(count,material.name).toBe(1);
      b.update(1/60,new PlayerCar(),new THREE.Vector3(),0);
      expect(materials(b).map(m=>(m as THREE.MeshStandardMaterial).color?.getHex())).toEqual(otherColors);
    }finally{a.dispose();b.dispose();}
  });
  it('turns the cabin wheel for actual countersteer in exterior and remote views',()=>{
    for(const own of [true,false]){
      const view=new PlayerView(2,0x244dab,new THREE.Texture(),4.6,1.79,own);
      try{
        view.setCockpit(false);const car=new PlayerCar();car.vx=25;car.steerIn=0;car.steerAngle=-.75;
        for(let i=0;i<60;i++)view.update(1/60,car,new THREE.Vector3(),0);
        const wheel=view.body.getObjectByName('R34 animated steering wheel')!;
        expect(wheel.rotation.z).toBeGreaterThan(4); // Not the old 146-degree visual clamp.
      }finally{view.dispose();}
    }
  });
});
