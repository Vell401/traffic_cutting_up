import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';

export const BRIDGE_DECK_THICKNESS = .4;
export const BRIDGE_PIER_BASE = -8;
export const BRIDGE_PIER_WIDTH = 2.8;
export const BRIDGE_PIER_LENGTH = 3.5;

/** The flat concrete cap fits below even the lowest part of a graded deck.
 * Sampling the footprint's bounding circle also covers turns and profile knots. */
export function bridgePierGeometry(edge: NetworkEdge, s: number) {
  const radius = Math.hypot(BRIDGE_PIER_WIDTH, BRIDGE_PIER_LENGTH) / 2;
  let top = Infinity;
  const start = Math.max(0, s - radius), end = Math.min(edge.length, s + radius);
  const local = Array.from({ length: Math.ceil((end - start) / .5) + 1 }, (_, i) => Math.min(end, start + i * .5));
  for (const at of [...local, end, ...roadSampleDistances(edge).filter(at => at > start && at < end)]) {
    top = Math.min(top, sampleEdge(edge, at).y - BRIDGE_DECK_THICKNESS);
  }
  const point = sampleEdge(edge, s);
  return { center: { x: point.x, y: (top + BRIDGE_PIER_BASE) / 2, z: point.z },
    top, height: top - BRIDGE_PIER_BASE, width: BRIDGE_PIER_WIDTH, length: BRIDGE_PIER_LENGTH, heading: point.heading };
}

/** Conservative footprint index: a speculative bridge pier must not occupy another
 * road's driving envelope. Includes tunnel roofs and decks below the bridge.
 */
export function bridgePierClearance(network: RoadNetwork): (edgeId: string, point: Vec3) => boolean {
  const cell = 32;
  const bins = new Map<string, Array<Vec3 & { edgeId: string; radius: number; roof: number }>>();
  for (const edge of network.edges) {
    for (const s of roadSampleDistances(edge, 2)) {
      const p = sampleEdge(edge, s);
      const radius = p.halfWidth + 5; // pier diagonal, sample spacing and safety margin
      const item = { ...p, edgeId: edge.id, radius, roof: edge.kind === 'tunnel' ? 7 : 5 };
      for (let x = Math.floor((p.x - radius) / cell); x <= Math.floor((p.x + radius) / cell); x++) {
        for (let z = Math.floor((p.z - radius) / cell); z <= Math.floor((p.z + radius) / cell); z++) {
          const key = `${x}:${z}`, list = bins.get(key) ?? [];
          list.push(item); bins.set(key, list);
        }
      }
    }
  }
  return (edgeId, point) => !(bins.get(`${Math.floor(point.x / cell)}:${Math.floor(point.z / cell)}`) ?? []).some(other =>
    other.edgeId !== edgeId && other.y - BRIDGE_DECK_THICKNESS <= point.y && other.y + other.roof >= BRIDGE_PIER_BASE
    && Math.hypot(other.x - point.x, other.z - point.z) < other.radius);
}
