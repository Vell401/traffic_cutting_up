import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const playwright = process.env.PLAYWRIGHT_MODULE || 'C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs';
const executablePath = process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const section = (start: string, end: string) => {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  if (a < 0 || b <= a) throw new Error(`Missing production section: ${start}`);
  return main.slice(a, b);
};
const script = (path: string) => existsSync(new URL(path, import.meta.url))
  ? readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '') : '';
const fixture = `
  ${script('../src/ui/menuInput.ts')}
  ${script('../src/core/input.ts')}
  const input = new Input(), loading = { active: false }, TEST = false, ONLINE = true;
  let state = 'menu', onlineMenu = false, sessions = 0;
  function startOnline() { sessions++; loading.active = true; }
  ${section('function start():', '\nfunction enterPlay():')}
  ${section('input.onPress =', "for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-quality]')")}
  ${section('function choice<', '\nconst showCar =')}
  choice('carSeg', 'carDesc', [{ id: 1, name: 'First', desc: 'One' }, { id: 2, name: 'Second', desc: 'Two' }], 1, () => {});
  const nameInput = document.getElementById('nameInput');
  const defaultName = 'Driver', saved = [];
  const playerName = () => nameInput.value.trim().slice(0, 16) || defaultName;
  const saveName = name => saved.push(name), leaders = null;
  ${section('nameInput.value = defaultName;', '\nconst leaders =')}
  ${section('const keysBox =', '// Sky:')}
  let clicks = 0;
  document.getElementById('startBtn').addEventListener('click', () => clicks++);
  window.h = { input, saved, sessions: () => sessions, clicks: () => clicks };
`;

// Execute production Input and main handlers in native DOM, without a server/WebGL/audio.
describe.skipIf(!existsSync(playwright) || !existsSync(executablePath))('menu keyboard ownership in native Edge', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any, page: any;
  beforeAll(async () => {
    const { chromium } = await import(/* @vite-ignore */ pathToFileURL(playwright).href);
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(`<button id="startBtn">Start <b>now</b></button><div id="carSeg"></div><div id="carDesc"></div>
      <input id="nameInput"><select id="map"><option>Highway</option><option>Miami</option></select>
      <input id="color" type="color"><input id="range" type="range"><textarea id="text"></textarea>
      <details id="keysBox"><summary><span>Controls</span></summary><div class="keys">Keys</div></details>
      <details id="pauseKeysBox"><summary>Pause controls</summary></details>
      <div contenteditable="true" id="editor"><span>Edit</span></div><div id="background" tabindex="-1">Background</div>`);
    await page.addScriptTag({ content: stripTypeScriptTypes(fixture) });
  });
  afterEach(async () => { await page?.close(); });

  const targets = ['#carSeg button', '#carSeg b', '#map', '#nameInput', '#color', '#range', '#text', '#keysBox', 'summary span', '#editor span'];
  it.each(targets.flatMap(selector => ['Enter', 'Space'].map(code => ({ selector, code }))))('does not start from $code on $selector', async ({ selector, code }) => {
    const result = await page.evaluate(({ selector, code }: { selector: string; code: string }) => {
      const h = (window as any).h;
      const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
      document.querySelector(selector)!.dispatchEvent(event);
      return { sessions: h.sessions(), prevented: event.defaultPrevented };
    }, { selector, code });
    expect(result.sessions).toBe(0);
    if (selector !== '#nameInput') expect(result.prevented).toBe(false);
  });

  it('leaves native Space activation intact and keeps a selected choice focused for another activation', async () => {
    const choice = page.locator('#carSeg button').last();
    await choice.focus(); await page.keyboard.press('Space');
    expect(await choice.getAttribute('aria-pressed')).toBe('true');
    expect(await choice.evaluate((button: Element) => button === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate('h.sessions()')).toBe(0);
  });

  it('keeps a summary focused and usable with native Space and Enter', async () => {
    await page.locator('#keysBox summary').focus(); await page.keyboard.press('Space');
    expect(await page.locator('#keysBox').getAttribute('open')).not.toBeNull();
    expect(await page.evaluate('document.activeElement.parentElement.id')).toBe('keysBox');
    await page.keyboard.press('Enter');
    expect(await page.locator('#keysBox').getAttribute('open')).toBeNull();
    expect(await page.evaluate('h.sessions()')).toBe(0);
  });

  it('finishes and saves name editing on Enter without joining', async () => {
    await page.locator('#nameInput').fill('New Driver'); await page.keyboard.press('Enter');
    expect(await page.evaluate('document.activeElement.id')).not.toBe('nameInput');
    expect(await page.evaluate('h.saved')).toContain('New Driver');
    expect(await page.evaluate('h.sessions()')).toBe(0);
  });

  it.each(['Enter', 'Space'])('allows native start-button %s once despite repeats and duplicate clicks', async code => {
    await page.locator('#startBtn').focus(); await page.keyboard.press(code);
    expect(await page.evaluate('h.clicks()')).toBe(1);
    await page.evaluate((code: string) => {
      const button = document.querySelector('#startBtn')!;
      button.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: true, bubbles: true }));
      (button as HTMLElement).click(); (button as HTMLElement).click();
    }, code);
    expect(await page.evaluate('h.sessions()')).toBe(1);
  });

  it('preserves the gamepad start shortcut without a keyboard target', async () => {
    await page.evaluate('h.input.onPress("Enter"); h.input.onPress("Enter")');
    expect(await page.evaluate('h.sessions()')).toBe(1);
  });

  it('recognizes text-node children as controls without claiming noninteractive background or windows', async () => {
    const result = await page.evaluate(`[
      isMenuControl(document.querySelector('#carSeg b').firstChild),
      isMenuControl(document.querySelector('#editor span')),
      isMenuControl(document.querySelector('#background')), isMenuControl(window), isMenuControl(null)
    ]`);
    expect(result).toEqual([true, true, false, false, false]);
  });

  it.each(['Enter', 'Space'])('retains the noninteractive background %s shortcut once', async code => {
    await page.locator('#background').focus(); await page.keyboard.press(code); await page.keyboard.press(code);
    expect(await page.evaluate('h.sessions()')).toBe(1);
  });

  it('still releases held driving keys when the focused control stops bubbling keyup', async () => {
    const result = await page.evaluate(() => {
      const h = (window as any).h, select = document.querySelector('select')!;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      const held = h.input.isDown('KeyW');
      select.addEventListener('keyup', e => e.stopPropagation()); select.focus();
      select.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })); h.input.poll();
      return { held, after: h.input.isDown('KeyW'), throttle: h.input.drive.throttle };
    });
    expect(result).toEqual({ held: true, after: false, throttle: 0 });
  });
});
