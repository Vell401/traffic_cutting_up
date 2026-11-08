import * as THREE from 'three';
import type { CarParts } from './index';
import { buildR34Exterior } from './r34Exterior';
import { buildR34Cockpit } from './r34Cockpit';

/** R34-only assembly: no other model, material, camera or handling preset is reused/mutated. */
export function buildR34Parts(paint: number, length: number, width: number, own: boolean): CarParts {
  const exterior=buildR34Exterior(paint),cabin=buildR34Cockpit();
  const scale=new THREE.Vector3(width/1.785,1,length/4.6);
  exterior.body.add(cabin.group);
  exterior.body.scale.copy(scale);exterior.wheelRoot.scale.copy(scale);
  cabin.setCockpit?.(false);
  const managedMaterials=new Set<THREE.Material>();
  for(const root of [exterior.body,exterior.wheelRoot])root.traverse(o=>{
    const material=(o as THREE.Mesh).material;
    if(material)for(const m of [material].flat())if(!m.userData.shared)managedMaterials.add(m);
  });
  return {
    ...exterior,managedMaterials,updateCabin:cabin.update,cockpit:own?cabin:null,
    lamp:new THREE.Vector3(0,.62,-2.24).multiply(scale),lampX:.6*scale.x,
    setCockpit(on){exterior.setCockpit?.(on);cabin.group.visible=true;cabin.setCockpit?.(on);},
    dispose(){exterior.dispose();cabin.dispose();},
  };
}
