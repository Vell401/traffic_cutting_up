import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import route from '../data/moscow/route.json';
import source from '../data/moscow/network.json';
import { createMoscowNetwork, projectMoscow } from '../src/network/moscow';
import { sampleEdge, type NetworkEdge, type Vec3 } from '../src/network/geometry';

// Run from any directory: npx tsx scripts/render-moscow-section.ts
// No plotting dependencies, imagery, traced coordinates, or generated timestamps.
const sections = route.sections.slice(0, 4);
const expected = [1207836341, 809185810, 809185809, 809185806];
if (sections.some((section, i) => section.wayId !== expected[i])) throw new Error('Section-01 route IDs changed');
const network = createMoscowNetwork();
const wayId = (edge: NetworkEdge) => Number(edge.id.split(':')[1]);
const selected = network.edges.filter(edge => expected.includes(wayId(edge)) && edge.id.split(':')[2] === '1');
for (const id of expected) if (!selected.some(edge => wayId(edge) === id)) throw new Error(`Missing runtime way ${id}`);
const reference = sections.flatMap(section => section.coordinates.map(([lat, lon]) => projectMoscow(lat, lon)));
const bounds = {
  minX: Math.min(...reference.map(p => p.x)) - 230, maxX: Math.max(...reference.map(p => p.x)) + 230,
  minZ: Math.min(...reference.map(p => p.z)) - 100, maxZ: Math.max(...reference.map(p => p.z)) + 100,
};
const frame = { x: 32, y: 126, width: 610, height: 1000 };
const scale = Math.min(frame.width / (bounds.maxX - bounds.minX), frame.height / (bounds.maxZ - bounds.minZ));
const ox = frame.x + (frame.width - (bounds.maxX - bounds.minX) * scale) / 2;
const oz = frame.y + (frame.height - (bounds.maxZ - bounds.minZ) * scale) / 2;
const xy = (p: Pick<Vec3, 'x' | 'z'>) => [ox + (p.x - bounds.minX) * scale, oz + (p.z - bounds.minZ) * scale];
const n = (v: number) => v.toFixed(2);
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const path = (points: Pick<Vec3, 'x' | 'z'>[]) => points.map((p, i) => `${i ? 'L' : 'M'}${xy(p).map(n).join(',')}`).join(' ');
const inside = (edge: NetworkEdge) => {
  // Segment bounding boxes, rather than only vertices, retain roads crossing the crop.
  const margin = Math.max(sampleEdge(edge, 0).halfWidth, sampleEdge(edge, edge.length).halfWidth);
  return edge.points.slice(1).some((b, i) => {
    const a = edge.points[i];
    return Math.max(a.x, b.x) + margin >= bounds.minX && Math.min(a.x, b.x) - margin <= bounds.maxX
      && Math.max(a.z, b.z) + margin >= bounds.minZ && Math.min(a.z, b.z) - margin <= bounds.maxZ;
  });
};
const visible = network.edges.filter(inside).sort((a, b) =>
  Math.max(...a.points.map(p => p.y)) - Math.max(...b.points.map(p => p.y)) || a.id.localeCompare(b.id));
