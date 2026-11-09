import { CARS } from '../sim/cars';
import { getMap, type MapId } from '../sim/maps';

/** One row of the server's leaderboard (server/store.ts LeaderEntry). */
interface Entry {
  rank: number;
  name: string;
  score: number;
  car: number;
  near: number;
  topKmh: number;
  at: number;
}

interface Board {
  map: MapId;
  entries: Entry[];
  /** Players with a run on this board. */
  total: number;
  /** Our own best run and place among everyone (null: no run here yet). */
  me: Entry | null;
}

export interface SoloRun {
  name: string;
  score: number;
  car: number;
  physics: number;
  near: number;
  topKmh: number;
  seconds: number;
}

type Mode = 'solo' | 'online';
const MODES: readonly Mode[] = ['solo', 'online'];

const fmt = new Intl.NumberFormat('ru-RU');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const carName = (id: number) => CARS.find((c) => c.id === id)?.name ?? '';
/** "1 игрок", "3 игрока", "12 игроков". */
const players = (n: number) => {
  const d = n % 10;
  const dd = n % 100;
  return `${fmt.format(n)} ${d === 1 && dd !== 11 ? 'игрок' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'игрока' : 'игроков'}`;
};

/**
 * Leaderboard of the start menu: the single-player board on the left, the online one on the right,
 * each player's best run, the top ten of each, and under them our own place among everyone there.
 * Solo runs are sent here when they end; online ones the game server records itself.
 */
export class Leaderboard {
  private readonly cols = new Map<Mode, { list: HTMLElement; me: HTMLElement; count: HTMLElement }>();

  constructor(
    private readonly base: string,
    private readonly myName: () => string,
    private readonly map: MapId = 'highway',
  ) {
    for (const mode of MODES) {
      const col = document.querySelector<HTMLElement>(`#leaders .lcol[data-mode="${mode}"]`)!;
      this.cols.set(mode, { list: col.querySelector('ol')!, me: col.querySelector('.lme')!, count: col.querySelector('.lcount')! });
    }
    const context = document.querySelector<HTMLElement>('#leaders .lh em');
    if (context) context.textContent = `${getMap(map).name} · лучший заезд каждого · от 1 000 очков`;
    void this.refresh();
  }

  /** Both boards, with our place on each. */
  async refresh(): Promise<void> {
    await Promise.all(MODES.map((m) => this.load(m)));
  }

  private async load(mode: Mode): Promise<void> {
    const col = this.cols.get(mode)!;
    const name = this.myName().trim();
    try {
      const res = await fetch(`${this.base}/leaderboard?mode=${mode}&limit=10&name=${encodeURIComponent(name)}`, { cache: 'no-store' });
      const data = (await res.json()) as Board;
      if (!res.ok || data.map !== this.map) throw new Error('Leaderboard instance mismatch');
      const me = name.toLowerCase();
      col.list.innerHTML = data.entries.length
        ? data.entries
            .map(
              (e) =>
                `<li class="${e.name.toLowerCase() === me ? 'me' : ''}"><b class="num">${e.rank}</b><span class="n">${esc(e.name)}<em>${esc(carName(e.car))} · ${e.topKmh} км/ч</em></span><span class="s num">${fmt.format(e.score)}</span></li>`,
            )
            .join('')
        : '<li class="empty">Пока пусто — станьте первым</li>';
      col.count.textContent = data.total ? players(data.total) : '';
      col.me.innerHTML = data.me
        ? `<span>Ваше место</span><b class="num">${data.me.rank}</b><span class="of">из ${fmt.format(data.total)}</span><span class="s num">${fmt.format(data.me.score)}</span>`
        : `<span class="none">${mode === 'solo' ? 'Нет вашего заезда: нужно от 1 000 очков' : 'Нет вашего онлайн-заезда от 1 000 очков'}</span>`;
    } catch {
      col.list.innerHTML = '<li class="empty">Сервер недоступен</li>';
      col.me.textContent = '';
      col.count.textContent = '';
    }
  }

  /** Report a finished solo run; resolves to the player's place on the board (if any). */
  async submitSolo(run: SoloRun): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...run, map: this.map }) });
      const data = (await res.json()) as { rank?: number };
      void this.load('solo');
      return data.rank;
    } catch {
      return undefined;
    }
  }
}
