import './style.css';
import { LANES, SIM_HZ, laneCenter } from './config';
import { Sound } from './audio/sound';
import { Input } from './core/input';
import { clamp } from './core/math';
import { View } from './render/view';
import type { DriveInput } from './sim/vehicle';
import { TRAFFIC_PRESETS } from './sim/director';
import { PHYSICS, type PhysicsId } from './sim/physics';
import { spawnS } from './sim/ring';
import { SHOWCASES } from './sim/testTrack';
import { Sim } from './sim/world';
import { conditionsFromUrl, healthUrl, serverUrl } from './online/link';
import { OnlineSession } from './online/session';
import type { Debug } from './ui/debug';
import { QUALITY, loadName, loadPhysics, loadQuality, loadTraffic, saveName, savePhysics, saveQuality, saveTraffic, type Quality } from './settings';
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
/** ?online: the shared ring on the game server (its own page lifecycle: leaving reloads the page). */
const ONLINE = params.has('online') && !TEST;
let showcase = 0;
const sim = new Sim(Math.random, { track: TEST ? SHOWCASES[0].script : undefined, physics: loadPhysics(), online: ONLINE });
sim.director.preset = loadTraffic();
sim.score.best = ONLINE ? 0 : loadBest();
sim.score.grace = Infinity; // the menu attract mode never scores
const quality = loadQuality();
const view = new View(canvas, sim, QUALITY[quality]);
const hud = new Hud(sim);
const input = new Input();
const sound = new Sound(sim);
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
});

function start(): void {
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
}

/** Online the world never stops: P / Esc only show the menu card while the car rolls on without input. */
let onlineMenu = false;
function setPaused(paused: boolean): void {
  if (state === 'menu') return;
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
  const name = nameInput.value.trim().slice(0, 16) || 'Driver';
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
        ohud.setMe(session!.core.id);
        ohud.setStatus('');
        menuMessage('');
        if (state === 'menu') enterPlay();
      } else if (st === 'connecting') {
        menuMessage(text);
      } else if (st === 'reconnecting') {
        ohud.setStatus(text, true);
      } else if (st === 'failed') {
        ohud.setStatus('');
        menuMessage(text, true);
        if (state !== 'menu') {
          // Back to the menu card; the car stays where the server left it.
          state = 'menu';
          onlineMenu = false;
          pauseEl.classList.add('hidden');
          document.body.classList.add('menu');
          startEl.classList.remove('hidden');
        }
      }
    },
    onPlayers: (list) => ohud.players(list),
    onFeed: (text) => ohud.addFeed(text),
    onTeleport: () => {
      view.snapCamera();
      const mine = sim.spawn.mine;
      if (mine >= 0 && Math.abs(sim.road.rel(sim.player.s, spawnS(mine))) < 3) hud.tag(`SPAWN · МЕСТО ${mine + 1}`, 2.5);
    },
  });
  session.start(name, sim.player.physicsId as PhysicsId);
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

if (ONLINE) {
  document.body.classList.add('online');
  nameInput.value = loadName();
  nameInput.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') start();
    e.stopPropagation(); // typing a name must not drive, pause or switch cameras
  });
  nameInput.addEventListener('keyup', (e) => e.stopPropagation());
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

input.onPress = (code) => {
  if (code === 'Backquote') void toggleDebug();
  else if (code === 'F1') metrics.toggle();
  else if (code === 'KeyC') hud.tag(`CAMERA · ${view.cycleCamera().toUpperCase()}`);
  else if (code === 'KeyM') hud.tag(sound.toggleMute() ? 'SOUND OFF' : 'SOUND ON');
  else if (state === 'menu' && (code === 'Enter' || code === 'Space')) start();
  else if (code === 'KeyP' || code === 'Escape') setPaused(ONLINE ? !onlineMenu : state === 'play');
  else if (code === 'KeyR' && state === 'play') {
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
    b.innerHTML = `<b>${it.id}</b>${it.name}`;
    b.addEventListener('click', () => {
      show(it.id);
      onPick(it.id);
      b.blur(); // keep Space/Enter for starting the run
    });
    seg.appendChild(b);
  }
  show(current);
}
choice('physicsSeg', 'physicsDesc', PHYSICS, sim.player.physicsId as 1 | 2, (id) => {
  savePhysics(id);
  sim.setPhysics(id);
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
    location.href = `${location.pathname}?online`;
    return;
  }
  location.href = location.pathname;
});
// Mode: single player and online are separate pages (online keeps its own sim, ring and lifecycle).
choice('modeSeg', 'modeDesc', [
  { id: 1, name: 'Одиночный', desc: 'Бесконечный хайвей, свой трафик, рекорд хранится в браузере' },
  { id: 2, name: 'Онлайн', desc: 'Общее кольцо 12 км и общий трафик с другими игроками на сервере' },
] as const, ONLINE ? 2 : 1, (id) => {
  if ((id === 2) !== ONLINE) location.search = id === 2 ? '?online' : '';
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
      session.step(onlineMenu ? NEUTRAL : input.drive);
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
      sim.step(STEP, state === 'play' ? input.drive : autopilot());
      acc -= STEP;
      n++;
    }
    if (n === 12) acc = 0;
  }
  const t1 = performance.now();
  metrics.gpuBegin();
  // Paused: effects (sparks, camera shake, blinkers) freeze along with the sim.
  view.render(state === 'pause' ? 1 : acc / STEP, state === 'pause' ? 0 : dt);
  metrics.gpuEnd();
  const t2 = performance.now();
  hud.update(dt);
  if (onlineHud && session) onlineHud.update(view, session.core.stats, dt);
  sound.update(state === 'pause' ? 0 : dt);
  metrics.frame(frameMs, t1 - t0, t2 - t1, n);
  if (TEST && state === 'play') announceSection();
  if (debugOn) debug?.update();
});
