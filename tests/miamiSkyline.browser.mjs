// Focused Task3 skyline repair evidence, not an admin/network integration rerun.
// Read-only API responses are isolated below; real game/assets/WebGL are unchanged.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = process.env.MIAMI_REBUILD_BASE_URL, output = process.env.MIAMI_REBUILD_OUTPUT_DIR;
assert.ok(base && output && process.env.PLAYWRIGHT_MODULE);
assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost)$/);
mkdirSync(output, { recursive: true });
function fingerprint() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts', 'tests', 'public/models/miami', 'public/textures/miami'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha256: hash.digest('hex'), files: paths.length };
}
const result = { source: fingerprint(), apiReadMocks: true, cars: [], captures: [], errors: [] };
const save = () => writeFileSync(`${output}/evidence.json`, JSON.stringify(result, null, 2));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.MIAMI_REBUILD_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
try {
  for (const car of [2, 3, 1, 4]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.addInitScript(car => {
      localStorage.setItem('tcu.quality', 'medium'); localStorage.setItem('tcu.car', String(car));
      let seed = 7; Math.random = () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }, car);
    await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
    await context.route('**/api/**', r => { assert.equal(r.request().method(), 'GET'); return r.fulfill({ json: { records: [], playlists: [], tracks: [], stations: [], tuning: {}, revision: 0 } }); });
    await context.route('**/health', r => r.fulfill({ json: { ok: true, players: 0 } }));
    const page = await context.newPage();
    page.on('pageerror', e => result.errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') result.errors.push(m.text()); });
    await page.goto(`${base}/?solo&map=miami`);
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 240000 });
    const ready = await page.evaluate(() => {
      const v = window.__game.view; v.renderer.setAnimationLoop(null); v.adaptResolution = () => {}; v.renderer.setPixelRatio(1); v.resize();
      return { ready: v.environmentReady, programs: v.renderer.info.programs.length };
    });
    assert.equal(ready.ready, true);
    async function capture(s, label = String(s), yaw = 0) {
      const row = await page.evaluate(({ s, yaw }) => {
        const { sim, view: v } = window.__game;
        sim.player.reset(s, 0, 0); sim.player.ghost = false; sim.road.ensure(s - 300, s + 1700);
        v.chase.setRig(v.chase.rig, 'chase'); v.chase.lookYaw = yaw; v.chase.lookPitch = 0; v.chase.lookT = 0;
        v.camera.fov = 62.17771448963918; v.camera.updateProjectionMatrix(); v.snapCamera(); v.render(1, 0);
        return { s, yaw, calls: v.renderer.info.render.calls, triangles: v.renderer.info.render.triangles, dpr: v.renderer.getPixelRatio(),
          width: v.renderer.domElement.width, height: v.renderer.domElement.height,
          shadow: v.renderer.shadowMap.enabled, memory: { ...v.renderer.info.memory }, programs: v.renderer.info.programs.length,
          camera: { position: v.camera.position.toArray(), quaternion: v.camera.quaternion.toArray(), fov: v.camera.fov }, origin: [v.ox, v.oz],
          png: document.querySelector('#c').toDataURL() };
      }, { s, yaw });
      const file = `${output}/car${car}-${label}.png`;
      writeFileSync(file, Buffer.from(row.png.split(',')[1], 'base64')); delete row.png;
      assert.equal(row.dpr, 1); assert.equal(row.shadow, true);
      assert.equal(row.width, 1280); assert.equal(row.height, 800);
      result.captures.push({ car, file, ...row }); save(); return row;
    }
    const rows = [];
    for (const s of [300, 850, 3800, 6100, 8500, 8600, 8700, 8800, 10050, 11990, 12010]) rows.push(await capture(s));
    const ghost = await page.evaluate(() => { const { sim, view } = window.__game; sim.player.ghost = true; view.render(1, 0); sim.player.ghost = false; return { calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles }; });
    result.cars.push({ car, ready, rows, ghost }); save();
    console.log(JSON.stringify({ car, maxCalls: Math.max(...rows.map(r => r.calls)), maxTriangles: Math.max(...rows.map(r => r.triangles)), ghost }));
    if (car === 2) {
      for (const s of [1799, 1801, 1845, 1900, 1999, 2001, 2100, 2145, 2199, 2201, 2399, 2401, 2999, 3001, 3100, 3199, 3201, 3245, 3299, 3301, 3399, 3401, -10, 10, 23990, 24010]) await capture(s, `transition-${s}`);
      // Look back from a legal selectable chase rig to inspect exit coverage too.
      for (const s of [3044, 3046, 3094, 3096, 3144, 3146, 3199, 3201]) await capture(s, `exit-look-${s}`, -2.35);
      result.steady = await page.evaluate(() => {
        const { view } = window.__game, world = view.miamiWorld;
        view.chase.lookYaw = 0; view.chase.lookPitch = 0; view.chase.lookT = 0; view.snapCamera(); view.render(1, 0);
        const versions = () => world.group.children.map(m => [m.instanceMatrix.version, m.instanceColor.version]);
        const before = { memory: { ...view.renderer.info.memory }, versions: versions() };
        for (let i = 0; i < 12; i++) view.render(1, 0);
        return { before, after: { memory: { ...view.renderer.info.memory }, versions: versions() } };
      });
      assert.deepEqual(result.steady.before, result.steady.after);
      result.sweep = await page.evaluate(async () => {
        const { sim, view } = window.__game, rows = [];
        for (let s = 0; s < 12000; s += 100) {
          sim.player.reset(s, 0, 0); sim.player.ghost = false; sim.road.ensure(s - 300, s + 1700); view.snapCamera(); view.render(1, 0);
          rows.push({ s, calls: view.renderer.info.render.calls, triangles: view.renderer.info.render.triangles }); await new Promise(requestAnimationFrame);
        }
        return rows;
      });
      save();
    }
    await context.close();
  }
  result.finishedSource = fingerprint(); assert.deepEqual(result.finishedSource, result.source);
  save(); assert.deepEqual(result.errors, []);
  const normal = [...result.cars.flatMap(c => c.rows), ...result.sweep];
  assert(Math.max(...normal.map(r => r.calls)) <= 500);
  assert(Math.max(...normal.map(r => r.triangles)) <= 5_000_000);
  console.log('PASS skyline transitions, all-four normal whole-frame budgets, opaque depth/shadows, stable instance buffers');
} finally { save(); await browser.close(); }
