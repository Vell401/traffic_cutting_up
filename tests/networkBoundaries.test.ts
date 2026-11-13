import { describe, expect, it } from 'vitest';
import { terminalAddress } from '../src/network/boundaries';
import { NetworkSession } from '../src/network/session';
import type { RoadNetwork } from '../src/network/geometry';

describe('open network terminal footprint', () => {
  it('accounts for length, orientation and short edges', () => {
    expect(terminalAddress(100, 4, 2, 0)).toBeCloseTo(97.9);
    expect(terminalAddress(100, 4, 2, Math.PI / 2)).toBeCloseTo(98.9);
    expect(terminalAddress(1, 4, 2, 0)).toBe(.5);
    expect(terminalAddress(100, 4, 2, 0, false)).toBeCloseTo(2.1);
  });
  it('stops a player footprint within an actual terminal and allows reverse', () => {
    const points = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -100 }];
    const network: RoadNetwork = { id: 'open-test', openBoundaries: true,
      nodes: [{ id: 'a', position: points[0] }, { id: 'b', position: points[1] }],
      edges: [{ id: 'road', from: 'a', to: 'b', points, lanes: 2, kind: 'road', route: 'road', length: 100 }],
      parkings: [{ id: 'start', name: 'start', edgeId: 'road', s: 90 }] };
    const session = new NetworkSession(network, { trafficCount: 0 });
    const player = session.addDriver('p');
    player.car.reset(96, 0, 0); player.car.setRoadVelocity(30, 0);
    session.step(.2, { p: { throttle: 1, steer: 0, brake: 0 } });
    expect(player.car.s).toBeLessThanOrEqual(terminalAddress(100, player.car.tune.length, player.car.tune.width, player.car.psi) + .001);
    const stoppedAt = player.car.s;
    player.car.setRoadVelocity(-3, 0); player.car.gear = 0;
    session.step(.1, { p: { throttle: 1, steer: 0, brake: 0 } });
    expect(player.car.s).toBeLessThan(stoppedAt);
  });
});
