import * as THREE from 'three';
import { clamp } from '../../core/math';
import { AXLES, F_RW, F_WS, baseY, pillarLines, railX, railY, rearWindowMargin, sideGlassMargin, windshieldMargin } from './r34Shape';

/*
 * Livery atlas: one mask texture shared by every R34, coloured per car in the paint shader.
 *   R  stripe colour (blue on ours, the driver's colour online)
 *   G  white pinstripes
 *   B  black: 1 glass, ~0.88 black trim (window frames, cowl, B-pillar), ~0.6 panel gaps
 *
 * Regions (u right, v down; flipY off):
 *   TOP    u 0..0.84 ↔ f, v 0..0.5 ↔ |x|   hood, roof, deck, windshield, rear window
 *   SIDE   u 0..0.84 ↔ f, v 0.5..1 ↔ y     flanks, side glass
 *   FRONT  u 0.84..1 ↔ |x|, v 0.5..1 ↔ y   front bumper face
 *   REAR   u 0.84..1 ↔ |x|, v 0..0.5 ↔ y   rear face
 */
const AW = 2048;
const AH = 1024;
const U_SPLIT = 0.84;
const F_MIN = -2.34;
const F_SPAN = 4.68;
const X_SPAN = 0.95;
const Y_SPAN = 1.45;
const FACE_X = 0.82;

export const uvTop = (f: number, x: number): [number, number] => [((f - F_MIN) / F_SPAN) * U_SPLIT, (Math.abs(x) / X_SPAN) * 0.5];
export const uvSide = (f: number, y: number): [number, number] => [((f - F_MIN) / F_SPAN) * U_SPLIT, 0.5 + (y / Y_SPAN) * 0.5];
export const uvFront = (x: number, y: number): [number, number] => [U_SPLIT + (Math.abs(x) / FACE_X) * (1 - U_SPLIT), 0.5 + (y / Y_SPAN) * 0.5];
export const uvRear = (x: number, y: number): [number, number] => [U_SPLIT + (Math.abs(x) / FACE_X) * (1 - U_SPLIT), (y / Y_SPAN) * 0.5];
/** A pixel nothing is drawn on: plain body colour for small painted parts (mirrors, wing). */
export const UV_PLAIN: [number, number] = uvTop(0, 0.93);

type Pt = [number, number];

