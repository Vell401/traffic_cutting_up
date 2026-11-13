/** Offline authoring support. Runtime never imports this file or contacts Poly Haven. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ua = 'TrafficCuttingUp-MiamiRebuild/1.0';
const sourcePath = resolve(root, 'assets/miami/sources.json');
const manifestPath = resolve(root, 'public/models/miami/manifest.json');
const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const local = path => resolve(root, `public${path}`);
function ensure(condition, message) { if (!condition) throw new Error(message); }

// Read the actual headers, rather than assuming the API resolution label.
function dimensions(data, extension) {
  if (extension === 'hdr') {
    const match = data.subarray(0, 2048).toString('ascii').match(/-Y (\d+) \+X (\d+)/);
    ensure(match, 'Missing Radiance dimensions');
    return { width: +match[2], height: +match[1] };
  }
  ensure(data[0] === 0xff && data[1] === 0xd8, 'Not a JPEG');
  for (let offset = 2; offset < data.length;) {
    ensure(data[offset] === 0xff, 'Invalid JPEG marker');
    const marker = data[offset + 1], size = data.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    offset += size + 2;
  }
  throw new Error('JPEG dimensions not found');
}
async function json(url) {
  const response = await fetch(url, { headers: { 'User-Agent': ua } });
  ensure(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
}
async function download() {
  let locked;
  try { locked = JSON.parse(await readFile(sourcePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = [];
  for (const asset of ['aerial_asphalt_01', 'concrete_wall_007', 'painted_plaster_wall', 'kloppenheim_06_puresky']) {
    const [files, info] = await Promise.all([json(`https://api.polyhaven.com/files/${asset}`), json(`https://api.polyhaven.com/info/${asset}`)]);
    const channels = asset.endsWith('puresky') ? [['hdri', 'hdr', 'linear']] :
      [['Diffuse', 'jpg', 'sRGB'], ['nor_gl', 'jpg', 'linear'], ['Rough', 'jpg', 'linear']];
    for (const [channel, extension, colorSpace] of channels) {
      const f = files[channel]['1k'][extension];
      ensure(f.size <= 2 * 1024 * 1024, `Oversize original ${asset}/${channel}`);
      const path = `/textures/miami/${f.url.split('/').at(-1)}`;
      const previous = locked?.textures.find(t => t.path === path);
      if (previous) ensure(previous.source.publishedMd5 === f.md5, `Upstream changed ${path}; inspect and explicitly update lock`);
      let data;
      try { data = await readFile(local(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!data) {
        const response = await fetch(f.url, { headers: { 'User-Agent': ua } });
        ensure(response.ok, `HTTP ${response.status}: ${f.url}`);
        // Check both declared and actual size; never fetch unbounded source archives.
        ensure(+(response.headers.get('content-length') || 0) <= 2 * 1024 * 1024, 'Oversize response');
        data = Buffer.from(await response.arrayBuffer());
        ensure(data.length === f.size && hash(data, 'md5') === f.md5, `Published checksum mismatch: ${path}`);
        await mkdir(dirname(local(path)), { recursive: true });
        await writeFile(local(path), data);
      }
      ensure(data.length === f.size && hash(data, 'md5') === f.md5, `Local source checksum mismatch: ${path}`);
      entries.push({ id: `${asset}_${channel.toLowerCase()}`, path, bytes: data.length,
        sha256: hash(data), md5: hash(data, 'md5'), ...dimensions(data, extension), colorSpace,
        source: { asset, url: f.url, api: `https://api.polyhaven.com/files/${asset}`,
          author: Object.entries(info.authors).map(([name, role]) => `${name} (${role})`).join('; '),
          license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license', publishedMd5: f.md5 },
        derivative: 'none; byte-identical published original' });
      console.log(`${asset}/${channel}: ${data.length} bytes; MD5 verified`);
    }
  }
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, JSON.stringify({ schema: 1, userAgent: ua, textures: entries }, null, 2) + '\n');
}
const boxJSON = box => ({ min: box.min.toArray(), max: box.max.toArray() });
async function parse() {
  const data = await readFile(resolve(root, 'public/models/miami/coastal-kit.glb'));
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  return { data, gltf };
}
async function manifest() {
  const { data, gltf } = await parse();
  const authoring = JSON.parse(await readFile(resolve(root, 'assets/miami/authoring.json'), 'utf8'));
  const { textures } = JSON.parse(await readFile(sourcePath, 'utf8'));
  const prototypes = gltf.scene.children.map(root => {
    const parts = [];
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      ensure(!Array.isArray(mesh.material), 'A part must have exactly one shared material');
      parts.push({ name: mesh.name, material: mesh.material.name, triangles: mesh.geometry.index.count / 3,
        bounds: boxJSON(new THREE.Box3().setFromObject(mesh)) });
    });
    return { name: root.name, bounds: boxJSON(new THREE.Box3().setFromObject(root)),
      triangles: parts.reduce((sum, p) => sum + p.triangles, 0), parts, materials: parts.map(p => p.material),
      features: authoring.prototypes[root.name],
      ...(root.name === 'yacht' ? { waterline: 0.9, placement: 'pivot at water surface minus 0.9m; bow -Z' } : {}),
      ...(root.name === 'marina_pontoon' ? { waterline: 0.3, placement: 'pivot at water surface minus 0.3m; deck +0.42m above water' } : {}) };
  });
  const result = { schema: 1, generator: authoring.generator,
    contract: { units: 'metres', up: '+Y', front: '-Z', pivot: 'bottom-centre',
      textureMode: 'runtime-shared', uv: 'UV0 is pre-scaled metres/2; use RepeatWrapping and repeat=(1,1); flipY=false for GLB UVs',
      extraction: 'Each identity root has one identity mesh per shared material; bake mesh.matrixWorld relative to root before instancing. No lights/cameras/animations in GLB.' },
    model: { path: '/models/miami/coastal-kit.glb', bytes: data.length, sha256: hash(data),
      author: 'Traffic Cutting Up project', source: 'project-authored in Blender; no extracted game models',
      license: 'project-authored; project rights unchanged (not covered by Poly Haven CC0)' },
    totalBytes: data.length + textures.reduce((sum, t) => sum + t.bytes, 0),
    partBatches: prototypes.reduce((sum, p) => sum + p.parts.length, 0), prototypes,
    materials: authoring.materials, textures,
    environment: { texture: 'kloppenheim_06_puresky_hdri', projection: 'equirectangular',
      colorSpace: 'linear', notes: 'Photographed late-sunset sky; use PMREM for reflections and original for background; no runtime third-party URLs.' },
    limits: { initialBytes: 48 * 1024 * 1024, sharedTextures: 48, prototypePartBatches: 120,
      runtimeVisibleInstances: 1800, wholeFrameCalls: 500, wholeFrameTriangles: 5000000 } };
  await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Manifest: ${result.partBatches} prototype-part batches, ${prototypes.reduce((sum, p) => sum + p.triangles, 0)} triangles, ${result.totalBytes} payload bytes`);
}
async function validate() {
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { data, gltf } = await parse();
  ensure(hash(data) === m.model.sha256 && data.length === m.model.bytes, 'Stale GLB checksum');
  ensure(gltf.scene.children.length === 15 && m.prototypes.length === 15, 'Missing prototype');
  let parts = 0, triangles = 0;
  gltf.scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    parts++; const g = mesh.geometry, p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
    ensure(p && n && uv && g.index && p.count > 0 && p.count === n.count && p.count === uv.count, `Missing geometry channels ${mesh.name}`);
    for (const a of [p, n, uv]) ensure([...a.array].every(Number.isFinite), `Nonfinite geometry ${mesh.name}`);
    for (let i = 0; i < n.count; i++) ensure(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 0.002, `Invalid normal ${mesh.name}`);
    triangles += g.index.count / 3;
    ensure(!mesh.material.map, 'GLB must not duplicate external texture payload');
  });
  let bytes = data.length;
  for (const t of m.textures) {
    const file = await readFile(local(t.path));
    ensure(hash(file) === t.sha256 && hash(file, 'md5') === t.source.publishedMd5 && file.length === t.bytes, `Texture checksum ${t.path}`);
    const d = dimensions(file, t.path.split('.').at(-1));
    ensure(d.width === t.width && d.height === t.height, `Image dimensions ${t.path}`);
    bytes += file.length;
  }
  ensure(parts === m.partBatches && parts <= 120 && m.textures.length <= 48, 'Batch/texture limit');
  ensure(bytes === m.totalBytes && bytes + (await stat(manifestPath)).size <= 48 * 1024 * 1024, 'Payload limit');
  console.log(JSON.stringify({ valid: true, prototypes: 15, parts, triangles, textures: m.textures.length, bytes }, null, 2));
}

const command = process.argv[2];
if (command === 'download') await download();
else if (command === 'manifest') await manifest();
else if (command === 'validate') await validate();
else throw new Error('Usage: node scripts/miamiAssets.mjs download|manifest|validate');
