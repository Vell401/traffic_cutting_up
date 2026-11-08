/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MeshoptDecoder } from 'meshoptimizer';

const file = readFileSync(new URL('../public/models/mercedes-a45s.glb', import.meta.url));
const size = file.readUInt32LE(12), asset = JSON.parse(file.subarray(20,20 + size).toString()), bin = file.subarray(28 + size);
const report = JSON.parse(readFileSync(new URL('../docs/a45-textures.json', import.meta.url), 'utf8'));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
describe('A45 appearance-preserving texture cleanup', () => {
  it('leaves all detailed images byte-identical, including the high-resolution tyre normal map', () => {
    expect(report.untouchedDetailedTextures).toBe(101);
    for (const record of report.records) {
      const view = asset.bufferViews[asset.images[record.index].bufferView];
      const png = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
      expect(hash(png)).toBe(record.hashAfter);
      if (record.protected) { expect(record.hashBefore).toBe(record.hashAfter); expect(record.after).toEqual(record.before); }
      else {
        expect(record.uniform).toBe(true); expect(record.after).toEqual([1,1]);
        let p=8; const chunks:Buffer[]=[];
        while(p<png.length){const n=png.readUInt32BE(p);if(png.toString('ascii',p+4,p+8)==='IDAT')chunks.push(png.subarray(p+8,p+8+n));p+=n+12;}
        const raw=inflateSync(Buffer.concat(chunks));
        expect(raw[0]).toBe(0); expect([...raw.subarray(1)]).toEqual(record.constantPixel);
      }
    }
    const tyre=report.records.find((r:{name:string})=>r.name==='advan_ad08r_nm.png');
    expect(tyre.after).toEqual([8192,1792]); expect(tyre.protected).toBe(true);
    expect(report.pixelsBefore-report.pixelsAfter).toBeGreaterThan(15_000_000);
  });
  it('preserves geometry, transforms, UVs and material parameters exactly and decodes every meshopt view', async () => {
    expect(report.geometryBefore).toBe(report.geometryAfter);
    const digest=createHash('sha256');
    digest.update(JSON.stringify({nodes:asset.nodes,meshes:asset.meshes,accessors:asset.accessors,materials:asset.materials}));
    for(const id of [...new Set<number>(asset.accessors.map((a:{bufferView:number})=>a.bufferView))].sort((a,b)=>a-b)){
      const v=asset.bufferViews[id],ext=v.extensions?.EXT_meshopt_compression;
      const start=ext?.byteOffset??v.byteOffset??0,length=ext?.byteLength??v.byteLength;
      digest.update(bin.subarray(start,start+length));
    }
    expect(digest.digest('hex')).toBe(report.geometryAfter);
    await MeshoptDecoder.ready;
    for(const v of asset.bufferViews){
      const ext=v.extensions?.EXT_meshopt_compression;if(!ext)continue;
      const decoded=new Uint8Array(v.byteLength);
      expect(()=>MeshoptDecoder.decodeGltfBuffer(decoded,ext.count,ext.byteStride,bin.subarray(ext.byteOffset,ext.byteOffset+ext.byteLength),ext.mode,ext.filter)).not.toThrow();
    }
    expect(file.length).toBe(report.bytesAfter);
    expect(hash(file)).toBe(report.fileHashAfter);
  });
});
