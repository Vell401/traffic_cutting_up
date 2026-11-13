import { sampleEdge } from './geometry';
import type { NetworkEdge, RoadKind, RoadNetwork, SurfaceSample, Vec3 } from './geometry';

type Anchor = readonly [number, number, number?];
interface Corridor { route: string; plus: NetworkEdge[]; minus: NetworkEdge[] }
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.z - a.z);
const lengthOf = (points: Vec3[]) => points.slice(1).reduce((s, p, i) => s + horizontal(points[i], p), 0);

/** Centripetal-looking, broad authored control polygons; dense samples are subsequently
 * resampled by horizontal arc length. SVG is a topology sketch, not a radius prescription. */
function spline(anchors: Anchor[], closed: boolean): Vec3[] {
  const points = anchors.map(([x, z, y = 12]) => ({ x, y, z }));
  const result: Vec3[] = [];
  const get = (i: number) => points[closed ? (i + points.length) % points.length : Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const a = get(i - 1), b = get(i), c = get(i + 1), d = get(i + 2);
    const count = Math.max(20, Math.ceil(horizontal(b, c) / 4));
    for (let j = 0; j < count; j++) {
      const t = j / count, p = { x: 0, y: 0, z: 0 };
      for (const key of ['x', 'y', 'z'] as const) p[key] = 0.5 * (2 * b[key] + (-a[key] + c[key]) * t + (2 * a[key] - 5 * b[key] + 4 * c[key] - d[key]) * t * t + (-a[key] + 3 * b[key] - 3 * c[key] + d[key]) * t * t * t);
      result.push(p);
    }
  }
  result.push({ ...get(closed ? 0 : points.length - 1) });
  return result;
}

