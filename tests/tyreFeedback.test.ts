import { describe, expect, it } from 'vitest';
import { createTyreFeedback, sampleTyreFeedback } from '../src/presentation/tyres';
import { PlayerCar } from '../src/sim/vehicle';
import { R34Car } from '../src/sim/vehicleR34';
import { DriftCar } from '../src/sim/vehicleDrift';
import { PorscheCar } from '../src/sim/vehiclePorsche';
import { MercedesCar } from '../src/sim/vehicleMercedes';
import { W204Car } from '../src/sim/vehicleW204';

describe('shared read-only tyre presentation telemetry', () => {
  it('reuses all four wheel objects and leaves a deeply frozen source/state untouched', () => {
    const car = new R34Car({ ...new R34Car().tune }); car.reset(0, 0, 20);
    car.steerAngle = .1; car.r = .2; car.vy = 1;
    const before = new Float64Array(car.stateSize); car.saveState(before);
    Object.freeze(car.tune); Object.freeze(car.omega); Object.freeze(car.keySpring); Object.freeze(car);
    const out = createTyreFeedback(), wheels = [...out.wheels];
    for (let i = 0; i < 1000; i++) expect(sampleTyreFeedback(car, out)).toBe(out);
    expect(out.wheels).toEqual(wheels);
    out.wheels.forEach((w, i) => expect(w).toBe(wheels[i]));
    const after = new Float64Array(car.stateSize); car.saveState(after);
    expect(after).toEqual(before);
  });

  it('reads actual R34 FL FR RL RR omega, including a single locked front', () => {
    const car = new R34Car(); car.reset(0, 0, 20);
    car.omega[0] = 0; car.omega[1] = 50; car.omega[2] = 80; car.omega[3] = 95;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.wheels.map(w => w.omega)).toEqual([0, 50, 80, 95]);
    expect(out.wheels[0].longitudinalSlipSpeed).toBe(-20);
    expect(out.wheels[0].slipIntensity).toBeGreaterThan(.9);
  });

  it('reads observer visualWheelOmega before axle fallback and unstepped remote R34 native omega', () => {
    const remote = Object.assign(new PlayerCar(), { visualWheelOmega: Object.freeze([-10, -11, 80, 90]), omegaF: 2, omegaR: 3 });
    const out = sampleTyreFeedback(remote, createTyreFeedback());
    expect(out.wheels.map(w => w.omega)).toEqual([-10, -11, 80, 90]);
    const overlay = new Float64Array([0, 0, 80, 90]);
    const remoteR34 = Object.assign(new R34Car(), { visualWheelOmega: overlay });
    remoteR34.vx = 12;
    expect(remoteR34.omega).toEqual([0, 0, 0, 0]);
    sampleTyreFeedback(remoteR34, out);
    expect(out.wheels.map(w => w.omega)).toEqual([0, 0, 80, 90]);
    expect(out.wheels[2].rollingSpeed).toBeCloseTo(80 * remoteR34.tune.wheelRadius);
    expect(remoteR34.omega).toEqual([0, 0, 0, 0]);
    expect(remoteR34.visualWheelOmega).toBe(overlay);
    expect([...overlay]).toEqual([0, 0, 80, 90]);
    const local = new R34Car(); local.reset(0, 0, 20); local.omega[2] = 95;
    sampleTyreFeedback(local, out);
    expect(out.wheels.map(w => w.omega)).toEqual(local.omega);
    expect(remote.visualWheelOmega).toEqual([-10, -11, 80, 90]);
  });

  it('accepts persistent typed-array observer telemetry and falls back conservatively when absent', () => {
    const remote: PlayerCar & { visualWheelOmega?: ArrayLike<number> } = new PlayerCar();
    remote.reset(0, 0, -6);
    const telemetry = new Float64Array([-10, -11, -12, -13]);
    remote.visualWheelOmega = telemetry;
    const out = sampleTyreFeedback(remote, createTyreFeedback());
    expect(out.wheels.map(w => w.omega)).toEqual([-10, -11, -12, -13]);
    expect(remote.visualWheelOmega).toBe(telemetry);
    expect([...telemetry]).toEqual([-10, -11, -12, -13]);
    delete remote.visualWheelOmega;
    sampleTyreFeedback(remote, out);
    expect(out.squealIntensity).toBe(0);
    expect(out.wheels.every(w => w.omega < 0 && w.longitudinalSlipSpeed === 0)).toBe(true);
  });

  it.each([DriftCar, PorscheCar, MercedesCar, W204Car])('reads legacy %s axle telemetry', Car => {
    const car = new Car(); car.reset(0, 0, 12); car.omegaF = 22; car.omegaR = 85;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.wheels.map(w => w.omega)).toEqual([22, 22, 85, 85]);
    expect(out.wheels[2].rollingSpeed).toBeCloseTo(85 * car.tune.wheelRadius);
  });

  it('keeps clean reverse rolling signed and silent', () => {
    const car = new R34Car(); car.reset(0, 0, -6);
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.speed).toBe(6);
    for (const w of out.wheels) {
      expect(w.omega).toBeLessThan(0); expect(w.contactLongitudinal).toBe(-6);
      expect(w.longitudinalSlipSpeed).toBeCloseTo(0); expect(w.slipIntensity).toBe(0);
    }
  });

  it('detects a reverse lock from actual omega with the correct signed slip', () => {
    const car = new R34Car(); car.reset(0, 0, -6); car.omega[2] = 0;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.wheels[2].longitudinalSlipSpeed).toBe(6);
    expect(out.wheels[2].slipIntensity).toBeGreaterThan(.8);
    expect(out.wheels[3].slipIntensity).toBe(0);
  });

  it('uses steered contact coordinates and yaw velocity at all four contact patches', () => {
    const car = new R34Car(); car.reset(0, 0, 18); car.r = .5; car.vy = 2; car.steerAngle = .3;
    const out = sampleTyreFeedback(car, createTyreFeedback()), t = car.tune;
    const u = 18 + .5 * t.trackWidth / 2, v = 2 + .5 * t.cgToFront;
    expect(out.wheels[0].contactLongitudinal).toBeCloseTo(u * Math.cos(.3) + v * Math.sin(.3));
    expect(out.wheels[0].contactLateral).toBeCloseTo(-u * Math.sin(.3) + v * Math.cos(.3));
    expect(out.wheels[2].contactLateral).toBeCloseTo(2 - .5 * t.cgToRear);
    expect(out.wheels[0].contactLongitudinal).not.toBe(out.wheels[1].contactLongitudinal);
  });

  it('detects front scrub even with a straight body velocity and no rear slip', () => {
    const car = new R34Car(); car.reset(0, 0, 25); car.steerAngle = .25;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.wheels[0].slipIntensity).toBeGreaterThan(.8);
    expect(out.wheels[2].slipIntensity).toBe(0);
  });

  it('retains stationary rear burnout and smoke, but no smoke for static pedals', () => {
    const car = new R34Car(); car.reset(0, 0, 0); car.brake = 1; car.handbrake = true;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.squealIntensity).toBe(0);
    car.omega[2] = car.omega[3] = 90;
    sampleTyreFeedback(car, out);
    expect(out.speed).toBe(0); expect(out.wheels[2].slipIntensity).toBeGreaterThan(.8);
    expect(out.wheels[2].smokeIntensity).toBeGreaterThan(.8);
    expect(out.slipPower).toBeGreaterThan(100000);
  });

  it('arcade fallback never fabricates lock from brake or handbrake', () => {
    const car = new PlayerCar(); car.reset(0, 0, -6); car.brake = 1; car.handbrake = true;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.squealIntensity).toBe(0);
    expect(out.wheels.every(w => w.omega < 0 && w.longitudinalSlipSpeed === 0)).toBe(true);
  });

  it('load estimate conserves weight and captures lagged transfer without writing the tune', () => {
    const car = new R34Car(); car.reset(0, 0, 20); car.axLag = 5; car.ayLag = 8;
    const tuneBefore = JSON.stringify(car.tune), out = sampleTyreFeedback(car, createTyreFeedback());
    expect(out.wheels.reduce((n, w) => n + w.normalLoad, 0)).toBeCloseTo(car.tune.mass * 9.81);
    expect(out.wheels[0].normalLoad).toBeGreaterThan(out.wheels[1].normalLoad);
    expect(out.wheels[2].normalLoad + out.wheels[3].normalLoad).toBeGreaterThan(car.tune.mass * 9.81 * car.tune.cgToFront / (car.tune.cgToFront + car.tune.cgToRear));
    expect(JSON.stringify(car.tune)).toBe(tuneBefore);
  });

  it('clears reused output completely after motion stops', () => {
    const car = new R34Car(); car.reset(0, 0, 20); car.omega[2] = 140;
    const out = sampleTyreFeedback(car, createTyreFeedback());
    car.reset(0, 0, 0); sampleTyreFeedback(car, out);
    expect(out.slipPower).toBe(0); expect(out.squealIntensity).toBe(0);
    expect(out.wheels.every(w => w.smokeIntensity === 0 && w.omega === 0)).toBe(true);
  });
});
