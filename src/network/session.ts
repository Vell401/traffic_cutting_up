import { createCar, type PhysicsId } from '../sim/physics';
import { edgeById, sampleEdge, validateNetwork, type RoadNetwork } from './geometry';
import { FIXED_STEP, SurfaceGrid, compareIds, overlaps, spawnDriver, stepDriver, syncDriver, type NetworkDriver, type NetworkInput, type Footprint } from './driving';
import { stepTraffic, type NetworkTraffic, type RoadOccupant } from './traffic';

export { pose, FIXED_STEP, orderedExits } from './driving';
export type { NetworkInput, NetworkDriver } from './driving';
export type { NetworkTraffic } from './traffic';

export interface DriverSnapshot {
  id: string; edgeId: string; s: number; d: number; psi: number; speed: number;
  parkingId: string; physicsId: PhysicsId; history: string[]; state: number[];
  pendingBranch?: number;
  controls: { manual: boolean; blinker: number; shiftRefused: boolean; handbrake: boolean; horn: boolean; ghost: boolean };
}
export interface NetworkSnapshot {
  version: 1; networkId: string; time: number; tick: number; accumulator: number; rng: number;
  drivers: DriverSnapshot[]; traffic: NetworkTraffic[];
}
const idle: NetworkInput = { steer: 0, throttle: 0, brake: 0 };
const bounded = (v: number, low: number, high: number) => Number.isFinite(v) ? Math.max(low, Math.min(high, v)) : 0;

/** The sole simulation entry point for both local prediction and authoritative server ticks. */
export class NetworkSession {
  readonly drivers = new Map<string, NetworkDriver>();
  readonly traffic: NetworkTraffic[] = [];
  time = 0;
  private tick = 0;
  private accumulator = 0;
  private rng: number;

  constructor(readonly network: RoadNetwork, options: { trafficCount?: number; seed?: number } = {}) {
    const errors = validateNetwork(network);
    if (errors.length) throw new Error(`Invalid road network: ${errors.join('; ')}`);
    this.rng = (options.seed ?? 1) >>> 0;
    const count = options.trafficCount ?? 24;
    if (!Number.isInteger(count) || count < 0 || count > 10000) throw new Error('Invalid traffic count');
    const edges = network.edges.filter(e => e.kind !== 'parking');
    if (count && !edges.length) throw new Error('Traffic requires a road edge');
    const totalLength = edges.reduce((sum, edge) => sum + edge.length, 0);
    const phase = this.random();
    for (let i = 0; i < count; i++) {
      // Stratified length-weighted sampling spans the entire graph, not its first N edges.
      const start = (i + phase) * totalLength / count;
      let placed = false;
      for (let attempt = 0; attempt < 256; attempt++) {
        let distance = (start + attempt * 7) % totalLength;
        let edge = edges[edges.length - 1];
        for (const candidate of edges) { if (distance < candidate.length) { edge = candidate; break; } distance -= candidate.length; }
        const s = distance, surface = sampleEdge(edge, s);
        const lanes = Math.max(1, Math.floor(surface.lanes)), lane = (i + attempt) % lanes;
        const candidate = { id: `traffic:${i}`, edgeId: edge.id, s, d: -surface.halfWidth + (lane + .5) * surface.halfWidth * 2 / lanes,
          psi: 0, speed: 10 + this.random() * 6, targetSpeed: 14 + this.random() * 10, length: 4.6, width: 1.8 };
        if (this.clear(candidate)) { this.traffic.push(candidate); placed = true; break; }
      }
      if (!placed) throw new Error('Insufficient clear road surface for requested traffic');
    }
  }

