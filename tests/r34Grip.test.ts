import { describe, expect, it } from 'vitest';
import { type DriveInput } from '../src/sim/vehicle';
import { R34Car, r34Tune, type R34Tune } from '../src/sim/vehicleR34';

const DT = 1 / 120;
const DEG = 180 / Math.PI;
// Counterfactual changes ONLY the three grip defaults, not steering, torque, inertia,
// slip curves, gears or the solver. Keep the old values explicit for before/after checks.
const oldTune = (): R34Tune => ({ ...structuredClone(r34Tune), gripFront: 1.16, gripRear: .93, longGrip: 1.04 });
const car = (old = false, kmh = 90): R34Car => {
  const c = new R34Car(old ? oldTune() : structuredClone(r34Tune));
  c.reset(0, 0, kmh / 3.6);
  return c;
};
const input = (steer = 0, throttle = 0, brake = 0): DriveInput => ({ steer, throttle, brake });
const beta = (c: R34Car) => Math.abs(Math.atan2(c.vy, c.vx)) * DEG;

/** Infinite flat pad: only position is rebased. Commands depend on time, never state.
 * Settled means the LAST excursion beyond 2 degrees/.03 rad/s, not a first crossing.
 * Stopping is observed, not implemented by a velocity edit or a reverse-gear request. */
function measure(c: R34Car, seconds: number, command: (tick: number) => DriveInput) {
  let distance = 0, lateralTravel = 0, betaSeconds = 0, peakBeta = 0, settled = 0;
  let stopSeconds: number | null = null, stopDistance: number | null = null;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    c.d = c.prevD = 0;
    c.step(DT, command(i), 0);
    distance += Math.hypot(c.s - c.prevS, c.d);
    lateralTravel += Math.abs(c.vy) * DT;
    betaSeconds += beta(c) * DT;
    peakBeta = Math.max(peakBeta, beta(c));
    if (beta(c) > 2 || Math.abs(c.r) > .03) settled = (i + 1) * DT;
    if (stopSeconds === null && c.speed < .5) {
      stopSeconds = (i + 1) * DT;
      stopDistance = distance;
    }
    expect(c.wallSide).toBe(0);
    expect(Number.isFinite(c.speed + c.r + c.steerAngle)).toBe(true);
  }
  return { distance, lateralTravel, betaSeconds, peakBeta, settled, stopSeconds, stopDistance };
}

