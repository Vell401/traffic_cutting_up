import { createCar, type PhysicsId } from '../sim/physics';
import { PlayerCar } from '../sim/vehicle';
import { WALL_D } from '../config';
import { terminalAddress } from './boundaries';
import { adjoining, movementBounds, type LateralBounds } from './junctions';
import { edgeById, sampleEdge, type RoadNetwork, type NetworkEdge, type SurfaceSample } from './geometry';

export interface NetworkInput { steer: number; throttle: number; brake: number; branch?: number; reset?: boolean }
export interface NetworkAddress { edgeId: string; s: number; d: number; psi: number }
export interface NetworkDriver extends NetworkAddress {
  id: string; speed: number; car: PlayerCar; parkingId: string;
  /** Traversed edges, used to reverse through the actual entry, never an arbitrary merge arm. */
  history: string[];
  /** Latched only inside the final 25 m decision region; rewindable. */
  pendingBranch?: number;
}
export const FIXED_STEP = 1 / 120;
export const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const angle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** Network-local boundary adapter: translate only during the inherited contact solve.
 * No solver source, force, tune, or rollback format changes, including overridden steps.
 */
class SurfaceBoundsCar extends PlayerCar {
  private legacyWalls(dt: number): void { super.resolveWalls(dt); }
  static install(car: PlayerCar, bounds: number | (() => LateralBounds), beforeWalls?: () => void): void {
    (car as SurfaceBoundsCar).resolveWalls = function(this: SurfaceBoundsCar, dt: number): void {
      beforeWalls?.();
      const originalD = this.d;
      const { min, max } = typeof bounds === 'number' ? { min: -bounds, max: bounds } : bounds();
      const ext = this.halfExtentD();
      const shift = originalD + ext > max - .05 ? WALL_D - max
        : originalD - ext < min + .05 ? -WALL_D - min : -originalD;
      this.d += shift;
      try { SurfaceBoundsCar.prototype.legacyWalls.call(this, dt); }
      finally { this.d -= shift; }
    };
  }
}
export const applySurfaceBounds = (car: PlayerCar, bounds: number | (() => LateralBounds), beforeWalls?: () => void): void => SurfaceBoundsCar.install(car, bounds, beforeWalls);

const indexes = new WeakMap<RoadNetwork, { edges: Map<string, NetworkEdge>; exits: Map<string, NetworkEdge[]> }>();
const indexedEdges = new WeakMap<RoadNetwork, NetworkEdge[]>();
export function networkIndex(network: RoadNetwork): { edges: Map<string, NetworkEdge>; exits: Map<string, NetworkEdge[]> } {
  let index = indexes.get(network);
  if (!index || indexedEdges.get(network) !== network.edges) {
    const edges = new Map(network.edges.map(e => [e.id, e]));
    const byFrom = new Map<string, NetworkEdge[]>();
    for (const edge of network.edges) { const list = byFrom.get(edge.from) ?? []; list.push(edge); byFrom.set(edge.from, list); }
    index = { edges, exits: new Map(network.edges.map(e => [e.id, (byFrom.get(e.to) ?? []).filter(next => {
      if (!network.openBoundaries || next.to !== e.from) return true;
      // Do not offer the opposite directed copy of the road just travelled as a
      // branch at a real shared junction. Physical reversing still uses history.
      const a = sampleEdge(e, e.length), b = sampleEdge(next, 0);
      return Math.cos(a.heading - b.heading) > -.95;
    })])) }; indexes.set(network, index); indexedEdges.set(network, network.edges);
  }
  return index;
}
export function pose(network: RoadNetwork, entity: { edgeId: string; s: number; d: number; psi?: number }): SurfaceSample {
  const edge = networkIndex(network).edges.get(entity.edgeId);
  if (!edge) throw new Error(`Unknown network edge: ${entity.edgeId}`);
  const p = sampleEdge(edge, entity.s, entity.d);
  return { ...p, heading: angle(p.heading + (entity.psi ?? 0)) };
}

