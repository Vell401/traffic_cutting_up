/**
 * Dev-only reference captures of section 01 (0–1942.3 m). Needs a running dev server
 * whose network page exposes window.__network (import.meta.env.DEV hook).
 *
 *   MSD_BASE_URL=http://127.0.0.1:5174 MSD_OUT=docs/msd-pilot/after \
 *   PLAYWRIGHT_MODULE=file:///.../playwright/index.mjs node scripts/capture-msd-pilot.mjs
 *
 * Uses a locally installed Chromium/Edge (MSD_BROWSER) with software GL; frame rate
 * under SwiftShader is not representative and is not reported from here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = process.env.MSD_BASE_URL ?? 'http://127.0.0.1:5174';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('Local dev server only');
const out = process.env.MSD_OUT ?? 'docs/msd-pilot/after';
const module = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(module.startsWith('file:') || module === 'playwright' ? module : pathToFileURL(module).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.MSD_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const started = Date.now();
await page.goto(`${base}/network.html?layout=moscow`);
await page.waitForFunction(() => document.querySelector('#telemetry')?.textContent?.includes('km/h'), null, { timeout: 180000 });
const readyMs = Date.now() - started;
await page.evaluate(() => { for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.display = 'none'; });

// [name, script]: identical calls for before/after (only the shared dev hook is used).
const views = [
  ['top-ramp-merge', 'N.over(200, 230)'], ['top-bridge', 'N.over(1430, 230)'], ['top-exit', 'N.over(1610, 150)'], ['top-end', 'N.over(1860, 200)'],
  ['oblique-start', 'N.oblique(150, 160, 70, 40)'], ['oblique-bridge', 'N.oblique(1450, 260, 70, 120)'], ['oblique-exit', 'N.oblique(1590, 120, 45, 40)'],
  ['driver-0060', 'N.drive(60, 0, 1.3, -0.02)'], ['driver-0226', 'N.drive(226, 0, 1.3, -0.02)'], ['driver-0300', 'N.drive(300, 3.6, 1.3, -0.03)'],
  ['driver-0640', 'N.drive(640, 3.6, 1.3, 0.03)'], ['driver-1150', 'N.drive(1150, 3.6, 1.3, -0.03)'], ['driver-1400', 'N.drive(1400, 3.6, 1.3, -0.03)'],
  ['driver-1540', 'N.drive(1540, 3.6, 1.3, -0.03)'], ['driver-1900', 'N.drive(1900, 3.6, 1.3, -0.03)'],
  ['branch-exit-40m', "(() => { const p = N.sample('osm:809185786:1:0', 40); N.inspect(p.x, p.y + 1.3, p.z, p.heading, -0.03); })()"],
  ['branch-loop-under-bridge', "(() => { const p = N.sample('osm:809185783:1:4', 3); N.inspect(p.x, p.y + 1.3, p.z, p.heading, 0.02); })()"],
];
// Section 02 (1942.3–5849.8 m), enabled with MSD_SECTION=02.
const section02 = [
  ['s02-driver-2100', 'N.drive(2100, 3.6, 1.3, -0.02)'], ['s02-driver-2450', 'N.drive(2450, 3.6, 1.3, -0.02)'],
  ['s02-oblique-railway-bridge', 'N.oblique(2600, 200, 70, -120)'], ['s02-driver-3330', 'N.drive(3330, 3.6, 1.3, 0.02)'],
  ['s02-driver-3800', 'N.drive(3800, 3.6, 1.3, 0)'], ['s02-driver-4200', 'N.drive(4200, 3.6, 1.3, 0)'],
  ['s02-oblique-tunnel', "(() => { const p = N.at(4265); N.inspect(p.x + 70, p.y + 30, p.z + 40, -1.0, -0.35); })()"],
  ['s02-driver-4420', 'N.drive(4420, 3.6, 1.3, 0)'], ['s02-driver-4640', 'N.drive(4640, 3.6, 1.3, 0)'],
  ['s02-driver-5200', 'N.drive(5200, 3.6, 1.3, 0)'], ['s02-driver-5500', 'N.drive(5500, 3.6, 1.3, -0.02)'],
  ['s02-top-5300', 'N.over(5300, 260)'], ['s02-oblique-overview', 'N.oblique(4000, 500, 260, 0)'],
];
if (process.env.MSD_SECTION === '02') views.splice(0, views.length, ...section02);
mkdirSync(out, { recursive: true });
for (const [name, script] of views) {
  await page.evaluate(`(() => { const N = window.__network; ${script}; })()`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('canvas').screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 72 });
}
writeFileSync(join(out, 'capture.json'), JSON.stringify({ base, readyMs, views: views.map(v => v[0]), errors, note: 'SwiftShader software rendering; readyMs includes dev-server transforms.' }, null, 2));
console.log({ out, readyMs, views: views.length, errors });
await browser.close();
