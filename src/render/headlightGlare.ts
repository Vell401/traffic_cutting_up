import type { Sim } from '../sim/world';

/*
 * Our headlights are real spot lights with inverse-square falloff. That is right for the road, but
 * a car's tail three metres ahead then receives dozens of times the light of the asphalt at thirty,
 * and the whole rear end burns out white as you close in on traffic.
 *
 * A camera (or an eye) would have stopped down. We do the equivalent at the source: each beam is
 * dimmed by the square of the distance to the nearest car inside it, so what falls on that car stays
 * what it was at `reference` metres however close you get. With nothing in the beam it is untouched.
 */

/** Cars farther than this are lit normally; nearer ones get no more light than they would here. */
export const GLARE_REFERENCE = 18;
/** Never fully dark: bumper to bumper the tail is still lit. */
export const GLARE_FLOOR = 0.02;
/** Half-angle of the part of the beam that matters, as lateral metres per metre ahead. */
const SPREAD = 0.55;
const LOOK_AHEAD = 60;

/** Share of a beam's output to keep when the nearest lit surface is `gap` metres from the lamp. */
export function beamScale(gap: number, reference = GLARE_REFERENCE): number {
  if (!(gap < reference)) return 1;
  const k = Math.max(gap, 0) / reference;
  return Math.max(GLARE_FLOOR, k * k);
}

/**
 * Distance from a headlamp at (s, lampD), `nose` metres ahead of our car's centre, to the nearest
 * surface of a car inside its beam; Infinity when the beam is clear.
 */
export function beamGap(sim: Sim, s: number, lampD: number, nose: number): number {
  let nearest = Infinity;
  const consider = (otherS: number, otherD: number, len: number, wid: number): void => {
    const ahead = sim.road.rel(otherS, s) - len / 2 - nose;
    if (ahead < -1 || ahead > LOOK_AHEAD) return;
    const along = Math.max(ahead, 0);
    const across = Math.max(Math.abs(otherD - lampD) - wid / 2, 0);
    if (across > 0.8 + along * SPREAD) return;
    const gap = Math.hypot(along, across);
    if (gap < nearest) nearest = gap;
  };
  for (const car of sim.traffic.cars) if (car.active) consider(car.s, car.d, car.spec.len, car.spec.wid);
  for (const remote of sim.remotes) if (remote.visible) consider(remote.car.s, remote.car.d, remote.car.tune.length, remote.car.tune.width);
  return nearest;
}
