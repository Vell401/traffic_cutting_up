import './style.css';
import './menu.css';
import { LANES, SIM_HZ, laneCenter } from './config';
import { Sound } from './audio/sound';
import { Input } from './core/input';
import { MouseControl } from './core/mouse';
import { clamp } from './core/math';
import type { CameraMode } from './render/camera';
import { View } from './render/view';
import { waitForCar } from './render/car';
import { loading } from './ui/loading';
import { SKY_PRESETS, skyPreset, skySwatch } from './render/sky';
import { CARS, type CarId } from './sim/cars';
import type { DriveInput } from './sim/vehicle';
import { TRAFFIC_PRESETS } from './sim/director';
import type { PhysicsId } from './sim/physics';
import { spawnS } from './sim/ring';
import { SHOWCASES } from './sim/testTrack';
import { Sim } from './sim/world';
import { apiBase, conditionsFromUrl, healthUrl, serverUrl } from './online/link';
import { diagFrame, initDiag, report } from './diag';
import { Leaderboard } from './ui/leaderboard';
import { Mixer } from './ui/mixer';
import { initModelLoad } from './ui/modelLoad';
import { OnlineSession } from './online/session';
import type { Debug } from './ui/debug';
import {
  QUALITY,
  loadCameraMode,
  loadCar,
  loadManual,
  loadMouseSens,
  loadName,
  loadPaint,
  loadQuality,
  loadSky,
  loadSteerMode,
  loadTraffic,
  saveCameraMode,
  saveCar,
  saveManual,
  saveMouseSens,
  saveName,
  savePaint,
  saveQuality,
  saveSky,
  saveSteerMode,
  saveTraffic,
  type Quality,
} from './settings';
import { Hud } from './ui/hud';
import { Metrics } from './ui/metrics';
import { OnlineHud } from './ui/onlineHud';

const BEST_KEY = 'tcu.best.v1';
const loadBest = (): number => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};
const saveBest = (v: number): void => {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    /* storage unavailable: best lives for this session only */
  }
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
/** ?test: short finite showcase tracks picked from a side panel; no records saved. */
const TEST = params.has('test');
/**
 * Online by default: the shared ring on the game server (its own page lifecycle: leaving reloads the
 * page). ?solo: single player. (?online still works for old links.)
 */
const ONLINE = !TEST && !params.has('solo');
let showcase = 0;
await loading.stage(18, 'Подготовка трассы и трафика');
const initialCar = loadCar();
const sim = new Sim(Math.random, { track: TEST ? SHOWCASES[0].script : undefined, physics: initialCar === 1 ? 4 : initialCar === 3 ? 3 : 2, online: ONLINE });
sim.director.preset = loadTraffic();
sim.score.best = ONLINE ? 0 : loadBest();
sim.score.grace = Infinity; // the menu attract mode never scores
const quality = loadQuality();
let car: CarId = loadCar();
let paint = loadPaint(car);
// Before the view: building the chosen car may start a model download right away.
initModelLoad();
await loading.stage(28, 'Создание сцены');
const view = new View(canvas, sim, QUALITY[quality], car, paint);
await loading.stage(40, 'Подготовка управления и интерфейса');
// Each car remembers its own camera.
view.setCar(car, loadCameraMode(car) as CameraMode);
view.setSky(skyPreset(loadSky()).id);
const hud = new Hud(sim);
const API = apiBase(serverUrl(params));
initDiag(API, ONLINE ? 'online' : TEST ? 'test' : 'solo', quality, canvas, view.renderer.getContext());
const input = new Input();
const sound = new Sound(sim);
sound.setCar(car);
const mixer = new Mixer(sound);
const metrics = new Metrics(view.renderer, sim, () => `quality ${quality}  audio ${sound.state}`);
// Audio may only start after a user gesture.
window.addEventListener('keydown', () => sound.unlock());
window.addEventListener('pointerdown', () => sound.unlock());

type State = 'menu' | 'play' | 'pause';
let state: State = 'menu';
document.body.classList.add('menu');
const startEl = document.getElementById('start')!;
const pauseEl = document.getElementById('pause')!;

