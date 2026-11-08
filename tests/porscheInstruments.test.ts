import { describe,it,expect,vi } from 'vitest';
import { PorscheInstruments, drawPorscheClusterBase } from '../src/render/car/porscheCockpit';
import { PorscheCar } from '../src/sim/vehiclePorsche';
import { PlayerView } from '../src/render/playerView';
import * as THREE from 'three';

describe('Porsche dashboard upload budget',()=>{
 it('does not paint a rectangular plate outside the five instrument pods',()=>{
  const clearRect=vi.fn(),fillRect=vi.fn(),gradient={addColorStop:vi.fn()};
  const g=new Proxy({clearRect,fillRect,createRadialGradient:()=>gradient},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{},set:()=>true});
  drawPorscheClusterBase(g as unknown as CanvasRenderingContext2D);
  expect(clearRect).toHaveBeenCalledWith(0,0,2048,576);
  expect(fillRect).not.toHaveBeenCalledWith(0,0,2048,576);
 });
 it('fades the generated instrument cluster with a ghosted car, including camera switches',async()=>{
  const gradient={addColorStop:vi.fn()};
  const g=new Proxy({createRadialGradient:()=>gradient},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{},set:()=>true});
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>g})});
  const view=new PlayerView(1,0xfee1f9,new THREE.Texture());
  try{
   const cluster=view.root.getObjectByName('Porsche_Cached_Instrument_Cluster') as THREE.Mesh;
   const material=cluster.material as THREE.MeshBasicMaterial;
   expect(material.alphaTest).toBeGreaterThan(0);
   view.setGhost(true);view.setCockpit(true);
   expect(material.opacity).toBeCloseTo(.35);
   await view.ready;expect(material.opacity).toBeCloseTo(.35);
   view.setGhost(false);view.setCockpit(false);view.setCockpit(true);
   expect(material.opacity).toBe(1);expect(material.transparent).toBe(true);
  }finally{view.dispose();vi.unstubAllGlobals();}
 });
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
