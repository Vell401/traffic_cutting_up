import './style.css';
import './menu.css';
import './mobile.css';
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
import { bodyPhysics, type PhysicsId } from './sim/physics';
import { getMap, mapSpawnS } from './sim/maps';
import { SHOWCASES } from './sim/testTrack';
import { Sim } from './sim/world';
import { apiBase, conditionsFromUrl, healthUrl, serverUrl } from './online/link';
import { diagFrame, initDiag, report } from './diag';
import { Leaderboard } from './ui/leaderboard';
import { Mixer } from './ui/mixer';
import { Radio } from './ui/radio';
import { initModelLoad } from './ui/modelLoad';
import { OnlineSession } from './online/session';
import { syncHttpTuning } from './online/tuningSync';
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
  loadSteerMode,
  loadTraffic,
  saveCameraMode,
  saveCar,
  saveManual,
  saveMouseSens,
  saveName,
  savePaint,
  saveQuality,
  saveSteerMode,
  saveTraffic,
  type Quality,
} from './settings';
import { Hud } from './ui/hud';
import { Metrics } from './ui/metrics';
import { OnlineHud } from './ui/onlineHud';
import { TouchControls } from './ui/touchControls';
import { Fullscreen } from './ui/fullscreen';
import { loadMapSky, mapNavigation, modeNavigation, mountServerPicker, saveMapSky, saveSelectedMap, selectedMap } from './ui/serverPicker';
import { Chat } from './ui/chat';
import { isMenuControl } from './ui/menuInput';

const params = new URLSearchParams(location.search);
/** Test showcases retain their original road/theme; regular play keeps the selected instance. */
const TEST = params.has('test');
const MAP_ID = TEST ? 'highway' : selectedMap(params);
const MAP = getMap(MAP_ID);
if (!TEST) saveSelectedMap(MAP_ID);
document.body.dataset.map = MAP_ID;
const BEST_KEY = MAP_ID === 'highway' ? 'tcu.best.v1' : `tcu.best.v1.${MAP_ID}`;
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
/**
 * Online by default: the shared ring on the game server. ?solo: single player.
 * Both return to their resident menu without losing decoded assets or the WebGL context.
 */
const ONLINE = !TEST && !params.has('solo');
const SERVER_URL = serverUrl(params, MAP_ID);
const API = apiBase(SERVER_URL);
// Do not leave model downloads idle behind a slow/offline tuning endpoint.
void syncHttpTuning(API, ONLINE);
if (!ONLINE && !TEST) window.setInterval(() => void syncHttpTuning(API, ONLINE), 15000);
let showcase = 0;
await loading.stage(18, 'Подготовка трассы и трафика');
const initialCar = loadCar();
const sim = new Sim(Math.random, { map: MAP_ID, track: TEST ? SHOWCASES[0].script : undefined, physics: bodyPhysics(initialCar), online: ONLINE });
sim.director.preset = loadTraffic();
sim.score.best = ONLINE ? 0 : loadBest();
sim.score.grace = Infinity; // the menu attract mode never scores
const quality = loadQuality();
let car: CarId = loadCar();
let paint = loadPaint(car);
// Before the view: building the chosen car may start a model download right away.
initModelLoad();
await loading.stage(28, 'Создание сцены');
// Observe the first selected request before constructing its view. Retain its rejection rather
// than silently starting another download later while the original instance remains failed.
let showSelectedProgress = false;
const selectedCarDownload = waitForCar(car, (fraction, unpacking) => {
  if (showSelectedProgress) loading.set(45 + fraction * 45, unpacking ? 'Подготовка материалов автомобиля' : 'Загрузка автомобиля');
});
void selectedCarDownload.catch(() => {});
const view = new View(canvas, sim, QUALITY[quality], car, paint);
await loading.stage(40, 'Подготовка управления и интерфейса');
// Each car remembers its own camera.
view.setCar(car, loadCameraMode(car) as CameraMode);
view.setSky(skyPreset(loadMapSky(MAP_ID, MAP.defaultSky)).id);
const hud = new Hud(sim);
initDiag(API, ONLINE ? 'online' : TEST ? 'test' : 'solo', quality, canvas, view.renderer.getContext());
const input = new Input();
const sound = new Sound(sim);
sound.setCar(car);
const mixer = new Mixer(sound, level => view.setScoreDistortion(level));
const radio = new Radio(API, sound);
const metrics = new Metrics(view.renderer, sim, () => `quality ${quality}  audio ${sound.state}`);
// Audio may only start after a user gesture.
window.addEventListener('keydown', () => sound.unlock());
window.addEventListener('pointerdown', () => sound.unlock());

