/// <reference types="node" />
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { carTune, WALL_D } from '../src/config';
import { PlayerCar, REVERSE_MAX, type DriveInput } from '../src/sim/vehicle';
import { driftTune } from '../src/sim/vehicleDrift';
import { MercedesCar, mercedesTune } from '../src/sim/vehicleMercedes';
import { PorscheCar, porscheTune } from '../src/sim/vehiclePorsche';
import { R34Car, r34Tune, type R34Tune } from '../src/sim/vehicleR34';
import { replay } from '../src/online/world';
import { NetSession, link } from './netsim';

const DT = 1 / 120;
const deg = (c: PlayerCar): number => -Math.atan2(c.vy, c.vx) * 180 / Math.PI;
const input = (steer = 0, throttle = 1, brake = 0): DriveInput => ({ steer, throttle, brake });
const state = (c: PlayerCar): Float64Array => {
  const result = new Float64Array(c.stateSize);
  expect(c.saveState(result)).toBe(result.length);
  return result;
};
const car = (speed = 25, tune?: R34Tune): R34Car => {
  const c = new R34Car(tune);
  c.reset(0, 0, speed);
  return c;
};

/**
 * An unbounded skid pad using the real public step(), including yaw/velocity integration. Rebase
 * only the lateral origin between steps so the highway barriers do not terminate a long circle.
 * Accumulated world displacement is retained; no velocity, heading or slip is reset/overridden.
 * Separate tests below exercise the actual fixed barriers without this rebase.
 */
function pad(c: R34Car, seconds: number, controls: DriveInput | ((i: number) => DriveInput)) {
  let distanceD = 0;
  const samples: { angle: number; speed: number; yaw: number; psi: number; travel: number; d: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    c.d = c.prevD = 0;
    c.step(DT, typeof controls === 'function' ? controls(i) : controls, 0);
    distanceD += c.d;
    samples.push({ angle: deg(c), speed: c.speed, yaw: c.r, psi: c.psi, travel: c.psi - deg(c) * Math.PI / 180, d: distanceD });
    expect(c.wallSide).toBe(0);
  }
  return samples;
}

