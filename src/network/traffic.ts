import { edgeById, sampleEdge, type RoadNetwork } from './geometry';
import { terminalAddress } from './boundaries';
import { adjoining, movementBounds } from './junctions';
import { angle, chooseExit, networkIndex, SurfaceGrid, project, type NetworkAddress } from './driving';

export interface NetworkTraffic extends NetworkAddress {
  id: string; speed: number; targetSpeed: number; length: number; width: number;
}
export interface RoadOccupant extends NetworkAddress { id: string; speed: number; length: number; width: number }

function reachableEdges(network: RoadNetwork, a: NetworkAddress, limit: number): Map<string, number> {
  const index = networkIndex(network), start = index.edges.get(a.edgeId)!;
  const queue = (index.exits.get(start.id) ?? []).map(e => ({ id: e.id, distance: start.length - a.s }));
  const visited = new Map<string, number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    if (item.distance > limit || item.distance >= (visited.get(item.id) ?? Infinity)) continue;
    visited.set(item.id, item.distance);
    const edge = index.edges.get(item.id)!;
    for (const next of index.exits.get(edge.id) ?? []) queue.push({ id: next.id, distance: item.distance + edge.length });
  }
  return visited;
}

/** Distance through directed topology, not a global s or proximity to an unrelated overpass. */
export function forwardDistance(network: RoadNetwork, a: NetworkAddress, b: NetworkAddress, limit = 100): number {
  if (a.edgeId === b.edgeId && b.s >= a.s) return b.s - a.s;
  const best = (reachableEdges(network, a, limit).get(b.edgeId) ?? Infinity) + b.s;
  return best <= limit ? best : Infinity;
}

/** All decisions use the same pre-step occupants: array iteration order cannot change yielding. */
export function stepTraffic(network: RoadNetwork, traffic: NetworkTraffic[], occupants: RoadOccupant[], dt: number): void {
  const grid = new SurfaceGrid(network, occupants, 64);
  const byId = new Map(occupants.map(o => [o.id, o]));
  const decisions = traffic.map(car => {
    let desired = car.targetSpeed;
    const edge = edgeById(network, car.edgeId);
    const exit = chooseExit(network, edge, { steer: 0, throttle: 0, brake: 0 });
    const remaining = edge.length - car.s;
    if (!exit) desired = Math.min(desired, Math.sqrt(2 * 5 * Math.max(0, remaining - car.length / 2)));
    const occupant = byId.get(car.id);
    const candidates = occupant ? grid.nearby(occupant, 105) : occupants;
    const reachable = reachableEdges(network, car, 100);
    for (const other of candidates) {
      if (other.id === car.id) continue;
      const distance = car.edgeId === other.edgeId && other.s >= car.s ? other.s - car.s : (reachable.get(other.edgeId) ?? Infinity) + other.s;
      // Lane offsets on directed edges describe independent travel corridors. At seams the
      // world lateral test below allows shifted centres and excludes neighbouring lanes.
      const p = occupant ? grid.poses.get(occupant)! : sampleEdge(edge, car.s, car.d), q = grid.poses.get(other)!;
      const lateral = Math.abs((q.x - p.x) * Math.cos(p.heading) + (q.z - p.z) * Math.sin(p.heading));
      const sameLane = car.edgeId === other.edgeId ? Math.abs(car.d - other.d) < (car.width + other.width) / 2 + .5
        : lateral < (car.width + other.width) / 2 + 1 || Math.abs(car.d - other.d) < .5;
      if (distance > 0 && distance < 100 && sameLane) {
        const gap = distance - (car.length + other.length) / 2 - 3;
        desired = Math.min(desired, Math.max(0, Math.min(gap / 1.4, other.speed + (gap - car.speed * 1.4) * .6)));
      }
      const otherEdge = edgeById(network, other.edgeId);
      if (otherEdge.id === edge.id || !exit || remaining > 50) continue;
      const otherExit = chooseExit(network, otherEdge, { steer: 0, throttle: 0, brake: 0 });
      if (otherExit?.id !== exit.id) continue;
      const otherRemaining = otherEdge.length - other.s;
      // Earliest arrival has priority; stable ID breaks simultaneous merge ties.
      const eta = remaining / Math.max(car.speed, 3), otherEta = otherRemaining / Math.max(other.speed, 3);
      if (otherRemaining < 50 && (otherEta < eta - .5 || Math.abs(otherEta - eta) <= .5 && other.id < car.id)) {
        desired = Math.min(desired, Math.sqrt(2 * 5 * Math.max(0, remaining - car.length / 2 - 4)));
      }
    }
    return Math.max(0, desired);
  });
  for (let i = 0; i < traffic.length; i++) {
    const car = traffic[i];
    car.speed += Math.max(-6 * dt, Math.min(2 * dt, decisions[i] - car.speed));
    car.s += car.speed * dt;
    let edge = edgeById(network, car.edgeId);
    let entryEdge: typeof edge | undefined;
    if (network.openBoundaries && !chooseExit(network, edge, { steer: 0, throttle: 0, brake: 0 })) {
      const limit = terminalAddress(edge.length, car.length, car.width, car.psi);
      if (car.s > limit) { car.s = limit; car.speed = 0; }
    }
    for (let hop = 0; hop < 64 && car.s > edge.length; hop++) {
      const next = chooseExit(network, edge, { steer: 0, throttle: 0, brake: 0 });
      if (!next) { car.s = network.openBoundaries ? terminalAddress(edge.length, car.length, car.width, car.psi) : edge.length; car.speed = 0; break; }
      const old = sampleEdge(edge, edge.length, car.d), excess = car.s - edge.length;
      const world = { x: old.x + Math.sin(old.heading) * excess, y: old.y + old.grade * excess, z: old.z - Math.cos(old.heading) * excess };
      const target = project(next, world), entry = sampleEdge(next, target.s);
      if (!adjoining(edge, next) || Math.abs(entry.y - world.y) > 1 || Math.abs(target.d) > entry.halfWidth) { car.s = network.openBoundaries ? terminalAddress(edge.length, car.length, car.width, car.psi) : edge.length; car.speed = 0; break; }
      car.s = target.s; car.d = target.d;
      car.psi = angle(old.heading + car.psi - entry.heading);
      car.edgeId = next.id; entryEdge = edge; edge = next;
    }
    const surface = sampleEdge(edge, car.s);
    const exit = chooseExit(network, edge, { steer: 0, throttle: 0, brake: 0 });
    const neighbors = network.openBoundaries ? [
      ...(exit && adjoining(edge, exit) && edge.length - car.s < 60 ? [exit] : []),
      ...(entryEdge && car.s < 60 ? [entryEdge] : []),
    ] : [];
    const bounds = neighbors.length ? movementBounds(edge, car.s, neighbors, car.length / 2)
      : { min: -surface.halfWidth, max: surface.halfWidth };
    const minD = Math.min(0, bounds.min + car.width / 2), maxD = Math.max(0, bounds.max - car.width / 2);
    car.d = Math.max(minD, Math.min(maxD, car.d));
    // Traffic follows the directed surface; opposing travel lives on a separate edge.
    car.psi *= Math.max(0, 1 - dt * 4);
  }
}
