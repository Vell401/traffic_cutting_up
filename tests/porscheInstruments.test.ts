import { describe,it,expect,vi } from 'vitest';
import { PorscheInstruments } from '../src/render/car/porscheCockpit';
import { PorscheCar } from '../src/sim/vehiclePorsche';

describe('Porsche dashboard upload budget',()=>{
 it('draws the large surfaces once and updates only the small readouts when visible and changed',()=>{
  const gradient={addColorStop:vi.fn()};
  const g=new Proxy({createRadialGradient:()=>gradient},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{},set:()=>true});
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>g})});
  const instruments=new PorscheInstruments(),car=new PorscheCar();car.reset(0,0,20);
  try{
   const background=instruments.cluster.version,pcm=instruments.pcm.version,initial=instruments.readouts.version;
   for(let i=0;i<120;i++){car.vx=i/2;car.rpm=900+i*30;instruments.update(car,1/60);}
   expect(instruments.cluster.version).toBe(background);expect(instruments.pcm.version).toBe(pcm);
   expect(instruments.readouts.version-initial).toBeGreaterThan(15);
   expect(instruments.readouts.version-initial).toBeLessThanOrEqual(24);
   const live=instruments.readouts.version;instruments.group.visible=false;
   for(let i=0;i<120;i++){car.rpm+=1;instruments.update(car,1/60);}
   expect(instruments.readouts.version).toBe(live);
   expect(instruments.readouts.image.width*instruments.readouts.image.height).toBeLessThan(70000);
   expect(instruments.readouts.generateMipmaps).toBe(false);
  }finally{instruments.dispose();vi.unstubAllGlobals();}
 });
});
