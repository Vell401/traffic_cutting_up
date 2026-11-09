/** W204 lossless delivery, reusing the proven Porsche buffer codec. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
await Promise.all([MeshoptDecoder.ready,MeshoptEncoder.ready]);
const work='/tmp/opencode/w204', output='public/models/mercedes-w204.glb';
// Blender 3 pads ushort index views; encode accessor count, never padding as indices.
{
 const src=fs.readFileSync(`${work}/raw.glb`),jl=src.readUInt32LE(12),g=JSON.parse(src.subarray(20,20+jl)),bin=src.subarray(28+jl),pieces=[];let size=0,fallback=0;
 const append=raw=>{const pad=(4-size%4)%4;pieces.push(Buffer.alloc(pad),Buffer.from(raw));size+=pad;const at=size;size+=raw.length;return at;};
 const cs={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},ts={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
 for(let i=0;i<g.bufferViews.length;i++){
  const v=g.bufferViews[i],a=g.accessors.find(a=>a.bufferView===i),raw=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
  if(a){const stride=v.byteStride??cs[a.componentType]*ts[a.type],mode=a.type==='SCALAR'?'INDICES':'ATTRIBUTES',count=a.count,data=raw.subarray(0,count*stride),packed=MeshoptEncoder.encodeGltfBuffer(data,count,stride,mode),decoded=new Uint8Array(data.length);MeshoptDecoder.decodeGltfBuffer(decoded,count,stride,packed,mode);if(Buffer.compare(Buffer.from(decoded),data))throw Error('Meshopt roundtrip');v.extensions={EXT_meshopt_compression:{buffer:0,byteOffset:append(packed),byteLength:packed.length,byteStride:stride,count,mode}};v.buffer=1;v.byteOffset=fallback;v.byteLength=data.length;fallback+=data.length;}
  else{v.buffer=0;v.byteOffset=append(raw);}
 }
 const body=Buffer.concat(pieces);g.buffers=[{byteLength:body.length},{byteLength:fallback,extensions:{EXT_meshopt_compression:{fallback:true}}}];g.extensionsUsed=[...(g.extensionsUsed??[]),'EXT_meshopt_compression'];g.extensionsRequired=[...(g.extensionsRequired??[]),'EXT_meshopt_compression'];
 const j=Buffer.from(JSON.stringify(g)),jp=Buffer.alloc((4-j.length%4)%4,32),bp=Buffer.alloc((4-body.length%4)%4),h=Buffer.alloc(20),b=Buffer.alloc(8);h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(28+j.length+jp.length+body.length+bp.length,8);h.writeUInt32LE(j.length+jp.length,12);h.writeUInt32LE(0x4e4f534a,16);b.writeUInt32LE(body.length+bp.length);b.writeUInt32LE(0x004e4942,4);fs.writeFileSync(output,Buffer.concat([h,j,jp,b,body,bp]));console.log('Delivered bytes',fs.statSync(output).size);
}
const f=fs.readFileSync(output),len=f.readUInt32LE(12),g=JSON.parse(f.subarray(20,20+len)),bin=f.subarray(28+len);
// Decode the DELIVERED compressed payload into a Blender-compatible inspection GLB.
const chunks=[];let offset=0;
for(const v of g.bufferViews){
 const e=v.extensions?.EXT_meshopt_compression;let raw;
 if(e){raw=new Uint8Array(v.byteLength);MeshoptDecoder.decodeGltfBuffer(raw,e.count,e.byteStride,bin.subarray(e.byteOffset,e.byteOffset+e.byteLength),e.mode,e.filter);delete v.extensions.EXT_meshopt_compression;if(!Object.keys(v.extensions).length)delete v.extensions;}
 else raw=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
 const pad=(4-offset%4)%4;chunks.push(Buffer.alloc(pad),Buffer.from(raw));offset+=pad;v.buffer=0;v.byteOffset=offset;offset+=raw.length;
}
g.buffers=[{byteLength:offset}];for(const k of ['extensionsUsed','extensionsRequired'])g[k]=(g[k]??[]).filter(x=>x!=='EXT_meshopt_compression');
const body=Buffer.concat(chunks),j=Buffer.from(JSON.stringify(g)),jp=Buffer.alloc((4-j.length%4)%4,32),bp=Buffer.alloc((4-body.length%4)%4),h=Buffer.alloc(20),b=Buffer.alloc(8);h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(28+j.length+jp.length+body.length+bp.length,8);h.writeUInt32LE(j.length+jp.length,12);h.writeUInt32LE(0x4e4f534a,16);b.writeUInt32LE(body.length+bp.length);b.writeUInt32LE(0x004e4942,4);fs.writeFileSync(`${work}/inspection.glb`,Buffer.concat([h,j,jp,b,body,bp]));
console.log('Verified delivery decoded for Blender inspection.');
const sha256 = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
fs.writeFileSync(`${work}/compression.json`, JSON.stringify({
  deliveredSha256: sha256(output), inspectionSha256: sha256(`${work}/inspection.glb`), byteRoundtripVerified: true,
}, null, 2));
