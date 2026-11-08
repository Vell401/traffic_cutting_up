import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTuning, currentTuning, defaultTuning, tuningFields } from '../src/sim/tuning';
import { restoreTuning } from '../server/restoreTuning';
import { createCar } from '../src/sim/physics';
import { driftTune } from '../src/sim/vehicleDrift';
import { R34Car } from '../src/sim/vehicleR34';
import { NetSession, link } from './netsim';

afterEach(()=>applyTuning(defaultTuning()));
describe('R34 is the only replaced vehicle',()=>{
  it('retains the exact original saved schemas/defaults of Grip, A45 and Porsche',()=>{
    const defaults=defaultTuning();
    for(const[id,expected]of Object.entries({
      '1':'69bacd43a311f9bd24b487795a949f11997e09cb365e0ceba92e928adef023eb',
      '3':'4f9a6dded936a8a433be6df6dbdb3aac17e893304099ea7d6a021c7d34c5bb64',
      '4':'b9ee089ee5c5afd3875d6898f2a3a8efbf0d7ac2e1af6aeb6b705a0fcc2446e3',
    })){
      expect(createHash('sha256').update(JSON.stringify(defaults.cars[id])).digest('hex'),id).toBe(expected);
      expect(tuningFields(id).some(f=>f.key==='steerAssist')).toBe(false);
    }
  });
  it('applies R34 settings to its existing instances without changing the inherited legacy tune',()=>{
    const old=structuredClone(driftTune),before=currentTuning(),car=createCar(2);
    expect(car).toBeInstanceOf(R34Car);
    const next=defaultTuning();next.cars['2'].powerKW=500;next.cars['2'].steerAssist=.5;
    applyTuning(next);
    expect(car.tune.powerKW).toBe(500);expect((car as R34Car).tune.steerAssist).toBe(.5);
    expect(driftTune).toEqual(old);
    for(const id of ['1','3','4'])expect(currentTuning().cars[id]).toEqual(before.cars[id]);
  });
  it('accepts the exact 55-degree mechanical lock in the admin form without changing other cars input steps',()=>{
    expect(tuningFields('2').find(f=>f.key==='maxSteerLow')!.step).toBe('any');
    for(const id of ['1','3','4'])expect(tuningFields(id).find(f=>f.key==='maxSteerLow')!.step).toBe(.01);
  });
  it('does not reject unchanged imported R34 coefficients through browser step mismatch',()=>{
    const defaults=defaultTuning().cars['2'];
    for(const field of tuningFields('2')){
      const value=defaults[field.key];if(value===undefined||field.step==='any')continue;
      const steps=(value-field.min)/field.step;
      expect(Math.abs(steps-Math.round(steps)),field.key).toBeLessThan(1e-7);
    }
  });
  it('exposes the actual new rack controls, not unused legacy stability/front-drive fields',()=>{
    const fields=tuningFields('2').map(f=>f.key);
    for(const key of ['mechanicalTrail','rackInertia','rackCentering'])expect(fields).toContain(key);
    for(const key of ['brakeAssist','frontDrive','escAssist','yawAssist','tireB','tireC'])expect(fields).not.toContain(key);
  });
  it('preserves customised other cars and traffic across both old R34 migrations and later restarts',()=>{
    for(const revision of [undefined,1,2]){
      const value=defaultTuning();value.r34Revision=revision;
      value.cars['2']={mass:2500,powerKW:1100};value.cars['3'].powerKW=700;value.cars['4'].brakeDecel=19;
      value.traffic.lanes[0]=[100,110];const before=structuredClone(value);
      const restored=restoreTuning(value);restored.cars['2'].steerAssist=.6;
      expect(restoreTuning(restored)).toEqual(restored);
      for(const id of ['1','3','4'])expect(restored.cars[id]).toEqual(before.cars[id]);
      expect(restored.traffic).toEqual(before.traffic);
    }
  });
  it('replicates physical countersteer to observers without altering other vehicle steering encoding',()=>{
    const net=new NetSession(675);net.server.configure({trafficOn:false});
    const r34=net.add({name:'R34',car:2,physics:2,up:link(0),down:link(0),fps:60,bot:{kmh:70,weave:false}});
    const observer=net.add({name:'AMG',car:3,physics:3,up:link(0),down:link(0),fps:60,bot:{kmh:70,weave:false}});
    r34.bot.drive=()=>({steer:.7,throttle:.5,brake:0});net.run(.6);
    const server=net.server.world.drivers.find(d=>d.body===2)!;
    const remote=observer.sim.remotes.find(d=>d.carId===2)!;
    expect(Math.abs(remote.car.steerAngle)).toBeGreaterThan(.01);
    expect(Math.abs(remote.car.steerAngle-server.car.steerAngle)).toBeLessThan(.04);
    expect(r34.core.ready).toBe(true);expect(r34.sim.player.stateSize).toBeLessThanOrEqual(64);
  });
});