/** Project onto a polyline in horizontal metres; elevation is used to reject stacked surfaces. */
export function project(edge: NetworkEdge, p: { x: number; y: number; z: number }): { s: number; d: number; error: number } {
  let best = { s: 0, d: 0, error: Infinity }, base = 0;
  let surfaceBest = { s: 0, d: 0, error: Infinity };
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1], b = edge.points[i];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len === 0) continue;
    if (edge.surfaceFrames) {
      // Invert the exact sampleEdge chart C(t) + d normalize(N(t)).
      // Parallelism cross(p-C(t), N(t)) = 0 is quadratic, even though
      // normalizing N makes the surface itself non-bilinear.
      const f = edge.surfaceFrames[i - 1], g = edge.surfaceFrames[i];
      const px = p.x - a.x, pz = p.z - a.z;
      const ux = g.rightX - f.rightX, uz = g.rightZ - f.rightZ;
      const aa = -(dx * uz - dz * ux);
      const bb = px * uz - pz * ux - dx * f.rightZ + dz * f.rightX;
      const cc = px * f.rightZ - pz * f.rightX;
      const roots: number[] = [];
      if (Math.abs(aa) < 1e-14) {
        if (Math.abs(bb) > 1e-14) roots.push(-cc / bb);
      } else {
        const discriminant = bb * bb - 4 * aa * cc;
        if (discriminant >= -1e-12) {
          const root = Math.sqrt(Math.max(0, discriminant));
          const q = -.5 * (bb + (bb >= 0 ? root : -root));
          if (q !== 0) roots.push(q / aa, cc / q);
          else roots.push(-bb / (2 * aa));
        }
      }
      for (const raw of roots) {
        if (raw < -1e-8 || raw > 1 + 1e-8) continue;
        const t = Math.max(0, Math.min(1, raw));
        const nx = f.rightX + ux * t, nz = f.rightZ + uz * t, magnitude = Math.hypot(nx, nz);
        if (magnitude < 1e-12) continue;
        const rx = px - dx * t, rz = pz - dz * t;
        const d = (rx * nx + rz * nz) / magnitude;
        const error = Math.hypot(rx, rz, p.y - a.y - (b.y - a.y) * t);
        if (error < surfaceBest.error) surfaceBest = { s: base + len * t, d, error };
      }
      // Preserve historical endpoint overshoot handling. Interior samples must
      // never fall back to an unrelated orthogonal projection.
      const raw = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len);
      if (!(i === 1 && raw < 0 || i === edge.points.length - 1 && raw > 1)) { base += len; continue; }
    }
    const raw = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len);
    // End segments extend to carry an entire overshoot, including reverse and short edges.
    const t = Math.max(i === 1 ? -Infinity : 0, Math.min(i === edge.points.length - 1 ? Infinity : 1, raw));
    const x = a.x + dx * t, z = a.z + dz * t, y = a.y + (b.y - a.y) * t;
    const error = Math.hypot(p.x - x, p.z - z, p.y - y);
    if (error < best.error) best = { s: base + len * t, d: ((p.x - x) * -dz + (p.z - z) * dx) / len, error };
    base += len;
  }
  return Number.isFinite(surfaceBest.error) ? surfaceBest : best;
}

export function spawnDriver(network: RoadNetwork, id: string, parkingId?: string, physicsId: PhysicsId = 1): NetworkDriver {
  const parking = parkingId === undefined ? network.parkings[0] : network.parkings.find(p => p.id === parkingId);
  if (!parking) throw new Error(`Unknown parking: ${parkingId ?? '(default)'}`);
  const car = createCar(physicsId);
  edgeById(network, parking.edgeId);
  car.reset(parking.s, 0, 0);
  return { id, edgeId: parking.edgeId, s: car.s, d: car.d, psi: car.psi, speed: 0, car, parkingId: parking.id, history: [] };
}

function divergence(edge: NetworkEdge, exit: NetworkEdge): number {
  const origin = sampleEdge(edge, edge.length), ahead = sampleEdge(exit, Math.min(120, exit.length));
  return angle(Math.atan2(ahead.x - origin.x, origin.z - ahead.z) - origin.heading);
}
/** Stable downstream left-to-right order, shared by simulation and HUD. */
export function orderedExits(network: RoadNetwork, edge: NetworkEdge | string): NetworkEdge[] {
  const current = typeof edge === 'string' ? edgeById(network, edge) : edge;
  return [...(networkIndex(network).exits.get(current.id) ?? [])].sort((a, b) => divergence(current, a) - divergence(current, b) || compareIds(a.id, b.id));
}
/** Neutral preserves route continuity; steering selects downstream divergence, not the shared entry tangent. */
export function chooseExit(network: RoadNetwork, edge: NetworkEdge, input: NetworkInput): NetworkEdge | undefined {
  const exits = orderedExits(network, edge);
  if (input.branch !== undefined && Number.isInteger(input.branch) && input.branch >= 0 && input.branch < exits.length) return exits[input.branch];
  if (input.steer < -.35) return exits[0];
  if (input.steer > .35) return exits[exits.length - 1];
  return exits.sort((a, b) => Number(b.route === edge.route) - Number(a.route === edge.route)
    || Math.abs(divergence(edge, a)) - Math.abs(divergence(edge, b)) || compareIds(a.id, b.id))[0];
}

