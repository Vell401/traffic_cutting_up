/**
 * Dev-only frame-rate probe for the Moscow network page with hardware GL (ANGLE D3D11
 * on Windows). Not a budget: one machine, one run.
 *   MSD_BASE_URL=http://127.0.0.1:5174 PLAYWRIGHT_MODULE=file:///.../playwright/index.mjs node scripts/measure-msd-fps.mjs [query]
 */
import { pathToFileURL } from 'node:url';

const base = process.env.MSD_BASE_URL ?? 'http://127.0.0.1:5174';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('Local dev server only');
const module = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(module.startsWith('file:') || module === 'playwright' ? module : pathToFileURL(module).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.MSD_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const started = Date.now();
await page.goto(`${base}/network.html?layout=moscow${process.argv[2] ? `&${process.argv[2]}` : ''}`);
await page.waitForFunction(() => document.querySelector('#telemetry')?.textContent?.includes('km/h'), null, { timeout: 240000 });
const readyMs = Date.now() - started;
const result = await page.evaluate(async () => {
  const N = window.__network;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.display = 'none';
  const gl = document.querySelector('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const fps = async ms => { let n = 0; const t0 = performance.now(); await new Promise(r => { const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); }); return +(n / ((performance.now() - t0) / 1000)).toFixed(1); };
  const out = { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  for (const [name, call] of [['ramp60', () => N.drive(60, 0, 1.3, -.02)], ['bridge1400', () => N.drive(1400, 3.6, 1.3, -.03)], ['cut3800', () => N.drive(3800, 3.6, 1.3, 0)],
    ['viaduct5200', () => N.drive(5200, 3.6, 1.3, 0)], ['overview', () => N.oblique(4000, 400, 200, 0)]]) { call(); await fps(500); out[name] = await fps(3000); }
  return out;
});
console.log(JSON.stringify({ readyMs, ...result }));
await browser.close();
