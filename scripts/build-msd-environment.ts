/**
 * Offline: compact the cached OSM context extract (scripts/import-msd-pilot-environment.py)
 * into projected game metres for the section-01 pilot. Data (c) OpenStreetMap
 * contributors, ODbL. Heights come from OSM tags where present; otherwise from an
 * explicit per-kind default that is recorded as `estimated: true`, never as fact.
 *
 *   npx tsx scripts/build-msd-environment.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { projectMoscow } from '../src/network/moscow';

type Point = { lat: number; lon: number };
type Element = { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; tags?: Record<string, string>;
  geometry?: Array<Point | null>; members?: Array<{ role: string; geometry?: Point[] }> };
// Cached OSM extracts per section (scripts/import-msd-environment.py --section NN).
const extracts = ['msd-pilot-environment.osm.json', 'msd-section-02-environment.osm.json']
  .map(name => JSON.parse(readFileSync(`data/moscow/${name}`, 'utf8')) as { osm3s: { timestamp_osm_base: string }; elements: Element[] });
const unique = new Map<string, Element>();
for (const extract of extracts) for (const e of extract.elements) unique.set(`${e.type}/${e.id}`, e);
const raw = { osm3s: extracts[0].osm3s, elements: [...unique.values()] };

// Sections 01+02 source route (route.json sections up to way 1194203196, ≈0–5850 m): distance filtering only.
const route = JSON.parse(readFileSync('data/moscow/route.json', 'utf8')) as { sections: Array<{ wayId: number; coordinates: number[][] }> };
const lastWay = route.sections.findIndex(s => s.wayId === 1194203196);
const ROUTE = route.sections.slice(0, lastWay + 1).flatMap(s => s.coordinates).map(([a, b]) => projectMoscow(a, b));
const xz = (p: Point): [number, number] => { const q = projectMoscow(p.lat, p.lon); return [Math.round(q.x * 100) / 100, Math.round(q.z * 100) / 100]; };
const distance = ([x, z]: [number, number]) => {
  let best = Infinity;
  for (let i = 1; i < ROUTE.length; i++) {
    const a = ROUTE[i - 1], b = ROUTE[i], dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz < 1e-9) continue; // shared section boundary node
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
  }
  return best;
};
const near = (points: Array<[number, number]>, limit: number) => points.some(p => distance(p) <= limit);
const line = (e: Element) => (e.geometry ?? []).filter((p): p is Point => !!p).map(xz);
const rings = (e: Element): Array<Array<[number, number]>> => e.type === 'way' ? [line(e)]
  : (e.members ?? []).filter(m => m.role === 'outer' && m.geometry?.length).map(m => m.geometry!.map(xz));
const closed = (r: Array<[number, number]>) => r.length >= 4 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1] ? r.slice(0, -1) : r;

// Per-kind defaults are explicit estimates for untagged footprints (metres).
const DEFAULT_HEIGHT: Record<string, number> = { garages: 3, garage: 3, kiosk: 3, service: 4, guardhouse: 3, roof: 4,
  industrial: 9, warehouse: 10, commercial: 8, retail: 7, office: 12, yes: 6, house: 7, construction: 6 };
const LEVEL = 3.2;
const buildings: Array<{ id: string; kind: string; height: number; estimated: boolean; colour?: string; ring: Array<[number, number]> }> = [];
const railways: Array<{ id: number; electrified: boolean; main: boolean; line: Array<[number, number]> }> = [];
const pipelines: Array<{ id: number; overhead: boolean; line: Array<[number, number]> }> = [];
const barriers: Array<{ id: number; kind: 'fence' | 'wall' | 'noise' | 'guard'; height: number; line: Array<[number, number]> }> = [];
const woods: Array<{ id: string; ring: Array<[number, number]> }> = [];
const paved: Array<{ id: string; kind: string; ring: Array<[number, number]> }> = [];
const trees: Array<[number, number]> = [];
const tanks: Array<{ id: number; height: number; ring: Array<[number, number]> }> = [];
const masts: Array<{ id: number; kind: string; position: [number, number]; height: number }> = [];
const waterways: Array<{ id: number; width: number; line: Array<[number, number]> }> = [];
const water: Array<{ id: string; ring: Array<[number, number]> }> = [];
const powerLines: Array<{ id: number; voltage: number; line: Array<[number, number]> }> = [];
const towers: Array<[number, number]> = [];

for (const e of raw.elements) {
  const t = e.tags ?? {};
  if (t.building && e.type !== 'node') {
    for (const [i, ring] of rings(e).entries()) {
      const r = closed(ring); if (r.length < 3 || !near(r, 650)) continue;
      const levels = Number.parseFloat(t['building:levels'] ?? ''), height = Number.parseFloat(t.height ?? '');
      const value = Number.isFinite(height) ? height : Number.isFinite(levels) ? levels * LEVEL + 1 : DEFAULT_HEIGHT[t.building] ?? (t.building === 'apartments' ? 50 : 6);
      buildings.push({ id: `${e.type}/${e.id}${i ? `#${i}` : ''}`, kind: t.building, height: Math.round(value * 10) / 10,
        estimated: !Number.isFinite(height) && !Number.isFinite(levels), ...(t['building:colour'] ? { colour: t['building:colour'] } : {}), ring: r });
    }
  } else if (t.man_made === 'storage_tank' && e.type === 'way') {
    const r = closed(line(e)); if (r.length >= 3 && near(r, 650)) tanks.push({ id: e.id, height: Number.parseFloat(t.height ?? '') || 12, ring: r });
  } else if (t.railway === 'rail' && e.type === 'way') {
    const l = line(e); if (near(l, 320)) railways.push({ id: e.id, electrified: t.electrified === 'contact_line', main: t.usage === 'main', line: l });
  } else if (t.man_made === 'pipeline' && e.type === 'way' && /^(overground|overhead)$/.test(t.location ?? '')) {
    const l = line(e); if (near(l, 300)) pipelines.push({ id: e.id, overhead: t.location === 'overhead', line: l });
  } else if (e.type === 'way' && (t.barrier === 'fence' || t.barrier === 'wall' || t.barrier === 'guard_rail')) {
    const l = line(e); if (!near(l, 260)) continue;
    const kind = t.barrier === 'guard_rail' ? 'guard' : t.wall === 'noise_barrier' ? 'noise' : t.barrier === 'wall' ? 'wall' : 'fence';
    const tagged = Number.parseFloat(t.height ?? '');
    barriers.push({ id: e.id, kind, height: Number.isFinite(tagged) ? tagged : { fence: 2, wall: 2.5, noise: 4, guard: .9 }[kind], line: l });
  } else if (t.natural === 'wood' || t.landuse === 'forest') {
    for (const [i, ring] of rings(e).entries()) { const r = closed(ring); if (r.length >= 3 && near(r, 320)) woods.push({ id: `${e.type}/${e.id}${i ? `#${i}` : ''}`, ring: r }); }
  } else if ((t.amenity === 'parking' || t.landuse === 'industrial') && e.type !== 'node') {
    for (const [i, ring] of rings(e).entries()) { const r = closed(ring); if (r.length >= 3 && near(r, 450)) paved.push({ id: `${e.type}/${e.id}${i ? `#${i}` : ''}`, kind: t.amenity === 'parking' ? 'parking' : 'industrial', ring: r }); }
  } else if (e.type === 'way' && (t.waterway === 'river' || t.waterway === 'stream' || t.waterway === 'canal')) {
    const l = line(e); if (near(l, 420)) waterways.push({ id: e.id, width: Number.parseFloat(t.width ?? '') || (t.waterway === 'stream' ? 3 : 8), line: l });
  } else if (t.natural === 'water' && e.type !== 'node') {
    for (const [i, ring] of rings(e).entries()) { const r = closed(ring); if (r.length >= 3 && near(r, 420)) water.push({ id: `${e.type}/${e.id}${i ? `#${i}` : ''}`, ring: r }); }
  } else if (t.power === 'line' && e.type === 'way') {
    const l = line(e); if (near(l, 450)) powerLines.push({ id: e.id, voltage: Number.parseInt(t.voltage ?? '', 10) || 110000, line: l });
  } else if (t.power === 'tower' && e.type === 'node') {
    const p = xz(e as Point); if (distance(p) <= 450) towers.push(p);
  } else if (t.natural === 'tree' && e.type === 'node') {
    const p = xz(e as Point); if (distance(p) <= 320) trees.push(p);
  } else if (e.type === 'node' && (t.man_made === 'mast' || t.man_made === 'chimney')) {
    const p = xz(e as Point); if (distance(p) <= 320) masts.push({ id: e.id, kind: t.man_made, position: p, height: Number.parseFloat(t.height ?? '') || (t.man_made === 'chimney' ? 25 : 30) });
  }
}
const output = { source: 'OpenStreetMap contributors, ODbL', osmBase: raw.osm3s.timestamp_osm_base,
  note: 'MSD sections 01-02 context only. estimated:true heights are per-kind defaults, not observations.',
  buildings, tanks, railways, pipelines, barriers, woods, paved, trees, masts, waterways, water, powerLines, towers };
writeFileSync('data/moscow/msd-environment.json', JSON.stringify(output));
console.log(Object.fromEntries(Object.entries(output).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])));
