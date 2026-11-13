import * as THREE from 'three';

/** Ordinary fog mixes fogColor into source RGB, which is incorrect for additive light.
 * Keep Three's exact linear/exp2 fog factor and the near-field HDR colour/profile, fading
 * only its contribution to the destination. */
export function additiveFog<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>',
      THREE.ShaderChunk.fog_fragment.replace(
        'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
        'gl_FragColor.a *= 1.0 - fogFactor;',
      ));
  };
  material.customProgramCacheKey = () => 'additive-fog-v1';
  return material;
}