describe('isolated R34 casual RWD trajectories', () => {
  it.each([-1, 1])('builds a controllable sustained power slide in direction %s', sign => {
    const c = car();
    const samples = pad(c, 6, input(sign));
    expect(samples[119].angle * sign).toBeGreaterThan(16);
    const held = samples.slice(180);
    expect(Math.min(...held.map(s => s.angle * sign))).toBeGreaterThan(25);
    expect(Math.max(...held.map(s => s.angle * sign))).toBeLessThan(42);
    expect(Math.max(...held.map(s => Math.abs(s.yaw)))).toBeLessThan(.8);
    expect(c.speed).toBeGreaterThan(35);
    // The car actually moves sideways and curves through the corner, not merely an animated pose.
    expect(samples[179].d * sign).toBeGreaterThan(6);
    expect(samples[239].travel * sign).toBeGreaterThan(.4);
    expect(c.physicsId).toBe(2);
  });

  it('is exactly mirror-symmetric in both body and road coordinates', () => {
    const left = car(), right = car();
    for (let i = 0; i < 600; i++) {
      left.d = right.d = left.prevD = right.prevD = 0;
      const steer = i < 240 ? 1 : i < 390 ? -.25 : -1;
      left.step(DT, input(-steer), 0);
      right.step(DT, input(steer), 0);
      expect(left.s).toBe(right.s);
      expect(left.vx).toBe(right.vx);
      expect(Math.abs(left.vy + right.vy)).toBe(0);
      expect(Math.abs(left.r + right.r)).toBe(0);
      expect(Math.abs(left.psi + right.psi)).toBe(0);
      expect(Math.abs(left.d + right.d)).toBe(0);
    }
  });

  it('can balance a real straight-road drift for seven seconds using only keyboard keys', () => {
    const c = car();
    c.d = c.prevD = -2;
    let minAngle = Infinity, maxAngle = 0, maxOffset = 0;
    let keyLeft = 0, keyReleased = 0;
    for (let i = 0; i < 840; i++) {
      const slip = deg(c) * Math.PI / 180;
      const travelHeading = c.psi - slip;
      // Test driver, NOT car assistance: place the exit tangent with short opposite-key taps.
      const demand = Math.max(-1, Math.min(1, -.65 * Math.sin(slip) / .9 - travelHeading * 2 - c.d * .025));
      const steer = i < 48 ? 1 : demand < -.02 ? (c.steerIn > demand ? -1 : 0) : demand > .02 ? (c.steerIn < demand ? 1 : 0) : 0;
      if (i >= 48) { if (steer === -1) keyLeft++; if (steer === 0) keyReleased++; }
      c.step(DT, { ...input(steer), handbrake: i < 48 }, 0);
      // No pad rebasing or heading edits in this test: these are the actual highway barriers.
      expect(c.wallSide).toBe(0);
      expect(c.wallHit).toBe(false);
      maxOffset = Math.max(maxOffset, Math.abs(c.d));
      if (i >= 120) {
        minAngle = Math.min(minAngle, deg(c));
        maxAngle = Math.max(maxAngle, deg(c));
      }
    }
    expect(minAngle).toBeGreaterThan(20);
    expect(maxAngle).toBeLessThan(35);
    expect(maxOffset).toBeLessThan(5);
    expect(c.s).toBeGreaterThan(220);
    expect(keyLeft).toBeGreaterThan(100);
    expect(keyReleased).toBeGreaterThan(100);
    // A held slide is not road-following autopilot: without those corrections it hits the wall.
    const handsOff = car();
    let hit = false;
    for (let i = 0; i < 840; i++) {
      handsOff.step(DT, { ...input(i < 48 ? 1 : 0), handbrake: i < 48 }, 0);
      hit ||= handsOff.wallHit;
    }
    expect(hit).toBe(true);
  });

  it('uses gas to set angle rather than locking to a scripted drift pose', () => {
    const angles: number[] = [];
    for (const throttle of [.35, .55, .7, 1]) {
      const c = car();
      pad(c, 2, input(1));
      pad(c, 2, input(0, throttle));
      angles.push(deg(c));
    }
    expect(angles[0]).toBeLessThan(2);
    expect(angles[1]).toBeGreaterThan(14);
    expect(angles[2]).toBeGreaterThan(angles[1] + 4);
    expect(angles[3]).toBeGreaterThan(angles[2] + 5);
    expect(angles[3]).toBeLessThan(40);
  });

  it('lets modest countersteer hold a smaller angle and full countersteer recover', () => {
    const neutral = car(), counter = car();
    pad(neutral, 2, input(1));
    counter.loadState(state(neutral));
    pad(neutral, 1, input(0));
    const held = pad(counter, 1, input(-.25));
    expect(Math.min(...held.map(s => s.angle))).toBeGreaterThan(20);
    expect(deg(counter)).toBeLessThan(deg(neutral) - 2);
    expect(counter.steerAngle).toBeLessThan(-.08);
    pad(counter, .6, input(-1));
    expect(deg(counter)).toBeLessThan(12);
  });

  it.each([-1, 1])('transitions from %s through zero into the opposite drift without a spin', sign => {
    const c = car();
    pad(c, 2, input(sign));
    const transition = pad(c, 2.5, input(-sign));
    expect(transition.some(s => Math.abs(s.angle) < 2)).toBe(true);
    expect(deg(c) * -sign).toBeGreaterThan(27);
    expect(Math.max(...transition.map(s => Math.abs(s.angle)))).toBeLessThan(42);
    expect(Math.max(...transition.map(s => Math.abs(s.yaw)))).toBeLessThan(1.6);
    for (let i = 1; i < transition.length; i++) {
      expect(Math.abs(transition[i].angle - transition[i - 1].angle)).toBeLessThan(.8);
    }
  });

  it('reattaches smoothly on lift without steering itself back to the road heading', () => {
    const c = car();
    pad(c, 2, input(1));
    const before = deg(c);
    const recovery = pad(c, 3, input(0, 0));
    expect(recovery[0].angle).toBeGreaterThan(before - 1);
    for (let i = 1; i < recovery.length; i++) {
      expect(recovery[i].angle).toBeLessThanOrEqual(recovery[i - 1].angle + 1e-10);
      expect(recovery[i - 1].angle - recovery[i].angle).toBeLessThan(.6);
    }
    expect(Math.abs(deg(c))).toBeLessThan(.1);
    expect(Math.abs(c.r)).toBeLessThan(.004);
    expect(c.psi).toBeGreaterThan(.4); // Exit along the chosen tangent; no road-heading autopilot.
    expect(c.steerAngle).toBe(0);
  });

  it('initiates faster with a short handbrake pull, and never invents a drift direction', () => {
    const powered = car(), handbraked = car(), straight = car();
    pad(powered, .5, input(1));
    pad(handbraked, .5, i => ({ ...input(1), handbrake: i < 45 }));
    expect(deg(handbraked)).toBeGreaterThan(20);
    expect(deg(handbraked)).toBeGreaterThan(deg(powered) + 12);
    expect(handbraked.speed).toBeLessThan(powered.speed - 3);
    pad(straight, 1, { ...input(0, 0), handbrake: true });
    expect(Math.abs(straight.vy)).toBe(0);
    expect(straight.r).toBe(0);
    expect(straight.psi).toBe(0);
  });

  it('stays straight at full power and settles after high-speed keyboard taps', () => {
    const straight = car(220 / 3.6);
    pad(straight, 8, input());
    expect(Math.abs(straight.vy)).toBe(0);
    expect(straight.r).toBe(0);
    expect(straight.psi).toBe(0);
    for (const throttle of [.3, 1]) {
      const c = car(220 / 3.6);
      const samples = pad(c, 2.5, i => input(i < 30 ? 1 : 0, throttle));
      expect(Math.max(...samples.map(s => Math.abs(s.angle)))).toBeLessThan(3);
      expect(Math.abs(c.r)).toBeLessThan(.005);
      expect(Math.abs(deg(c))).toBeLessThan(.1);
      expect(c.steerAngle).toBe(0);
    }
  });

  it('also accepts continuous analog input and direct wheel angles', () => {
    for (const controls of [{ analog: true }, { direct: true }]) {
      const c = car(20);
      const samples = pad(c, 3, { ...input(.7), ...controls });
      expect(deg(c)).toBeGreaterThan(20);
      expect(Math.max(...samples.map(s => Math.abs(s.angle)))).toBeLessThan(46);
      expect(c.speed).toBeGreaterThan(20);
    }
  });
});

