import './admin.css';
import { CARS } from '../sim/cars';
import { TUNE_CARS, tuningFields, type GlobalTuning, type TuneKey } from '../sim/tuning';
import { RADIO_MAX_TRACK_BYTES, type RadioLibrary } from '../audio/radioTypes';

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
const PHYSICS_NAMES: Record<number, string> = { 1: 'Grip', 2: 'R34 RWD', 3: 'AMG 4MATIC+', 4: 'GT3 RS', 5: 'C63 AMG W204' };
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
  maxPerKm: number;
  capacity: number;
}
interface State {
  server: { version: string; uptimeS: number; rssMB: number; connections: number; stepAvgMs: number; stepMaxMs: number; tick: number; seed: number; rules: string };
  rules: { maxPlayers: number; tickHz: number; ringKm: number };
  traffic: Traffic;
  modes: string[];
  drivers: Driver[];
  bans: { addr: string; until: number }[];
  tuning: GlobalTuning;
  defaults: GlobalTuning;
  radio: RadioLibrary;
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
let tuneCar = '3';
let tuneDirty = false;
let speedDirty = false;
let radioSelected = '';
let radioSignature = '';
let uploading = false;
let uploadRequest: XMLHttpRequest | null = null;
let refreshRevision = 0;
let dashboardVersion = '';

function showDashboard(): void {
  dashboardVersion = '';
  app.innerHTML = `
    <header class="top">
      <img src="/favicon.svg" alt="" />
      <div>
        <h1>Traffic Cutting Up · админка</h1>
        <div class="meta" id="meta"></div>
      </div>
      <div class="grow"></div>
      <span class="live" id="live"></span>
      <button id="adminUpdate" hidden>Админка обновлена · Перезагрузить</button>
      <a href="/"><button>К игре</button></a>
      <button id="logout">Выйти</button>
    </header>
    <div class="wrap">
      <section class="tiles" id="tiles"></section>
      <div class="cols">
        <section class="panel">
          <h2>Трафик</h2>
          <div class="row"><label>Трафик на кольце</label><button class="switch" id="trafficOn" title="Выключение убирает все машины"></button><span class="note" id="trafficCars"></span></div>
          <div class="row"><label>Режим</label><select id="mode"></select><span class="note" id="modeNow"></span></div>
          <table class="dens" id="densities"></table>
          <div class="note" id="trafficNote"></div>
          <div class="note">«Авто» — режимы меняются сами, остальные закрепляются до смены. Числа задают целевое количество машин без дополнительных множителей. Фактическое количество зависит от свободного места: машины не появляются перед носом у игроков. Enter или уход с поля сохраняет; настройки переживают перезапуск.</div>
        </section>
        <section class="panel">
          <h2>Сервер</h2>
          <div class="row"><label>Мест на сервере</label><input type="number" min="1" max="64" id="maxPlayers" style="width:90px" /><button id="saveMax">Сохранить</button></div>
          <div class="row"><label>Объявление</label><input type="text" maxlength="140" class="grow" id="sayText" placeholder="Текст для всех в ленте событий" /><button id="say">Отправить</button></div>
          <div class="row"><label>Баны</label><div class="grow" id="bans"></div></div>
          <div class="note" id="srvNote"></div>
        </section>
      </div>
      <div class="cols">
        <section class="panel">
          <h2>Машины · глобальная физика</h2>
          <div class="row"><label for="tuneCar">Машина</label><select id="tuneCar">${TUNE_CARS.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <form id="carTuneForm"><div class="tune-fields" id="carTuneFields"></div><div class="row"><button class="primary" type="submit">Применить для всех</button><button type="button" id="resetCarTune">Сбросить машину к дефолту</button></div></form>
          <div class="note">Эталон — исходные настройки текущей версии. Изменения сохраняются на сервере, применяются к подключённым игрокам и новым заездам. В одиночном режиме обновление — до 15 секунд.</div>
        </section>
        <section class="panel">
          <h2>Скорость трафика</h2>
          <form id="trafficSpeedForm"><div id="trafficSpeedFields"></div><div class="row"><button class="primary" type="submit">Применить скорости</button><button type="button" id="resetTrafficSpeed">Сбросить к дефолту</button></div></form>
          <div class="note">Диапазоны желаемой скорости, км/ч. Первая полоса — левая. Грузовики ограничены отдельно. Уже едущие машины плавно меняют скорость; в пробках скорость может быть ниже. Начальные значения сохранены как эталон.</div>
        </section>
      </div>
      <section class="panel" id="radioAdmin">
        <h2>Радио · плейлисты</h2>
        <div class="row"><input id="playlistName" maxlength="100" placeholder="Название плейлиста" /><button id="createPlaylist">Создать плейлист</button><button id="renamePlaylist">Переименовать выбранный</button></div>
        <fieldset id="radioEdit"><div class="row"><label for="radioPlaylist">Плейлист</label><select id="radioPlaylist"></select><button id="deletePlaylist">Удалить плейлист</button></div>
        <div class="row"><label for="radioFiles">Добавить треки</label><input type="file" id="radioFiles" multiple accept=".mp3,.ogg,.wav,.m4a,.flac,audio/*" /></div>
        <div class="scroll"><table id="radioTracks"></table></div></fieldset>
        <div class="row"><span id="radioProgress" role="status"></span><button id="cancelRadioUpload" hidden>Отменить загрузку</button></div>
        <div class="note">MP3, OGG, WAV, M4A, FLAC — до 40 МБ на трек, 200 треков в плейлисте, 1 ГБ на библиотеку. Декодирование формата зависит от браузера. Загружайте только записи, которые разрешено использовать. Файлы и плейлисты переживают перезапуск и деплой.</div>
      </section>
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
  $('adminUpdate').addEventListener('click', () => location.reload());
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
  $<HTMLSelectElement>('mode').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    void act('traffic', { mode: v }, v === 'auto' ? 'Режимы меняются сами' : `Режим: ${MODE_NAMES[v] ?? v}`);
  });
  $('densities').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.mode) return;
    const perKm = Number(input.value);
    const max = state?.traffic.maxPerKm ?? 80;
    if (!input.value.trim() || !Number.isFinite(perKm) || !(perKm >= 0 && perKm <= max)) {
      toast(`Число от 0 до ${max}`, true);
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
  initTuningControls();
  initRadioControls();

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
  const revision = ++refreshRevision;
  const live = document.getElementById('live');
  try {
    const next = await call<State>('state');
    if (revision !== refreshRevision || !document.getElementById('tiles')) return;
    state = next;
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
  if (!dashboardVersion) dashboardVersion = srv.version;
  $('adminUpdate')!.hidden = !srv.version || srv.version === 'dev' || srv.version === dashboardVersion;
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
  $('trafficNote')!.textContent = `До ${t.maxPerKm} машин/км каждой полосы (≈ ${Math.round(t.maxPerKm * t.lanes * t.windowKm)} у игрока). Участок: 220 м позади и 850 м впереди; общий пул сервера — ${t.capacity} машин.`;
  const sel = $('mode') as HTMLSelectElement;
  if (sel.options.length === 0) {
    sel.innerHTML = `<option value="auto">Авто (меняются сами)</option>` + s.modes.map((m) => `<option value="${m}">${esc(MODE_NAMES[m] ?? m)}</option>`).join('');
  }
  if (document.activeElement !== sel) sel.value = t.held ? t.mode : 'auto';
  $('modeNow')!.textContent = `сейчас: ${MODE_NAMES[t.mode] ?? t.mode}${t.held ? ' (закреплён)' : ''}`;
  renderDensities(t);
  renderTuning(s);
  renderRadio(s.radio);

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
          <td class="num"><input type="number" min="0" max="${t.maxPerKm}" step="0.5" value="${d.perKm.toFixed(1)}" data-mode="${esc(d.mode)}" /></td>
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

function renderTuning(s: State): void {
  (document.getElementById('tuneCar') as HTMLSelectElement).value = tuneCar;
  if (!tuneDirty && !document.getElementById('carTuneFields')!.contains(document.activeElement)) {
    const fields = s.tuning.cars[tuneCar];
    document.getElementById('carTuneFields')!.innerHTML = tuningFields(tuneCar).filter(f => fields[f.key] !== undefined).map(f =>
      `<label>${esc(f.label)}<input type="number" name="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${fields[f.key]}" required /><span class="note">Дефолт: ${s.defaults.cars[tuneCar][f.key]}</span></label>`).join('');
  }
  if (!speedDirty && !document.getElementById('trafficSpeedFields')!.contains(document.activeElement)) {
    const t = s.tuning.traffic;
    document.getElementById('trafficSpeedFields')!.innerHTML = `<table><thead><tr><th>Полоса</th><th>От, км/ч</th><th>До, км/ч</th><th>Дефолт</th></tr></thead><tbody>` +
      [...t.lanes, [t.truckMin, t.truckMax], [t.wallMin, t.wallMax]].map((p, i) => `<tr><td>${i === 4 ? 'Грузовики' : i === 5 ? 'Стенки' : i + 1}</td><td><input name="speed-${i}-0" type="number" min="10" max="${i >= 4 ? 180 : 250}" value="${p[0]}" required /></td><td><input name="speed-${i}-1" type="number" min="10" max="${i >= 4 ? 180 : 250}" value="${p[1]}" required /></td><td class="note">${i === 4 ? `${s.defaults.traffic.truckMin}–${s.defaults.traffic.truckMax}` : i === 5 ? `${s.defaults.traffic.wallMin}–${s.defaults.traffic.wallMax}` : s.defaults.traffic.lanes[i].join('–')}</td></tr>`).join('') + '</tbody></table>';
  }
}
async function saveTuning(body: object, done: string): Promise<void> {
  try {
    await call('tuning', body);
    if ('traffic' in body || 'resetTraffic' in body) speedDirty = false; else tuneDirty = false;
    toast(done); await refresh();
  } catch (e) { if (!(e instanceof LoginNeeded)) toast((e as Error).message, true); }
}
function initTuningControls(): void {
  const carForm = document.getElementById('carTuneForm') as HTMLFormElement;
  const speedForm = document.getElementById('trafficSpeedForm') as HTMLFormElement;
  carForm.addEventListener('input', () => { tuneDirty = true; });
  speedForm.addEventListener('input', () => { speedDirty = true; });
  document.getElementById('tuneCar')!.addEventListener('change', e => {
    tuneCar = (e.target as HTMLSelectElement).value; tuneDirty = false; if (state) renderTuning(state);
  });
  carForm.addEventListener('submit', e => {
    e.preventDefault(); if (!carForm.reportValidity()) return;
    const values = Object.fromEntries([...new FormData(carForm)].map(([key, value]) => [key as TuneKey, Number(value)]));
    void saveTuning({ car: tuneCar, values }, 'Настройки машины применены для всех');
  });
  speedForm.addEventListener('submit', e => {
    e.preventDefault(); if (!speedForm.reportValidity()) return;
    const data = new FormData(speedForm), lanes = Array.from({ length: 4 }, (_, i) => [Number(data.get(`speed-${i}-0`)), Number(data.get(`speed-${i}-1`))]);
    void saveTuning({ traffic: { lanes, truckMin: Number(data.get('speed-4-0')), truckMax: Number(data.get('speed-4-1')), wallMin: Number(data.get('speed-5-0')), wallMax: Number(data.get('speed-5-1')) } }, 'Скорости трафика применены');
  });
  document.getElementById('resetCarTune')!.addEventListener('click', () => { if (confirm('Вернуть исходные настройки выбранной машины для всех игроков?')) void saveTuning({ resetCar: tuneCar }, 'Машина сброшена к эталону'); });
  document.getElementById('resetTrafficSpeed')!.addEventListener('click', () => { if (confirm('Вернуть исходные скорости трафика?')) void saveTuning({ resetTraffic: true }, 'Скорости сброшены к эталону'); });
}

function renderRadio(library: RadioLibrary): void {
  if (uploading) return;
  const signature = JSON.stringify([library, radioSelected]);
  if (signature === radioSignature) return;
  radioSignature = signature;
  const select = document.getElementById('radioPlaylist') as HTMLSelectElement;
  if (!library.playlists.some(p => p.id === radioSelected)) radioSelected = library.playlists[0]?.id ?? '';
  select.innerHTML = library.playlists.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.tracks.length})</option>`).join('') || '<option value="">Нет плейлистов</option>';
  select.value = radioSelected;
  const p = library.playlists.find(p => p.id === radioSelected);
  (document.getElementById('radioFiles') as HTMLInputElement).disabled = !p;
  (document.getElementById('deletePlaylist') as HTMLButtonElement).disabled = !p;
  document.getElementById('radioTracks')!.innerHTML = '<thead><tr><th>#</th><th>Трек</th><th>МБ</th><th></th></tr></thead><tbody>' + (p?.tracks.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.title)}</td><td>${(t.bytes / 1048576).toFixed(1)}</td><td class="acts"><button data-radio-action="move" data-id="${esc(t.id)}" data-direction="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button data-radio-action="move" data-id="${esc(t.id)}" data-direction="1" ${i === p.tracks.length - 1 ? 'disabled' : ''}>↓</button><button data-radio-action="deleteTrack" data-id="${esc(t.id)}">Удалить</button></td></tr>`).join('') || '<tr><td colspan="4" class="note">Добавьте треки в плейлист</td></tr>') + '</tbody>';
}
async function radioAction(body: object): Promise<void> {
  try {
    const result = await call<{ radio: RadioLibrary }>('radio', body);
    if ('action' in body && body.action === 'create') radioSelected = result.radio.playlists.at(-1)?.id ?? '';
    radioSignature = ''; if (state) state.radio = result.radio;
    renderRadio(result.radio); toast('Плейлисты обновлены');
  } catch (e) { if (!(e instanceof LoginNeeded)) toast((e as Error).message, true); }
}
function initRadioControls(): void {
  document.getElementById('createPlaylist')!.addEventListener('click', () => {
    const input = document.getElementById('playlistName') as HTMLInputElement;
    if (!input.value.trim()) return; void radioAction({ action: 'create', name: input.value }); input.value = '';
  });
  document.getElementById('renamePlaylist')!.addEventListener('click', () => {
    const input = document.getElementById('playlistName') as HTMLInputElement;
    if (radioSelected && input.value.trim()) void radioAction({ action: 'rename', playlist: radioSelected, name: input.value });
  });
  document.getElementById('radioPlaylist')!.addEventListener('change', e => { radioSelected = (e.target as HTMLSelectElement).value; radioSignature = ''; if (state) renderRadio(state.radio); });
  document.getElementById('deletePlaylist')!.addEventListener('click', () => { if (radioSelected && confirm('Удалить плейлист и все его аудиофайлы?')) void radioAction({ action: 'deletePlaylist', playlist: radioSelected }); });
  document.getElementById('radioTracks')!.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-radio-action]'); if (!b) return;
    if (b.dataset.radioAction === 'deleteTrack' && !confirm('Удалить аудиофайл?')) return;
    void radioAction({ action: b.dataset.radioAction, playlist: radioSelected, track: b.dataset.id, direction: Number(b.dataset.direction) });
  });
  document.getElementById('cancelRadioUpload')!.addEventListener('click', () => uploadRequest?.abort());
  document.getElementById('radioFiles')!.addEventListener('change', e => void uploadRadio(e.target as HTMLInputElement));
}
async function uploadRadio(input: HTMLInputElement): Promise<void> {
  const files = [...input.files ?? []]; if (!files.length || !radioSelected || uploading) return;
  if (files.some(f => f.size > RADIO_MAX_TRACK_BYTES)) { toast('Максимум 40 МБ на трек', true); input.value = ''; return; }
  uploading = true;
  const fieldset = document.getElementById('radioEdit') as HTMLFieldSetElement, progress = document.getElementById('radioProgress')!, cancel = document.getElementById('cancelRadioUpload')!;
  fieldset.disabled = true; cancel.hidden = false;
  try {
    for (const [i, file] of files.entries()) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const type = ({ mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac' } as Record<string, string>)[ext];
      if (!type) throw new Error(`Неподдерживаемый файл: ${file.name}`);
      await new Promise<void>((resolve, reject) => {
        const xhr = uploadRequest = new XMLHttpRequest();
        xhr.open('POST', `${API}/radio/upload?${new URLSearchParams({ playlist: radioSelected, title: file.name.replace(/\.[^.]+$/, '') })}`);
        xhr.setRequestHeader('authorization', `Bearer ${token}`); xhr.setRequestHeader('content-type', type); xhr.timeout = 180000;
        xhr.upload.onprogress = event => { progress.textContent = `${i + 1}/${files.length} · ${file.name} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0}%`; };
        xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else { let message = `Ошибка загрузки ${xhr.status}`; try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* non JSON */ } reject(new Error(message)); } };
        xhr.onerror = () => reject(new Error('Не удалось загрузить трек')); xhr.onabort = () => reject(new Error('Загрузка отменена')); xhr.ontimeout = () => reject(new Error('Загрузка заняла слишком много времени'));
        xhr.send(file);
      });
    }
    toast('Треки загружены'); progress.textContent = 'Загрузка завершена';
  } catch (e) { toast((e as Error).message, true); progress.textContent = (e as Error).message; }
  finally { uploading = false; uploadRequest = null; fieldset.disabled = false; cancel.hidden = true; input.value = ''; radioSignature = ''; await refresh(); }
}
