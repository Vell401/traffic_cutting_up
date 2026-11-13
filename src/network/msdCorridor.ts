import source from '../../data/moscow/network.json';
import route from '../../data/moscow/route.json';
import type { RoadNetwork } from './geometry';

const routeApproaches = new Set(route.sections.filter(s => s.leg === 0 && s.tags.name === 'Кантемировская улица').map(s => s.wayId));
const mainWays = new Set(source.ways.filter(w => {
  const name = (w.tags as Record<string, string>).name ?? '';
  return /(?:Юго-Восточная|Северо-Восточная) хорда|Московский скоростной диаметр/.test(name) || routeApproaches.has(w.id);
}).map(w => w.id));
const rampWays = new Set(source.ways.filter(w => (w.tags as Record<string, string>).highway?.endsWith('_link')
  && !/МКАД/.test((w.tags as Record<string, string>).name ?? '')).map(w => w.id));
const cache = new WeakMap<RoadNetwork, Set<string>>();
export const osmWayId = (edgeId: string): number => Number(edgeId.split(':')[1]);

/** Named MSD carriageways plus their connected link chains (bounded to 1200 m).
 * MKAD/local through roads remain the unpolished layout. No XY proximity joins.
 */
export function msdCorridor(network: RoadNetwork): Set<string> {
  const cached = cache.get(network);
  if (cached) return cached;
  const result = new Set<string>();
  if (!network.id.startsWith('moscow-osm')) return result;
  const adjacent = new Map<string, typeof network.edges>();
  for (const edge of network.edges) for (const node of [edge.from, edge.to]) {
    const list = adjacent.get(node) ?? []; list.push(edge); adjacent.set(node, list);
  }
  const distances = new Map<string, number>(), queue: Array<{ node: string; distance: number }> = [];
  for (const edge of network.edges) if (mainWays.has(osmWayId(edge.id))) {
    result.add(edge.id);
    for (const node of [edge.from, edge.to]) if (!distances.has(node)) {
      distances.set(node, 0); queue.push({ node, distance: 0 });
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const { node, distance } = queue[i];
    if (distance !== distances.get(node)) continue;
    for (const edge of adjacent.get(node) ?? []) {
      if (!rampWays.has(osmWayId(edge.id)) || distance + edge.length > 1200) continue;
      result.add(edge.id);
      const next = edge.from === node ? edge.to : edge.from, d = distance + edge.length;
      if (d < (distances.get(next) ?? Infinity)) { distances.set(next, d); queue.push({ node: next, distance: d }); }
    }
  }
  cache.set(network, result); return result;
}
