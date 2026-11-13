import { describe, expect, it } from 'vitest';
import { movementBounds } from '../src/network/junctions';
import { orderedExits, pose, spawnDriver, stepDriver } from '../src/network/driving';
import { type NetworkEdge, type RoadNetwork } from '../src/network/geometry';

const idle = { steer: 0, throttle: 0, brake: 0 };
const point = (x: number, z: number, y = 0) => ({ x, y, z });
function fixture(): RoadNetwork {
  const edge = (id: string, from: string, to: string, a: ReturnType<typeof point>, b: ReturnType<typeof point>): NetworkEdge =>
    ({ id, from, to, points: [a, b], width: 8, lanes: 1, route: 'main', kind: 'road', length: Math.hypot(a.x - b.x, a.z - b.z) });
  return { id: 'junction', openBoundaries: true, nodes: [], parkings: [{ id: 'p', name: 'p', edgeId: 'in', s: 90 }], edges: [
    edge('in', 'a', 'b', point(0, 0), point(0, -100)),
    edge('branch', 'b', 'c', point(0, -100), point(60, -180)),
    edge('reverse', 'b', 'a', point(0, -100), point(0, 0)),
    edge('unrelated', 'd', 'e', point(7, 0), point(7, -100)),
    edge('upper', 'b', 'f', point(0, -100, 8), point(60, -180, 8)),
  ] };
}

describe('movement-local open junction surfaces', () => {
  it('opens only the actual adjoining ribbon and keeps the opposite outer wall', () => {
    const net = fixture(), [incoming, branch] = net.edges;
    incoming.width = 12;
    const bounds = movementBounds(branch, .5, [incoming], 2.3);
    expect(bounds.max).toBeGreaterThan(4);
    expect(bounds.min).toBe(-4);
    expect(movementBounds(branch, 50, [incoming], 2.3)).toEqual({ min: -4, max: 4 });
    expect(movementBounds(incoming, 50, [], 2.3)).toEqual({ min: -6, max: 6 });
    expect(movementBounds(incoming, 99, [net.edges[4]], 2.3)).toEqual({ min: -6, max: 6 });
  });

  it('lets a finite-width body straddle a merge seam without an internal wall impulse', () => {
    const net = fixture(), driver = spawnDriver(net, 'p');
    net.edges[0].width = 12;
    driver.edgeId = 'branch'; driver.history = ['in'];
    driver.car.reset(.5, 3.4, 0);
    const before = pose(net, { ...driver, s: .5, d: 3.4 });
    stepDriver(net, driver, idle, 1 / 120);
    expect(driver.car.wallSide).toBe(0);
    expect(driver.car.wallImpact).toBe(0);
    expect(Math.hypot(pose(net, driver).x - before.x, pose(net, driver).z - before.z)).toBeLessThan(.01);
  });

  it('keeps nearby unrelated roads inaccessible and closed networks retain their wall', () => {
    for (const open of [true, false]) {
      const net = fixture(); net.openBoundaries = open;
      const driver = spawnDriver(net, 'p'); driver.car.reset(50, 4, 0);
      stepDriver(net, driver, idle, 1 / 120);
      expect(driver.edgeId).toBe('in');
      expect(driver.d + driver.car.halfExtentD()).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('allows a finite car through a selected split while retaining the exterior edge', () => {
    const net = fixture(), driver = spawnDriver(net, 'p');
    net.edges[1].width = 12;
    // At 99 m the rear cross-section is still behind the branch's diagonal
    // end cap: its asphalt is separated from the incoming verge by a gap.
    // Move the whole finite body into the genuinely connected throat first.
    const bounds = movementBounds(net.edges[0], 99.8, [net.edges[1]], 2.3);
    expect(bounds.max).toBeGreaterThan(4);
    driver.car.reset(99.8, 3.3, 0);
    stepDriver(net, driver, { ...idle, branch: 0 }, 1 / 120);
    expect(driver.car.wallSide).toBe(0);
    expect(driver.car.wallImpact).toBe(0);
    driver.edgeId = 'in'; driver.history = []; driver.car.reset(80, 5, 0);
    stepDriver(net, driver, idle, 1 / 120);
    expect(driver.d + driver.car.halfExtentD()).toBeLessThanOrEqual(4 + 1e-9);
  });

  it('filters false immediate U-turns but preserves recorded physical reversing', () => {
    const net = fixture(), driver = spawnDriver(net, 'p');
    expect(orderedExits(net, 'in').map(e => e.id)).not.toContain('reverse');
    driver.car.reset(99.99, 0, 6);
    stepDriver(net, driver, idle, 1 / 120);
    expect(driver.edgeId).toBe('branch');
    driver.car.s = .001; driver.car.vx = -4; driver.car.gear = 0;
    stepDriver(net, driver, { ...idle, throttle: 1 }, 1 / 120);
    expect(driver.edgeId).toBe('in');
    expect(driver.history).toEqual([]);
  });
});
