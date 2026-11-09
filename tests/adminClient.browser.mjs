/**
 * Opt-in real-server browser checks. Never points at a shared server by default.
 * Start an isolated game server with ADMIN_PASSWORD and an isolated DB_PATH,
 * then Vite with GAME_SERVER pointing at it. Run:
 * ADMIN_BASE_URL=http://127.0.0.1:5187 ADMIN_TEST_PASSWORD=...
 * ADMIN_PLAYWRIGHT_MODULE=file:///.../playwright/index.mjs node tests/adminClient.browser.mjs
 * ADMIN_BROWSER_EXECUTABLE can select a locally installed Chromium/Edge.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.ADMIN_BASE_URL ?? 'http://127.0.0.1:5187';
assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost)$/);
assert.ok(process.env.ADMIN_TEST_PASSWORD, 'Set ADMIN_TEST_PASSWORD for the isolated test server');
const { chromium } = await import(process.env.ADMIN_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ADMIN_BROWSER_EXECUTABLE ? { executablePath: process.env.ADMIN_BROWSER_EXECUTABLE } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('dialog', dialog => dialog.accept());
const requests = { board: 0, logs: 0 };
page.on('request', request => {
  if (request.url().includes('/api/admin/board?')) requests.board++;
  if (request.url().includes('/api/admin/logs?')) requests.logs++;
});
const tab = id => page.locator(`#admin-tab-${id}`);
const select = id => tab(id).click();
const waitFor = async (predicate, message) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(50);
  }
  throw Error(message);
};
const login = async () => {
  await page.locator('input[name=password]').fill(process.env.ADMIN_TEST_PASSWORD);
  await page.locator('.login button').click();
  await page.locator('#meta').filter({ hasText: 'версия' }).waitFor();
};
const adminState = () => page.evaluate(async () => {
  const r = await fetch('/api/admin/state', { headers: { authorization: `Bearer ${sessionStorage.getItem('tcu.admin')}` } });
  return r.json();
});
const mutation = async (path, action) => {
  const response = page.waitForResponse(r => r.url().endsWith(`/api/admin/${path}`) && r.request().method() === 'POST');
  await action();
  assert.equal((await response).status(), 200, `${path} action`);
};
const wave = () => {
  const pcm = Buffer.alloc(8000);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

try {
  await page.goto(`${base}/admin.html`);
  await login();
  assert.equal(await page.getByRole('tab').count(), 6);
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  assert.equal(await tab('overview').getAttribute('aria-selected'), 'true');
  assert.deepEqual(requests, { board: 0, logs: 0 }, 'no hidden filter requests at login');
  await page.evaluate(() => {
    window.adminTestNodes = Object.fromEntries([...document.querySelectorAll('.admin-tab-panel, #radioFiles, #carTuneForm, #trafficSpeedForm')].map(node => [node.id, node]));
  });
  await tab('overview').focus();
  for (const [key, target] of [['ArrowLeft', 'logs'], ['ArrowRight', 'overview'], ['End', 'logs'], ['Home', 'overview'], ['ArrowRight', 'traffic']]) {
    await page.keyboard.press(key);
    assert.equal(await tab(target).getAttribute('aria-selected'), 'true');
    assert.equal(await tab(target).evaluate(el => document.activeElement === el), true);
    assert.equal(await page.getByRole('tabpanel').count(), 1);
  }
  await select('overview');
  await mutation('players', async () => { await page.locator('#maxPlayers').fill('6'); await page.locator('#saveMax').click(); });
  await mutation('say', async () => { await page.locator('#sayText').fill('Admin tabs browser test'); await page.locator('#say').click(); });
  assert.equal((await adminState()).rules.maxPlayers, 6);
  const driverName = `Tabs & "${String(Date.now()).slice(-6)}"`;
  await page.evaluate(async name => {
    const { PROTOCOL_VERSION, rulesHash } = await import('/src/online/rules.ts');
    const ws = window.adminTestPeer = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name, physics: 5, car: 5, seq: 0 }));
      ws.onmessage = event => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.t === 'welcome') resolve();
        else if (message.t === 'reject') reject(Error(message.reason));
      };
      ws.onerror = () => reject(Error('test peer connection'));
    });
  }, driverName);
  const driverRow = page.locator('#players tr').filter({ hasText: driverName });
  await driverRow.waitFor();
  await mutation('kick', () => driverRow.locator('button[data-id]:not([data-ban])').click());

  await select('traffic');
  const trafficMode = await page.locator('#mode').inputValue() === 'dense' ? 'sparse' : 'dense';
  await mutation('traffic', () => page.locator('#mode').selectOption(trafficMode));
  await mutation('traffic', async () => {
    const field = page.locator(`#densities input[data-mode=${trafficMode}]`);
    await field.fill(await field.inputValue() === '12.5' ? '13' : '12.5'); await field.press('Enter');
  });
  await mutation('traffic', () => page.locator('#trafficOn').click());
  await waitFor(async () => !(await adminState()).traffic.on, 'traffic switched off');
  await mutation('traffic', () => page.locator('#trafficOn').click());
  await waitFor(async () => (await adminState()).traffic.on, 'traffic switched on');
  console.log('PASS login, ARIA/keyboard, max players, announcement, escaped player name/kick, traffic actions');

  await select('tuning');
  await page.locator('#tuneCar').selectOption('5');
  assert.match(await page.locator('#tuneCar option:checked').textContent(), /C63.*W204/);
  const power = page.locator('#carTuneFields input[name=powerKW]');
  const powerValue = String(Number(await power.inputValue()) + 1);
  const speed = page.locator('#trafficSpeedFields input[name=speed-0-0]');
  const speedValue = String(Number(await speed.inputValue()) + 1);
  await power.fill(powerValue); await speed.fill(speedValue);
  await page.evaluate(() => { window.adminTestPower = document.querySelector('#carTuneFields input[name=powerKW]'); });
  const hiddenTuning = await page.locator('#admin-panel-tuning').innerHTML();
  await select('overview');
  const counts = { ...requests };
  await delay(10500);
  assert.deepEqual(requests, counts, 'inactive leaderboard/log do not poll');
  assert.equal(await page.locator('#admin-panel-tuning').innerHTML(), hiddenTuning, 'inactive tuning DOM is untouched');
  await select('tuning');
  assert.equal(await power.inputValue(), powerValue); assert.equal(await speed.inputValue(), speedValue);
  assert.equal(await power.evaluate(el => el === window.adminTestPower), true, 'dirty input not replaced');
  await mutation('tuning', () => page.locator('#carTuneForm button[type=submit]').click());
  await mutation('tuning', () => page.locator('#trafficSpeedForm button[type=submit]').click());
  assert.equal((await adminState()).tuning.cars['5'].powerKW, Number(powerValue));
  assert.equal((await adminState()).tuning.traffic.lanes[0][0], Number(speedValue));

  await select('radio');
  const playlistName = `Tabs <b> & "radio" ${Date.now()}`;
  await mutation('radio', async () => { await page.locator('#playlistName').fill(playlistName); await page.locator('#createPlaylist').click(); });
  await waitFor(async () => (await page.locator('#radioPlaylist option:checked').textContent())?.includes(playlistName.replace(/[<>]/g, '')), 'playlist created');
  const playlistId = await page.locator('#radioPlaylist').inputValue();
  assert.equal(await page.locator('#radioPlaylist b').count(), 0);
  let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadPattern = '**/api/admin/radio/upload?*';
  await page.route(uploadPattern, async route => {
    const response = await route.fetch();
    await uploadGate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.locator('#radioFiles').setInputFiles({ name: 'tabs-test.wav', mimeType: 'audio/wav', buffer: wave() });
  await page.locator('#cancelRadioUpload').waitFor({ state: 'visible' });
  await page.locator('#playlistName').fill('unsaved radio draft');
  await select('overview');
  await delay(2200);
  assert.equal(await page.locator('#radioFiles').evaluate(el => el.files.length), 1);
  await select('radio');
  assert.equal(await page.locator('#radioFiles').evaluate(el => el === window.adminTestNodes.radioFiles), true);
  assert.equal(await page.locator('#radioEdit').evaluate(el => el.disabled), true);
  assert.equal(await page.locator('#playlistName').inputValue(), 'unsaved radio draft');
  releaseUpload();
  await page.locator('#cancelRadioUpload').waitFor({ state: 'hidden' });
  await page.locator('#radioTracks').getByText('tabs-test', { exact: true }).waitFor();
  await page.unroute(uploadPattern);
  assert.equal(await page.evaluate(() => Object.entries(window.adminTestNodes).every(([id, node]) => document.getElementById(id) === node)), true, 'all panels/forms/file input remain mounted');
  await page.reload();
  await page.locator(`#radioPlaylist option[value="${playlistId}"]`).waitFor({ state: 'attached' });
  await page.locator('#radioPlaylist').selectOption(playlistId);
  await page.locator('#radioTracks').getByText('tabs-test', { exact: true }).waitFor();
  assert.equal(await tab('radio').getAttribute('aria-selected'), 'true', 'same login remembers selected panel');
  console.log('PASS C63 id5, dirty forms, inactive DOM/polling, actual upload across switches, mounted identities, reload persistence');

  // Hold real server responses to force stale filter/401 races (not new endpoints).
  let releaseBoard;
  const boardGate = new Promise(resolve => { releaseBoard = resolve; });
  let boardHeld;
  const heldBoard = new Promise(resolve => { boardHeld = resolve; });
  await page.route('**/api/admin/board?mode=solo&*', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), authorization: 'Bearer expired-test-token' } });
    assert.equal(response.status(), 401);
    boardHeld(); await boardGate;
    await route.fulfill({ response }).catch(() => {});
  });
  await select('leaderboard'); await heldBoard;
  await page.locator('#boardTabs button[data-v=online]').click();
  await page.locator('#board .empty').filter({ hasText: 'Пусто' }).waitFor();
  releaseBoard(); await delay(200);
  assert.equal(await page.locator('.login').count(), 0, 'stale filter 401 cannot log out');
  assert.equal(await page.locator('#boardTabs button[data-v=online]').getAttribute('aria-pressed'), 'true');
  await page.unroute('**/api/admin/board?mode=solo&*');

  let releaseLogs;
  const logsGate = new Promise(resolve => { releaseLogs = resolve; });
  let logsHeld;
  const heldLogs = new Promise(resolve => { logsHeld = resolve; });
  await page.route('**/api/admin/logs?limit=300', async route => {
    const response = await route.fetch(); logsHeld(); await logsGate;
    await route.fulfill({ response }).catch(() => {});
  });
  await select('logs'); await heldLogs;
  await page.locator('#logTabs button[data-v=client]').click();
  await page.locator('#logs .empty').filter({ hasText: 'Журнал пуст' }).waitFor();
  releaseLogs(); await delay(200);
  assert.match(await page.locator('#logs').textContent(), /Журнал пуст/);
  await page.unroute('**/api/admin/logs?limit=300');

  // Ignore AbortSignal for one fetch in the test to exercise the epoch guard too.
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    let once = true;
    window.fetch = (url, options) => {
      if (once && String(url).endsWith('/state')) {
        once = false;
        return nativeFetch(url, { ...options, signal: undefined });
      }
      return nativeFetch(url, options);
    };
  });
  let releaseState;
  const stateGate = new Promise(resolve => { releaseState = resolve; });
  let stateHeld;
  const heldState = new Promise(resolve => { stateHeld = resolve; });
  let stateIntercepted = false;
  await page.route('**/api/admin/state', async route => {
    if (stateIntercepted) { await route.continue(); return; }
    stateIntercepted = true;
    const response = await route.fetch({ headers: { ...route.request().headers(), authorization: 'Bearer expired-test-token' } });
    assert.equal(response.status(), 401);
    stateHeld(); await stateGate;
    await route.fulfill({ response });
  });
  await heldState;
  await page.locator('#logout').click();
  await login();
  releaseState(); await delay(200);
  await page.unroute('**/api/admin/state');
  assert.equal(await tab('overview').getAttribute('aria-selected'), 'true', 'new login starts its own tab selection');
  await select('radio');
  await page.locator('#radioPlaylist').selectOption(playlistId);
  await page.locator('#radioTracks').getByText('tabs-test', { exact: true }).waitFor();
  assert.notEqual(await page.locator('#radioPlaylist').inputValue(), '', 'radio signature reset on rebuild');

  // An actual current-session 401 must rebuild the login view.
  await page.evaluate(async () => {
    await fetch('/api/admin/logout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('tcu.admin')}` }, body: '{}' });
  });
  await page.locator('.login').waitFor();
  await login();
  await select('radio');
  await page.locator('#radioPlaylist').selectOption(playlistId);
  await page.locator('#radioTracks').getByText('tabs-test', { exact: true }).waitFor();
  console.log('PASS stale leaderboard/log responses, stale 401 across logout/login, current 401 recovery, radio rebuild');

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of ['overview', 'traffic', 'tuning', 'radio', 'leaderboard', 'logs']) {
      await select(id);
      assert.equal(await page.getByRole('tabpanel').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${id} fits ${width}px`);
    }
    assert.equal(await page.locator('.admin-tabs').evaluate(el => el.scrollWidth > el.clientWidth), true);
    await tab('logs').focus(); await page.keyboard.press('Home');
    assert.equal(await tab('overview').evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth), true);
    await page.keyboard.press('End');
    assert.equal(await tab('logs').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  console.log('PASS 320/390px horizontal navigation, hidden panels, keyboard scrolling, no browser exceptions');
} catch (error) {
  console.error('Browser diagnostic:', await page.evaluate(() => ({
    url: location.href,
    selected: document.querySelector('.admin-tabs [aria-selected=true]')?.id,
    login: document.querySelector('.login .err')?.textContent,
    progress: document.getElementById('radioProgress')?.textContent,
    toast: document.querySelector('.toast')?.textContent,
  })).catch(() => ({})), errors);
  throw error;
} finally {
  await browser.close();
}
