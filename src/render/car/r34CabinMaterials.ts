import * as THREE from 'three';

/** R34-only resources. Nothing here borrows a material from the exterior or another car. */
export type CabinFinish = 'dash' | 'leather' | 'suede' | 'carpet' | 'carbon' | 'metal' | 'plastic' | 'black' | 'seam' | 'red' | 'glass' | 'atlas' | 'needle' | 'webbing';
export type CabinMaterials = Record<CabinFinish, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>;
type RGB = readonly [number, number, number];

// A deliberately small raster font: deterministic, sharp at grazing angles and usable in Node.
const FONT: Record<string, string> = {
  '0':'01110/10001/10011/10101/11001/10001/01110', '1':'00100/01100/00100/00100/00100/00100/01110',
  '2':'01110/10001/00001/00010/00100/01000/11111', '3':'11110/00001/00001/01110/00001/00001/11110',
  '4':'00010/00110/01010/10010/11111/00010/00010', '5':'11111/10000/10000/11110/00001/00001/11110',
  '6':'01110/10000/10000/11110/10001/10001/01110', '7':'11111/00001/00010/00100/01000/01000/01000',
  '8':'01110/10001/10001/01110/10001/10001/01110', '9':'01110/10001/10001/01111/00001/00001/01110',
  A:'01110/10001/10001/11111/10001/10001/10001', B:'11110/10001/10001/11110/10001/10001/11110',
  C:'01111/10000/10000/10000/10000/10000/01111', D:'11110/10001/10001/10001/10001/10001/11110',
  E:'11111/10000/10000/11110/10000/10000/11111', F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01111', H:'10001/10001/10001/11111/10001/10001/10001',
  I:'01110/00100/00100/00100/00100/00100/01110', J:'00111/00010/00010/00010/00010/10010/01100',
  K:'10001/10010/10100/11000/10100/10010/10001', L:'10000/10000/10000/10000/10000/10000/11111',
  M:'10001/11011/10101/10101/10001/10001/10001', N:'10001/11001/10101/10011/10001/10001/10001',
  O:'01110/10001/10001/10001/10001/10001/01110', P:'11110/10001/10001/11110/10000/10000/10000',
  Q:'01110/10001/10001/10001/10101/10010/01101', R:'11110/10001/10001/11110/10100/10010/10001',
  S:'01111/10000/10000/01110/00001/00001/11110', T:'11111/00100/00100/00100/00100/00100/00100',
  U:'10001/10001/10001/10001/10001/10001/01110', V:'10001/10001/10001/10001/10001/01010/00100',
  W:'10001/10001/10001/10101/10101/10101/01010', X:'10001/10001/01010/00100/01010/10001/10001',
  Y:'10001/10001/01010/00100/00100/00100/00100', Z:'11111/00001/00010/00100/01000/10000/11111',
  '-':'00000/00000/00000/11111/00000/00000/00000', '.':'00000/00000/00000/00000/00000/00110/00110',
  ':':'00000/00110/00110/00000/00110/00110/00000', '/':'00001/00010/00010/00100/01000/01000/10000',
  '+':'00000/00100/00100/11111/00100/00100/00000', '%':'11001/11010/00100/00100/01000/10110/00110',
};

/** Pixel coordinates are top-left, independent of browser canvas and installed fonts. */
export class CabinRaster {
  readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) { this.data = new Uint8Array(width * height * 4); }
  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    for (let yy = y0; yy < Math.min(this.height, Math.round(y + h)); yy++) {
      for (let xx = x0; xx < Math.min(this.width, Math.round(x + w)); xx++) {
        const i = (yy * this.width + xx) * 4;
        this.data[i] = color[0]; this.data[i + 1] = color[1]; this.data[i + 2] = color[2]; this.data[i + 3] = 255;
      }
    }
  }
  text(text: string, x: number, y: number, scale = 1, color: RGB = [205, 218, 210]): void {
    for (const c of text.toUpperCase()) {
      const glyph = FONT[c];
      if (glyph) glyph.split('/').forEach((row, j) => {
        for (let i = 0; i < row.length; i++) if (row[i] === '1') this.rect(x + i * scale, y + j * scale, scale, scale, color);
      });
      x += 6 * scale;
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, color: RGB, thickness = 1): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) this.rect(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, thickness, thickness, color);
  }
  texture(dynamic = false): THREE.DataTexture {
    const t = new THREE.DataTexture(this.data, this.width, this.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = true;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = dynamic ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = !dynamic;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }
}

