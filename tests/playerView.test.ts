import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PlayerView } from '../src/render/playerView';

describe('PlayerView and shared model materials', () => {
  it('a car taken off the scene disposes its own materials, never the ones every car of a model shares', () => {
    const view = new PlayerView(1, 0x3366ff, new THREE.Texture(), 4.6, 1.9, false);
    // An imported model's material is shared by every car built from it.
    const shared = new THREE.MeshStandardMaterial();
    shared.userData.shared = true;
    view.root.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    const own = new THREE.MeshStandardMaterial();
    view.root.add(new THREE.Mesh(new THREE.BoxGeometry(), own));
    let sharedGone = false;
    let ownGone = false;
    shared.addEventListener('dispose', () => (sharedGone = true));
    own.addEventListener('dispose', () => (ownGone = true));
    // Fading as a ghost must not touch the shared one either (it would fade every such car).
    view.setGhost(true);
    expect(shared.transparent).toBe(false);
    expect(own.transparent).toBe(true);
    view.dispose();
    expect(ownGone).toBe(true);
    // Disposing it made every client recompile the others' A45 shaders: a freeze when a driver left.
    expect(sharedGone).toBe(false);
  });
});

describe('driver paint and beams', () => {
  it('repaints only this car, keeping the glass, trim and other drivers unchanged', () => {
    const a = new PlayerView(1, 0x3366ff, new THREE.Texture());
    const b = new PlayerView(1, 0x3366ff, new THREE.Texture());
    const colours = (view: PlayerView) => {
      const result: number[] = [];
      view.root.traverse(o=>{const m=(o as THREE.Mesh).material as THREE.MeshStandardMaterial|undefined;if(m?.color)result.push(m.color.getHex());});
      return result;
    };
    const before = colours(a), other = colours(b);
    a.setPaint(0xc83235);
    expect(colours(a)).toEqual(before.map(c=>c===0x3366ff?0xc83235:c));
    expect(colours(b)).toEqual(other);
    a.dispose();b.dispose();
  });
  it('high beam extends the real lights, aims higher and restores low beam exactly', () => {
    const view = new PlayerView(1, 0x3366ff, new THREE.Texture());
    const before = view.headlights.map(b=>({intensity:b.intensity,distance:b.distance,angle:b.angle,target:b.target.position.clone()}));
    view.setHighBeam(true);
    view.headlights.forEach((b,i)=>{
      expect(b.distance).toBeGreaterThan(before[i].distance);
      expect(b.intensity).toBeGreaterThan(before[i].intensity);
      expect(b.target.position.y).toBeGreaterThan(before[i].target.y);
      expect(b.target.position.z).toBeLessThan(before[i].target.z);
    });
    view.setHighBeam(false);
    view.headlights.forEach((b,i)=>{expect(b.intensity).toBe(before[i].intensity);expect(b.distance).toBe(before[i].distance);expect(b.angle).toBe(before[i].angle);expect(b.target.position).toEqual(before[i].target);});
    view.dispose();
  });
});
