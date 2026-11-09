/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { carTune, WALL_D } from '../src/config';
import { G } from '../src/core/math';
import { PlayerCar, type DriveInput } from '../src/sim/vehicle';
import { driftTune } from '../src/sim/vehicleDrift';
import { mercedesTune } from '../src/sim/vehicleMercedes';
import { porscheTune } from '../src/sim/vehiclePorsche';
import { R34Car, r34Tune, type R34Tune } from '../src/sim/vehicleR34';
import { evaluateTMeasy } from '../src/sim/r34/chronoTMeasy';
import { SketchbookSpring, sketchbookKeyTarget } from '../src/sim/r34/sketchbookSteering';
import { replay } from '../src/online/world';
import { inputFromQ, quantizeInput } from '../src/online/protocol';
import { NetSession, link } from './netsim';

const DT = 1 / 120;
const angle = (c: PlayerCar): number => -Math.atan2(c.vy, c.vx);
const degrees = (c: PlayerCar): number => angle(c) * 180 / Math.PI;
const input = (steer = 0, throttle = 1, brake = 0): DriveInput => ({ steer, throttle, brake });
const car = (speed = 25, tune: Partial<R34Tune> = {}): R34Car => {
  const c = new R34Car({ ...r34Tune, gearTopKmh: [...r34Tune.gearTopKmh], ...tune });
  c.reset(0, 0, speed);
  return c;
};
const state = (c: PlayerCar): Float64Array => {
  const result = new Float64Array(c.stateSize);
  expect(c.saveState(result)).toBe(result.length);
  return result;
};

/** Unlimited flat skid pad: rebase only d to avoid the highway walls, never velocity or heading.
 * Keep actual accumulated world displacement and path length for trajectory assertions. */
function pad(c: R34Car, seconds: number, controls: DriveInput | ((i: number) => DriveInput)) {
  let lateral = 0, distance = 0;
  const samples: { angle: number; speed: number; yaw: number; wheel: number; spin: number; lateral: number; distance: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    c.d = c.prevD = 0;
    c.step(DT, typeof controls === 'function' ? controls(i) : controls, 0);
    lateral += c.d;
    distance += Math.hypot(c.s - c.prevS, c.d);
    samples.push({ angle: degrees(c), speed: c.speed, yaw: c.r, wheel: c.steerAngle, spin: c.rearWheelspin, lateral, distance });
    expect(c.wallSide).toBe(0);
  }
  return samples;
}

