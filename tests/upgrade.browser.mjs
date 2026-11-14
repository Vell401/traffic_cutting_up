// Opt-in integration acceptance. External Playwright + isolated, externally started backends only.
// Exact setup/commands and evidence boundaries: docs/reviews/2026-11-13-miami-upgrade.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = process.env.UPGRADE_BASE_URL;
const output = process.env.UPGRADE_OUTPUT_DIR;
assert.ok(base && output && process.env.UPGRADE_ADMIN_PASSWORD, 'Set UPGRADE_BASE_URL, UPGRADE_OUTPUT_DIR, UPGRADE_ADMIN_PASSWORD for isolated fixtures');
assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost)$/);
mkdirSync(output, { recursive: true });
function fingerprint() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'server', 'scripts', 'tests'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha256: hash.digest('hex'), files: paths.length };
}
const source = fingerprint(), errors = [], results = [];
const record = (name, data) => { results.push({ name, ...data }); console.log(`PASS ${name}`, JSON.stringify(data)); };
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({ executablePath: process.env.UPGRADE_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function game(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ...options });
  await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  const page = await context.newPage(), sockets = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('websocket', socket => { if (/\/(?:miami\/)?ws$/.test(new URL(socket.url()).pathname)) sockets.push(socket.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('tcu.quality', 'medium'); localStorage.setItem('tcu.car', '2');
    const Native = window.WebSocket;
    window.__acceptanceSockets = [];
    window.WebSocket = class extends Native { constructor(...args) { super(...args); if (/\/(?:miami\/)?ws$/.test(new URL(String(args[0]), location.href).pathname)) window.__acceptanceSockets.push(this); } };
  });
  return { context, page, sockets };
}
async function loaded(page) {
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 240000 });
  // Comparative images use fixed Medium/DPR1. This disables only existing test-time adaptation;
  // it is not an optimization, FPS measurement, or a change to production quality settings.
  await page.evaluate(() => { window.__game.view.adaptResolution = () => {}; window.__game.view.renderer.setPixelRatio(1); window.__game.view.resize(); });
}
async function enter(page) {
  await page.locator('#startBtn').click();
  await page.waitForFunction(() => window.__game.session?.core.ready && !document.body.classList.contains('menu'), null, { timeout: 120000 });
  await loaded(page);
}
const screenshot = (page, name) => page.screenshot({ path: `${output}/${name}.png`, timeout: 120000 });
const wav = () => {
  const pcm = Buffer.alloc(800), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
};
try {
  for (const map of ['highway', 'miami']) {
    const { context, page, sockets } = await game();
    await page.goto(`${base}/?map=${map === 'miami' ? 'highway' : 'miami'}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await loaded(page);
    await page.locator('#serverChoice').selectOption(map); await page.waitForURL(url => url.searchParams.get('map') === map); await loaded(page);
    for (const [id, key] of [[1, 'Enter'], [2, 'Space']]) {
      await page.locator(`#modeSeg [data-id="${id}"]`).focus(); await page.keyboard.press(key);
      await page.waitForURL(url => url.searchParams.has('solo') === (id === 1)); await loaded(page);
      assert.equal(sockets.length, 0, 'mode/map choices must not join');
    }
    for (const [id, key] of [[1, 'Enter'], [2, 'Space']]) {
      await page.locator(`#carSeg [data-id="${id}"]`).focus(); await page.keyboard.press(key); await loaded(page);
      assert.equal(await page.locator(`#carSeg [data-id="${id}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(sockets.length, 0, 'native car activation must not join');
    }
    assert.equal(await page.locator('#pause').evaluate(el => el.inert), true);
    await page.locator('#nameInput').fill(`Upgrade ${map}`);
    await page.evaluate(() => { window.__resident = { view: window.__game.view, renderer: window.__game.view.renderer, player: window.__game.view.playerView, origin: performance.timeOrigin }; });
    await page.locator('#startBtn').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.session?.core.ready && !document.body.classList.contains('menu'), null, { timeout: 120000 }); await loaded(page);
    assert.equal(sockets.length, 1, 'one explicit native start creates exactly one game connection');
    assert.equal(new URL(sockets[0]).pathname, map === 'miami' ? '/miami/ws' : '/ws');
    const identity = await page.evaluate(async () => {
      const { rulesHash, PROTOCOL_VERSION } = await import('/src/online/rules.ts');
      const g = window.__game; return { map: g.sim.map.id, revision: g.sim.map.revision, ring: g.sim.road.ringLen, hash: rulesHash(g.sim.map.id), protocol: PROTOCOL_VERSION, id: g.session.core.id };
    });
    assert.deepEqual({ ...identity, id: 0 }, { map, revision: map === 'miami' ? 3 : 1, ring: map === 'miami' ? 30000 : 12000, hash: map === 'miami' ? '21932311' : 'e570192c', protocol: 13, id: 0 });
    assert.equal(await page.locator('#start').evaluate(el => el.inert), true);
    const s = await page.evaluate(() => window.__game.sim.player.s);
    await page.locator('#c').click({ force: true }); await page.keyboard.down('KeyW');
    await page.waitForFunction(s => window.__game.sim.player.s > s + .5, s, { timeout: 120000 }); await page.keyboard.up('KeyW');
    const peer = await page.evaluate(async map => {
      const { rulesHash, PROTOCOL_VERSION } = await import('/src/online/rules.ts');
      const { peerWelcome } = await import('/tests/helpers/peerWelcome.ts');
      const ws = window.__acceptancePeer = new WebSocket(`${location.origin.replace('http', 'ws')}${map === 'miami' ? '/miami' : ''}/ws`);
      return await peerWelcome(ws, { t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(map), map, name: 'Upgrade peer', physics: 2, car: 2, seq: 0 });
    }, map);
    assert.notEqual(peer.id, identity.id); assert.equal(peer.players, 2);
    await page.evaluate(() => window.__acceptanceSockets[0].close());
    await page.waitForFunction(id => window.__game.session?.state === 'joined' && window.__game.session.core.ready && window.__game.session.core.id === id && window.__acceptanceSockets.length >= 3, identity.id, { timeout: 120000 });
    await page.evaluate(() => { window.__acceptancePeer.send(JSON.stringify({ t: 'leave' })); window.__acceptancePeer.close(); });
    await screenshot(page, `${map}-desktop-road`);
    await page.keyboard.press('KeyP'); await page.locator('body.paused').waitFor(); await page.locator('#menuBtn').click();
    await page.locator('body.menu').waitFor();
    assert.equal(await page.evaluate(() => { const a = window.__resident, b = window.__game; return !!a.player && a.view === b.view && a.renderer === b.view.renderer && a.player === b.view.playerView && a.origin === performance.timeOrigin; }), true);
    const connects = sockets.length; await page.waitForTimeout(700); assert.equal(sockets.length, connects, 'resident menu does not reconnect');
    await enter(page); assert.equal(sockets.length, connects + 1);
    record(`${map} menu/native controls, identity, movement, two clients, reconnect, resident reuse`, { identity, peer, connects: sockets.length });
    await context.close();
  }
  const mobile = await game({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.page.goto(`${base}/?map=miami`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await loaded(mobile.page);
  assert.equal(mobile.sockets.length, 0); await enter(mobile.page); await mobile.page.locator('body.driving-touch').waitFor();
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await mobile.page.setViewportSize(size);
    // A resize releases held touches by design. Wait for native resize/rAF delivery before
    // starting a new finger, rather than racing that intentional release with pointerdown.
    await mobile.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const id of ['hud', 'leaders', 'radio', 'mixer']) assert.equal(await mobile.page.locator(`#${id}`).isVisible(), false);
    await mobile.page.locator('[data-touch=throttle]').dispatchEvent('pointerdown', { pointerId: 51, pointerType: 'touch' });
    await mobile.page.waitForFunction(() => window.__game.input.drive.throttle === 1);
    await mobile.page.locator('[data-touch=throttle]').dispatchEvent('pointercancel', { pointerId: 51, pointerType: 'touch' });
    await mobile.page.waitForFunction(() => window.__game.input.drive.throttle === 0);
    assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot(mobile.page, `miami-touch-${size.width}`);
  }
  record('integrated Miami touch portrait/landscape cancel', { viewports: ['390x844', '844x390'] }); await mobile.context.close();

  // Fixed-pose visual evidence is separate from authoritative online movement: no server car
  // is teleported. Normal chase rig, unchanged geometry/quality and clean framebuffer only.
  const visual = await game();
  await visual.page.goto(`${base}/?solo&map=miami`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await loaded(visual.page);
  const captures = await visual.page.evaluate(() => {
    const { sim, view } = window.__game, render = view.render.bind(view); view.render = () => {};
    const gl = view.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return [850, 3800, 6100, 8600, 11990, 12010].map(s => {
      sim.player.reset(s, 0, 0); sim.road.ensure(s - 300, s + 1700); view.setCar(2, 'chase'); view.snapCamera(); render(1, 0);
      return { s, map: sim.map.id, revision: sim.map.revision, dpr: view.renderer.getPixelRatio(), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), camera: view.camera.position.toArray(),
        png: view.renderer.domElement.toDataURL('image/png') };
    });
  });
  for (const c of captures) {
    assert.equal(c.dpr, 1); assert.equal(c.width, 1280); assert.equal(c.height, 800);
    writeFileSync(`${output}/miami-fixed-${c.s}.png`, Buffer.from(c.png.split(',')[1], 'base64')); delete c.png;
  }
  assert.equal(visual.sockets.length, 0); record('Miami fixed-pose districts and lap seam', { captures }); await visual.context.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await context.newPage(), traffic = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (new URL(r.url()).pathname.includes('/api/admin')) traffic.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  const prefix = map => map === 'miami' ? '/api/admin/maps/miami' : '/api/admin';
  const tab = id => page.locator(`#admin-tab-${id}`).click();
  const ready = map => page.waitForFunction(map => document.querySelector('#adminInstance')?.value === map && !document.querySelector('.wrap')?.inert && document.querySelector('#meta')?.textContent.includes(map), map);
  const switchMap = async map => { await page.locator('#adminInstance').selectOption(map); await ready(map); };
  const read = map => page.evaluate(async path => (await fetch(`${path}/state`, { headers: { authorization: `Bearer ${sessionStorage.getItem('tcu.admin')}` } })).json(), prefix(map));
  const post = async (path, action) => { const response = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST'); await action(); assert.equal((await response).status(), 200); };
  // Synthetic fixture records, never shared/production data; target names make accidental mixing visible.
  for (const map of ['highway', 'miami']) {
    const r = await context.request.post(`${base}${map === 'miami' ? '/miami' : ''}/api/runs`, { headers: { origin: base }, data: { map, name: `Board ${map}`, score: 1234, car: 2, physics: 2, near: 1, topKmh: 120, seconds: 10 } }); assert.equal(r.status(), 200); assert.equal((await r.json()).stored, true);
  }
  await page.goto(`${base}/admin.html?map=miami`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=password]').fill(process.env.UPGRADE_ADMIN_PASSWORD); await page.locator('.login button[type=submit]').click(); await ready('miami');
  await page.evaluate(() => { window.__adminOrigin = performance.timeOrigin; window.__adminToken = sessionStorage.getItem('tcu.admin'); });
  for (const map of ['miami', 'highway']) {
    await switchMap(map); await tab('traffic'); await post(`${prefix(map)}/traffic`, () => page.locator('#mode').selectOption(map === 'miami' ? 'sparse' : 'dense'));
    await tab('tuning'); const input = page.locator('#carTuneFields input').first(); await input.fill('555');
    await tab('radio'); await tab('tuning'); assert.equal(await input.inputValue(), '555');
    page.once('dialog', d => d.dismiss()); await page.locator('#adminInstance').selectOption(map === 'miami' ? 'highway' : 'miami'); assert.equal(await page.locator('#adminInstance').inputValue(), map);
    await tab('radio'); await post(`${prefix(map)}/radio`, async () => { await page.locator('#playlistName').fill(`Upgrade ${map}`); await page.locator('#createPlaylist').click(); });
    await page.waitForFunction(() => document.querySelector('#radioPlaylist')?.value);
    const pattern = `**${prefix(map)}/radio/upload?*`; let release, arrived, finished;
    const gate = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { arrived = resolve; }), handled = new Promise(resolve => { finished = resolve; });
    await page.route(pattern, async route => { arrived(); await gate; await route.abort().catch(() => {}); finished(); });
    const cancelled = page.waitForEvent('requestfailed', r => new URL(r.url()).pathname === `${prefix(map)}/radio/upload`);
    await page.locator('#radioFiles').setInputFiles({ name: 'cancel.wav', mimeType: 'audio/wav', buffer: wav() }); await held;
    await tab('overview'); await tab('radio'); assert.equal(await page.locator('#radioFiles').evaluate(el => el.files.length), 1);
    assert.equal(await page.locator('#radioEdit').evaluate(el => el.disabled), true);
    page.once('dialog', d => d.dismiss()); await page.locator('#adminInstance').selectOption(map === 'miami' ? 'highway' : 'miami'); assert.equal(await page.locator('#adminInstance').inputValue(), map);
    await page.locator('#cancelRadioUpload').click(); await page.locator('#cancelRadioUpload').waitFor({ state: 'hidden' });
    // Let Chromium deliver native network cancellation before disabling Fetch interception.
    // Removing the last route while its cancelled request is still paused can flush it upstream.
    assert.equal((await cancelled).failure().errorText, 'net::ERR_ABORTED');
    release(); await handled; await page.unroute(pattern);
    assert.equal((await read(map)).radio.playlists.find(p => p.name === `Upgrade ${map}`).tracks.length, 0);
    await post(`${prefix(map)}/radio/upload`, () => page.locator('#radioFiles').setInputFiles({ name: `${map}-fixture.wav`, mimeType: 'audio/wav', buffer: wav() }));
    await page.locator('#cancelRadioUpload').waitFor({ state: 'hidden' }); await page.locator('#radioTracks').getByText(`${map}-fixture`, { exact: true }).waitFor();
    await tab('leaderboard'); await page.locator('#boardTabs button[data-v=solo]').click();
    await page.locator('#board').getByText(`Board ${map}`, { exact: true }).waitFor();
    assert.equal(await page.locator('#board').getByText(`Board ${map === 'miami' ? 'highway' : 'miami'}`, { exact: true }).count(), 0);
    await screenshot(page, `admin-${map}-board`);
    page.once('dialog', d => d.accept()); await switchMap(map === 'miami' ? 'highway' : 'miami');
  }
  assert.equal((await read('miami')).traffic.mode, 'sparse'); assert.equal((await read('highway')).traffic.mode, 'dense');
  for (const map of ['miami', 'highway']) {
    const playlists = (await read(map)).radio.playlists.filter(p => p.name.startsWith('Upgrade '));
    assert.equal(playlists.length, 1); assert.equal(playlists[0].tracks.length, 1); assert.equal(playlists[0].tracks[0].title, `${map}-fixture`);
  }
  assert.equal(await page.evaluate(() => performance.timeOrigin === window.__adminOrigin && sessionStorage.getItem('tcu.admin') === window.__adminToken), true);
  assert.deepEqual(traffic.filter(r => r.path.endsWith('/login')), [{ method: 'POST', path: '/api/admin/login' }]);
  assert.equal(traffic.some(r => r.path.startsWith('/miami/')), false);
  await post('/api/admin/logout', () => page.locator('#logout').click()); await page.locator('.login').waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tcu.admin')), null);
  record('one central login, both-way no-reload switching, isolated traffic/radio/boards, drafts, uploads/cancel, logout', { traffic });
  await context.close(); assert.deepEqual(errors, []); assert.deepEqual(fingerprint(), source, 'source changed during acceptance');
  writeFileSync(`${output}/result.json`, JSON.stringify({ status: 'PASS', source, results, errors, graphics: 'Edge/SwiftShader, Medium, fixed DPR1; not physical GPU/FPS evidence' }, null, 2));
} catch (error) {
  const diagnostics = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    diagnostics.push(await page.evaluate(() => ({ url: location.href, body: document.body.className, viewport: [innerWidth, innerHeight], meta: document.querySelector('#meta')?.textContent, board: document.querySelector('#board')?.textContent, throttle: window.__game?.input.drive.throttle })).catch(() => ({})));
    await page.screenshot({ path: `${output}/failure-${diagnostics.length}.png`, timeout: 120000 }).catch(() => {});
  }
  writeFileSync(`${output}/failure.json`, JSON.stringify({ source, current: fingerprint(), results, errors, diagnostics, failure: String(error.stack) }, null, 2)); throw error;
} finally { await browser.close(); }
