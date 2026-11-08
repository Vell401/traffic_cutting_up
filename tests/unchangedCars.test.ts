/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MercedesCar, mercedesTune } from '../src/sim/vehicleMercedes';
import { PorscheCar, porscheTune } from '../src/sim/vehiclePorsche';
import { CAMERA_RIGS } from '../src/render/car';

/** Regression snapshots for A45/Porsche assets, rendering and vehicle response. */
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const files: Record<string,string> = {
  'src/config.ts':'4e428b7fac93dc9d1d9395051af4dc0923569455c87fee1aa4462ee86f89c743',
  'src/sim/vehicleMercedes.ts':'3d584300c5ab160a71046d68135608a72f5c61aeba023f76bb6ce3e2ef674c94',
  'src/sim/vehiclePorsche.ts':'f3297996ad65685ba59e0c57213463f06f2a3888a60c9ebc84dc6c770acaad82',
  'src/render/car/porsche.ts':'d12ef1cd54555c64ca6847eb5bdae67e1c579b9eb57248462dffd2968d9527c6',
  'src/render/car/porscheCockpit.ts':'071803795bf178f32a97f7740281e2f12db986955d4c6acc251e5ce3510e010c',
  'public/models/mercedes-a45s.glb':'0f9f6d8bc2f9d67274bb0dbe21ec8d4ed6b8659be0b470e4ed5182269e7bccd4',
  'public/models/porsche-911-irl10.glb':'9ca92aa496626e11b8cf310d257644bd3f7f52f3613f815cff110f757f3373d4',
};
describe('A45 and Porsche remain exactly at the user-approved main version', () => {
  it('retains their camera positions and response',()=>{
    expect(CAMERA_RIGS[1]).toEqual({
      chase:{dist:6.6,height:2.2,lookAhead:6,lookHeight:.9,fovMin:58,fovMax:76,yawLag:7},
      far:{dist:2.6,height:.9,lookAhead:2,lookHeight:.3},hood:{f:.55,y:1.2,lookHeight:.95},
      bumper:{f:2.45,y:.55,lookHeight:.5},cockpit:{fov:64,fovFast:70,pitch:-.04},modes:['chase','far','cockpit','hood','bumper'],
    });
    expect(CAMERA_RIGS[3]).toEqual({
      chase:{dist:6.3,height:2.15,lookAhead:6,lookHeight:.88,fovMin:58,fovMax:76,yawLag:7},
      far:{dist:2.8,height:.95,lookAhead:2,lookHeight:.3},hood:{f:.65,y:1.12,lookHeight:.9},
      bumper:{f:2.3,y:.52,lookHeight:.45},cockpit:{fov:62,fovFast:69,pitch:-.06},modes:['chase','far','cockpit','hood','bumper'],
    });
  });
  it('retains assets, rendering builders and vehicle defaults byte-for-byte', () => {
    for (const [path, expected] of Object.entries(files)) {
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      expect(hash(path.endsWith('.ts') ? bytes.toString('utf8').replaceAll('\r\n','\n') : bytes), path).toBe(expected);
    }
    expect(hash(JSON.stringify(mercedesTune))).toBe('23e5395672613bf3ca3e21aa5edb5969f1125b1f0f5c8d2e273372df225a691c');
    expect(hash(JSON.stringify(porscheTune))).toBe('9bc11f9247d1ee4f00b4dddf1c99c8c63df68c557f4727ec3c33c8ea8f1528b6');
    const builders = readFileSync(new URL('../src/render/car/index.ts',import.meta.url),'utf8').replaceAll('\r\n','\n');
    for (const [start,end,expected] of [
      ['function buildMercedesParts(','function buildR34(','e380f6d44ae61061baf59ab0f178870a4616565a4e2dd79c18a66b24ac63cf6f'],
      ['class A45Cockpit','const TAIL_IDLE','a99cc882bf5ed2a28ba46c4c41d4fa4e7b19e478f25a61123fa5f107acb23c21'],
    ]) expect(hash(builders.slice(builders.indexOf(start),builders.indexOf(end,builders.indexOf(start)))),start).toBe(expected);
  });
  for (const [name, Type, expected] of [
    ['A45', MercedesCar, '62ea39a8aa447d67daaeae7e3eed35fce17b59816362321aeec3c03200b487f7'],
    ['Porsche', PorscheCar, '4c3dff3a71edf0afc1f183f1f9729ea38da43c1732eb570fbf37ddac644496d6'],
  ] as const) it(`retains the ${name} acceleration/steering/braking trajectory`, () => {
    const car = new Type(); car.reset(0,0,80/3.6);
    const samples: number[][] = [];
    for (let i=0;i<1200;i++) {
      const steer=i<240?0:i<360?.35:i<480?-.35:i<720?0:i<840?.5:i<960?-.5:0;
      car.step(1/120,{steer,throttle:i<960?.6:0,brake:i>=960?.6:0},0);
      if(Math.abs(car.d)>3)car.d=car.prevD=0;
      if(i%30===0){const state=new Float64Array(64);const n=car.saveState(state);samples.push([...state.slice(0,n)].map(x=>Math.round(x*1e6)/1e6));}
    }
    expect(hash(JSON.stringify(samples))).toBe(expected);
  });
});
