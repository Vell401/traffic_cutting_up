import manifest from '../../public/audio/porsche/manifest.json';
import { clamp } from '../core/math';

export const PORSCHE_AUDIO_CLIPS=manifest.clips;
let pending:Promise<ArrayBuffer[]>|undefined;
const fetched:Array<ArrayBuffer|undefined>=new Array(PORSCHE_AUDIO_CLIPS.length);
/** Shared fetch cache; decoding belongs to the unlocked AudioContext. */
export function preloadPorscheAudio():Promise<ArrayBuffer[]>{
  if(!pending)pending=(async()=>{
    const errors:unknown[]=[];let next=0;
    await Promise.all(Array.from({length:4},async()=>{
      for(;;){const i=next++;if(i>=fetched.length)return;
        if(fetched[i])continue;
        try{
          const response=await fetch(`/audio/porsche/${PORSCHE_AUDIO_CLIPS[i].file}`);
          if(!response.ok)throw new Error(`Porsche sound: ${response.status}`);
          fetched[i]=await response.arrayBuffer();
        }catch(error){errors.push(error);}
      }
    }));
    // Drain every worker before allowing a retry; successful clips survive failures.
    if(errors.length)throw errors[0];
    return fetched as ArrayBuffer[];
  })().catch(error=>{pending=undefined;throw error;});
  return pending;
}

/** Equal-power adjacent RPM crossfades; every recording follows its real recorded engine speed. */
export function rpmBlend(rpms:readonly number[],rpm:number):{low:number;high:number;a:number;b:number}{
  let high=rpms.findIndex(r=>r>=rpm);if(high<0)high=rpms.length-1;
  const low=Math.max(0,high-1),f=low===high?0:clamp(Math.log(Math.max(rpm,1)/rpms[low])/Math.log(rpms[high]/rpms[low]),0,1);
  return {low,high,a:Math.cos(f*Math.PI/2),b:Math.sin(f*Math.PI/2)};
}

interface Voice{source:AudioBufferSourceNode;gain:GainNode;last:number}
export class PorscheEngine {
  ready=false;
  private disposed=false;
  private loading:Promise<void>|undefined;
  private readonly output:GainNode;
  private readonly send:GainNode;
  private readonly filter:BiquadFilterNode;
  private readonly voices=new Map<number,Voice>();
  private buffers:Array<AudioBuffer|undefined>=[];
  private readonly banks:number[][]=[];
  private readonly weights=new Float32Array(PORSCHE_AUDIO_CLIPS.length);
  constructor(private readonly ctx:AudioContext,bus:{dry:GainNode;send:GainNode}){
    this.output=ctx.createGain();this.output.gain.value=0;
    this.filter=ctx.createBiquadFilter();this.filter.type='lowpass';this.filter.Q.value=.45;this.filter.frequency.value=12000;this.filter.connect(this.output);
    this.output.connect(bus.dry);this.send=ctx.createGain();this.send.gain.value=.5;this.output.connect(this.send);this.send.connect(bus.send);
    for(const channel of ['engine','exhaust'])for(const load of ['off','on'])
      this.banks.push(PORSCHE_AUDIO_CLIPS.flatMap((c,i)=>c.channel===channel&&c.load===load?[i]:[]));
    void this.retry();
  }
  private usable():boolean{return !this.disposed&&this.ctx.state!=='closed';}
  /** One attempt per selection, never per update; concurrent selections share the attempt. */
  retry():Promise<void>{
    if(!this.usable()){this.ready=false;return Promise.resolve();}
    if(this.ready)return Promise.resolve();
    if(this.loading)return this.loading;
    this.loading=preloadPorscheAudio().then(async data=>{
      if(!this.usable())return;
      const results=await Promise.allSettled(data.map(async (b,i)=>{
        if(this.buffers[i])return;
        const buffer=await this.ctx.decodeAudioData(b.slice(0));
        if(this.usable())this.buffers[i]=buffer;
      }));
      const failed=results.find(r=>r.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      if(this.usable())this.ready=true;
    }).catch(error=>{
      if(this.usable())console.warn('Porsche recordings unavailable; using the fallback engine.',error);
    }).finally(()=>{this.loading=undefined;});
    return this.loading;
  }
  dispose():void{
    if(this.disposed)return;
    this.disposed=true;this.ready=false;
    for(const {source,gain} of this.voices.values()){source.stop();source.disconnect();gain.disconnect();}
    this.voices.clear();this.buffers=[];
    this.filter.disconnect();this.output.disconnect();this.send.disconnect();
  }
  update(rpm:number,throttle:number,shift:boolean,active:boolean,cockpit:boolean):void{
    if(!this.usable()){this.ready=false;return;}
    const now=this.ctx.currentTime;
    const limiter=rpm>=8950&&throttle>.5&&Math.sin(now*Math.PI*2*17)<0;
    this.output.gain.setTargetAtTime(active&&this.ready ? (shift ? .12 : limiter ? .24 : .58) : 0,now,limiter ? .008 : .025);
    this.filter.frequency.setTargetAtTime(cockpit?6200:13500,now,.12);
    if(!this.ready)return;
    this.weights.fill(0);
    if(active){
      const load=clamp(throttle,0,1),off=Math.cos(load*Math.PI/2),on=Math.sin(load*Math.PI/2);
      for(let bank=0;bank<this.banks.length;bank++){
        const ids=this.banks[bank],blend=rpmBlend(ids.map(i=>PORSCHE_AUDIO_CLIPS[i].rpm),rpm);
        const balance=bank<2 ? (cockpit ? .8 : .52) : (cockpit ? .43 : .85);
        const gain=(bank%2===0?off:on)*balance;
        this.weights[ids[blend.low]]+=blend.a*gain;
        this.weights[ids[blend.high]]+=blend.b*gain;
      }
    }
    for(let i=0;i<this.weights.length;i++){
      const weight=this.weights[i];let voice=this.voices.get(i);
      if(!voice&&weight>.001){
        const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();source.buffer=this.buffers[i]!;source.loop=true;
        gain.gain.value=0;source.connect(gain);gain.connect(this.filter);
        source.playbackRate.value=clamp(rpm/PORSCHE_AUDIO_CLIPS[i].rpm,.45,2.1);
        source.start(now,(now*source.playbackRate.value)%source.buffer.duration);
        voice={source,gain,last:now};this.voices.set(i,voice);
      }
      if(!voice)continue;
      voice.gain.gain.setTargetAtTime(weight,now,.035);
      voice.source.playbackRate.setTargetAtTime(clamp(rpm/PORSCHE_AUDIO_CLIPS[i].rpm,.45,2.1),now,.018);
      if(weight>.001)voice.last=now;
      else if(now-voice.last>.3){voice.source.stop();voice.source.disconnect();voice.gain.disconnect();this.voices.delete(i);}
    }
  }
}