export function syncDriver(driver: NetworkDriver): void {
  driver.s = driver.car.s; driver.d = driver.car.d; driver.psi = driver.car.psi; driver.speed = driver.car.speed;
}

export function stepDriver(network: RoadNetwork, driver: NetworkDriver, input: NetworkInput, dt: number): void {
  const car = driver.car;
  let edge = edgeById(network, driver.edgeId);
  const surface = sampleEdge(edge, car.s, car.d);
  if (edge.length - car.s <= 25) {
    if (input.branch !== undefined && Number.isInteger(input.branch)) driver.pendingBranch = input.branch;
    else if (Math.abs(input.steer) > .35) {
      const selected = chooseExit(network, edge, input);
      const exits = orderedExits(network, edge);
      driver.pendingBranch = exits.findIndex(e => e.id === selected?.id);
    }
  } else driver.pendingBranch = undefined;
  // R34 and Drift override step(), but both call the inherited resolveWalls(). No force model is replaced.
  const selected = chooseExit(network, edge, { ...input, branch: driver.pendingBranch ?? input.branch });
  const priorEdge = networkIndex(network).edges.get(driver.history[driver.history.length - 1]);
  const neighbors = network.openBoundaries ? [
    ...(selected && adjoining(edge, selected) && edge.length - car.s < 60 ? [selected] : []),
    ...(priorEdge && adjoining(priorEdge, edge) && car.s < 60 ? [priorEdge] : []),
  ] : [];
  const initialS = car.s, initialD = car.d;
  let mapped = false;
  const mapLocalStep = edge.surfaceFrames ? () => {
    if (mapped) return;
    mapped = true;
    // The inherited models integrate an orthogonal local road frame. A framed
    // ribbon is a skew chart, so interpret that delta as physical world motion
    // and invert the chart before contacts. No force or body velocity changes.
    const along = car.s - initialS, lateral = car.d - initialD;
    const world = {
      x: surface.x + Math.sin(surface.heading) * along + Math.cos(surface.heading) * lateral,
      y: surface.y + surface.grade * along,
      z: surface.z - Math.cos(surface.heading) * along + Math.sin(surface.heading) * lateral,
    };
    const target = project(edge, world);
    if (Number.isFinite(target.error)) {
      car.s = target.s; car.d = target.d;
      car.psi = angle(car.psi + surface.heading - sampleEdge(edge, car.s).heading);
    }
  } : undefined;
  applySurfaceBounds(car, neighbors.length ? () => movementBounds(edge, car.s, neighbors,
    (Math.abs(Math.cos(car.psi)) * car.tune.length + Math.abs(Math.sin(car.psi)) * car.tune.width) / 2)
    : () => ({ min: -sampleEdge(edge, car.s).halfWidth, max: sampleEdge(edge, car.s).halfWidth }), mapLocalStep);
  car.step(dt, input, edge.surfaceFrames ? 0 : surface.curvature);
  // Some model overrides may omit resolveWalls; still map their integration.
  mapLocalStep?.();
  if (network.openBoundaries && !chooseExit(network, edge, input)) {
    const limit = terminalAddress(edge.length, car.tune.length, car.tune.width, car.psi);
    if (car.s > limit && car.vAlong > 0) { car.s = limit; car.setRoadVelocity(0, car.vLat); }
  }
  // Change coordinate frame as soon as the centre leaves this ribbon for the
  // selected adjoining one, rather than hitting its now-internal lateral seam.
  if (neighbors.length && Math.abs(car.d) > sampleEdge(edge, car.s).halfWidth - car.halfExtentD()) {
    const world = sampleEdge(edge, car.s, car.d);
    for (const next of neighbors) {
      const target = project(next, world), targetSurface = sampleEdge(next, target.s);
      const reconstructed = sampleEdge(next, target.s, target.d);
      if (target.s < 0 || target.s > next.length || Math.abs(targetSurface.y - world.y) > 1
        || Math.hypot(reconstructed.x - world.x, reconstructed.z - world.z) > .1
        || Math.abs(target.d) >= Math.abs(car.d) || Math.abs(target.d) > targetSurface.halfWidth - car.halfExtentD()) continue;
      const forward = next === selected;
      if (forward) driver.history.push(edge.id); else driver.history.pop();
      car.psi = angle(world.heading + car.psi - targetSurface.heading);
      car.s = target.s; car.d = target.d; driver.edgeId = next.id; edge = next;
      driver.pendingBranch = undefined;
      car.prevS = car.s; car.prevD = car.d; car.prevPsi = car.psi;
      break;
    }
  }
  for (let hop = 0; hop < 64 && (car.s > edge.length || car.s < 0); hop++) {
    const forward = car.s > edge.length;
    const at = sampleEdge(edge, forward ? edge.length : 0, car.d);
    const excess = car.s - (forward ? edge.length : 0);
    const world = { x: at.x + Math.sin(at.heading) * excess, y: at.y + at.grade * excess, z: at.z - Math.cos(at.heading) * excess };
    const prior = driver.history[driver.history.length - 1];
    const next = forward ? chooseExit(network, edge, { ...input, branch: driver.pendingBranch ?? input.branch }) : prior ? edgeById(network, prior) : undefined;
    if (!next || (!forward && next.to !== edge.from)) {
      car.s = network.openBoundaries ? terminalAddress(edge.length, car.tune.length, car.tune.width, car.psi, forward) : forward ? edge.length : 0;
      car.setRoadVelocity(0, car.vLat); break;
    }
    const target = project(next, world);
    const nextSurface = sampleEdge(next, target.s);
    const entry = sampleEdge(next, forward ? 0 : next.length);
    // A topological link is not permission to teleport across a gap or to a different deck.
    const center = sampleEdge(edge, forward ? edge.length : 0);
    if (Math.hypot(entry.x - center.x, entry.z - center.z, entry.y - center.y) > .5
      || Math.abs(nextSurface.y - world.y) > 1 || Math.abs(target.d) > nextSurface.halfWidth) {
      car.s = network.openBoundaries ? terminalAddress(edge.length, car.tune.length, car.tune.width, car.psi, forward) : forward ? edge.length : 0;
      car.setRoadVelocity(0, car.vLat); break;
    }
    if (forward) driver.history.push(edge.id); else driver.history.pop();
    driver.pendingBranch = undefined;
    const heading = at.heading + car.psi;
    car.s = target.s; car.d = target.d; car.psi = angle(heading - nextSurface.heading);
    // Body velocities are unchanged: the new address is merely another coordinate frame.
    driver.edgeId = next.id; edge = next;
    car.prevS = car.s; car.prevD = car.d; car.prevPsi = car.psi;
  }
  car.onShoulder = Math.abs(car.d) > sampleEdge(edge, car.s).halfWidth;
  syncDriver(driver);
}