function makeAtlas(): THREE.DataTexture {
  const layer = () => {
    const cv = document.createElement('canvas');
    cv.width = AW;
    cv.height = AH;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, AW, AH);
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    return { cv, g };
  };
  const R = layer();
  const G = layer();
  const gaps = layer();
  const px = ([u, v]: [number, number]): Pt => [u * AW, v * AH];
  const poly = (g: CanvasRenderingContext2D, pts: Pt[], stroke = 0, open = false) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (!open) g.closePath();
    if (stroke > 0) {
      g.lineWidth = stroke;
      g.stroke();
    } else g.fill();
  };
  const pxPerM = (AW * U_SPLIT) / F_SPAN;
  const top = (f: number, x: number) => px(uvTop(f, x));
  const side = (f: number, y: number) => px(uvSide(f, y));
  const front = (x: number, y: number) => px(uvFront(x, y));
  const rect = (map: (a: number, b: number) => Pt, a0: number, b0: number, a1: number, b1: number): Pt[] => [map(a0, b0), map(a1, b0), map(a1, b1), map(a0, b1)];

  // Twin stripes nose to tail over hood, roof and deck, with a thin white line outside each.
  poly(R.g, rect(top, -2.25, 0.05, 2.33, 0.25));
  poly(G.g, rect(top, -2.25, 0.262, 2.33, 0.274));
  // ...and down the bumper face to a blue lower lip.
  poly(R.g, rect(front, 0.05, 0, 0.25, 0.7));
  poly(G.g, rect(front, 0.262, 0, 0.274, 0.7));
  poly(R.g, rect(front, 0, 0, 0.9, 0.205));

  // Flanks: a blue sill band and blades sweeping up and back, outlined in white.
  const [fFront, fRear] = [AXLES[0] - 0.39, AXLES[1] + 0.39];
  const shapes: [number, number][][] = [
    [[fFront + 0.05, 0.0], [fFront + 0.05, 0.27], [fRear, 0.33], [fRear, 0.0]],
    [[2.4, 0.0], [2.4, 0.3], [AXLES[0] + 0.3, 0.3], [AXLES[0] + 0.3, 0.0]],
    [[AXLES[1] - 0.36, 0.0], [AXLES[1] - 0.36, 0.33], [-2.4, 0.35], [-2.4, 0.0]],
  ];
  for (let k = 0; k < 4; k++) {
    const f0 = 0.84 - k * 0.38;
    shapes.push([[f0, 0.27 + k * 0.012], [f0 - 0.6, 0.62 - k * 0.035], [f0 - 0.17, 0.28 + k * 0.014]]);
  }
  shapes.push([[AXLES[1] - 0.36, 0.33], [-2.28, 0.6], [AXLES[1] - 0.52, 0.335]]);
  for (const s of shapes) poly(R.g, s.map(([f, y]) => side(f, y)));
  G.g.globalCompositeOperation = 'source-over';
  for (const s of shapes.slice(3)) poly(G.g, s.map(([f, y]) => side(f, y)), 0.012 * pxPerM);
  // Blue only inside the outline: white ring around the blades, the blade itself stays blue.
  for (const s of shapes.slice(3)) {
    G.g.save();
    G.g.fillStyle = '#000';
    G.g.beginPath();
    s.map(([f, y]) => side(f, y)).forEach(([x, y], i) => (i ? G.g.lineTo(x, y) : G.g.moveTo(x, y)));
    G.g.closePath();
    G.g.fill();
    G.g.restore();
  }
  poly(G.g, [side(fFront + 0.05, 0.27), side(fRear, 0.33), side(fRear, 0.344), side(fFront + 0.05, 0.284)]);

  // Panel gaps: hood, trunk lid, doors; door handle recess.
  gaps.g.strokeStyle = '#999';
  const gw = 0.004 * pxPerM;
  poly(gaps.g, [top(2.13, 0), top(2.13, 0.7), top(0.69, 0.7), top(0.69, 0)], gw, true);
  poly(gaps.g, [top(-1.71, 0), top(-1.71, 0.7), top(-2.235, 0.7), top(-2.235, 0)], gw, true);
  poly(gaps.g, [side(0.6, 0.86), side(0.6, 0.275), side(-0.6, 0.275), side(-0.6, 0.93)], gw, true);
  gaps.g.fillStyle = '#b3b3b3';
  poly(gaps.g, rect(side, -0.47, 0.833, -0.33, 0.866));
  // Hood duct.
  gaps.g.fillStyle = '#d9d9d9';
  poly(gaps.g, [top(1.05, 0.08), top(1.42, 0.13), top(1.42, -0.001), top(1.05, -0.001)]);
  // Cowl: black panel between hood and windshield.
  gaps.g.fillStyle = '#e0e0e0';
  poly(gaps.g, rect(top, F_WS - 0.005, -0.001, 0.675, 0.9));
  // Rear: black lower valance, plate recess between the lamps' feet.
  const rear = (x: number, y: number) => px(uvRear(x, y));
  gaps.g.fillStyle = '#e0e0e0';
  poly(gaps.g, rect(rear, -0.001, 0, 0.9, 0.4));
  gaps.g.fillStyle = '#c4c4c4';
  poly(gaps.g, rect(rear, -0.001, 0.47, 0.205, 0.64));

  // Combine, then glass per pixel from the same outlines as the geometry (with a black frame band).
  const out = new Uint8Array(AW * AH * 4);
  const rd = R.g.getImageData(0, 0, AW, AH).data;
  const gd = G.g.getImageData(0, 0, AW, AH).data;
  const bd = gaps.g.getImageData(0, 0, AW, AH).data;
  const pxM = F_SPAN / (AW * U_SPLIT);
  const cover = (m: number) => clamp(m / pxM + 0.5, 0, 1);
  const glass = (m: (inset: number) => number) => {
    const frame = cover(m(-0.012));
    if (frame <= 0) return 0;
    return frame * 0.88 + cover(m(0)) * 0.12;
  };
  // f-only terms per texel column, pillar lines per texel row.
  const cols = Math.ceil(AW * U_SPLIT);
  const colF = new Float64Array(cols);
  const colBase = new Float64Array(cols);
  const colRailY = new Float64Array(cols);
  const colRailX = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    const f = F_MIN + ((c + 0.5) / AW / U_SPLIT) * F_SPAN;
    colF[c] = f;
    if (f < F_WS && f > F_RW) {
      colBase[c] = baseY(f);
      colRailY[c] = railY(f);
      colRailX[c] = railX(f);
    }
  }
  for (let py = 0; py < AH; py++) {
    const v = (py + 0.5) / AH;
    const topRow = v < 0.5;
    const x = (v / 0.5) * X_SPAN;
    const y = ((v - 0.5) / 0.5) * Y_SPAN;
    const aY = topRow ? 0 : pillarLines.a(y);
    const cY = topRow ? 0 : pillarLines.c(y);
    for (let pxi = 0; pxi < AW; pxi++) {
      const i = (py * AW + pxi) * 4;
      let b = bd[i] / 255;
      if (pxi < cols) {
        const f = colF[pxi];
        if (topRow) {
          if (f < F_WS && f > -0.35) b = Math.max(b, glass((k) => windshieldMargin(f, x, k, colRailX[pxi])));
          else if (f < -0.95 && f > F_RW) b = Math.max(b, glass((k) => rearWindowMargin(f, x, k, colRailX[pxi])));
        } else if (y > 0.75 && f < F_WS && f > F_RW) {
          const m = (k: number) => sideGlassMargin(f, y, k, colBase[pxi], colRailY[pxi], aY, cY);
          b = Math.max(b, glass(m));
          // B-pillar: black trim between the door glass and the quarter glass.
          if (Math.abs(f + 0.63) < 0.03 && m(-0.012) > 0) b = Math.min(b, 0.88);
        }
      }
      out[i] = rd[i];
      out[i + 1] = gd[i];
      out[i + 2] = Math.round(b * 255);
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, AW, AH, THREE.RGBAFormat);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

let atlas: THREE.DataTexture | null = null;
/** Built once on first use (≈ 30 ms), shared by every car. */
export function liveryAtlas(): THREE.DataTexture {
  return (atlas ??= makeAtlas());
}

/**
 * Clearcoat paint driven by the atlas: body colour, stripe colour and white pinstripes, glossy black
 * glass and trim (lower roughness, no metal flake).
 */
export function liveryPaint(body: number, stripe: number): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: body,
    metalness: 0.62,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    map: liveryAtlas(),
    // The scene's environment is a lit room: at night a silver car should not mirror a bright ceiling.
    envMapIntensity: 0.7,
  });
  const uStripe = { value: new THREE.Color(stripe) };
  const uPin = { value: new THREE.Color(0xeef1f5) };
  mat.userData.stripe = uStripe.value;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uStripe = uStripe;
    sh.uniforms.uPin = uPin;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uStripe;\nuniform vec3 uPin;')
      .replace(
        '#include <map_fragment>',
        `vec4 lv = texture2D( map, vMapUv );
        diffuseColor.rgb = mix( diffuseColor.rgb, uStripe, lv.r );
        diffuseColor.rgb = mix( diffuseColor.rgb, uPin, lv.g );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.006 ), lv.b );
        float glassK = smoothstep( 0.8, 0.97, lv.b );`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( roughness, 0.07, smoothstep( 0.5, 0.9, lv.b ) );')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix( metalness, 0.0, max( glassK, lv.b * 0.8 ) );')
      // Tinted glass at night: keep the reflections, but not the bright white sheen at grazing angles.
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        material.clearcoat *= 1.0 - 0.8 * glassK;
        material.specularF90 *= 1.0 - 0.55 * glassK;`,
      );
  };
  mat.customProgramCacheKey = () => 'r34-livery';
  return mat;
}

/** Inside of the greenhouse (headliner, pillars): cut out wherever the atlas says glass. */
export function cabinShell(color: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, map: liveryAtlas() });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', 'if ( texture2D( map, vMapUv ).b > 0.95 ) discard;');
  };
  mat.customProgramCacheKey = () => 'r34-shell';
  return mat;
}
