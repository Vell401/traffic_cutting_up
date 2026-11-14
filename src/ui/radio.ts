import { roundedSelect } from './dropdown';
import type { Sound } from '../audio/sound';
import type { RadioLibrary, RadioPlaylist } from '../audio/radioTypes';

/** Stream a track at a time; no whole-playlist decoding or audio buffers on the game thread. */
export class Radio {
  private readonly audio = new Audio();
  private library: RadioLibrary = { playlists: [] };
  private selected = '';
  private index = 0;
  private readonly root = document.getElementById('radio')!;
  private readonly select = this.root.querySelector('select')!;
  private readonly status = this.root.querySelector<HTMLElement>('.radio-status')!;
  private readonly play = this.root.querySelector<HTMLButtonElement>('[data-radio=play]')!;
  private readonly volume = this.root.querySelector<HTMLInputElement>('input')!;
  constructor(private readonly base: string, private readonly sound: Sound) {
    this.audio.preload = 'none';
    this.audio.crossOrigin = 'anonymous';
    try { this.selected = localStorage.getItem('tcu.radio') ?? ''; } catch { /* no storage */ }
    roundedSelect(this.select);
    this.select.addEventListener('change', () => {
      this.selected = this.select.value; this.index = 0;
      try { localStorage.setItem('tcu.radio', this.selected); } catch { /* no storage */ }
      if (!this.selected) this.stop(); else void this.start();
    });
    this.play.addEventListener('click', () => {
      if (!this.audio.paused) { this.audio.pause(); this.sync(); }
      else void this.start();
    });
    for (const direction of ['prev', 'next'] as const) this.root.querySelector(`[data-radio=${direction}]`)!.addEventListener('click', () => void this.next(direction === 'prev' ? -1 : 1));
    this.audio.addEventListener('ended', () => void this.next(1));
    this.audio.addEventListener('error', () => { this.audio.pause(); this.status.textContent = 'Не удалось прочитать трек. Попробуйте следующий.'; this.sync(); });
    this.audio.addEventListener('playing', () => this.sync());
    this.audio.addEventListener('pause', () => this.sync());
    this.volume.addEventListener('input', () => sound.setLevel('radio', Number(this.volume.value) / 100));
    const syncVolume = () => { this.volume.value = String(Math.round(sound.level('radio') * 100)); this.volume.nextElementSibling!.textContent = this.volume.value; };
    sound.onMixChange(syncVolume); syncVolume();
    for (const type of ['keydown', 'keyup'] as const) this.root.addEventListener(type, event => {
      if (event.code === 'Escape' || event.code === 'KeyP') (event.target as HTMLElement).blur(); else event.stopPropagation();
    });
    void this.refresh(); window.setInterval(() => void this.refresh(), 30000);
  }
  private playlist(): RadioPlaylist | undefined { return this.library.playlists.find(p => p.id === this.selected); }
  private sync(): void {
    this.play.textContent = this.audio.paused ? '▶' : '❚❚';
    this.play.setAttribute('aria-label', this.audio.paused ? 'Включить радио' : 'Приостановить радио');
    this.play.disabled = !this.playlist()?.tracks.length;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-radio=prev], [data-radio=next]')) button.disabled = !this.playlist()?.tracks.length;
  }
  private stop(): void {
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    this.status.textContent = 'Радио выключено'; this.sync();
  }
  private async refresh(): Promise<void> {
    try {
      const response = await fetch(`${this.base}/radio`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('radio unavailable');
      this.library = await response.json() as RadioLibrary;
      const previous = this.select.value;
      this.select.replaceChildren(new Option('Радио выключено', ''));
      for (const p of this.library.playlists) this.select.add(new Option(`${p.name}${p.tracks.length ? '' : ' (пусто)'}`, p.id));
      if (!this.playlist()) { this.selected = ''; this.stop(); }
      this.select.value = this.selected;
      const currentId = this.audio.getAttribute('src')?.split('/').pop();
      if (currentId) {
        const currentIndex = this.playlist()?.tracks.findIndex(t => t.id === currentId) ?? -1;
        if (currentIndex >= 0) this.index = currentIndex;
      }
      if (currentId && !this.playlist()?.tracks.some(t => t.id === currentId)) this.stop();
      if (!this.library.playlists.length) this.status.textContent = 'Плейлисты пока не добавлены';
      else if (previous !== this.selected || !currentId) this.status.textContent = this.selected ? 'Нажмите ▶, чтобы включить радио' : 'Радио выключено';
      this.sync();
    } catch { this.status.textContent = 'Радио недоступно — повторим подключение'; }
  }
  private async next(direction: number): Promise<void> {
    const p = this.playlist(); if (!p?.tracks.length) return;
    this.index = (this.index + direction + p.tracks.length) % p.tracks.length;
    await this.start();
  }
  private async start(): Promise<void> {
    const p = this.playlist(); if (!p?.tracks.length) { this.stop(); return; }
    this.index %= p.tracks.length;
    const track = p.tracks[this.index], src = `${this.base}/radio/audio/${track.id}`;
    this.sound.connectRadio(this.audio); // Must run synchronously inside the user gesture.
    if (this.audio.getAttribute('src') !== src) this.audio.src = src;
    this.status.textContent = `${p.name} · ${track.title}`;
    this.status.title = this.status.textContent;
    try { await this.audio.play(); }
    catch { this.status.textContent = 'Нажмите ▶ или выберите другой трек'; }
    this.sync();
  }
}