sim.events.on('runEnd', (e) => {
  if (e.newBest && !TEST && !ONLINE) saveBest(e.best);
  // Solo runs go to the solo leaderboard (online ones the server records itself).
  if (!TEST && !ONLINE && e.score >= 1000) {
    void leaders
      ?.submitSolo({ name: playerName(), score: e.score, car, physics: sim.player.physicsId, near: e.near, topKmh: e.topKmh, seconds: e.time })
      .then((rank) => {
        if (rank && rank <= 10) hud.tag(`ЛИДЕРБОРД · МЕСТО ${rank}`, 3);
      });
  }
});

function start(): void {
  if (loading.active && !TEST) return;
  if (state !== 'menu') return;
  if (ONLINE) {
    startOnline();
    return;
  }
  enterPlay();
  sim.score.resetRun();
  sim.score.grace = 0;
}

function enterPlay(): void {
  state = 'play';
  document.body.classList.remove('menu');
  startEl.classList.add('hidden');
  mouse.centre();
  // Starting is a click or a key press: mouse steering can take the pointer at once.
  if (mouse.mode === 'mouse') void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
}

/** Online the world never stops: P / Esc only show the menu card while the car rolls on without input. */
let onlineMenu = false;
function setPaused(paused: boolean): void {
  if (state === 'menu') return;
  document.body.classList.toggle('paused', paused);
  if (paused && mouse.locked) document.exitPointerLock();
  if (ONLINE) {
    onlineMenu = paused;
    pauseEl.classList.toggle('hidden', !paused);
    return;
  }
  state = paused ? 'pause' : 'play';
  pauseEl.classList.toggle('hidden', !paused);
  sound.setPaused(paused);
}

// ---------------------------------------------------------------- online

const onlineMsg = document.getElementById('onlineMsg')!;
const nameInput = document.getElementById('nameInput') as HTMLInputElement;
let session: OnlineSession | null = null;
let onlineHud: OnlineHud | null = null;

function menuMessage(text: string, bad = false): void {
  onlineMsg.textContent = text;
  onlineMsg.classList.toggle('bad', bad);
}

function startOnline(): void {
  if (session && session.state !== 'failed') return;
  loading.begin('online', 'Выходим на общее кольцо');
  loading.set(20, 'Соединение с сервером');
  const name = playerName();
  saveName(name);
  nameInput.blur();
  const ohud = (onlineHud ??= new OnlineHud(sim));
  metrics.net = () => {
    const st = session?.core.stats;
    if (!st) return '';
    return `net  ping ${st.rtt.toFixed(0)} ms  ahead ${st.horizon} steps  srv queue ${st.queue}  corrections ${st.corrections} (last ${(st.lastCorrection * 100).toFixed(1)} cm, max ${(st.maxCorrection * 100).toFixed(1)} cm)  in ${(st.bytesIn / 1024).toFixed(0)} kB`;
  };
  session = new OnlineSession(sim, serverUrl(params), conditionsFromUrl(params), {
    onState: (st, text) => {
      if (st === 'joined') {
        if (loading.context === 'online') loading.set(75, 'Получение состояния трассы');
        ohud.setMe(session!.core.id);
        ohud.setStatus('');
        menuMessage('');
        if (state === 'menu') enterPlay();
      } else if (st === 'connecting') {
        menuMessage(text);
      } else if (st === 'reconnecting') {
        ohud.setStatus(text, true);
        report('warn', 'online: connection lost, reconnecting');
      } else if (st === 'failed') {
        if (loading.active && loading.context === 'online') loading.fail(text, () => {}, 'Вернуться в меню');
        report('warn', `online failed: ${text}`);
        ohud.setStatus('');
        menuMessage(text, true);
        if (state !== 'menu') {
          // Back to the menu card; the car stays where the server left it.
          state = 'menu';
          onlineMenu = false;
          pauseEl.classList.add('hidden');
          document.body.classList.remove('paused');
          document.body.classList.add('menu');
          if (mouse.locked) document.exitPointerLock();
          startEl.classList.remove('hidden');
        }
      }
    },
    onPlayers: (list) => ohud.players(list),
    onFeed: (text) => ohud.addFeed(text),
    onAnnounce: (text) => {
      ohud.announce(text);
      sound.notice();
    },
    onTeleport: () => {
      view.snapCamera();
      if (Math.abs(sim.road.rel(sim.player.s, spawnS(0))) < 3) hud.tag('SPAWN · ВЫ НЕВИДИМЫ, ПОКА НА ПЛОЩАДКЕ', 2.5);
    },
  });
  session.start(name, sim.player.physicsId as PhysicsId, car, paint);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __game: object }).__game, { session });
}

