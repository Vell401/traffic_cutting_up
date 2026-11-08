/** Lossless only: collapse proven-uniform PNGs, deduplicate images; never resample detailed textures. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const path = process.argv[2] ?? fileURLToPath(new URL('../public/models/mercedes-a45s.glb', import.meta.url));
const output = process.argv[3] ?? path;
const b = fs.readFileSync(path), jsonLength = b.readUInt32LE(12);
const g = JSON.parse(b.subarray(20, 20 + jsonLength)), binary = b.subarray(28 + jsonLength);
const hash = data => createHash('sha256').update(data).digest('hex');
const reportPath = fileURLToPath(new URL('../docs/a45-textures.json', import.meta.url));
const fileHashBefore = hash(b);
if (fs.existsSync(reportPath)) {
  const previous = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (previous.fileHashAfter === fileHashBefore) {
    if (output !== path) fs.copyFileSync(path, output);
    console.log('A45 already optimized; keeping the original verification report.');
    process.exit(0);
  }
}
function geometryHash(asset, bin) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify({ nodes: asset.nodes, meshes: asset.meshes, accessors: asset.accessors, materials: asset.materials }));
  const used = new Set(asset.accessors.map(a => a.bufferView));
  for (const id of [...used].sort((a,b) => a-b)) {
    const view = asset.bufferViews[id], ext = view.extensions?.EXT_meshopt_compression;
    const start = ext?.byteOffset ?? view.byteOffset ?? 0, length = ext?.byteLength ?? view.byteLength;
    digest.update(bin.subarray(start, start + length));
  }
  return digest.digest('hex');
}
const geometryBefore = geometryHash(g, binary);
function chunks(png) {
  const out = [];
  for (let p = 8; p < png.length;) { const n = png.readUInt32BE(p); out.push({ type: png.toString('ascii', p + 4, p + 8), data: png.subarray(p + 8, p + 8 + n) }); p += n + 12; }
  return out;
}
function decode(png) {
  const c = chunks(png), header = c.find(c => c.type === 'IHDR').data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[header[9]];
  if (header[8] !== 8 || header[12] !== 0 || !channels) return null;
  const packed = inflateSync(Buffer.concat(c.filter(c => c.type === 'IDAT').map(c => c.data)));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    if (filter > 4) throw Error('Unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= channels ? pixels[at - channels] : 0, up = y ? pixels[at - stride] : 0, corner = y && x >= channels ? pixels[at - stride - channels] : 0;
      pixels[at] = (packed[y * (stride + 1) + 1 + x] + [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter]) & 255;
    }
  }
  return { width, height, channels, pixels, header, chunks: c };
}
function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([head, name, data, tail]); }
function uniformPNG(decoded) {
  const header = Buffer.from(decoded.header); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  // Retain colour metadata verbatim. Detail-bearing pictures are byte-for-byte untouched.
  const metadata = decoded.chunks.filter(c => ['sRGB', 'gAMA', 'cHRM', 'iCCP', 'tRNS'].includes(c.type));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...metadata.map(c => chunk(c.type, c.data)), chunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), decoded.pixels.subarray(0, decoded.channels)]), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sampled = g.images.map(() => new Set());
const use = (info, channels) => { if (info?.index !== undefined) for (const channel of channels) sampled[g.textures[info.index].source].add(channel); };
for (const material of g.materials) {
  use(material.pbrMetallicRoughness?.baseColorTexture, [0,1,2,3]);
  use(material.pbrMetallicRoughness?.metallicRoughnessTexture, [1,2]);
  use(material.normalTexture, [0,1,2]); use(material.occlusionTexture, [0]); use(material.emissiveTexture, [0,1,2]);
  const clearcoat = material.extensions?.KHR_materials_clearcoat;
  use(clearcoat?.clearcoatTexture, [0]); use(clearcoat?.clearcoatRoughnessTexture, [1]); use(clearcoat?.clearcoatNormalTexture, [0,1,2]);
  const specular = material.extensions?.KHR_materials_specular;
  use(specular?.specularTexture, [3]); use(specular?.specularColorTexture, [0,1,2]);
  for (const name of Object.keys(material.extensions ?? {})) if (!['KHR_materials_clearcoat', 'KHR_materials_specular'].includes(name)) throw Error(`Unaudited material extension: ${name}`);
}
const component = (decoded, at, channel) => {
  if (decoded.channels >= 3) return channel < decoded.channels ? decoded.pixels[at + channel] : 255;
  return channel === 3 ? decoded.channels === 2 ? decoded.pixels[at + 1] : 255 : decoded.pixels[at];
};
const replacements = new Map(), records = [];
for (const [index, image] of g.images.entries()) {
  const view = g.bufferViews[image.bufferView], bytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const decoded = image.mimeType === 'image/png' ? decode(bytes) : null;
  let uniform = !!decoded;
  if (decoded) for (let i = decoded.channels; i < decoded.pixels.length; i++) if (decoded.pixels[i] !== decoded.pixels[i % decoded.channels]) { uniform = false; break; }
  const channels = [...sampled[index]];
  let sampledConstant = !!decoded && channels.length > 0;
  if (decoded) outer: for (let at = decoded.channels; at < decoded.pixels.length; at += decoded.channels) for (const channel of channels) if (component(decoded, at, channel) !== component(decoded, 0, channel)) { sampledConstant = false; break outer; }
  const collapsible = uniform || sampledConstant;
  let next = bytes;
  if (collapsible && decoded.width * decoded.height > 1) {
    next = uniformPNG(decoded);
    const verify = decode(next);
    if (!verify || !verify.pixels.equals(decoded.pixels.subarray(0, decoded.channels))) throw Error('Uniform pixel mismatch');
  }
  replacements.set(image.bufferView, next);
  records.push({ index, name: image.name, before: decoded ? [decoded.width, decoded.height] : null, after: collapsible ? [1, 1] : decoded ? [decoded.width, decoded.height] : null, uniform, sampledConstant, sampledChannels: channels, constantPixel: collapsible ? [...decoded.pixels.subarray(0, decoded.channels)] : undefined, bytesBefore: bytes.length, bytesAfter: next.length, hashBefore: hash(bytes), hashAfter: hash(next), protected: !collapsible });
}
const parts = []; let offset = 0;
function append(bytes) { const pad = (4 - offset % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; } const at = offset; parts.push(bytes); offset += bytes.length; return at; }
const imageOffsets = new Map();
for (const [index, v] of g.bufferViews.entries()) {
  const ext = v.extensions?.EXT_meshopt_compression;
  if (ext) {
    const bytes = binary.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    ext.byteOffset = append(bytes); // Compressed geometry is copied without decoding/re-encoding.
  } else if (v.buffer === 0) {
    const bytes = replacements.get(index) ?? binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    const key = replacements.has(index) ? hash(bytes) : null;
    v.byteOffset = key && imageOffsets.has(key) ? imageOffsets.get(key) : append(bytes);
    if (key) imageOffsets.set(key, v.byteOffset);
    v.byteLength = bytes.length;
  }
}
// Share a source image as well as bytes, preventing redundant browser image/GPU allocations.
const sources = new Map();
for (const texture of g.textures) {
  const image = g.images[texture.source], bytes = replacements.get(image.bufferView), key = hash(bytes);
  if (sources.has(key)) texture.source = sources.get(key); else sources.set(key, texture.source);
}
const body = Buffer.concat(parts); g.buffers[0].byteLength = body.length;
const geometryAfter = geometryHash(g, body);
if (geometryBefore !== geometryAfter) throw Error('Geometry/materials changed; refusing to write the model');
const json = Buffer.from(JSON.stringify(g)), jp = Buffer.alloc((4 - json.length % 4) % 4, 32), bp = Buffer.alloc((4 - body.length % 4) % 4), head = Buffer.alloc(20), bh = Buffer.alloc(8);
head.writeUInt32LE(0x46546c67); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + json.length + jp.length + body.length + bp.length, 8); head.writeUInt32LE(json.length + jp.length, 12); head.writeUInt32LE(0x4e4f534a, 16); bh.writeUInt32LE(body.length + bp.length); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(output, Buffer.concat([head, json, jp, bh, body, bp]));
const pixels = r => (r?.[0] ?? 0) * (r?.[1] ?? 0);
const report = { bytesBefore: b.length, bytesAfter: fs.statSync(output).size, fileHashBefore, fileHashAfter: hash(fs.readFileSync(output)), geometryBefore, geometryAfter, pixelsBefore: records.reduce((n, r) => n + pixels(r.before), 0), pixelsAfter: records.reduce((n, r) => n + pixels(r.after), 0), uniformTextures: records.filter(r => r.uniform).length, constantSampledTextures: records.filter(r => r.sampledConstant).length, untouchedDetailedTextures: records.filter(r => r.protected).length, records };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, records: undefined }, null, 2));
