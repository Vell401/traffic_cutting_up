import { describe, expect, it } from 'vitest';
import { carTune } from '../src/config';
import { G } from '../src/core/math';
import { PlayerCar, type DriveInput } from '../src/sim/vehicle';
import { driftTune } from '../src/sim/vehicleDrift';
import { MercedesCar, mercedesTune } from '../src/sim/vehicleMercedes';
import { PorscheCar, porscheTune } from '../src/sim/vehiclePorsche';
import { R34Car, r34Tune, type R34Tune } from '../src/sim/vehicleR34';
import { inputFromQ, quantizeInput } from '../src/online/protocol';
import { replay } from '../src/online/world';
import { NetSession, link } from './netsim';

// Independent acceptance tests: no required drift equilibrium, yaw target or scripted path.
// Pads remove only the arbitrary lateral position before a step, never body/velocity state.
const DT = 1 / 120;
const controls = (steer = 0, throttle = 0, brake = 0): DriveInput => ({ steer, throttle, brake });
const tune = (changes: Partial<R34Tune> = {}): R34Tune => Object.assign(structuredClone(r34Tune), changes);
const car = (changes: Partial<R34Tune> = {}, speed = 25): R34Car => {
  const c = new R34Car(tune(changes));
  c.reset(0, 0, speed);
  return c;
};
const noResistance = { aeroDrag: 0, rollingRes: 0, engineBrakeNm: 0 };
const ice = { ...noResistance, gripFront: 0, gripRear: 0, longGrip: 0 };
function pad(c: R34Car, seconds: number, input: DriveInput, dt = DT): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    c.d = c.prevD = 0;
    c.step(dt, input, 0);
    expect(c.wallSide).toBe(0);
  }
}
function state(c: PlayerCar): Float64Array {
  const values = new Float64Array(c.stateSize);
  expect(c.saveState(values)).toBe(values.length);
  return values;
}
const frontTravel = (c: R34Car): number => Math.atan2(c.vy + c.tune.cgToFront * c.r, c.vx);
function manualShift(c: R34Car, shift: number): void {
  c.step(DT, { ...controls(), manual: true, clutch: true, shift }, 0);
  pad(c, c.tune.shiftTime + 2 * DT, { ...controls(), manual: true, clutch: true });
}