  private random(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  addDriver(id: string, parkingId?: string, physicsId: PhysicsId = 1): NetworkDriver {
    if (this.drivers.has(id) || this.traffic.some(t => t.id === id)) throw new Error(`Duplicate driver: ${id}`);
    const driver = spawnDriver(this.network, id, parkingId, physicsId);
    this.allocateSlot(driver);
    this.drivers.set(id, driver);
    return driver;
  }

  removeDriver(id: string): void { this.drivers.delete(id); }

  private clear(candidate: Footprint, ignoreId?: string): boolean {
    const padded = { ...candidate, length: candidate.length + 3, width: candidate.width + .6 };
    for (const other of this.traffic) if (other.id !== ignoreId && overlaps(this.network, padded, other)) return false;
    for (const other of this.drivers.values()) {
      if (other.id === ignoreId) continue;
      const footprint = { edgeId: other.edgeId, s: other.car.s, d: other.car.d, psi: other.car.psi, length: other.car.tune.length, width: other.car.tune.width };
      if (overlaps(this.network, padded, footprint)) return false;
    }
    return true;
  }

  private allocateSlot(driver: NetworkDriver): void {
    const edge = edgeById(this.network, driver.edgeId), origin = driver.car.s;
    const spacing = driver.car.tune.length + 4;
    for (let i = 0; i <= Math.ceil(edge.length / spacing); i++) {
      for (const direction of i === 0 ? [1] : [-1, 1]) {
        const s = origin + direction * i * spacing;
        if (s < driver.car.tune.length / 2 || s > edge.length - driver.car.tune.length / 2) continue;
        const surface = sampleEdge(edge, s), laneCount = Math.max(1, Math.floor(surface.lanes));
        const offsets = [0, ...Array.from({ length: laneCount }, (_, lane) => -surface.halfWidth + (lane + .5) * 2 * surface.halfWidth / laneCount)];
        for (const d of offsets) {
          if (Math.abs(d) + driver.car.tune.width / 2 > surface.halfWidth) continue;
          const candidate = { edgeId: edge.id, s, d, psi: 0, length: driver.car.tune.length, width: driver.car.tune.width };
          if (!this.clear(candidate, driver.id)) continue;
          driver.car.reset(s, d, 0); syncDriver(driver); return;
        }
      }
    }
    throw new Error(`Parking has no clear spawn slot: ${driver.parkingId}`);
  }

  /** dt is elapsed seconds; inputs are held for every fixed tick consumed by this call. */
  step(dt: number, inputs: Record<string, NetworkInput>): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('dt must be finite and nonnegative');
    this.accumulator += dt;
    while (this.accumulator + 1e-12 >= FIXED_STEP) {
      this.fixedStep(inputs);
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP);
      if (this.accumulator < 1e-12) this.accumulator = 0;
      this.time = ++this.tick * FIXED_STEP;
    }
  }

  private fixedStep(inputs: Record<string, NetworkInput>): void {
    const drivers = [...this.drivers.values()].sort((a, b) => compareIds(a.id, b.id));
    // Reset first: collision rollback and traffic decisions must use the allocated spawn,
    // never the driver's pre-reset location.
    for (const driver of drivers) {
      if (Object.hasOwn(inputs, driver.id) && inputs[driver.id].reset) {
        const replacement = spawnDriver(this.network, driver.id, driver.parkingId, driver.car.physicsId as PhysicsId);
        this.allocateSlot(replacement); Object.assign(driver, replacement);
      }
      syncDriver(driver);
    }
    const occupants: RoadOccupant[] = [...this.traffic.map(t => ({ ...t })), ...drivers.filter(d => !d.car.ghost).map(d => ({
      id: d.id, edgeId: d.edgeId, s: d.car.s, d: d.car.d, psi: d.car.psi, speed: Math.max(0, d.car.vAlong), length: d.car.tune.length, width: d.car.tune.width,
    }))];
    const previous = new Map<string, { edgeId: string; s: number; d: number; psi: number; history?: string[] }>();
    for (const driver of drivers) syncDriver(driver);
    for (const body of [...drivers, ...this.traffic]) previous.set(body.id, { edgeId: body.edgeId, s: body.s, d: body.d, psi: body.psi,
      ...('history' in body ? { history: [...body.history] } : {}) });
    stepTraffic(this.network, this.traffic, occupants, FIXED_STEP);
    for (const driver of drivers) {
      const raw = Object.hasOwn(inputs, driver.id) ? inputs[driver.id] : idle;
      stepDriver(this.network, driver, { steer: bounded(raw.steer, -1, 1), throttle: bounded(raw.throttle, 0, 1), brake: bounded(raw.brake, 0, 1), branch: raw.branch }, FIXED_STEP);
    }
    const bodies: Array<{ body: NetworkDriver | NetworkTraffic; footprint: Footprint }> = [
      ...drivers.filter(d => !d.car.ghost).map(body => ({ body, footprint: { ...body, length: body.car.tune.length, width: body.car.tune.width } })),
      ...this.traffic.map(body => ({ body, footprint: { ...body } })),
    ];
    const hit = new Set<string>();
    const footprints = bodies.map(b => b.footprint), grid = new SurfaceGrid(this.network, footprints, 12);
    const indices = new Map(footprints.map((body, i) => [body, i]));
    const maxRadius = footprints.reduce((r, body) => Math.max(r, Math.hypot(body.length, body.width) / 2), 0);
    for (let i = 0; i < bodies.length; i++) for (const other of grid.nearby(footprints[i], maxRadius * 2)) {
      const j = indices.get(other)!;
      if (j <= i) continue;
      if (overlaps(this.network, footprints[i], other, grid.poses.get(footprints[i]), grid.poses.get(other))) { hit.add(bodies[i].body.id); hit.add(bodies[j].body.id); }
    }
    // Inelastic contact, rolling positions back together to avoid iteration-order impulses.
    for (const { body } of bodies) if (hit.has(body.id)) {
      const old = previous.get(body.id)!;
      body.edgeId = old.edgeId; body.s = old.s; body.d = old.d; body.psi = old.psi; body.speed = 0;
      if ('car' in body) {
        body.car.s = old.s; body.car.d = old.d; body.car.psi = old.psi;
        body.car.vx = body.car.vy = body.car.r = 0;
        body.history = old.history ?? []; syncDriver(body);
      }
    }
  }

  snapshot(): NetworkSnapshot {
    return { version: 1, networkId: this.network.id, time: this.time, tick: this.tick, accumulator: this.accumulator, rng: this.rng,
      drivers: [...this.drivers.values()].sort((a, b) => compareIds(a.id, b.id)).map(d => {
        const state = new Float64Array(d.car.stateSize); d.car.saveState(state);
        return { id: d.id, edgeId: d.edgeId, s: d.car.s, d: d.car.d, psi: d.car.psi, speed: d.car.speed,
          physicsId: d.car.physicsId as PhysicsId, parkingId: d.parkingId, history: [...d.history], state: Array.from(state),
          ...(d.pendingBranch === undefined ? {} : { pendingBranch: d.pendingBranch }),
          controls: { manual: d.car.manual, blinker: d.car.blinker, shiftRefused: d.car.shiftRefused, handbrake: d.car.handbrake, horn: d.car.horn, ghost: d.car.ghost } };
      }), traffic: this.traffic.map(t => ({ ...t })) };
  }

  restore(snapshot: NetworkSnapshot): void {
    if (snapshot.version !== 1 || snapshot.networkId !== this.network.id) throw new Error('Network snapshot mismatch');
    const restored = snapshot.drivers.map(d => {
      const driver = spawnDriver(this.network, d.id, d.parkingId, d.physicsId);
      const car = createCar(d.physicsId);
      edgeById(this.network, d.edgeId);
      if (d.state.length !== car.stateSize || !d.state.every(Number.isFinite)) throw new Error('Invalid car rollback state');
      car.loadState(d.state); Object.assign(car, d.controls);
      return { ...driver, car, edgeId: d.edgeId, s: car.s, d: car.d, psi: car.psi, speed: car.speed, history: [...d.history], pendingBranch: d.pendingBranch };
    });
    for (const traffic of snapshot.traffic) edgeById(this.network, traffic.edgeId);
    this.drivers.clear();
    for (const driver of restored) this.drivers.set(driver.id, driver);
    this.traffic.splice(0, this.traffic.length, ...snapshot.traffic.map(t => ({ ...t })));
    this.tick = snapshot.tick; this.time = snapshot.time; this.accumulator = snapshot.accumulator; this.rng = snapshot.rng;
  }
}
