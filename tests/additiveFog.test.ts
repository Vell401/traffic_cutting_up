import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoadView } from '../src/render/roadView';
import { Sparks } from '../src/render/sparks';
import { QUALITY } from '../src/settings';
import { renderDocument } from './renderCanvas';

beforeEach(() => vi.stubGlobal('document', renderDocument));
afterEach(() => vi.unstubAllGlobals());

it.each(['pools', 'sparks'])('%s attenuate additive contribution, never inject fog colour, with unchanged near-field HDR/alpha', kind => {
  const road = new RoadView({ ...QUALITY.medium, roadTex: 64 }, 4, 'miami');
  const sparks = new Sparks();
  const material = kind === 'pools' ? (road as unknown as { mats: { pools: THREE.MeshBasicMaterial } }).mats.pools : sparks.points.material as THREE.PointsMaterial;
  const shader = { vertexShader: '', fragmentShader: '#include <fog_fragment>', uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  expect(material.fog).toBe(true); expect(material.blending).toBe(THREE.AdditiveBlending); expect(material.premultipliedAlpha).toBe(false);
  // Inspect the actual shader output at Three's compile boundary, not an unused CPU helper.
  const fragment = shader.fragmentShader;
  expect(fragment).toContain('FOG_EXP2'); expect(fragment).toContain('smoothstep( fogNear, fogFar, vFogDepth )');
  expect(fragment).not.toContain('fogColor');
  const expression = fragment.match(/gl_FragColor\.a\s*\*=\s*([^;]+);/)?.[1];
  expect(expression).toBeDefined();
  const attenuation = new Function('fogFactor', `return ${expression};`) as (f: number) => number;
  for (const fog of [[0,0,0], [.008,.033,.058], [.8,.3,.9]]) for (const light of [[0,0,0], [4.5,2.1,.6]]) {
    for (const factor of [0,.2,.5,1]) for (const alpha of [0,.25,1]) {
      const added = light.map(c => c * alpha * attenuation(factor));
      expect(added).toEqual(light.map(c => c * alpha * (1 - factor)));
      if (factor === 1) expect(fog.map((c,i) => c + added[i])).toEqual(fog);
    }
  }
  road.dispose(); sparks.points.geometry.dispose(); material.dispose();
});
