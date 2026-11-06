import { scoreTune } from '../config';
import type { Sim } from '../sim/world';

const fmt = new Intl.NumberFormat('en-US');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** DOM HUD. Values are written only when they change; nothing is re-rendered wholesale. */
export class Hud {
  private readonly score = $('score');
  private readonly mult = $('mult');
  private readonly combo = $('combo');
  private readonly comboBar = $('comboBar');
  private readonly best = $('bestNum');
  private readonly kmh = $('kmh');
  private readonly gear = $('gear');
  private readonly blinkL = $('blinkL');
  private readonly blinkR = $('blinkR');
  private readonly rpmBar = $('rpmBar');
  private readonly popups = $('popups');
  private readonly banner = $('banner');
  private readonly shoulder = $('shoulder');
  private readonly modeTag = $('modeTag');
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
    this.set('score', this.score, fmt.format(Math.floor(sc.score)));
    this.set('mult', this.mult, `×${sc.mult.toFixed(sc.mult % 1 === 0 ? 0 : 2)}`);
    this.set('best', this.best, fmt.format(sc.best));
    this.set('kmh', this.kmh, String(Math.round(Math.max(0, p.vAlong) * 3.6)));
    this.set('gear', this.gear, p.manual ? `M${p.gear}` : String(p.gear));
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
    const rpm = Math.min(1, p.rpm / p.tune.redline);
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
