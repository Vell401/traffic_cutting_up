import { describe, expect, it } from 'vitest';
import { NetworkSession, FIXED_STEP, pose } from '../src/network/session';
import { applySurfaceBounds, chooseExit, orderedExits, overlaps, SurfaceGrid, syncDriver } from '../src/network/driving';
import { createPrototypeNetwork, createBayNetwork } from '../src/network/layout';
import { forwardDistance, stepTraffic, type NetworkTraffic } from '../src/network/traffic';
import { sampleEdge, validateNetwork, type NetworkEdge, type RoadNetwork } from '../src/network/geometry';
import { createCar, type PhysicsId } from '../src/sim/physics';
import { DriftCar } from '../src/sim/vehicleDrift';

const idle = { steer: 0, throttle: 0, brake: 0 };
const point = (x: number, z: number, y = 0) => ({ x, y, z });
function fixture(): RoadNetwork {
  const nodes = [
    { id: 'a', position: point(0, 0) }, { id: 'b', position: point(0, -100) },
    { id: 'c', position: point(0, -200) }, { id: 'l', position: point(-60, -180) },
    { id: 'r', position: point(60, -180) },
    { id: 'u', position: point(-50, -50, 8) }, { id: 'v', position: point(50, -50, 8) },
  ];
  const edge = (id: string, from: string, to: string): NetworkEdge => {
    const a = nodes.find(n => n.id === from)!.position, b = nodes.find(n => n.id === to)!.position;
    return { id, from, to, points: [a, b], lanes: 2, width: 12, kind: 'road', route: 'test', length: Math.hypot(b.x - a.x, b.z - a.z) };
  };
  // Every arm and the elevated deck has real return access. Connections are far from
  // the measured seam/crossing, so they cannot masquerade as a crossing junction.
  return { id: 'test', nodes, edges: [edge('in', 'a', 'b'), edge('straight', 'b', 'c'), edge('left', 'b', 'l'), edge('right', 'b', 'r'), edge('return', 'c', 'b'), edge('upper', 'u', 'v'),
    edge('left-return', 'l', 'c'), edge('right-return', 'r', 'c'), edge('home', 'c', 'a'), edge('upper-access', 'c', 'u'), edge('upper-return', 'v', 'a')],
    parkings: [{ id: 'spawn', name: 'Spawn', edgeId: 'in', s: 10 }] };
}
function session(): NetworkSession { return new NetworkSession(fixture(), { trafficCount: 0 }); }
function traffic(id: string, edgeId: string, s: number, speed = 12): NetworkTraffic {
  return { id, edgeId, s, d: 0, psi: 0, speed, targetSpeed: 20, length: 4.6, width: 1.8 };
}

