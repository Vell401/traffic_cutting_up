import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp, smoothstep, wrapAngle } from '../core/math';
import type { PlayerCar } from '../sim/vehicle';
import { CAMERA_RIGS, type CameraMode, type CameraRig } from './car';

export type { CameraMode } from './car';

/** Mouse look holds this long after the last move, then eases back, s. */
const LOOK_HOLD = 2;

/** What the first-person camera rides on. */
export interface CockpitAnchor {
  eye: THREE.Object3D;
  body: THREE.Object3D;
  car: PlayerCar;
}

/** Second-order follower (a spring with damping): the driver's head lagging and overshooting a little. */
class Spring {
  x = 0;
  private v = 0;
  constructor(
    private readonly k: number,
    private readonly zeta: number,
  ) {}
  step(target: number, dt: number): number {
    const c = 2 * this.zeta * Math.sqrt(this.k);
    // Substeps keep it stable on slow frames.
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (this.k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(): void {
    this.x = 0;
    this.v = 0;
  }
}

/**
 * Chase cameras lag the car's heading and widen the FOV with speed; the hood and bumper cameras are
 * rigid; the cockpit camera sits at the driver's eye on the suspended body, with the head swaying
 * under g-forces and glancing into turns. All of them shake on impacts and near misses. Positions
 * come from the current car's rig.
 */
export class ChaseCamera {
  mode: CameraMode = 'chase';
  rig: CameraRig = CAMERA_RIGS[1];
  /** Boost on: the view widens a little. */
  boost = false;
  /** C held: look back (the chase views from in front of the car, the others from its tail). */
  lookBack = false;
  private boostFov = 0;
  private yaw = 0;
  private shake = 0;
  private t = 0;
  private first = true;
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  // First person: head offsets (m, rad) and the glance into turns.
  private readonly headX = new Spring(70, 0.7);
  private readonly headZ = new Spring(60, 0.7);
  private readonly headRoll = new Spring(60, 0.8);
  private readonly headPitch = new Spring(60, 0.8);
  private glance = 0;
  private readonly q = new THREE.Quaternion();
  private readonly qHead = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  /** Mouse look (left button dragged): offsets in rad, eased back to zero 2 s after the last move. */
  private lookYaw = 0;
  private lookPitch = 0;
  private lookT = 1e9;

  /**
   * Drag by (dx, dy) px: around the car in the chase views, the head in the cockpit, the view on the
   * hood and bumper. Yaw goes all the way round (no stop); pitch from a little under the horizon to
   * nearly overhead outside, the full range of a turned head inside.
   */
  mouseLook(dx: number, dy: number): void {
    const cockpit = this.mode === 'cockpit';
    this.lookYaw = wrapAngle(this.lookYaw - dx * 0.006);
    this.lookPitch = clamp(this.lookPitch - dy * 0.004, cockpit ? -0.9 : -0.3, cockpit ? 0.8 : 1.25);
    this.lookT = 0;
  }

  private easeLook(dt: number): void {
    this.lookT += dt;
    if (this.lookT < LOOK_HOLD) return;
    this.lookYaw = damp(this.lookYaw, 0, 3, dt);
    this.lookPitch = damp(this.lookPitch, 0, 3, dt);
  }

  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  snap(): void {
    this.first = true;
  }

  /** Switch to a car's rig; keep `mode` if that car has it (else the chase view). */
  setRig(rig: CameraRig, mode: CameraMode = this.mode): CameraMode {
    this.rig = rig;
    this.mode = rig.modes.includes(mode) ? mode : 'chase';
    this.first = true;
    return this.mode;
  }

  cycle(): CameraMode {
    const modes = this.rig.modes;
    this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
    this.first = true;
    return this.mode;
  }

  /** Rigid views (no chase lag). */
  get rigid(): boolean {
    return this.mode !== 'chase' && this.mode !== 'far';
  }

  update(dt: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3, carYaw: number, kmh: number, cockpit: CockpitAnchor | null): void {
    if (this.lookBack) {
      this.rearView(camera, target, carYaw);
      return;
    }
    if (this.mode === 'cockpit' && cockpit && this.rig.cockpit) {
      this.firstPerson(dt, camera, cockpit, kmh);
      return;
    }
    const ct = this.rig.chase;
    if (this.first) {
      this.yaw = carYaw;
      this.first = false;
    }
    const rigid = this.rigid;
    this.yaw = rigid ? dampAngle(this.yaw, carYaw, 30, dt) : dampAngle(this.yaw, carYaw, ct.yawLag, dt);
    const sp = clamp((kmh - 40) / 260, 0, 1);
    this.easeLook(dt);
    // The car's heading (for looking ahead) and the camera's own direction (turned by the mouse).
    const fx = Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const cx = Math.sin(this.yaw + this.lookYaw);
    const cz = -Math.cos(this.yaw + this.lookYaw);

    const [n1, n2] = this.noise(dt, sp, rigid ? 0.35 : 1);

    let back: number;
    let h: number;
    let lookAhead: number;
    let lookH: number;
    switch (this.mode) {
      case 'far':
        back = ct.dist + this.rig.far.dist + sp;
        h = ct.height + this.rig.far.height;
        lookAhead = ct.lookAhead + this.rig.far.lookAhead;
        lookH = ct.lookHeight + this.rig.far.lookHeight;
        break;
      case 'hood':
        back = -this.rig.hood.f;
        h = this.rig.hood.y;
        lookAhead = 30;
        lookH = this.rig.hood.lookHeight;
        break;
      case 'bumper':
        back = -this.rig.bumper.f;
        h = this.rig.bumper.y;
        lookAhead = 30;
        lookH = this.rig.bumper.lookHeight;
        break;
      default:
        back = ct.dist + sp * 0.8;
        h = ct.height - sp * 0.15;
        lookAhead = ct.lookAhead;
        lookH = ct.lookHeight;
    }

    // The hood sits ~0.3 m under the hood camera: only that mode needs a near plane closer than 0.5 m
    // (the rest keep 0.5 m for depth precision on far road decals).
    this.setNear(camera, this.mode === 'hood' ? 0.15 : 0.5);
    if (rigid) {
      // Hood and bumper: the camera stays put and turns.
      camera.position.set(target.x - fx * back + n1, target.y + h + n2, target.z - fz * back + n2 * 0.5);
      const ahead = lookAhead * Math.cos(this.lookPitch);
      this.look.set(camera.position.x + cx * ahead, target.y + lookH + lookAhead * Math.sin(this.lookPitch), camera.position.z + cz * ahead);
    } else {
      // Chase: orbit around the car, framing it more centrally the further round the camera goes.
      const flat = back * Math.cos(this.lookPitch);
      const up = h + back * Math.sin(this.lookPitch);
      const ahead = lookAhead * Math.max(0, Math.cos(this.lookYaw));
      camera.position.set(target.x - cx * flat + n1, target.y + up + n2, target.z - cz * flat + n2 * 0.5);
      this.look.set(target.x + fx * ahead, target.y + lookH, target.z + fz * ahead);
    }
    camera.lookAt(this.look);

    const base = rigid ? 8 : 0;
    this.boostFov = damp(this.boostFov, this.boost ? 6 : 0, 4, dt);
    this.setFov(camera, damp(camera.fov, lerp(ct.fovMin + base, ct.fovMax + base, sp) + this.boostFov, 3, dt));
  }

  /**
   * Rear view while C is held. Chase views: from in front of the car over its roof at the road behind
   * (the car stays in the picture); cockpit, hood and bumper: from the tail, straight back.
   */
  private rearView(camera: THREE.PerspectiveCamera, target: THREE.Vector3, carYaw: number): void {
    // Rigid to the car: no swing when C is let go either.
    this.yaw = carYaw;
    this.first = false;
    const fx = Math.sin(carYaw);
    const fz = -Math.cos(carYaw);
    const ct = this.rig.chase;
    if (this.mode === 'chase' || this.mode === 'far') {
      const ahead = ct.dist + (this.mode === 'far' ? this.rig.far.dist : 0);
      camera.position.set(target.x + fx * ahead, target.y + ct.height + 0.25, target.z + fz * ahead);
      this.look.set(target.x - fx * 14, target.y + ct.lookHeight, target.z - fz * 14);
      this.setNear(camera, 0.5);
    } else {
      const tail = this.rig.bumper.f + 0.35;
      camera.position.set(target.x - fx * tail, target.y + 1.15, target.z - fz * tail);
      this.look.set(camera.position.x - fx * 30, target.y + 0.9, camera.position.z - fz * 30);
      this.setNear(camera, 0.2);
    }
    camera.lookAt(this.look);
    this.setFov(camera, ct.fovMin + 4);
  }

  /** Driver's eye on the suspended body; the head sways with the g-forces and glances into turns. */
  private firstPerson(dt: number, camera: THREE.PerspectiveCamera, a: CockpitAnchor, kmh: number): void {
    const rig = this.rig.cockpit!;
    const car = a.car;
    if (this.first) {
      this.first = false;
      for (const s of [this.headX, this.headZ, this.headRoll, this.headPitch]) s.reset();
      this.glance = 0;
    }
    const latG = clamp(car.accLat / 9.81, -1.5, 1.5);
    const longG = clamp(car.accLong / 9.81, -1.5, 1.5);
    // Cornering throws the head to the outside, accelerating presses it back, braking pitches it forward.
    const hx = this.headX.step(-latG * 0.032, dt);
    const hz = this.headZ.step(longG * 0.03, dt);
    const roll = this.headRoll.step(latG * 0.018, dt);
    const pitch = this.headPitch.step(longG * 0.018, dt);
    this.glance = damp(this.glance, clamp(car.r * 0.11 + car.steerIn * 0.025, -0.12, 0.12), 3, dt);
    this.easeLook(dt);
    const sp = clamp((kmh - 40) / 260, 0, 1);
    const [n1, n2] = this.noise(dt, sp, 0.12);

    a.eye.updateWorldMatrix(true, false);
    // Looking back the driver turns in the seat: the head leans toward the middle of the car and a
    // little forward, so the view goes past the own headrest to the rear window.
    const back = smoothstep((Math.abs(this.lookYaw) - 0.9) / 1.5);
    let leanX = 0;
    if (back > 0) {
      const side = a.body.worldToLocal(a.eye.getWorldPosition(this.tmp)).x;
      leanX = (side > 0 ? -1 : 1) * 0.24 * back;
    }
    camera.position.set(hx + n1 + leanX, n2 + 0.03 * back, hz - 0.14 * back).applyMatrix4(a.eye.matrixWorld);
    a.body.getWorldQuaternion(this.q);
    this.e.set(rig.pitch + pitch + n2 * 0.6 + this.lookPitch, -this.glance + this.lookYaw, roll);
    this.qHead.setFromEuler(this.e);
    camera.quaternion.copy(this.q).multiply(this.qHead);

    this.setNear(camera, 0.08);
    this.setFov(camera, damp(camera.fov, lerp(rig.fov, rig.fovFast, sp), 3, dt));
  }

  /** Camera shake: impacts and near misses, plus a little speed buzz. */
  private noise(dt: number, sp: number, scale: number): [number, number] {
    this.t += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const amp = (this.shake * this.shake * 0.35 + sp * sp * 0.01) * scale;
    const t = this.t;
    return [Math.sin(t * 37.1) * Math.sin(t * 13.7) * amp, Math.sin(t * 29.3 + 1.3) * Math.cos(t * 17.9) * amp];
  }

  private setNear(camera: THREE.PerspectiveCamera, near: number): void {
    if (camera.near === near) return;
    camera.near = near;
    camera.updateProjectionMatrix();
  }

  private setFov(camera: THREE.PerspectiveCamera, fov: number): void {
    if (Math.abs(fov - camera.fov) <= 0.01) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
