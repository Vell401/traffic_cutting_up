import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MIAMI_SKYLINE, MiamiSkyline, miamiSkylineCoverage } from '../src/render/miami/skyline';

function shader(material: THREE.Material) {
  const source = { ...THREE.ShaderLib.standard, uniforms: {} };
  material.onBeforeCompile(source as Parameters<THREE.Material['onBeforeCompile']>[0], {} as THREE.WebGLRenderer); return source;
}

describe('bounded opaque island skyline coverage', () => {
  it('is full throughout the floor-rounded close window and continuous at both residency ends', () => {
    for (let d = -200; d <= 700; d++) expect(miamiSkylineCoverage(d)).toBe(1);
    for (const d of [-1000, -301, -300, 1000, 1001, 2000]) expect(miamiSkylineCoverage(d)).toBe(0);
    expect(miamiSkylineCoverage(-250)).toBe(.5); expect(miamiSkylineCoverage(850)).toBe(.5);
    for (let d = -500; d <= 1100; d++) expect(Math.abs(miamiSkylineCoverage(d + 2) - miamiSkylineCoverage(d))).toBeLessThan(.031);
  });
  it('patches matching colour and shadow coverage before loading, without blending or touching source geometry/maps/materials', () => {
    const map = new THREE.Texture(), source = new THREE.MeshStandardMaterial({ map, roughness: .73, metalness: .25 });
    const before = source.onBeforeCompile, skyline = new MiamiSkyline(12), material = skyline.material(source);
    expect(material).not.toBe(source); expect(skyline.material(source)).toBe(material);
    expect(material.map).toBe(map); expect(material.roughness).toBe(.73); expect(material.metalness).toBe(.25);
    expect(material.transparent).toBe(false); expect(material.depthWrite).toBe(true); expect(source.onBeforeCompile).toBe(before);
    const colour = shader(material), depth = shader(skyline.depth);
    expect(colour.vertexShader).toBe(depth.vertexShader); expect(colour.fragmentShader).toBe(depth.fragmentShader);
    expect(colour.vertexShader).toContain('gl_InstanceID'); expect(colour.fragmentShader).toContain('discard');
    expect(colour.vertexShader).toContain(`smoothstep(-${MIAMI_SKYLINE.behind}.0, -${MIAMI_SKYLINE.fullBehind}.0`);
    expect(colour.vertexShader).toContain(`smoothstep(${MIAMI_SKYLINE.fullAhead}.0, ${MIAMI_SKYLINE.ahead}.0`);
    expect(colour.uniforms).toEqual({ miamiSkylineSlots: { value: skyline.slots }, miamiPlayerS: skyline.player });
    expect(depth.uniforms).toEqual(colour.uniforms);
    skyline.set(0, 2845, true); skyline.set(1, 8623, false);
    expect(Array.from((skyline.slots.image.data as Float32Array).slice(0, 4))).toEqual([2845, 1, 8623, 0]);
    const version = skyline.slots.version; skyline.player.value = 2201;
    expect(skyline.slots.version).toBe(version); expect((colour.uniforms as Record<string, THREE.IUniform>).miamiPlayerS.value).toBe(2201);
    const owned = [material, skyline.depth, skyline.slots].map(o => vi.spyOn(o, 'dispose')), borrowed = [source, map].map(o => vi.spyOn(o, 'dispose'));
    skyline.dispose(); owned.forEach(s => expect(s).toHaveBeenCalledOnce()); borrowed.forEach(s => expect(s).not.toHaveBeenCalled());
    source.dispose(); map.dispose();
  });
});
