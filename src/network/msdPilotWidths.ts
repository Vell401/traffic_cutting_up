import type { NetworkEdge, RoadNetwork } from './geometry';

const WIDTH = 3 * 3.6 + .5;
const selected = (e: NetworkEdge): boolean => {
  const [, way, direction, part] = e.id.split(':');
  if (direction !== '1') return false;
  return way === '1207836340' && part === '2'
    || ['809185810', '809185809', '809185812', '809185807'].includes(way)
    || way === '809185806' && Number(part) <= 3
    || way === '809185811' && Number(part) <= 5;
};
const nominal = (e: NetworkEdge, end: boolean) => e.width
  ?? (end ? e.endLanes ?? e.lanes : e.lanes) * 3.6 + 3;
const smooth = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/** Section 01 engineering envelope, not surveyed shoulders. Three 3.6 m lanes
 * plus 0.25 m shoulders leave positive median clearance on this pilot. The
 * first merge's ~11.88 m spacing cannot also support the generic 0.8 m median
 * reserve: the tested minimum here is 0.5 m, without narrowing actual lanes.
 * Call after the
 * divided-envelope correction and before prepareRoadFrames. inferredEdgeIds
 * MUST be captured before that correction (edges with width === undefined),
 * so an explicit width is never mistaken for a corrected inference.
 *
 * Return hook runs immediately AFTER prepareRoadFrames, before publication or
 * sampling. It writes widths only, preserving the frame owner's normals. The
 * hook closes over this build's targets; no geometry/sample cache is created.
 */
export function applyMsdPilotWidths(network: RoadNetwork, inferredEdgeIds: ReadonlySet<string>): () => void {
  if (!network.id.startsWith('moscow-osm')) return () => {};
  const edges = network.edges.filter(e => selected(e) && inferredEdgeIds.has(e.id)
    && e.lanes === 3 && (e.endLanes ?? e.lanes) === 3);
  if (edges.some(e => e.surfaceFrames)) throw new Error('Apply MSD pilot widths before preparing road frames');
  const scope = new Set(edges);
  const handoffs = new Map<NetworkEdge, { before?: NetworkEdge; after?: NetworkEdge }>();
  for (const e of edges) {
    // Preserve the neighbour's existing cross-section at each scope handoff,
    // including 809185806:1:4. Never mutate the buffer or a ramp.
    const before = network.edges.filter(other => other.to === e.from && !scope.has(other));
    const after = network.edges.filter(other => other.from === e.to && !scope.has(other));
    const through = (other: NetworkEdge) => other.route === e.route && other.lanes === 3;
    handoffs.set(e, { before: before.find(through), after: after.find(through) });
  }
  for (const e of edges) e.width = WIDTH;
  return () => {
    if (edges.some(e => e.surfaceFrames?.length !== e.points.length)) {
      throw new Error('Prepare road frames before finalizing MSD pilot widths');
    }
    for (const e of edges) {
      const { before, after } = handoffs.get(e)!;
      // Ordinary seams may already have averaged cross-sections. Preserve the
      // outside frame's actual width, not its nominal edge width, and never
      // rewrite the outside frame. Unframed boundary roads retain legacy width.
      const target = {
        start: before ? (before.surfaceFrames?.at(-1)?.halfWidth ?? nominal(before, true) / 2) * 2 : WIDTH,
        end: after ? (after.surfaceFrames?.[0]?.halfWidth ?? nominal(after, false) / 2) * 2 : WIDTH,
      };
      const reach = Math.min(80, e.length / 2);
      let s = 0;
      for (let i = 0; i < e.points.length; i++) {
        if (i) s += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
        e.surfaceFrames![i].halfWidth = (WIDTH
          + (target.start - WIDTH) * smooth(1 - s / reach)
          + (target.end - WIDTH) * smooth(1 - (e.length - s) / reach)) / 2;
      }
      e.surfaceFrames![0].halfWidth = target.start / 2;
      e.surfaceFrames!.at(-1)!.halfWidth = target.end / 2;
    }
  };
}