describe('R34 higher-grip defaults: contact forces and fixed-input comparisons', () => {
  it.each([-1, 1])('increases both loaded axle forces opposing the same lateral slip, side %s', sign => {
    const old = car(true), current = car();
    for (const c of [old, current]) {
      c.vy = sign * 6;
      c.axLag = 3; c.ayLag = sign * 4;
      const before = c.vLat;
      c.step(.0001, { ...input(), direct: true }, 0);
      expect(c.forceFront * sign).toBeLessThan(0);
      expect(c.forceRear * sign).toBeLessThan(0);
      // The measured restoring impulse is exactly the reported contact force, not damping.
      expect((c.vLat - before) / .0001).toBeCloseTo((c.forceFront + c.forceRear) / c.tune.mass, 8);
    }
    expect(current.loadFront).toBe(old.loadFront);
    expect(current.loadRear).toBe(old.loadRear);
    expect(Math.abs(current.forceFront)).toBeGreaterThan(Math.abs(old.forceFront) * 1.04);
    expect(Math.abs(current.forceRear)).toBeGreaterThan(Math.abs(old.forceRear) * 1.12);
  });

  it.each([[0, 0], [3, 4], [-4, -5]])('increases actual longitudinal contact capacity at load transfer %s/%s', (ax, ay) => {
    const old = car(true), current = car();
    for (const c of [old, current]) {
      c.tune.aeroDrag = c.tune.rollingRes = 0;
      c.gear = -1; c.axLag = ax; c.ayLag = ay;
      // Identical pre-existing wheel slip, disconnected crank: no engine can explain the gain.
      for (let i = 0; i < 4; i++) c.omega[i] *= 1.14;
      c.step(.00001, { ...input(), manual: true, direct: true }, 0);
      expect((c.vAlong - 25) / .00001).toBeCloseTo(c.accLong, 7);
    }
    expect(current.loadFront).toBe(old.loadFront);
    expect(current.loadRear).toBe(old.loadRear);
    expect(current.accLong).toBeGreaterThan(old.accLong * 1.1);
  });

  it.each([false, true])('passively restores the same lateral impulse without driver feedback (fixed rack=%s)', direct => {
    const results = [true, false].map(old => {
      const c = car(old);
      c.vy = -6; // Same initial disturbance; no body-state edits after the run starts.
      return measure(c, 4, () => ({ ...input(), direct }));
    });
    const [old, current] = results;
    expect(current.lateralTravel).toBeLessThan(old.lateralTravel * .95);
    expect(current.betaSeconds).toBeLessThan(old.betaSeconds * .95);
    expect(current.settled).toBeLessThan(old.settled);
    expect(current.settled).toBeLessThan(1.5);
    console.table(results.map((r, i) => ({ tune: i ? 'higher grip' : 'old', direct, ...r })));
  });

  it.each([60, 90, 120])('short human entry/lift slides less and settles sooner at %s km/h', kmh => {
    // Keep the ORIGINAL .5 s entry, W until 1.5 s, then coast. No longer-entry
    // recalibration here: this comparison must demonstrate the user's extra usable grip.
    const results = [true, false].map(old => measure(car(old, kmh), 6,
      i => input(i < 60 ? 1 : 0, i < 180 ? 1 : 0)));
    const [old, current] = results;
    expect(current.peakBeta).toBeLessThan(old.peakBeta * .6);
    expect(current.betaSeconds).toBeLessThan(old.betaSeconds * .3);
    expect(current.settled).toBeLessThan(old.settled * .8);
    expect(current.settled).toBeLessThan(2.2);
    console.table(results.map((r, i) => ({ tune: i ? 'higher grip' : 'old', kmh, ...r })));
  });

  it.each([-1, 1])('recovers an identical established slide sooner after lift, side %s', sign => {
    const seed = car(true);
    measure(seed, 1, i => input(i < 60 ? sign : 0, 1));
    const snapshot = new Float64Array(seed.stateSize);
    seed.saveState(snapshot);
    const results = [true, false].map(old => {
      const c = car(old);
      c.loadState(snapshot);
      expect(c.stateSize).toBe(58);
      expect(c.stateSize).toBeLessThanOrEqual(64);
      const startingBeta = beta(c);
      const metrics = measure(c, 4, () => input());
      expect(metrics.peakBeta).toBeGreaterThan(startingBeta * .9); // Inertia, no instant catch.
      expect(beta(c)).toBeLessThan(.1);
      expect(Math.abs(c.r)).toBeLessThan(.01);
      expect(c.psi * sign).toBeGreaterThan(.2); // No road-heading restoration.
      return metrics;
    });
    const [old, current] = results;
    expect(current.settled).toBeLessThan(old.settled * .95);
    expect(current.lateralTravel).toBeLessThan(old.lateralTravel * .85);
    expect(current.betaSeconds).toBeLessThan(old.betaSeconds * .85);
    console.table(results.map((r, i) => ({ tune: i ? 'higher grip' : 'old', sign, ...r })));
  });

  it('shortens tyre-limited braking without turning straight coasting into artificial friction', () => {
    const stopped = [true, false].map(old => measure(car(old), 4,
      () => ({ ...input(0, 0, 1), manual: true })));
    const [old, current] = stopped;
    expect(current.stopDistance).not.toBeNull(); expect(old.stopDistance).not.toBeNull();
    expect(current.stopSeconds).not.toBeNull(); expect(old.stopSeconds).not.toBeNull();
    expect(current.stopDistance!).toBeLessThan(old.stopDistance! * .99);
    expect(current.stopSeconds!).toBeLessThan(old.stopSeconds! * .99);
    const coast = [true, false].map(old => measure(car(old), 5, () => input()));
    expect(Math.abs(coast[1].distance - coast[0].distance)).toBeLessThan(.002);
    expect(coast.every(r => r.stopSeconds === null && r.lateralTravel === 0)).toBe(true);
    console.table(stopped.map((r, i) => ({ tune: i ? 'higher grip' : 'old', ...r })));
  });
});
