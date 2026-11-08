import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PlayerView } from '../src/render/playerView';
import { PlayerCar } from '../src/sim/vehicle';

function materials(view: PlayerView): THREE.Material[] {
  const found=new Set<THREE.Material>();
  view.root.traverse(o=>{const m=(o as THREE.Mesh).material;if(m)for(const mat of [m].flat())found.add(mat);});
  return [...found];
}
const colors=(view:PlayerView)=>materials(view).map(m=>(m as THREE.MeshStandardMaterial).color?.getHex());
describe('R34 body/cockpit integration',()=>{
  it('keeps a left-hand cabin visible outside, restores ghost materials and isolates repaint/disposal',()=>{
    const own=new PlayerView(2,0x2146b7,new THREE.Texture(),4.6,1.79,true);
    const other=new PlayerView(2,0x914229,new THREE.Texture(),4.6,1.79,false);
    try{
      expect(own.eye!.position.x).toBeLessThan(-.3);expect(other.eye).toBeNull();
      let tris=0;other.body.traverse(o=>{const g=(o as THREE.Mesh).geometry;if(g)tris+=(g.index?.count??g.attributes.position.count)/3;});
      // Remote drivers retain the detailed seats/dash instead of an empty exterior shell.
      expect(tris).toBeGreaterThan(150_000);
      own.setCockpit(true);expect(own.eye!.parent!.visible).toBe(true);
      own.setCockpit(false);expect(own.eye!.parent!.visible).toBe(true);
      const baseline=materials(own).map(material=>({material,opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite}));
      own.setGhost(true);own.setCockpit(true);own.setCockpit(false);
      for(const b of baseline)if(!b.material.userData.shared)expect(b.material.opacity).toBeCloseTo(b.opacity*.35);
      own.setGhost(false);
      for(const b of baseline){expect(b.material.opacity).toBe(b.opacity);expect(b.material.transparent).toBe(b.transparent);expect(b.material.depthWrite).toBe(b.depthWrite);}
      const otherColors=colors(other),ownColors=colors(own);own.setPaint(0x3daa75);
      expect(colors(own)).not.toEqual(ownColors);expect(colors(other)).toEqual(otherColors);
      // Body and physics are independent on reconnect: a generic car must not break the instruments.
      own.setCockpit(true);const generic=new PlayerCar();generic.reset(0,0,20);own.update(1/60,generic,new THREE.Vector3(),0);
      const disposal=new Map<THREE.Material,number>();
      for(const material of materials(own)){disposal.set(material,0);material.addEventListener('dispose',()=>disposal.set(material,disposal.get(material)!+1));}
      own.dispose();
      for(const [material,count]of disposal)if(!material.userData.shared)expect(count,material.name).toBe(1);
      other.update(1/60,generic,new THREE.Vector3(),0);
      expect(colors(other)).toEqual(otherColors);
    }finally{own.dispose();other.dispose();}
  });
  it('updates cabin steering/odometry in chase view and remote cars without uploading sleeping LCDs',()=>{
    const own=new PlayerView(2,0x2452a8,new THREE.Texture(),4.6,1.79,true);
    const remote=new PlayerView(2,0x2452a8,new THREE.Texture(),4.6,1.79,false);
    try{
      const display=own.body.getObjectByName('R34 odometer gear speed display') as THREE.Mesh;
      const map=(display.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
      const pixels=map.image.data!.slice(),version=map.version;
      own.setCockpit(false);const car=new PlayerCar();car.vx=30;car.steerIn=1;car.steerAngle=.08;
      for(let i=0;i<3600;i++)own.update(1/60,car,new THREE.Vector3(),0);
      remote.update(1/60,car,new THREE.Vector3(),0);
      expect(own.body.getObjectByName('R34 animated steering wheel')!.rotation.z).toBeLessThan(0);
      expect(remote.body.getObjectByName('R34 animated steering wheel')!.rotation.z).toBeLessThan(0);
      expect(map.version).toBe(version);
      car.vx=0;car.steerIn=0;car.steerAngle=0;own.setCockpit(true);
      own.update(1/60,car,new THREE.Vector3(),0);
      expect(map.image.data).not.toEqual(pixels);
      expect(map.version).toBeGreaterThan(version);
    }finally{own.dispose();remote.dispose();}
  });
});