describe('R34 ordinary driving, collisions and controls', () => {
  it('does not develop rear slip during low-speed manoeuvres, and brakes to rest without oscillation', () => {
    const c = car(4);
    const slow = pad(c, 1, input(1, 0));
    expect(Math.max(...slow.map(s => Math.abs(s.angle)))).toBeLessThan(.01);
    expect(c.r).toBeGreaterThan(0);
    c.reset(0, 0, 100 / 3.6);
    let stopped = false;
    for (let i = 0; i < 600; i++) {
      const speed = c.speed;
      c.step(DT, input(0, 0, 1), 0);
      expect(c.speed).toBeLessThanOrEqual(speed);
      expect(Math.abs(c.vy)).toBe(0);
      if (c.vx === 0) { stopped = true; break; }
    }
    expect(stopped).toBe(true);
    expect(c.s).toBeGreaterThan(25);
    expect(c.s).toBeLessThan(35);
  });

  it('supports the shared reverse pedal convention and returns to first', () => {
    const c = car(0);
    for (let i = 0; i < 480; i++) c.step(DT, input(0, 0, 1), 0);
    expect(c.gear).toBe(0);
    expect(c.vx).toBe(-REVERSE_MAX);
    expect(c.s).toBeLessThan(-15);
    c.step(DT, { ...input(.5, 0, 1), horn: true, blinker: 2, boost: true }, 0);
    expect(c.r).toBeLessThan(0);
    expect(c.horn).toBe(true);
    expect(c.blinker).toBe(2);
    expect(c.boostOn).toBe(false);
    for (let i = 0; i < 240; i++) c.step(DT, input(0, 1), 0);
    expect(c.gear).toBe(1);
    expect(c.vx).toBeGreaterThan(1);
    expect(c.rearRelease).toBe(0);
  });

  it('keeps manual gears, cuts thrust during shifts and refuses an over-rev downshift', () => {
    const c = car(30 / 3.6);
    c.gear = 1;
    c.step(DT, { ...input(), manual: true, shift: 1 }, 0);
    expect(c.gear).toBe(2);
    expect(c.shiftT).toBeGreaterThan(0);
    expect(c.accLong).toBeLessThan(0);
    for (let i = 0; i < 120; i++) c.step(DT, { ...input(), manual: true }, 0);
    expect(c.gear).toBe(2);
    c.reset(0, 0, 150 / 3.6);
    c.gear = 3;
    c.step(DT, { ...input(), manual: true, shift: -1 }, 0);
    expect(c.gear).toBe(3);
    expect(c.shiftRefused).toBe(true);
    c.reset(0, 0, 0);
    c.step(DT, { ...input(0, 0), manual: true, shift: -1 }, 0);
    expect(c.gear).toBe(0);
    c.step(DT, { ...input(0, 0), manual: true, shift: 1 }, 0);
    expect(c.gear).toBe(1);
  });

  it('spends and refills boost and carries horn/signals without changing handling', () => {
    const boosted = car(), normal = car();
    for (let i = 0; i < 360; i++) {
      boosted.step(DT, { ...input(), boost: true, horn: true, blinker: 1 }, 0);
      normal.step(DT, input(), 0);
    }
    expect(boosted.speed).toBeGreaterThan(normal.speed + 4);
    expect(boosted.boost).toBeCloseTo(.25, 10);
    expect(boosted.boostOn).toBe(true);
    expect(boosted.horn).toBe(true);
    expect(boosted.blinker).toBe(1);
    for (let i = 0; i < 1680; i++) boosted.step(DT, input(0, 0), 0);
    expect(boosted.boost).toBe(1);
    expect(boosted.boostOn).toBe(false);
    expect(boosted.horn).toBe(false);
    expect(boosted.blinker).toBe(0);
  });

  it.each([-1, 1])('uses barrier contacts and cooldown on side %s without tunnelling', sign => {
    const c = car(30);
    c.d = sign * (WALL_D - c.halfExtentD() - .02);
    c.setRoadVelocity(30, sign * 5);
    c.step(DT, input(0, 0), 0);
    expect(c.wallHit).toBe(true);
    expect(c.wallSide).toBe(sign);
    expect(c.wallImpact).toBeGreaterThan(3);
    expect(c.vLat * sign).toBeLessThan(0);
    expect(Math.abs(c.d) + c.halfExtentD()).toBeLessThanOrEqual(WALL_D + 1e-9);
    c.setRoadVelocity(25, sign * 2);
    c.step(DT, input(0, 0), 0);
    expect(c.wallHit).toBe(false);
    expect(c.scrapeSide).toBe(sign);
    c.d = 0;
    c.psi = 0;
    c.setRoadVelocity(20, 0);
    for (let i = 0; i < 90; i++) c.step(DT, input(0, .2), 0);
    c.d = sign * (WALL_D - c.halfExtentD() - .02);
    c.setRoadVelocity(20, sign * 5);
    c.step(DT, input(0, 0), 0);
    expect(c.wallHit).toBe(true);
  });

  it('retains collision velocity/yaw impulses rather than overwriting them with a drift pose', () => {
    const hit = car(), untouched = car();
    pad(hit, 1.5, input(1));
    untouched.loadState(state(hit));
    hit.setRoadVelocity(hit.vAlong - 8, hit.vLat + 3);
    hit.r -= .5;
    const changed = state(hit);
    pad(hit, DT, input(0, .7));
    pad(untouched, DT, input(0, .7));
    expect(Math.abs(hit.speed - untouched.speed)).toBeGreaterThan(3);
    expect(Math.abs(hit.r - untouched.r)).toBeGreaterThan(.3);
    expect(state(hit)).not.toEqual(changed);
  });

  it('does not interpret collision-induced side slip as a request for sustained wheelspin', () => {
    const c = car(60.6013518093);
    // Actual off-centre predicted contact from the seed-9/stalled-link reproduction: substantial
    // longitudinal impulse and 10 rad/s yaw kick, but the rear tyres were gripped before impact.
    c.setRoadVelocity(37.6260741806, 0);
    c.r = 10.1143793437;
    const first = pad(c, DT, input());
    expect(c.r).toBeGreaterThan(9); // No collision/yaw clamp and no impulse deletion.
    expect(c.speed).toBeLessThan(38); // The longitudinal hit remains as well.
    const recovery = [...first, ...pad(c, 2 - DT, input())];
    expect(Math.max(...recovery.map(s => s.angle))).toBeGreaterThan(30);
    expect(c.rearRelease).toBe(0); // Slip alone cannot open the rear axle.
    expect(Math.abs(deg(c))).toBeLessThan(1);
    // Before the fix this identical contact manufactured rearRelease=.909 and held ~33° forever.
    const modest = car(37.6260741806);
    modest.r = .8;
    pad(modest, DT, input());
    expect(modest.r).toBeGreaterThan(.7);
    pad(modest, 2 - DT, input());
    expect(Math.abs(deg(modest))).toBeLessThan(.01);
    expect(modest.rearRelease).toBe(0);
  });
});

