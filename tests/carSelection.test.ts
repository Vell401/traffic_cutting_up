import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import type { ServerMsg } from '../src/online/protocol';
import type { PhysicsId } from '../src/sim/physics';
import type { CarId } from '../src/sim/cars';
import { MercedesCar } from '../src/sim/vehicleMercedes';
import { PorscheCar } from '../src/sim/vehiclePorsche';

function enter(game:GameServer,physics:PhysicsId,car:CarId,token?:string){
  const messages:ServerMsg[]=[];let closed=false;
  const connection=game.connect({send(data){if(typeof data==='string')messages.push(JSON.parse(data));},close(){closed=true;},buffered:0});
  connection.receive(JSON.stringify({t:'hello',v:PROTOCOL_VERSION,rules:rulesHash(),name:'Vehicle switch',physics,car,seq:0,token}));
  const welcome=messages.find((m):m is Extract<ServerMsg,{t:'welcome'}>=>m.t==='welcome');
  if(!welcome)throw new Error('Expected welcome: '+JSON.stringify(messages));
  const driver=game.world.drivers.find(d=>d.id===welcome.id)!;
  return{connection,welcome,driver,closed:()=>closed};
}

describe('online vehicle selection does not inherit a different car physics',()=>{
  for(const[physics,body,Type]of[[3,3,MercedesCar],[4,1,PorscheCar]]as const){
    it(`restores the selected physics ${physics} after an R34 session token`,()=>{
      let n=0;const game=new GameServer({seed:14,token:()=>`switch-${++n}`});
      const r34=enter(game,2,2);r34.connection.close();
      const selected=enter(game,physics,body,r34.welcome.token);
      expect(selected.driver.physics).toBe(physics);expect(selected.driver.body).toBe(body);
      expect(selected.driver.car).toBeInstanceOf(Type);
      expect(selected.welcome.token).not.toBe(r34.welcome.token);
      expect(game.world.drivers).toHaveLength(1);
    });
  }
  it('keeps the same car, position, score and token on a genuine same-physics reconnect',()=>{
    const game=new GameServer({seed:15});const before=enter(game,3,3);
    before.driver.car.s+=30;before.driver.score.score=123;
    const s=before.driver.car.s;before.connection.close();
    const after=enter(game,3,3,before.welcome.token);
    expect(after.driver).toBe(before.driver);expect(after.driver.car.s).toBe(s);
    expect(after.driver.score.score).toBe(123);expect(after.welcome.token).toBe(before.welcome.token);
  });
  it('frees the previous slot even on a full server and does not replace another driver',()=>{
    let n=0;const game=new GameServer({seed:16,rules:{maxPlayers:2},token:()=>`switch-${++n}`});
    const r34=enter(game,2,2),other=enter(game,4,1);
    const amg=enter(game,3,3,r34.welcome.token);
    expect(r34.closed()).toBe(true);expect(other.closed()).toBe(false);
    expect(other.driver.car).toBeInstanceOf(PorscheCar);expect(amg.driver.car).toBeInstanceOf(MercedesCar);
    expect(game.world.drivers).toHaveLength(2);expect(game.world.drivers).toContain(other.driver);
  });
});
