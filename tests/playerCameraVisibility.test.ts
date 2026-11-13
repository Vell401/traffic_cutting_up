import * as THREE from 'three';
import { expect, it } from 'vitest';
import { PlayerView } from '../src/render/playerView';
import { View } from '../src/render/view';
import { W204Car } from '../src/sim/vehicleW204';
import type { CameraMode } from '../src/render/camera';

it('camera cycles hide only owned visuals; both beams/targets keep their real world poses and authored hidden branches stay hidden', async () => {
  const player = new PlayerView(3, 0x3366ff, new THREE.Texture(), 4.6, 1.9, true, true);
  await player.ready;
  const scene = new THREE.Scene(); scene.add(player.root);
  const authored = new THREE.Group(); authored.visible = false; player.body.add(authored);
  const chase: { mode: CameraMode } = { mode: 'chase' };
  const view = Object.assign(Object.create(View.prototype), { playerView: player, chase }) as View;
  const apply = () => (view as unknown as { applyCameraMode(): void }).applyCameraMode();
  const car = new W204Car();
  try {
    for (const mode of ['chase', 'cockpit', 'hood', 'bumper', 'chase'] as CameraMode[]) {
      chase.mode = mode; apply();
      for (const high of [false, true]) {
        player.setHighBeam(high); player.update(0, car, new THREE.Vector3(31, 0, -59), .7); scene.updateMatrixWorld(true);
        const visible: THREE.Object3D[] = []; scene.traverseVisible(o => visible.push(o));
        expect(player.headlights.filter(b => visible.includes(b))).toHaveLength(2);
        expect(player.root.visible).toBe(true);
        expect(visible.includes(player.body)).toBe(mode !== 'bumper');
        expect(authored.visible).toBe(false);
        for (const b of player.headlights) {
          expect(b.getWorldPosition(new THREE.Vector3())).toEqual(b.position.clone().applyMatrix4(player.root.matrixWorld));
          expect(b.target.getWorldPosition(new THREE.Vector3())).toEqual(b.target.position.clone().applyMatrix4(player.root.matrixWorld));
          expect(b.intensity).toBe(high ? 1500 : 520); expect(b.distance).toBe(high ? 240 : 120);
        }
      }
    }
  } finally { player.dispose(); }
});