describe('R34 force law and causal chassis dynamics', () => {
  it('uses the actual TMeasy combined-slip curve, including finite peak and sliding branch', () => {
    const load = 4000;
    for (const k of [-3, -.4, -.115, -.01, 0, .01, .115, .4, 3]) {
      for (const sy of [-1, -.1, 0, .1, 1]) {
        const { fx, fy } = evaluateTMeasy(k, sy, load, load);
        expect(Math.hypot(fx, fy)).toBeLessThanOrEqual(1.13 * load);
        expect(fx * k).toBeGreaterThanOrEqual(0);
        expect(fy * sy).toBeGreaterThanOrEqual(0);
      }
    }
    const peak = evaluateTMeasy(.13913, 0, load, load).fx;
    expect(peak).toBeCloseTo(1.1292 * load, 8);
    expect(evaluateTMeasy(1, 0, load, load).fx).toBeLessThan(peak * .8);
    expect(Math.abs(evaluateTMeasy(.6, .15, load, load).fy)).toBeLessThan(load * .3);
    expect(evaluateTMeasy(.6, 1, 0, load)).toEqual({ fx: 0, fy: 0, mz: 0, dfxDsx: 0 });
  });

  it('conserves world linear/angular momentum on zero-grip ground despite all controls', () => {
    const c = car(25, { gripFront: 0, gripRear: 0, aeroDrag: 0, rollingRes: 0 });
    c.vy = 5; c.r = 1.2;
    const initial = [c.vAlong, c.vLat, c.r, c.speed];
    pad(c, 10, i => ({ ...input(i % 200 < 100 ? 1 : -1, 1, 1), handbrake: i % 300 < 150, boost: true }));
    [c.vAlong, c.vLat, c.r, c.speed].forEach((x, i) => expect(x).toBeCloseTo(initial[i], 8));
    expect(c.forceFront).toBe(0);
    expect(c.forceRear).toBe(0);
    expect(c.accLong).toBe(0);
    expect(c.accLat).toBe(0);
  });

  it('steering creates a front contact force before yaw; no front grip means no steering authority', () => {
    const c = car(25, { gripRear: 0, aeroDrag: 0, rollingRes: 0 });
    c.steerIn = 1;
    c.step(.0001, { ...input(1, 0), direct: true }, 0);
    expect(c.forceFront).toBeGreaterThan(0);
    expect(c.r).toBeGreaterThan(0);
    // Rear zero grip, no rear force moment: exact contact-solver inertia m*a*b.
    const expected = (c.tune.cgToFront * c.forceFront + c.groundMoment)
      / (c.tune.mass * c.tune.cgToFront * c.tune.cgToRear) * .0001;
    expect(c.r).toBeCloseTo(expected, 10);
    expect(c.r).toBeLessThan(.001);
    const iceFront = car(25, { gripFront: 0 });
    pad(iceFront, 1, input(1, 0));
    expect(iceFront.vy).toBe(0);
    expect(iceFront.r).toBe(0);
  });

  it('power spins the rear wheels and loses rear lateral authority instead of assigning body slip', () => {
    const coast = car(), powered = car();
    pad(coast, 1, input(1, 0));
    pad(powered, 1, input(1, 1));
    expect(powered.slipRear).toBeGreaterThan(.25);
    expect(powered.rearWheelspin).toBeGreaterThan(8);
    expect(Math.abs(coast.rearWheelspin)).toBeLessThan(.2);
    expect(degrees(powered)).toBeGreaterThan(degrees(coast) + 8);
    expect(Math.abs(powered.slipAngleRear)).toBeGreaterThan(.2);
    const normal = car(20), excessive = car(20, { torqueNm: r34Tune.torqueNm * 3, powerKW: r34Tune.powerKW * 3 });
    pad(normal, 1, input()); pad(excessive, 1, input());
    expect(excessive.slipRear).toBeGreaterThan(normal.slipRear);
    expect(excessive.accLong).toBeLessThan(normal.accLong * 1.3); // Tyres, not requested torque, limit force.
    expect(excessive.speed).toBeLessThan(normal.speed + 2);
  });

  it('has sprung longitudinal/lateral load transfer and load-sensitive tyre capacity', () => {
    const c = car();
    const staticFront = c.tune.mass * G * c.tune.cgToRear / (c.tune.cgToFront + c.tune.cgToRear);
    pad(c, 1, input());
    expect(c.loadFront).toBeLessThan(staticFront - 500);
    expect(c.loadFront + c.loadRear).toBeCloseTo(c.tune.mass * G, 9);
    expect(c.axLag).toBeGreaterThan(2);
    const before = c.loadFront;
    pad(c, DT, input(0, 0, 1));
    expect(Math.abs(c.loadFront - before)).toBeLessThan(100); // Spring/load lag, not an instantaneous axle switch.
    pad(c, .7, input(0, 0, 1));
    expect(c.loadFront).toBeGreaterThan(staticFront + 1000);
    const level = car(25, { engineBrakeNm: 0, aeroDrag: 0, rollingRes: 0 });
    const rolled = car(25, { engineBrakeNm: 0, aeroDrag: 0, rollingRes: 0 });
    level.vy = rolled.vy = -3;
    rolled.ayLag = 10;
    level.step(.0001, input(0, 0), 0); rolled.step(.0001, input(0, 0), 0);
    expect(Math.abs(rolled.forceRear)).toBeLessThan(Math.abs(level.forceRear));
    const insensitive = car(25, { loadSensitivity: 0, engineBrakeNm: 0, aeroDrag: 0, rollingRes: 0 });
    insensitive.vy = -3; insensitive.ayLag = 10;
    insensitive.step(.0001, input(0, 0), 0);
    // Turning off our extra mu/load adjustment does not disable Chrono's native pn/2pn curves.
    expect(Math.abs(insensitive.forceRear)).toBeLessThan(Math.abs(level.forceRear));
    expect(Math.abs(insensitive.forceRear)).toBeGreaterThan(Math.abs(rolled.forceRear));
  });

  it('wheel inertia changes torque response, and LSD equalizes independent rear wheel speeds', () => {
    const light = car(0), heavy = car(0, { engineInertia: 1.2, wheelInertia: 8 });
    pad(light, .3, input()); pad(heavy, .3, input());
    expect(light.omega[2]).toBeGreaterThan(heavy.omega[2] * 1.5);
    expect(light.speed).toBeGreaterThan(heavy.speed);
    const open = car(22, { lsdLock: 0 }), locked = car(22);
    pad(open, 3, input(1)); pad(locked, 3, input(1));
    expect(Math.abs(locked.omega[2] - locked.omega[3])).toBeLessThan(Math.abs(open.omega[2] - open.omega[3]) * .4);
    expect(locked.slipRear).toBeGreaterThan(open.slipRear);
    expect(light.engineTorque(6000) * 6000 * Math.PI / 30).toBeLessThanOrEqual(r34Tune.powerKW * 1000 + 1e-8);
  });
});

