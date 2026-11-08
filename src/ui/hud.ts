import { scoreTune } from '../config';
import type { Sim } from '../sim/world';

const fmt = new Intl.NumberFormat('en-US');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** DOM HUD. Values are written only when they change; nothing is re-rendered wholesale. */
export class Hud {
  private readonly speedo=document.querySelector<HTMLElement>('.speedo')!;
  private physicalInstruments=false;
  private readonly score = $('score');
  private readonly mult = $('mult');
  private readonly combo = $('combo');
  private readonly comboBar = $('comboBar');
  private readonly best = $('bestNum');
  private readonly kmh = $('kmh');
  private readonly gear = $('gear');
  private readonly blinkL = $('blinkL');
  private readonly boostBar = $('boostBar');
  private boostWasOn = false;
  private rpmShown = 0;
  private readonly blinkR = $('blinkR');
  private readonly rpmBar = $('rpmBar');
  private readonly popups = $('popups');
  private readonly banner = $('banner');
  private readonly shoulder = $('shoulder');
  private readonly modeTag = $('modeTag');
  private readonly assistStatus = $('assistStatus');
  private readonly tireSlip = $('tireSlip');
  private bannerT = 0;
  private modeT = 0;
  private last = { score: '', mult: '', best: '', kmh: '', gear: '', shoulder: false, combo: false };

  constructor(private readonly sim: Sim) {
    const ev = sim.events;
    ev.on('nearMiss', (e) => this.popup(e.truck ? 'NEAR MISS · TRUCK' : e.gap < 0.3 ? 'TOO CLOSE' : 'NEAR MISS', e.points, e.gap < 0.3 ? 'hot' : ''));
    ev.on('laneSplit', (e) => this.popup('LANE SPLIT', e.points, 'split'));
    ev.on('comboEnd', (e) => {
      if (e.reason === 'wall') this.popup('WALL · COMBO LOST', 0, 'bad');
    });
    ev.on('trafficMode', (e) => {
      if (e.label) this.tag(e.label, 3);
    });
    ev.on('trackEnd', () => this.showBanner('КОНЕЦ ПОКАЗА', 'выбери вид слева · R — заново', 'best', 4));
    ev.on('runEnd', (e) => {
      if (e.score <= 0) return;
      this.showBanner(e.newBest ? 'NEW BEST' : 'RUN OVER', `${fmt.format(e.score)} · ${e.near} near misses · top ${Math.round(e.topKmh)} km/h`, e.newBest ? 'best' : 'bad');
    });
  }