/** Menu line under the name field: is the server up, how many are driving. */
async function probeServer(): Promise<void> {
  const info = document.getElementById('serverInfo')!;
  const url = serverUrl(params);
  info.textContent = `Сервер ${url.replace(/^wss?:\/\//, '')} …`;
  try {
    const res = await fetch(healthUrl(url), { cache: 'no-store' });
    const h = (await res.json()) as { players: number; drivers: unknown[] };
    info.textContent = `Сервер на связи · на трассе ${h.players}`;
  } catch {
    info.textContent = 'Сервер не отвечает (npm run server)';
  }
}

// The driver's name: online it is shown to others, both modes put it on the leaderboard.
// A cleared field falls back to the saved (or first random) name, never a shared "Driver".
const defaultName = loadName();
const playerName = (): string => nameInput.value.trim().slice(0, 16) || defaultName;
nameInput.value = defaultName;
nameInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') start();
  e.stopPropagation(); // typing a name must not drive, pause or switch cameras
});
nameInput.addEventListener('keyup', (e) => e.stopPropagation());
nameInput.addEventListener('change', () => {
  saveName(playerName());
  void leaders?.refresh(); // our place is looked up by name
});
const leaders = TEST ? null : new Leaderboard(API, playerName);
if (ONLINE) {
  document.body.classList.add('online');
  void probeServer();
}

let debug: Debug | null = null;
let debugOn = false;
let debugLoading = false;
async function toggleDebug(): Promise<void> {
  if (ONLINE) {
    // Live tuning would make our prediction disagree with the server's physics.
    hud.tag('ТЮНИНГ ТОЛЬКО В ОДИНОЧНОМ РЕЖИМЕ');
    return;
  }
  debugOn = !debugOn;
  if (!debug && !debugLoading) {
    debugLoading = true;
    const { createDebug } = await import('./ui/debug');
    metrics.gpuAllowed = false; // stats-gl wraps every render in its own GPU timer query
    debug = await createDebug(view.renderer, sim);
  }
  debug?.setVisible(debugOn);
}
if (new URLSearchParams(location.search).has('debug')) void toggleDebug();
if (import.meta.env.DEV) Object.assign(window, { __game: { sim, view, input, hud, metrics, sound } });

// ---------------------------------------------------------------- mouse

// Keyboard steering: the left button held on the game view looks around. Mouse steering (as in
// Assetto Corsa): a click captures the pointer, side-to-side turns the wheel, left button throttle,
// right brake, middle looks around, Esc lets go (and pauses).
const mouse = new MouseControl(
  canvas,
  {
    look: (dx, dy) => view.look(dx, dy),
    driving: () => state === 'play' && !(ONLINE && onlineMenu),
    released: () => setPaused(true),
  },
  loadSteerMode(),
  loadMouseSens(),
);
input.mouse = mouse;
const mouseWheel = document.getElementById('mouseWheel')!;
const mouseWheelMark = mouseWheel.querySelector('i')!;
const mouseHint = document.getElementById('mouseHint')!;

/** Per frame: the wheel position strip while steering with the mouse, the capture hint before. */
function updateMouseHud(): void {
  const on = mouse.mode === 'mouse' && state === 'play' && !(ONLINE && onlineMenu);
  mouseWheel.hidden = !(on && mouse.locked);
  mouseHint.hidden = !(on && !mouse.locked);
  if (!mouseWheel.hidden) mouseWheelMark.style.left = `${50 + mouse.steer * 50}%`;
}

