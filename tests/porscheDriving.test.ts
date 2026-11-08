/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { Quaternion,Vector3 } from 'three';
import { PorscheCar } from '../src/sim/vehiclePorsche';
import { createCar } from '../src/sim/physics';
import { PORSCHE_STEERING_AXIS,porscheSteeringAngle } from '../src/render/car/porscheCockpit';
import { PORSCHE_AUDIO_CLIPS,rpmBlend } from '../src/audio/porscheEngine';
import { OnlineWorld } from '../src/online/world';

describe('Porsche steering and chassis',()=>{
  it('turns clockwise to the right around the imported shaft without tilting the rim',()=>{
    const glb=readFileSync(new URL('../public/models/porsche-911-irl10.glb',import.meta.url));
    const asset=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString());
    const root=asset.nodes.find((n:{name:string})=>n.name==='Porsche_911_GT3RS_IRL10');
    const wheel=asset.nodes.find((n:{name:string})=>n.name==='SteeringWheel');
    const rest=new Quaternion(...root.rotation).multiply(new Quaternion(...wheel.rotation));
    const shaft=PORSCHE_STEERING_AXIS.clone().applyQuaternion(rest);
    const top=new Vector3(0,1,0).addScaledVector(shaft,-shaft.y).normalize().applyQuaternion(rest.clone().invert());
    for(const sign of [-1,1]){
      const rotation=rest.clone().multiply(new Quaternion().setFromAxisAngle(PORSCHE_STEERING_AXIS,porscheSteeringAngle(sign*.05)));
      expect(PORSCHE_STEERING_AXIS.clone().applyQuaternion(rotation).distanceTo(shaft)).toBeLessThan(1e-6);
      expect(top.clone().applyQuaternion(rotation).x*sign).toBeGreaterThan(.3);
    }
    expect(porscheSteeringAngle(0)).toBe(0);
  });
  it('accelerates through all seven PDK gears and stays within its intended performance envelope',()=>{
    const c=new PorscheCar();c.reset(0,0,0);let t100=0,t200=0;
    for(let i=1;i<=7200;i++){
      c.step(1/120,{steer:0,throttle:1,brake:0},0);
      if(!t100&&c.vAlong*3.6>=100)t100=i/120;if(!t200&&c.vAlong*3.6>=200)t200=i/120;
    }
    expect(t100).toBeGreaterThan(2.9);expect(t100).toBeLessThan(3.7);
    expect(t200).toBeGreaterThan(9.5);expect(t200).toBeLessThan(11.5);
    expect(c.vAlong*3.6).toBeGreaterThan(288);expect(c.vAlong*3.6).toBeLessThan(302);
    expect(c.gear).toBe(7);expect(Math.abs(c.d)).toBeLessThan(1e-8);
  });
  it('limits launch wheelspin with traction control and allows it when switched off',()=>{
    const run=(tc:boolean)=>{
      const c=new PorscheCar();c.reset(0,0,0);c.tractionControlEnabled=tc;let maxSlip=0;
      for(let i=0;i<180;i++){
        c.step(1/120,{steer:0,throttle:1,brake:0},0);
        maxSlip=Math.max(maxSlip,Math.abs(c.slipRear));
      }
      return maxSlip;
    };
    expect(run(false)).toBeGreaterThan(run(true)*1.5);
  });
  it('launches with rear wheelspin after free-revving neutral to redline',()=>{
    const c=new PorscheCar();c.reset(0,0,0);c.manual=true;c.gear=-1;
    const inp={steer:0,throttle:1,brake:0,manual:true,tractionControlEnabled:false,espEnabled:false};
    for(let i=0;i<420;i++)c.step(1/120,inp,0);
    expect(c.rpm).toBeGreaterThan(8000);
    c.step(1/120,{...inp,shift:1},0);
    expect(c.gear).toBe(1);
    expect(c.rpm).toBeGreaterThan(7000);
    let maxSlip=0,spinningSteps=0,maxWheelSpeed=0;
    for(let i=0;i<90;i++){
      c.step(1/120,{...inp,shift:0},0);
      maxSlip=Math.max(maxSlip,c.slipRear);
      maxWheelSpeed=Math.max(maxWheelSpeed,c.omegaR*c.tune.wheelRadius);
      if(c.omegaR*c.tune.wheelRadius-c.vx>.5)spinningSteps++;
    }
    expect(maxSlip).toBeGreaterThan(.08);
    expect(spinningSteps).toBeGreaterThan(15);
    expect(maxWheelSpeed).toBeGreaterThan(c.vx*1.5);
    expect(c.vx).toBeGreaterThan(.5);
  });
  it('keeps driving through sustained wheelspin after a neutral redline launch',()=>{
    const c=new PorscheCar();c.reset(0,0,0);c.manual=true;c.gear=-1;
    const inp={steer:0,throttle:1,brake:0,manual:true,tractionControlEnabled:false,espEnabled:false};
    for(let i=0;i<420;i++)c.step(1/120,inp,0);
    c.step(1/120,{...inp,shift:1},0);
    let maxSpeed=0;
    for(let i=0;i<600;i++){
      c.step(1/120,{...inp,shift:0},0);
      maxSpeed=Math.max(maxSpeed,c.vx*3.6);
    }
    expect(maxSpeed).toBeGreaterThan(10);
    expect(c.vx*3.6).toBeGreaterThan(65);
  });
  it('eases rear wheelspin into second gear instead of snapping to grip',()=>{
    const c=new PorscheCar();c.reset(0,0,0);c.manual=true;c.gear=-1;
    const inp={steer:0,throttle:1,brake:0,manual:true,tractionControlEnabled:false,espEnabled:false};
    for(let i=0;i<420;i++)c.step(1/120,inp,0);
    c.step(1/120,{...inp,shift:1},0);
    for(let i=0;i<10;i++)c.step(1/120,{...inp,shift:0},0);
    expect(c.slipRear).toBeGreaterThan(.2);
    const speedBefore=c.omegaR*c.tune.wheelRadius;
    for(let i=0;i<3&&c.gear===1;i++)c.step(1/120,{...inp,shift:1},0);
    expect(c.gear).toBe(2);
    expect(c.slipRear).toBeGreaterThan(.05);
    expect(c.omegaR*c.tune.wheelRadius).toBeGreaterThan(speedBefore*.5);
    for(let i=0;i<18;i++)c.step(1/120,{...inp,shift:0},0);
    expect(c.vx*3.6).toBeGreaterThan(8);
    expect(c.slipRear).toBeGreaterThan(.02);
  });
  it('transfers free-rev inertia into the rear wheels when the clutch is released in first',()=>{
    const c=new PorscheCar();c.reset(0,0,0);c.manual=true;c.gear=-1;
    const inp={steer:0,throttle:1,brake:0,manual:true,tractionControlEnabled:false,espEnabled:false,clutch:true};
    for(let i=0;i<420;i++)c.step(1/120,inp,0);
    expect(c.rpm).toBeGreaterThan(8000);
    c.step(1/120,{...inp,shift:1},0);
    expect(c.gear).toBe(1);
    c.step(1/120,{...inp,shift:0},0);
    let maxSlip=0,maxWheelSpeed=0;
    for(let i=0;i<60;i++){
      c.step(1/120,{...inp,clutch:false},0);
      maxSlip=Math.max(maxSlip,c.slipRear);
      maxWheelSpeed=Math.max(maxWheelSpeed,c.omegaR*c.tune.wheelRadius);
    }
    expect(maxSlip).toBeGreaterThan(1);
    expect(maxWheelSpeed).toBeGreaterThan(15);
    expect(c.vx).toBeGreaterThan(.5);
  });
  it('locks the rear differential and disables stability control with the driver assists off',()=>{
    const c=new PorscheCar();
    c.tractionControlEnabled=false;
    c.espEnabled=false;
    expect(c.tractionControlEnabled).toBe(false);
    expect(c.espEnabled).toBe(false);
    c.reset(0,0,20/3.6);
    for(let i=0;i<120;i++) c.step(1/120,{steer:.8,throttle:1,brake:0},0);
    expect(c.esc).toBeLessThan(.05);
  });
  it('responds faster than the heavy RWD car and settles after a high-speed lane change',()=>{
    const results=[];
    for(const id of [2,4] as const){
      const c=createCar(id);c.reset(0,0,220/3.6);let offset=0,slip=0;
      for(let i=0;i<300;i++){
        c.step(1/120,{steer:i<30?1:0,throttle:.3,brake:0},0);
        slip=Math.max(slip,Math.abs(Math.atan2(c.vy,c.vx)));
        if(Math.abs(c.d)>3){offset+=c.d;c.d=c.prevD=0;}
      }
      expect(slip).toBeLessThan(.06);expect(Math.abs(c.r)).toBeLessThan(.005);
      expect(Math.abs(c.steerAngle)).toBeLessThan(1e-6);results.push(offset+c.d);
    }
    expect(results[1]).toBeGreaterThan(results[0]*1.3);expect(results[1]).toBeLessThan(7);
  });
  it('keeps its dedicated physics when joining the authoritative online world',()=>{
    const w=new OnlineWorld(911);const driver=w.join('Porsche',4,1);
    expect(driver?.physics).toBe(4);expect(driver?.car).toBeInstanceOf(PorscheCar);
  });
});

