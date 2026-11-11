import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Build-only lossless sidecars: no per-download CPU cost on the small production VPS. */
export async function precompressModels(directory: string): Promise<void> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Sequential to bound peak RAM when building the 36 MB A45 on a small host.
  for (const file of files.filter(file => file.endsWith('.glb'))) {
    const bytes = await readFile(join(directory, file));
    const compressed = gzipSync(bytes, { level: 6 });
    const sidecar = join(directory, `${file}.gz`);
    if (compressed.length < bytes.length) await writeFile(sidecar, compressed);
    else await unlink(sidecar).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