// ---------------------------------------------------------------- gearbox and turn signals

/** G switches the gearbox; Z / X shift down / up in manual (one shift per press, in the next step). */
let manualGears = loadManual();
let pendingShift = 0;
/** Turn signal: 0 off, 1 left, 2 right. Q / E toggle it; it cancels itself after the lane change. */
let blinker = 0;
let blinkFromD = 0;
let blinkWasLit = false;
let highBeam = false;

function setBlinker(side: number): void {
  blinker = blinker === side ? 0 : side;
  blinkFromD = sim.player.d;
}

/** Controls that are not pedals or steering, written into the input of the next step. */
function withControls(d: DriveInput): DriveInput {
  d.manual = manualGears;
  d.blinker = blinker;
  d.shift = pendingShift;
  pendingShift = 0;
  return d;
}

/** Per frame: the turn signal goes off once the car has moved over a lane that way and the wheel is straight. */
function updateBlinker(): void {
  const p = sim.player;
  if (blinker !== 0) {
    const moved = (p.d - blinkFromD) * (blinker === 1 ? -1 : 1);
    if (moved > 3 && Math.abs(p.steerIn) < 0.15) blinker = 0;
  }
  const lit = view.blinkLit;
  if (lit !== blinkWasLit) sound.tick(lit);
  blinkWasLit = lit;
  hud.setBlinkers(p.blinker, lit);
}

input.onPress = (code) => {
  if (loading.active) return;
  if (code === 'Backquote') void toggleDebug();
  else if (code === 'F1') metrics.toggle();
  else if (code === 'KeyV') {
    const mode = view.cycleCamera();
    saveCameraMode(car, mode);
    hud.tag(`CAMERA · ${mode.toUpperCase()}`);
  }
  else if (code === 'KeyL' && state === 'play' && !onlineMenu) {
    highBeam = !highBeam;
    view.setHighBeam(highBeam);
    document.getElementById('highBeam')!.hidden = !highBeam;
    hud.tag(highBeam ? 'ДАЛЬНИЙ СВЕТ' : 'БЛИЖНИЙ СВЕТ', 1.5);
  }
  else if (code === 'KeyM') {
    hud.tag(sound.toggleMute() ? 'SOUND OFF' : 'SOUND ON');
    mixer.sync();
  }
  else if (code === 'KeyG') {
    manualGears = !manualGears;
    saveManual(manualGears);
    hud.tag(manualGears ? 'КОРОБКА · РУЧНАЯ  (Z ↓  X ↑)' : 'КОРОБКА · АВТОМАТ', 2);
  } else if ((code === 'KeyX' || code === 'KeyZ') && state === 'play') {
    if (manualGears) pendingShift = code === 'KeyX' ? 1 : -1;
    else hud.tag('ПЕРЕДАЧИ Z / X — В РУЧНОМ РЕЖИМЕ (G)', 2);
  } else if (code === 'KeyQ' && state === 'play') setBlinker(1);
  else if (code === 'KeyE' && state === 'play') setBlinker(2);
  else if (state === 'menu' && (code === 'Enter' || code === 'Space')) start();
  else if (code === 'KeyP' || code === 'Escape') setPaused(ONLINE ? !onlineMenu : state === 'play');
  else if (code === 'KeyR' && state === 'play') {
    mouse.centre();
    if (ONLINE) session?.requestRespawn();
    else if (TEST) loadShowcase(showcase);
    else sim.respawn();
  } else if (TEST && state === 'play' && /^Digit[0-9]$/.test(code)) {
    const i = (Number(code.slice(5)) + 9) % 10; // 1..9, 0 = tenth
    if (i < SHOWCASES.length) loadShowcase(i);
  }
};
document.getElementById('startBtn')!.addEventListener('click', start);
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-quality]')) {
  btn.classList.toggle('on', btn.dataset.quality === quality);
  btn.addEventListener('click', () => {
    if (btn.dataset.quality === quality) return;
    saveQuality(btn.dataset.quality as Quality);
    location.reload(); // textures and render targets are built once at startup
  });
}
/** Start-menu segmented choice (numbered variants) with a description line under it. */
function choice<T extends number>(
  segId: string,
  descId: string,
  items: readonly { id: T; name: string; desc: string }[],
  current: T,
  onPick: (id: T) => void,
): void {
  const seg = document.getElementById(segId)!;
  const desc = document.getElementById(descId)!;
  const show = (id: T) => {
    for (const b of seg.children) b.classList.toggle('on', (b as HTMLElement).dataset.id === String(id));
    desc.textContent = items.find((it) => it.id === id)?.desc ?? '';
  };
  for (const it of items) {
    const b = document.createElement('button');
    b.dataset.id = String(it.id);
    // Numbered by place in the list (the ids stay what the network and saved settings use).
    b.innerHTML = `<b>${seg.childElementCount + 1}</b>${it.name}`;
    b.addEventListener('click', () => {
      show(it.id);
      onPick(it.id);
      b.blur(); // keep Space/Enter for starting the run
    });
    seg.appendChild(b);
  }
  show(current);
}
choice('carSeg', 'carDesc', CARS, car, (id) => {
  car = id;
  saveCar(id);
  sim.setPhysics(id === 1 ? 4 : id === 3 ? 3 : 2);
  sound.setCar(id);
  paint = loadPaint(id);
  view.setPaint(paint);
  showPaint();
  void (async () => {
    loading.begin('car', 'Готовим твою машину');
    await loading.stage(10, 'Подготовка модели');
    try {
      await waitForCar(id, (fraction, unpacking) => loading.set(15 + fraction * 70, unpacking ? 'Подготовка материалов' : 'Загрузка автомобиля'));
      view.setCar(id, loadCameraMode(id) as CameraMode);
      await loading.stage(92, 'Подготовка первого кадра');
      view.render(1, 0);
      await view.prepareCar();
      loading.finish();
    } catch { loading.fail('Не удалось загрузить автомобиль. Попробуйте ещё раз.'); }
  })();
});

