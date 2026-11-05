import * as THREE from 'three';
import { cameraTune } from '../config';
import { clamp, damp, dampAngle, lerp } from '../core/math';

export type CameraMode = 'chase' | 'far' | 'hood' | 'bumper';
const MODES: CameraMode[] = ['chase', 'far', 'hood', 'bumper'];

/**
 * Chase cameras lag the car's heading and widen the FOV with speed; the hood and bumper cameras are
 * rigid. All of them shake on impacts and near misses.
 */
export class ChaseCamera {
  mode: CameraMode = 'chase';
  private yaw = 0;
  private shake = 0;
  private t = 0;
  private first = true;
  private readonly look = new THREE.Vector3();

  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  cycle(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this.first = true;
    return this.mode;
  }

  get cockpit(): boolean {
    return this.mode === 'hood' || this.mode === 'bumper';
  }

  update(dt: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3, carYaw: number, kmh: number): void {
    const ct = cameraTune;
    if (this.first) {
      this.yaw = carYaw;
      this.first = false;
    }
    const cockpit = this.cockpit;
    this.yaw = cockpit ? dampAngle(this.yaw, carYaw, 30, dt) : dampAngle(this.yaw, carYaw, ct.yawLag, dt);
    const sp = clamp((kmh - 40) / 260, 0, 1);
    const fx = Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);

    this.t += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const amp = (this.shake * this.shake * 0.35 + sp * sp * 0.01) * (cockpit ? 0.35 : 1);
    const t = this.t;
    const n1 = Math.sin(t * 37.1) * Math.sin(t * 13.7) * amp;
    const n2 = Math.sin(t * 29.3 + 1.3) * Math.cos(t * 17.9) * amp;

    let back: number;
    let h: number;
    let lookAhead: number;
    let lookH: number;
    switch (this.mode) {
      case 'far':
        back = ct.dist + 2.6 + sp;
        h = ct.height + 0.9;
        lookAhead = ct.lookAhead + 2;
        lookH = ct.lookHeight + 0.3;
        break;
      case 'hood':
        back = -0.55;
        h = 1.2;
        lookAhead = 30;
        lookH = 0.95;
        break;
      case 'bumper':
        back = -2.45;
        h = 0.55;
        lookAhead = 30;
        lookH = 0.5;
        break;
      default:
        back = ct.dist + sp * 0.8;
        h = ct.height - sp * 0.15;
        lookAhead = ct.lookAhead;
        lookH = ct.lookHeight;
    }

    // The hood sits ~0.3 m under the hood camera: only that mode needs a near plane closer than 0.5 m
    // (the rest keep 0.5 m for depth precision on far road decals).
    const near = this.mode === 'hood' ? 0.15 : 0.5;
    if (camera.near !== near) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    camera.position.set(target.x - fx * back + n1, target.y + h + n2, target.z - fz * back + n2 * 0.5);
    this.look.set(target.x + fx * lookAhead, target.y + lookH, target.z + fz * lookAhead);
    camera.lookAt(this.look);

    const base = cockpit ? 8 : 0;
    const fov = damp(camera.fov, lerp(ct.fovMin + base, ct.fovMax + base, sp), 3, dt);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