describe('R34 force causality, independent of attractive drift trajectories', () => {
  it.each([
    ['coasting', controls()],
    ['powered steering', controls(1, 1)],
    ['nitro through driven wheels', { ...controls(1, 1), boost: true }],
    ['clutch-held nitro', { ...controls(1, 1), boost: true, clutch: true }],
    ['braking steering', controls(-1, 0, 1)],
    ['handbrake steering', { ...controls(1, 1), handbrake: true }],
    ['both pedals', controls(-1, 1, 1)],
  ] satisfies [string, DriveInput][])('conserves world momentum on zero grip: %s', (_name, input) => {
    const c = car(ice);
    c.psi = .31;
    c.vx = 24;
    c.vy = -7;
    c.r = .6;
    const before = { along: c.vAlong, lateral: c.vLat, yaw: c.r };
    pad(c, .5, input, 1 / 480);
    // 2 cm/s allows the body-frame integrator's truncation error, not tyre-less damping.
    expect(Math.abs(c.vAlong - before.along)).toBeLessThan(.02);
    expect(Math.abs(c.vLat - before.lateral)).toBeLessThan(.02);
    expect(Math.abs(c.r - before.yaw)).toBeLessThan(1e-9);
  });

  it.each([controls(0, 0, 1), { ...controls(), handbrake: true }])('cannot brake a straight car through zero-grip tyres: %j', input => {
    const c = car(ice);
    pad(c, 1, input);
    expect(Math.abs(c.vx - 25)).toBeLessThan(1e-8);
    expect(Math.abs(c.vy)).toBeLessThan(1e-10);
    expect(Math.abs(c.r)).toBeLessThan(1e-10);
  });

  it.each([
    [1, 0],
    [0, 1],
    [1, 1],
  ])('shares one finite grip budget under throttle=%s brake=%s', (throttle, brake) => {
    const c = car({ ...noResistance, gripFront: .5, gripRear: .5, longGrip: 1 });
    // These optional aero fields are explicitly zero if the replacement supports them.
    Object.assign(c.tune, { downforceFront: 0, downforceRear: 0, loadSensitivity: 0 });
    c.vy = -8;
    c.r = .35;
    for (let i = 0; i < 240; i++) {
      c.d = c.prevD = 0;
      const along = c.vAlong, lateral = c.vLat;
      c.step(DT, { ...controls(.8, throttle, brake), direct: true }, 0);
      const acceleration = Math.hypot(c.vAlong - along, c.vLat - lateral) / DT;
      // With equal axle mu and no downforce, total force <= mu*m*g, regardless of
      // load transfer or force directions. Separate longitudinal/lateral caps fail this.
      expect(acceleration).toBeLessThan(.5 * G * 1.05);
      expect(c.wallSide).toBe(0);
    }
  });

  it.each([false, true])('does not enter reverse and erase a 25 m/s slide (manual=%s)', manual => {
    const c = car(ice);
    c.vx = -1;
    c.vy = 25;
    c.r = .4;
    const along = c.vAlong, lateral = c.vLat;
    c.step(DT, { ...controls(0, 0, 1), manual, shift: manual ? -1 : 0 }, 0);
    expect(c.gear).not.toBe(0);
    expect(Math.abs(c.vAlong - along)).toBeLessThan(.02);
    expect(Math.abs(c.vLat - lateral)).toBeLessThan(.02);
    expect(Math.abs(c.r - .4)).toBeLessThan(1e-9);
    expect(c.speed).toBeGreaterThan(25);
  });

  it('transmits engine/brake torque to wheel inertia, not directly to body motion on ice', () => {
    const powered = car(ice), locked = car(ice);
    const initial = 25 / powered.tune.wheelRadius;
    pad(powered, .2, controls(0, 1));
    pad(locked, .2, { ...controls(), handbrake: true });
    expect((powered.omega[2] + powered.omega[3]) / 2).toBeGreaterThan(initial * 1.05);
    expect(Math.abs(locked.omega[2]) + Math.abs(locked.omega[3])).toBeLessThan(.01);
    expect(powered.vx).toBeCloseTo(25, 10);
    expect(locked.vx).toBeCloseTo(25, 10);
    const light = car({ ...ice, engineInertia: 0, wheelInertia: 1 });
    const heavy = car({ ...ice, engineInertia: 0, wheelInertia: 10 });
    light.step(1 / 1200, controls(0, 1), 0);
    heavy.step(1 / 1200, controls(0, 1), 0);
    const lightChange = light.omega[2] - initial, heavyChange = heavy.omega[2] - initial;
    expect(lightChange).toBeGreaterThan(0);
    expect(lightChange / heavyChange).toBeCloseTo(10, 8);
  });

  it('reported axle forces plus external tyre moments account for the first symmetric-contact yaw impulse', () => {
    const c = car(noResistance);
    c.vy = -4;
    c.steerAngle = .2;
    c.steerIn = .2 / c.tune.maxSteerLow;
    const along = c.vAlong, lateral = c.vLat;
    const dt = 1e-5;
    c.step(dt, { ...controls(c.steerIn), direct: true, analog: true }, 0);
    const inertia = c.tune.mass * c.tune.cgToFront * c.tune.cgToRear;
    // Initial yaw is zero: paired contact speeds and Fx are equal left/right, so their
    // longitudinal-force yaw moments cancel exactly. TMeasy's four ground Mz values
    // are external moments too; mechanical caster torque is internal to the rack/body.
    const moment = c.tune.cgToFront * c.forceFront - c.tune.cgToRear * c.forceRear + c.groundMoment;
    expect(Math.abs(c.r / dt - moment / inertia)).toBeLessThan(1e-7);
    expect(Math.abs((c.vAlong - along) / dt - c.accLong)).toBeLessThan(1e-7);
    expect(Math.abs((c.vLat - lateral) / dt - c.accLat)).toBeLessThan(1e-7);
    expect(Math.abs(c.accLat - (c.forceFront + c.forceRear) / c.tune.mass)).toBeLessThan(1e-9);
    expect(Math.abs(moment)).toBeGreaterThan(100);
    expect(Math.abs(c.groundMoment)).toBeGreaterThan(1);
  });

  it('conserves total normal load and transfers it rearward under power / forward under braking', () => {
    const powered = car(noResistance), braking = car(noResistance);
    const t = powered.tune;
    const weight = t.mass * G;
    const staticFront = weight * t.cgToRear / (t.cgToFront + t.cgToRear);
    for (let i = 0; i < 60; i++) {
      powered.step(DT, controls(0, 1), 0);
      braking.step(DT, controls(0, 0, 1), 0);
      for (const c of [powered, braking]) {
        expect(c.loadFront).toBeGreaterThan(0);
        expect(c.loadRear).toBeGreaterThan(0);
        expect(c.loadFront + c.loadRear).toBeCloseTo(weight, 8);
      }
    }
    expect(powered.loadFront).toBeLessThan(staticFront - 50);
    expect(braking.loadFront).toBeGreaterThan(staticFront + 50);
    expect(powered.axLag).toBeGreaterThan(0);
    expect(braking.axLag).toBeLessThan(0);
  });

  it('zero CG height removes longitudinal load transfer without removing acceleration', () => {
    const c = car({ ...noResistance, cgHeight: 0 });
    pad(c, .5, controls(0, 1));
    const t = c.tune;
    expect(c.accLong).toBeGreaterThan(.5);
    expect(c.loadFront).toBeCloseTo(t.mass * G * t.cgToRear / (t.cgToFront + t.cgToRear), 8);
    expect(c.loadRear).toBeCloseTo(t.mass * G * t.cgToFront / (t.cgToFront + t.cgToRear), 8);
  });

  it('can change a collision yaw kick only by the available contact impulse', () => {
    const c = car({ ...noResistance, longGrip: 1, loadSensitivity: 0 }, 37.6);
    c.r = 10;
    const along = c.vAlong, lateral = c.vLat;
    const t = c.tune;
    const maxForce = Math.max(t.gripFront, t.gripRear) * t.mass * G;
    const maxLever = Math.hypot(Math.max(t.cgToFront, t.cgToRear), t.trackWidth / 2);
    const inertia = t.mass * t.cgToFront * t.cgToRear;
    c.step(DT, controls(), 0);
    expect(Math.abs(c.r - 10)).toBeLessThanOrEqual(maxForce * maxLever / inertia * DT + 1e-6);
    expect(Math.hypot(c.vAlong - along, c.vLat - lateral)).toBeLessThanOrEqual(maxForce / t.mass * DT + 1e-6);
    expect(c.wallSide).toBe(0);
  });

  it('does not manufacture kinetic energy through passive combined-slip contacts', () => {
    const c = car(noResistance, 10);
    c.vy = 3;
    c.r = .5;
    c.gear = 2;
    const t = c.tune;
    const ratio = t.redline * Math.PI / 30 * t.wheelRadius * 3.6 / t.gearTopKmh[1];
    const inertia = t.mass * t.cgToFront * t.cgToRear;
    const energy = (): number => .5 * t.mass * (c.vx ** 2 + c.vy ** 2) + .5 * inertia * c.r ** 2
      + c.omega.reduce((sum, w, i) => sum + .5 * (t.wheelInertia
        + (i < 2 ? 0 : t.engineInertia * ratio ** 2 * .5)) * w ** 2, 0);
    const initial = energy();
    let previous = initial;
    for (let i = 0; i < 240; i++) {
      c.d = c.prevD = 0;
      c.step(DT, { ...controls(), manual: true, direct: true, analog: true }, 0);
      expect(c.gear).toBe(2); // Fixed coupled inertia: no shift/clutch energy bookkeeping ambiguity.
      const current = energy();
      expect(current).toBeLessThanOrEqual(previous + initial * 1e-8);
      previous = current;
    }
    expect(energy()).toBeLessThan(initial * .99);
  });
});