  update(dt: number): void {
    const sc = this.sim.score;
    const p = this.sim.player;
    const assist = p as typeof p & { tractionControlEnabled?: boolean; espEnabled?: boolean };
    if (p.physicsId === 2) {
      const rack = p.tune as typeof p.tune & { steerAssist?: number };
      const autoSteer = (rack.steerAssist ?? 0) > 0;
      this.assistStatus.textContent = `AUTO STEER ${autoSteer ? 'ON' : 'OFF'} · TC ${p.tune.tractionControl > 0 ? 'ON' : 'OFF'}`;
      this.assistStatus.classList.toggle('off', !autoSteer);
    } else if (assist.tractionControlEnabled !== undefined && assist.espEnabled !== undefined) {
      this.assistStatus.textContent = `TC ${assist.tractionControlEnabled ? 'ON' : 'OFF'} · ESP ${assist.espEnabled ? 'ON' : 'OFF'}`;
      this.assistStatus.classList.toggle('off', !assist.tractionControlEnabled || !assist.espEnabled);
    }
    const tire = p as typeof p & { slipRear?: number; slipAngleRear?: number };
    const slip = Math.max(Math.abs(tire.slipRear ?? 0) / 0.3, Math.abs(tire.slipAngleRear ?? 0) / 0.18);
    const slipLevel = Math.min(1, slip);
    this.tireSlip.style.setProperty('--slip', slipLevel.toFixed(3));
    this.tireSlip.classList.toggle('on', slipLevel > 0.12);
    this.tireSlip.classList.toggle('hot', slipLevel > 0.72);
    this.set('score', this.score, fmt.format(Math.floor(sc.score)));
    this.set('mult', this.mult, `×${sc.mult.toFixed(sc.mult % 1 === 0 ? 0 : 2)}`);
    this.set('best', this.best, fmt.format(sc.best));
    this.set('kmh', this.kmh, String(Math.round((p.physicsId === 2 ? p.speed : Math.max(0, p.vAlong)) * 3.6)));
    const gear = p.gear === 0 ? 'R' : p.gear === -1 ? 'N' : String(p.gear);
    this.set('gear', this.gear, p.manual && p.gear > 0 ? `M${gear}` : gear);
    this.boostBar.style.transform = `scaleX(${p.boost.toFixed(3)})`;
    if (p.boostOn !== this.boostWasOn) {
      this.boostWasOn = p.boostOn;
      this.boostBar.classList.toggle('on', p.boostOn);
    }
    this.gear.classList.toggle('manual', p.manual);
    if (p.shiftRefused) {
      // A downshift the engine would not survive: the gear box flashes.
      this.gear.classList.remove('deny');
      void this.gear.offsetWidth;
      this.gear.classList.add('deny');
    }

    const active = sc.combo > 0;
    if (active !== this.last.combo) {
      this.combo.classList.toggle('on', active);
      this.last.combo = active;
    }
    this.comboBar.style.transform = `scaleX(${active ? sc.comboT / scoreTune.comboTime : 0})`;
    this.rpmShown += (p.rpm - this.rpmShown) * (1 - Math.exp(-dt * 9));
    const rpm = Math.min(1, this.rpmShown / p.tune.redline);
    this.rpmBar.style.transform = `scaleX(${rpm.toFixed(3)})`;
    this.rpmBar.classList.toggle('red', rpm > 0.93);

    if (p.onShoulder !== this.last.shoulder) {
      this.shoulder.classList.toggle('on', p.onShoulder);
      this.last.shoulder = p.onShoulder;
    }

    if (this.modeT > 0) {
      this.modeT -= dt;
      if (this.modeT <= 0) this.modeTag.classList.remove('on');
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.classList.remove('on');
    }
  }

  /** Use the physical cluster instead of the floating speed/gear overlay. */
  setPhysicalInstruments(on:boolean):void {
    if(on===this.physicalInstruments)return;
    this.physicalInstruments=on;this.speedo.style.visibility=on?'hidden':'';
  }

  /** Turn signal arrows by the speedometer, lit in step with the car's lamps. */
  setBlinkers(side: number, lit: boolean): void {
    const l = side === 1 && lit;
    const r = side === 2 && lit;
    if (l !== this.blinkL.classList.contains('on')) this.blinkL.classList.toggle('on', l);
    if (r !== this.blinkR.classList.contains('on')) this.blinkR.classList.toggle('on', r);
  }

  private set(key: 'score' | 'mult' | 'best' | 'kmh' | 'gear', el: HTMLElement, text: string): void {
    if (this.last[key] === text) return;
    this.last[key] = text;
    el.textContent = text;
  }

  private popup(label: string, points: number, cls: string): void {
    const el = document.createElement('div');
    el.className = `pop ${cls}`;
    el.innerHTML = points > 0 ? `${label} <b>+${fmt.format(points)}</b>` : label;
    el.addEventListener('animationend', () => el.remove());
    this.popups.prepend(el);
    while (this.popups.childElementCount > 4) this.popups.lastElementChild!.remove();
  }

  /** Short status line under the combo (traffic mode, camera). */
  tag(text: string, seconds = 1.8): void {
    this.modeTag.textContent = text;
    this.modeTag.classList.add('on');
    this.modeT = seconds;
  }

  private showBanner(title: string, sub: string, cls: string, seconds = 2.6): void {
    this.banner.className = `on ${cls}`;
    this.banner.querySelector('.t')!.textContent = title;
    this.banner.querySelector('.s')!.textContent = sub;
    this.bannerT = seconds;
  }
}
