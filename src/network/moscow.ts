import data from '../../data/moscow/network.json';
import manualEdits from '../../data/moscow/manual-edits.json';
import { applyMoscowEdits, type MoscowSource } from './moscowEdits';
import type { NetworkEdge, RoadNetwork, Vec3 } from './geometry';
import { boundedGrade, verticalProfile } from './verticalProfile';
import { prepareRoadFrames } from './roadFrames';
import { msdCorridor } from './msdCorridor';
import { correctDividedCarriagewayEnvelopes } from './dividedCarriageways';
import { smoothRoadCenterlines } from './roadSmoothing';
import { applyMsdPilotVerticalAlignment } from './msdPilot';
import { applyMsdPilotWidths } from './msdPilotWidths';

/** Local tangent-plane projection in metres: east +X, north -Z. No map rescaling. */
export function projectMoscow(latitude: number, longitude: number): Vec3 {
  const radians = Math.PI / 180, radius = 6371008.8;
  return { x: radius * (longitude - 37.616692) * radians * Math.cos(55.576894 * radians),
    y: .2, z: -radius * (latitude - 55.576894) * radians };
}

type Tags = Record<string, string | undefined>;
const distance = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.z - a.z);
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => t === 0 ? { ...a } : t === 1 ? { ...b }
  : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };

/** Real directed OSM topology, including opposite carriageways and interchange arms.
 * Vertical profiles are inferred from relative OSM layers, not surveyed elevations.
 */