describe('R34 approved neutral / clutch compatibility', () => {
  it('consumes individual manual presses through 1 -> N -> R -> N -> 1 without NaN', () => {
    const c = car({}, 0);
    for (const [shift, gear] of [[-1, -1], [-1, 0], [1, -1], [1, 1]]) {
      manualShift(c, shift);
      expect(c.gear).toBe(gear);
      expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
      expect(c.speed).toBeLessThan(1e-9);
    }
  });

  it.each(['neutral', 'clutch'] as const)('%s disconnects engine and nitro wheel torque, retaining world momentum', mode => {
    const c = car(ice);
    c.gear = mode === 'neutral' ? -1 : 2;
    c.psi = .3; c.vx = 24; c.vy = -7; c.r = .6;
    const along = c.vAlong, lateral = c.vLat, wheels = [...c.omega];
    pad(c, .5, { ...controls(1, 1), manual: true, clutch: mode === 'clutch', boost: true }, 1 / 480);
    expect(Math.abs(c.vAlong - along)).toBeLessThan(.02);
    expect(Math.abs(c.vLat - lateral)).toBeLessThan(.02);
    expect(Math.abs(c.r - .6)).toBeLessThan(1e-9);
    for (let i = 0; i < wheels.length; i++) expect(c.omega[i]).toBeCloseTo(wheels[i], 9);
    expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
  });

  it.each(['neutral', 'clutch'] as const)('%s coasts on real grip and revs freely without throttle/boost thrust', mode => {
    // Keep crank friction enabled: lifting must slow the free engine, but its drag must
    // NOT reach the wheels through an open clutch / neutral. Only road resistance is zero.
    const revving = car({ aeroDrag: 0, rollingRes: 0 }), coasting = car({ aeroDrag: 0, rollingRes: 0 });
    for (const c of [revving, coasting]) c.gear = mode === 'neutral' ? -1 : 2;
    const input = { ...controls(0, 1), manual: true, clutch: mode === 'clutch', boost: true };
    pad(revving, .7, input);
    pad(coasting, .7, { ...input, throttle: 0, boost: false });
    expect(revving.speed).toBeCloseTo(25, 8);
    expect(coasting.speed).toBeCloseTo(25, 8);
    expect(revving.rpm).toBeGreaterThan(coasting.rpm + 500);
    expect(revving.rpm).toBeLessThanOrEqual(revving.tune.redline + 1e-8);
    const revved = revving.rpm;
    pad(revving, .7, { ...input, throttle: 0, boost: false });
    expect(revving.rpm).toBeLessThan(revved - 500);
  });

  it.each([-1, 0])('total-speed guards keep a sideways 25 m/s car from shifting between N/R (gear %s)', gear => {
    const c = car(ice);
    c.gear = gear; c.vx = -.05; c.vy = 25; c.r = .4;
    const along = c.vAlong, lateral = c.vLat;
    c.step(DT, { ...controls(), manual: true, clutch: true, shift: gear === -1 ? -1 : 1 }, 0);
    expect(c.gear).toBe(gear);
    expect(Math.abs(c.vAlong - along)).toBeLessThan(.02);
    expect(Math.abs(c.vLat - lateral)).toBeLessThan(.02);
    expect(Math.abs(c.r - .4)).toBeLessThan(1e-9);
    expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
  });

  it('entering N from first at speed never indexes a negative gearbox ratio or deletes momentum', () => {
    const c = car(ice);
    c.gear = 1; c.vy = 5; c.r = .3;
    const along = c.vAlong, lateral = c.vLat;
    c.step(DT, { ...controls(0, 1), manual: true, clutch: true, shift: -1, boost: true }, 0);
    expect(c.gear).toBe(-1);
    expect(Math.abs(c.vAlong - along)).toBeLessThan(.02);
    expect(Math.abs(c.vLat - lateral)).toBeLessThan(.02);
    expect(Math.abs(c.r - .3)).toBeLessThan(1e-9);
    expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
  });
});

