import type { PlayerInfo } from '../online/protocol';
import type { ClientStats } from '../online/clientCore';
import type { View } from '../render/view';
import type { Sim } from '../sim/world';

const fmt = new Intl.NumberFormat('ru-RU');
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/**
 * Online overlay: the driver board (current run and best of everyone on the server), a short feed of
 * joins and records, the connection line, and name tags over the other drivers' cars.
 */
export class OnlineHud {
  private readonly board = document.getElementById('board')!;
  private readonly rows = document.getElementById('boardRows')!;
  private readonly net = document.getElementById('boardNet')!;
  private readonly feed = document.getElementById('feed')!;
  private readonly announceEl = document.getElementById('announce')!;
  private announceTimer = 0;
  private readonly status = document.getElementById('netStatus')!;
  private readonly tagLayer = document.getElementById('tags')!;
  private readonly tags = new Map<number, HTMLDivElement>();
  private readonly pos = { x: 0, y: 0, dist: 0 };
  private myId = 0;
  private netT = 0;
  private distT = 0;
  /** Board cells showing the distance to each driver (id → cell). */
  private readonly dist = new Map<number, HTMLElement>();

  constructor(private readonly sim: Sim) {
    this.board.hidden = false;
  }

  setMe(id: number): void {
    this.myId = id;
    this.sim.spawn.mine = -1;
  }

  players(list: PlayerInfo[]): void {
    // Spawn pad colours: who owns which place.
    const sp = this.sim.spawn;
    sp.owners.length = 0;
    for (const p of list) sp.owners[p.slot] = p.color;
    for (let i = 0; i < sp.owners.length; i++) sp.owners[i] ??= null;
    sp.mine = list.find((p) => p.id === this.myId)?.slot ?? -1;

    const sorted = [...list].sort((a, b) => b.best - a.best || b.score - a.score);
    this.rows.innerHTML = sorted
      .map((p) => {
        const cls = [p.id === this.myId ? 'me' : '', p.state !== 'active' ? 'off' : ''].join(' ');
        const note = p.state === 'offline' ? ' · нет связи' : p.state === 'away' ? ' · в боксах' : '';
        return `<div class="row ${cls}"><i style="background:${hex(p.color)}"></i><span class="n">${esc(p.name)}<em>${note}</em></span><span class="d num" data-id="${p.id}"></span><span class="s num">${fmt.format(p.score)}</span><span class="b num">${fmt.format(p.best)}</span></div>`;
      })
      .join('');
    this.dist.clear();
    for (const el of this.rows.querySelectorAll<HTMLElement>('.d')) this.dist.set(Number(el.dataset.id), el);
    this.distT = 0;
  }

  /** Distance along the ring (the short way round) from our car to each other driver. */
  private updateDistances(): void {
    const own = this.sim.player.s;
    for (const [id, el] of this.dist) {
      let text = '';
      if (id === this.myId) text = 'вы';
      else {
        const r = this.sim.remotes.find((x) => x.id === id);
        if (r) {
          const ds = r.car.s - own;
          const m = Math.abs(ds);
          const v = m < 1000 ? `${Math.round(m / 5) * 5} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`;
          text = `${ds >= 0 ? '▲' : '▼'} ${v}`;
          el.classList.toggle('near', m < 150);
        }
      }
      if (el.textContent !== text) el.textContent = text;
    }
  }

  addFeed(text: string): void {
    const el = document.createElement('div');
    el.textContent = text;
    el.addEventListener('animationend', () => el.remove());
    this.feed.prepend(el);
    while (this.feed.childElementCount > 4) this.feed.lastElementChild!.remove();
  }

  /** A message from the server's admin: a banner at the top for a while (over menus too). */
  announce(text: string): void {
    this.announceEl.querySelector('.t')!.textContent = text;
    this.announceEl.classList.add('on');
    window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => this.announceEl.classList.remove('on'), 9000);
  }

  /** Connection problems and other session-wide notices; empty text hides the line. */
  setStatus(text: string, bad = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('on', text !== '');
    this.status.classList.toggle('bad', bad);
  }

  /** Per frame: name tags follow the cars; the ping line updates twice a second. */
  update(view: View, stats: ClientStats, dt: number): void {
    const seen = new Set<number>();
    for (const r of this.sim.remotes) {
      seen.add(r.id);
      let el = this.tags.get(r.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'nametag';
        this.tagLayer.appendChild(el);
        this.tags.set(r.id, el);
      }
      if (el.dataset.name !== r.name || el.dataset.color !== String(r.color)) {
        el.dataset.name = r.name;
        el.dataset.color = String(r.color);
        el.innerHTML = `<i style="background:${hex(r.color)}"></i>${esc(r.name)}`;
      }
      const on = view.remoteTag(r.id, this.pos);
      el.style.opacity = on ? String(Math.max(0.25, Math.min(1, 1.4 - this.pos.dist / 400))) : '0';
      if (on) el.style.transform = `translate(${this.pos.x.toFixed(1)}px, ${this.pos.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of this.tags) {
      if (seen.has(id)) continue;
      el.remove();
      this.tags.delete(id);
    }
    this.distT -= dt;
    if (this.distT <= 0) {
      this.distT = 0.2;
      this.updateDistances();
    }
    this.netT -= dt;
    if (this.netT <= 0) {
      this.netT = 0.5;
      const ping = Math.round(stats.rtt);
      this.net.textContent = `ping ${ping} ms · ${this.sim.remotes.length + 1} на трассе`;
      this.net.classList.toggle('bad', ping > 180);
    }
  }
}
