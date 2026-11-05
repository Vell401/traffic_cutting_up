import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { PlayerCar } from '../sim/vehicle';

const TAIL_IDLE = new THREE.Color(1.2, 0.05, 0.03);
const TAIL_BRAKE = new THREE.Color(5, 0.18, 0.1);

/** Grey-box player car built from primitives. Faces -Z; root sits on the ground under the car centre. */
export class PlayerView {
  readonly root = new THREE.Group();
  readonly headlight: THREE.SpotLight;
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Object3D[] = [];
  private readonly frontPivots: THREE.Object3D[] = [];
  private readonly tailMat = new THREE.MeshBasicMaterial({ color: TAIL_IDLE.clone() });
  private pitch = 0;
  private roll = 0;

  constructor(paint: number, shadowTex: THREE.Texture, length = 4.6, width = 1.9) {
    const L = length;
    const W = width;
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: paint,
      metalness: 0.5,
      roughness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.06 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.75 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xa7adb5, metalness: 0.85, roughness: 0.28 });
    const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.3) });

    const box = (w: number, h: number, l: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      m.position.set(x, y, z);
      this.body.add(m);
      return m;
    };

    box(W, 0.5, L, paintMat, 0, 0.47, 0);
    box(W * 0.97, 0.1, 1.5, paintMat, 0, 0.75, -1.45); // hood bulge
    box(1.6, 0.44, 2.15, glassMat, 0, 0.94, 0.2); // cabin
    box(1.5, 0.05, 1.6, paintMat, 0, 1.18, 0.25); // roof
    box(W + 0.02, 0.14, L * 0.62, trimMat, 0, 0.27, 0); // skirts
    box(W * 0.9, 0.16, 0.12, trimMat, 0, 0.28, L / 2 - 0.02); // diffuser
    box(1.75, 0.04, 0.32, trimMat, 0, 0.98, L / 2 - 0.2); // spoiler
    box(0.48, 0.09, 0.04, this.tailMat, -0.62, 0.62, L / 2 + 0.01);
    box(0.48, 0.09, 0.04, this.tailMat, 0.62, 0.62, L / 2 + 0.01);
    box(0.9, 0.03, 0.03, this.tailMat, 0, 0.62, L / 2 + 0.012);
    box(0.42, 0.07, 0.04, headMat, -0.63, 0.58, -L / 2 - 0.01);
    box(0.42, 0.07, 0.04, headMat, 0.63, 0.58, -L / 2 - 0.01);

    const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 24).rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.27, 12).rotateZ(Math.PI / 2);
    for (const [x, z, front] of [
      [-0.84, -1.32, true],
      [0.84, -1.32, true],
      [-0.84, 1.42, false],
      [0.84, 1.42, false],
    ] as [number, number, boolean][]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.34, z);
      const wheel = new THREE.Group();
      wheel.add(new THREE.Mesh(tireGeo, tireMat), new THREE.Mesh(rimGeo, rimMat));
      pivot.add(wheel);
      this.root.add(pivot);
      this.wheels.push(wheel);
      if (front) this.frontPivots.push(pivot);
    }

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.45, L * 1.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    shadow.position.y = 0.02;
    shadow.renderOrder = 1;
    this.root.add(shadow);

    this.headlight = new THREE.SpotLight(0xfff0d8, 2600, 160, 0.42, 0.55, 1.4);
    this.headlight.position.set(0, 0.65, -L / 2);
    this.headlight.target.position.set(0, 0, -40);
    this.root.add(this.headlight, this.headlight.target);

    this.root.add(this.body);
  }

  update(dt: number, car: PlayerCar, pos: THREE.Vector3, yaw: number): void {
    this.root.position.copy(pos);
    this.root.rotation.y = -yaw;
    // Suspension feel: nose dives under braking, body rolls out of the turn.
    this.pitch = damp(this.pitch, clamp(car.accLong * 0.004, -0.04, 0.03), 8, dt);
    this.roll = damp(this.roll, clamp(car.accLat * 0.005, -0.05, 0.05), 8, dt);
    this.body.rotation.set(this.pitch, 0, this.roll);
    for (const p of this.frontPivots) p.rotation.y = -car.steerIn * 0.32;
    const spin = -(car.wheelSpin % (Math.PI * 2));
    for (const w of this.wheels) w.rotation.x = spin;
    this.tailMat.color.copy(car.brake > 0.05 ? TAIL_BRAKE : TAIL_IDLE);
  }
}