function ribbon(edge: NetworkEdge, fill: string) {
  const count = Math.ceil(edge.length / 5);
  const stations = Array.from({ length: count + 1 }, (_, i) => edge.length * i / count);
  const side = (sign: number) => stations.map(s => sampleEdge(edge, s, sampleEdge(edge, s).halfWidth * sign));
  return `<path data-edge="${escape(edge.id)}" d="${path([...side(-1), ...side(1).reverse()])} Z" fill="${fill}"/>`;
}
const parts = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1210" viewBox="0 0 1000 1210" role="img" aria-labelledby="title desc">`,
  `<title id="title">Moscow section 01 — first four route ways, approximately 2,061 m</title>`,
  `<desc id="desc">North-up schematic from createMoscowNetwork runtime road surfaces. Grey full carriageways, orange selected route. OSM layout / reference review, not surveyed. No satellite tracing. Road widths use runtime lane and shoulder assumptions; heights are not depicted.</desc>`,
  `<style>text{font-family:system-ui,sans-serif;fill:#243446;font-size:14px}.title{font-size:25px;font-weight:700}.heading{font-size:16px;font-weight:700}.small{font-size:12px}.muted{fill:#536473}.label{paint-order:stroke;stroke:#f6f8fa;stroke-width:5px;stroke-linejoin:round}.id{font-family:monospace;font-size:12px}</style>`,
  `<rect width="1000" height="1210" fill="#fff"/>`,
  `<text x="32" y="42" class="title">Moscow · section 01</text>`,
  `<text x="32" y="70">First four directed route ways · 0–2,061 m (source chainage, rounded)</text>`,
  `<text x="32" y="97" class="heading">OSM layout / reference review, not surveyed</text>`,
  `<defs><clipPath id="crop"><rect x="${ox}" y="${oz}" width="${(bounds.maxX - bounds.minX) * scale}" height="${(bounds.maxZ - bounds.minZ) * scale}"/></clipPath></defs>`,
  `<rect x="32" y="126" width="610" height="1000" rx="8" fill="#f6f8fa" stroke="#dce2e7"/>`,
  `<g clip-path="url(#crop)">`,
  ...visible.map(edge => ribbon(edge, '#9ca7b1')),
  ...selected.map(edge => ribbon(edge, '#e87924')),
  // Centreline overlay is a visibility aid, not another carriageway-width estimate.
  ...selected.map(edge => `<path d="${path(edge.points)}" fill="none" stroke="#b64c0b" stroke-width="1"/>`),
  `</g>`,
];
function landmark(nodeId: number, heading: string, detail: string, offset = 0) {
  const node = network.nodes.find(node => node.id === `osm-node:${nodeId}`);
  if (!node) throw new Error(`Missing landmark OSM node ${nodeId}`);
  const [x, y] = xy(node.position), labelY = y + offset;
  parts.push(`<path d="M${n(x)},${n(y)} L245,${n(labelY)} H52" fill="none" stroke="#536473" stroke-width="1"/>`,
    `<circle cx="${n(x)}" cy="${n(y)}" r="4" fill="#fff" stroke="#b64c0b" stroke-width="2"/>`,
    `<text x="52" y="${n(labelY - 23)}" class="heading label">${escape(heading)}</text>`,
    `<text x="52" y="${n(labelY - 6)}" class="small label">${escape(detail)}</text>`,
    `<text x="52" y="${n(labelY + 16)}" class="id label">node ${nodeId}</text>`);
}
landmark(11191288649, 'Entry · 0 m', 'Way 1207836341 · ramp');
landmark(7566321603, 'Mainline merge · 287 m', 'Way 809185810 · 3 lanes', -12);
landmark(7566321596, 'First bridge · 1,334 m', 'Way 809185809 · bridge-tag start', 22);
landmark(7566321442, 'Section end · 2,061 m', 'Way 809185806 · next merge', 12);
const ramp = selected.find(edge => wayId(edge) === 1207836341)!;
const rawRamp = createMoscowNetwork(source).edges.find(edge => edge.id === ramp.id)!;
const before = sampleEdge(rawRamp, 0), after = sampleEdge(ramp, 0);
parts.push(
  `<path d="M600,211 V161 M593,174 L600,161 L607,174" stroke="#243446" stroke-width="2" fill="none"/><text x="594" y="151" class="heading">N</text>`,
  `<path d="M${n(ox + 20)},1090 h${n(200 * scale)} m${n(-200 * scale)},-5 v10 m${n(200 * scale)},-10 v10" fill="none" stroke="#243446" stroke-width="2"/>`,
  `<text x="${n(ox + 20)}" y="1075" class="small">0</text><text x="${n(ox + 20 + 200 * scale)}" y="1075" text-anchor="end" class="small">200 m</text>`,
  `<text x="674" y="152" class="heading">Reading the schematic</text>`,
  `<path d="M676,183 h30" stroke="#9ca7b1" stroke-width="9"/><text x="718" y="188">All runtime carriageways</text>`,
  `<path d="M676,215 h30" stroke="#e87924" stroke-width="9"/><text x="718" y="220">Selected route · direction 1</text>`,
  `<text x="674" y="260">North up · east right</text>`,
  `<text x="674" y="284">Same metre scale on both axes.</text>`,
  `<text x="674" y="308">Grey context is clipped to the crop;</text>`,
  `<text x="674" y="330">connections continue beyond it.</text>`,
  `<text x="674" y="370" class="heading">Stable OSM way IDs</text>`,
  ...expected.map((id, i) => `<text x="674" y="${400 + i * 25}" class="id">${i + 1}. ${id}${i === 0 ? ' · ramp' : i === 2 ? ' · bridge' : ' · 3 lanes'}</text>`),
  `<text x="674" y="532" class="heading">Ramp width · before / current</text>`,
  `<text x="674" y="556" class="id">way 1207836341 · direction 1</text>`,
  `<rect x="674" y="579" width="${n(before.halfWidth * 2 * 16)}" height="24" fill="#9ca7b1"/>`,
  `<text x="674" y="624">Raw fallback: ${before.lanes} lanes / ${n(before.halfWidth * 2)} m</text>`,
  `<rect x="674" y="643" width="${n(after.halfWidth * 2 * 16)}" height="24" fill="#e87924"/>`,
  `<text x="674" y="689">Current: ${after.lanes} lane${after.lanes === 1 ? '' : 's'} / ${n(after.halfWidth * 2)} m</text>`,
  `<text x="674" y="717" class="small">Inset only: 16 px/m, not the map scale.</text>`,
  `<text x="674" y="744" class="small">Widths include generic runtime shoulders.</text>`,
  `<text x="674" y="765" class="small">Lane evidence does not measure width.</text>`,
  `<text x="674" y="813" class="heading">Limits</text>`,
  `<text x="674" y="841">Not satellite traced or a map editor.</text>`,
  `<text x="674" y="866">No surveyed widths or elevations.</text>`,
  `<text x="674" y="891">Orange overlay shows itinerary;</text>`,
  `<text x="674" y="914">crossings do not imply junctions.</text>`,
  `<text x="674" y="954" class="small">Runtime: createMoscowNetwork()</text>`,
  `<text x="674" y="978" class="small">Route: route.json · sections 0–3</text>`,
  `<text x="32" y="1160" class="small">© OpenStreetMap contributors · ODbL-1.0 · openstreetmap.org/copyright</text>`,
  `<text x="32" y="1182" class="small muted">Reproduce: npx tsx scripts/render-moscow-section.ts · geometry and current manual edits are read, never modified.</text>`,
  `</svg>`,
);
const output = fileURLToPath(new URL('../docs/moscow-section-01.svg', import.meta.url));
mkdirSync(fileURLToPath(new URL('../docs/', import.meta.url)), { recursive: true });
writeFileSync(output, parts.join('\n') + '\n');
console.log(`Wrote ${output}: ${visible.length} context edges, ${selected.length} highlighted edges; ramp ${before.lanes} → ${after.lanes} lanes`);
