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
const fixture = `
  ${readFileSync(new URL('../src/ui/loading.ts', import.meta.url), 'utf8').replace('export const loading', 'const loading')}
  const startEl = document.querySelector('#start'), pauseEl = document.querySelector('#pause');
  let state = 'menu', onlineMenu = false;
  const chat = { active: false }, touchLayout = { matches: false, addEventListener() {} };
  const touch = { setActive() {} }, audioPanels = [], mobileAudio = document.createElement('details');
  const mixer = { setVisible(visible) { document.querySelector('#mixer').inert = !visible; } };
  ${section("let touchSnapshot = '';", '\nsim.events.on(')}
  window.h = { loading, syncTouch, state(next) { state = next; syncTouch(); } };
`;

describe.skipIf(!existsSync(playwright) || !existsSync(executablePath))('loader and desktop lifecycle focus ownership in native Edge', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any, page: any;
  beforeAll(async () => {
    const { chromium } = await import(/* @vite-ignore */ pathToFileURL(playwright).href);
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(`<div id="start"><div class="card"><button id="startButton">Start</button></div></div>
      <div id="pause"><div class="pause-settings"><button id="pauseButton">Resume</button></div></div>
      <div id="mixer"><button>Mute</button></div><div id="protected" inert><button>Unavailable</button></div>
      <div id="loading"><div id="loadingTitle"></div><div role="progressbar"></div><div id="loadingBar"></div>
      <div id="loadingPercent"></div><div id="loadingLabel"></div><button id="loadingAction" hidden>Return</button></div>`);
    await page.addScriptTag({ content: stripTypeScriptTypes(fixture) });
  });
  afterEach(async () => { await page?.close(); });

  it('returns keyboard focus to a visible choice after its load without focusing a hidden choice after joining', async () => {
    const result = await page.evaluate(async () => {
      const h = (window as any).h;
      h.state('menu'); h.loading.finish();
      document.getElementById('startButton')!.focus(); h.loading.begin('car', 'Loading');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); h.loading.finish();
      const carFocus = document.activeElement!.id;
      h.loading.begin('online', 'Joining'); h.state('play');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); h.loading.finish();
      return { carFocus, joinedFocus: document.activeElement!.id };
    });
    expect(result.carFocus).toBe('startButton');
    expect(result.joinedFocus).not.toBe('startButton');
  });

  for (const context of ['boot', 'online', 'car']) for (const failed of [false, true]) {
    it(`${context} ${failed ? 'failure action' : 'finish'} retains hidden overlay inertness and locks visible controls until unlock`, async () => {
      const result = await page.evaluate(({ context, failed }: { context: string; failed: boolean }) => {
        const h = (window as any).h;
        h.state(context === 'car' ? 'pause' : 'menu');
        h.loading.begin(context, 'Loading'); h.syncTouch();
        if (context === 'online') h.state('play');
        const flags = () => ['start', 'pause', 'mixer', 'protected'].map(id => document.getElementById(id)!.inert);
        const during = flags();
        document.getElementById(context === 'car' ? 'pauseButton' : 'startButton')!.focus();
        const backgroundFocused = ['startButton', 'pauseButton'].includes(document.activeElement!.id);
        let failureLocked = true;
        if (failed) {
          h.loading.fail('Failed', () => {}); h.syncTouch(); failureLocked = flags().every(Boolean);
          (document.getElementById('loadingAction') as HTMLElement).click();
        } else h.loading.finish();
        const immediate = flags(); h.syncTouch(); const after = flags();
        // Hidden lifecycle controls cannot be focused even though desktop CSS only fades them.
        for (const id of context === 'online' ? ['startButton', 'pauseButton'] : [context === 'car' ? 'startButton' : 'pauseButton']) {
          document.getElementById(id)!.focus();
          if (document.activeElement!.id === id) throw new Error(`Hidden ${id} accepted focus`);
        }
        return { during, backgroundFocused, failureLocked, immediate, after };
      }, { context, failed });
      expect(result.during).toEqual([true, true, true, true]);
      expect(result.backgroundFocused).toBe(false);
      expect(result.failureLocked).toBe(true);
      const expected = context === 'online' ? [true, true, true, true] : context === 'car' ? [true, false, false, true] : [false, true, false, true];
      expect(result.immediate).toEqual(expected); expect(result.after).toEqual(expected);
    });
  }
});
