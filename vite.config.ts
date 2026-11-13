import { defineConfig, type ViteUserConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';
import { precompressModels } from './scripts/lib/precompressModels.ts';

/** Local game server (npm run server). The dev site proxies /ws and /health to it, like nginx would in production. */
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';
const GAME_MIAMI_SERVER = process.env.GAME_MIAMI_SERVER ?? 'http://localhost:8788';

function compressedModels(): Plugin {
  let directory = '';
  return {
    name: 'precompressed-models',
    apply: 'build',
    configResolved(config) { directory = resolve(config.root, config.build.outDir, 'models'); },
    async closeBundle() { await precompressModels(directory); },
  };
}

export default defineConfig(({ isSsrBuild }): ViteUserConfig => ({
  plugins: isSsrBuild ? [] : [compressedModels()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Match the nested backend routes first; the query-selected UI is still /index.html.
      '^/miami/(?:ws|health)(?:\\?|$)|^/miami/api(?:/|\\?|$)': {
        target: GAME_MIAMI_SERVER,
        ws: true,
        rewrite: path => path.replace(/^\/miami(?=\/)/, ''),
      },
      '/ws': { target: GAME_SERVER, ws: true },
      '/health': { target: GAME_SERVER },
      '/api': { target: GAME_SERVER },
    },
  },
  // three.js + postprocessing (~740 kB minified) plus the sim and online code: ~810 kB, ~220 kB gzip.
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    // npm run build: the game and the admin page. npm run build:server: the game server, the smoke-test
    // client and the log reader, side by side in dist-server/.
    rollupOptions: isSsrBuild
      ? { input: { main: 'server/main.ts', smoke: 'scripts/smoke.ts', logs: 'server/logs.ts', networkSandbox: 'server/networkSandbox.ts' } }
      : { input: { main: 'index.html', admin: 'admin.html', network: 'network.html' } },
    ...(isSsrBuild ? { copyPublicDir: false } : {}),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Bound CPU-heavy asset/physics contention on developer machines and CI without relaxing timeouts.
    maxWorkers: 2,
    isolate: true,
  },
}));
