/*
 * Page diagnostics: problems worth knowing about from players' browsers go to the server's log
 * (POST /api/log), batched every few seconds. Kept small on purpose: the same message is counted,
 * not repeated; at most 30 reports per page load.
 *
 * What is reported: script errors and rejected promises, a lost WebGL context, failed model loads,
 * online rejections and long reconnect runs, big prediction corrections, a frame rate that stays low.
 */
type Level = 'info' | 'warn' | 'error';
interface Item {
  level: Level;
  msg: string;
  detail?: string;
  count: number;
}

const MAX_REPORTS = 30;
const FLUSH_MS = 5000;

let base = '';
let context: Record<string, string> = {};
const pending = new Map<string, Item>();
const reported = new Set<string>();
let sent = 0;
let timer = 0;

export function report(level: Level, msg: string, detail?: string): void {
  if (!base) return;
  const key = `${level}|${msg}`;
  const have = pending.get(key);
  if (have) {
    have.count++;
    return;
  }
  // Once a message has gone out, repeats are not news.
  if (reported.has(key) || sent + pending.size >= MAX_REPORTS) return;
  pending.set(key, { level, msg: msg.slice(0, 300), detail: detail?.slice(0, 1500), count: 1 });
  if (!timer) timer = window.setTimeout(flush, FLUSH_MS);
}

function flush(beacon = false): void {
  timer = 0;
  if (pending.size === 0) return;
  const items = [...pending.values()];
  for (const k of pending.keys()) reported.add(k);
  sent += items.length;
  pending.clear();
  const body = JSON.stringify({ ...context, items });
  try {
    if (beacon && navigator.sendBeacon) navigator.sendBeacon(`${base}/log`, new Blob([body], { type: 'application/json' }));
    else void fetch(`${base}/log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    /* diagnostics must never break the game */
  }
}

/** GPU name, if the browser tells (helps with rendering problems). */
function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext | null): string {
  if (!gl) return '';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
}

/** Start reporting to `apiBase` (…/api) from this page. */
export function initDiag(apiBase: string, page: string, quality: string, canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext | null): void {
  base = apiBase;
  context = { page, quality, ua: navigator.userAgent.slice(0, 200), gpu: gpuName(gl).slice(0, 120) };
  window.addEventListener('error', (e) => {
    const where = e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}:${e.colno}` : '';
    report('error', `${e.message}${where}`, (e.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | string | undefined;
    report('error', `unhandled rejection: ${r instanceof Error ? r.message : String(r)}`, r instanceof Error ? r.stack : undefined);
  });
  canvas.addEventListener('webglcontextlost', () => report('error', 'WebGL context lost'));
  window.addEventListener('pagehide', () => flush(true));
}

let fpsT = 0;
let fpsFrames = 0;
let slowSpells = 0;
let simT = 0;
let renderT = 0;
/**
 * Per frame: a frame rate under 24 for a whole 10 s stretch is reported (twice at most). Under 5 the
 * page is almost surely in the background (throttled), not slow: not reported. Loading, hidden tabs
 * and long interruptions reset the sampling window, so they cannot contaminate a driving report.
 */
export function diagFrame(dtMs: number, simMs = 0, renderMs = 0, detail: () => object = () => ({}), active = true): void {
  if (!active || document.hidden || dtMs <= 0 || dtMs > 250) {
    fpsT = fpsFrames = simT = renderT = 0;
    return;
  }
  fpsT += dtMs;
  fpsFrames++;
  simT += simMs;
  renderT += renderMs;
  if (fpsT < 10_000) return;
  const fps = (fpsFrames * 1000) / fpsT;
  const timings = { simulationMs: +(simT / fpsFrames).toFixed(2), renderCpuMs: +(renderT / fpsFrames).toFixed(2) };
  fpsT = 0;
  fpsFrames = 0;
  simT = renderT = 0;
  if (fps < 24 && fps >= 5 && !document.hidden && slowSpells < 2) {
    slowSpells++;
    report('warn', `low frame rate ${fps.toFixed(0)} fps for 10 s`, JSON.stringify({ ...timings, ...detail() }));
  }
}
