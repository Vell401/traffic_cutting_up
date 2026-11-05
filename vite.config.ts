import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // three.js + postprocessing are ~740 kB minified (~195 kB gzip): one cacheable vendor chunk.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
  test: { include: ['tests/**/*.test.ts'] },
});
