// Actual-game art/readiness evidence; run sequentially with other GPU/browser suites.
// External Playwright, installed Chromium, existing Vite and isolated backends only.
// Online/reconnect/shared-admin/upload coverage is reused, not copied: upgrade.browser.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = process.env.MIAMI_REBUILD_BASE_URL, output = process.env.MIAMI_REBUILD_OUTPUT_DIR;
assert.ok(base && output && process.env.PLAYWRIGHT_MODULE, 'Set MIAMI_REBUILD_BASE_URL, MIAMI_REBUILD_OUTPUT_DIR, PLAYWRIGHT_MODULE');
assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost)$/);
mkdirSync(output, { recursive: true });
const fingerprint = () => {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts', 'tests', 'public/models/miami', 'public/textures/miami'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha256: hash.digest('hex'), files: paths.length };
};
const source = fingerprint(), result = { source, captures: [], cars: [], errors: [], external: [], blockedLegacyFonts: [] };
const save = () => writeFileSync(`${output}/evidence.json`, JSON.stringify(result, null, 2));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.MIAMI_REBUILD_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
async function game(car = 2, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ...options });
  // Existing menu font CSS is unrelated to the environment. Block it exactly as
  // the integration suites do; disclose it, rather than claiming the old UI is local.
  await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await context.addInitScript(car => {
    localStorage.setItem('tcu.quality', 'medium'); localStorage.setItem('tcu.car', String(car));
    let seed = 7; Math.random = () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }, car);
  const page = await context.newPage(), sockets = [], requests = [];
  page.on('pageerror', e => result.errors.push(String(e)));
  page.on('websocket', s => { if (/\/(?:miami\/)?ws$/.test(new URL(s.url()).pathname)) sockets.push(s.url()); });
  page.on('request', r => {
    if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(base).origin) {
      if (new URL(r.url()).hostname === 'fonts.googleapis.com') result.blockedLegacyFonts.push(r.url());
      else result.external.push(r.url());
    }
    if (/\/(models|textures)\//.test(r.url())) requests.push(r.url());
  });
  return { context, page, sockets, requests };
}
async function loaded(page) {
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 240000 });
  await page.evaluate(() => {
    // Fixed comparative quality, not a production optimization or a hardware-FPS test.
    const v = window.__game.view; v.adaptResolution = () => {}; v.renderer.setPixelRatio(1); v.resize();
  });
}
async function capture(page, name, pose = {}) {
  const row = await page.evaluate(({ name, pose }) => {
    const { sim, view } = window.__game;
    if (pose.s !== undefined) {
      sim.player.reset(pose.s, pose.d || 0, 0); sim.player.ghost = false;
      sim.road.ensure(pose.s - 1000, pose.s + 2000); view.snapCamera();
    }
    view.chase.lookYaw = pose.yaw || 0; view.chase.lookPitch = pose.pitch || 0; view.chase.lookT = 0;
    if (pose.mode) view.chase.setRig(view.chase.rig, pose.mode);
    // Exact immutable 815a188 R34 normal camera FOV; no distance/height change.
    if ((!pose.mode || pose.mode === 'chase') && !pose.yaw) { view.camera.fov = sim.map.id === 'miami' ? 62.17771448963918 : 62.13470881500168; view.camera.updateProjectionMatrix(); }
    view.render(1, 0);
    const gl = view.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const world = view.miamiWorld;
    return { name, pose, s: sim.player.s, d: sim.player.d, map: sim.map.id, revision: sim.map.revision, car: view.playerView.car,
      calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles, dpr: view.renderer.getPixelRatio(),
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      memory: { ...view.renderer.info.memory }, programs: view.renderer.info.programs.length,
      camera: { position: view.camera.position.toArray(), quaternion: view.camera.quaternion.toArray(), fov: view.camera.fov }, origin: [view.ox, view.oz],
      batches: world?.group.children.length || 0, instances: world?.group.children.filter(m => m.userData.firstPart).reduce((n, m) => n + m.count, 0) || 0,
      shadow: view.renderer.shadowMap.enabled, background: view.scene.background?.name,
      traffic: sim.traffic.cars.length, png: document.querySelector('#c').toDataURL('image/png') };
  }, { name, pose });
  writeFileSync(`${output}/${name}.png`, Buffer.from(row.png.split(',')[1], 'base64')); delete row.png;
  row.file = `${output}/${name}.png`; result.captures.push(row); save(); return row;
}
try {
  // Required asset error, real retry under initial overlay, no pre-start game joins.
  const retry = await game(); let attempts = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await retry.page.route('**/models/miami/manifest.json', r => ++attempts === 1 ? r.fulfill({ status: 503, body: 'synthetic required failure' }) : r.continue());
  await retry.page.route('**/models/miami/coastal-kit.glb', async r => { await held; await r.continue(); });
  await retry.page.goto(`${base}/?solo&map=miami`);
  await retry.page.locator('#loading.failed').waitFor();
  assert.equal(await retry.page.locator('#start').evaluate(el => el.inert), true);
  assert.equal(await retry.page.evaluate(() => window.__game.view.environmentReady), false);
  await retry.page.screenshot({ path: `${output}/required-failure.png` });
  const requested = retry.page.waitForRequest('**/models/miami/coastal-kit.glb');
  await retry.page.locator('#loadingAction').click(); await requested;
  assert.equal(await retry.page.locator('#start').evaluate(el => el.inert), true); assert.equal(retry.sockets.length, 0);
  release(); await loaded(retry.page); assert.equal(attempts, 2); assert.equal(retry.sockets.length, 0);
  result.retry = { attempts, sockets: retry.sockets, requests: retry.requests }; await retry.context.close(); save();
  console.log('PASS required-asset failure/retry, no pre-start game joins');

  for (const car of [2, 3, 1, 4]) {
    const g = await game(car); await g.page.goto(`${base}/?solo&map=miami`); await loaded(g.page);
    assert.equal(g.sockets.length, 0);
    if (car === 2) {
      await g.page.locator('#startBtn').click();
      const start = await g.page.evaluate(() => window.__game.sim.player.s);
      await g.page.keyboard.down('KeyW'); await g.page.waitForFunction(s => window.__game.sim.player.s > s + 6, start, { timeout: 120000 }); await g.page.keyboard.up('KeyW');
      result.moving = await capture(g.page, 'miami-moving-traffic');
    }
    await g.page.evaluate(() => window.__game.view.renderer.setAnimationLoop(null));
    const rows = [];
    // South Beach, MacArthur port, Watson, Downtown, Port tunnel, Wynwood, Grove marina, Rickenbacker, Key Biscayne, Gables, Bayfront, lap seam.
    for (const s of [300, 850, 4100, 5400, 8250, 10050, 11800, 15100, 18300, 21000, 24600, 28500, 29990, 30010]) {
      const row = await capture(g.page, car === 2 ? `miami-${s}` : `miami-car${car}-${s}`, { s, mode: 'chase' });
      assert.equal(row.dpr, 1); assert.equal(row.width, 1280); assert.equal(row.height, 800);
      assert(row.batches <= 130 && row.instances <= 1800); rows.push(row);
    }
    const ghost = await g.page.evaluate(() => { const { sim, view } = window.__game; sim.player.ghost = true; view.render(1, 0); sim.player.ghost = false; return { calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles }; });
    result.cars.push({ car, rows: rows.map(({ file, ...r }) => r), ghost, requests: g.requests }); save();
    console.log(`Captured normal car${car}: max calls ${Math.max(...rows.map(r => r.calls))}`);
    if (car === 2) {
      for (const [name, pose] of [
        ['miami-frontage-onroad-look', { s: 850, d: 6, mode: 'hood', yaw: .9 }],
        ['miami-palms-shore-onroad-look', { s: 850, d: -6, mode: 'hood', yaw: -1 }],
        ['miami-yachts-onroad-look', { s: 15115, d: -6, mode: 'hood', yaw: -1, pitch: -.08 }],
        ['miami-yachts-far-camera-look', { s: 15115, d: -6, mode: 'far', yaw: -1, pitch: .12 }],
        ['miami-marina-left-lane', { s: 15100, d: -6, mode: 'chase' }],
        ['miami-port-onroad-look', { s: 4100, d: 6, mode: 'hood', yaw: 1 }],
        ['miami-beach-onroad-look', { s: 850, d: -6, mode: 'far', yaw: -1, pitch: .12 }],
        ['miami-cockpit', { s: 850, mode: 'cockpit' }], ['miami-bumper', { s: 15100, mode: 'bumper' }],
        // District and section boundaries: beach to causeway, causeway to downtown, both tunnel portals, city to marina, marina to causeway.
        ...[2999, 3001, 7299, 7301, 9899, 9901, 11099, 11101, 14099, 14101, 16899, 16901, 26899, 26901].map(s => [`miami-transition-${s}`, { s, mode: 'chase' }]),
      ]) await capture(g.page, name, pose);
      for (const id of ['night', 'dusk', 'midnight', 'neon', 'violet', 'miami-night']) {
        await g.page.evaluate(id => window.__game.view.setSky(id), id);
        await capture(g.page, `miami-sky-${id}`, { s: 850, mode: 'chase' });
      }
      result.sweep = await g.page.evaluate(async () => {
        const { sim, view } = window.__game, rows = [];
        for (let s = 0; s < 30000; s += 100) {
          sim.player.reset(s, 0, 0); sim.player.ghost = false; sim.road.ensure(s - 1000, s + 2000); view.snapCamera(); view.render(1, 0);
          rows.push({ s, calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles }); await new Promise(requestAnimationFrame);
        }
        const memory = { ...view.renderer.info.memory }, version = view.miamiWorld.group.children[0].instanceMatrix.version;
        for (let i = 0; i < 12; i++) { view.render(1, 0); await new Promise(requestAnimationFrame); }
        return { rows, steadyBefore: memory, steadyAfter: { ...view.renderer.info.memory }, matrixVersionBefore: version, matrixVersionAfter: view.miamiWorld.group.children[0].instanceMatrix.version };
      });
      assert.deepEqual(result.sweep.steadyBefore, result.sweep.steadyAfter); assert.equal(result.sweep.matrixVersionBefore, result.sweep.matrixVersionAfter);
      // Actual resident car-cache/menu flow in a separate live document (not frozen evidence loop).
    }
    await g.context.close(); save();
  }
  const resident = await game(); await resident.page.goto(`${base}/?solo&map=miami`); await loaded(resident.page);
  for (const id of [3, 1, 4, 2]) { await resident.page.locator(`#carSeg [data-id="${id}"]`).click(); await loaded(resident.page); }
  await resident.page.evaluate(() => {
    const { view } = window.__game; window.__resident = { view, renderer: view.renderer, cars: new Map(view.playerViews), environment: view.miamiWorld, timeOrigin: performance.timeOrigin };
  });
  const requestsBefore = resident.requests.length;
  await resident.page.locator('#startBtn').click(); await resident.page.keyboard.press('KeyP');
  await resident.page.locator('body.paused').waitFor(); await resident.page.locator('#menuBtn').click(); await resident.page.locator('body.menu').waitFor();
  for (const id of [4, 1, 3, 2]) { await resident.page.locator(`#carSeg [data-id="${id}"]`).click(); await loaded(resident.page); }
  result.resident = await resident.page.evaluate(() => {
    const { view } = window.__game, old = window.__resident;
    return { sameView: old.view === view, sameRenderer: old.renderer === view.renderer, sameEnvironment: old.environment === view.miamiWorld,
      sameDocument: old.timeOrigin === performance.timeOrigin, cars: [...old.cars].map(([id, entry]) => ({ id, same: entry.view === view.playerViews.get(id).view })) };
  });
  assert(Object.values(result.resident).slice(0, 4).every(Boolean)); assert.equal(result.resident.cars.length, 4); assert(result.resident.cars.every(c => c.same));
  assert.equal(resident.requests.length, requestsBefore, 'resident cache must issue no repeat model/map HTTP'); assert.equal(resident.sockets.length, 0);
  await resident.page.evaluate(async () => { const { saveMapSky } = await import('/src/ui/serverPicker.ts'); saveMapSky('miami', 'dusk'); });
  await resident.page.reload(); await loaded(resident.page);
  result.savedSky = await resident.page.evaluate(() => ({ id: window.__game.view.skyId, dome: window.__game.view.sky.visible, value: localStorage.getItem('tcu.sky.miami') }));
  assert.deepEqual(result.savedSky, { id: 'dusk', dome: true, value: 'dusk' });
  await resident.context.close(); save();
  const mobile = await game(2, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.page.goto(`${base}/?solo&map=miami`); await loaded(mobile.page); await mobile.page.locator('#startBtn').click();
  await mobile.page.evaluate(() => window.__game.view.renderer.setAnimationLoop(null));
  for (const [width, height] of [[390, 844], [844, 390]]) {
    await mobile.page.setViewportSize({ width, height }); await mobile.page.evaluate(() => window.__game.view.resize());
    const row = await capture(mobile.page, `miami-phone-${width}`, { s: 850, mode: 'chase' });
    assert.equal(row.dpr, 1); assert.equal(row.width, width); assert.equal(row.height, height);
    await mobile.page.screenshot({ path: `${output}/miami-phone-ui-${width}.png` });
  }
  await mobile.context.close();
  const highway = await game(); await highway.page.goto(`${base}/?solo&map=highway`); await loaded(highway.page);
  await highway.page.evaluate(() => window.__game.view.renderer.setAnimationLoop(null));
  for (const s of [300, 3800]) await capture(highway.page, `highway-${s}`, { s, mode: 'chase' });
  assert.equal(highway.requests.some(url => /\/(models|textures)\/miami\//.test(url)), false); await highway.context.close();
  result.finishedSource = fingerprint(); assert.deepEqual(result.finishedSource, source, 'source must stay stable during evidence');
  assert.deepEqual(result.errors, []); assert.deepEqual(result.external, []);
  const normal = [...result.cars.flatMap(c => c.rows), ...result.sweep.rows];
  result.maxCalls = Math.max(...normal.map(r => r.calls)); result.maxTriangles = Math.max(...normal.map(r => r.triangles)); save();
  assert(result.maxCalls <= 500, `whole-frame normal opaque calls: ${result.maxCalls}`);
  assert(result.maxTriangles <= 5_000_000, `whole-frame normal opaque triangles: ${result.maxTriangles}`);
  console.log(JSON.stringify({ captures: result.captures.length, maxCalls: result.maxCalls, maxTriangles: result.maxTriangles, cars: result.cars.map(c => ({ car: c.car, maxCalls: Math.max(...c.rows.map(r => r.calls)), ghost: c.ghost })), source, errors: result.errors }, null, 2));
} finally { save(); await browser.close(); }
