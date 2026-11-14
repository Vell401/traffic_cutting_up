/**
 * Development-only reference overlay: projected runtime road outlines on top of a
 * Yandex static satellite frame centred at the same coordinate. The frame is shown
 * by the browser only; it is never stored, bundled or used as a game texture.
 * Query: ?ll=lon,lat&z=18&ids=1&opacity=0.6
 */
import { createMoscowNetwork } from './moscow';
import { roadSampleDistances, sampleEdge } from './geometry';
import { MSD_PILOT_WAY_IDS } from './msdPilot';

const params = new URLSearchParams(location.search);
const [lon, lat] = (params.get('ll') ?? '37.6167,55.5882').split(',').map(Number);
const zoom = Number(params.get('z') ?? 18);
const opacity = Number(params.get('opacity') ?? .75);
const W = 650, H = 450;
document.querySelector<HTMLImageElement>('#sat')!.src
  = `https://static-maps.yandex.ru/1.x/?ll=${lon},${lat}&z=${zoom}&l=sat&size=${W},${H}`;
// Web-Mercator ground resolution at this latitude (Yandex uses an ellipsoidal
// variant; the local scale differs by <0.3%, the frame is centred on ll).
const metresPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
const radians = Math.PI / 180, radius = 6371008.8;
const centre = { x: radius * (lon - 37.616692) * radians * Math.cos(55.576894 * radians), z: -radius * (lat - 55.576894) * radians };
const px = (p: { x: number; z: number }) => [W / 2 + (p.x - centre.x) / metresPerPixel, H / 2 + (p.z - centre.z) / metresPerPixel];
const network = createMoscowNetwork();
const pilot = new Set<number>(MSD_PILOT_WAY_IDS);
const svg = document.querySelector('#roads')!;
const parts: string[] = [];
const reach = Math.hypot(W, H) * metresPerPixel;
for (const edge of network.edges) {
  const mid = sampleEdge(edge, edge.length / 2);
  if (Math.hypot(mid.x - centre.x, mid.z - centre.z) > reach + edge.length) continue;
  const ds = roadSampleDistances(edge, 2);
  const left = ds.map(s => px(sampleEdge(edge, s, -sampleEdge(edge, s).halfWidth)));
  const right = ds.map(s => px(sampleEdge(edge, s, sampleEdge(edge, s).halfWidth)));
  const axis = ds.map(s => px(sampleEdge(edge, s)));
  const way = Number(edge.id.split(':')[1]);
  const colour = pilot.has(way) ? '#ff3df5' : '#3dd8ff';
  const poly = [...left, ...right.reverse()].map(p => p.join(',')).join(' ');
  parts.push(`<polygon points="${poly}" fill="${colour}" fill-opacity=".12" stroke="${colour}" stroke-width="1" stroke-opacity="${opacity}"/>`);
  parts.push(`<polyline points="${axis.map(p => p.join(',')).join(' ')}" fill="none" stroke="#ffe23d" stroke-width=".8" stroke-dasharray="3 3" stroke-opacity="${opacity}"/>`);
  if (params.get('ids')) {
    const [x, y] = px(sampleEdge(edge, edge.length / 2));
    parts.push(`<text x="${x}" y="${y}" fill="#fff" font-size="9" stroke="#000" stroke-width=".3">${edge.id.replace('osm:', '')}</text>`);
  }
}
// 10 m scale bar.
parts.push(`<rect x="10" y="${H - 14}" width="${10 / metresPerPixel}" height="4" fill="#fff"/><text x="12" y="${H - 18}" fill="#fff" font-size="10">10 m</text>`);
svg.innerHTML = parts.join('');
document.querySelector('#info')!.textContent = `ll=${lon},${lat} z=${zoom} · ${metresPerPixel.toFixed(3)} m/px · magenta: pilot ways, cyan: other roads, yellow dashed: runtime axis`;
// Click to log world metres (x, z) of a point: used to trace unmapped features.
const clicks: string[] = [];
document.querySelector('#roads')!.addEventListener('click', event => {
  const svgElement = event.currentTarget as SVGSVGElement, rect = svgElement.getBoundingClientRect();
  const px = ((event as MouseEvent).clientX - rect.left) * W / rect.width, py = ((event as MouseEvent).clientY - rect.top) * H / rect.height;
  const x = centre.x + (px - W / 2) * metresPerPixel, z = centre.z + (py - H / 2) * metresPerPixel;
  clicks.push(`[${x.toFixed(1)}, ${z.toFixed(1)}]`);
  document.querySelector('#info')!.textContent = clicks.join(', ');
  (window as unknown as { traced: string[] }).traced = clicks;
});
