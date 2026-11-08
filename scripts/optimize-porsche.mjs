/** A separate, reproducible delivery pass. The full-detail authoring GLB stays in data/porsche. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MeshoptEncoder,MeshoptDecoder,MeshoptSimplifier } from 'meshoptimizer';
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready,MeshoptSimplifier.ready]);
const root=fileURLToPath(new URL('../',import.meta.url));
const work=path.join(root,'data/porsche/optimized');fs.mkdirSync(work,{recursive:true});
const input=process.argv[2]??path.join(root,'data/porsche/porsche-irl10.raw.glb');
const output=process.argv[3]??path.join(root,'public/models/porsche-911-irl10.glb');
const file=fs.readFileSync(input),length=file.readUInt32LE(12),g=JSON.parse(file.subarray(20,20+length)),binary=file.subarray(28+length);
const views=g.bufferViews.map(v=>{
  const ext=v.extensions?.EXT_meshopt_compression;
  if(!ext)return binary.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
  const bytes=new Uint8Array(v.byteLength);MeshoptDecoder.decodeGltfBuffer(bytes,ext.count,ext.byteStride,binary.subarray(ext.byteOffset,ext.byteOffset+ext.byteLength),ext.mode,ext.filter);return bytes;
});
const originalImageBytes=g.images.map(im=>views[im.bufferView].length);
const originalImageHashes=g.images.map(im=>createHash('sha256').update(views[im.bufferView]).digest('hex'));
const originalImageMimes=g.images.map(im=>im.mimeType);
const trianglesBefore=g.nodes.reduce((sum,n)=>sum+(n.mesh===undefined?0:g.meshes[n.mesh].primitives.reduce((s,p)=>s+g.accessors[p.indices].count/3,0)),0);
const components={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
function readAccessor(id){
  const a=g.accessors[id],size=components[a.componentType]*sizes[a.type],stride=g.bufferViews[a.bufferView].byteStride??size,src=views[a.bufferView];
  const raw=new Uint8Array(a.count*size);
  for(let i=0;i<a.count;i++)raw.set(src.subarray((a.byteOffset??0)+i*stride,(a.byteOffset??0)+i*stride+size),i*size);
  return raw;
}
const uses=g.images.map(()=>[]);
for(const m of g.materials){
  const p=m.pbrMetallicRoughness??{};
  for(const [kind,t] of Object.entries({...p,normalTexture:m.normalTexture,emissiveTexture:m.emissiveTexture}))if(t&&typeof t==='object'&&'index'in t)
    uses[g.textures[t.index].source].push({material:m.name,kind});
}
const plan=g.images.map((im,i)=>{
  const source=path.join(work,`source-${i}.image`);fs.writeFileSync(source,views[im.bufferView]);
  const names=uses[i].map(u=>u.material).join('|'),normal=uses[i].some(u=>u.kind==='normalTexture');
  let cap=512;
  if(/P911_Tires/.test(names))cap=normal?1024:2048;
  else if(/hoodbadge/i.test(names))cap=2048;
  else if(/Porsche_logowing/.test(names))cap=2048;
  else if(/carbon_roof|CSR2_Badge/.test(names))cap=512;
  else if(/TwiXeR_992_web|ID12_paint|Interior_D/.test(names))cap=1024;
  else if(normal&&/plastic|leather|stitch|rivet/.test(names))cap=256;
  const jpeg=!normal&&!/logo|Badge|symbols|inttex|gauges|carbon|PDK|Interior_D/i.test(names);
  return {index:i,input:source,output:path.join(work,`image-${i}`),cap,jpeg,uses:uses[i]};
});
const planFile=path.join(work,'texture-plan.json');fs.writeFileSync(planFile,JSON.stringify(plan));
execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/resize-porsche-textures.ps1'),'-Plan',planFile],{stdio:'inherit',windowsHide:true});
const images=JSON.parse(fs.readFileSync(planFile+'.results.json','utf8').replace(/^\uFEFF/,''));
const imageBytes=images.map(im=>fs.readFileSync(im.path));
let oldPixels=0,newPixels=0;for(const im of images){oldPixels+=im.originalWidth*im.originalHeight;newPixels+=im.width*im.height;}

// New buffers contain compacted attributes and indices. Meshopt round trips are checked byte-for-byte.
const chunks=[],bufferViews=[],accessors=[];let offset=0,fallback=0;
function append(data){const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}const at=offset;chunks.push(Buffer.from(data));offset+=data.byteLength;return at;}
function accessor(data,componentType,type,count,target){
  const stride=components[componentType]*sizes[type],mode=target===34963?'INDICES':'ATTRIBUTES';
  const packed=MeshoptEncoder.encodeGltfBuffer(data,count,stride,mode),decoded=new Uint8Array(data.byteLength);
  MeshoptDecoder.decodeGltfBuffer(decoded,count,stride,packed,mode);
  if(Buffer.compare(Buffer.from(data),Buffer.from(decoded)))throw Error('Meshopt mismatch');
  const index=bufferViews.length;bufferViews.push({buffer:1,byteOffset:fallback,byteLength:data.byteLength,target,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:append(packed),byteLength:packed.byteLength,byteStride:stride,count,mode}}});fallback+=data.byteLength;
  const a={bufferView:index,componentType,count,type};
  if(type==='VEC3'&&target===34962){const f=new Float32Array(data.buffer,data.byteOffset,data.byteLength/4);a.min=[Infinity,Infinity,Infinity];a.max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<count;i++)for(let k=0;k<3;k++){a.min[k]=Math.min(a.min[k],f[i*3+k]);a.max[k]=Math.max(a.max[k],f[i*3+k]);}}
  const id=accessors.length;accessors.push(a);return id;
}
function policy(name,steering){
  if(steering)return {ratio:1,error:0,protected:true};
  if(/BodyPaint|carbon_roof|glass|Glass|badge|logo|GT3RS|symbols|stitch|gauges_9000/i.test(name))return {ratio:1,error:0,protected:true};
  if(/wheels_black_gloss/.test(name))return {ratio:.25,error:.0015};
  if(/head_frame/.test(name))return {ratio:.25,error:.001};
  if(/SV_SKIN/.test(name))return {ratio:.4,error:.0015};
  if(/rubbertrim/.test(name))return {ratio:.4,error:.0008};
  if(/gauges_chrome_2/.test(name))return {ratio:.25,error:.0004};
  if(/P911_Tires/.test(name))return {ratio:.55,error:.0008};
  return {ratio:.55,error:/leather|seat|carpet/.test(name)?.0015:.0008};
}
const records=[];
const meshes=g.meshes.map((mesh,mi)=>({name:mesh.name,primitives:mesh.primitives.map((p,pi)=>{
  const name=g.materials[p.material].name,steering=g.nodes.some(n=>n.name==='SteeringWheel'&&n.mesh===mi),rule=policy(name,steering);
  const attrs=Object.fromEntries(Object.entries(p.attributes).map(([semantic,id])=>[semantic,{a:g.accessors[id],data:readAccessor(id)}]));
  const a=g.accessors[p.indices],raw=readAccessor(p.indices),dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  let indices=Uint32Array.from({length:a.count},(_,i)=>a.componentType===5123?dv.getUint16(i*2,true):dv.getUint32(i*4,true));
  const original=indices.length/3;let error=0;
  const hash=()=>{const h=createHash('sha256');for(const key of Object.keys(attrs).sort())h.update(attrs[key].data);h.update(new Uint8Array(indices.buffer));return h.digest('hex');};
  const beforeHash=hash();
  if(rule.ratio<1&&indices.length>=180){
    const pos=new Float32Array(attrs.POSITION.data.buffer),norm=attrs.NORMAL?new Float32Array(attrs.NORMAL.data.buffer):null,uv=attrs.TEXCOORD_0?new Float32Array(attrs.TEXCOORD_0.data.buffer):null;
    const count=attrs.POSITION.a.count,weights=[...(norm?[.1,.1,.1]:[]),...(uv?[.5,.5]:[])],stride=weights.length,extra=new Float32Array(count*stride);
    for(let v=0;v<count;v++){let k=0;if(norm)for(let j=0;j<3;j++)extra[v*stride+k++]=norm[v*3+j];if(uv)for(let j=0;j<2;j++)extra[v*stride+k++]=uv[v*2+j];}
    [indices,error]=MeshoptSimplifier.simplifyWithAttributes(indices,pos,3,extra,stride,weights,null,Math.floor(indices.length*rule.ratio/3)*3,rule.error,['LockBorder','ErrorAbsolute']);
    const [remap,n]=MeshoptSimplifier.compactMesh(indices);
    for(const attr of Object.values(attrs)){
      const size=components[attr.a.componentType]*sizes[attr.a.type],data=new Uint8Array(n*size);
      for(let v=0;v<remap.length;v++)if(remap[v]!==0xffffffff)data.set(attr.data.subarray(v*size,(v+1)*size),remap[v]*size);
      attr.data=data;attr.a={...attr.a,count:n};
    }
  }
  const afterHash=hash();if(rule.protected&&beforeHash!==afterHash)throw Error(`Protected surface changed: ${name}`);
  records.push({mesh:mi,primitive:pi,material:name,before:original,after:indices.length/3,errorLimit:rule.error,error,protected:!!rule.protected,beforeHash,afterHash});
  return {...p,attributes:Object.fromEntries(Object.entries(attrs).map(([semantic,{a,data}])=>[semantic,accessor(data,a.componentType,a.type,a.count,34962)])),indices:accessor(new Uint8Array(indices.buffer),5125,'SCALAR',indices.length,34963)};
})}));

// Split static primitives into visibility sets without touching their vertices or material boundaries.
function visibility(name,material){
  if(/gauges_9000|glass_gauges|gauges_screen|Gauge_Yellow|gauges_1_web/.test(name))return 'stock-gauges';
  if(material.alphaMode==='BLEND'&&/glass/i.test(name))return 'window-glass';
  if(/head_frame|headlight|taillight|brakelight|signal_[LR]|metal_radiator|enginebay|Porsche_logowing/i.test(name))return 'exterior-detail';
  return 'structure';
}
for(const node of [...g.nodes])if(node.name==='Body_and_Cockpit'&&node.mesh!==undefined){
  const parts=new Map();for(const p of meshes[node.mesh].primitives){const m=g.materials[p.material],kind=visibility(m.name,m);if(!parts.has(kind))parts.set(kind,[]);parts.get(kind).push(p);}
  node.children??=[];
  for(const [kind,primitives] of parts){const index=meshes.length;meshes.push({name:`Porsche_${kind}`,primitives});node.children.push(g.nodes.length);g.nodes.push({name:`Porsche_${kind}`,mesh:index,extras:{porscheVisibility:kind}});}
  delete node.mesh;
}
// Remove the now-unused unsplit static mesh; remap references so no duplicate primitives are delivered.
const active=[...new Set(g.nodes.flatMap(n=>n.mesh===undefined?[]:[n.mesh]))],remap=new Map(active.map((id,i)=>[id,i]));
const trianglesAfter=g.nodes.reduce((sum,n)=>sum+(n.mesh===undefined?0:meshes[n.mesh].primitives.reduce((s,p)=>s+accessors[p.indices].count/3,0)),0);
for(const n of g.nodes)if(n.mesh!==undefined)n.mesh=remap.get(n.mesh);
g.meshes=active.map(id=>meshes[id]);
g.images=g.images.map((im,i)=>{const index=bufferViews.length,bytes=imageBytes[i];bufferViews.push({buffer:0,byteOffset:append(bytes),byteLength:bytes.length});return {...im,bufferView:index,mimeType:images[i].mime};});
g.bufferViews=bufferViews;g.accessors=accessors;
const body=Buffer.concat(chunks);g.buffers=[{byteLength:body.length},{byteLength:fallback,extensions:{EXT_meshopt_compression:{fallback:true}}}];
g.asset.generator='Porsche delivery optimizer: protected shell, attribute-aware details, selective texture budgets';
g.extensionsUsed=[...new Set([...(g.extensionsUsed??[]),'EXT_meshopt_compression'])];
g.extensionsRequired=[...new Set([...(g.extensionsRequired??[]),'EXT_meshopt_compression'])];
const json=Buffer.from(JSON.stringify(g)),jp=Buffer.alloc((4-json.length%4)%4,32),bp=Buffer.alloc((4-body.length%4)%4),head=Buffer.alloc(20),bh=Buffer.alloc(8);
head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+jp.length+body.length+bp.length,8);head.writeUInt32LE(json.length+jp.length,12);head.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(body.length+bp.length);bh.writeUInt32LE(0x004e4942,4);
fs.writeFileSync(output,Buffer.concat([head,json,jp,bh,body,bp]));
const report={sourceBytes:file.length,resultBytes:fs.statSync(output).size,trianglesBefore,trianglesAfter,texturePixelsBefore:oldPixels,texturePixelsAfter:newPixels,rgbaMipBytesBefore:Math.round(oldPixels*4*4/3),rgbaMipBytesAfter:Math.round(newPixels*4*4/3),images:images.map((im,i)=>({...im,path:undefined,cap:plan[i].cap,sourceMime:originalImageMimes[i],bytesBefore:originalImageBytes[i],bytesAfter:imageBytes[i].length,hashBefore:originalImageHashes[i],hashAfter:createHash('sha256').update(imageBytes[i]).digest('hex'),uses:uses[i]})),primitives:records};
fs.writeFileSync(path.join(root,'docs/porsche-optimization.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,images:undefined,primitives:undefined},null,2));