class Builder {
  readonly network: RoadNetwork;
  constructor(id: string) { this.network = { id, nodes: [], edges: [], parkings: [] }; }
  edge(id: string, from: string, to: string, points: Vec3[], route: string, lanes: number, kind: RoadKind = 'road'): NetworkEdge {
    const edge: NetworkEdge = { id, from, to, points, route, lanes, kind, length: lengthOf(points) };
    for (const [nodeId, position] of [[from, points[0]], [to, points[points.length - 1]]] as const) {
      if (!this.network.nodes.some(n => n.id === nodeId)) this.network.nodes.push({ id: nodeId, position: { ...position } });
    }
    this.network.edges.push(edge);
    return edge;
  }
  corridor(route: string, anchors: Anchor[], closed: boolean, lanes: number, kinds: (fraction: number) => RoadKind = () => 'road', targetLength?: number): Corridor {
    const points = spline(anchors, closed);
    // Each independently authored concept corridor has an explicit axis budget.
    // City routes scale about X1 so its actual grade-separated crossing is retained.
    if (targetLength !== undefined) {
      const scale = targetLength / lengthOf(points);
      for (const p of points) { p.x = -150 + (p.x + 150) * scale; p.z = -100 + (p.z + 100) * scale; }
    }
    const axis: NetworkEdge = { id: route, from: '', to: '', points, route, lanes, kind: 'road', length: lengthOf(points) };
    const count = Math.max(12, Math.ceil(axis.length / 250));
    const plus: NetworkEdge[] = [], minus: NetworkEdge[] = [];
    const offset = lanes * 1.8 + 3;
    const point = (s: number, d: number): Vec3 => { const p = sampleEdge(axis, s, d); return { x: p.x, y: p.y, z: p.z }; };
    // Use the same central tangent at the closed seam, not one-sided polyline tangents.
    const seam = (d: number) => {
      const a = points[points.length - 2], b = points[1];
      const h = Math.atan2(b.x - a.x, a.z - b.z);
      return { x: points[0].x + Math.cos(h) * d, y: points[0].y, z: points[0].z + Math.sin(h) * d };
    };
    const carriagewayPoint = (s: number, d: number): Vec3 => {
      if (!closed) return point(Math.max(0, Math.min(axis.length, s)), d);
      const wrapped = ((s % axis.length) + axis.length) % axis.length;
      return wrapped < 1e-6 || axis.length - wrapped < 1e-6 ? seam(d) : point(wrapped, d);
    };
    const boundaryTangent = (s: number, d: number) => {
      // Estimate from BOTH sides of the unsplit offset curve. Independent one-sided
      // chords differ by curvature * sample spacing, especially on the S3 bends.
      const a = carriagewayPoint(s - 2.5, d), b = carriagewayPoint(s + 2.5, d);
      return Math.atan2(b.x - a.x, a.z - b.z);
    };
    for (let i = 0; i < count; i++) {
      const start = axis.length * i / count, end = axis.length * (i + 1) / count;
      const n = Math.ceil((end - start) / 5);
      for (const direction of [1, -1]) {
        const suffix = direction === 1 ? '+' : '-';
        const samples = Array.from({ length: n + 1 }, (_, j) => {
          const s = start + (end - start) * j / n, d = -direction * offset;
          return carriagewayPoint(s, d);
        });
        // Encode the shared tangent in the geometry itself, not sampler metadata:
        // outgoing/incoming endpoint segments are collinear at the same node.
        // Preserve their horizontal lengths and elevations. The adjustment is the
        // small chord-to-tangent discretisation error, not a new connecting ramp.
        for (const [endpoint, neighbour, s, sign] of [[0, 1, start, 1], [n, n - 1, end, -1]] as const) {
          const p = samples[endpoint], q = samples[neighbour];
          const ds = horizontal(p, q), heading = boundaryTangent(s, -direction * offset);
          q.x = p.x + sign * Math.sin(heading) * ds;
          q.z = p.z - sign * Math.cos(heading) * ds;
        }
        const a = `${route}${suffix}:${i}`, b = `${route}${suffix}:${closed ? (i + 1) % count : i + 1}`;
        const edge = this.edge(`${route}${suffix}:${i}`, direction === 1 ? a : b, direction === 1 ? b : a, direction === 1 ? samples : samples.reverse(), route, lanes, kinds((i + 0.5) / count));
        (direction === 1 ? plus : minus).push(edge);
      }
    }
    return { route, plus, minus };
  }
  /** Ramps leave/arrive at distinct carriageway nodes, never an at-grade median U-turn.
   * Two short tangent leads make all legal transitions exactly heading-compatible. */
  ramp(id: string, source: NetworkEdge, target: NetworkEdge, kind: RoadKind = 'bridge', bulge = 0): NetworkEdge {
    const a = sampleEdge(source, source.length), b = sampleEdge(target, 0);
    const lead = 15;
    const shift = (p: SurfaceSample, ds: number): Vec3 => ({ x: p.x + Math.sin(p.heading) * ds, z: p.z - Math.cos(p.heading) * ds, y: p.y + p.grade * ds });
    const p0 = shift(a, lead), p3 = shift(b, -lead);
    let reach = horizontal(p0, p3) * 0.45;
    const build = (): Vec3[] => {
    const p1 = shift({ ...a, ...p0 }, reach), p2 = shift({ ...b, ...p3 }, -reach);
    const points: Vec3[] = [{ x: a.x, y: a.y, z: a.z }, { ...p0 }];
    const n = Math.max(40, Math.ceil((horizontal(p0, p3) + reach * 2) / 4));
    for (let i = 1; i < n; i++) {
      const t = i / n, u = 1 - t;
      points.push({
        x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x + bulge * Math.sin(Math.PI * t) ** 2,
        z: u ** 3 * p0.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t ** 3 * p3.z,
        y: 0,
      });
    }
    points.push({ ...p3 }, { x: b.x, y: b.y, z: b.z });
    // Elevation is a function of HORIZONTAL ARC DISTANCE, not Bezier t. Using
    // grade * control-handle length as a vertical Bezier handle produced steep
    // spikes wherever the horizontal cubic slowed down (notably J1:out+).
    // Retain the tangent leads and match both endpoint grades with a Hermite
    // vertical profile over the intervening, measured horizontal ramp length.
    const arc = [0];
    for (let i = 2; i < points.length - 1; i++) arc.push(arc[arc.length - 1] + horizontal(points[i - 1], points[i]));
    const run = arc[arc.length - 1], rise = p3.y - p0.y;
    for (let i = 1; i < points.length - 1; i++) {
      const t = arc[i - 1] / run;
      points[i].y = p0.y + rise * (3 * t * t - 2 * t ** 3)
        + run * a.grade * (t ** 3 - 2 * t * t + t)
        + run * b.grade * (t ** 3 - t * t);
    }
    return points;
    };
    let points = build();
    // Lengthen the horizontal connector, not merely flatten its elevation or
    // relax the grade limit. Preserve the takeoff/landing stations and tangents.
    // The Hermite grade is quadratic in normalised horizontal arc distance;
    // check its exact extrema as well as the actual tessellated segment grades.
    const worstGrade = (path: Vec3[]): number => {
      const run = lengthOf(path.slice(1, -1)), slope = (p3.y - p0.y) / run;
      const c0 = a.grade, c1 = 6 * slope - 4 * a.grade - 2 * b.grade;
      const c2 = -6 * slope + 3 * a.grade + 3 * b.grade;
      let worst = Math.max(Math.abs(a.grade), Math.abs(b.grade));
      const vertex = -c1 / (2 * c2);
      if (vertex > 0 && vertex < 1) worst = Math.max(worst, Math.abs(c0 + c1 * vertex + c2 * vertex * vertex));
      for (let i = 1; i < path.length; i++) worst = Math.max(worst, Math.abs(path[i].y - path[i - 1].y) / horizontal(path[i - 1], path[i]));
      return worst;
    };
    for (let attempt = 0; worstGrade(points) > 0.079 && attempt < 24; attempt++) {
      reach *= 1.35;
      points = build();
    }
    if (worstGrade(points) > 0.08) throw new Error(`Ramp cannot meet eight percent grade: ${id}`);
    return this.edge(id, source.to, target.from, points, id.split(':')[0], kind === 'parking' ? 1 : 2, kind);
  }
  junction(id: string, loop: Corridor, fraction: number, access: Corridor, start: boolean): void {
    const n = loop.plus.length, i = Math.round(fraction * n) % n;
    const before = (i + n - 2) % n, after = (i + 2) % n;
    const inward = start ? access.plus[0] : access.minus[access.minus.length - 1];
    const outward = start ? access.minus[0] : access.plus[access.plus.length - 1];
    this.ramp(`${id}:in+`, loop.plus[before], inward);
    this.ramp(`${id}:in-`, loop.minus[after], inward);
    this.ramp(`${id}:out+`, outward, loop.plus[after]);
    this.ramp(`${id}:out-`, outward, loop.minus[before]);
  }
  parking(id: string, name: string, loop: Corridor, fraction: number): void {
    const n = loop.plus.length, i = Math.floor(fraction * n);
    const access = this.ramp(`${id}:access`, loop.plus[i], loop.plus[(i + 4) % n], 'parking', -100);
    access.width = 22;
    this.network.parkings.push({ id, name, edgeId: access.id, s: access.length / 2 });
  }
}