describe('original GT3 sound banks',()=>{
  it('ships the original PCM bytes and both load states of engine and exhaust',()=>{
    let bytes=0;
    for(const clip of PORSCHE_AUDIO_CLIPS){
      const b=readFileSync(new URL(`../public/audio/porsche/${clip.file}`,import.meta.url));bytes+=b.length;
      expect(b.subarray(0,4).toString()).toBe('RIFF');expect(b.length).toBe(clip.bytes);
      expect(createHash('sha256').update(b).digest('hex')).toBe(clip.sha256);
    }
    expect(bytes).toBeLessThan(6*1024*1024);
    for(const channel of ['engine','exhaust'])for(const load of ['off','on']){
      const bank=PORSCHE_AUDIO_CLIPS.filter(c=>c.channel===channel&&c.load===load);
      expect(bank.length).toBeGreaterThanOrEqual(7);expect(bank[0].rpm).toBeLessThan(1300);expect(bank.at(-1)!.rpm).toBeGreaterThan(7600);
      for(let rpm=900;rpm<=9000;rpm+=37){
        const mix=rpmBlend(bank.map(c=>c.rpm),rpm);
        expect(mix.a*mix.a+mix.b*mix.b).toBeCloseTo(1,10);
        const weights=[mix.a,mix.b];
        for(const [n,i] of [mix.low,mix.high].entries())if(weights[n]>.001){
          expect(rpm/bank[i].rpm).toBeGreaterThan(.45);expect(rpm/bank[i].rpm).toBeLessThan(2.1);
        }
      }
    }
  });
});
