import * as THREE from 'three';
import type { MiamiPlacement } from './layout';

/** Only island silhouettes, not downtown frontage. The floor-rounded close window
 * can include [-200,700]m; every one of those placements remains completely opaque.
 * Admission/removal happen beyond the zero-coverage ends, never at a visible edge. */
// End the rear fade within the simulation's 300m road retention, not just a
// generously preloaded art/teleport fixture. No simulation range change is needed.
export const MIAMI_SKYLINE = { behind: 300, ahead: 1000, fullBehind: 200, fullAhead: 700 } as const;
export const isMiamiSkyline = (p: MiamiPlacement): boolean => p.prototype.startsWith('tower_') && Math.abs(p.d) >= 250;
export function miamiSkylineCoverage(distance: number): number {
  const smooth = (a: number, b: number, x: number) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  return smooth(-MIAMI_SKYLINE.behind, -MIAMI_SKYLINE.fullBehind, distance)
    * (1 - smooth(MIAMI_SKYLINE.fullAhead, MIAMI_SKYLINE.ahead, distance));
}

/** Per-prototype instance metadata, shared by its parts and colour/depth variants.
 * Borrow geometry/maps unchanged. Only these small textures/materials are owned.
 * Player movement updates one uniform, not instance buffers or texture uploads. */
export class MiamiSkyline {
  readonly slots: THREE.DataTexture;
  readonly player = { value: 0 };
  private readonly materials = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  readonly depth: THREE.MeshDepthMaterial;

  constructor(capacity: number) {
    this.slots = new THREE.DataTexture(new Float32Array(capacity * 2), capacity, 1, THREE.RGFormat, THREE.FloatType);
    this.slots.name = 'miami/skyline-slots'; this.slots.needsUpdate = true;
    this.depth = this.patch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  }

  material(source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    let material = this.materials.get(source);
    if (!material) { material = this.patch(source.clone()); this.materials.set(source, material); }
    return material;
  }

  set(index: number, along: number, skyline: boolean): void {
    const data = this.slots.image.data as Float32Array;
    data[index * 2] = along; data[index * 2 + 1] = skyline ? 1 : 0;
  }

  private patch<T extends THREE.Material>(material: T): T {
    material.customProgramCacheKey = () => 'miami-skyline-coverage-v1';
    material.onBeforeCompile = shader => {
      shader.uniforms.miamiSkylineSlots = { value: this.slots }; shader.uniforms.miamiPlayerS = this.player;
      shader.vertexShader = `uniform sampler2D miamiSkylineSlots;
uniform float miamiPlayerS;
varying float vMiamiSkylineCoverage;
${shader.vertexShader}`.replace('void main() {', `void main() {
  vec2 miamiSlot = texelFetch(miamiSkylineSlots, ivec2(gl_InstanceID, 0), 0).rg;
  float miamiDistance = miamiSlot.x - miamiPlayerS;
  vMiamiSkylineCoverage = mix(1.0,
    smoothstep(-${MIAMI_SKYLINE.behind}.0, -${MIAMI_SKYLINE.fullBehind}.0, miamiDistance)
    * (1.0 - smoothstep(${MIAMI_SKYLINE.fullAhead}.0, ${MIAMI_SKYLINE.ahead}.0, miamiDistance)), miamiSlot.y);`);
      // Opaque coverage, not alpha blending: keep normal depth/ghost ordering. Use
      // the same coverage in the shadow pass so an invisible tower cannot cast.
      shader.fragmentShader = `varying float vMiamiSkylineCoverage;
${shader.fragmentShader}`.replace('void main() {', `void main() {
  float miamiNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (vMiamiSkylineCoverage < 1.0 && vMiamiSkylineCoverage <= miamiNoise) discard;`);
    };
    return material;
  }

  dispose(): void {
    this.materials.forEach(m => m.dispose()); this.materials.clear(); this.depth.dispose(); this.slots.dispose();
  }
}
