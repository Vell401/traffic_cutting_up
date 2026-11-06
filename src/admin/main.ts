import './admin.css';
import { CARS } from '../sim/cars';

/*
 * Admin page of the online server (/admin.html): status, traffic, players (kick, ban), announcements,
 * leaderboard moderation and the diagnostics log. Talks to /api/admin (server/admin.ts) with a session
 * token kept for this tab only.
 */

const API = '/api/admin';
const TOKEN_KEY = 'tcu.admin';
const MODE_NAMES: Record<string, string> = {
  normal: 'Обычный',
  sparse: 'Свободный',
  dense: 'Плотный',
  trucks: 'Грузовики',
  walls: 'Стенки',
  platoons: 'Колонны',
};
const PHYSICS_NAMES: Record<number, string> = { 1: 'Grip', 2: 'V8 RWD', 3: 'AMG 4MATIC+' };
const STATE_NAMES: Record<string, string> = { active: 'на трассе', away: 'отошёл', offline: 'нет связи' };

interface Driver {
  id: number;
  name: string;
  state: 'active' | 'away' | 'offline';
  physics: number;
  car: number;
  score: number;
  best: number;
  kmh: number;
  ghost: boolean;
  violations: number;
  queue: number;
  addr: string;
}
interface Traffic {
  on: boolean;
  preset: 1 | 2;
  intensity: number;
  mode: string;
  held: boolean;
  cars: number;
  densities: { mode: string; perKm: number; scale: number }[];
  windowKm: number;
  lanes: number;
}
interface State {
  server: { version: string; uptimeS: number; rssMB: number; connections: number; stepAvgMs: number; stepMaxMs: number; tick: number; seed: number; rules: string };
  rules: { maxPlayers: number; tickHz: number; ringKm: number };
  traffic: Traffic;
  modes: string[];
  drivers: Driver[];
  bans: { addr: string; until: number }[];
}
interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  car: number;
  topKmh: number;
  at: number;
}
interface LogRow {
  id: number;
  at: number;
  source: string;
  level: string;
  message: string;
  detail: string | null;
}

const app = document.getElementById('app')!;
let token = '';
try {
  token = sessionStorage.getItem(TOKEN_KEY) ?? '';
} catch {
  /* no storage: log in again after a reload */
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = new Intl.NumberFormat('ru-RU');
const carName = (id: number) => CARS.find((c) => c.id === id)?.name ?? `#${id}`;
const time = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} д ${Math.floor((s % 86400) / 3600)} ч` : s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин` : `${Math.floor(s / 60)} мин`);

function setToken(t: string): void {
  token = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* see above */
  }
}

class LoginNeeded extends Error {}

async function call<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && path !== 'login') {
    setToken('');
    showLogin('Сессия закончилась, войдите снова');
    throw new LoginNeeded();
  }
  if (!res.ok) throw new Error(data.error ?? `Ошибка ${res.status}`);
  return data;
}

let toastTimer = 0;
function toast(text: string, bad = false): void {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 2600);
}

/** Run an admin action: a toast with the outcome, then a fresh state. */
async function act(path: string, body: object, done: string): Promise<void> {
  try {
    await call(path, body);
    toast(done);
    void refresh();
  } catch (e) {
    if (!(e instanceof LoginNeeded)) toast((e as Error).message, true);
  }
}

// ---------------------------------------------------------------- login

let refreshTimer = 0;

function showLogin(message = ''): void {
  clearInterval(refreshTimer);
  app.innerHTML = `
    <div class="login">
      <form>
        <img src="/favicon.svg" alt="" />
        <h1>Админка сервера</h1>
        <input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus />
        <button class="primary" type="submit">Войти</button>
        <div class="err">${esc(message)}</div>
      </form>
    </div>`;
  const form = app.querySelector('form')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.err')!;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    try {
      const r = await call<{ token: string }>('login', { password });
      setToken(r.token);
      showDashboard();
    } catch (e2) {
      err.textContent = (e2 as Error).message;
    }
  });
}