describe('real keyboard auto-countersteer and drift trajectories', () => {
  it('ports Sketchbook directional min/max rather than adding another opposite-lock demand', () => {
    expect(sketchbookKeyTarget(-1, 25, -15, r34Tune.maxSteerLow)).toBeCloseTo(Math.atan2(-15, 25), 12);
    expect(sketchbookKeyTarget(1, 25, -15, r34Tune.maxSteerLow)).toBeCloseTo(.8 / 7.5, 12);
    expect(sketchbookKeyTarget(1, 25, 15, r34Tune.maxSteerLow)).toBeCloseTo(Math.atan2(15, 25), 12);
    expect(sketchbookKeyTarget(-1, 25, 15, r34Tune.maxSteerLow)).toBeCloseTo(-.8 / 7.5, 12);
    expect(sketchbookKeyTarget(1, 0, 100, r34Tune.maxSteerLow)).toBe(r34Tune.maxSteerLow);
  });

  it('keeps the original 60-Hz spring cadence, cached interpolation and rewind state', () => {
    const spring = new SketchbookSpring(); spring.target = 1;
    spring.simulate(1 / 60);
    expect(spring.position).toBe(0);
    expect(spring.nextVelocity).toBe(.06);
    spring.simulate(1 / 120);
    expect(spring.position).toBeCloseTo(.03, 14);
    const data = new Float64Array(8); spring.save(data);
    const restored = new SketchbookSpring(); restored.load(data);
    for (let i = 0; i < 100; i++) { spring.simulate(.007); restored.simulate(.007); }
    const a = new Float64Array(8), b = new Float64Array(8); spring.save(a); restored.save(b);
    expect(a).toEqual(b);
  });

  // Higher rear grip needs a deliberate longer entry; the keyboard survey still measures short taps.
  it.each([[60, .7], [80, .7], [100, .8], [120, .9]])(
    'measures fixed human entries with +/-100 ms timing error at %s km/h', (kmh, entry) => {
      const measurements = [];
      for (const sign of [-1, 1]) for (const timing of [-.1, 0, .1]) {
        const c = car(kmh / 3.6), tap = Math.round((entry + timing) / DT);
        const samples = pad(c, 6, i => input(i < tap ? sign : 0, i < 420 ? 1 : 0));
        const peak = Math.max(...samples.map(s => Math.abs(s.angle)));
        const hold = samples.slice(tap).filter(s => s.angle * sign > 10).length * DT;
        measurements.push({ kmh, sign, entry: entry + timing,
          peak: +peak.toFixed(2), secondsAbove10: +hold.toFixed(2), exit: +degrees(c).toFixed(2) });
        expect(peak).toBeGreaterThan(5);
        expect(peak).toBeLessThan(80);
        expect(Math.abs(degrees(c))).toBeLessThan(3);
        expect(samples.every((s, i) => i === 0 || Math.abs(s.angle - samples[i - 1].angle) < 2)).toBe(true);
      }
      // These are measurements, not an assertion that every speed/tap has one beta equilibrium.
      console.table(measurements);
    });

  it.each([-1, 1])('holds a real powered slide after a fixed key entry, direction %s', sign => {
    const c = car(25);
    const samples = pad(c, 5, i => input(i < 102 ? sign : 0, i < 420 ? 1 : 0));
    // More grip: W + D/A .85 s (was .5), release, W until 3.5 s, then lift. No feedback driver.
    const held = samples.slice(120, 300);
    expect(Math.min(...held.map(s => s.angle * sign))).toBeGreaterThan(15);
    expect(Math.max(...samples.map(s => Math.abs(s.angle)))).toBeLessThan(70);
    expect(held.every(s => s.spin > 5 && s.speed > 24)).toBe(true);
    expect(held.filter(s => s.wheel * sign < -.2).length).toBeGreaterThan(held.length * .9);
    expect(samples.at(-1)!.distance).toBeGreaterThan(120);
    expect(Math.abs(degrees(c))).toBeLessThan(3);
    expect(c.physicsId).toBe(2);
  });

  it('gas sustains the rear breakaway while lift progressively restores grip', () => {
    const powered = car(25), lifted = car(25);
    pad(powered, .85, input(1)); lifted.loadState(state(powered));
    const gas = pad(powered, 2, input(0)), coast = pad(lifted, 2, input(0, 0));
    expect(gas[120].angle).toBeGreaterThan(coast[120].angle + 10);
    expect(gas[120].spin).toBeGreaterThan(5);
    expect(Math.abs(coast.at(-1)!.spin)).toBeLessThan(.5);
    expect(Math.abs(coast.at(-1)!.angle)).toBeLessThan(2);
    expect(coast.every((s, i) => i === 0 || Math.abs(s.angle - coast[i - 1].angle) < 1.5)).toBe(true);
  });

  it('released keys turn the actual wheels into opposite lock, with finite rack speed', () => {
    const c = car(25);
    pad(c, .85, input(1));
    expect(degrees(c)).toBeGreaterThan(3);
    const oldAngle = c.steerAngle, oldSlip = degrees(c), oldV = [c.vx, c.vy];
    const samples = pad(c, .5, input(0));
    expect(samples.at(-1)!.wheel).toBeLessThan(-.1);
    expect(Math.abs(samples[0].wheel - oldAngle)).toBeLessThanOrEqual(c.tune.rackRate * DT + 1e-12);
    expect(Math.abs(samples[0].angle - oldSlip)).toBeLessThan(1);
    expect(Math.hypot(c.vx - oldV[0], c.vy - oldV[1])).toBeGreaterThan(.2);
    expect(c.steerIn).toBe(0);
    const direct = car(22);
    direct.loadState(state(c));
    pad(direct, .4, { ...input(0, 0), direct: true });
    expect(direct.steerAngle).toBe(0); // Direct wheel input bypasses keyboard aid.
  });

  it('self-aligns toward positive front-contact velocity during pure yaw, not opposite it', () => {
    const c = car();
    c.r = 1.5;
    const contactAngle = Math.atan2(c.vy + c.tune.cgToFront * c.r, c.vx);
    expect(contactAngle).toBeGreaterThan(0);
    c.step(DT, input(0, 0), 0);
    expect(c.steerAngle).toBeGreaterThan(0);
    expect(c.steerAngle).toBeLessThan(contactAngle);
    expect(c.steerAngle).toBeLessThanOrEqual(c.tune.rackRate * DT);
  });

  it('needs actual contact torque to self-steer, including fast sideways/backwards motion', () => {
    for (const sign of [-1, 1]) {
      const sideways = car(1, { gripFront: 0, gripRear: 0, aeroDrag: 0, rollingRes: 0 });
      sideways.vy = sign * 25;
      pad(sideways, .15, input(0, 0));
      expect(sideways.steerAngle).toBe(0);
      expect(sideways.speed).toBeGreaterThan(25);
      const backwards = car(25, { gripFront: 0, gripRear: 0, aeroDrag: 0, rollingRes: 0 });
      backwards.vx = -25; backwards.vy = sign * 10;
      pad(backwards, .15, input(0, 0));
      expect(backwards.gear).toBeGreaterThan(0);
      expect(backwards.steerAngle).toBe(0);
      expect(backwards.rackTorque).toBe(0);
    }
  });

  it('lifts/catches progressively and leaves the chosen exit heading, not the road heading', () => {
    const c = car(25);
    pad(c, .85, input(1));
    pad(c, .5, input(0));
    const slip = degrees(c);
    const recovery = pad(c, 4, input(0, 0));
    expect(recovery[0].angle).toBeGreaterThan(slip - 1);
    expect(recovery[30].angle).toBeGreaterThan(5);
    expect(Math.abs(degrees(c))).toBeLessThan(2);
    expect(Math.abs(c.r)).toBeLessThan(.01);
    expect(Math.abs(c.psi)).toBeGreaterThan(.2);
    expect(recovery.every((s, i) => i === 0 || Math.abs(s.angle - recovery[i - 1].angle) < 1)).toBe(true);
  });

  it.each([-1, 1])('transitions with a fixed opposite-key pulse and catches the rear, from %s', sign => {
    const c = car(25);
    // Longer deliberate entry and opposite pulse for the higher-grip rear tyres.
    pad(c, .85, input(sign));
    pad(c, .35, input(0));
    const samples = pad(c, 5.8, i => input(i < 180 ? -sign : 0, i < 336 ? 1 : 0));
    expect(samples.some(s => Math.abs(s.angle) < 1)).toBe(true);
    expect(Math.min(...samples.map(s => s.angle * sign))).toBeLessThan(-20);
    expect(Math.max(...samples.map(s => Math.abs(s.angle)))).toBeLessThan(60);
    expect(samples.every((s, i) => i === 0 || Math.abs(s.angle - samples[i - 1].angle) < 1.5)).toBe(true);
    expect(Math.abs(degrees(c))).toBeLessThan(3);
  });

  it.each([-1, 1])('makes a fixed highway entry and catches without rebasing or state edits, side %s', sign => {
    const c = car();
    c.reset(0, -4 * sign, 25);
    let maxSlip = 0, maxOffset = 0;
    for (let i = 0; i < 720; i++) {
      // Fixed quick lane-entry tap and lift. No state-dependent decisions at all.
      c.step(DT, input(i < 24 ? sign : 0, i < 24 ? 1 : 0), 0);
      maxSlip = Math.max(maxSlip, Math.abs(degrees(c)));
      maxOffset = Math.max(maxOffset, Math.abs(c.d));
      expect(c.wallSide).toBe(0); expect(c.wallHit).toBe(false);
    }
    expect(maxSlip).toBeGreaterThan(.1); expect(maxSlip).toBeLessThan(15);
    expect(maxOffset).toBeLessThan(8);
    expect(c.s).toBeGreaterThan(120);
    expect(Math.abs(degrees(c))).toBeLessThan(.2);
    expect(Math.abs(c.r)).toBeLessThan(.01);
    // Caster cannot choose the exit road tangent; it must retain the entry's world heading.
    expect(c.psi * sign).toBeGreaterThan(0);
  });

  it('exposes RWD instability without assistance; even assisted full-lock power can spin', () => {
    const raw = car(25, { steerAssist: 0 }), assisted = car();
    const rawPath = pad(raw, 2, i => input(i < 72 ? 1 : 0));
    const safePath = pad(assisted, 2, i => input(i < 72 ? 1 : 0));
    expect(Math.max(...rawPath.map(s => Math.abs(s.angle)))).toBeGreaterThan(100);
    expect(Math.max(...safePath.map(s => Math.abs(s.angle)))).toBeLessThan(65);
    pad(assisted, 3, input(0, 0));
    expect(Math.abs(degrees(assisted))).toBeLessThan(3);
    const careless = car(22);
    const spin = pad(careless, 7, input(1));
    expect(Math.max(...spin.map(s => Math.abs(s.angle)))).toBeGreaterThan(100);
  });

  it('handbrake locks rear wheels, loses lateral grip and never invents a slide direction', () => {
    const ordinary = car(), pulled = car(), straight = car();
    pad(ordinary, .4, input(1));
    pad(pulled, .4, { ...input(1), handbrake: true });
    expect(pulled.omega[2]).toBe(0); expect(pulled.omega[3]).toBe(0);
    expect(pulled.slipRear).toBeCloseTo(-1, 8);
    expect(degrees(pulled)).toBeGreaterThan(degrees(ordinary) + 1);
    expect(pulled.speed).toBeLessThan(ordinary.speed - 2);
    pad(straight, 1, { ...input(0, 0), handbrake: true });
    expect(straight.vy).toBe(0); expect(straight.r).toBe(0);
  });

  it('is mirror-symmetric and has no hidden road/lane-heading feedback', () => {
    const left = car(), right = car(), rotated = car();
    rotated.psi = 1.1;
    for (let i = 0; i < 600; i++) {
      left.d = right.d = rotated.d = 0;
      const steer = i < 240 ? 1 : i < 420 ? -1 : 0;
      left.step(DT, input(-steer), 0); right.step(DT, input(steer), 0); rotated.step(DT, input(steer), 0);
      expect(left.vx).toBeCloseTo(right.vx, 10);
      expect(left.vy).toBeCloseTo(-right.vy, 10);
      expect(left.r).toBeCloseTo(-right.r, 10);
      expect(left.psi).toBeCloseTo(-right.psi, 10);
      expect(rotated.vx).toBe(right.vx); expect(rotated.vy).toBe(right.vy); expect(rotated.r).toBe(right.r);
      expect(rotated.psi - right.psi).toBeCloseTo(1.1, 10);
    }
  });
});