const paintInput = document.getElementById('paintInput') as HTMLInputElement;
const swatches = document.getElementById('paintSwatches')!;
const paints: [string, number][] = [['Синий',0x1f4fd8],['Красный',0xc83235],['Белый',0xe6e8ed],['Графит',0x24262d],['Фиолетовый',0x8953bd],['Зелёный',0x28664d],['Оранжевый',0xf08a28]];
function showPaint(): void {
  paintInput.value = `#${paint.toString(16).padStart(6, '0')}`;
  for (const button of swatches.children) button.setAttribute('aria-pressed', String(Number((button as HTMLElement).dataset.color) === paint));
}
function choosePaint(color: number): void { paint = color; savePaint(color,car); view.setPaint(color); showPaint(); }
for (const [name, color] of paints) {
  const button = document.createElement('button');
  button.dataset.color = String(color); button.setAttribute('aria-label', name); button.title = name;
  button.style.setProperty('--paint', `#${color.toString(16).padStart(6, '0')}`);
  button.onclick = () => { choosePaint(color); button.blur(); };
  swatches.appendChild(button);
}
paintInput.addEventListener('input', () => choosePaint(parseInt(paintInput.value.slice(1),16)));
for (const type of ['keydown','keyup'] as const) paintInput.addEventListener(type, e => e.stopPropagation());
showPaint();
// The menu card always fits the window: when its content is taller than the room, the whole card is
// scaled down (CSS zoom keeps the layout and the clicks right). Re-fitted on resize, once the fonts
// are in, and whenever something in it shows, hides or unfolds.
const menuCard = startEl.querySelector<HTMLElement>('.card')!;
let fitQueued = false;
function fitMenu(): void {
  fitQueued = false;
  menuCard.style.zoom = '';
  const cs = getComputedStyle(startEl);
  const room = startEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const need = menuCard.scrollHeight;
  if (need > room && room > 0) menuCard.style.zoom = String(Math.max(0.5, Math.floor((room / need) * 1000) / 1000));
}
const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(fitMenu);
};
window.addEventListener('resize', queueFit);
void document.fonts?.ready.then(fitMenu);
new MutationObserver(queueFit).observe(menuCard, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'open'] });
fitMenu();

