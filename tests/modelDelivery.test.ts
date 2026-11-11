/// <reference types="node" />
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { precompressModels } from '../scripts/lib/precompressModels';

describe('lossless static-model delivery', () => {
  it('builds independently decompressible sidecars, keeps the original bytes, and ignores other file types', async () => {
    const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
    const directory = await mkdtemp(join(root, 'model-delivery-'));
    try {
      const bytes = Buffer.from('test-model-geometry-and-detailed-textures'.repeat(1000));
      await writeFile(join(directory, 'test.glb'), bytes);
      await writeFile(join(directory, 'manifest.json'), '{}');
      await precompressModels(directory);
      const compressed = await readFile(join(directory, 'test.glb.gz'));
      expect(compressed.length).toBeLessThan(bytes.length);
      expect(gunzipSync(compressed)).toEqual(bytes);
      expect(await readFile(join(directory, 'test.glb'))).toEqual(bytes);
      expect((await readdir(directory)).sort()).toEqual(['manifest.json', 'test.glb', 'test.glb.gz']);
      await precompressModels(directory);
      expect(await readFile(join(directory, 'test.glb.gz'))).toEqual(compressed);
      await expect(precompressModels(join(directory, 'missing'))).resolves.toBeUndefined();
      await writeFile(join(directory, 'test.glb'), Buffer.from([1]));
      await precompressModels(directory);
      expect(await readdir(directory)).not.toContain('test.glb.gz'); // Never serve a stale sidecar.
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps hashed JS immutable, revalidates mutable models/audio and HTML, and enables precompressed GLB', () => {
    const caddy = readFileSync(new URL('../deploy/docker/Caddyfile', import.meta.url), 'utf8');
    expect(caddy).toContain('@hashed path /assets/*');
    expect(caddy).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(caddy).toContain('@media path /models/* /audio/*');
    expect(caddy).toContain('Cache-Control "public, max-age=0, must-revalidate"');
    expect(caddy).toContain('@page path / /index.html /admin.html /version.json');
    expect(caddy).toContain('Cache-Control "no-cache"');
    expect(caddy).toMatch(/file_server\s*\{[^}]*precompressed gzip/);
    expect(caddy).toContain('@game path /ws /health /api /api/*');
    expect(caddy).toContain('reverse_proxy game:8787');
    expect(caddy).toContain('reverse_proxy game-miami:8787');
  });

  it('does not introduce a throughput ceiling in deployment configuration', () => {
    for (const file of ['deploy/docker/Caddyfile', 'deploy/Caddyfile', 'deploy/nginx.conf', 'compose.yaml']) {
      const config = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(config).not.toMatch(/limit_rate|rate_limit|bandwidth|20\s*(?:mbit|mbps)/i);
    }
  });
});
