import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

// Optional real-DOM acceptance, following the existing browser scripts' local setup.
// Set both paths on other machines; no browser or DOM dependency is added to the app.
const playwright = process.env.PLAYWRIGHT_MODULE
  || 'C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs';
const executablePath = process.env.BROWSER_EXECUTABLE
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const html = `<!doctype html><html><body><div id="picker"></div><button id="after">After</button>
<script type="module">
import { Input } from '/src/core/input.ts';
import { mountServerPicker, mapNavigation, selectedMap } from '/src/ui/serverPicker.ts';
const input = new Input(), presses = [], selections = [], urls = [];
input.onPress = code => {
  presses.push(code);
  sessionStorage.setItem('presses', JSON.stringify(presses));
};
const root = document.querySelector('#picker');
const mount = (selected = 'highway') => mountServerPicker(root, selected, map => {
  selections.push(map);
  const next = mapNavigation(new URL(location.href), map);
  urls.push(next.href);
  if (new URL(location.href).searchParams.has('navigate')) location.assign(next.href);
});
const dispose = mount(selectedMap(new URLSearchParams(location.search), { getItem: () => null }));
window.pickerTest = { input, presses, selections, urls, root, mount, dispose };
document.documentElement.dataset.ready = 'true';
</script></body></html>`;

describe.skipIf(!existsSync(playwright) || !existsSync(executablePath))('server picker with real Input and native Edge DOM', () => {
  let server: ViteDevServer;
  // Playwright is loaded from the same optional external installation as browser scripts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any, page: any;
  let base: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false, appType: 'custom', server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'picker-keyboard-test', configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/__picker_keyboard_test')) return next();
          res.setHeader('Content-Type', 'text/html'); res.end(html);
        });
      } }],
    });
    await server.listen();
    base = server.resolvedUrls!.local[0];
    const moduleUrl = pathToFileURL(playwright).href;
    const { chromium } = await import(/* @vite-ignore */ moduleUrl);
    browser = await chromium.launch({ executablePath, headless: true });
  }, 30_000);

  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(`${base}__picker_keyboard_test?map=highway&server=wss%3A%2F%2Fcustom.test`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  });
  afterEach(async () => { await page?.close(); });

  it('leaves native key defaults intact without firing game commands or holding driving keys', async () => {
    const result = await page.evaluate(() => {
      const state = (window as any).pickerTest;
      const select = document.querySelector('select')!;
      select.focus();
      const events = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter',
        'NumpadEnter', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape', 'KeyM', 'KeyW', 'KeyP', 'F1']
        .flatMap(code => [false, true].map(repeat => {
          const event = new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true });
          const allowed = select.dispatchEvent(event);
          return { code, allowed, prevented: event.defaultPrevented, held: state.input.isDown(code) };
        }));
      state.input.poll();
      return { events, presses: state.presses, drive: state.input.drive };
    });
    expect(result.events.every((event: { allowed: boolean; prevented: boolean; held: boolean }) =>
      event.allowed && !event.prevented && !event.held)).toBe(true);
    expect(result.presses).toEqual([]);
    expect(result.drive).toMatchObject({ steer: 0, throttle: 0, brake: 0, handbrake: false });
  });

  it('preserves capture-phase keyup releases for keys held before focusing the select', async () => {
    const result = await page.evaluate(() => {
      const state = (window as any).pickerTest;
      const select = document.querySelector('select')!;
      const codes = ['KeyW', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ControlLeft'];
      for (const code of codes) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      const heldBefore = codes.every(code => state.input.isDown(code));
      select.focus();
      // Even another UI's bubbling keyup isolation cannot hide releases from Input.
      select.addEventListener('keyup', event => event.stopPropagation());
      for (const code of codes) select.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      state.input.poll();
      return { heldBefore, heldAfter: codes.some(code => state.input.isDown(code)), drive: state.input.drive };
    });
    expect(result.heldBefore).toBe(true);
    expect(result.heldAfter).toBe(false);
    expect(result.drive).toMatchObject({ steer: 0, throttle: 0, brake: 0, boost: false, clutch: false, handbrake: false });
  });

  it('keeps isolation local: game keyboard input still works outside the select', async () => {
    const result = await page.evaluate(() => {
      const state = (window as any).pickerTest;
      const event = new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true, cancelable: true });
      document.querySelector('#after')!.dispatchEvent(event);
      state.input.poll();
      return { presses: state.presses, prevented: event.defaultPrevented, brake: state.input.drive.brake };
    });
    expect(result).toEqual({ presses: ['ArrowDown'], prevented: true, brake: 1 });
  });

  it('allows native ArrowDown/Enter selection and builds the new map URL, not a Solo action', async () => {
    await page.locator('select').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const result = await page.evaluate(`({ value: document.querySelector('select').value,
      selections: pickerTest.selections, urls: pickerTest.urls, presses: pickerTest.presses })`);
    expect(result.value).toBe('miami');
    expect(result.selections).toContain('miami');
    expect(result.presses).toEqual([]);
    const url = new URL(result.urls.at(-1));
    expect(url.searchParams.get('map')).toBe('miami');
    expect(url.searchParams.has('server')).toBe(false);
    expect(url.searchParams.has('solo')).toBe(false);
  });

  it('navigates to Miami with the actual native ArrowDown change event', async () => {
    await page.goto(`${base}__picker_keyboard_test?map=highway&navigate`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.locator('select').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForURL((url: URL) => url.searchParams.get('map') === 'miami');
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    expect(await page.locator('select').inputValue()).toBe('miami');
    expect(await page.evaluate(`sessionStorage.getItem('presses')`)).toBeNull();
    expect(new URL(page.url()).searchParams.has('solo')).toBe(false);
  });

  it('retains native options, accessible labeling, Tab focus and non-keyboard change events', async () => {
    const select = page.getByRole('combobox', { name: 'Онлайн-сервер и карта' });
    expect(await select.locator('option').allTextContents()).toEqual(['Night Highway', 'Miami Night']);
    expect(await select.getAttribute('aria-describedby')).toBe('serverChoiceDescription');
    await select.focus(); await page.keyboard.press('Tab');
    expect(await page.evaluate(`document.activeElement.id`)).toBe('after');
    expect(await page.evaluate(`pickerTest.presses`)).toEqual([]);
    await select.selectOption('miami');
    expect(await page.evaluate(`pickerTest.selections`)).toEqual(['miami']);
  });

  it('removes listeners on disposal without a stale disposer deleting the replacement picker', async () => {
    const result = await page.evaluate(() => {
      const state = (window as any).pickerTest;
      const retired = document.querySelector('select')!;
      const disposeNew = state.mount('miami');
      state.dispose(); state.dispose();
      const current = document.querySelector('select')!;
      const replacementSurvived = current.value === 'miami' && current.isConnected;
      document.body.append(retired);
      retired.value = 'miami'; retired.dispatchEvent(new Event('change', { bubbles: true }));
      retired.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
      current.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      disposeNew(); disposeNew();
      state.input.dispose();
      return { replacementSurvived, children: state.root.childElementCount, selections: state.selections, presses: state.presses };
    });
    expect(result).toEqual({ replacementSurvived: true, children: 0, selections: [], presses: ['Enter'] });
  });
});
