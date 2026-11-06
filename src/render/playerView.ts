import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { PlayerCar } from '../sim/vehicle';
import { buildCoupe } from './carModels';

const TAIL_IDLE = new THREE.Color(1.2, 0.05, 0.03);
const TAIL_BRAKE = new THREE.Color(2.6, 0.07, 0.04);

/** Player coupe: extruded body with clearcoat paint, glasshouse, trim. Faces -Z; root on the ground under the centre. */
export class PlayerView {
  readonly root = new THREE.Group();
  readonly headlight: THREE.SpotLight;
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Object3D[] = [];
  private readonly frontPivots: THREE.Object3D[] = [];
  private readonly tailMat = new THREE.MeshBasicMaterial({ color: TAIL_IDLE.clone() });
  private pitch = 0;
  private roll = 0;
  private ghost = false;
  private readonly mats: THREE.Material[] = [];

  /** headlight: the real spot light (the player's own car only; others get just the lamps). */
  constructor(paint: number, shadowTex: THREE.Texture, length = 4.6, width = 1.9, headlight = true) {
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

    const coupe = buildCoupe(L, W);
    this.body.add(new THREE.Mesh(coupe.paint, paintMat), new THREE.Mesh(coupe.glass, glassMat), new THREE.Mesh(coupe.trim, trimMat));
    // Lamps sit just proud of the bevelled body surface.
    box(0.46, 0.08, 0.06, this.tailMat, -0.6, 0.7, L / 2 + 0.04);
    box(0.46, 0.08, 0.06, this.tailMat, 0.6, 0.7, L / 2 + 0.04);
    box(0.8, 0.025, 0.05, this.tailMat, 0, 0.72, L / 2 + 0.05);
    box(0.42, 0.06, 0.06, headMat, -0.62, 0.6, -L / 2 - 0.01);
    box(0.42, 0.06, 0.06, headMat, 0.62, 0.6, -L / 2 - 0.01);

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

    // Physical falloff (decay 2): with 1.4 cars 30-60 m ahead were lit almost as hard as up close and bloomed.
    this.headlight = new THREE.SpotLight(0xfff0d8, 900, 120, 0.42, 0.55, 2);
    this.headlight.position.set(0, 0.65, -L / 2);
    this.headlight.target.position.set(0, 0, -40);
    if (headlight) this.root.add(this.headlight, this.headlight.target);

    this.root.add(this.body);
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !this.mats.includes(m)) this.mats.push(m);
    });
  }

  /** Online spawn protection: the car is drawn see-through while traffic passes through it. */
  setGhost(on: boolean): void {
    if (on === this.ghost) return;
    this.ghost = on;
    for (const m of this.mats) {
      const base = (m.userData.baseOpacity ??= m.opacity) as number;
      const baseTransparent = (m.userData.baseTransparent ??= m.transparent) as boolean;
      const baseDepthWrite = (m.userData.baseDepthWrite ??= m.depthWrite) as boolean;
      m.transparent = on || baseTransparent;
      m.opacity = on ? base * 0.35 : base;
      m.depthWrite = on ? false : baseDepthWrite;
      m.needsUpdate = true;
    }
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
