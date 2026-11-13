import './style.css';
import { createBayNetwork, createPrototypeNetwork } from './layout';
import { createMoscowNetwork } from './moscow';
import { edgeById, networkLength, sampleEdge, type NetworkEdge, type RoadNetwork } from './geometry';
import { angle, orderedExits, pose, type NetworkAddress, type NetworkInput } from './driving';
import { NetworkSession, type NetworkSnapshot } from './session';
import { NetworkRenderer, type RenderCar } from './render';

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const telemetry = document.querySelector<HTMLElement>('#telemetry')!;
const status = document.querySelector<HTMLElement>('#status')!;
const params = new URLSearchParams(location.search);
type Layout = 'bay' | 'prototype' | 'moscow';
type DriverView = NetworkAddress & { id: string; speed: number; pendingBranch?: number };
let layout: Layout = params.get('layout') === 'moscow' ? 'moscow' : params.get('layout') === 'prototype' ? 'prototype' : 'bay';
let network: RoadNetwork;
let renderer: NetworkRenderer | undefined;
let session: NetworkSession | undefined;
let lengthKm = 0;
let playerId = 'local';
let socket: WebSocket | undefined;
let stopped = false;
let frameId = 0;
let previousTime = performance.now();
let nextSend = 0;
let lastHud = 0;
let reset = false;
let selection: { edgeId: string; index: number } | undefined;
let snapshot: NetworkSnapshot | undefined;
let receivedAt = 0;
let blendDuration = 100;
let previousPoses = new Map<string, RenderCar>();
let targetPoses = new Map<string, RenderCar>();
const keys = new Set<string>();
const lifetime = new AbortController();
const endpoint = params.get('online');
const flightPanel = document.createElement('label');
flightPanel.style.cssText = 'position:fixed;right:16px;top:16px;z-index:10;background:#18232ee8;color:white;padding:12px;font:14px sans-serif;max-width:310px';
flightPanel.textContent = 'F — свободная камера · мышь — обзор · WASD — полёт · Q/E — вниз/вверх · Shift — ×5. Скорость (м/с): ';
const speedInput = document.createElement('input');
speedInput.type = 'number'; speedInput.min = '1'; speedInput.max = '10000'; speedInput.value = '300';
speedInput.style.width = '85px'; speedInput.setAttribute('aria-label', 'Скорость свободной камеры, метров в секунду');
flightPanel.append(speedInput); document.body.append(flightPanel);
speedInput.addEventListener('input', () => {
  const speed = speedInput.valueAsNumber;
  if (renderer && Number.isFinite(speed)) renderer.flightSpeed = Math.max(1, Math.min(10000, speed));
}, { signal: lifetime.signal });
canvas.addEventListener('click', () => { if (renderer?.freeCamera) void canvas.requestPointerLock(); }, { signal: lifetime.signal });
document.addEventListener('mousemove', event => {
  if (document.pointerLockElement === canvas) renderer?.look(event.movementX, event.movementY);
}, { signal: lifetime.signal });

