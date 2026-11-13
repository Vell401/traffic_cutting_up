/// <reference types="node" />
/** Matched-content, CPU-only scheduling benchmark. Not renderer timing or game FPS. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { mulberry32 } from '../src/core/rng';
import { getMap } from '../src/sim/maps';
import { CHUNK_LEN, Road, type RoadChunk } from '../src/sim/road';
import { RoadView } from '../src/render/roadView';
import { QUALITY } from '../src/settings';
import { renderDocument } from '../tests/renderCanvas';

type Chunk = { group: THREE.Group; x0: number; z0: number; build(c: RoadChunk, r: Road): void };
type Internals = { road: Road | null; live: Map<number,Chunk>; free: Chunk[]; mats: unknown; theme: string; disposed: boolean };

/** Frozen BASE1cc28b3 scheduling, run after identical real scene prebuild (constructor retained).
 * No content/builder/texture substitutes. The original function requires a nonempty road. */
export function referenceRoadUpdate(view: RoadView, road: Road, sMin: number, sMax: number, ox: number, oz: number): void {
  const s = view as unknown as Internals;
  if (s.disposed) return;
  const prototype = s.live.values().next().value ?? s.free[0];
  const ChunkView = prototype?.constructor as new (mats: unknown, theme: string) => Chunk;
  if (road !== s.road) {
    for (const v of s.live.values()) { view.group.remove(v.group); s.free.push(v); }
    s.live.clear(); s.road = road;
  }
  const iMin = Math.max(Math.floor(sMin / CHUNK_LEN), road.chunks[0].index);
  const iMax = Math.floor(sMax / CHUNK_LEN);
  for (const [idx,v] of s.live) if (idx < iMin || idx > iMax) {
    s.live.delete(idx); view.group.remove(v.group); s.free.push(v);
  }
  for (const c of road.chunks) {
    if (c.index < iMin || c.index > iMax) continue;
    let v = s.live.get(c.index);
    if (!v) {
      v = s.free.pop() ?? new ChunkView(s.mats,s.theme); v.build(c,road);
      s.live.set(c.index,v); view.group.add(v.group);
    }
    v.group.position.set(v.x0-ox,0,v.z0-oz);
  }
}

/** All allocated bytes, including unused tails, draw ranges and chunk transforms. */
export function roadOutput(view: RoadView): string {
  const hash = createHash('sha256');
  const s = view as unknown as Internals;
  for (const [index,c] of [...s.live].sort((a,b) => a[0]-b[0])) {
    hash.update(JSON.stringify([index,c.group.position.toArray()]));
    for (const child of c.group.children) {
      const mesh = child as THREE.Mesh; hash.update(JSON.stringify([mesh.visible,mesh.geometry.drawRange]));
      for (const a of [mesh.geometry.index!, ...Object.values(mesh.geometry.attributes)]) hash.update(Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength));
    }
  }
  return hash.digest('hex');
}

function benchmark() {
  Object.assign(globalThis,{ document: renderDocument });
  const trials = 9, warmups = 3;
  console.log(JSON.stringify({ trials,warmups,node:process.version,note:'CPU-only ms/update; alternating matched post-Task2 content, same prebuilt geometry/quality/capacities. No WebGL/FPS/hardware claim.' }));
  for (const theme of ['highway','miami'] as const) for (const [path,frames] of [['steady',20000],['origin',20000],['range',80],['version',20000],['identity',12]] as const) {
    const samples = { reference: [] as number[],current: [] as number[] };
    for (let trial = -warmups; trial < trials; trial++) {
      const roads = [0,1].map(() => { const r = new Road(mulberry32(7),getMap(theme).script); r.ensure(0,1900); return r; });
      const views = [0,1].map(() => { const v = new RoadView(QUALITY.medium,4,theme); v.update(roads[0],0,1699,0,0); return v; });
      if (roadOutput(views[0]) !== roadOutput(views[1])) throw new Error('prebuild mismatch');
      try {
        for (const reference of trial % 2 ? [false,true] : [true,false]) {
          const v = views[reference ? 0 : 1], update = reference ? referenceRoadUpdate : (v: RoadView,...args: Parameters<RoadView['update']>) => v.update(...args);
          const start = performance.now();
          for (let i=0;i<frames;i++) {
            const r = roads[path === 'identity' ? i%2 : 0];
            if (path === 'version') r.version++;
            const low = path === 'range' ? 300+(i%2)*100 : 0;
            update(v,r,low,path === 'range' ? low+1299 : 1699,path === 'origin' ? i%2*1000 : 0,path === 'origin' ? i%2*-2000 : 0);
          }
          const ms = (performance.now()-start)/frames;
          if (trial >= 0) samples[reference ? 'reference':'current'].push(ms);
        }
        if (roadOutput(views[0]) !== roadOutput(views[1])) throw new Error(`${theme}/${path}: output mismatch`);
      } finally { views.forEach(v => v.dispose()); }
    }
    const summarize = (values:number[]) => ({ median:[...values].sort((a,b)=>a-b)[4],trials:values });
    console.log(JSON.stringify({ theme,path,frames,reference:summarize(samples.reference),current:summarize(samples.current) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) benchmark();