const WHITE: RGB = [221, 225, 213], RED: RGB = [222, 49, 42];
export const CABIN_DIAL_RECTS = [[0, 0, 256, 256], [256, 0, 256, 256], [512, 0, 256, 256]] as const;
export const CABIN_LABELS = ['GT-R', 'SKYLINE', '1 3 5 / 2 4 6 R', 'AUTO  A/C', 'FM  89.1  STEREO', 'NISSAN  SRS', 'VOL  TUNE', 'MODE  SET  RETURN'] as const;
export const cabinLabelRect = (i: number): readonly [number, number, number, number] => {
  if (i === 2) return [873, 66, 46, 28];
  const width = CABIN_LABELS[i].length * 12 + 12;
  return [896 - width / 2, i * 32 + 4, width, 24];
};

function gaugeAtlas(): THREE.DataTexture {
  const r = new CabinRaster(1024, 512);
  r.rect(0, 0, 1024, 512, [12, 15, 18]);
  const labels = ['KM/H', 'RPM X1000', 'BOOST BAR'];
  for (let dial = 0; dial < 3; dial++) {
    const cx = dial * 256 + 128, cy = 128;
    const ticks = dial === 0 ? 40 : dial === 1 ? 50 : 30;
    for (let i = 0; i <= ticks; i++) {
      const a = (225 - i * 270 / ticks) * Math.PI / 180;
      const major = i % 5 === 0, radius = major ? 91 : 99;
      const color = dial === 1 && i >= 40 ? RED : WHITE;
      r.line(cx + Math.cos(a) * radius, cy - Math.sin(a) * radius, cx + Math.cos(a) * 111, cy - Math.sin(a) * 111, color, major ? 2 : 1);
      if (major) {
        const value = dial === 0 ? String(i * 8) : dial === 1 ? String(i / 5) : (i * 0.1 - 1).toFixed(1);
        const px = cx + Math.cos(a) * 76 - value.length * 5;
        const py = cy - Math.sin(a) * 76 - 6;
        r.text(value, px, py, dial === 2 ? 1 : 2, color);
      }
    }
    r.text(labels[dial], cx - labels[dial].length * 3, 165, 1, WHITE);
    r.text(dial === 1 ? 'GT-R' : 'NISMO', cx - 24, 96, 2, dial === 1 ? RED : WHITE);
  }
  CABIN_LABELS.forEach((label, i) => {
    r.rect(768, i * 32, 256, 32, [19, 23, 26]);
    if (i === 2) {
      r.text('1 3 5', 880, 68, 1, WHITE);
      r.text('2 4 6', 880, 85, 1, WHITE);
      r.text('R', 914, 85, 1, RED);
      r.line(882, 80, 906, 80, WHITE);
      for (const x of [882, 894, 906]) r.line(x, 76, x, 83, WHITE);
    } else if (i === 0) {
      r.text('GT-', 872, 9, 2, WHITE);
      r.text('R', 908, 9, 2, RED);
    } else r.text(label, 896 - label.length * 6, i * 32 + 9, 2, WHITE);
  });
  const t = r.texture(); t.name = 'R34 immutable dial / switch lettering atlas';
  return t;
}

function grain(kind: 'leather' | 'suede' | 'carbon' | 'metal' | 'carpet'): THREE.DataTexture {
  const r = new CabinRaster(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const hash = Math.imul(x + 137, 374761393) ^ Math.imul(y + 59, 668265263);
    const noise = ((Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 16) & 255) / 255;
    let v: number;
    if (kind === 'carbon') {
      const weave = ((x >> 3) + (y >> 3)) % 2;
      v = 73 + (weave ? x % 8 : y % 8) * 9 + noise * 14;
    } else if (kind === 'metal') v = 166 + noise * 30 + Math.sin(y * 9.1) * 15;
    else if (kind === 'leather') v = 167 + noise * 58 - ((x + y * 3) % 19 < 2 ? 34 : 0);
    else if (kind === 'carpet') v = 105 + noise * 95 + Math.sin(x * 5 + y * 7) * 19;
    else v = 159 + noise * 72;
    r.rect(x, y, 1, 1, [v, v, v]);
  }
  const t = r.texture();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(kind === 'carbon' ? 5 : 9, kind === 'carbon' ? 5 : 9);
  t.name = `R34 immutable ${kind} grain`;
  return t;
}