function load(next: Layout): void {
  document.querySelector<HTMLElement>('#moscow-notice')!.hidden = next !== 'moscow';
  if (next === 'moscow' && endpoint) throw new Error('Moscow candidate currently supports offline driving only; remove the online parameter.');
  renderer?.dispose();
  layout = next;
   network = next === 'moscow' ? createMoscowNetwork() : next === 'prototype' ? createPrototypeNetwork() : createBayNetwork();
  lengthKm = networkLength(network) / 1000;
  renderer = new NetworkRenderer(canvas, network);
  selection = undefined; snapshot = undefined;
  previousPoses.clear(); targetPoses.clear();
  session = endpoint ? undefined : new NetworkSession(network, { trafficCount: next === 'bay' ? 100 : 32 });
  session?.addDriver(playerId);
  for (const name of ['bay', 'prototype', 'moscow'] as const) {
    const link = document.querySelector<HTMLAnchorElement>(`#${name}`)!;
    const url = new URL(location.href); url.searchParams.set('layout', name);
    link.href = url.href;
    if (name === layout) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

function exits(edge: NetworkEdge): NetworkEdge[] {
  return orderedExits(network, edge);
}

/** Look through ordinary chunk seams to the next real branch, not just this edge. */
function upcoming(driver: DriverView): { edge: NetworkEdge; distance: number; arms: NetworkEdge[] } | undefined {
  let edge = edgeById(network, driver.edgeId), distance = edge.length - driver.s;
  const seen = new Set<string>();
  while (!seen.has(edge.id)) {
    seen.add(edge.id);
    const arms = exits(edge);
    if (arms.length > 1) return { edge, distance, arms };
    if (!arms.length) return { edge, distance, arms };
    edge = arms[0]; distance += edge.length;
  }
  return undefined;
}

function driver(): DriverView | undefined {
  return session?.drivers.get(playerId) ?? snapshot?.drivers.find(d => d.id === playerId);
}

const controlled = new Set(['KeyF', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'Digit1', 'Digit2', 'Digit3']);
window.addEventListener('keydown', event => {
  if (!controlled.has(event.code) || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLAnchorElement || event.target instanceof HTMLInputElement) return;
  event.preventDefault(); keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'KeyF') {
    const active = renderer?.toggleFreeCamera();
    keys.clear();
    if (active) void canvas.requestPointerLock();
    else if (document.pointerLockElement === canvas) document.exitPointerLock();
    return;
  }
  if (event.code === 'KeyR') { reset = true; selection = undefined; }
  const index = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
  const current = driver(), junction = current && upcoming(current);
  if (index >= 0 && junction && index < junction.arms.length) selection = { edgeId: junction.edge.id, index };
}, { signal: lifetime.signal });
window.addEventListener('keyup', event => { keys.delete(event.code); }, { signal: lifetime.signal });

function input(): NetworkInput {
  if (renderer?.freeCamera) return { steer: 0, throttle: 0, brake: 1 };
  const held = (...codes: string[]) => codes.some(code => keys.has(code)) ? 1 : 0;
  const current = driver();
  return { steer: held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'), throttle: held('KeyW', 'ArrowUp'), brake: held('KeyS', 'ArrowDown'),
    ...(selection && current?.edgeId === selection.edgeId ? { branch: selection.index } : {}), ...(reset ? { reset: true } : {}) };
}

function send(controls: NetworkInput): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: 'input', input: controls })); return true;
}

function release(): void {
  keys.clear(); reset = false;
  if (endpoint) send({ steer: 0, throttle: 0, brake: 0 });
}
window.addEventListener('blur', release, { signal: lifetime.signal });
document.addEventListener('visibilitychange', () => {
  release(); previousTime = performance.now();
}, { signal: lifetime.signal });

function car(entity: NetworkAddress & { id: string }): RenderCar {
  return { ...entity, ...pose(network, entity), id: entity.id, player: entity.id === playerId,
    tunnel: edgeById(network, entity.edgeId).kind === 'tunnel' };
}

function interpolate(now: number): RenderCar[] {
  const t = Math.min(1, Math.max(0, (now - receivedAt) / blendDuration));
  return [...targetPoses.values()].map(b => {
    const a = previousPoses.get(b.id);
    // Reset/teleport snapshots snap, ordinary edge changes interpolate in world space.
    if (!a || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 80) return b;
    return { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
      heading: a.heading + angle(b.heading - a.heading) * t, grade: a.grade + (b.grade - a.grade) * t };
  });
}

// Only the rendering subset is accepted. No remote state is restored into local physics.
function acceptSnapshot(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot');
  const candidate = value as NetworkSnapshot;
  if (candidate.version !== 1 || candidate.networkId !== layout || !Number.isFinite(candidate.tick)
    || !Array.isArray(candidate.drivers) || !Array.isArray(candidate.traffic)
    || candidate.drivers.length + candidate.traffic.length > 12000) throw new Error('Snapshot layout/version mismatch');
  const poses = new Map<string, RenderCar>();
  for (const entity of [...candidate.drivers, ...candidate.traffic]) {
    if (!entity || typeof entity.id !== 'string' || typeof entity.edgeId !== 'string'
      || ![entity.s, entity.d, entity.psi, entity.speed].every(Number.isFinite) || poses.has(entity.id)) throw new Error('Invalid snapshot entity');
    poses.set(entity.id, car(entity));
  }
  if (snapshot && candidate.tick < snapshot.tick) return;
  const now = performance.now();
  previousPoses = new Map(interpolate(now).map(p => [p.id, p]));
  blendDuration = Math.max(30, Math.min(200, now - receivedAt));
  targetPoses = poses; snapshot = candidate; receivedAt = now;
  status.textContent = `Online · authoritative server · ${candidate.drivers.length} driver(s)`;
}