// The key list starts folded (unfolded, the card scales down to keep fitting).
const keysBox = document.getElementById('keysBox') as HTMLDetailsElement;
// Space / Enter after a click must start the run, not fold the list again.
keysBox.addEventListener('toggle', () => keysBox.querySelector('summary')!.blur());

// Sky: each button shows its gradient; a click repaints the scene behind the menu at once (the preview).
{
  const seg = document.getElementById('skySeg')!;
  const desc = document.getElementById('skyDesc')!;
  let current = skyPreset(loadSky()).id;
  const show = () => {
    for (const b of seg.children) b.classList.toggle('on', (b as HTMLElement).dataset.id === current);
    const p = skyPreset(current);
    desc.textContent = `${p.name} — ${p.desc}`;
  };
  for (const p of SKY_PRESETS) {
    const b = document.createElement('button');
    b.dataset.id = p.id;
    b.title = `${p.name}: ${p.desc}`;
    b.setAttribute('aria-label', p.name);
    b.innerHTML = `<i class="sw" style="background:${skySwatch(p)}"></i>`;
    b.addEventListener('click', () => {
      current = p.id;
      view.setSky(p.id);
      saveSky(p.id);
      show();
      b.blur();
    });
    // Hovering previews it too; leaving puts the chosen one back.
    b.addEventListener('pointerenter', () => view.setSky(p.id));
    b.addEventListener('pointerleave', () => view.setSky(current));
    seg.appendChild(b);
  }
  show();
}

// Steering: keyboard (or gamepad) or the mouse, with its sensitivity.
const sensRow = document.getElementById('sensRow')!;
const sensInput = document.getElementById('sensInput') as HTMLInputElement;
const sensOut = document.getElementById('sensOut')!;
const showSens = () => (sensOut.textContent = `${mouse.sens.toFixed(2)}×`);
sensInput.value = String(mouse.sens);
showSens();
sensRow.hidden = mouse.mode !== 'mouse';
sensInput.addEventListener('input', () => {
  mouse.sens = Number(sensInput.value);
  saveMouseSens(mouse.sens);
  showSens();
});
for (const type of ['keydown', 'keyup'] as const) sensRow.addEventListener(type, (e) => e.stopPropagation());
choice('steerSeg', 'steerDesc', [
  { id: 1, name: 'Клавиатура', desc: 'A / D (или геймпад); ЛКМ с движением мыши — осмотреться' },
  { id: 2, name: 'Мышь', desc: 'Как в Assetto Corsa: мышь влево-вправо — руль, ЛКМ — газ, ПКМ — тормоз, СКМ — обзор. Клик по игре захватывает мышь, Esc отпускает' },
] as const, mouse.mode === 'mouse' ? 2 : 1, (id) => {
  const mode = id === 2 ? 'mouse' : 'keys';
  mouse.setMode(mode);
  saveSteerMode(mode);
  sensRow.hidden = mode !== 'mouse';
});
choice('trafficSeg', 'trafficDesc', TRAFFIC_PRESETS, sim.director.preset, (id) => {
  saveTraffic(id);
  sim.director.preset = id;
  sim.traffic.reset(sim.player); // repopulate at once (the menu card hides the pop)
});
document.getElementById('testBtn')!.addEventListener('click', () => {
  location.search = '?test';
});
document.getElementById('menuBtn')!.addEventListener('click', () => {
  if (ONLINE) {
    session?.leave();
    location.href = location.pathname;
    return;
  }
  location.href = `${location.pathname}?solo`;
});
document.getElementById('resumeBtn')!.addEventListener('click', () => {
  setPaused(false);
  if (mouse.mode === 'mouse') void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  document.getElementById('resumeBtn')!.blur();
});
// Mode: single player and online are separate pages (online keeps its own sim, ring and lifecycle).
choice('modeSeg', 'modeDesc', [
  { id: 2, name: 'Онлайн', desc: 'Общее кольцо 12 км и общий трафик с другими игроками на сервере' },
  { id: 1, name: 'Одиночный', desc: 'Бесконечный хайвей, свой трафик, рекорд хранится в браузере' },
] as const, ONLINE ? 2 : 1, (id) => {
  if ((id === 2) !== ONLINE) location.search = id === 2 ? '' : '?solo';
});
// ---------------------------------------------------------------- test panel