// ---------------------------------------------------------------- dashboard

let state: State | null = null;
let boardMode: 'solo' | 'online' = 'solo';
let logSource: '' | 'server' | 'client' = '';
/** The intensity slider is being moved: refreshes must not jump it back. */
let draggingIntensity = false;

function showDashboard(): void {
  app.innerHTML = `
    <header class="top">
      <img src="/favicon.svg" alt="" />
      <div>
        <h1>Traffic Cutting Up · админка</h1>
        <div class="meta" id="meta"></div>
      </div>
      <div class="grow"></div>
      <span class="live" id="live"></span>
      <a href="/"><button>К игре</button></a>
      <button id="logout">Выйти</button>
    </header>
    <div class="wrap">
      <section class="tiles" id="tiles"></section>
      <div class="cols">
        <section class="panel">
          <h2>Трафик</h2>
          <div class="row"><label>Трафик на кольце</label><button class="switch" id="trafficOn" title="Выключение убирает все машины"></button><span class="note" id="trafficCars"></span></div>
          <div class="row"><label>Плотность</label><div class="seg" id="preset"><button data-v="1">Обычная</button><button data-v="2">Плотная</button></div></div>
          <div class="row"><label>Сложность</label><input type="range" min="0" max="100" step="1" class="grow" id="intensity" /><b id="intensityOut"></b></div>
          <div class="row"><label>Режим</label><select id="mode"></select><span class="note" id="modeNow"></span></div>
          <table class="dens" id="densities"></table>
          <div class="note">Спавн — сколько машин режим держит на 1 км каждой полосы при текущих плотности и сложности; «≈ у игрока» — сколько это машин вокруг одного игрока (на участке дороги вокруг него, где сервер держит трафик: 220 м позади и 850 м впереди). Значение можно поменять: Enter или уход с поля сохраняет.</div>
          <div class="note">Сложность — частота и плотность машин, доля «резких» водителей. «Авто» — режимы меняются сами каждые 1–2 км, остальные держатся, пока не смените. Настройки трафика сохраняются на сервере и переживают перезапуск.</div>
        </section>
        <section class="panel">
          <h2>Сервер</h2>
          <div class="row"><label>Мест на сервере</label><input type="number" min="1" max="64" id="maxPlayers" style="width:90px" /><button id="saveMax">Сохранить</button></div>
          <div class="row"><label>Объявление</label><input type="text" maxlength="140" class="grow" id="sayText" placeholder="Текст для всех в ленте событий" /><button id="say">Отправить</button></div>
          <div class="row"><label>Баны</label><div class="grow" id="bans"></div></div>
          <div class="note" id="srvNote"></div>
        </section>
      </div>
      <section class="panel">
        <h2>Игроки <span class="grow"></span><span class="note" id="playersNote"></span></h2>
        <div class="scroll"><table id="players"></table></div>
      </section>
      <div class="cols">
        <section class="panel">
          <h2>Лидерборд <span class="grow"></span><div class="seg" id="boardTabs"><button data-v="solo">Одиночный</button><button data-v="online">Онлайн</button></div></h2>
          <div class="scroll"><table id="board"></table></div>
        </section>
        <section class="panel">
          <h2>Журнал <span class="grow"></span><div class="seg" id="logTabs"><button data-v="">Все</button><button data-v="server">Сервер</button><button data-v="client">Страницы</button></div><button class="small" id="logRefresh">Обновить</button></h2>
          <div class="logs"><table id="logs"></table></div>
        </section>
      </div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  $('logout').addEventListener('click', () => {
    void call('logout', {}).catch(() => {});
    setToken('');
    showLogin();
  });
  $('trafficOn').addEventListener('click', () => {
    const on = !state?.traffic.on;
    if (!on && !confirm('Выключить трафик? Все машины исчезнут с кольца.')) return;
    void act('traffic', { trafficOn: on }, on ? 'Трафик включён' : 'Трафик выключен');
  });
  for (const b of $('preset').querySelectorAll('button')) {
    b.addEventListener('click', () => void act('traffic', { traffic: Number(b.dataset.v) }, `Плотность: ${b.textContent}`));
  }
  const intensity = $<HTMLInputElement>('intensity');
  intensity.addEventListener('input', () => {
    draggingIntensity = true;
    $('intensityOut').textContent = `${intensity.value}%`;
  });
  intensity.addEventListener('change', () => {
    draggingIntensity = false;
    void act('traffic', { intensity: Number(intensity.value) / 100 }, `Сложность ${intensity.value}%`);
  });
  $<HTMLSelectElement>('mode').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    void act('traffic', { mode: v }, v === 'auto' ? 'Режимы меняются сами' : `Режим: ${MODE_NAMES[v] ?? v}`);
  });
  $('densities').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.mode) return;
    const perKm = Number(input.value);
    if (!(perKm >= 0 && perKm <= 40)) {
      toast('Число от 0 до 40', true);
      return;
    }
    void act('traffic', { modePerKm: { mode: input.dataset.mode, perKm } }, `${MODE_NAMES[input.dataset.mode] ?? input.dataset.mode}: ${perKm} машин на км полосы`);
    input.blur();
  });
  $('densities').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  });
  $('saveMax').addEventListener('click', () => {
    const n = Number($<HTMLInputElement>('maxPlayers').value);
    void act('players', { maxPlayers: n }, `Мест: ${n}`);
  });
  const say = () => {
    const input = $<HTMLInputElement>('sayText');
    const text = input.value.trim();
    if (!text) return;
    void act('say', { text }, 'Объявление отправлено').then(() => (input.value = ''));
  };
  $('say').addEventListener('click', say);
  $('sayText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') say();
  });
  $('players').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const id = Number(b.dataset.id);
    const ban = Number(b.dataset.ban ?? 0);
    const name = state?.drivers.find((d) => d.id === id)?.name ?? `#${id}`;
    const what = ban ? `Отключить ${name} и закрыть вход с его адреса на ${ban >= 1440 ? `${ban / 1440} сут` : `${ban} мин`}?` : `Отключить ${name}?`;
    if (confirm(what)) void act('kick', { id, banMinutes: ban }, `${name} отключён`);
  });
  $('bans').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) void act('unban', { addr: b.dataset.addr }, 'Бан снят');
  });
  for (const b of $('boardTabs').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      boardMode = b.dataset.v === 'online' ? 'online' : 'solo';
      void loadBoard();
    });
  }
  $('board').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const name = b.dataset.name!;
    if (confirm(`Удалить все заезды «${name}» из таблицы (${boardMode === 'solo' ? 'одиночный' : 'онлайн'})?`)) {
      void act('board/remove', { mode: boardMode, name }, `Заезды ${name} удалены`).then(loadBoard);
    }
  });
  for (const b of $('logTabs').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      logSource = (b.dataset.v ?? '') as typeof logSource;
      void loadLogs();
    });
  }
  $('logRefresh').addEventListener('click', () => void loadLogs());

  void refresh();
  void loadBoard();
  void loadLogs();
  clearInterval(refreshTimer);
  let ticks = 0;
  refreshTimer = window.setInterval(() => {
    void refresh();
    // The log moves slower: every 10 s.
    if (++ticks % 5 === 0) void loadLogs();
  }, 2000);
}

