/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { MeshoptDecoder } from 'meshoptimizer';
import { CARS } from '../src/sim/cars';
import { loadPaint,savePaint } from '../src/settings';
import { vi } from 'vitest';
import { Quaternion,Vector3 } from 'three';

const file=readFileSync(new URL('../public/models/porsche-911-irl10.glb',import.meta.url));
const jsonLength=file.readUInt32LE(12),asset=JSON.parse(file.subarray(20,20+jsonLength).toString()),bin=file.subarray(28+jsonLength);
const optimization=JSON.parse(readFileSync(new URL('../docs/porsche-optimization.json',import.meta.url),'utf8'));
let decodedViews:Uint8Array[]|undefined;
async function decodeViews():Promise<Uint8Array[]>{
 await MeshoptDecoder.ready;
 return decodedViews??=asset.bufferViews.map((v:{byteOffset?:number;byteLength:number;extensions?:Record<string,any>})=>{
  const ext=v.extensions?.EXT_meshopt_compression;
  if(!ext)return bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
  const decoded=new Uint8Array(v.byteLength);
  MeshoptDecoder.decodeGltfBuffer(decoded,ext.count,ext.byteStride,bin.subarray(ext.byteOffset,ext.byteOffset+ext.byteLength),ext.mode,ext.filter);
  return decoded;
 });
}
describe('Porsche IRL Spec 10 delivery',()=>{
 it('keeps the Coupe identity and the complete optimised body, cockpit and wheel assemblies',()=>{
  expect(CARS.find(c=>c.id===1)?.name).toBe('Porsche 911 GT3 RS');
  expect(file.length).toBeLessThan(12*1024*1024);
  for(const name of ['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR','SteeringWheel','Body_and_Cockpit'])expect(asset.nodes.some((n:{name:string})=>n.name===name)).toBe(true);
  for(const n of asset.nodes)expect(n.name??'').not.toMatch(/subframe|muffler|steeringbox|tierod|brakelines/);
  let triangles=0;
  for(const node of asset.nodes)if(node.mesh!==undefined)for(const p of asset.meshes[node.mesh].primitives){
   triangles+=asset.accessors[p.indices].count/3;
   expect(Object.keys(p.attributes).filter(k=>k.startsWith('TEXCOORD'))).toEqual(['TEXCOORD_0']);
   expect(Object.keys(p.attributes).some(k=>k.startsWith('COLOR'))).toBe(false);
  }
  expect(triangles).toBe(optimization.trianglesAfter);expect(triangles).toBeLessThan(260000);
  expect(asset.images.length).toBeGreaterThan(10);
  expect(asset.images.every((im:{bufferView:number})=>Number.isInteger(im.bufferView))).toBe(true);
  const root=asset.nodes.find((n:{name:string})=>n.name==='Porsche_911_GT3RS_IRL10');
  const wheel=asset.nodes.find((n:{name:string})=>n.name==='SteeringWheel');
  // BeamNG props are authored lying flat. The delivered steering face must point back at the driver.
  const face=new Vector3(0,1,0).applyQuaternion(new Quaternion(...wheel.rotation)).applyQuaternion(new Quaternion(...root.rotation));
  expect(face.z).toBeGreaterThan(.9);expect(face.y).toBeGreaterThan(.3);expect(face.y).toBeLessThan(.4);
 });
 it('decodes every losslessly compressed buffer and has valid index bounds',async()=>{
  const views=await decodeViews();
  for(const mesh of asset.meshes)for(const primitive of mesh.primitives){
   const a=asset.accessors[primitive.indices],data=views[a.bufferView],view=new DataView(data.buffer,data.byteOffset,data.byteLength),size=a.componentType===5123?2:4;
   for(let i=0;i<a.count;i++)expect(size===2?view.getUint16((a.byteOffset??0)+i*size,true):view.getUint32((a.byteOffset??0)+i*size,true)).toBeLessThan(asset.accessors[primitive.attributes.POSITION].count);
  }
 });
 it('preserves the protected body/steering surfaces exactly and respects texture/error budgets',async()=>{
  const views=await decodeViews(),hashes=new Set<string>();
  for(const mesh of asset.meshes)for(const primitive of mesh.primitives){
   const h=createHash('sha256');
   for(const key of Object.keys(primitive.attributes).sort()){
    const a=asset.accessors[primitive.attributes[key]];h.update(views[a.bufferView]);
   }
   h.update(views[asset.accessors[primitive.indices].bufferView]);hashes.add(h.digest('hex'));
  }
  const protectedParts=optimization.primitives.filter((p:{protected:boolean})=>p.protected);
  expect(protectedParts.length).toBeGreaterThan(20);
  for(const part of protectedParts){expect(part.beforeHash).toBe(part.afterHash);expect(hashes.has(part.afterHash)).toBe(true);}
  for(const part of optimization.primitives)expect(part.error).toBeLessThanOrEqual(part.errorLimit+1e-7);
  expect(optimization.rgbaMipBytesAfter).toBeLessThan(64*1024*1024);
  expect(optimization.rgbaMipBytesAfter).toBeLessThan(optimization.rgbaMipBytesBefore/5);
  for(const image of optimization.images){
   expect(Math.max(image.width,image.height)).toBe(Math.min(image.cap,Math.max(image.originalWidth,image.originalHeight)));
   expect(image.width/image.height).toBeCloseTo(image.originalWidth/image.originalHeight,1);
   expect(createHash('sha256').update(views[asset.images[image.index].bufferView]).digest('hex')).toBe(image.hashAfter);
   if(image.sourceMime==='image/png'&&image.mime==='image/png'&&Math.max(image.originalWidth,image.originalHeight)<=image.cap)expect(image.hashAfter).toBe(image.hashBefore);
  }
  for(const kind of ['exterior-detail','window-glass','stock-gauges'])expect(asset.nodes.some((n:{extras?:{porscheVisibility:string}})=>n.extras?.porscheVisibility===kind)).toBe(true);
 });
 it('starts with the spec paint and remembers changes independently of other cars',()=>{
  const storage=new Map<string,string>([['tcu.paint','#0000ff']]);
  vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});
  try{expect(loadPaint(1)).toBe(0xfee1f9);savePaint(0xff1111,1);expect(loadPaint(1)).toBe(0xff1111);expect(loadPaint(2)).toBe(0x0000ff);}finally{vi.unstubAllGlobals();}
 });
});
