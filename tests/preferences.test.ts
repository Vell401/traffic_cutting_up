import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMouseSens, loadPaint, saveMouseSens, savePaint, loadScoreDistortion, saveScoreDistortion } from '../src/settings';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { replay, type Stimulus } from '../src/online/world';
import type { ServerMsg } from '../src/online/protocol';

afterEach(() => vi.unstubAllGlobals());
describe('driver preferences', () => {
  it('disables distortion by default and persists only bounded levels', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
    expect(loadScoreDistortion()).toBe(0);
    saveScoreDistortion(.4);
    expect(loadScoreDistortion()).toBe(.4);
    saveScoreDistortion(2);
    expect(loadScoreDistortion()).toBe(1);
    data.set('tcu.effects.distortion', 'NaN');
    expect(loadScoreDistortion()).toBe(0);
  });
  it('defaults to 0.3x, accepts 0.05x and restores valid saved settings', () => {
    const data = new Map<string,string>();
    vi.stubGlobal('localStorage', { getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => data.set(k,v) });
    expect(loadMouseSens()).toBe(.3);
    saveMouseSens(.05); expect(loadMouseSens()).toBe(.05);
    for (const value of ['garbage','0','4','Infinity']) { data.set('tcu.mouseSens',value); expect(loadMouseSens()).toBe(.3); }
    savePaint(0); expect(loadPaint()).toBe(0);
    savePaint(0xa233ee); expect(loadPaint()).toBe(0xa233ee);
    data.set('tcu.paint','#nope'); expect(loadPaint()).toBe(0x1f4fd8);
  });
  it('works when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => {throw Error('blocked');}, setItem: () => {throw Error('blocked');} });
    expect(loadMouseSens()).toBe(.3); expect(loadPaint()).toBe(0x1f4fd8);
    expect(() => {saveMouseSens(.1);savePaint(0xff0000);}).not.toThrow();
  });
});

describe('online paint', () => {
  it('broadcasts chosen paint, preserves it on reconnect, validates input and replays changes', () => {
    const journal: Stimulus[] = [], messages: ServerMsg[] = [];
    let token=0;
    const server = new GameServer({seed:42,journal:s=>journal.push(s),token:()=>`paint-${++token}`});
    const peer = () => ({ buffered:0, send:(data:Uint8Array|string)=>{if(typeof data==='string')messages.push(JSON.parse(data));}, close:()=>{} });
    const hello = (color:unknown, reconnect?:string) => JSON.stringify({t:'hello',v:PROTOCOL_VERSION,rules:rulesHash(),name:'Paint',physics:1,car:1,seq:0,color,token:reconnect});
    const a = server.connect(peer()); a.receive(hello(0xc83235));
    const welcome = messages.find((m):m is Extract<ServerMsg,{t:'welcome'}> => m.t==='welcome')!;
    expect(welcome.players[0].color).toBe(0xc83235);
    const b = server.connect(peer()); b.receive(hello(0x28664d,welcome.token));
    expect(server.world.byId(welcome.id)!.color).toBe(0x28664d);
    const c = server.connect(peer()); c.receive(hello('red',welcome.token));
    expect(server.world.byId(welcome.id)!.color).toBe(0x28664d);
    const other = server.connect(peer()); other.receive(hello(-1));
    expect(server.world.drivers[1].color).toBeGreaterThanOrEqual(0);
    const again=replay(42,{},journal,server.world.tick);
    expect(again.players(()=>true).map(p=>p.color)).toEqual(server.world.players(()=>true).map(p=>p.color));
  });
});