function connect(): void {
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Online URL must use ws:// or wss://');
  url.searchParams.set('layout', layout);
  status.textContent = 'Online · connecting; waiting for welcome and snapshot…';
  socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'welcome' && 'id' in message && typeof message.id === 'string'
        && 'layout' in message && (message.layout === 'bay' || message.layout === 'prototype')) {
        playerId = message.id;
        if (message.layout !== layout) load(message.layout);
        status.textContent = 'Online · welcomed; waiting for authoritative snapshot…';
      } else if (message.type === 'snapshot' && 'snapshot' in message) acceptSnapshot(message.snapshot);
    } catch (error) { status.textContent = `Online message rejected: ${error instanceof Error ? error.message : 'invalid data'}`; }
  }, { signal: lifetime.signal });
  socket.addEventListener('close', () => { status.textContent = 'Online · disconnected (world frozen). Reload to reconnect.'; keys.clear(); }, { signal: lifetime.signal });
  socket.addEventListener('error', () => { status.textContent = 'Online · connection error. Check server address and layout.'; }, { signal: lifetime.signal });
}

function updateHud(current: DriverView | undefined, now: number): void {
  if (now - lastHud < 100) return;
  lastHud = now;
  if (!current) { telemetry.textContent = `${layout.toUpperCase()} · ${lengthKm.toFixed(1)} km directed network\nWaiting for player snapshot…`; return; }
  const edge = edgeById(network, current.edgeId), junction = upcoming(current);
  if (selection && junction?.edge.id !== selection.edgeId) selection = undefined;
  const arms = junction?.arms.length === 0 ? 'Граница карты: остановитесь, сдайте назад или нажмите R.'
    : junction?.arms.map((arm, i) => `${selection?.index === i ? '▶' : ' '} ${i + 1}: ${arm.route} / ${arm.id}`).join('\n') ?? 'No branching junction on this loop';
  telemetry.textContent = `${layout.toUpperCase()} · ${(current.speed * 3.6).toFixed(0)} km/h\nRoute ${edge.route} · ${edge.kind} · ${sampleEdge(edge, current.s).lanes.toFixed(1)} lanes\n${edge.id} · ${Math.round(current.s)} / ${Math.round(edge.length)} m\nNetwork ${lengthKm.toFixed(1)} km (directed carriageways)\n${junction ? `Upcoming junction in ${Math.max(0, Math.round(junction.distance))} m` : 'Route selection'}\n${arms}\nSelected: ${selection ? selection.index + 1 : 'steering / default'} · latched: ${current.pendingBranch === undefined ? '—' : current.pendingBranch + 1}`;
}

function frame(now: number): void {
  if (stopped) return;
  try {
    const dt = document.hidden ? 0 : Math.min(.05, Math.max(0, (now - previousTime) / 1000)); previousTime = now;
    const controls = input();
    const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative));
    renderer?.fly(dt, axis('KeyW', 'KeyS') || axis('ArrowUp', 'ArrowDown'), axis('KeyD', 'KeyA') || axis('ArrowRight', 'ArrowLeft'), axis('KeyE', 'KeyQ'), keys.has('ShiftLeft') || keys.has('ShiftRight'));
    if (session) { session.step(dt, { [playerId]: controls }); if (dt > 0) reset = false; }
    else if (!document.hidden && now >= nextSend && socket?.readyState === WebSocket.OPEN) {
      if (send(controls)) reset = false; nextSend = now + 1000 / 30;
    }
    const entities = session ? [...session.drivers.values(), ...session.traffic].map(car) : interpolate(now);
    const focus = entities.find(entity => entity.id === playerId);
    // Show the complete authored world immediately, even while a server is connecting.
    const fallback = car({ id: 'preview', edgeId: network.parkings[0].edgeId, s: network.parkings[0].s, d: 0, psi: 0 });
    renderer?.draw(entities, focus ?? fallback, dt);
    updateHud(driver(), now);
    if (snapshot && socket?.readyState === WebSocket.OPEN && now - receivedAt > 3000) status.textContent = 'Online · snapshot stream stalled (world frozen)';
    frameId = requestAnimationFrame(frame);
  } catch (error) { status.textContent = `Sandbox stopped: ${error instanceof Error ? error.message : 'unknown error'}`; cleanup(); }
}

function cleanup(): void {
  if (stopped) return;
  stopped = true; release(); cancelAnimationFrame(frameId); lifetime.abort();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  flightPanel.remove();
  socket?.close(); renderer?.dispose(); renderer = undefined; session = undefined;
  previousPoses.clear(); targetPoses.clear();
}
window.addEventListener('pagehide', cleanup, { signal: lifetime.signal });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); }, { once: true });
if (import.meta.hot) import.meta.hot.dispose(cleanup);

try { load(layout); connect(); frameId = requestAnimationFrame(frame); }
catch (error) { status.textContent = `Cannot start sandbox: ${error instanceof Error ? error.message : 'unknown error'}`; cleanup(); }
