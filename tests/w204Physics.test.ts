import { afterEach, describe, expect, it, vi } from 'vitest';
import { W204Car, w204Tune, W204_GEARS, W204_FINAL_DRIVE } from '../src/sim/vehicleW204';
import { bodyPhysics, createCar, physicsId, PHYSICS } from '../src/sim/physics';
import { carId, CARS } from '../src/sim/cars';
import { currentTuning, defaultTuning, applyTuning, validateTuning } from '../src/sim/tuning';
import { restoreTuning } from '../server/restoreTuning';
import { loadCar, saveCar, loadPhysics, savePhysics, loadPaint, savePaint, loadCameraMode, saveCameraMode } from '../src/settings';
import { NetSession, link } from './netsim';

afterEach(() => { applyTuning(defaultTuning()); vi.unstubAllGlobals(); });

describe('default pre-facelift C63 AMG W204', () => {
  it('has distinct body/physics IDs without remapping any existing car', () => {
    expect(CARS.map(c => c.id)).toContain(4);
    expect(PHYSICS.map(c => c.id)).toContain(5);
    expect(carId(4)).toBe(4); expect(physicsId(5)).toBe(5);
    expect([1, 2, 3, 4].map(id => bodyPhysics(carId(id)))).toEqual([4, 2, 3, 5]);
    expect(createCar(5)).toBeInstanceOf(W204Car);
    expect([1, 2, 3, 4].map(id => createCar(physicsId(id)).physicsId)).toEqual([1, 2, 3, 4]);
  });

  it('derives seven redline speeds from the source gearbox and final drive', () => {
    expect(w204Tune.mass).toBe(1800); expect(w204Tune.frontDrive).toBe(0);
    expect(w204Tune.cgToFront + w204Tune.cgToRear).toBeCloseTo(2.76, 12);
    expect(w204Tune.gearTopKmh).toHaveLength(7);
    W204_GEARS.forEach((ratio, i) => {
      expect(w204Tune.gearTopKmh[i] / 3.6 / .325 * ratio * W204_FINAL_DRIVE * 30 / Math.PI).toBeCloseTo(7200, 9);
    });
    const c = new W204Car();
    expect(c.engineTorque(5000)).toBeCloseTo(610, 8);
    expect(c.engineTorque(1500)).toBeLessThan(c.engineTorque(4000));
    let peak = 0;
    for (let rpm = 750; rpm <= 7200; rpm += 10) peak = Math.max(peak, c.engineTorque(rpm) * rpm * Math.PI / 30000);
    expect(peak).toBeGreaterThan(330); expect(peak).toBeLessThanOrEqual(336.000001);
  });

  it('accelerates in the stock performance envelope and holds a straight line', () => {
    const c = new W204Car(); c.reset(0, 0, 0);
    let t100 = 0, t200 = 0;
    for (let i = 1; i <= 7200; i++) {
      c.step(1 / 120, { steer: 0, throttle: 1, brake: 0 }, 0);
      if (!t100 && c.vAlong * 3.6 >= 100) t100 = i / 120;
      if (!t200 && c.vAlong * 3.6 >= 200) t200 = i / 120;
    }
    expect(t100).toBeGreaterThan(4.2); expect(t100).toBeLessThan(5.3);
    expect(t200).toBeGreaterThan(13); expect(t200).toBeLessThan(17);
    expect(c.vAlong * 3.6).toBeGreaterThan(275); expect(c.vAlong * 3.6).toBeLessThan(295);
    expect(c.gear).toBeGreaterThanOrEqual(6); expect(Math.abs(c.d)).toBeLessThan(1e-8);
  });

  it('settles after a 220 km/h lane-change input without a lift-off spin', () => {
    const c = new W204Car(); c.reset(0, 0, 220 / 3.6);
    let maxSlip = 0;
    for (let i = 0; i < 300; i++) {
      c.step(1 / 120, { steer: i < 30 ? 1 : 0, throttle: i < 30 ? .3 : 0, brake: 0 }, 0);
      maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(c.vy, c.vx)));
    }
    expect(maxSlip).toBeLessThan(.06); expect(Math.abs(c.r)).toBeLessThan(.005);
    expect(c.d).toBeGreaterThan(2); expect(c.d).toBeLessThan(5);
  });

  it('brakes from 100 km/h without locking into a spin and reports the reverse ratio', () => {
    const c = new W204Car(); c.reset(0, 0, 100 / 3.6);
    for (let i = 0; i < 1200 && c.vAlong > .1; i++) c.step(1 / 120, { steer: 0, throttle: 0, brake: 1 }, 0);
    expect(c.vAlong).toBeLessThan(.1); expect(c.s).toBeGreaterThan(28); expect(c.s).toBeLessThan(38);
    expect(Math.abs(c.d)).toBeLessThan(1e-8);
    c.reset(0, 0, 0); c.gear = 0;
    for (let i = 0; i < 240; i++) c.step(1 / 120, { steer: 0, throttle: 1, brake: 0, manual: true }, 0);
    expect(c.vx).toBeLessThan(-1);
    expect(c.rpm).toBeCloseTo(Math.max(750, Math.abs(c.vx) / .325 * 3.41 * 3.231 * 30 / Math.PI), 8);
  });

  it('replays saved state exactly through shifts, braking and assistance changes', () => {
    const a = createCar(5); a.reset(100, 0, 100 / 3.6);
    for (let i = 0; i < 180; i++) a.step(1 / 120, { steer: .1, throttle: 1, brake: 0 }, 1 / 1500);
    const state = new Float64Array(a.stateSize); a.saveState(state);
    const b = createCar(5); b.loadState(state);
    for (let i = 0; i < 600; i++) {
      const input = { steer: Math.sin(i * .04) * .3, throttle: i < 300 ? 1 : 0, brake: i >= 300 ? .7 : 0,
        tractionControlEnabled: i < 200, espEnabled: i < 400 };
      a.step(1 / 120, input, 1 / 1500); b.step(1 / 120, input, 1 / 1500);
    }
    const sa = new Float64Array(a.stateSize), sb = new Float64Array(b.stateSize);
    a.saveState(sa); b.saveState(sb); expect([...sb]).toEqual([...sa]);
    expect([...sa].every(Number.isFinite)).toBe(true);
  });

  it('accepts W204 tuning and upgrades saved catalogues without resetting existing cars', () => {
    const old = defaultTuning(); delete old.cars['5']; old.cars['3'].powerKW = 700;
    const before = structuredClone(old), restored = restoreTuning(old);
    expect(old).toEqual(before); expect(restored.cars['5']).toEqual(defaultTuning().cars['5']);
    for (const id of ['1', '2', '3', '4']) expect(restored.cars[id]).toEqual(old.cars[id]);
    restored.cars['5'].powerKW = 350;
    applyTuning(validateTuning(restored));
    expect(createCar(5).tune.powerKW).toBe(350); expect(currentTuning().cars['5'].powerKW).toBe(350);
  });

  it('remembers W204 selection, paint and camera independently', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
    saveCar(4); savePhysics(5); savePaint(0xabcdef, 4); saveCameraMode(4, 'hood');
    savePaint(0x112233, 2); saveCameraMode(2, 'far');
    expect(loadCar()).toBe(4); expect(loadPhysics()).toBe(5);
    expect(loadPaint(4)).toBe(0xabcdef); expect(loadCameraMode(4)).toBe('hood');
    expect(loadPaint(2)).toBe(0x112233); expect(loadCameraMode(2)).toBe('far');
  });

  it('keeps W204 on server, owner prediction and remote prediction through reconnect', () => {
    const net = new NetSession(204);
    const spec = { name: 'W204', physics: 5 as const, car: 4 as const, up: link(25, 5), down: link(25, 5), fps: 60, bot: { kmh: 160, weave: false } };
    const owner = net.add(spec), observer = net.add({ ...spec, name: 'Observer', physics: 3, car: 3 });
    net.run(5);
    const driver = net.server.world.drivers.find(d => d.id === owner.core.id)!;
    expect(driver.physics).toBe(5); expect(driver.body).toBe(4); expect(driver.car).toBeInstanceOf(W204Car);
    expect(owner.sim.player).toBeInstanceOf(W204Car);
    const remote = observer.sim.remotes.find(r => r.id === owner.core.id)!;
    expect(remote.carId).toBe(4); expect(remote.car).toBeInstanceOf(W204Car);
    expect(owner.core.stats.maxCorrection).toBeLessThan(.5);
    const token = owner.core.token; owner.drop(); owner.open(token); net.run(2);
    expect(owner.sim.player.physicsId).toBe(5);
    expect(net.server.world.drivers.find(d => d.id === owner.core.id)?.body).toBe(4);
  });
});