describe('R34 keyboard rack assistance, not slip/yaw/path assistance', () => {
  it.each([-1, 1])('released keys follow front-contact velocity on slide side %s', sign => {
    const c = car(), gripless = car(ice);
    c.vy = sign * 10;
    c.r = sign * .2;
    gripless.vy = c.vy;
    gripless.r = c.r;
    pad(c, .15, controls());
    pad(gripless, .15, controls());
    const travel = frontTravel(c);
    expect(travel * sign).toBeGreaterThan(.08);
    expect(c.steerAngle * sign).toBeGreaterThan(.03);
    expect(Math.abs(c.steerAngle - travel)).toBeLessThan(Math.abs(travel));
    expect(Math.abs(c.steerAngle)).toBeLessThanOrEqual(c.tune.maxSteerLow + 1e-10);
    // Velocity alone is not a caster torque: without front tyre forces, the released
    // centered rack must stay centered even though the car is sliding and rotating.
    expect(gripless.rackTorque).toBe(0);
    expect(gripless.steerAngle).toBe(0);
  });

  it.each([-1, 1])('front tyre forces can steer the rack in a fast sideways collision slide, side %s', sign => {
    const c = car(noResistance);
    c.vx = 1;
    c.vy = sign * 25;
    // Total speed, not vx, must keep real caster/contact feedback active.
    pad(c, .15, controls());
    expect(c.speed).toBeGreaterThan(20);
    expect(Math.abs(frontTravel(c))).toBeGreaterThan(1);
    expect(c.steerAngle * sign).toBeGreaterThan(.1);
  });

  it.each([-1, 1])('a backward spin cannot supply caster torque without tyre contact forces, side %s', sign => {
    const c = car(ice);
    c.vx = -25;
    c.vy = sign * 10;
    pad(c, .15, controls());
    expect(c.gear).not.toBe(0); // Collision-induced backwards travel is not a reverse-pedal request.
    expect(c.rackTorque).toBe(0);
    expect(c.steerAngle).toBe(0);
    expect(c.r).toBe(0);
    expect(c.vx).toBeCloseTo(-25, 10);
    expect(c.vy).toBeCloseTo(sign * 10, 10);
  });

  it('steerAssist=0 distinguishes disabled assistance from released-key countersteer', () => {
    const assisted = car(), unassisted = car({ steerAssist: 0 });
    for (const c of [assisted, unassisted]) { c.vy = -10; c.r = -.2; }
    pad(assisted, .15, controls());
    pad(unassisted, .15, controls());
    expect(assisted.steerAngle).toBeLessThan(-.03);
    expect(Math.abs(unassisted.steerAngle)).toBeLessThan(1e-9);
  });

  it('explicit direct-wheel control can keep the wheels centered during a slide', () => {
    const c = car();
    c.vy = -10;
    c.r = -.2;
    pad(c, .15, { ...controls(), direct: true, analog: true });
    expect(Math.abs(c.steerAngle)).toBeLessThan(1e-9);
  });

  it('uses yaw at the front contact, not body slip alone, to choose released steering', () => {
    const positive = car(), negative = car();
    positive.r = 1.5;
    negative.r = -1.5;
    // A physical rack responds after the front contact torque exists, not by directly
    // assigning atan2(vy + a*r, vx) on the first tick.
    pad(positive, .05, controls());
    pad(negative, .05, controls());
    expect(positive.steerAngle).toBeGreaterThan(0);
    expect(negative.steerAngle).toBeLessThan(0);
    expect(positive.steerAngle).toBeCloseTo(-negative.steerAngle, 12);
  });

  it('does not change local forces or steering to recover a road heading or lane', () => {
    const a = car(), b = car();
    for (const c of [a, b]) { c.vy = -8; c.r = .3; }
    a.psi = -.6; a.d = -2;
    b.psi = .6; b.d = 2;
    for (let i = 0; i < 12; i++) {
      a.step(DT, controls(), 0);
      b.step(DT, controls(), 0);
      expect(a.wallSide).toBe(0);
      expect(b.wallSide).toBe(0);
      for (const field of ['vx', 'vy', 'r', 'steerAngle'] as const) expect(a[field]).toBe(b[field]);
    }
  });

  it('makes approximately 55 degrees of direct lock available without creating tyre-less yaw', () => {
    const c = car(ice);
    pad(c, 1, { ...controls(1), direct: true, analog: true });
    expect(c.steerAngle).toBeGreaterThan(50 * Math.PI / 180);
    expect(c.steerAngle).toBeLessThan(60 * Math.PI / 180);
    expect(c.steerAngle).toBeCloseTo(c.tune.maxSteerLow, 6);
    expect(Math.abs(c.r)).toBeLessThan(1e-10);
    expect(Math.abs(c.vy)).toBeLessThan(1e-10);
  });

  it('keyboard assistance produces the same forces as manually applying its actual rack angle', () => {
    const assisted = car(), direct = car();
    for (const c of [assisted, direct]) { c.vy = -10; c.r = .2; }
    const dt = 1e-5; // One integration interval: compare exactly the same physical contact geometry.
    assisted.step(dt, controls(), 0);
    direct.steerAngle = assisted.steerAngle;
    direct.steerIn = direct.steerAngle / direct.tune.maxSteerLow;
    direct.step(dt, { ...controls(direct.steerIn), direct: true, analog: true }, 0);
    for (const field of ['vx', 'vy', 'r', 'accLong', 'accLat', 'forceFront', 'forceRear'] as const) {
      expect(assisted[field]).toBe(direct[field]);
    }
    expect(assisted.omega).toEqual(direct.omega);
  });

  // Keyboard feel is deliberately tested separately in r34KeyboardFeel.test.ts.
  // A slip/yaw-feedback test driver can conceal an inaccessible open-loop car.
});

