import { defineConfig } from 'vitest/config';

/** Local game server (npm run server). The dev site proxies /ws and /health to it, like nginx would in production. */
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: GAME_SERVER, ws: true },
      '/health': { target: GAME_SERVER },
    },
  },
  // three.js + postprocessing (~740 kB minified) plus the sim and online code: ~810 kB, ~220 kB gzip.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  test: { include: ['tests/**/*.test.ts'] },
});