type State = 'menu' | 'play' | 'pause';
let state: State = 'menu';
document.body.classList.add('menu');
const startEl = document.getElementById('start')!;
const pauseEl = document.getElementById('pause')!;
const fullscreen = new Fullscreen(); // document root includes canvas AND every DOM control
const touchLayout = matchMedia('(pointer: coarse), (max-width: 760px)');
const touch = new TouchControls(input, code => input.onPress?.(code));
// Move, don't clone, the existing audio widgets: their listeners/playback remain untouched.
const audioPanels = ['radio', 'mixer'].map(id => {
  const element = document.getElementById(id)!;
  const home = document.createComment(`${id} desktop position`);
  element.before(home);
  return { element, home };
});
const mobileAudio = document.createElement('details');
mobileAudio.className = 'mobile-audio';
const audioSummary = document.createElement('summary');
audioSummary.textContent = 'Радио и звук';
mobileAudio.append(audioSummary);
touch.toolbar.append(fullscreen.button());
for (const id of ['screenOptions', 'pauseScreenOptions']) {
  document.getElementById(id)!.append(fullscreen.button(), fullscreen.notice());
}
let touchSnapshot = '';
function syncTouch(): void {
  const paused = state === 'pause' || onlineMenu;
  const driving = touchLayout.matches && state === 'play' && !onlineMenu && !chat.active && !loading.active;
  const snapshot = `${touchLayout.matches}/${state}/${paused}/${driving}/${chat.active}/${loading.active}`;
  if (snapshot === touchSnapshot) return;
  touchSnapshot = snapshot;
  mixer.setVisible(!loading.active && (state === 'menu' || paused));
  startEl.inert = loading.active || state !== 'menu';
  pauseEl.inert = loading.active || !paused;
  document.body.classList.toggle('touch-ui', touchLayout.matches);
  document.body.classList.toggle('driving-touch', driving);
  touch.setActive(driving);
  if (touchLayout.matches) {
    const parent = (paused ? pauseEl.querySelector('.pause-settings') : startEl.querySelector('.card'))!;
    if (mobileAudio.parentElement !== parent) parent.append(mobileAudio);
    for (const { element } of audioPanels) if (element.parentElement !== mobileAudio) mobileAudio.append(element);
  } else {
    for (const { element, home } of audioPanels) {
      if (element.id === 'mixer' && paused) {
        const parent = document.getElementById('pauseMixer')!;
        if (element.parentElement !== parent) parent.append(element);
      } else if (element.previousSibling !== home) home.after(element);
    }
    mobileAudio.remove();
  }
  loading.refreshLocks(); // Audio moved out of an inert menu must stay locked until loading ends.
}
// Unlock synchronously: a loader must never clear the hidden overlays' lifecycle-owned inertness.
loading.onLockChange = () => { touchSnapshot = ''; syncTouch(); };
touchLayout.addEventListener('change', () => { touch.releaseAll(); syncTouch(); });

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
  if (mouse.mode === 'mouse' && !touchLayout.matches) void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  syncTouch();
}