describe('R34 prediction and bounded integration', () => {
  it.each([9, 11, 42])('bounds speculative collision corrections with stalled links, seed %s', seed => {
    const net = new NetSession(seed, {}, true);
    const l = link(75, 40, .01);
    const client = net.add({ name: 'R34', physics: 2, car: 2, up: l, down: l, fps: 60, bot: { kmh: 220, weave: false, reckless: true } });
    const receive = client.core.receive.bind(client.core);
    let maxYawCorrection = 0;
    client.core.receive = (data, now) => {
      const heading = client.sim.player.psi;
      const count = client.core.stats.corrections;
      receive(data, now);
      if (count !== client.core.stats.corrections) maxYawCorrection = Math.max(maxYawCorrection, Math.abs(client.sim.player.psi - heading));
    };
    net.run(60);
    expect(client.localCrashes).toBeGreaterThan(0);
    expect(client.core.stats.snapshots).toBeGreaterThan(1500);
    expect(client.core.stats.maxCorrection).toBeLessThan(1);
    expect(maxYawCorrection).toBeLessThan(.6);
    const live = net.server.world;
    expect(replay(seed, {}, net.journal, live.tick).hash()).toBe(live.hash());
  });

  it('keeps corrections small without stalls in the seed-9 collision scenario', () => {
    const net = new NetSession(9);
    const l = link(75, 40);
    const client = net.add({ name: 'R34', physics: 2, car: 2, up: l, down: l, fps: 60, bot: { kmh: 220, weave: false, reckless: true } });
    net.run(60);
    expect(client.localCrashes).toBeGreaterThan(0);
    expect(client.core.stats.maxCorrection).toBeLessThan(.3);
  });

  it('serializes every carried value with offsets, then replays every step bit-exactly', () => {
    const original = car();
    pad(original, 1.5, input(1));
    original.step(DT, { ...input(-.25, .8), manual: true, horn: true, blinker: 2, handbrake: true }, .002);
    const buffer = new Float64Array(64).fill(-123);
    expect(original.stateSize).toBeLessThanOrEqual(64);
    expect(original.saveState(buffer, 3)).toBe(3 + original.stateSize);
    expect(buffer[2]).toBe(-123);
    expect(buffer[3 + original.stateSize]).toBe(-123);
    const predicted = car(0);
    expect(predicted.loadState(Array.from(buffer), 3)).toBe(3 + original.stateSize);
    expect(state(predicted)).toEqual(state(original));
    for (let i = 0; i < 1800; i++) {
      const controls: DriveInput = {
        steer: i % 400 < 130 ? -1 : i % 400 < 260 ? 1 : 0,
        throttle: i % 500 < 350 ? .85 : 0,
        brake: i % 500 > 440 ? .7 : 0,
        handbrake: i % 333 < 18,
        boost: i % 700 < 120,
        manual: i % 600 < 300,
        shift: i % 181 === 0 ? 1 : i % 197 === 0 ? -1 : 0,
        horn: i % 99 < 3,
        blinker: i % 3,
      };
      const curvature = Math.sin(i * .01) * .002;
      original.step(DT, controls, curvature);
      predicted.step(DT, controls, curvature);
      expect(state(predicted)).toEqual(state(original));
    }
  });

  it('can rewind reverse and a wall scrape, and reset removes prior drift/control memory', () => {
    const c = car(0);
    for (let i = 0; i < 90; i++) c.step(DT, { ...input(.4, 0, 1), manual: true, horn: true }, 0);
    const clone = car();
    clone.loadState(state(c));
    for (let i = 0; i < 120; i++) {
      c.step(DT, input(0, 0, 1), 0);
      clone.step(DT, input(0, 0, 1), 0);
      expect(state(c)).toEqual(state(clone));
    }
    c.reset(0, 0, 25);
    const fresh = car();
    expect(state(c)).toEqual(state(fresh));
    pad(c, 2, input(1));
    c.reset(0, 0, 25);
    expect(state(c)).toEqual(state(fresh));
    c.d = WALL_D;
    c.step(DT, input(1), 0);
    clone.loadState(state(c));
    c.step(DT, input(-1), 0);
    clone.step(DT, input(-1), 0);
    expect(state(c)).toEqual(state(clone));
  });

  it('stays finite and bounded over mixed controls, curves, barriers and variable frame steps', () => {
    const c = car(45);
    let seed = 0x1234abcd;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    let controls = input();
    for (let i = 0; i < 12000; i++) {
      if (i % 37 === 0) controls = { steer: Math.round(random() * 2 - 1), throttle: random(), brake: random() > .8 ? random() : 0, handbrake: random() < .12, boost: random() < .2, analog: random() < .25 };
      c.step([DT, 1 / 60, 1 / 30][i % 3], controls, Math.sin(i * .001) * .008);
      const values = state(c);
      expect(Array.from(values).every(Number.isFinite)).toBe(true);
      expect(c.speed).toBeLessThan(100);
      expect(Math.abs(c.r)).toBeLessThan(5);
      expect(Math.abs(c.d)).toBeLessThan(WALL_D);
      expect(c.rearRelease).toBeGreaterThanOrEqual(0);
      expect(c.rearRelease).toBeLessThanOrEqual(1);
      expect(c.gear).toBeGreaterThanOrEqual(0);
      expect(c.gear).toBeLessThanOrEqual(r34Tune.gearTopKmh.length);
    }
  });

  it('converges closely at 30/60/120 Hz and ignores invalid time intervals', () => {
    const results: R34Car[] = [];
    for (const hz of [30, 60, 120]) {
      const c = car();
      for (let i = 0; i < hz * 3; i++) {
        c.d = c.prevD = 0;
        c.step(1 / hz, input(i < hz * 1.5 ? 1 : -.25), 0);
      }
      results.push(c);
    }
    expect(Math.max(...results.map(deg)) - Math.min(...results.map(deg))).toBeLessThan(1.5);
    expect(Math.max(...results.map(c => c.speed)) - Math.min(...results.map(c => c.speed))).toBeLessThan(.3);
    const c = results[0], before = state(c);
    for (const dt of [0, -1, NaN, Infinity]) c.step(dt, input(-1), 0);
    expect(state(c)).toEqual(before);
  });
});

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function legacyTrajectory(Model: typeof MercedesCar | typeof PorscheCar): string {
  const c = new Model();
  c.reset(17, -1, 35);
  const samples: number[] = [];
  for (let i = 0; i < 1200; i++) {
    c.step(DT, {
      steer: Math.sin(i * .031) * .65,
      throttle: i % 480 < 360 ? .8 : .15,
      brake: i % 480 >= 400 ? .5 : 0,
      handbrake: i % 333 < 9,
      boost: i % 400 < 100,
      manual: i % 300 > 200,
      shift: i % 111 === 0 ? 1 : 0,
      blinker: i % 3,
      horn: i % 99 < 3,
    }, Math.sin(i * .01) * .001);
    samples.push(...state(c));
  }
  return hash(new Uint8Array(new Float64Array(samples).buffer));
}