/** Test showcases: name each section as the car enters it. */
const SECTION_LABEL = { open: 'OPEN ROAD', walls: 'NOISE WALLS', viaduct: 'VIADUCT', tunnel: 'TUNNEL', bridge: 'BRIDGE' } as const;
let lastSection = '';
function announceSection(): void {
  const c = sim.road.chunkAt(sim.player.s);
  if (c.void) return;
  const key = `${c.kind}/${c.light}`;
  if (key === lastSection) return;
  const first = lastSection === '';
  lastSection = key;
  if (!first) hud.tag(`${SECTION_LABEL[c.kind]} · ${c.light === 'led' ? 'LED' : 'SODIUM'}`, 2.5);
}

const panel = document.getElementById('testPanel')!;
const showcaseList = document.getElementById('showcases')!;

function loadShowcase(i: number): void {
  showcase = i;
  sim.loadTrack(SHOWCASES[i].script);
  view.snapCamera();
  lastSection = '';
  for (const [k, el] of [...showcaseList.children].entries()) el.classList.toggle('on', k === i);
  hud.tag(SHOWCASES[i].name.toUpperCase(), 2.5);
}

/** Buttons keep focus after a click; drop it so Space/Enter never re-trigger them while driving. */
function panelButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    onClick();
    b.blur();
  });
  parent.appendChild(b);
  return b;
}

if (TEST) {
  document.body.classList.add('test');
  sim.score.best = 0;
  panel.hidden = false;
  SHOWCASES.forEach((sc, i) => panelButton(showcaseList, `${(i + 1) % 10}  ${sc.name}`, () => loadShowcase(i)));
  const traffic = document.getElementById('patterns')!;
  const ahead = () => sim.player.s + 260;
  panelButton(traffic, 'Стенка из машин', () => sim.traffic.spawnWall(ahead(), sim.player));
  panelButton(traffic, 'Колонна', () => sim.traffic.spawnPlatoon(ahead(), sim.player));
  panelButton(traffic, 'Грузовики', () => sim.director.setMode('trucks', 1e6));
  panelButton(traffic, 'Плотный', () => sim.director.setMode('dense', 1e6));
  const toggle = panelButton(traffic, 'Трафик: вкл', () => {
    sim.traffic.enabled = !sim.traffic.enabled;
    if (!sim.traffic.enabled) sim.traffic.clearAround(sim.player.s, 1e9);
    toggle.textContent = `Трафик: ${sim.traffic.enabled ? 'вкл' : 'выкл'}`;
  });
  sim.director.setMode('normal', 1e6);
  start();
  loadShowcase(0);
}

document.addEventListener('visibilitychange', () => {
  // Online the server takes a hidden tab's car off the road and puts it back on return.
  if (document.hidden && state === 'play' && !ONLINE) setPaused(true);
});

/** A server correction of our car over 3 m is worth a report (it means the prediction went far off). */
let correctionsSeen = 0;
let correctionCheck = 0;
function watchCorrections(now: number): void {
  if (!session || now - correctionCheck < 1000) return;
  correctionCheck = now;
  const st = session.core.stats;
  if (st.corrections !== correctionsSeen && st.lastCorrection > 3) {
    report('warn', 'big prediction correction', `last ${st.lastCorrection.toFixed(2)} m, ping ${st.rtt.toFixed(0)} ms, ahead ${st.horizon} steps`);
  }
  correctionsSeen = st.corrections;
}

