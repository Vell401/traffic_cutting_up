import { CARS } from '../sim/cars';

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

export interface SoloRun {
  name: string;
  score: number;
  car: number;
  physics: number;
  near: number;
  topKmh: number;
  seconds: number;
}

const fmt = new Intl.NumberFormat('ru-RU');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const carName = (id: number) => CARS.find((c) => c.id === id)?.name ?? '';

/**
 * Leaderboard panel of the start menu: each player's best run, solo and online kept apart (tabs).
 * Solo runs are sent here when they end; online ones the game server records itself.
 */
export class Leaderboard {
  private readonly list = document.getElementById('leadersList')!;
  private readonly note = document.getElementById('leadersNote')!;
  private mode: 'solo' | 'online';

  constructor(
    private readonly base: string,
    initial: 'solo' | 'online',
    private readonly myName: () => string,
  ) {
    this.mode = initial;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#leadersTabs button')) {
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode === 'online' ? 'online' : 'solo';
        b.blur();
        void this.refresh();
      });
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#leadersTabs button')) b.classList.toggle('on', b.dataset.mode === this.mode);
    try {
      const res = await fetch(`${this.base}/leaderboard?mode=${this.mode}&limit=10`, { cache: 'no-store' });
      const data = (await res.json()) as { entries: Entry[] };
      const me = this.myName().trim().toLowerCase();
      this.list.innerHTML = data.entries.length
        ? data.entries
            .map(
              (e) =>
                `<li class="${e.name.toLowerCase() === me ? 'me' : ''}"><b class="num">${e.rank}</b><span class="n">${esc(e.name)}<em>${esc(carName(e.car))} · ${e.topKmh} км/ч</em></span><span class="s num">${fmt.format(e.score)}</span></li>`,
            )
            .join('')
        : '<li class="empty">Пока пусто — станьте первым</li>';
      this.note.textContent = this.mode === 'solo' ? 'Одиночный режим · лучший заезд каждого · от 1 000 очков' : 'Онлайн · заезды засчитывает сервер · от 1 000 очков';
    } catch {
      this.list.innerHTML = '<li class="empty">Сервер недоступен</li>';
    }
  }

  /** Report a finished solo run; resolves to the player's place on the board (if any). */
  async submitSolo(run: SoloRun): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run) });
      const data = (await res.json()) as { rank?: number };
      if (this.mode === 'solo') void this.refresh();
      return data.rank;
    } catch {
      return undefined;
    }
  }
}
