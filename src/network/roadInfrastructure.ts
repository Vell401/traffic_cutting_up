import source from '../../data/moscow/network.json';
import { roadSampleDistances, sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from './geometry';
import { msdRampCurbRange } from './msdPilot';

export type InfrastructureMaterial = 'infrastructureMetal' | 'infrastructureConcrete' | 'infrastructureWhite'
  | 'infrastructureRed' | 'infrastructureBlue' | 'infrastructureDark';
export type InfrastructureQuadEmitter = (material: InfrastructureMaterial, a: Vec3, b: Vec3, c: Vec3, d: Vec3) => void;
/** Centered box: width along driver's right, length along the road; same convention as NetworkRenderer.box. */
export type InfrastructureBoxEmitter = (material: InfrastructureMaterial, center: Vec3, width: number, height: number, length: number, heading: number) => void;
export interface InfrastructureRun { edgeId: string; start: number; end: number; side: -1 | 1; kind: 'rail' | 'median';
  /** Signed metre offsets from the framed centerline; linearly interpolated by the emitter. */
  lateralStart?: number; lateralEnd?: number; pairedEdgeId?: string }
export interface InfrastructureSign { edgeId: string; s: number; kind: 'speed90' | 'direction' }
export interface RoadInfrastructurePlan { runs: InfrastructureRun[]; signs: InfrastructureSign[];
  coverage: { requestedRoadsideMeters: number; emittedRoadsideMeters: number; clearanceSkippedMeters: number;
    budgetSkippedMeters: number; duplicateSuppressedMeters: number; curbReplacedMeters: number; runStep: number; coveredEdges: number } }

const tagsByWay = new Map(source.ways.map(way => [String(way.id), way.tags as Record<string, string | undefined>]));
const tagsFor = (network: RoadNetwork, edge: NetworkEdge) => network.id.startsWith('moscow-osm')
  ? tagsByWay.get(/^osm:(\d+):/.exec(edge.id)?.[1] ?? '') : undefined;
const CELL = 64, SHOULDER = 1.1;
type Segment = { edge: NetworkEdge; a: Vec3; b: Vec3; width: number; start: number; end: number;
  border: Vec3[]; minX: number; maxX: number; minZ: number; maxZ: number };
type SegmentTree = { edge: NetworkEdge; minX: number; maxX: number; minZ: number; maxZ: number;
  left?: SegmentTree; right?: SegmentTree; segments?: Segment[] };
const treeFor = (segments: Segment[], start = 0, end = segments.length): SegmentTree => {
  if (end - start <= 8) {
    const leaf = segments.slice(start, end);
    return { edge: segments[start].edge, minX: Math.min(...leaf.map(s => s.minX)), maxX: Math.max(...leaf.map(s => s.maxX)),
      minZ: Math.min(...leaf.map(s => s.minZ)), maxZ: Math.max(...leaf.map(s => s.maxZ)), segments: leaf };
  }
  const mid = (start + end) >>> 1, left = treeFor(segments, start, mid), right = treeFor(segments, mid, end);
  return { edge: left.edge, minX: Math.min(left.minX, right.minX), maxX: Math.max(left.maxX, right.maxX),
    minZ: Math.min(left.minZ, right.minZ), maxZ: Math.max(left.maxZ, right.maxZ), left, right };
};
const MEDIAN_HALF_WIDTH = .35, MEDIAN_CLEARANCE = .025;
const isMainline = (network: RoadNetwork, edge: NetworkEdge) => {
  const t = tagsFor(network, edge);
  return edge.lanes >= 2 && t && ['motorway', 'trunk', 'primary'].includes(t.highway ?? '')
    && ['yes', '1', 'true'].includes(t.oneway ?? (t.highway === 'motorway' ? 'yes' : 'no'))
    && /(?:Юго-Восточная|Северо-Восточная) хорда|Московский скоростной диаметр/.test(t.name ?? '') ? t.name : undefined;
};

/** Pure CPU plan. Only requested edges emit geometry; every road participates in clearance checks.
 * This is plausible road furniture, not a surveyed inventory. Hard budgets prevent accidental
 * whole-network post/sign explosions. Adaptive runs cover the entire corridor rather
 * than exhausting a prefix budget; render tessellation still includes every road knot.
 */
export function planRoadInfrastructure(network: RoadNetwork, corridor: Set<string>): RoadInfrastructurePlan {
  const runs: InfrastructureRun[] = [], signs: InfrastructureSign[] = [];
  const eligible = network.edges.filter(edge => corridor.has(edge.id) && edge.kind !== 'parking' && edge.kind !== 'tunnel' && edge.length > 0)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const requestedRoadsideMeters = eligible.reduce((sum, edge) => sum + edge.length * 2, 0);
  // Reserve two partial runs per edge, so short edge remainders cannot consume the budget.
  const runStep = Math.max(8, requestedRoadsideMeters / Math.max(1, 12000 - eligible.length * 2));
  const coverage = { requestedRoadsideMeters, emittedRoadsideMeters: 0, clearanceSkippedMeters: 0,
    budgetSkippedMeters: 0, duplicateSuppressedMeters: 0, curbReplacedMeters: 0, runStep, coveredEdges: 0 };
  if (!corridor.size) return { runs, signs, coverage };
  // Index only cells reachable by requested furniture/pair queries. All roads in
  // those cells still participate; distant unrelated dense profiles need no ribbons.
  const requestedCells = new Set<string>();
  for (const edge of eligible) {
    const width = Math.max(...(edge.surfaceFrames?.map(f => f.halfWidth) ?? [edge.width === undefined ? edge.lanes * 1.8 + 1.5 : edge.width / 2]));
    const radius = Math.max(32, width + 5);
    let previous = '';
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      const x0 = Math.floor((Math.min(a.x, b.x) - radius) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + radius) / CELL);
      const z0 = Math.floor((Math.min(a.z, b.z) - radius) / CELL), z1 = Math.floor((Math.max(a.z, b.z) + radius) / CELL);
      const key = `${x0}:${x1}:${z0}:${z1}`; if (key === previous) continue; previous = key;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) requestedCells.add(`${x}:${z}`);
    }
  }
  const cells = new Map<string, SegmentTree[]>(), degree = new Map<string, number>();
  for (const edge of network.edges) {
    for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, half = 0;
    for (let i = 0; i < edge.points.length; i++) {
      const p = edge.points[i]; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      half = Math.max(half, edge.surfaceFrames?.[i].halfWidth ?? (edge.width === undefined ? Math.max(edge.lanes, edge.endLanes ?? edge.lanes) * 1.8 + 1.5 : edge.width / 2));
    }
    let relevant = false;
    for (let x = Math.floor((minX - half) / CELL); x <= Math.floor((maxX + half) / CELL) && !relevant; x++)
      for (let z = Math.floor((minZ - half) / CELL); z <= Math.floor((maxZ + half) / CELL); z++)
        if (requestedCells.has(`${x}:${z}`)) { relevant = true; break; }
    if (!relevant) continue;
    let start = 0;
    const segments: Segment[] = [];
    if (edge.points.length < 2) continue;
    let p: Pick<ReturnType<typeof sampleEdge>, 'x' | 'y' | 'z' | 'heading' | 'halfWidth'> = sampleEdge(edge, 0);
    const borderPoint = (v: typeof p, side: number): Vec3 => ({ x: v.x + Math.cos(v.heading) * v.halfWidth * side,
      y: v.y, z: v.z + Math.sin(v.heading) * v.halfWidth * side });
    let left = borderPoint(p, -1), right = borderPoint(p, 1);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i], end = start + Math.hypot(b.x - a.x, b.z - a.z);
      const frame = edge.surfaceFrames?.[i];
      const q = frame ? { x: b.x, y: b.y, z: b.z, heading: Math.atan2(frame.rightZ, frame.rightX), halfWidth: frame.halfWidth } : sampleEdge(edge, end);
      const width = Math.max(p.halfWidth, q.halfWidth);
      const magnitude = frame ? Math.hypot(frame.rightX, frame.rightZ) : 1;
      const rx = frame ? frame.rightX / magnitude : Math.cos(q.heading), rz = frame ? frame.rightZ / magnitude : Math.sin(q.heading);
      const nextLeft = { x: q.x - rx * q.halfWidth, y: q.y, z: q.z - rz * q.halfWidth };
      const nextRight = { x: q.x + rx * q.halfWidth, y: q.y, z: q.z + rz * q.halfWidth };
      const border = [left, nextLeft, nextRight, right]; left = nextLeft; right = nextRight;
      const segment = { edge, a, b, width, start, end, border,
        minX: Math.min(border[0].x, border[1].x, border[2].x, border[3].x),
        maxX: Math.max(border[0].x, border[1].x, border[2].x, border[3].x),
        minZ: Math.min(border[0].z, border[1].z, border[2].z, border[3].z),
        maxZ: Math.max(border[0].z, border[1].z, border[2].z, border[3].z) }; start = end;
      segments.push(segment); p = q;
    }
    const tree = treeFor(segments);
    for (let x = Math.floor(tree.minX / CELL); x <= Math.floor(tree.maxX / CELL); x++)
      for (let z = Math.floor(tree.minZ / CELL); z <= Math.floor(tree.maxZ / CELL); z++) {
        const key = `${x}:${z}`; if (!requestedCells.has(key)) continue;
        const list = cells.get(key) ?? []; list.push(tree); cells.set(key, list);
      }
  }
  const candidateCache = new Map<string, SegmentTree[]>();
  const neighbours = (p: Vec3, radius: number, accept?: (edge: NetworkEdge) => boolean, heading?: number) => {
    const found: Segment[] = [];
    const tx = heading === undefined ? 0 : -Math.sin(heading), tz = heading === undefined ? 0 : Math.cos(heading);
    const visit = (tree: SegmentTree) => {
      if (p.x + radius < tree.minX || p.x - radius > tree.maxX
        || p.z + radius < tree.minZ || p.z - radius > tree.maxZ) return;
      if (heading !== undefined) {
        const center = ((tree.minX + tree.maxX) / 2 - p.x) * tx + ((tree.minZ + tree.maxZ) / 2 - p.z) * tz;
        const extent = (tree.maxX - tree.minX) / 2 * Math.abs(tx) + (tree.maxZ - tree.minZ) / 2 * Math.abs(tz);
        if (Math.abs(center) > extent + 1e-7) return;
      }
      if (tree.left && tree.right) { visit(tree.left); visit(tree.right); return; }
      for (const segment of tree.segments!) {
        if (p.x + radius < segment.minX || p.x - radius > segment.maxX
          || p.z + radius < segment.minZ || p.z - radius > segment.maxZ) continue;
        if (heading !== undefined) {
          const center = ((segment.minX + segment.maxX) / 2 - p.x) * tx + ((segment.minZ + segment.maxZ) / 2 - p.z) * tz;
          const extent = (segment.maxX - segment.minX) / 2 * Math.abs(tx) + (segment.maxZ - segment.minZ) / 2 * Math.abs(tz);
          if (Math.abs(center) > extent + 1e-7) continue;
        }
        found.push(segment);
      }
    };
    const x0 = Math.floor((p.x - radius) / CELL), x1 = Math.floor((p.x + radius) / CELL);
    const z0 = Math.floor((p.z - radius) / CELL), z1 = Math.floor((p.z + radius) / CELL);
    const key = `${x0}:${x1}:${z0}:${z1}`;
    let candidates = candidateCache.get(key);
    if (!candidates) {
      const seen = new Set<SegmentTree>();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++)
        for (const tree of cells.get(`${x}:${z}`) ?? []) seen.add(tree);
      candidates = [...seen]; candidateCache.set(key, candidates);
    }
    for (const tree of candidates) if (!accept || accept(tree.edge)) visit(tree);
    return found;
  };
  const projection = (p: Vec3, segment: Segment) => {
    const { a, b } = segment, dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
    const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0;
    return { distance: Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz), y: a.y + t * (b.y - a.y),
      s: segment.start + t * (segment.end - segment.start) };
  };
  const ribbonDistance = (p: Vec3, border: Vec3[]) => {
    let inside = false, distance = Infinity;
    for (let i = 0, j = border.length - 1; i < border.length; j = i++) {
      const a = border[j], b = border[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      distance = Math.min(distance, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
      if ((a.z > p.z) !== (b.z > p.z) && p.x < a.x + (p.z - a.z) * dx / dz) inside = !inside;
    }
    return inside ? 0 : distance;
  };
  const continuations = new Map<NetworkEdge, Map<NetworkEdge, boolean>>();
  const obstacle = (edge: NetworkEdge, other: NetworkEdge) => {
      if (edge === other) return false;
      let cache = continuations.get(edge); if (!cache) { cache = new Map(); continuations.set(edge, cache); }
      if (cache.has(other)) return cache.get(other)!;
      // A degree-two tangent continuation is the same physical roadside, not an obstacle.
      const joint = edge.to === other.from ? edge.to : other.to === edge.from ? edge.from : undefined;
      if (joint && degree.get(joint) === 2) {
        const h = sampleEdge(edge, joint === edge.to ? edge.length : 0).heading;
        const oh = sampleEdge(other, joint === other.from ? 0 : other.length).heading;
        if (Math.cos(h - oh) > .98) { cache.set(other, false); return false; }
      }
      cache.set(other, true); return true;
  };
  const clear = (edge: NetworkEdge, p: Vec3, radius: number, margin = .5) => {
    for (const segment of neighbours(p, radius + 1, other => obstacle(edge, other))) {
      const near = projection(p, segment);
      // The furniture occupies only its own deck; never project it onto an unrelated deck.
      if (Math.abs(near.y - p.y) < 6 && ribbonDistance(p, segment.border) < radius + margin - 1e-7) return false;
    }
    return true;
  };
  // Intersect the actual framed inner ribbon border with this station's left ray.
  // Using the opposite edge's start heading or unframed width loses narrow medians.
  const pairCache = new Map<NetworkEdge, Map<number, { edge: NetworkEdge; lateral: number; gap: number; s: number } | undefined>>();
  const stationCache = new Map<NetworkEdge, Map<number, ReturnType<typeof sampleEdge>>>();
  const station = (edge: NetworkEdge, s: number) => {
    let cache = stationCache.get(edge); if (!cache) { cache = new Map(); stationCache.set(edge, cache); }
    let p = cache.get(s); if (!p) { p = sampleEdge(edge, s); cache.set(s, p); } return p;
  };
  const mainNames = new Map(network.edges.map(edge => [edge, isMainline(network, edge)]));
  const paired = (edge: NetworkEdge, s: number) => {
    const name = mainNames.get(edge); if (!name) return undefined;
    let cache = pairCache.get(edge); if (!cache) { cache = new Map(); pairCache.set(edge, cache); }
    if (cache.has(s)) return cache.get(s);
    const p = station(edge, s), rx = Math.cos(p.heading), rz = Math.sin(p.heading);
    let best: { edge: NetworkEdge; lateral: number; gap: number; s: number } | undefined;
    for (const segment of neighbours(p, 32, other => other !== edge && mainNames.get(other) === name, p.heading)) {
      if (segment.edge === edge || mainNames.get(segment.edge) !== name) continue;
      const [a, b] = segment.border, dx = b.x - a.x, dz = b.z - a.z;
      const denominator = dx * rz - dz * rx;
      if (Math.abs(denominator) < 1e-9) continue;
      const t = ((p.x - a.x) * rz - (p.z - a.z) * rx) / denominator;
      if (t < -1e-7 || t > 1 + 1e-7) continue;
      const lateral = (a.x + t * dx - p.x) * rx + (a.z + t * dz - p.z) * rz;
      const gap = -lateral - p.halfWidth;
      if (lateral >= 0 || gap < -.5 || gap > 16 || (best && gap >= best.gap)) continue;
      const q = sampleEdge(segment.edge, segment.start + Math.max(0, Math.min(1, t)) * (segment.end - segment.start));
      if (Math.cos(q.heading - p.heading) > -.98 || Math.abs(q.y - p.y) > .75) continue;
      best = { edge: segment.edge, gap, lateral: (lateral - p.halfWidth) / 2,
        s: segment.start + Math.max(0, Math.min(1, t)) * (segment.end - segment.start) };
    }
    cache.set(s, best); return best;
  };
  const signed = new Set<string>();
  const emittedMedians = new Map<NetworkEdge, InfrastructureRun[]>();
  for (const edge of eligible) {
    const start = 0, end = edge.length;
    const before = runs.length;
    const tags = tagsFor(network, edge);
    const clearanceKnots = roadSampleDistances(edge, 2);
    // Observed curbed ramp section: curbs/footway (msdEnvironment) replace guardrails.
    const curbs = msdRampCurbRange(network, edge);
    for (const side of [-1, 1] as const) {
      const railClear = new Map<number, boolean>();
      const medianClear = new Map<number, Map<number, boolean>>();
      const append = (run: InfrastructureRun) => {
        const previous = runs.at(-1);
        // Exact endpoint/slope agreement keeps a varying offset without long chord shortcuts.
        if (previous && previous.edgeId === run.edgeId && previous.side === side && previous.end === run.start
          && previous.kind === run.kind && previous.pairedEdgeId === run.pairedEdgeId
          && (run.kind === 'rail' || (Math.abs(previous.lateralEnd! - run.lateralStart!) < 1e-6
            && Math.abs((previous.lateralEnd! - previous.lateralStart!) / (previous.end - previous.start)
              - (run.lateralEnd! - run.lateralStart!) / (run.end - run.start)) < 1e-7))) {
          previous.end = run.end; previous.lateralEnd = run.lateralEnd;
        } else if (runs.length < 12000) {
          runs.push(run);
          if (run.kind === 'median') {
            const list = emittedMedians.get(edge) ?? []; list.push(run); emittedMedians.set(edge, list);
          }
        }
        else { coverage.budgetSkippedMeters += run.end - run.start; return; }
        coverage.emittedRoadsideMeters += run.end - run.start;
      };
      const visit = (s: number, finish: number): void => {
        if (curbs && s < curbs[1] - 1e-9) {
          if (finish > curbs[1] + 1e-9) { visit(curbs[1], finish); finish = curbs[1]; }
          coverage.curbReplacedMeters += finish - s; return;
        }
        const middle = side === -1 ? paired(edge, (s + finish) / 2) : undefined;
        const median = !!middle;
        const first = median ? paired(edge, s) : undefined, last = median ? paired(edge, finish) : undefined;
        let safe = !median || (!!first && !!last && first.edge === middle!.edge && last.edge === middle!.edge);
        let lo = 0, hi = clearanceKnots.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (clearanceKnots[mid] <= s) lo = mid + 1; else hi = mid; }
        const knots: number[] = [];
        for (let i = lo; i < clearanceKnots.length && clearanceKnots[i] < finish; i++) knots.push(clearanceKnots[i]);
        const samples = [s, ...knots, finish];
        if (middle && emittedMedians.has(middle.edge)) {
          let covered = 0;
          for (const at of samples) {
            const pair = paired(edge, at); if (!pair) continue;
            const list = emittedMedians.get(pair.edge); if (!list) continue;
            let lo = 0, hi = list.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].end < pair.s - 1e-6) lo = mid + 1; else hi = mid; }
            const run = list[lo];
            if (run && run.start <= pair.s + 1e-6 && run.pairedEdgeId === edge.id) covered++;
          }
          if (covered === samples.length) { coverage.duplicateSuppressedMeters += finish - s; return; }
          // At ownership boundaries, preserve only the uncovered portions. Never suppress
          // merely because the opposite direction was requested or has a lower ID.
          if (covered) {
            if (finish - s > .5) { const mid = (s + finish) / 2; visit(s, mid); visit(mid, finish); }
            else coverage.clearanceSkippedMeters += finish - s;
            return;
          }
        }
        for (const at of samples) {
          if (!safe) break;
          if (!median && railClear.has(at)) { safe = railClear.get(at)!; continue; }
          const p = station(edge, at);
          let lateral = side * (p.halfWidth + SHOULDER);
          if (median) {
            const pair = paired(edge, at);
            if (!pair || pair.edge !== middle!.edge || pair.gap < 2 * (MEDIAN_HALF_WIDTH + MEDIAN_CLEARANCE)) { safe = false; break; }
            lateral = first!.lateral + (last!.lateral - first!.lateral) * (at - s) / (finish - s);
            if (Math.abs(lateral - pair.lateral) > .01
              || -lateral - p.halfWidth < MEDIAN_HALF_WIDTH + MEDIAN_CLEARANCE) { safe = false; break; }
          } else if (side === -1 && paired(edge, at)) { railClear.set(at, false); safe = false; break; }
          let cached = median ? medianClear.get(at) : undefined;
          let stationSafe = cached?.get(lateral);
          if (stationSafe === undefined) {
            const position = { x: p.x + Math.cos(p.heading) * lateral, y: p.y, z: p.z + Math.sin(p.heading) * lateral };
            stationSafe = clear(edge, position, median ? MEDIAN_HALF_WIDTH : .36, median ? MEDIAN_CLEARANCE : .5);
            if (median) {
              if (!cached) { cached = new Map(); medianClear.set(at, cached); }
              cached.set(lateral, stationSafe);
            }
          }
          if (!median) railClear.set(at, stationSafe);
          if (!stationSafe) { safe = false; break; }
        }
        if (!safe) {
          if (finish - s > .5) { const mid = (s + finish) / 2; visit(s, mid); visit(mid, finish); }
          else coverage.clearanceSkippedMeters += finish - s;
          return;
        }
        append({ edgeId: edge.id, start: s, end: finish, side, kind: median ? 'median' : 'rail',
          ...(median ? { lateralStart: first!.lateral, lateralEnd: last!.lateral, pairedEdgeId: middle!.edge.id } : {}) });
      };
      for (let s = start; s < end; s += runStep) visit(s, Math.min(end, s + runStep));
    }
    if (runs.length > before) coverage.coveredEdges++;
    const wayKey = /^osm:(\d+):(-?\d+):/.exec(edge.id)?.slice(1).join(':') ?? edge.id;
    const s = start + 24;
    if (signs.length >= 24 || signed.has(wayKey) || s + 24 > end) continue;
    const p = sampleEdge(edge, s, sampleEdge(edge, s).halfWidth + 2.6);
    if (!clear(edge, p, 1.5)) continue;
    // A branch alone is not legal sign evidence. Only show a schematic through/right
    // diagram when source lane tags explicitly corroborate that movement.
    const kind = tags?.maxspeed === '90' ? 'speed90' : (degree.get(edge.to) ?? 0) > 2
      && /(?:^|[|;])through(?:[|;]|$)/.test(tags?.['turn:lanes'] ?? '')
      && /(?:^|[|;])slight_right(?:[|;]|$)/.test(tags?.['turn:lanes'] ?? '') ? 'direction' : undefined;
    if (kind) { signs.push({ edgeId: edge.id, s, kind }); signed.add(wayKey); }
  }
  return { runs, signs, coverage };
}

