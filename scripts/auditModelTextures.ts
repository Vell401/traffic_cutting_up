/** Read-only exact-pixel audit. Use --json to print detailed, reproducible image/channel records. */
import { readFileSync } from 'node:fs';
import { auditModelTextures } from './lib/modelTextureAudit';

for (const file of ['mercedes-a45s.glb', 'mercedes-w204.glb', 'porsche-911-irl10.glb']) {
  const report = auditModelTextures(readFileSync(new URL(`../public/models/${file}`, import.meta.url)));
  console.log(JSON.stringify({ file, ...(process.argv.includes('--json') ? report : { ...report, imageRecords: undefined }) }, null, 2));
}
