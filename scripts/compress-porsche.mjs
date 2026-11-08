import fs from 'node:fs';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const source=process.argv[2]??'data/porsche/porsche-irl10.raw.glb',target=process.argv[3]??'data/porsche/porsche-irl10.full.glb';
const file=fs.readFileSync(source),jl=file.readUInt32LE(12),g=JSON.parse(file.subarray(20,20+jl)),bin=file.subarray(28+jl);
const pieces=[];let size=0,fallback=0,compressedViews=0;
function append(data){const pad=(4-size%4)%4;if(pad){pieces.push(Buffer.alloc(pad));size+=pad;}const offset=size;pieces.push(data);size+=data.length;return offset;}
const comps={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},types={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
for(let i=0;i<g.bufferViews.length;i++){
 const v=g.bufferViews[i],raw=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength),a=g.accessors.find(a=>a.bufferView===i);
 if(a&&!a.sparse){
  const stride=v.byteStride??comps[a.componentType]*types[a.type];const mode=v.target===34963?'INDICES':'ATTRIBUTES';
  if(v.byteLength%stride||mode==='ATTRIBUTES'&&stride%4)throw Error('Unexpected buffer layout '+i);
  const count=v.byteLength/stride,packed=MeshoptEncoder.encodeGltfBuffer(raw,count,stride,mode);
  const decoded=new Uint8Array(raw.length);MeshoptDecoder.decodeGltfBuffer(decoded,count,stride,packed,mode);
  if(Buffer.compare(raw,decoded)!==0)throw Error('Lossless round-trip failed '+i);
  v.extensions={...v.extensions,EXT_meshopt_compression:{buffer:0,byteOffset:append(Buffer.from(packed)),byteLength:packed.length,byteStride:stride,count,mode}};
  v.buffer=1;v.byteOffset=fallback;fallback+=v.byteLength;compressedViews++;
 }else{v.buffer=0;v.byteOffset=append(raw);}
}
const binary=Buffer.concat(pieces);g.buffers=[{byteLength:binary.length},{byteLength:fallback,extensions:{EXT_meshopt_compression:{fallback:true}}}];
g.extensionsUsed=[...new Set([...(g.extensionsUsed??[]),'EXT_meshopt_compression'])];g.extensionsRequired=[...new Set([...(g.extensionsRequired??[]),'EXT_meshopt_compression'])];
const json=Buffer.from(JSON.stringify(g)),jp=Buffer.alloc((4-json.length%4)%4,32),bp=Buffer.alloc((4-binary.length%4)%4),head=Buffer.alloc(20),bh=Buffer.alloc(8);head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+jp.length+binary.length+bp.length,8);head.writeUInt32LE(json.length+jp.length,12);head.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(binary.length+bp.length);bh.writeUInt32LE(0x004e4942,4);
fs.writeFileSync(target,Buffer.concat([head,json,jp,bh,binary,bp]));console.log(JSON.stringify({sourceBytes:file.length,resultBytes:fs.statSync(target).size,compressedViews,verified:'all geometry buffers decoded byte-for-byte'},null,2));
