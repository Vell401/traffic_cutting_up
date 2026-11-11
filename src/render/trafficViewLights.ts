import * as THREE from 'three';

export interface TrafficLamp {
  position: THREE.Vector3;
  width: number;
  height: number;
  /** 1 head halo, 2 tail halo, 3 rear asphalt wash. */
  role: 1 | 2 | 3;
}

export const TRAFFIC_LIGHTING = {
  instancesPerCar: 5, washY: .06, washFadeStart: 45, washFadeEnd: 85, haloFadeStart: 150, haloFadeEnd: 220,
  // Linear RGB and peak alpha: a faint road tint even at night, not a second luminous lens.
  washTail: [.14, .003, .001], washBrake: [.42, .009, .002], washOpacity: .18,
} as const;

/** Read semantic lens bounds once. Segmented optics share a halo; the two rear lamps share one road wash. */
export function trafficLampLayout(geometry: THREE.BufferGeometry): TrafficLamp[] {
  const p = geometry.getAttribute('position'), roles = geometry.getAttribute('partRole');
  const lamps: TrafficLamp[] = [], point = new THREE.Vector3();
  for (const role of [1, 2] as const) for (const side of [-1, 1]) {
    const bounds = new THREE.Box3();
    for (let i = 0; i < p.count; i++) {
      if (roles.getX(i) === role && p.getX(i) * side > 0) bounds.expandByPoint(point.fromBufferAttribute(p, i));
    }
    if (bounds.isEmpty()) continue;
    const position = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    // Outside the lens, not inside the fascia: normal depth testing can occlude it correctly.
    position.z = role === 1 ? bounds.min.z - .018 : bounds.max.z + .018;
    lamps.push({ position, width: THREE.MathUtils.clamp(size.x * 1.9, .28, .9), height: THREE.MathUtils.clamp(size.y * 2.8, .24, .65), role });
  }
  const tails = lamps.filter(lamp => lamp.role === 2);
  if (tails.length) {
    const rear = Math.max(...tails.map(lamp => lamp.position.z));
    const left = Math.min(...tails.map(lamp => lamp.position.x)), right = Math.max(...tails.map(lamp => lamp.position.x));
    lamps.push({
      position: new THREE.Vector3((left + right) / 2, TRAFFIC_LIGHTING.washY, rear + .85),
      width: THREE.MathUtils.clamp(right - left + .8, 1.5, 2.6), height: 2.2, role: 3,
    });
  }
  return lamps;
}

/** One shared instanced pass. No textures, per-car meshes, dynamic lights or shadow maps. */
export function trafficGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic directional lens glow / asphalt wash',
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
    toneMapped: false, fog: true,
    vertexShader: `
      attribute vec2 trafficLampState;
      varying vec2 vGlowUv;
      varying vec3 vGlowColor;
      varying float vGlowVisibility;
      varying float vGroundWash;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float head = 1.0 - step(1.5, trafficLampState.x);
        vGroundWash = step(2.5, trafficLampState.x);
        vec3 forward = mat3(modelViewMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, mix(1.0, -1.0, head));
        float facing = dot(normalize(forward), normalize(-mvPosition.xyz));
        vGlowVisibility = smoothstep(.03, .65, facing) * (1.0 - smoothstep(${TRAFFIC_LIGHTING.haloFadeStart.toFixed(1)}, ${TRAFFIC_LIGHTING.haloFadeEnd.toFixed(1)}, length(mvPosition.xyz)));
        vGlowColor = head > .5 ? vec3(2.2, 2.05, 1.8) : mix(vec3(2.4, .025, .012), vec3(7.5, .08, .025), trafficLampState.y);
        if (vGroundWash > .5) {
          // A true horizontal decal, never a camera-facing red card. Normal depth testing hides it
          // beneath cars/walls; the road is flat at y=0 and the tiny lift prevents z fighting.
          vec3 up = mat3(modelViewMatrix) * mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0);
          float elevation = dot(normalize(up), normalize(-mvPosition.xyz));
          vGlowVisibility = smoothstep(.015, .12, elevation) * (1.0 - smoothstep(${TRAFFIC_LIGHTING.washFadeStart.toFixed(1)}, ${TRAFFIC_LIGHTING.washFadeEnd.toFixed(1)}, length(mvPosition.xyz)));
          vGlowColor = mix(vec3(${TRAFFIC_LIGHTING.washTail.join(', ')}), vec3(${TRAFFIC_LIGHTING.washBrake.join(', ')}), trafficLampState.y);
          mvPosition = modelViewMatrix * instanceMatrix * vec4(position.x, 0.0, -position.y, 1.0);
        } else {
          // Billboard only the optical halo; the opaque lens stays on the authored fascia.
          vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
          mvPosition.xy += position.xy * size;
        }
        vGlowUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      varying vec2 vGlowUv;
      varying vec3 vGlowColor;
      varying float vGlowVisibility;
      varying float vGroundWash;
      #include <fog_pars_fragment>
      void main() {
        float r = length(vGlowUv);
        float halo = pow(1.0 - smoothstep(0.0, 1.0, r), 3.0) * .32 + exp(-r * r * 24.0) * .18;
        float wash = pow(1.0 - smoothstep(0.0, 1.0, r), 2.0) * ${TRAFFIC_LIGHTING.washOpacity};
        float profile = mix(halo, wash, vGroundWash);
        float alpha = profile * vGlowVisibility;
        // Additive fog must fade to zero, not add a luminous fog-coloured rectangle.
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            alpha *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
          #endif
        #endif
        if (alpha < .002) discard;
        gl_FragColor = vec4(vGlowColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}