export interface Footprint extends NetworkAddress { length: number; width: number }
/** Rebuilt once per tick; poses cached once per occupant, candidates only in nearby cells. */
export class SurfaceGrid<T extends NetworkAddress> {
  private cells = new Map<string, T[]>();
  readonly poses = new Map<T, SurfaceSample>();
  constructor(network: RoadNetwork, bodies: T[], readonly cellSize = 32) {
    for (const body of bodies) {
      const p = pose(network, body); this.poses.set(body, p);
      const key = this.key(p.x, p.y, p.z), list = this.cells.get(key) ?? [];
      list.push(body); this.cells.set(key, list);
    }
  }
  private key(x: number, y: number, z: number): string { return `${Math.floor(x / this.cellSize)},${Math.floor(y / 4)},${Math.floor(z / this.cellSize)}`; }
  nearby(body: T, radius: number): T[] {
    const p = this.poses.get(body)!;
    const result: T[] = [];
    for (let x = Math.floor((p.x - radius) / this.cellSize); x <= Math.floor((p.x + radius) / this.cellSize); x++)
      for (let z = Math.floor((p.z - radius) / this.cellSize); z <= Math.floor((p.z + radius) / this.cellSize); z++)
        for (let y = Math.floor((p.y - 2) / 4); y <= Math.floor((p.y + 2) / 4); y++) {
          result.push(...(this.cells.get(`${x},${y},${z}`) ?? []));
        }
    return result;
  }
}
/** Horizontal oriented SAT with elevation separation, including contacts across edge seams. */
export function overlaps(network: RoadNetwork, a: Footprint, b: Footprint, pa = pose(network, a), pb = pose(network, b)): boolean {
  if (Math.abs(pa.y - pb.y) > 1.8) return false;
  const axes = (h: number) => [{ x: Math.sin(h), z: -Math.cos(h) }, { x: Math.cos(h), z: Math.sin(h) }];
  const aa = axes(pa.heading), ba = axes(pb.heading);
  for (const axis of [...aa, ...ba]) {
    const dot = (v: { x: number; z: number }) => axis.x * v.x + axis.z * v.z;
    const extent = (v: typeof aa, body: Footprint) => Math.abs(dot(v[0])) * body.length / 2 + Math.abs(dot(v[1])) * body.width / 2;
    if (Math.abs(dot({ x: pb.x - pa.x, z: pb.z - pa.z })) >= extent(aa, a) + extent(ba, b)) return false;
  }
  return true;
}