describe('shared network backend', () => {
  it('orders authored ramp divergence downstream and keeps neutral on the same route', () => {
    for (const network of [createPrototypeNetwork(), createBayNetwork()]) {
      let splits = 0;
      for (const edge of network.edges) {
        const exits = orderedExits(network, edge);
        if (exits.length < 2) continue;
        splits++;
        expect(chooseExit(network, edge, { ...idle, steer: -1 })?.id).toBe(exits[0].id);
        expect(chooseExit(network, edge, { ...idle, steer: 1 })?.id).toBe(exits[exits.length - 1].id);
        if (exits.some(exit => exit.route === edge.route)) expect(chooseExit(network, edge, idle)?.route).toBe(edge.route);
        const origin = sampleEdge(edge, edge.length);
        const lateral = exits.map(exit => {
          const ahead = sampleEdge(exit, Math.min(120, exit.length));
          return Math.atan2(Math.sin(Math.atan2(ahead.x - origin.x, origin.z - ahead.z) - origin.heading),
            Math.cos(Math.atan2(ahead.x - origin.x, origin.z - ahead.z) - origin.heading));
        });
        expect(lateral).toEqual([...lateral].sort((a, b) => a - b));
      }
      expect(splits).toBeGreaterThan(0);
    }
  });

  it('allocates clear deterministic slots for shared parking and reset without ghost deadlock', () => {
    const a = session(), b = session();
    for (const sim of [a, b]) {
      const first = sim.addDriver('first'), second = sim.addDriver('second');
      const footprint = (driver: typeof first) => ({ ...driver, length: driver.car.tune.length, width: driver.car.tune.width });
      expect(overlaps(sim.network, footprint(first), footprint(second))).toBe(false);
      expect(first.car.ghost || second.car.ghost).toBe(false);
      second.car.reset(70, 0, 0);
      sim.step(FIXED_STEP, { second: { ...idle, reset: true } });
      expect(second.s).not.toBe(70);
      expect(overlaps(sim.network, footprint(first), footprint(second))).toBe(false);
      for (let i = 0; i < 40; i++) sim.step(FIXED_STEP, { second: { ...idle, throttle: 1 } });
      expect(second.speed).toBeGreaterThan(0);
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('samples traffic across complete authored networks with no initial world footprint overlaps', () => {
    for (const network of [createPrototypeNetwork(), createBayNetwork()]) {
      const sim = new NetworkSession(network, { trafficCount: 100, seed: 42 });
      const byId = new Map(network.edges.map(e => [e.id, e]));
      const routes = new Set(sim.traffic.map(t => byId.get(t.edgeId)!.route));
      if (network.id === 'bay') {
        for (const route of ['R0', 'C1', 'C2', 'S1', 'S2', 'S3']) expect(routes.has(route), route).toBe(true);
      } else {
        expect(routes.has('prototype')).toBe(true);
      }
      const edgePositions = sim.traffic.map(t => network.edges.findIndex(e => e.id === t.edgeId));
      expect(Math.max(...edgePositions)).toBeGreaterThan(network.edges.length / 2);
      for (let i = 0; i < sim.traffic.length; i++) for (let j = i + 1; j < sim.traffic.length; j++)
        expect(overlaps(network, sim.traffic[i], sim.traffic[j])).toBe(false);
    }
  });

  it('broadphase retains seam neighbours and rejects distant traffic without all-pairs scans', () => {
    const network = fixture(), near = traffic('near', 'in', 99), across = traffic('seam', 'straight', 1);
    const far = traffic('far', 'straight', 90), above = traffic('above', 'upper', 50);
    const grid = new SurfaceGrid(network, [near, across, far, above], 12);
    expect(grid.nearby(near, 6)).toContain(across);
    expect(grid.nearby(near, 6)).not.toContain(far);
    expect(grid.nearby(near, 6)).not.toContain(above);
    expect(grid.poses.size).toBe(4);
  });
  it('uses a genuinely strongly connected fixture without relaxing layout validation', () => {
    expect(validateNetwork(fixture())).toEqual([]);
  });
  it('spawns in parking, supports every factory profile, and leaves legacy forces unchanged', () => {
    for (const physicsId of [1, 2, 3, 4, 5] as PhysicsId[]) {
      const sim = session(), driver = sim.addDriver('p', 'spawn', physicsId), legacy = createCar(physicsId);
      legacy.reset(10, 0, 0);
      const input = { steer: 0, throttle: .65, brake: 0 };
      for (let i = 0; i < 90; i++) { sim.step(FIXED_STEP, { p: input }); legacy.step(FIXED_STEP, input, 0); }
      const a = new Float64Array(legacy.stateSize), b = new Float64Array(driver.car.stateSize);
      legacy.saveState(a); driver.car.saveState(b);
      expect(Array.from(b)).toEqual(Array.from(a));
      expect(driver.car.physicsId).toBe(physicsId);
      expect(driver.parkingId).toBe('spawn');
    }
  });

  it('inherited optional bounds reach both R34 and Drift overriding steps without tuning edits', () => {
    for (const car of [createCar(2), new DriftCar()]) {
      car.reset(0, 8, 0); applySurfaceBounds(car, 10);
      car.step(FIXED_STEP, idle, 0);
      expect(car.d).toBe(8);
      applySurfaceBounds(car, 4);
      car.step(FIXED_STEP, idle, 0);
      expect(Math.abs(car.d) + car.halfExtentD()).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('preserves world position, heading, body velocity, and overshoot at a straight seam', () => {
    const sim = session(), driver = sim.addDriver('p');
    driver.car.reset(99.9, 1.7, 24); driver.car.psi = .03; syncDriver(driver);
    const legacy = createCar(1); legacy.reset(99.9, 1.7, 24); legacy.psi = .03;
    legacy.step(FIXED_STEP, idle, 0);
    sim.step(FIXED_STEP, { p: idle });
    expect(driver.edgeId).toBe('straight');
    expect(driver.s).toBeCloseTo(legacy.s - 100, 10);
    expect(driver.d).toBeCloseTo(legacy.d, 10);
    expect(pose(sim.network, driver).heading).toBeCloseTo(legacy.psi, 10);
    expect(driver.car.vx).toBe(legacy.vx); expect(driver.car.vy).toBe(legacy.vy);
  });

  it('steering and explicit branch requests select different real fork arms without pose teleport', () => {
    for (const [steer, expected] of [[-1, 'left'], [1, 'right']] as const) {
      const sim = session(), driver = sim.addDriver('p');
      driver.car.reset(99.98, 0, 12); syncDriver(driver);
      const before = pose(sim.network, driver);
      sim.step(FIXED_STEP, { p: { ...idle, steer } });
      const after = pose(sim.network, driver);
      expect(driver.edgeId).toBe(expected);
      expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(.2);
      expect(Math.abs(after.heading - before.heading)).toBeLessThan(.01);
    }
    const sim = session(), driver = sim.addDriver('p'); driver.car.reset(99.98, 0, 12);
    sim.step(FIXED_STEP, { p: { ...idle, branch: 0 } }); expect(driver.edgeId).toBe('left');
  });

  it('reverses only through the actual recorded entry, not a guessed incoming merge', () => {
    const sim = session(), driver = sim.addDriver('p'); driver.car.reset(99.98, 0, 12);
    sim.step(FIXED_STEP, { p: idle }); expect(driver.edgeId).toBe('straight');
    driver.car.s = .01; driver.car.vx = -4; driver.car.gear = 0;
    sim.step(FIXED_STEP, { p: { ...idle, throttle: 1 } });
    expect(driver.edgeId).toBe('in'); expect(driver.s).toBeLessThan(100); expect(driver.history).toEqual([]);
    driver.edgeId = 'straight'; driver.history = []; driver.car.s = .001; driver.car.vx = -4;
    sim.step(FIXED_STEP, { p: { ...idle, throttle: 1 } });
    expect(driver.edgeId).toBe('straight'); expect(driver.s).toBe(0);
  });

  it('enforces tapered surface width rather than a legacy global road width', () => {
    const sim = session(), driver = sim.addDriver('p');
    const edge = sim.network.edges[0]; edge.endLanes = 1; delete edge.width;
    driver.car.reset(99, 5.5, 0);
    sim.step(FIXED_STEP, { p: idle });
    expect(Math.abs(driver.d) + driver.car.halfExtentD()).toBeLessThanOrEqual(sampleEdge(edge, 99).halfWidth + 1e-6);
  });

  it('replays JSON snapshots exactly including all profile rollback state and fractional time', () => {
    for (const physics of [1, 2, 3, 4, 5] as PhysicsId[]) {
      const a = session(); a.addDriver('p', undefined, physics);
      for (let i = 0; i < 25; i++) a.step(.013, { p: { steer: .1, throttle: .7, brake: 0 } });
      const state = JSON.parse(JSON.stringify(a.snapshot()));
      const b = new NetworkSession(a.network, { trafficCount: 0, seed: 99 }); b.restore(state);
      expect(b.snapshot()).toEqual(state);
      for (let i = 0; i < 40; i++) {
        const inputs = { p: { steer: i % 2 ? -.2 : .2, throttle: .5, brake: 0 } };
        a.step(.011, inputs); b.step(.011, inputs);
      }
      expect(b.snapshot()).toEqual(a.snapshot());
    }
  });

  it('uses identical fixed ticks for batched and individual calls', () => {
    const a = session(), b = session(); a.addDriver('p'); b.addDriver('p');
    const inputs = { p: { ...idle, throttle: 1 } };
    a.step(1, inputs); for (let i = 0; i < 120; i++) b.step(FIXED_STEP, inputs);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(() => a.step(NaN, {})).toThrow();
    expect(() => b.restore({ ...a.snapshot(), networkId: 'different' })).toThrow();
  });

  it('tests world OBB contacts across seams but separates vertically stacked crossing surfaces', () => {
    const net = fixture();
    const a = { edgeId: 'in', s: 99, d: 0, psi: 0, length: 4.6, width: 1.8 };
    expect(overlaps(net, a, { ...a, edgeId: 'straight', s: 1 })).toBe(true);
    expect(overlaps(net, { ...a, s: 50 }, { ...a, edgeId: 'upper', s: 50 })).toBe(false);
    const sim = new NetworkSession(net, { trafficCount: 0 }), driver = sim.addDriver('p');
    driver.car.reset(50, 0, 10); sim.traffic.push(traffic('above', 'upper', 50, 0));
    sim.step(FIXED_STEP, { p: idle }); expect(driver.speed).toBeGreaterThan(9);
    sim.traffic.splice(0, 1, traffic('ahead', 'in', driver.s + 2, 0));
    sim.step(FIXED_STEP, { p: idle }); expect(driver.speed).toBe(0);
  });

  it('follows beyond seams, yields at merges, and ignores disconnected crossing decks', () => {
    const net = fixture();
    expect(forwardDistance(net, traffic('a', 'in', 95), traffic('b', 'straight', 5))).toBe(10);
    expect(forwardDistance(net, traffic('a', 'in', 50), traffic('b', 'upper', 50))).toBe(Infinity);
    const follower = traffic('f', 'in', 95), leader = traffic('l', 'straight', 5, 0);
    stepTraffic(net, [follower], [follower, leader], FIXED_STEP); expect(follower.speed).toBeLessThan(12);
    const free = traffic('f', 'in', 50), above = traffic('above', 'upper', 50, 0);
    stepTraffic(net, [free], [free, above], FIXED_STEP); expect(free.speed).toBeGreaterThan(12);
    net.nodes = net.nodes.filter(n => n.id !== 'l' && n.id !== 'r');
    net.edges = net.edges.filter(e => !['left', 'right', 'left-return', 'right-return'].includes(e.id));
    expect(validateNetwork(net)).toEqual([]);
    const merge = traffic('z', 'return', 85), priority = traffic('a', 'in', 85);
    for (let i = 0; i < 120; i++) stepTraffic(net, [merge], [merge, priority], FIXED_STEP);
    expect(merge.speed).toBeLessThan(12);
  });

  it('seeds directed-edge traffic deterministically and snapshots it without shared references', () => {
    const a = new NetworkSession(fixture(), { trafficCount: 12, seed: 42 });
    const b = new NetworkSession(fixture(), { trafficCount: 12, seed: 42 });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.traffic.some(t => t.edgeId === 'return')).toBe(true);
    const snapshot = a.snapshot(); a.step(.2, {});
    b.restore(snapshot); b.step(.2, {}); expect(a.snapshot()).toEqual(b.snapshot());
    snapshot.traffic[0].s = -100; expect(b.traffic[0].s).not.toBe(-100);
  });

  it('removes drivers and resets to the selected parking', () => {
    const sim = session(), driver = sim.addDriver('p'); driver.car.reset(50, 2, 10);
    sim.step(FIXED_STEP, { p: { ...idle, reset: true } }); expect(driver.s).toBe(10);
    sim.removeDriver('p'); expect(sim.drivers.size).toBe(0);
  });
});
