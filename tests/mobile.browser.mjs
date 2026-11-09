// Optional real-browser proof. Uses the existing external Playwright install, not a new dependency.
// MOBILE_BASE_URL=http://127.0.0.1:5184 node tests/mobile.browser.mjs
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs').href);
const base = process.env.MOBILE_BASE_URL || 'http://127.0.0.1:5184';
const output = process.env.MOBILE_PROOF_DIR || 'C:/Users/sosi/AppData/Local/Temp/opencode';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
async function pageFor(options) {
  const context = await browser.newContext(options);
  // Shared worktree: colleagues' writes must not HMR-reload a run halfway through held pointers.
  await context.routeWebSocket('**', socket => socket.close());
  await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('**/api/radio', r => r.fulfill({ json: { playlists: [] } }));
  await context.route('**/api/tuning', r => r.fulfill({ status: 204 }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem('tcu.quality', 'medium'); localStorage.setItem('tcu.car', '4'); });
  await page.goto(`${base}/?solo`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 240000 });
  return { page, context };
}
async function cleanLayout(page, driving = false) {
  const result = await page.evaluate(driving => {
    const visible = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    const controls = [...document.querySelectorAll('#touchControls button')].filter(visible).map(el => {
      const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
    });
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      startOverflow: document.querySelector('#start').scrollWidth > innerWidth,
      zoom: getComputedStyle(document.querySelector('#start .card')).zoom,
      cars: document.querySelectorAll('#carSeg button').length,
      clutter: driving ? ['hud', 'radio', 'mixer', 'leaders', 'announce', 'testPanel'].filter(id => visible(document.getElementById(id))) : [],
      controls: driving ? controls : [] };
  }, driving);
  assert.equal(result.overflow, false, JSON.stringify(result));
  assert.equal(result.startOverflow, false, JSON.stringify(result));
  assert.equal(result.cars, 4);
  if (driving) {
    assert.deepEqual(result.clutter, []);
    for (const r of result.controls) {
      assert.ok(r.w >= 44 && r.h >= 44 && r.x >= 0 && r.y >= 0 && r.x + r.w <= result.width + 1 && r.y + r.h <= result.height + 1, JSON.stringify(r));
    }
    // Visible controls must not cover one another, including manual shift buttons.
    for (let i = 0; i < result.controls.length; i++) for (let j = i + 1; j < result.controls.length; j++) {
      const a = result.controls[i], b = result.controls[j];
      assert.ok(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1, `${a.text} overlaps ${b.text}`);
    }
  } else assert.equal(result.zoom, '1');
  return result;
}
async function pointer(page, control, id, type, fraction = .5) {
  await page.locator(`[data-touch=${control}]`).evaluate((el, { id, type, fraction }) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: r.x + r.width * fraction, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));
  }, { id, type, fraction });
}
try {
  const { page, context } = await pageFor({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await cleanLayout(page);
  await page.locator('#start').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: `${output}/mobile-menu-390.png` });
  // Native API is called from an actual Playwright click (not a fake dispatched pointer event).
  await page.locator('#screenOptions button').click();
  const native = await page.evaluate(() => !!document.fullscreenElement);
  if (native) await page.evaluate(() => document.exitFullscreen());
  await page.locator('#startBtn').click();
  await page.locator('body.driving-touch').waitFor();
  await cleanLayout(page, true);
  await pointer(page, 'steer', 101, 'pointerdown', .9);
  await pointer(page, 'throttle', 102, 'pointerdown');
  await page.waitForFunction(() => window.__game.input.drive.throttle === 1 && window.__game.input.drive.steer > .5);
  await pointer(page, 'throttle', 102, 'pointercancel');
  await page.waitForFunction(() => window.__game.input.drive.throttle === 0 && window.__game.input.drive.steer > .5);
  await page.locator('#touchControls button').filter({ hasText: 'Пауза' }).click();
  await page.locator('body.paused').waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#pause')).opacity === '1');
  assert.equal(await page.evaluate(() => window.__game.input.touch.steer), null);
  const freeze = await page.evaluate(() => window.__game.sim.player.s);
  await page.screenshot({ path: `${output}/mobile-pause-390.png` });
  assert.equal(await page.evaluate(() => window.__game.sim.player.s), freeze, 'solo pause must freeze');
  await page.locator('#pause .pause-settings > summary').click();
  await page.locator('#gearboxBtn').click();
  await page.locator('#resumeBtn').click();
  await page.locator('.touch-manual').waitFor({ state: 'visible' });
  await cleanLayout(page, true);
  await page.screenshot({ path: `${output}/mobile-drive-390.png` });
  for (const size of [{ width: 844, height: 390 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await cleanLayout(page, true);
    await page.screenshot({ path: `${output}/mobile-drive-${size.width}.png` });
  }
  // Real CDP simultaneous fingers exercise browser pointer capture and out-of-button release.
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  const rects = await page.evaluate(() => ['steer', 'throttle'].map(control => {
    const r = document.querySelector(`[data-touch=${control}]`).getBoundingClientRect();
    return { x: r.x + r.width * .8, y: r.y + r.height * .5 };
  }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: rects.map((p, id) => ({ ...p, id })) });
  await page.waitForFunction(() => window.__game.input.drive.throttle === 1 && window.__game.input.drive.steer > .5);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 420, id: 0 }, { x: 220, y: 420, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => window.__game.input.drive.throttle === 0 && window.__game.input.touch.steer === null);
  console.log('Phone/tablet proof passed: 390x844, 844x390, 1024x768; native fullscreen gesture:', native);
  await context.close();
  const desktop = await pageFor({ viewport: { width: 1440, height: 1000 } });
  assert.equal(await desktop.page.locator('#touchControls').isVisible(), false);
  assert.equal(await desktop.page.locator('#carSeg button').count(), 4);
  await desktop.page.locator('#startBtn').click();
  await desktop.page.keyboard.down('KeyW');
  await desktop.page.waitForFunction(() => window.__game.input.drive.throttle === 1);
  await desktop.page.keyboard.press('Escape');
  await desktop.page.locator('body.paused').waitFor();
  await desktop.page.waitForFunction(() => getComputedStyle(document.querySelector('#pause')).opacity === '1' && getComputedStyle(document.querySelector('#start')).opacity === '0');
  const resume = await desktop.page.locator('#resumeBtn').boundingBox();
  assert.ok(resume.width <= 280 && resume.height >= 44 && resume.height < 60);
  await desktop.page.keyboard.up('KeyW');
  await desktop.page.screenshot({ path: `${output}/mobile-desktop-pause.png` });
  await desktop.context.close();
  assert.deepEqual(errors, []);
  console.log('Desktop keyboard/pause/W204 preserved; no browser runtime errors.');
} finally { await browser.close(); }
