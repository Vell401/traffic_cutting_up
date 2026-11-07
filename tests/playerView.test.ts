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