describe('R34 complete rewind state and preset isolation', () => {
  it('rewinds a dirty rack and non-boundary Sketchbook frame cache exactly', () => {
    const original = car(), dirty = car({}, 8);
    original.step(1 / 480, controls(1, 1), 0);
    original.step(1 / 120, controls(1, 1), 0);
    pad(dirty, .6, controls(-1, 1));
    expect(original.keySpring.offset).toBeGreaterThan(0);
    expect(original.keySpring.offset).toBeLessThan(1 / 60);
    expect(original.rackVelocity).not.toBe(dirty.rackVelocity);
    expect(original.keySpring.target).not.toBe(dirty.keySpring.target);
    expect(original.stateSize).toBeLessThanOrEqual(64);
    dirty.loadState(state(original));
    expect(state(dirty)).toEqual(state(original));
    for (let i = 0; i < 360; i++) {
      const input = controls(i < 30 ? 1 : i < 150 ? 0 : i < 180 ? -1 : 0, i < 240 ? 1 : 0);
      const dt = [1 / 480, DT, 1 / 60][i % 3];
      original.d = original.prevD = dirty.d = dirty.prevD = 0;
      original.step(dt, input, 0);
      dirty.step(dt, input, 0);
      expect(state(dirty)).toEqual(state(original));
    }
  });

  it('restores physical reverse wheel/gear/rack memory into a dirty forward car', () => {
    const original = car({}, 0), dirty = car();
    // Manual now uses the user-approved 1 -> N -> R sequence, not brake-to-reverse.
    manualShift(original, -1);
    expect(original.gear).toBe(-1);
    manualShift(original, -1);
    expect(original.gear).toBe(0);
    pad(original, 2, { ...controls(.5, 0, 1), manual: true, horn: true, blinker: 2 });
    pad(dirty, .5, { ...controls(-1, 1), handbrake: true, boost: true });
    expect(original.gear).toBe(0);
    expect(original.vx).toBeLessThan(-.5);
    dirty.loadState(Array.from(state(original)));
    for (let i = 0; i < 300; i++) {
      const input: DriveInput = {
        steer: i < 90 ? -.5 : i < 180 ? .5 : 0,
        throttle: i < 120 ? 0 : 1,
        brake: i < 90 ? 1 : 0,
        manual: true,
        shift: i === 240 ? 1 : 0,
        handbrake: i >= 90 && i < 120,
      };
      original.step(DT, input, 0);
      dirty.step(DT, input, 0);
      expect(state(dirty)).toEqual(state(original));
    }
  });

  it('fits offset state within 64 floats and replaces dirty hidden memory for exact replay', () => {
    const original = car(), dirty = car({}, 4);
    pad(original, .7, { ...controls(.7, 1), handbrake: true, boost: true });
    pad(original, .2, { ...controls(-1, .6), manual: true, shift: 1, horn: true, blinker: 2 });
    pad(dirty, .6, { ...controls(-1, 0, 1), direct: true, analog: true });
    expect(original.stateSize).toBeLessThanOrEqual(64);
    const offset = 5;
    const buffer = new Float64Array(offset + original.stateSize + 2).fill(-12345);
    expect(original.saveState(buffer, offset)).toBe(offset + original.stateSize);
    expect(Array.from(buffer.slice(0, offset))).toEqual(Array(offset).fill(-12345));
    expect(Array.from(buffer.slice(offset + original.stateSize))).toEqual([-12345, -12345]);
    expect(dirty.loadState(Array.from(buffer), offset)).toBe(offset + original.stateSize);
    expect(state(dirty)).toEqual(state(original));
    for (let i = 0; i < 720; i++) {
      const input: DriveInput = {
        steer: i % 120 < 40 ? -1 : i % 120 < 80 ? 1 : 0,
        throttle: i % 180 < 120 ? 1 : 0,
        brake: i % 180 >= 160 ? 1 : 0,
        handbrake: i % 137 < 8,
        boost: i % 250 < 25,
        clutch: i % 211 < 35,
        manual: i % 240 < 180,
        shift: i % 89 === 0 ? 1 : i % 97 === 0 ? -1 : 0,
        direct: i % 360 > 300,
        analog: i % 360 > 300,
        horn: i % 73 === 0,
        blinker: i % 3,
      };
      const curvature = Math.sin(i * .03) * .002;
      // Run the same quantized representation consumed by server and prediction.
      const quantized = inputFromQ(quantizeInput(input, { steer: 0, throttle: 0, brake: 0, flags: 0 }), controls());
      original.step(DT, quantized, curvature);
      dirty.step(DT, quantized, curvature);
      expect(state(dirty)).toEqual(state(original));
      expect(Array.from(state(original)).every(Number.isFinite)).toBe(true);
    }
    original.reset(0, 0, 25);
    expect(state(original)).toEqual(state(car()));
  });

  it.each(['neutral', 'clutch'] as const)('restores dirty free-RPM / %s memory and replays quantized reconnection exactly', mode => {
    const original = car({}, 0), dirty = car();
    if (mode === 'neutral') manualShift(original, -1);
    pad(original, .7, { ...controls(0, .85), manual: true, clutch: true, boost: true });
    pad(dirty, .5, { ...controls(-1, 1), handbrake: true });
    expect(original.rpm).toBeGreaterThan(original.tune.idleRpm + 500);
    expect(original.stateSize).toBeLessThanOrEqual(64);
    const offset = 3, buffer = new Float64Array(offset + original.stateSize + 1).fill(-919);
    expect(original.saveState(buffer, offset)).toBe(offset + original.stateSize);
    expect(dirty.loadState(Array.from(buffer), offset)).toBe(offset + original.stateSize);
    expect(buffer[2]).toBe(-919);
    expect(buffer[offset + original.stateSize]).toBe(-919);
    expect(state(dirty)).toEqual(state(original));
    for (let i = 0; i < 480; i++) {
      const input: DriveInput = {
        ...controls(i < 100 ? .4 : i < 200 ? -.4 : 0, i < 300 ? .8 : 0, i >= 360 ? 1 : 0),
        manual: true,
        clutch: i < 40 || i % 113 < 20,
        shift: mode === 'neutral' && i === 20 ? 1 : i === 180 ? 1 : 0,
        boost: i < 80,
        handbrake: i >= 300 && i < 330,
      };
      const quantized = inputFromQ(quantizeInput(input, { steer: 0, throttle: 0, brake: 0, flags: 0 }), controls());
      expect(quantized.clutch).toBe(input.clutch);
      original.step(DT, quantized, 0);
      dirty.step(DT, quantized, 0);
      expect(state(dirty)).toEqual(state(original));
      expect(Array.from(state(original)).every(Number.isFinite)).toBe(true);
    }
  });

  it('copied custom R34 presets neither mutate defaults nor change A45/Porsche trajectories', () => {
    const baselineTunes = [carTune, driftTune, mercedesTune, porscheTune, r34Tune].map(t => structuredClone(t));
    const reference = [new MercedesCar(), new PorscheCar()];
    const compared = [new MercedesCar(), new PorscheCar()];
    for (const c of [...reference, ...compared]) c.reset(17, -1, 25);
    const custom = tune({ mass: 1900, powerKW: 600, gripRear: .6, steerAssist: 0 });
    custom.gearTopKmh[0] = 85;
    const independent = new R34Car(custom);
    independent.reset(0, 0, 25);
    expect(custom.gearTopKmh).not.toBe(r34Tune.gearTopKmh);
    for (const other of [carTune, driftTune, mercedesTune, porscheTune]) {
      expect(r34Tune).not.toBe(other);
      expect(r34Tune.gearTopKmh).not.toBe(other.gearTopKmh);
    }
    for (let i = 0; i < 360; i++) {
      const input = controls(Math.sin(i * .03) * .5, .8, i % 120 > 100 ? .4 : 0);
      for (const c of reference) c.step(DT, input, .001);
      pad(independent, DT, { ...input, handbrake: i % 90 < 10 });
      for (const c of compared) c.step(DT, input, .001);
      for (let j = 0; j < reference.length; j++) expect(state(compared[j])).toEqual(state(reference[j]));
    }
    expect([carTune, driftTune, mercedesTune, porscheTune, r34Tune]).toEqual(baselineTunes);
  });
});

