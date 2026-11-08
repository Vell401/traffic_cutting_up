import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = (path: string) => new URL(`../${path}`, import.meta.url);
describe('replacement R34 uses pinned, redistributable external foundations', () => {
  for (const [project, pin] of [
    ['chrono', 'bdfd07c2edee80361acffbe01df392c36c6d8ef6'],
    ['sketchbook', '62f4b7986fd1ce1e4f91daba89ef032c20a6ce55'],
  ]) it(`retains unmodified ${project} sources and their distributed license`, () => {
    const manifest = JSON.parse(readFileSync(root(`third_party/${project}/UPSTREAM.json`), 'utf8')) as {
      revision: string; files: Record<string, string>;
    };
    expect(manifest.revision).toBe(pin);
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(root(`third_party/${project}/${name}`))).digest('hex'), name).toBe(hash);
    }
    const license = readFileSync(root(`third_party/${project}/LICENSE`), 'utf8').replace(/\s+/g, ' ').trim();
    const distributed = readFileSync(root('public/THIRD_PARTY_LICENSES.txt'), 'utf8').replace(/\s+/g, ' ');
    expect(distributed).toContain(license);
  });
});