/** Variant 02 geometry backend, not a geographic tracing of the concept SVG.
 * Compromises: compact directional diamonds (four movements per endpoint), not
 * full cloverleaf matrices; parking is a broad through-access collector, not a
 * free-roam lot. Reverse parking access uses the surrounding connected network.
 * No mainline node ever connects opposing carriageways or coincident crossings. */
export function createBayNetwork(): RoadNetwork {
  const b = new Builder('bay');
  const r = b.corridor('R0', [
    [-4800, 800, 12], [-5200, -1400, 22], [-4000, -3300, 26], [-2100, -3500, 30],
    [-200, -4300, 32], [1800, -3900, 24], [3500, -2800, 18], [4700, -1300, 12],
    [4300, 500, 12], [4900, 1700, 42], [4200, 3500, 42], [2600, 4200, 12],
    [700, 4600, 12], [-1000, 4300, 12], [-2900, 4600, 12], [-4300, 3600, 12],
    [-3900, 2300, -38], [-4400, 1600, -38],
  ], true, 3, f => f > 0.47 && f < 0.59 ? 'bridge' : f > 0.88 ? 'tunnel' : 'road', 36000);
  const c1 = b.corridor('C1', [
    [-2400, -700, 16], [-3100, -1200, 16], [-2700, -1900, 8], [-1900, -2100, -8],
    [-1300, -2500, -8], [-650, -2100, 16], [-350, -1200, 24], [-150, -100, 24],
    [-1000, 350, 16], [-1800, 1000, 16], [-2900, 700, 16], [-2700, 0, 16],
  ], true, 2, f => f > 0.16 && f < 0.3 ? 'tunnel' : 'road', 7800);
  const c2 = b.corridor('C2', [
    [-150, -100, 8], [500, -1100, 8], [1300, -1500, 12], [2200, -1100, 18],
    [3100, -1400, 30], [3500, -500, 30], [2600, -200, -8], [2200, 650, -8],
    [1400, 950, 12], [700, 1400, 16], [-100, 850, 12], [-650, 550, 8],
  ], true, 2, f => f > 0.48 && f < 0.64 ? 'tunnel' : 'road', 8800);
  const s1 = b.corridor('S1', [[-4700, 500], [-4200, -200], [-3800, -100], [-3400, -600], [-3000, -900], [-2400, -700]], false, 2, undefined, 3700);
  const s2 = b.corridor('S2', [[200, -4250, 20], [500, -3500, 20], [50, -3100, 20], [350, -2400, 20], [-400, -1700, 24]], false, 2, undefined, 3700);
  const s3 = b.corridor('S3', [[4400, 500], [3800, 600], [3600, 200], [2900, 350], [2700, 0], [2200, 200]], false, 2, undefined, 3700);
  const c3 = b.corridor('C3', [[-1800, 1000, 12], [-1100, 1550, 12], [-300, 1600, 12], [500, 1150, 12], [1200, 1000, 12]], false, 2, undefined, 2500);
  b.junction('J1', r, 0, s1, true); b.junction('J4', c1, 0, s1, false);
  b.junction('J2', r, 0.26, s2, true); b.junction('J5', c1, 0.53, s2, false);
  b.junction('J3', r, 0.46, s3, true); b.junction('J6', c2, 0.65, s3, false);
  b.junction('C3-west', c1, 0.77, c3, true); b.junction('C3-east', c2, 0.77, c3, false);
  // X1 is a genuine crossing at (-150,-100), C1 24 m / C2 8 m.
  // Four directional transfers, while both continuous city loops retain priority.
  const i = Math.floor(c1.plus.length * 0.6), j = 1;
  b.ramp('X1:++', c1.plus[i - 2], c2.plus[j + 2]);
  b.ramp('X1:+-', c1.plus[i - 2], c2.minus[c2.minus.length - 3]);
  b.ramp('X1:-+', c2.minus[j + 2], c1.plus[i + 2]);
  b.ramp('X1:--', c2.plus[c2.plus.length - 3], c1.minus[i - 2]);
  b.ramp('F4:distributor', s2.plus[4], s2.plus[s2.plus.length - 2], 'road', 180);
  // F1 lane addition and removal: two local tapers, not a whole-route widening.
  const f1 = Math.floor(c1.plus.length * 0.42);
  c1.plus[f1].endLanes = 3;
  c1.plus[f1 + 1].lanes = 3; c1.plus[f1 + 1].endLanes = 2;
  c1.plus[Math.floor(c1.plus.length * 0.9)].width = 15; // F2
  r.plus[Math.floor(r.plus.length * 0.73)].width = 19; // F5
  b.parking('P1', 'Port waterfront', r, 0.68);
  b.parking('P2', 'Business district', c1, 0.85);
  b.parking('P3', 'Outer ring rest area', r, 0.36);
  return b.network;
}

export function createPrototypeNetwork(): RoadNetwork {
  const b = new Builder('prototype');
  // Figure-eight with two distinct elevations at the same horizontal crossing.
  const main = b.corridor('prototype', [
    [0, 0, 10], [900, -900, 10], [1800, 0, 10], [900, 900, 20],
    [0, 0, 28], [-900, -900, 28], [-1800, 0, 20], [-900, 900, 10],
  ], true, 2);
  const branch = b.ramp('prototype:split-merge', main.plus[1], main.plus[7], 'bridge', -180);
  // Elevated middle crosses the opposite side of the loop, independent of its nodes.
  for (let i = 2; i < branch.points.length - 2; i++) {
    const t = (i - 1) / (branch.points.length - 3);
    branch.points[i].y += 18 * Math.sin(Math.PI * t) ** 2;
  }
  branch.lanes = 3; branch.endLanes = 2;
  // Opposite flows change direction only via separated, long access connectors.
  b.ramp('prototype:transfer+', main.plus[10], main.minus[2]);
  b.ramp('prototype:transfer-', main.minus[10], main.plus[2]);
  b.parking('P1', 'Prototype meeting area', main, 0.6);
  return b.network;
}