describe('R34 quantized online replay with latency and stalled delivery', () => {
  // Exact replay/no-contact prediction below is NOT a collision ride-quality guarantee.
  // Separate reproduction: scripts/netcheck.ts, seed 11, 60 s, mixed physics 1/2,
  // link(75, 30, .01), 60 fps. The frozen R34 recorded a 2.639 m max correction
  // (R34-only p95 .393 m) while its recorded authoritative journal replayed exactly.
  // Keep that limitation separate; do not weaken these replay assertions to conceal it.
  it.each([60, 144])('replays deliberate N/R selection and clutch edges at %s render fps', fps => {
    const seed = 28411;
    const net = new NetSession(seed, {}, true);
    net.server.configure({ trafficOn: false });
    const delayed = link(75, 40, .01);
    const client = net.add({ name: 'Manual N/clutch R34', car: 2, physics: 2, up: delayed, down: delayed, fps,
      bot: { kmh: 30, weave: false } });
    let ticks = 0, maximumNeutralRpm = 0;
    const serverGears = new Set<number>();
    client.bot.drive = () => {
      const i = ticks++;
      return {
        steer: 0,
        throttle: i >= 150 && i <= 420 || i > 780 && i <= 900 || i > 960 ? 1 : 0,
        brake: i > 420 && i <= 600 || i >= 692 && i <= 780 ? 1 : 0,
        manual: true,
        shift: i === 120 || i === 601 || i === 661 ? -1 : i === 240 || i === 901 || i === 961 ? 1 : 0,
        clutch: i >= 240 && i <= 300 || i > 1000,
        boost: i >= 160 && i < 200 || i >= 260 && i < 280,
      };
    };
    net.run(12, () => {
      const server = net.server.world.drivers[0];
      if (!server) return;
      serverGears.add(server.car.gear);
      if (server.car.gear === -1) maximumNeutralRpm = Math.max(maximumNeutralRpm, server.car.rpm);
    });
    expect(client.sim.player).toBeInstanceOf(R34Car);
    expect(serverGears.has(-1)).toBe(true);
    expect(serverGears.has(0)).toBe(true);
    expect(serverGears.has(1)).toBe(true);
    expect(maximumNeutralRpm).toBeGreaterThan(r34Tune.idleRpm + 500);
    expect(client.core.stats.snapshots).toBeGreaterThan(250);
    expect(client.core.stats.corrections).toBe(0);
    expect(client.core.stats.maxCorrection).toBe(0);
    expect(replay(seed, {}, net.journal, net.server.world.tick).hash()).toBe(net.server.world.hash());
  });

  it.each([30, 144])('needs no corrections without speculative contacts at %s render fps', fps => {
    const seed = 9187;
    const net = new NetSession(seed, {}, true);
    net.server.configure({ trafficOn: false });
    const delayed = link(75, 40, .01);
    const client = net.add({ name: 'Keyboard R34', car: 2, physics: 2, up: delayed, down: delayed, fps,
      bot: { kmh: 90, weave: false } });
    let ticks = 0;
    client.bot.drive = () => {
      const phase = ticks++ % 960;
      return {
        steer: phase < 120 ? 1 : phase < 240 ? 0 : phase < 420 ? -1 : phase < 540 ? 0 : phase < 660 ? 1 : 0,
        throttle: phase < 660 ? 1 : 0,
        brake: phase > 840 ? 1 : 0,
        manual: phase > 500 && phase < 800,
        shift: phase === 540 ? 1 : phase === 720 ? -1 : 0,
        handbrake: phase > 10 && phase < 28,
        boost: phase > 360 && phase < 400,
        clutch: phase > 360 && phase < 380,
        horn: phase % 120 < 2,
        blinker: phase < 400 ? 1 : 2,
        analog: phase > 740 && phase < 800,
        direct: phase > 740 && phase < 800,
      };
    };
    net.run(12);
    expect(client.sim.player).toBeInstanceOf(R34Car);
    expect(net.server.world.drivers[0].car).toBeInstanceOf(R34Car);
    expect(client.core.ready).toBe(true);
    expect(client.core.stats.snapshots).toBeGreaterThan(250);
    expect(client.core.stats.corrections).toBe(0);
    expect(client.core.stats.maxCorrection).toBe(0);
    expect(replay(seed, {}, net.journal, net.server.world.tick).hash()).toBe(net.server.world.hash());
  });
});