describe('R34 tune isolation / untouched A45 and Porsche', () => {
  it('owns its mutable tune and gearbox array, and exposes meaningful R34-only controls', () => {
    for (const other of [carTune, driftTune, mercedesTune, porscheTune]) {
      expect(r34Tune).not.toBe(other);
      expect(r34Tune.gearTopKmh).not.toBe(other.gearTopKmh);
    }
    const angles = [.4, .72].map(driftAngle => {
      const c = car(25, { ...r34Tune, gearTopKmh: [...r34Tune.gearTopKmh], driftAngle });
      pad(c, 4, input(1));
      return deg(c);
    });
    expect(angles[1]).toBeGreaterThan(angles[0] + 12);
    const faster = car(20, { ...r34Tune, powerKW: 600, torqueNm: 1000, longGrip: 1.8 });
    const slower = car(20, { ...r34Tune, powerKW: 100, torqueNm: 150 });
    pad(faster, 2, input());
    pad(slower, 2, input());
    expect(faster.speed).toBeGreaterThan(slower.speed + 6);
  });

  it('preserves the pre-R34 A45/Porsche full-state trajectory bytes even after live R34 tuning', () => {
    // Golden hashes captured on clean main 7a9a0c2. Includes every serialized float at every step,
    // not a loose performance envelope: shared physics or default tune edits invalidate them.
    const expected = ['c1eff3cb1907ab4b3f97caf8dad1c8090e8306cdf7ea5293a3c4449a3ce28a2e', 'd6baf6e5376b2bd85b5acbf9cf8f54019e9975d4e21712066583f25cc50e2e25'];
    const beforeTunes = [JSON.stringify(mercedesTune), JSON.stringify(porscheTune), JSON.stringify(driftTune), JSON.stringify(carTune)];
    const saved = structuredClone(r34Tune);
    try {
      Object.assign(r34Tune, { powerKW: 700, mass: 2000, driftAngle: .8, gripRear: .7 });
      r34Tune.gearTopKmh[0] = 80;
      pad(car(), 4, input(1));
      expect([JSON.stringify(mercedesTune), JSON.stringify(porscheTune), JSON.stringify(driftTune), JSON.stringify(carTune)]).toEqual(beforeTunes);
      expect([legacyTrajectory(MercedesCar), legacyTrajectory(PorscheCar)]).toEqual(expected);
    } finally {
      Object.assign(r34Tune, saved);
    }
  });
});