async function refresh(): Promise<void> {
  const live = document.getElementById('live');
  try {
    state = await call<State>('state');
    render(state);
    if (live) {
      live.textContent = `обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
      live.classList.remove('bad');
    }
  } catch (e) {
    if (e instanceof LoginNeeded) return;
    if (live) {
      live.textContent = `нет связи: ${(e as Error).message}`;
      live.classList.add('bad');
    }
  }
}

function render(s: State): void {
  const $ = (id: string) => document.getElementById(id);
  const srv = s.server;
  const online = s.drivers.filter((d) => d.state !== 'offline').length;
  $('meta')!.textContent = `версия ${srv.version} · правила ${srv.rules} · кольцо ${s.rules.ringKm} км · ${s.rules.tickHz} Гц`;
  $('tiles')!.innerHTML = [
    ['Игроки', `${online}<small> / ${s.rules.maxPlayers}</small>`],
    ['Соединения', srv.connections],
    ['Трафик', `${s.traffic.on ? s.traffic.cars : 'выкл'}<small>${s.traffic.on ? ' машин' : ''}</small>`],
    ['Такт', `${srv.stepAvgMs.toFixed(2)}<small> / ${srv.stepMaxMs.toFixed(2)} мс</small>`],
    ['Память', `${Math.round(srv.rssMB)}<small> МБ</small>`],
    ['Аптайм', uptime(srv.uptimeS)],
  ]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const t = s.traffic;
  $('trafficOn')!.classList.toggle('on', t.on);
  $('trafficCars')!.textContent = t.on ? `сейчас ${t.cars} машин` : 'выключен';
  for (const b of $('preset')!.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.v) === t.preset);
  if (!draggingIntensity) {
    const v = Math.round(t.intensity * 100);
    ($('intensity') as HTMLInputElement).value = String(v);
    $('intensityOut')!.textContent = `${v}%`;
  }
  const sel = $('mode') as HTMLSelectElement;
  if (sel.options.length === 0) {
    sel.innerHTML = `<option value="auto">Авто (меняются сами)</option>` + s.modes.map((m) => `<option value="${m}">${esc(MODE_NAMES[m] ?? m)}</option>`).join('');
  }
  if (document.activeElement !== sel) sel.value = t.held ? t.mode : 'auto';
  $('modeNow')!.textContent = `сейчас: ${MODE_NAMES[t.mode] ?? t.mode}${t.held ? ' (закреплён)' : ''}`;
  renderDensities(t);

  const maxInput = $('maxPlayers') as HTMLInputElement;
  if (document.activeElement !== maxInput) maxInput.value = String(s.rules.maxPlayers);
  $('srvNote')!.textContent = `seed ${srv.seed} · тик ${fmt.format(srv.tick)}. Объявление появится у всех в ленте событий справа.`;
  $('bans')!.innerHTML = s.bans.length
    ? s.bans.map((b) => `<div>${esc(b.addr)} до ${time(b.until)} <button class="small" data-addr="${esc(b.addr)}">Снять</button></div>`).join('')
    : '<span class="note">нет</span>';

  $('playersNote')!.textContent = `${s.drivers.length} в слотах, ${online} на связи`;
  $('players')!.innerHTML = s.drivers.length
    ? `<thead><tr><th>#</th><th>Имя</th><th>Статус</th><th>Машина</th><th class="num">км/ч</th><th class="num">Очки</th><th class="num">Рекорд</th><th>Адрес</th><th class="num">Наруш.</th><th></th></tr></thead><tbody>` +
      s.drivers
        .map(
          (d) => `<tr>
            <td>${d.id}</td>
            <td>${esc(d.name)}${d.ghost ? ' <span class="tag">призрак</span>' : ''}</td>
            <td><span class="tag ${d.state}">${STATE_NAMES[d.state] ?? d.state}</span></td>
            <td>${esc(carName(d.car))} · ${PHYSICS_NAMES[d.physics] ?? d.physics}</td>
            <td class="num">${d.kmh}</td>
            <td class="num">${fmt.format(d.score)}</td>
            <td class="num">${fmt.format(d.best)}</td>
            <td>${esc(d.addr || '—')}</td>
            <td class="num">${d.violations}</td>
            <td class="acts"><button class="small danger" data-id="${d.id}">Отключить</button><button class="small danger" data-id="${d.id}" data-ban="30">Бан 30 мин</button><button class="small danger" data-id="${d.id}" data-ban="1440">Бан сутки</button></td>
          </tr>`,
        )
        .join('') +
      '</tbody>'
    : '<tr><td class="empty">На сервере никого нет</td></tr>';
}

/** Spawn density of each traffic mode; the current one highlighted. Inputs being edited are left alone. */
function renderDensities(t: Traffic): void {
  const table = document.getElementById('densities')!;
  const editing = table.contains(document.activeElement);
  if (editing) return;
  const perDriver = (perKm: number) => Math.round(perKm * t.lanes * t.windowKm);
  table.innerHTML =
    `<thead><tr><th>Режим</th><th class="num">Спавн, машин/км полосы</th><th class="num">≈ у игрока</th></tr></thead><tbody>` +
    t.densities
      .map(
        (d) => `<tr class="${d.mode === t.mode ? 'cur' : ''}">
          <td>${esc(MODE_NAMES[d.mode] ?? d.mode)}${d.mode === t.mode ? ' <span class="tag active">сейчас</span>' : ''}</td>
          <td class="num"><input type="number" min="0" max="40" step="0.5" value="${d.perKm.toFixed(1)}" data-mode="${esc(d.mode)}" /></td>
          <td class="num">${perDriver(d.perKm)}</td>
        </tr>`,
      )
      .join('') +
    '</tbody>';
}

async function loadBoard(): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#boardTabs button')) b.classList.toggle('on', b.dataset.v === boardMode);
  const el = document.getElementById('board')!;
  try {
    const r = await call<{ entries: BoardEntry[] }>(`board?mode=${boardMode}&limit=50`);
    el.innerHTML = r.entries.length
      ? `<thead><tr><th>#</th><th>Имя</th><th class="num">Очки</th><th>Машина</th><th class="num">км/ч</th><th>Когда</th><th></th></tr></thead><tbody>` +
        r.entries
          .map(
            (e) => `<tr><td>${e.rank}</td><td>${esc(e.name)}</td><td class="num">${fmt.format(e.score)}</td><td>${esc(carName(e.car))}</td><td class="num">${e.topKmh}</td><td>${time(e.at)}</td>
              <td class="acts"><button class="small danger" data-name="${esc(e.name)}">Удалить</button></td></tr>`,
          )
          .join('') +
        '</tbody>'
      : '<tr><td class="empty">Пусто</td></tr>';
  } catch (e) {
    if (!(e instanceof LoginNeeded)) el.innerHTML = `<tr><td class="empty">${esc((e as Error).message)}</td></tr>`;
  }
}

async function loadLogs(): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#logTabs button')) b.classList.toggle('on', (b.dataset.v ?? '') === logSource);
  const el = document.getElementById('logs')!;
  try {
    const r = await call<{ rows: LogRow[] }>(`logs?limit=300${logSource ? `&source=${logSource}` : ''}`);
    el.innerHTML = r.rows.length
      ? `<thead><tr><th>Время</th><th>Откуда</th><th>Сообщение</th></tr></thead><tbody>` +
        r.rows
          .map(
            (row) => `<tr><td>${time(row.at)}</td><td>${row.source === 'client' ? 'страница' : 'сервер'}</td>
              <td class="msg lvl-${esc(row.level)}">${row.detail ? `<details><summary>${esc(row.message)}</summary><pre>${esc(row.detail)}</pre></details>` : esc(row.message)}</td></tr>`,
          )
          .join('') +
        '</tbody>'
      : '<tr><td class="empty">Журнал пуст</td></tr>';
  } catch (e) {
    if (!(e instanceof LoginNeeded)) el.innerHTML = `<tr><td class="empty">${esc((e as Error).message)}</td></tr>`;
  }
}

if (token) showDashboard();
else showLogin();
