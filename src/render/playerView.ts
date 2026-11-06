import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { CarId } from '../sim/cars';
import type { PlayerCar } from '../sim/vehicle';
import { buildCar, type CarParts } from './car';

/** Turn signal rhythm: about 85 flashes a minute, lit a bit longer than dark. */
const BLINK_PERIOD = 0.7;
const BLINK_LIT = 0.38;

/**
 * A driver's car: the chosen body (built in render/car), suspension pitch and roll, steering and
 * rolling wheels, brake lamps. Faces -Z; root on the ground under the centre. Our own car also gets
 * the real headlight and, for models that have one, the cockpit for the first-person view.
 */
export class PlayerView {
  readonly root = new THREE.Group();
  readonly headlight: THREE.SpotLight;
  private readonly parts: CarParts;
  private pitch = 0;
  private roll = 0;
  private ghost = false;
  private cockpitOn = false;
  private blinkSide = 0;
  private blinkT = 0;
  /** A turn signal lamp is lit right now (the HUD arrow and the relay click follow it). */
  blinkLit = false;
  private readonly mats: THREE.Material[] = [];
  private readonly inside: THREE.Material[];

  /** own: the player's own car (real spot light, cockpit); others get just the lamps. */
  constructor(
    readonly car: CarId,
    paint: number,
    shadowTex: THREE.Texture,
    length = 4.6,
    width = 1.9,
    own = true,
    /** A hidden spare built only to compile shaders: skip heavy downloads. */
    spare = false,
  ) {
    const L = length;
    const W = width;
    this.parts = buildCar(car, paint, L, W, own, !spare);
    const p = this.parts;

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.45, L * 1.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    shadow.position.y = 0.02;
    shadow.renderOrder = 1;
    this.root.add(shadow);

    // Physical falloff (decay 2): with 1.4 cars 30-60 m ahead were lit almost as hard as up close and bloomed.
    // A wide, soft-edged beam (penumbra 0.85): the light spreads over the road instead of a hard oval.
    this.headlight = new THREE.SpotLight(0xfff0d8, 780, 120, 0.5, 0.85, 2);
    this.headlight.position.copy(p.lamp);
    this.headlight.target.position.set(0, 0, p.lamp.z - 40);
    if (own) this.root.add(this.headlight, this.headlight.target);

    this.root.add(p.body, p.wheelRoot);
    // Ghosting fades the outside of the car; the cockpit stays solid (from inside the outside is not seen anyway).
    const inside = new Set<THREE.Material>();
    p.cockpit?.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) inside.add(m);
    });
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !inside.has(m) && !this.mats.includes(m)) this.mats.push(m);
    });
    this.inside = [...inside];
  }

  /** Driver's eye anchor (cars with a cockpit). */
  get eye(): THREE.Object3D | null {
    return this.parts.cockpit?.eye ?? null;
  }

  /** The suspended body (the first-person camera rides on it). */
  get body(): THREE.Object3D {
    return this.parts.body;
  }

  get hasCockpit(): boolean {
    return this.parts.cockpit !== null;
  }

  /** First-person view: draw the interior, skip the wheels (never seen from inside). */
  setCockpit(on: boolean): void {
    this.cockpitOn = on && this.parts.cockpit !== null;
    if (this.parts.cockpit) this.parts.cockpit.group.visible = this.cockpitOn;
    this.parts.wheelRoot.visible = !this.cockpitOn;
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
    const p = this.parts;
    this.root.position.copy(pos);
    this.root.rotation.y = -yaw;
    // Suspension feel: nose dives under braking, body rolls out of the turn.
    this.pitch = damp(this.pitch, clamp(car.accLong * 0.004, -0.04, 0.03), 8, dt);
    this.roll = damp(this.roll, clamp(car.accLat * 0.005, -0.05, 0.05), 8, dt);
    p.body.rotation.set(this.pitch, 0, this.roll);
    if (!this.cockpitOn) p.wheels.update(car.steerIn * 0.32, car.wheelSpin % (Math.PI * 2));
    p.tail.color.copy(car.brake > 0.05 ? p.tailBrake : p.tailIdle);
    // Turn signals: a new side starts lit, like a real relay.
    if (car.blinker !== this.blinkSide) {
      this.blinkSide = car.blinker;
      this.blinkT = 0;
    } else this.blinkT += dt;
    this.blinkLit = this.blinkSide !== 0 && this.blinkT % BLINK_PERIOD < BLINK_LIT;
    p.indicators.set(this.blinkLit && this.blinkSide === 1, this.blinkLit && this.blinkSide === 2, car.brake > 0.05);
    if (this.cockpitOn) p.cockpit!.update(car, dt);
  }

  /** Take it out of the scene and free its materials (geometry is shared between cars of a model). */
  dispose(): void {
    this.root.removeFromParent();
    for (const m of [...this.mats, ...this.inside]) m.dispose();
  }
}
