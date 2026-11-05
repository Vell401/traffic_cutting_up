import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // three.js alone is ~590 kB minified (~150 kB gzip); it is one cacheable vendor chunk.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 700 },
  test: { include: ['tests/**/*.test.ts'] },
});
