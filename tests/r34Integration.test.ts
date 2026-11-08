import { afterEach, describe, expect, it } from 'vitest';
import { createCar } from '../src/sim/physics';
import { R34Car } from '../src/sim/vehicleR34';
import { driftTune } from '../src/sim/vehicleDrift';
import { applyTuning, defaultTuning } from '../src/sim/tuning';
import { NetSession, link } from './netsim';

afterEach(() => applyTuning(defaultTuning()));
describe('new R34 integration', () => {
  it('uses its isolated handling factory/tune and applies admin changes to existing instances only', () => {
    const defaults=defaultTuning(), legacy=structuredClone(driftTune), car=createCar(2);
    expect(car).toBeInstanceOf(R34Car);
    const custom=defaultTuning();custom.cars['2'].powerKW=600;custom.cars['2'].brakeDecel=18;
    applyTuning(custom);
    expect(car.tune.powerKW).toBe(600);expect(createCar(2).tune.brakeDecel).toBe(18);
    expect(driftTune).toEqual(legacy);
    for(const id of ['1','3','4'])expect(defaultTuning().cars[id]).toEqual(defaults.cars[id]);
    expect(createCar(3).tune.powerKW).toBe(defaults.cars['3'].powerKW);
    expect(createCar(4).tune.powerKW).toBe(defaults.cars['4'].powerKW);
  });
  it('replicates actual R34 wheel angles to observers instead of leaving their wheels straight', () => {
    const net=new NetSession(674,{traffic:1});
    net.server.configure({trafficOn:false});
    const drift=net.add({name:'R34',car:2,physics:2,up:link(0),down:link(0),fps:60,bot:{kmh:70,weave:false}});
    const observer=net.add({name:'Observer',car:3,physics:3,up:link(0),down:link(0),fps:60,bot:{kmh:70,weave:false}});
    drift.bot.drive=()=>({steer:.4,throttle:.6,brake:0});
    net.run(.8);
    const remote=observer.sim.remotes.find(c=>c.carId===2);
    expect(remote).toBeDefined();
    expect(Math.abs(remote!.car.steerAngle)).toBeGreaterThan(.01);
    const server=net.server.world.drivers.find(c=>c.body===2)!;
    expect(Math.abs(remote!.car.steerAngle-server.car.steerAngle)).toBeLessThan(.04);
    expect(drift.sim.player.stateSize).toBeLessThanOrEqual(64);
    expect(drift.core.ready).toBe(true);
  });
  it('keeps reverse gear zero on an observed R34 instead of converting it to first',()=>{
    const net=new NetSession(675);net.server.configure({trafficOn:false});
    const drift=net.add({name:'Reversing R34',car:2,physics:2,up:link(0),down:link(0),fps:60,bot:{kmh:10,weave:false}});
    const observer=net.add({name:'Observer',car:3,physics:3,up:link(0),down:link(0),fps:60,bot:{kmh:10,weave:false}});
    net.run(.2);
    const server=net.server.world.drivers.find(c=>c.body===2)!;
    // Set up an authoritative reverse snapshot; the driving/reverse entry itself has separate tests.
    server.car.reset(server.car.s,server.car.d,0);server.car.gear=0;server.car.vx=-2;
    drift.bot.drive=()=>({steer:0,throttle:0,brake:.4,manual:true});
    net.run(.15);
    expect(server.car.gear).toBe(0);
    expect(observer.sim.remotes.find(c=>c.carId===2)!.car.gear).toBe(0);
  });
});