/** Online the world never stops: P / Esc only show the menu card while the car rolls on without input. */
let onlineMenu = false;
function setPaused(paused: boolean): void {
  if (state === 'menu') return;
  touch.releaseAll();
  input.releaseAll();
  pendingShift = 0;
  if (chat.active) chat.close();
  document.body.classList.toggle('paused', paused);
  if (paused && mouse.locked) document.exitPointerLock();
  if (ONLINE) {
    onlineMenu = paused;
    pauseEl.classList.toggle('hidden', !paused);
    syncTouch();
    if (paused) document.getElementById('resumeBtn')!.focus({ preventScroll: true });
    return;
  }
  state = paused ? 'pause' : 'play';
  pauseEl.classList.toggle('hidden', !paused);
  sound.setPaused(paused);
  syncTouch();
  if (paused) document.getElementById('resumeBtn')!.focus({ preventScroll: true });
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
  session?.leave();
  loading.begin('online', `Подключаемся · ${MAP.name}`);
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
  session = new OnlineSession(sim, SERVER_URL, conditionsFromUrl(params), {
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
        chat.reset();
        if (state !== 'menu') {
          // Back to the menu card; the car stays where the server left it.
          state = 'menu';
          onlineMenu = false;
          pauseEl.classList.add('hidden');
          document.body.classList.remove('paused');
          document.body.classList.add('menu');
          if (mouse.locked) document.exitPointerLock();
          startEl.classList.remove('hidden');
          input.releaseAll();
          syncTouch();
        }
      }
    },
    onPlayers: (list) => ohud.players(list),
    onFeed: (text) => ohud.addFeed(text),
    onChat: (message) => chat.receive(message.name, message.text),
    onAnnounce: (text) => {
      ohud.announce(text);
      sound.notice();
    },
    onTeleport: () => {
      view.snapCamera();
      void syncAuthoritativeCar();
      if (Math.abs(sim.road.rel(sim.player.s, mapSpawnS(MAP, 0))) < 3) hud.tag('SPAWN · ВЫ НЕВИДИМЫ, ПОКА НА ПЛОЩАДКЕ', 2.5);
    },
  });
  session.start(name, sim.player.physicsId as PhysicsId, car, paint);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __game: object }).__game, { session });
}

/** Menu line under the name field: is the server up, how many are driving. */
async function probeServer(): Promise<void> {
  const info = document.getElementById('serverInfo')!;
  const url = SERVER_URL;
  info.textContent = `${MAP.name} · ${url.replace(/^wss?:\/\//, '')} …`;
  try {
    const res = await fetch(healthUrl(url), { cache: 'no-store' });
    const h = (await res.json()) as { map?: string; players: number };
    if (!res.ok || h.map !== MAP_ID) throw new Error('Server map does not match selection');
    info.textContent = `${MAP.name} · на связи · на трассе ${h.players}`;
  } catch {
    info.textContent = `${MAP.name} недоступен или адрес ведёт на другую карту`;
  }
}

// The driver's name: online it is shown to others, both modes put it on the leaderboard.
// A cleared field falls back to the saved (or first random) name, never a shared "Driver".
const defaultName = loadName();
const playerName = (): string => nameInput.value.trim().slice(0, 16) || defaultName;
nameInput.value = defaultName;
nameInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { e.preventDefault(); nameInput.blur(); }
  e.stopPropagation(); // typing a name must not drive, pause or switch cameras
});
nameInput.addEventListener('keyup', (e) => e.stopPropagation());
nameInput.addEventListener('change', () => {
  saveName(playerName());
  void leaders?.refresh(); // our place is looked up by name
});
const leaders = TEST ? null : new Leaderboard(API, playerName, MAP_ID);
mountServerPicker(document.getElementById('serverChoiceRoot')!, MAP_ID, map => {
  saveSelectedMap(map);
  location.href = mapNavigation(new URL(location.href), map).href;
});
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
if (import.meta.env.DEV) Object.assign(window, { __game: { sim, view, input, hud, metrics, sound, radio } });

// ---------------------------------------------------------------- mouse

// Keyboard steering: the left button held on the game view looks around. Mouse steering (as in
// Assetto Corsa): a click captures the pointer, side-to-side turns the wheel, left button throttle,
// right brake, middle looks around, Esc lets go (and pauses).
const mouse = new MouseControl(
  canvas,
  {
    look: (dx, dy) => { if (!chat.active) view.look(dx, dy); },
    driving: () => state === 'play' && !chat.active && !loading.active && !(ONLINE && onlineMenu),
    released: () => { if (!chat.active) setPaused(true); },
  },
  loadSteerMode(),
  loadMouseSens(),
);
input.mouse = mouse;
const chat = new Chat({
  available: () => state === 'play' && !onlineMenu && session?.state === 'joined',
  send: text => session?.sendChat(text) ?? false,
  focus: active => {
    input.setEnabled(!active);
    if (active) pendingShift = 0;
    if (active && mouse.locked) document.exitPointerLock();
    syncTouch();
  },
});
const mouseWheel = document.getElementById('mouseWheel')!;
const mouseWheelMark = mouseWheel.querySelector('i')!;
const mouseHint = document.getElementById('mouseHint')!;