/** Online menu card open: no pedals, no steering (the car rolls on). */
const NEUTRAL: DriveInput = { steer: 0, throttle: 0, brake: 0 };

/** Menu background: keep the lane, cruise at ~105 km/h, follow the car ahead. */
const auto: DriveInput = { steer: 0, throttle: 0, brake: 0 };
function autopilot(): DriveInput {
  const p = sim.player;
  const lane = clamp(Math.round((p.d - laneCenter(0)) / (laneCenter(1) - laneCenter(0))), 0, LANES - 1);
  auto.steer = clamp((laneCenter(lane) - p.d) * 0.25 - p.psi * 12, -1, 1);
  let gap = Infinity;
  let lead = 0;
  for (const c of sim.traffic.cars) {
    if (!c.active || c.s <= p.s || Math.abs(c.d - p.d) > 2.4) continue;
    const g = c.s - p.s;
    if (g < gap) {
      gap = g;
      lead = c.v;
    }
  }
  const want = gap < 70 ? Math.min(29, lead - (gap < 30 ? 3 : 0)) : 29;
  auto.throttle = p.vAlong < want - 0.5 ? 0.6 : 0;
  auto.brake = p.vAlong > want + 1.5 ? 0.6 : 0;
  return auto;
}

const STEP = 1 / SIM_HZ;
let acc = 0;
let last = performance.now();
view.renderer.setAnimationLoop((now: number) => {
  const frameMs = now - last;
  const dt = Math.min(frameMs / 1000, 0.1);
  last = now;
  input.poll();
  const t0 = performance.now();
  let n = 0;
  if (session && session.core.ready && state !== 'menu') {
    // Online: our car is predicted step by step; the server confirms (and corrects) it. The world
    // runs in real time, so a slow frame is caught up further than offline (up to 0.25 s).
    acc += Math.min(frameMs / 1000, 0.25);
    while (acc >= STEP && n < 30) {
      session.step(withControls(onlineMenu ? NEUTRAL : input.drive));
      acc -= STEP;
      n++;
    }
    if (n === 30) acc = 0;
    session.frame(dt);
  } else if (session && state !== 'menu') {
    // Joined, first snapshot on its way: nothing to step yet.
    acc = 0;
  } else if (state !== 'pause') {
    acc += dt;
    while (acc >= STEP && n < 12) {
      sim.step(STEP, state === 'play' ? withControls(input.drive) : autopilot());
      acc -= STEP;
      n++;
    }
    if (n === 12) acc = 0;
  }
  const t1 = performance.now();
  metrics.gpuBegin();
  // Paused: effects (sparks, camera shake, blinkers) freeze along with the sim.
  view.render(state === 'pause' ? 1 : acc / STEP, state === 'pause' ? 0 : dt);
  if (session?.core.ready && loading.active && loading.context === 'online') {
    loading.context = 'ready';
    loading.finish();
  }
  metrics.gpuEnd();
  const t2 = performance.now();
  hud.update(dt);
  hud.setPhysicalInstruments(car===1&&view.cameraMode==='cockpit');
  updateBlinker();
  updateMouseHud();
  // C held: rear view (while driving).
  view.setLookBack(state === 'play' && input.isDown('KeyC'));
  if (onlineHud && session) onlineHud.update(view, session.core.stats, dt);
  sound.setCockpit(view.cameraMode === 'cockpit');
  sound.update(state === 'pause' ? 0 : dt);
  metrics.frame(frameMs, t1 - t0, t2 - t1, n);
  diagFrame(frameMs);
  watchCorrections(now);
  if (TEST && state === 'play') announceSection();
  if (debugOn) debug?.update();
});

await loading.stage(45, 'Загрузка выбранного автомобиля');
await waitForCar(car, (fraction, unpacking) => loading.set(45 + fraction * 45, unpacking ? 'Подготовка материалов автомобиля' : 'Загрузка автомобиля'));
await loading.stage(95, 'Подготовка первого кадра');
view.render(1, 0);
await view.prepareCar();