describe('R34 controls, contact continuity and prediction', () => {
  it('keeps full lateral/angular impulses and cannot select reverse during a sideways spin', () => {
    const c = car(0);
    c.vy = 25; c.r = .8;
    c.step(DT, input(0, 0, 1), 0);
    expect(c.gear).toBe(1);
    expect(c.speed).toBeGreaterThan(24);
    expect(c.vy).toBeGreaterThan(24);
    expect(c.r).toBeGreaterThan(.7);
    const hit = car(), untouched = car();
    pad(hit, 1, input(1)); untouched.loadState(state(hit));
    hit.setRoadVelocity(hit.vAlong - 8, hit.vLat + 3); hit.r -= .5;
    pad(hit, DT, input(0, .7)); pad(untouched, DT, input(0, .7));
    expect(Math.abs(hit.speed - untouched.speed)).toBeGreaterThan(3);
    expect(Math.abs(hit.r - untouched.r)).toBeGreaterThan(.3);
  });

  it('uses the same tyre forces in reverse and supports manual shift/refusal controls', () => {
    const c = car(0);
    pad(c, 4, input(0, 0, 1));
    expect(c.gear).toBe(0); expect(c.vx).toBeLessThan(-6); expect(c.vx).toBeGreaterThan(-8);
    expect(c.s).toBeLessThan(-15);
    pad(c, 3, input(0, 1));
    expect(c.gear).toBe(1); expect(c.vx).toBeGreaterThan(1);
    c.reset(0, 0, 8);
    c.step(DT, { ...input(), manual: true, shift: 1 }, 0);
    expect(c.gear).toBe(2); expect(c.shiftT).toBeGreaterThan(0);
    pad(c, 1, { ...input(), manual: true });
    expect(c.gear).toBe(2);
    c.reset(0, 0, r34Tune.gearTopKmh[1] * 1.15 / 3.6); c.gear = 3;
    c.step(DT, { ...input(), manual: true, shift: -1 }, 0);
    expect(c.gear).toBe(3); expect(c.shiftRefused).toBe(true);
    c.reset(0, 0, 0);
    c.step(DT, { ...input(0, 0), manual: true, shift: -1 }, 0);
    expect(c.gear).toBe(-1);
    pad(c, .2, { ...input(0, 0), manual: true });
    c.step(DT, { ...input(0, 0), manual: true, shift: -1 }, 0);
    expect(c.gear).toBe(0);
    pad(c, .2, { ...input(0, 0), manual: true });
    c.step(DT, { ...input(0, 0), manual: true, shift: 1 }, 0);
    expect(c.gear).toBe(-1);
    pad(c, .2, { ...input(0, 0), manual: true });
    c.step(DT, { ...input(0, 0), manual: true, shift: 1 }, 0);
    expect(c.gear).toBe(1);
  });

  it('neutral free-revs with no drive, drag, boost thrust or automatic pedal gear selection', () => {
    const c = car(20, { aeroDrag: 0, rollingRes: 0 });
    c.gear = -1; c.rpm = c.tune.idleRpm;
    const initialWheel = c.omega[2];
    pad(c, .6, { ...input(), manual: true, boost: true });
    expect(c.gear).toBe(-1);
    expect(c.rpm).toBeGreaterThan(7000);
    expect(c.speed).toBeCloseTo(20, 10);
    expect(c.omega[2]).toBeCloseTo(initialWheel, 10);
    expect(c.slipRear).toBeCloseTo(0, 10);
    expect(c.boostOn).toBe(false); expect(c.boost).toBe(1);
    const revs = c.rpm;
    pad(c, .25, { ...input(0, 0), manual: true });
    expect(c.rpm).toBeLessThan(revs - 100);
    expect(c.rpm).toBeGreaterThan(c.tune.idleRpm + 100);
    expect(c.speed).toBeCloseTo(20, 10);
    c.reset(0, 0, 0); c.gear = -1;
    pad(c, .3, input(0, 0, 1));
    expect(c.gear).toBe(-1); expect(c.speed).toBe(0);
    c.gear = 1;
    pad(c, .3, { ...input(0, 0, 1), manual: true });
    expect(c.gear).toBe(1); // Manual R requires first -> N -> R, not just the brake pedal.
  });

  it.each([1, 0])('held clutch disconnects forward/reverse drive and releases without a fake body kick, gear %s', gear => {
    const c = car(0);
    c.gear = gear;
    const gas: DriveInput = { ...input(0, gear === 0 ? 0 : 1, gear === 0 ? 1 : 0), manual: true, clutch: true, boost: true };
    pad(c, .5, gas);
    expect(c.gear).toBe(gear);
    expect(c.rpm).toBeGreaterThan(7000);
    expect(c.speed).toBe(0); expect(c.omega[2]).toBe(0);
    expect(c.boostOn).toBe(false);
    c.step(.00001, { ...gas, clutch: false }, 0);
    expect(c.speed).toBeLessThan(.001);
    expect(Math.abs(c.r)).toBeLessThan(1e-10);
    pad(c, .4, { ...gas, clutch: false, boost: false });
    expect(c.speed).toBeGreaterThan(.1);
    expect(c.vx * (gear === 0 ? -1 : 1)).toBeGreaterThan(0);
  });

  it.each([-1, 2])('disconnected wheel response is independent of crank inertia, gear %s', gear => {
    const light = car(25, { engineInertia: .05 }), heavy = car(25, { engineInertia: 2 });
    for (const c of [light, heavy]) { c.gear = gear; c.omega[2] *= .8; c.omega[3] *= .8; }
    const controls = { ...input(0, 0), manual: true, clutch: gear !== -1 };
    pad(light, .1, controls); pad(heavy, .1, controls);
    expect(light.omega).toEqual(heavy.omega);
    expect(light.vx).toBe(heavy.vx); expect(light.vy).toBe(heavy.vy); expect(light.r).toBe(heavy.r);
    expect(light.rpm).toBeLessThan(heavy.rpm);
  });

  it('total-speed reverse guard also protects manual N/R selection during a sideways collision', () => {
    const c = car(0, { gripFront: 0, gripRear: 0, aeroDrag: 0, rollingRes: 0 });
    c.gear = -1; c.vx = -1; c.vy = 25; c.r = .4;
    const before = [c.vAlong, c.vLat, c.r];
    c.step(DT, { ...input(0, 0, 1), manual: true, clutch: true, shift: -1 }, 0);
    expect(c.gear).toBe(-1); expect(c.shiftRefused).toBe(true);
    [c.vAlong, c.vLat, c.r].forEach((x, i) => expect(x).toBeCloseTo(before[i], 10));
    expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
  });

  it.each(['neutral', 'clutch'] as const)('offset-rewinds free engine RPM in %s and quantized clutch/gear changes exactly', mode => {
    const original = car(15), dirty = car(40);
    original.gear = mode === 'neutral' ? -1 : 2;
    pad(original, .4, { ...input(), manual: true, clutch: mode === 'clutch' });
    pad(dirty, .3, { ...input(-1), handbrake: true });
    const buffer = new Float64Array(64).fill(-7), offset = 5;
    expect(original.saveState(buffer, offset)).toBe(offset + original.stateSize);
    expect(dirty.loadState(Array.from(buffer), offset)).toBe(offset + original.stateSize);
    expect(buffer[offset - 1]).toBe(-7); expect(buffer[offset + original.stateSize]).toBe(-7);
    expect(state(dirty)).toEqual(state(original));
    for (let i = 0; i < 600; i++) {
      const controls: DriveInput = { ...input(i % 180 < 60 ? 1 : i % 180 < 120 ? -1 : 0, i % 240 < 180 ? 1 : 0),
        manual: true, clutch: i < 60 || i % 137 < 20, brake: i % 240 > 220 ? 1 : 0,
        shift: i === 120 ? 1 : i === 240 ? -1 : 0, boost: i % 400 < 30,
        tractionControlEnabled: i % 80 < 40, espEnabled: i % 160 < 80 };
      const packet = inputFromQ(quantizeInput(controls, { steer: 0, throttle: 0, brake: 0, flags: 0 }), input(0, 0));
      original.step(DT, packet, .001); dirty.step(DT, packet, .001);
      expect(state(dirty)).toEqual(state(original));
      expect(Array.from(state(original)).every(Number.isFinite)).toBe(true);
    }
  });

  it('boost acts through driven tyres; reserve/cosmetics work and never add grip-free thrust', () => {
    const c = car(40), normal = car(40);
    pad(c, 3, { ...input(), manual: true, boost: true, horn: true, blinker: 2 });
    pad(normal, 3, { ...input(), manual: true });
    expect(c.speed).toBeGreaterThan(normal.speed + 1);
    expect(c.boost).toBeCloseTo(.25, 9); expect(c.boostOn).toBe(true);
    expect(c.horn).toBe(true); expect(c.blinker).toBe(2);
    pad(c, 14, input(0, 0));
    expect(c.boost).toBeCloseTo(1, 9); expect(c.boostOn).toBe(false);
    expect(c.horn).toBe(false); expect(c.blinker).toBe(0);
    const ice = car(25, { gripFront: 0, gripRear: 0, aeroDrag: 0, rollingRes: 0 });
    pad(ice, 2, { ...input(), boost: true });
    expect(ice.speed).toBe(25); expect(ice.omega[2]).toBeGreaterThan(25 / ice.tune.wheelRadius);
  });

  it.each([-1, 1])('retains existing barrier response/cooldown on side %s', sign => {
    const c = car(30);
    c.d = sign * (WALL_D - c.halfExtentD() - .02);
    c.setRoadVelocity(30, sign * 5); c.step(DT, input(0, 0), 0);
    expect(c.wallSide).toBe(sign); expect(c.wallHit).toBe(true);
    expect(c.wallImpact).toBeGreaterThan(3); expect(c.vLat * sign).toBeLessThan(0);
    expect(Math.abs(c.d) + c.halfExtentD()).toBeLessThanOrEqual(WALL_D + 1e-9);
    c.setRoadVelocity(25, sign * 2); c.step(DT, input(0, 0), 0);
    expect(c.wallHit).toBe(false); expect(c.scrapeSide).toBe(sign);
  });

  it('serializes all memory with offsets, then replays mixed controls bit-exactly', () => {
    const original = car(); pad(original, 2, input(1));
    original.step(DT, { ...input(-1, .8), manual: true, horn: true, blinker: 2, handbrake: true }, .002);
    const buffer = new Float64Array(64).fill(-123);
    expect(original.stateSize).toBe(58);
    expect(original.stateSize).toBeLessThanOrEqual(64);
    expect(original.saveState(buffer, 3)).toBe(original.stateSize + 3);
    expect(buffer[2]).toBe(-123); expect(buffer[3 + original.stateSize]).toBe(-123);
    const clone = car(0);
    expect(clone.loadState(Array.from(buffer), 3)).toBe(original.stateSize + 3);
    expect(state(clone)).toEqual(state(original));
    for (let i = 0; i < 2400; i++) {
      const controls: DriveInput = { steer: i % 400 < 130 ? -1 : i % 400 < 260 ? 1 : 0,
        throttle: i % 500 < 350 ? 1 : 0, brake: i % 500 > 440 ? .7 : 0,
        handbrake: i % 333 < 18, boost: i % 700 < 120, manual: i % 600 < 300,
        shift: i % 181 === 0 ? 1 : i % 197 === 0 ? -1 : 0, horn: i % 99 < 3, blinker: i % 3,
        clutch: i % 137 < 23, tractionControlEnabled: i % 200 < 100, espEnabled: i % 400 < 200 };
      const quantized = inputFromQ(quantizeInput(controls, { steer: 0, throttle: 0, brake: 0, flags: 0 }), input(0, 0));
      expect(quantized.clutch).toBe(controls.clutch);
      expect(quantized.tractionControlEnabled).toBe(controls.tractionControlEnabled);
      expect(quantized.espEnabled).toBe(controls.espEnabled);
      const curve = Math.sin(i * .01) * .002;
      original.step(DT, quantized, curve); clone.step(DT, quantized, curve);
      expect(state(clone)).toEqual(state(original));
    }
    original.reset(0, 0, 25);
    expect(state(original)).toEqual(state(car()));
    const rev = car(0); pad(rev, 1, input(0, 0, 1)); clone.loadState(state(rev));
    rev.step(DT, input(1, 0, 1), 0); clone.step(DT, input(1, 0, 1), 0);
    expect(state(clone)).toEqual(state(rev));
  });

  it('converges at 30/60/120/240 Hz and ignores invalid intervals', () => {
    const results = [30, 60, 120, 240].map(hz => {
      const c = car();
      for (let i = 0; i < hz * 4; i++) { c.d = 0; c.step(1 / hz, input(i < hz * 2 ? 1 : -1), 0); }
      return c;
    });
    for (const c of results) {
      expect(c.speed).toBeCloseTo(results[2].speed, 2);
      expect(c.r).toBeCloseTo(results[2].r, 3);
      expect(Math.abs(c.s - results[2].s)).toBeLessThan(.02);
      expect(degrees(c)).toBeCloseTo(degrees(results[2]), 1);
    }
    const c = results[0], before = state(c);
    for (const dt of [0, -1, NaN, Infinity]) c.step(dt, input(-1), 0);
    expect(state(c)).toEqual(before);
  });

  it('stays finite at low speed, through spins, curves, walls and 12,000 mixed variable steps', () => {
    const c = car(45);
    let seed = 0x1234abcd;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    let controls = input();
    for (let i = 0; i < 12000; i++) {
      if (i % 37 === 0) controls = { steer: Math.round(random() * 2 - 1), throttle: random(), brake: random() > .8 ? random() : 0,
        handbrake: random() < .12, boost: random() < .2, analog: random() < .25, clutch: random() < .2,
        manual: random() < .5, shift: random() < .25 ? -1 : random() < .25 ? 1 : 0 };
      c.step([DT, 1 / 60, 1 / 30][i % 3], controls, Math.sin(i * .001) * .008);
      expect(Array.from(state(c)).every(Number.isFinite)).toBe(true);
      expect(c.speed).toBeLessThan(100); expect(Math.abs(c.r)).toBeLessThan(6);
      expect(Math.abs(c.d)).toBeLessThan(WALL_D);
      expect(c.gear).toBeGreaterThanOrEqual(-1); expect(c.gear).toBeLessThanOrEqual(r34Tune.gearTopKmh.length);
    }
  });

  it.each([9, 11, 42])('bounds collision prediction under latency/jitter/stalls and replays exactly, seed %s', seed => {
    const net = new NetSession(seed, {}, true), l = link(75, 40, .01);
    const c = net.add({ name: 'R34', physics: 2, car: 2, up: l, down: l, fps: 60, bot: { kmh: 220, weave: false, reckless: true } });
    const receive = c.core.receive.bind(c.core);
    let yawCorrection = 0;
    c.core.receive = (data, now) => {
      const heading = c.sim.player.psi, count = c.core.stats.corrections;
      receive(data, now);
      if (count !== c.core.stats.corrections) yawCorrection = Math.max(yawCorrection, Math.abs(c.sim.player.psi - heading));
    };
    net.run(60);
    expect(c.sim.player).toBeInstanceOf(R34Car);
    expect(c.localCrashes).toBeGreaterThan(0); expect(c.core.stats.snapshots).toBeGreaterThan(1500);
    // A stalled speculative contact can disagree with the real contact. Position is allowed
    // to reflect that uncertainty, without demanding arcade suppression of angular impulses.
    expect(c.core.stats.maxCorrection).toBeLessThan(2); expect(yawCorrection).toBeLessThan(.8);
    expect(replay(seed, {}, net.journal, net.server.world.tick).hash()).toBe(net.server.world.hash());
  }, 20000);
});

describe('R34 isolation from approved A45/Porsche defaults', () => {
  it('owns every mutable tune/gear array and leaves other defaults unchanged during live tuning', () => {
    for (const other of [carTune, driftTune, mercedesTune, porscheTune]) {
      expect(r34Tune).not.toBe(other); expect(r34Tune.gearTopKmh).not.toBe(other.gearTopKmh);
    }
    const before = [carTune, driftTune, mercedesTune, porscheTune].map(t => JSON.stringify(t));
    const saved = structuredClone(r34Tune);
    try {
      Object.assign(r34Tune, { powerKW: 700, mass: 1900, gripRear: .7, steerAssist: .2 });
      r34Tune.gearTopKmh[0] = 80;
      pad(car(), 3, input(1));
      expect([carTune, driftTune, mercedesTune, porscheTune].map(t => JSON.stringify(t))).toEqual(before);
    } finally { Object.assign(r34Tune, saved); }
  });
});
