import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export function readGlb(bytes: Buffer) {
  const length = bytes.readUInt32LE(12);
  return { asset: JSON.parse(bytes.subarray(20, 20 + length).toString()), binary: bytes.subarray(28 + length) };
}

/** Exact 8-bit, non-interlaced PNG decode for verification, never resampling or writing images. */
export function decodePng(png: Buffer) {
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[png[25]];
  if (png[24] !== 8 || png[26] !== 0 || png[27] !== 0 || png[28] !== 0 || !channels) return null;
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (at + 12 + length > png.length) throw new Error('Truncated PNG chunk');
    if (type === 'tRNS') return null; // Do not guess alpha semantics for these uncommon images.
    if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const packed = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  if (packed.length !== height * (stride + 1)) throw new Error('Unexpected PNG raster size');
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    if (filter > 4) throw new Error('Unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels] : 0, up = y ? pixels[at - stride] : 0;
      const corner = y && x >= channels ? pixels[at - stride - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, corner);
      pixels[at] = (packed[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function auditModelTextures(bytes: Buffer) {
  const { asset, binary } = readGlb(bytes);
  const usedMaterials = new Set<number>();
  for (const mesh of asset.meshes ?? []) for (const primitive of mesh.primitives) if (primitive.material !== undefined) usedMaterials.add(primitive.material);
  const uses = new Map<number, string[]>();
  const visit = (object: any, path: string) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      if (key.endsWith('Texture') && (value as any)?.index !== undefined) {
        const index = (value as any).index, list = uses.get(index) ?? [];
        list.push(`${path}.${key}`); uses.set(index, list);
      } else visit(value, `${path}.${key}`);
    }
  };
  for (const index of usedMaterials) visit(asset.materials[index], `${index}:${asset.materials[index].name}`);
  const usedImages = new Set<number>([...uses.keys()].map(index => asset.textures[index].source));
  const decodedGroups = new Map<string, number[]>();
  const images = (asset.images as { bufferView: number; name?: string }[]).map((image, index) => {
    const view = asset.bufferViews[image.bufferView];
    const data = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const decoded = decodePng(data), constants: (number | null)[] = [];
    let decodedHash: string | null = null, greenHash: string | null = null;
    if (decoded) {
      for (let channel = 0; channel < decoded.channels; channel++) {
        const first = decoded.pixels[channel];
        let constant = true;
        for (let at = channel; at < decoded.pixels.length; at += decoded.channels) if (decoded.pixels[at] !== first) { constant = false; break; }
        constants.push(constant ? first : null);
      }
      const rgba = createHash('sha256').update(`${decoded.width}/${decoded.height}/rgba8/`);
      const green = createHash('sha256').update(`${decoded.width}/${decoded.height}/green8/`);
      const row = Buffer.alloc(decoded.width * 4), greenRow = Buffer.alloc(decoded.width);
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 0; x < decoded.width; x++) {
          const at = (y * decoded.width + x) * decoded.channels, dst = x * 4;
          row[dst] = decoded.pixels[at];
          row[dst + 1] = decoded.pixels[at + (decoded.channels >= 3 ? 1 : 0)];
          row[dst + 2] = decoded.pixels[at + (decoded.channels >= 3 ? 2 : 0)];
          row[dst + 3] = decoded.channels === 2 ? decoded.pixels[at + 1] : decoded.channels === 4 ? decoded.pixels[at + 3] : 255;
          greenRow[x] = row[dst + 1];
        }
        rgba.update(row); green.update(greenRow);
      }
      decodedHash = rgba.digest('hex'); greenHash = green.digest('hex');
      const group = decodedGroups.get(decodedHash) ?? []; group.push(index); decodedGroups.set(decodedHash, group);
    }
    return {
      index, name: image.name, used: usedImages.has(index), encodedBytes: data.length, sha256: sha256(data),
      dimensions: decoded ? [decoded.width, decoded.height] : null, channels: decoded?.channels ?? null,
      constants, decodedHash, greenHash,
      textures: [...uses].filter(([texture]) => asset.textures[texture].source === index).map(([texture, uses]) => ({ texture, uses })),
    };
  });
  const constantRoughness = [...usedMaterials].flatMap(index => {
    const material = asset.materials[index], pbr = material.pbrMetallicRoughness;
    if (pbr?.metallicFactor !== 0 || !pbr.metallicRoughnessTexture) return [];
    const texture = asset.textures[pbr.metallicRoughnessTexture.index], image = images[texture.source];
    const green = image.channels && image.channels < 3 ? image.constants[0] : image.constants[1];
    if (green == null || !image.dimensions || image.dimensions[0] * image.dimensions[1] <= 1) return [];
    return [{ material: material.name, texture: pbr.metallicRoughnessTexture.index, image: texture.source, imageName: image.name,
      green, roughnessFactor: pbr.roughnessFactor ?? 1, sha256: image.sha256,
      pixels: image.dimensions[0] * image.dimensions[1] }];
  });
  const roughnessGroups = new Map<string, { material: string; texture: number; image: number; imageName: string; pixels: number }[]>();
  for (const index of usedMaterials) {
    const material = asset.materials[index], pbr = material.pbrMetallicRoughness;
    if (pbr?.metallicFactor !== 0 || !pbr.metallicRoughnessTexture) continue;
    const texture = asset.textures[pbr.metallicRoughnessTexture.index], image = images[texture.source];
    if (!image.greenHash || !image.dimensions) continue;
    const key = `${image.greenHash}/${JSON.stringify(asset.samplers?.[texture.sampler] ?? {})}`;
    const group = roughnessGroups.get(key) ?? [];
    group.push({ material: material.name, texture: pbr.metallicRoughnessTexture.index, image: texture.source,
      imageName: image.name ?? `image-${texture.source}`, pixels: image.dimensions[0] * image.dimensions[1] });
    roughnessGroups.set(key, group);
  }
  return {
    sha256: sha256(bytes), bytes: bytes.length,
    materials: asset.materials.length, usedMaterials: usedMaterials.size,
    textures: asset.textures.length, usedTextures: uses.size,
    images: images.length, usedImages: usedImages.size,
    duplicateDecodedImages: [...decodedGroups.values()].filter(group => group.length > 1),
    duplicateSampledRoughness: [...roughnessGroups.values()].filter(group => new Set(group.map(record => record.image)).size > 1),
    constantRoughness, imageRecords: images,
  };
}