/** Normal and roughness data stay linear. Reusing a colour-space albedo as a
 * bump map made the previous leather sparkle like coarse sand under streetlights. */
function microfinish(source: THREE.DataTexture, kind: string): { normal: THREE.DataTexture; rough: THREE.DataTexture } {
  const data = source.image.data as Uint8Array, size = source.image.width;
  const normal = new Uint8Array(data.length), rough = new Uint8Array(data.length);
  const h = (x: number, y: number) => data[(((y + size) % size) * size + (x + size) % size) * 4] / 255;
  const strength = kind === 'metal' ? 0.12 : kind === 'carpet' ? 0.7 : 0.32;
  const base = kind === 'metal' ? 145 : kind === 'carbon' ? 162 : kind === 'leather' ? 195 : 238;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const nx = (h(x - 1, y) - h(x + 1, y)) * strength, ny = (h(x, y - 1) - h(x, y + 1)) * strength;
    const len = Math.hypot(nx, ny, 1);
    normal.set([128 + nx / len * 127, 128 + ny / len * 127, 128 + 127 / len, 255], i);
    const r = base + (h(x, y) - 0.7) * 26;
    rough.set([r, r, r, 255], i);
  }
  const texture = (pixels: Uint8Array, name: string) => {
    const t = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.copy(source.repeat); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.needsUpdate = true; t.name = `R34 immutable ${kind} ${name}`;
    return t;
  };
  return { normal: texture(normal, 'normal'), rough: texture(rough, 'roughness') };
}

type GrainKind = 'leather' | 'suede' | 'carpet' | 'carbon' | 'metal';
let shared: Record<GrainKind | 'atlas', THREE.DataTexture> | undefined;
let micro: Record<GrainKind, ReturnType<typeof microfinish>> | undefined;

/** Module-lifetime immutable maps; an instance only owns and disposes its private materials. */
export function acquireCabinMaterials(): { materials: CabinMaterials; release(): void } {
  shared ??= { leather: grain('leather'), suede: grain('suede'), carpet: grain('carpet'), carbon: grain('carbon'), metal: grain('metal'), atlas: gaugeAtlas() };
  const maps = shared;
  micro ??= Object.fromEntries((['leather', 'suede', 'carpet', 'carbon', 'metal'] as const).map(kind => [kind, microfinish(maps[kind], kind)])) as Record<GrainKind, ReturnType<typeof microfinish>>;
  const standard = (color: number, roughness: number, kind?: GrainKind, metalness = 0) => new THREE.MeshStandardMaterial({
    color, roughness, metalness, map: kind ? maps[kind] : null,
    normalMap: kind ? micro![kind].normal : null, normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: kind ? micro![kind].rough : null, emissive: 0x060709, envMapIntensity: 0.4,
  });
  const materials: CabinMaterials = {
    dash: standard(0x25272a, 1, 'leather'), leather: standard(0x27292d, 0.9, 'leather'),
    suede: standard(0x303138, 1, 'suede'), carpet: standard(0x26272b, 1, 'carpet'),
    carbon: standard(0x454950, 0.58, 'carbon', 0.3), metal: standard(0x8b9099, 0.65, 'metal', 0.82),
    plastic: standard(0x2c2f35, 0.9, 'leather'), black: standard(0x0d1013, 0.9), seam: standard(0x484a50, 0.95),
    webbing: standard(0x15181c, 1, 'carpet'),
    red: standard(0x9d1726, 0.62), glass: standard(0x455963, 0.14, undefined, 0.95),
    atlas: new THREE.MeshBasicMaterial({ map: maps.atlas, color: 0xffffff, toneMapped: false }),
    needle: new THREE.MeshBasicMaterial({ color: 0xff442b, toneMapped: false }),
  };
  // Two-sided trim is narrow local geometry, never a windscreen-sized opaque sheet.
  materials.suede.side = THREE.DoubleSide;
  materials.carpet.side = THREE.DoubleSide;
  materials.webbing.side = THREE.DoubleSide;
  let released = false;
  return { materials, release() {
    if (released) return;
    released = true;
    Object.values(materials).forEach(m => m.dispose());
    // Like the other model geometry caches, immutable maps survive car switches and remotes.
    // Never dispose a shared texture from a PlayerView/cabin instance.
  } };
}