/** Per frame: the wheel position strip while steering with the mouse, the capture hint before. */
function updateMouseHud(): void {
  const on = mouse.mode === 'mouse' && state === 'play' && !chat.active && !(ONLINE && onlineMenu);
  mouseWheel.hidden = !(on && mouse.locked);
  mouseHint.hidden = !(on && !mouse.locked);
  if (!mouseWheel.hidden) mouseWheelMark.style.left = `${50 + mouse.steer * 50}%`;
}

// ---------------------------------------------------------------- gearbox and turn signals

/** G switches the gearbox; Z / X shift down / up in manual (one shift per press, in the next step). Y toggles ESP. */
let manualGears = loadManual();
let pendingShift = 0;
const gearboxBtn = document.getElementById('gearboxBtn')!;
function syncGearbox(): void {
  touch.setManual(manualGears);
  gearboxBtn.textContent = manualGears ? 'Коробка: ручная' : 'Коробка: автомат';
  gearboxBtn.setAttribute('aria-pressed', String(manualGears));
}
gearboxBtn.addEventListener('click', () => { input.onPress?.('KeyG'); gearboxBtn.blur(); });
syncGearbox();
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
  const player = sim.player as typeof sim.player & { tractionControlEnabled?: boolean; espEnabled?: boolean };
  if (player.tractionControlEnabled !== undefined) d.tractionControlEnabled = player.tractionControlEnabled;
  if (player.espEnabled !== undefined) d.espEnabled = player.espEnabled;
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

