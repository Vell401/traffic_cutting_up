import './style.css';
import { LANES, SIM_HZ, laneCenter } from './config';
import { Input } from './core/input';
import { clamp } from './core/math';
import { View } from './render/view';
import type { DriveInput } from './sim/vehicle';
import { Sim } from './sim/world';
import type { Debug } from './ui/debug';
import { Hud } from './ui/hud';
import { Metrics } from './ui/metrics';

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
const sim = new Sim();
sim.score.best = loadBest();
sim.score.grace = Infinity; // the menu attract mode never scores
const view = new View(canvas, sim);
const hud = new Hud(sim);
const input = new Input();
const metrics = new Metrics(view.renderer, sim);

type State = 'menu' | 'play' | 'pause';
let state: State = 'menu';
document.body.classList.add('menu');
const startEl = document.getElementById('start')!;
const pauseEl = document.getElementById('pause')!;

sim.events.on('runEnd', (e) => {
  if (e.newBest) saveBest(e.best);
});

function start(): void {
  if (state !== 'menu') return;
  state = 'play';
  document.body.classList.remove('menu');
  startEl.classList.add('hidden');
  sim.score.resetRun();
  sim.score.grace = 0;
}

function setPaused(paused: boolean): void {
  if (state === 'menu') return;
  state = paused ? 'pause' : 'play';
  pauseEl.classList.toggle('hidden', !paused);
}

let debug: Debug | null = null;
let debugOn = false;
let debugLoading = false;
async function toggleDebug(): Promise<void> {
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
if (import.meta.env.DEV) Object.assign(window, { __game: { sim, view, input, hud, metrics } });

input.onPress = (code) => {
  if (code === 'Backquote') void toggleDebug();
  else if (code === 'F1') metrics.toggle();
  else if (state === 'menu' && (code === 'Enter' || code === 'Space')) start();
  else if (code === 'KeyP' || code === 'Escape') setPaused(state === 'play');
  else if (code === 'KeyR' && state === 'play') sim.respawn();
};
document.getElementById('startBtn')!.addEventListener('click', start);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') setPaused(true);
});

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
  if (state !== 'pause') {
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
  view.render(state === 'pause' ? 1 : acc / STEP, dt);
  metrics.gpuEnd();
  const t2 = performance.now();
  hud.update(dt);
  metrics.frame(frameMs, t1 - t0, t2 - t1, n);
  if (debugOn) debug?.update();
});
