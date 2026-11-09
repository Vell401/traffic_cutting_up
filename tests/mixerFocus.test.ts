import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

const playwright = process.env.PLAYWRIGHT_MODULE
  || 'C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs';
const executable = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

describe('mixer driving focus lifecycle', () => {
  it('wires menu, solo pause and online pause visibility through the shared state sync', () => {
    const main = readFileSync(resolve('src/main.ts'), 'utf8');
    expect(main).toContain("const paused = state === 'pause' || onlineMenu;");
    expect(main).toContain("mixer.setVisible(state === 'menu' || paused);");
  });

  // Native Tab navigation and visibility cannot be verified by a DOM stub.
  it.skipIf(!existsSync(playwright) || !existsSync(executable))(
    'native Tab skips hidden mixer, W reaches Input, and menu/pause retain accessible levels',
    async () => {
      const markup = readFileSync(resolve('index.html'), 'utf8').match(/<aside id="mixer"[\s\S]*?<\/aside>/)![0];
      const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head>
        <body class="menu"><button id="before">Before mixer</button>${markup}<button id="after">After mixer</button>
        <script type="module">
          import { Mixer } from '/src/ui/mixer.ts';
          import { Input } from '/src/core/input.ts';
          import { Sound } from '/src/audio/sound.ts';
          import { Sim } from '/src/sim/world.ts';
          localStorage.removeItem('tcu.mix');
          const sound = new Sound(new Sim());
          const mixer = new Mixer(sound);
          const input = new Input();
          window.__mixerTest = { sound, input, setState(state) {
            document.body.classList.toggle('menu', state === 'menu');
            document.body.classList.toggle('paused', state === 'pause');
            mixer.setVisible(state !== 'play');
          }};
        </script></body></html>`;
      const server = await createServer({
        configFile: false,
        server: { host: '127.0.0.1', port: 0 },
        plugins: [{ name: 'mixer-focus-fixture', configureServer(server) {
          server.middlewares.use('/__mixer_focus__', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
          });
        } }],
      });
      let browser: { close(): Promise<void> } | undefined;
      try {
        await server.listen();
        const { chromium } = await import(pathToFileURL(playwright).href);
        const launched = await chromium.launch({ executablePath: executable, headless: true });
        browser = launched;
        const page = await launched.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`${server.resolvedUrls!.local[0]}__mixer_focus__`);
        await page.waitForFunction('!!window.__mixerTest');
        const active = () => page.evaluate('document.activeElement.id');

        await page.locator('#before').focus();
        await page.keyboard.press('Tab');
        expect(await active()).toBe('muteBtn');
        await page.keyboard.press('Space');
        expect(await page.evaluate('window.__mixerTest.sound.isMuted')).toBe(true);
        await page.evaluate(`window.__mixerTest.sound.setLevel('engine', .37);
          window.__mixerTest.sound.setLevel('radio', .23)`);
        await page.locator('#mixer input[data-channel="engine"]').focus();
        // Slider keys remain local while the mixer is visible.
        await page.keyboard.down('KeyW');
        expect(await page.evaluate('window.__mixerTest.input.isDown("KeyW")')).toBe(false);
        await page.keyboard.up('KeyW');

        await page.evaluate('window.__mixerTest.setState("play")');
        expect(await page.evaluate('document.querySelector("#mixer").contains(document.activeElement)')).toBe(false);
        expect(await page.locator('#mixer').evaluate((el: HTMLElement) => el.inert)).toBe(true);
        expect(await page.locator('#mixer').evaluate((el: HTMLElement) => getComputedStyle(el).visibility)).toBe('hidden');
        for (const control of await page.locator('#mixer button, #mixer input').all()) {
          await control.evaluate((el: HTMLElement) => el.focus());
          expect(await page.evaluate('document.querySelector("#mixer").contains(document.activeElement)')).toBe(false);
        }
        await page.locator('#before').focus();
        for (let n = 0; n < 12; n++) {
          await page.keyboard.press('Tab');
          expect(await page.evaluate('document.querySelector("#mixer").contains(document.activeElement)')).toBe(false);
          await page.keyboard.down('KeyW');
          expect(await page.evaluate('window.__mixerTest.input.poll(); window.__mixerTest.input.drive.throttle')).toBe(1);
          await page.keyboard.up('KeyW');
        }
        // The stylesheet itself must also remove invisible controls from native Tab order.
        await page.locator('#mixer').evaluate((el: HTMLElement) => { el.inert = false; });
        await page.locator('#before').focus();
        await page.keyboard.press('Tab');
        expect(await active()).toBe('after');

        for (const state of ['pause', 'menu']) {
          await page.evaluate(`window.__mixerTest.setState('${state}')`);
          await page.locator('#before').focus();
          await page.keyboard.press('Tab');
          expect(await active()).toBe('muteBtn');
          expect(await page.locator('#mixer').evaluate((el: HTMLElement) => getComputedStyle(el).visibility)).toBe('visible');
          await page.keyboard.press('Tab');
          expect(await page.evaluate('document.activeElement.dataset.channel')).toBe('master');
          expect(await page.locator('#mixer input[data-channel="engine"]').inputValue()).toBe('37');
          expect(await page.locator('#mixer input[data-channel="radio"]').inputValue()).toBe('23');
          expect(await page.evaluate('window.__mixerTest.sound.isMuted')).toBe(true);
        }
      } finally {
        await browser?.close();
        await server.close();
      }
    }, 60000,
  );
});