input.onPress = (code, event) => {
  if (loading.active) return;
  if (code === 'Enter' && state === 'play' && !onlineMenu) {
    // Focusing a form during this keydown must not submit it with the opening Enter's default action.
    event?.preventDefault();
    chat.open();
  }
  else if (code === 'Backquote') void toggleDebug();
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
  else if (code === 'KeyT' && state === 'play') {
    const player = sim.player;
    if ('tractionControlEnabled' in player) {
      player.tractionControlEnabled = !player.tractionControlEnabled;
      hud.tag(player.tractionControlEnabled ? 'TRACTION CONTROL · ON' : 'TRACTION CONTROL · OFF', 2);
    }
  }
  else if (code === 'KeyY' && state === 'play') {
    const player = sim.player;
    if ('espEnabled' in player) {
      player.espEnabled = !player.espEnabled;
      hud.tag(player.espEnabled ? 'ESP · ON' : 'ESP · OFF', 2);
    }
  }
  else if (code === 'KeyM') {
    hud.tag(sound.toggleMute() ? 'SOUND OFF' : 'SOUND ON');
    mixer.sync();
  }
  else if (code === 'KeyG') {
    manualGears = !manualGears;
    saveManual(manualGears);
    syncGearbox();
    hud.tag(manualGears ? 'КОРОБКА · РУЧНАЯ  (Z ↓  X ↑)' : 'КОРОБКА · АВТОМАТ', 2);
  } else if ((code === 'KeyX' || code === 'KeyZ') && state === 'play') {
    if (manualGears) pendingShift = code === 'KeyX' ? 1 : -1;
    else hud.tag('ПЕРЕДАЧИ Z / X — В РУЧНОМ РЕЖИМЕ (G)', 2);
  } else if (code === 'KeyQ' && state === 'play') setBlinker(1);
  else if (code === 'KeyE' && state === 'play') setBlinker(2);
  else if (state === 'menu' && (code === 'Enter' || code === 'Space') && !isMenuControl(event?.target ?? null)) start();
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
): (id: T) => void {
  const seg = document.getElementById(segId)!;
  const desc = document.getElementById(descId)!;
  const show = (id: T) => {
    for (const b of seg.children) {
      const selected = (b as HTMLElement).dataset.id === String(id);
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', String(selected));
    }
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
    });
    seg.appendChild(b);
  }
  show(current);
  return show;
}
const showCar = choice('carSeg', 'carDesc', CARS, car, id => void chooseCar(id));
const showPauseCar = choice('pauseCarSeg', 'pauseCarDesc', CARS, car, id => void chooseCar(id));
let carRevision = 0;
let choosingCar = false;
let restoringCar = false;
async function chooseCar(id: CarId): Promise<void> {
  if (id === car) return;
  choosingCar = true;
  const revision = ++carRevision;
  loading.begin('car', 'Готовим твою машину');
  try {
    await loading.stage(10, 'Подготовка модели');
    await waitForCar(id, (fraction, unpacking) => {
      if (revision === carRevision) loading.set(15 + fraction * 70, unpacking ? 'Подготовка материалов' : 'Загрузка автомобиля');
    });
    if (revision !== carRevision) return;
    const color = loadPaint(id);
    if (session && state !== 'menu') await session.changeCar(id, color);
    else sim.setPhysics(bodyPhysics(id), state !== 'menu');
    if (revision !== carRevision) return;
    car = id;
    paint = color;
    saveCar(id);
    sound.setCar(id);
    view.setPaint(paint);
    view.setCar(id, loadCameraMode(id) as CameraMode);
    showPaint();
    showCar(id);
    showPauseCar(id);
    pendingShift = 0;
    blinker = 0;
    mouse.centre();
    await loading.stage(92, 'Подготовка первого кадра');
    view.render(1, 0);
    await view.prepareCar();
    if (revision === carRevision) loading.finish();
  } catch (error) {
    if (revision !== carRevision) return;
    showCar(car);
    showPauseCar(car);
    console.warn('Car selection failed', error);
    loading.fail('Не удалось сменить автомобиль. Проверьте подключение и попробуйте ещё раз.', () => {}, 'Вернуться');
  } finally {
    if (revision === carRevision) choosingCar = false;
  }
}

/** A dropped garage ACK must not leave the old visual body on the server's new chassis. */
async function syncAuthoritativeCar(): Promise<void> {
  if (!session || choosingCar) return;
  const owner = session;
  const own = owner.core.players.find(player => player.id === owner.core.id);
  if (!own || own.physics !== sim.player.physicsId || (own.car === car && own.color === paint)) return;
  const revision = ++carRevision;
  restoringCar = true;
  const showLoading = !loading.active;
  if (showLoading) loading.begin('car-sync', 'Восстанавливаем автомобиль');
  try {
    await waitForCar(own.car);
    if (owner !== session || revision !== carRevision) return;
    car = own.car;
    paint = own.color;
    saveCar(car);
    sound.setCar(car);
    view.setPaint(paint);
    view.setCar(car, loadCameraMode(car) as CameraMode);
    showPaint();
    showCar(car);
    showPauseCar(car);
    await view.prepareCar();
    if (showLoading && revision === carRevision && loading.context === 'car-sync') loading.finish();
  } catch (error) {
    if (owner !== session || revision !== carRevision) return;
    console.warn('Authoritative car restoration failed', error);
    if (showLoading || loading.context === 'online') loading.fail('Не удалось восстановить модель автомобиля.', () => { void syncAuthoritativeCar(); });
  } finally {
    if (revision === carRevision) restoringCar = false;
  }
}

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
  button.onclick = () => choosePaint(color);
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
  // Phones/tablets reflow and scroll at native text/target size; never shrink the desktop plate.
  if (touchLayout.matches) return;
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
const pauseKeysBox = document.getElementById('pauseKeysBox')!;
pauseKeysBox.appendChild(keysBox.querySelector('.keys')!.cloneNode(true));

