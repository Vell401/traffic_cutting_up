import * as THREE from 'three';
import { MOON_DIR } from './sky';
import type { MapTheme } from './miami';

/**
 * Night city facades without textures: windows come from a procedural grid in facade metres
 * (aWin.xy), lit or dark by a hash of the cell and the building seed (aWin.z), with a per-building
 * lit share (aWin.w; negative = roof, no windows). Lit windows punch through the fog a little,
 * so the skyline reads as distant city lights.
 */
export function makeCityMaterial(theme: MapTheme = 'highway'): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { moonDir: { value: MOON_DIR }, coastal: { value: theme === 'miami' ? 1 : 0 } }]),
    vertexShader: /* glsl */ `
      attribute vec4 aWin;
      attribute vec3 color;
      varying vec4 vWin;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vFogDepth;
      void main() {
        vWin = aWin;
        vColor = color;
        vNormal = normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 fogColor;
      uniform float fogNear;
      uniform float fogFar;
      uniform vec3 moonDir;
      uniform float coastal;
      varying vec4 vWin;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vFogDepth;

      // Sine-free hash (Dave Hoskins): stable for large inputs, no per-pixel sparkle.
      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        float shade = 0.55 + 0.45 * max(dot(normalize(vNormal), moonDir), 0.0);
        vec3 col = vColor * shade;
        float lit = 0.0;
        if (vWin.w >= 0.0) {
          float seed = floor(vWin.z + 0.5);
          vec2 g = vWin.xy / vec2(3.2, 3.5);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.78);
          float h = hash(cell + seed * 13.17);
          lit = win * step(h, vWin.w) * step(1.0, vWin.y);
          vec3 warm = vec3(1.0, 0.68, 0.38);
          vec3 cool = vec3(0.7, 0.82, 1.0);
          vec3 wc = mix(warm, cool, step(0.72 + coastal * 0.2, hash(cell.yx * 1.31 + seed)));
          float bright = 0.5 + 1.1 * hash(cell * 1.7 + seed * 3.1);
          col = mix(col, vColor * 0.4 + vec3(0.015), win * (1.0 - lit));
          col += wc * bright * lit * 1.4;
        }
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
        col = mix(col, fogColor, fogF * (1.0 - 0.55 * lit));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