export function createMoscowNetwork(source?: MoscowSource, options: { smoothCenterlines?: boolean; pilotVerticalAlignment?: boolean; pilotWidths?: boolean } = {}): RoadNetwork {
  const correctInferredEnvelopes = source === undefined || source === data;
  source ??= applyMoscowEdits(data, manualEdits);
  const network: RoadNetwork = { id: 'moscow-osm-network', nodes: [], edges: [], parkings: [], openBoundaries: true };
  const positions = new Map(Object.entries(source.nodes).map(([id, p]) => [Number(id), { x: p[0], y: p[1], z: p[2] }]));
  const { ways } = source;
  const nodeIds = new Set<string>();
  const incident = new Map<number, number>();
  const neighbours = new Map<number, Set<number>>();
  for (const way of ways) for (const n of new Set(way.nodes)) incident.set(n, (incident.get(n) ?? 0) + 1);
  for (const way of ways) for (let i = 1; i < way.nodes.length; i++) {
    const a = way.nodes[i - 1], b = way.nodes[i];
    for (const [from, to] of [[a, b], [b, a]]) {
      const adjacent = neighbours.get(from) ?? new Set<number>(); adjacent.add(to); neighbours.set(from, adjacent);
    }
  }
  const addNode = (id: string, position: Vec3) => {
    if (!nodeIds.has(id)) { nodeIds.add(id); network.nodes.push({ id, position: { ...position } }); }
  };
  const directed = ways.flatMap(way => {
    const tags: Tags = way.tags;
    const oneway = tags.oneway ?? (tags.highway === 'motorway' || tags.junction === 'roundabout' ? 'yes' : 'no');
    const both = !['yes', '1', 'true', '-1'].includes(oneway);
    const directions = both ? [1, -1] : [oneway === '-1' ? -1 : 1];
    const count = Number.parseInt(tags.lanes ?? '', 10);
    return directions.map(direction => {
      const ids = direction === 1 ? [...way.nodes] : [...way.nodes].reverse();
      const explicit = Number.parseInt(tags[direction === 1 ? 'lanes:forward' : 'lanes:backward'] ?? '', 10);
      const lanes = Math.max(1, Number.isFinite(explicit) ? explicit : Number.isFinite(count) ? both ? Math.floor(count / 2) : count : 2);
      const kind = tags.bridge === 'yes' ? 'bridge' as const : tags.tunnel === 'yes' ? 'tunnel' as const : 'road' as const;
      return { way, tags, direction, ids, lanes, both, kind };
    });
  });
  type Directed = typeof directed[number];
  const starts = new Map<number, Directed[]>(), ends = new Map<number, Directed[]>();
  for (const road of directed) {
    const a = road.ids[0], b = road.ids[road.ids.length - 1];
    starts.set(a, [...(starts.get(a) ?? []), road]); ends.set(b, [...(ends.get(b) ?? []), road]);
  }
  // A shared OSM node is often only a tag boundary. Continue only through a
  // degree-two node with one compatible directed continuation (never a branch).
  const continuation = (road: Directed, forward: boolean, vertical = false): Directed | undefined => {
    const at = forward ? road.ids.length - 1 : 0, n = road.ids[at];
    if (neighbours.get(n)?.size !== 2) return;
    const behind = road.ids[forward ? at - 1 : 1];
    const candidates = (forward ? starts : ends).get(n)?.filter(other => other !== road
      && other.ids[forward ? 1 : other.ids.length - 2] !== behind);
    if (candidates?.length !== 1) return;
    const other = candidates[0];
    if (vertical || road.both === other.both && road.lanes === other.lanes && road.kind === other.kind
      && (road.tags.layer ?? '0') === (other.tags.layer ?? '0')) return other;
  };
  const links = new Map(directed.map(road => [road, { before: continuation(road, false), after: continuation(road, true) }]));
  const controls = new Map(directed.map(road => {
    const { before, after } = links.get(road)!;
    return [road, road.ids.map((n, i) => {
      const p = { ...positions.get(n)! };
      const previous = i ? road.ids[i - 1] : before?.ids[before.ids.length - 2];
      const next = i < road.ids.length - 1 ? road.ids[i + 1] : after?.ids[1];
      const ordinary = neighbours.get(n)?.size === 2 && ((incident.get(n) ?? 0) === 1
        || (i === 0 ? !!before : i === road.ids.length - 1 ? !!after : false));
      if (road.both && ordinary && previous !== undefined && next !== undefined) {
        const a = positions.get(previous)!, b = positions.get(next)!;
        const heading = Math.atan2(b.x - a.x, a.z - b.z), offset = road.lanes * 1.8 + .25;
        p.x += Math.cos(heading) * offset; p.z += Math.sin(heading) * offset;
      }
      return p;
    })];
  }));
  // Vertical continuity crosses ordinary tag/lane/bridge boundaries too. At a
  // genuine branch use zero grade: all incident roads retain the exact shared
  // source height without choosing an arbitrary through movement.
  const grades = new Map(directed.map(road => [road, road.ids.map((n, i) => {
    const before = continuation(road, false, true), after = continuation(road, true, true);
    const p = controls.get(road)![i];
    const a = i ? controls.get(road)![i - 1] : before ? controls.get(before)!.at(-2) : undefined;
    const b = i < road.ids.length - 1 ? controls.get(road)![i + 1] : after ? controls.get(after)![1] : undefined;
    // A shared node may be interior to another way, so endpoint continuation
    // lookup alone is insufficient. Flatten every incident representation,
    // including duplicate ways and degree-two shared interior nodes.
    if ((neighbours.get(n)?.size ?? 0) > 2 || (incident.get(n) ?? 0) > 1) return 0;
    const left = a && distance(a, p) > 1e-9 ? (p.y - a.y) / distance(a, p) : undefined;
    const right = b && distance(p, b) > 1e-9 ? (b.y - p.y) / distance(p, b) : undefined;
    return left === undefined ? right ?? 0 : right === undefined ? left : boundedGrade(left, right);
  })]));
  // Do not round near another centreline, including a stacked crossing. Its
  // audited height was computed on the original XY geometry, not on a spline.
  const cells = new Map<string, Array<{ a: Vec3; b: Vec3; from: number; to: number }>>();
  for (const way of ways) for (let i = 1; i < way.nodes.length; i++) {
    const from = way.nodes[i - 1], to = way.nodes[i], a = positions.get(from)!, b = positions.get(to)!;
    const segment = { a, b, from, to };
    for (let x = Math.floor(Math.min(a.x, b.x) / 32); x <= Math.floor(Math.max(a.x, b.x) / 32); x++)
      for (let z = Math.floor(Math.min(a.z, b.z) / 32); z <= Math.floor(Math.max(a.z, b.z) / 32); z++) {
        const key = `${x}:${z}`, list = cells.get(key) ?? []; list.push(segment); cells.set(key, list);
      }
  }
  const isolated = (n: number, p: Vec3, radius: number): boolean => {
    for (let x = Math.floor((p.x - radius) / 32); x <= Math.floor((p.x + radius) / 32); x++)
      for (let z = Math.floor((p.z - radius) / 32); z <= Math.floor((p.z + radius) / 32); z++)
        for (const { a, b, from, to } of cells.get(`${x}:${z}`) ?? []) {
          if (from === n || to === n) continue;
          const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
          const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0;
          if (distance(p, mix(a, b, t)) < radius) return false;
        }
    return true;
  };
  for (const road of directed) {
      const { way, tags, direction, ids, lanes, both, kind } = road;
      const { before, after } = links.get(road)!, points = controls.get(road)!;
      let part: Vec3[] = [], startId = '', partNumber = 0;
      const publish = (endId: string) => {
        if (part.length < 2) return;
        const length = part.slice(1).reduce((sum, p, i) => sum + distance(part[i], p), 0);
        if (length < .01) { part = [part[part.length - 1]]; startId = endId; return; }
        const edge: NetworkEdge = { id: `osm:${way.id}:${direction}:${partNumber++}`, from: startId, to: endId,
          points: part, length, lanes, kind, route: tags.name ?? tags.ref ?? tags.highway ?? 'Дорога' };
        addNode(startId, part[0]); addNode(endId, part[part.length - 1]);
        network.edges.push(edge); startId = endId; part = [{ ...part[part.length - 1] }];
      };
      const corners = points.map((p, i) => {
        const a = i ? points[i - 1] : before ? controls.get(before)!.at(-2) : undefined;
        const b = i < points.length - 1 ? points[i + 1] : after ? controls.get(after)![1] : undefined;
        if (!a || !b || neighbours.get(ids[i])?.size !== 2
          || ((incident.get(ids[i]) ?? 0) > 1 && !(i === 0 ? before : i === ids.length - 1 ? after : false))
          || Math.abs(a.y - p.y) > 1e-6 || Math.abs(b.y - p.y) > 1e-6) return [p];
        const left = distance(a, p), right = distance(p, b);
        if (left < .01 || right < .01) return [p];
        const cosine = ((p.x - a.x) * (b.x - p.x) + (p.z - a.z) * (b.z - p.z)) / left / right;
        // Local quadratic fillets only: no overshoot, no hairpin shortcuts,
        // <=25 cm corner displacement, <=20% of either adjacent chord.
        if (cosine < Math.SQRT1_2 || cosine > .999999) return [p];
        const trim = Math.min(8, left * .2, right * .2, .5 / Math.sqrt((1 - cosine) / 2));
        if (!isolated(ids[i], p, trim + 12)) return [p];
        const entry = mix(p, a, trim / left), exit = mix(p, b, trim / right);
        const steps = Math.max(8, Math.ceil(trim * 4 / .5) * 2);
        return Array.from({ length: steps + 1 }, (_, j) => {
          const t = j / steps; return mix(mix(entry, p, t), mix(p, exit, t), t);
        });
      });
      const append = (point: Vec3, startGrade = 0, endGrade = 0) => {
        if (!part.length) { part = [{ ...point }]; return; }
        const a = part[part.length - 1], ds = distance(a, point);
        if (ds > 1e-9) {
          if (a.y === point.y) {
            const steps = Math.max(1, Math.ceil(ds / 5));
            for (let j = 1; j <= steps; j++) part.push(mix(a, point, j / steps));
          } else {
            const profile = verticalProfile(a.y, point.y, ds, startGrade, endGrade);
            for (const t of profile.fractions) part.push({ ...mix(a, point, t), y: profile.height(t) });
          }
        }
      };
      const endpoint = (i: number) => {
        const n = ids[i], ordinary = neighbours.get(n)?.size === 2
          && (i === 0 ? before : i === ids.length - 1 ? after : (incident.get(n) ?? 0) === 1);
        if (both && neighbours.get(n)?.size === 1) return `osm-node:${n}:boundary:${way.id}:${direction}`;
        // Use physical travel direction, not the way's arbitrary OSM ordering.
        const next = ids[i + 1] ?? after?.ids[1];
        return both && ordinary ? `osm-node:${n}:toward:${next}` : `osm-node:${n}`;
      };
      startId = endpoint(0);
      for (let i = 0; i < ids.length; i++) {
        const n = ids[i], corner = corners[i], middle = Math.floor(corner.length / 2);
        for (let j = i === 0 ? middle : 0; j <= (i === ids.length - 1 ? middle : corner.length - 1); j++) {
          append(corner[j], j === 0 && i > 0 ? grades.get(road)![i - 1] : 0,
            j === 0 ? grades.get(road)![i] : 0);
        // Split at every actual shared OSM node, never at an XY crossing.
          if (j === middle && ((incident.get(n) ?? 0) > 1 || i === ids.length - 1 || part.length >= 51)) publish(endpoint(i));
        }
      }
  }
  const corridor = msdCorridor(network);
  if (options.smoothCenterlines !== false) smoothRoadCenterlines(network, corridor);
  const inferredEdgeIds = new Set(network.edges.filter(e => e.width === undefined).map(e => e.id));
  if (correctInferredEnvelopes) {
    // Width inference must not expand the vertical pilot's scope. Evaluate on
    // pre-pilot XY/heights using temporary edge identities: sampleEdge's caches
    // must never observe the construction-time resampling below.
    const inference = { ...network, edges: network.edges.map(e => ({ ...e })) };
    correctDividedCarriagewayEnvelopes(inference);
    for (let i = 0; i < network.edges.length; i++) if (inference.edges[i].width !== undefined) network.edges[i].width = inference.edges[i].width;
  }
  if (correctInferredEnvelopes && options.pilotVerticalAlignment !== false) applyMsdPilotVerticalAlignment(network);
  const finishPilotWidths = correctInferredEnvelopes && options.pilotWidths !== false
    ? applyMsdPilotWidths(network, inferredEdgeIds) : () => {};
  prepareRoadFrames(network, corridor);
  finishPilotWidths();
  const start = network.edges.find(e => e.id.startsWith(`osm:${source.startWayId}:1:`)) ?? network.edges[0];
  network.parkings.push({ id: 'moscow-start', name: 'Бирюлёво · технический старт', edgeId: start.id, s: Math.min(20, start.length / 2) });
  return network;
}

export const moscowRouteSource = data.source;