// Sky: each button shows its gradient; a click repaints the scene behind the menu at once (the preview).
{
  const seg = document.getElementById('skySeg')!;
  const desc = document.getElementById('skyDesc')!;
  let current = skyPreset(loadMapSky(MAP_ID, MAP.defaultSky)).id;
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
      saveMapSky(MAP_ID, p.id);
      show();
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
const pauseSensInput = document.getElementById('pauseSensInput') as HTMLInputElement;
const pauseSensOut = document.getElementById('pauseSensOut')!;
const pauseSensRow = pauseSensInput.closest('label')!;
const showSens = () => {
  sensOut.textContent = pauseSensOut.textContent = `${mouse.sens.toFixed(2)}×`;
  sensInput.value = pauseSensInput.value = String(mouse.sens);
};
showSens();
sensRow.hidden = mouse.mode !== 'mouse';
pauseSensRow.hidden = mouse.mode !== 'mouse';
for (const slider of [sensInput, pauseSensInput]) {
  slider.addEventListener('input', () => {
    mouse.sens = Number(slider.value);
    saveMouseSens(mouse.sens);
    showSens();
  });
  for (const type of ['keydown', 'keyup'] as const) slider.addEventListener(type, e => {
    if (e.code === 'Escape' || e.code === 'KeyP') slider.blur();
    else e.stopPropagation();
  });
}
const steeringChoices = [
  { id: 1, name: 'Клавиатура', desc: 'A / D (или геймпад); ЛКМ с движением мыши — осмотреться' },
  { id: 2, name: 'Мышь', desc: 'Как в Assetto Corsa: мышь влево-вправо — руль, ЛКМ — газ, ПКМ — тормоз, СКМ — обзор. Клик по игре захватывает мышь, Esc отпускает' },
] as const;
function chooseSteering(id: 1 | 2): void {
  const mode = id === 2 ? 'mouse' : 'keys';
  mouse.setMode(mode);
  saveSteerMode(mode);
  sensRow.hidden = mode !== 'mouse';
  pauseSensRow.hidden = mode !== 'mouse';
  showSteering(id);
  showPauseSteering(id);
}
const showSteering = choice('steerSeg', 'steerDesc', steeringChoices, mouse.mode === 'mouse' ? 2 : 1, chooseSteering);
const showPauseSteering = choice('pauseSteerSeg', 'pauseSteerDesc', steeringChoices, mouse.mode === 'mouse' ? 2 : 1, chooseSteering);
choice('trafficSeg', 'trafficDesc', TRAFFIC_PRESETS, sim.director.preset, (id) => {
  saveTraffic(id);
  sim.director.preset = id;
  sim.traffic.reset(sim.player); // repopulate at once (the menu card hides the pop)
});
document.getElementById('testBtn')!.addEventListener('click', () => {
  location.search = '?test';
});
document.getElementById('menuBtn')!.addEventListener('click', () => {
  // Keep the WebGL context, decoded models, audio and shaders resident on a normal exit.
  session?.leave();
  session = null;
  metrics.net = null;
  onlineHud?.reset();
  sim.remotes.length = 0;
  sim.spawn.owners.length = 0;
  sim.spawn.mine = -1;
  sim.visual.ds = sim.visual.dd = sim.visual.dpsi = 0;
  chat.reset();
  touch.releaseAll();
  input.releaseAll();
  if (mouse.locked) document.exitPointerLock();
  state = 'menu';
  onlineMenu = false;
  pendingShift = 0;
  blinker = 0;
  acc = 0;
  sound.setPaused(false);
  sim.score.resetRun();
  if (TEST) loadShowcase(showcase);
  sim.score.grace = Infinity;
  pauseEl.classList.add('hidden');
  startEl.classList.remove('hidden');
  document.body.classList.remove('paused');
  document.body.classList.add('menu');
  menuMessage('');
  fitMenu();
  syncTouch();
  void leaders?.refresh();
  if (ONLINE) void probeServer();
});
document.getElementById('resumeBtn')!.addEventListener('click', () => {
  setPaused(false);
  if (mouse.mode === 'mouse' && !touchLayout.matches) void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  document.getElementById('resumeBtn')!.blur();
});
// Mode: single player and online are separate pages (online keeps its own sim, ring and lifecycle).
choice('modeSeg', 'modeDesc', [
  { id: 2, name: 'Онлайн', desc: `${MAP.name} · общее кольцо 12 км; трафик, игроки и рекорды этого сервера` },
  { id: 1, name: 'Одиночный', desc: MAP_ID === 'miami' ? 'Miami · прибрежное кольцо, свой трафик и отдельные рекорды' : 'Бесконечный хайвей, свой трафик, рекорд хранится в браузере' },
] as const, ONLINE ? 2 : 1, (id) => {
  if ((id === 2) !== ONLINE) location.href = modeNavigation(new URL(location.href), id === 2 ? 'online' : 'solo').href;
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
const NEUTRAL: DriveInput = { steer: 0, throttle: 0, brake: 0, analog: false, direct: false, keyboardSteer: false, clutch: false, boost: false, handbrake: false, horn: false };

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
  syncTouch();
  const t0 = performance.now();
  let n = 0;
  if (session && session.core.ready && state !== 'menu') {
    // Online: our car is predicted step by step; the server confirms (and corrects) it. The world
    // runs in real time, so a slow frame is caught up further than offline (up to 0.25 s).
    acc += Math.min(frameMs / 1000, 0.25);
    while (acc >= STEP && n < 30) {
      session.step(withControls(onlineMenu || chat.active || loading.active ? NEUTRAL : input.drive));
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
      sim.step(STEP, state === 'play' ? withControls(chat.active || loading.active ? NEUTRAL : input.drive) : autopilot());
      acc -= STEP;
      n++;
    }
    if (n === 12) acc = 0;
  }
  const t1 = performance.now();
  metrics.gpuBegin();
  // Paused: effects (sparks, camera shake, blinkers) freeze along with the sim.
  view.render(state === 'pause' ? 1 : acc / STEP, state === 'pause' ? 0 : dt);
  if (session?.core.ready && !restoringCar && loading.active && loading.context === 'online') {
    loading.context = 'ready';
    loading.finish();
  }
  metrics.gpuEnd();
  const t2 = performance.now();
  hud.update(dt);
  if (touchLayout.matches) touch.update(document.getElementById('kmh')!.textContent!, document.getElementById('gear')!.textContent!);
  hud.setPhysicalInstruments((car===1||car===4)&&view.cameraMode==='cockpit');
  updateBlinker();
  updateMouseHud();
  // C held: rear view (while driving).
   view.setLookBack(state === 'play' && !chat.active && input.isDown('KeyC'));
  if (onlineHud && session) onlineHud.update(view, session.core.stats, dt);
  sound.setCockpit(view.cameraMode === 'cockpit');
  sound.update(state === 'pause' ? 0 : dt);
  metrics.frame(frameMs, t1 - t0, t2 - t1, n);
  const performanceActive = !loading.active && !document.hidden && state === 'play' && !onlineMenu;
  view.adaptResolution(frameMs, t2 - t0, performanceActive);
  diagFrame(frameMs, t1 - t0, t2 - t1, () => ({
    calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles,
    dpr: view.renderer.getPixelRatio(), width: canvas.width, height: canvas.height,
    traffic: sim.traffic.activeCount, players: sim.remotes.length, camera: view.cameraMode,
    pingMs: session?.core.stats.rtt,
  }), performanceActive);
  watchCorrections(now);
  if (TEST && state === 'play') announceSection();
  if (debugOn) debug?.update();
});

// Boot readiness: optional models must not prevent a usable selected car from reaching the menu.
try {
  showSelectedProgress = true;
  await loading.stage(45, 'Загрузка выбранного автомобиля');
  await selectedCarDownload;
  // Nearby remote cars use their proxy until their detailed model is ready; never block boot on all bodies.
  await loading.stage(95, 'Подготовка первого кадра');
  view.render(1, 0);
  await view.prepareCar();
} catch (error) {
  report('error', 'Selected car startup preparation failed', String(error));
  loading.fail('Не удалось подготовить выбранный автомобиль. Проверьте соединение и повторите загрузку.', () => location.reload());
  // boot.ts finishes the loading screen when this module resolves. Keep a failed boot pending
  // until the explicit reload action reconstructs the selected view and retries its model.
  await new Promise(() => {});
}
