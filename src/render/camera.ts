import * as THREE from 'three';
import { cameraTune } from '../config';
import { clamp, damp, dampAngle, lerp } from '../core/math';

/** Chase camera: lags the car's heading, widens FOV with speed, shakes on impacts and near misses. */
export class ChaseCamera {
  private yaw = 0;
  private shake = 0;
  private t = 0;
  private first = true;
  private readonly look = new THREE.Vector3();

  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3, carYaw: number, kmh: number): void {
    const ct = cameraTune;
    if (this.first) {
      this.yaw = carYaw;
      this.first = false;
    }
    this.yaw = dampAngle(this.yaw, carYaw, ct.yawLag, dt);
    const sp = clamp((kmh - 40) / 260, 0, 1);
    const fx = Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const dist = ct.dist + sp * 0.8;
    const h = ct.height - sp * 0.15;

    this.t += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const amp = this.shake * this.shake * 0.35 + sp * sp * 0.01;
    const t = this.t;
    const n1 = Math.sin(t * 37.1) * Math.sin(t * 13.7);
    const n2 = Math.sin(t * 29.3 + 1.3) * Math.cos(t * 17.9);

    camera.position.set(target.x - fx * dist + n1 * amp, target.y + h + n2 * amp, target.z - fz * dist + n2 * amp * 0.5);
    this.look.set(target.x + fx * ct.lookAhead, target.y + ct.lookHeight, target.z + fz * ct.lookAhead);
    camera.lookAt(this.look);

    const fov = damp(camera.fov, lerp(ct.fovMin, ct.fovMax, sp), 3, dt);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