/** Emits world-metre geometry, no THREE dependency, no scenery, no transverse barriers.
 * Supply the renderer's quad and centered box callbacks; all sign faces look upstream.
 */
export function emitRoadInfrastructure(network: RoadNetwork, corridor: Set<string>, emitQuad: InfrastructureQuadEmitter, emitBox: InfrastructureBoxEmitter): void {
  const plan = planRoadInfrastructure(network, corridor), edges = new Map(network.edges.map(edge => [edge.id, edge]));
  const stations = new Map<string, number[]>();
  let posts = 0;
  for (const run of plan.runs) {
    const edge = edges.get(run.edgeId)!;
    let knots = stations.get(edge.id);
    if (!knots) { knots = roadSampleDistances(edge); stations.set(edge.id, knots); }
    let lo = 0, hi = knots.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (knots[mid] <= run.start) lo = mid + 1; else hi = mid; }
    const spans = [run.start];
    for (let i = lo; i < knots.length && knots[i] < run.end; i++) spans.push(knots[i]);
    spans.push(run.end);
    const point = (s: number, offset: number, height: number) => {
      const lateral = run.lateralStart === undefined ? run.side * (sampleEdge(edge, s).halfWidth + SHOULDER)
        : run.lateralStart + (run.lateralEnd! - run.lateralStart) * (s - run.start) / (run.end - run.start);
      const p = sampleEdge(edge, s, lateral + run.side * offset);
      return { x: p.x, y: p.y + height, z: p.z };
    };
    const profileStrip = (material: InfrastructureMaterial, profile: number[][]) => {
      for (let station = 1; station < spans.length; station++) for (let i = 1; i < profile.length; i++) {
        const [d0, y0] = profile[i - 1], [d1, y1] = profile[i];
        emitQuad(material, point(spans[station - 1], d0, y0), point(spans[station], d0, y0),
          point(spans[station], d1, y1), point(spans[station - 1], d1, y1));
      }
    };
    if (run.kind === 'median') {
      // Longitudinal Jersey profile, never a box spanning a carriageway.
      const profile = [[-.35, .05], [-.35, .25], [-.12, .65], [-.10, 1.05], [.10, 1.05], [.12, .65], [.35, .25], [.35, .05]];
      profileStrip('infrastructureConcrete', profile);
    } else {
      // Corrugated W-beam: two outward ribs around a recessed center seam.
      const profile = [[0, .53], [.10, .61], [0, .72], [.10, .83], [0, .91]];
      profileStrip('infrastructureMetal', profile);
      // World-distance spacing is independent of adaptive planning/merged run boundaries.
      for (let at = 8 + 24 * Math.ceil((run.start - 8) / 24); at < run.end && posts < 2000; at += 24) {
        const p = sampleEdge(edge, at); posts++;
        emitBox('infrastructureMetal', point(at, .16, .48), .12, .96, .16, p.heading);
        if (Math.floor(at / 8) % 6 === 1) emitBox(run.side === 1 ? 'infrastructureRed' : 'infrastructureWhite', point(at, -.03, .8), .04, .14, .18, p.heading);
      }
    }
  }
  for (const sign of plan.signs) {
    const edge = edges.get(sign.edgeId)!, p = sampleEdge(edge, sign.s, sampleEdge(edge, sign.s).halfWidth + 2.6);
    const face = (x: number, y: number, forward = 0): Vec3 => ({ x: p.x + Math.cos(p.heading) * x + Math.sin(p.heading) * forward,
      y: p.y + y, z: p.z + Math.sin(p.heading) * x - Math.cos(p.heading) * forward });
    emitBox('infrastructureMetal', face(0, 1.6), .09, 3.2, .09, p.heading);
    if (sign.kind === 'speed90') {
      // Polygonal circular disc and geometry digits avoid font/canvas/GPU dependencies.
      for (let i = 0; i < 24; i++) {
        const a = i / 12 * Math.PI, b = (i + 1) / 12 * Math.PI;
        const disc = (radius: number, material: InfrastructureMaterial, depth: number) => emitQuad(material, face(0, 3.05, depth), face(Math.cos(a) * radius, 3.05 + Math.sin(a) * radius, depth), face(Math.cos(b) * radius, 3.05 + Math.sin(b) * radius, depth), face(0, 3.05, depth));
        disc(.48, 'infrastructureRed', 0); disc(.37, 'infrastructureWhite', -.012);
      }
      const segments = [[-.065, .15, .13, .035], [-.065, 0, .13, .035], [-.065, -.15, .13, .035], [-.13, .075, .035, .15], [0, .075, .035, .15], [0, -.075, .035, .15]];
      for (const [x, y, w, h] of segments) emitBox('infrastructureDark', face(x - .08, 3.05 + y, -.025), w, h, .012, p.heading);
      for (const [x, y, w, h] of [[.16, .15, .13, .035], [.16, -.15, .13, .035], [.095, 0, .035, .3], [.225, 0, .035, .3]]) emitBox('infrastructureDark', face(x, 3.05 + y, -.025), w, h, .012, p.heading);
    } else {
      emitBox('infrastructureWhite', face(0, 3.05), 1.55, 1.05, .07, p.heading);
      emitBox('infrastructureBlue', face(0, 3.05, -.045), 1.45, .95, .025, p.heading);
      // Generic forward/diverge arrows only: no fabricated route/destination text.
      emitBox('infrastructureWhite', face(-.35, 3.0, -.065), .07, .48, .012, p.heading);
      emitQuad('infrastructureWhite', face(-.51, 3.15, -.075), face(-.35, 3.36, -.075), face(-.19, 3.15, -.075), face(-.35, 3.2, -.075));
      emitQuad('infrastructureWhite', face(.15, 2.78, -.075), face(.21, 2.76, -.075), face(.53, 3.24, -.075), face(.47, 3.26, -.075));
      emitQuad('infrastructureWhite', face(.27, 3.27, -.075), face(.59, 3.38, -.075), face(.58, 3.05, -.075), face(.48, 3.24, -.075));
    }
  }
}
