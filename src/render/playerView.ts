import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { CarId } from '../sim/cars';
import type { PlayerCar } from '../sim/vehicle';
import { buildCar, isShared, waitForCar, type CarParts } from './car';
import { createTyreFeedback, sampleTyreFeedback } from '../presentation/tyres';

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
  /** Our car's two headlight beams (left, right). */
  readonly headlights: THREE.SpotLight[] = [];
  private readonly parts: CarParts;
  private disposed = false;
  private readonly readiness: Promise<void>;
  private cancelReady: () => void = () => {};
  private pitch = 0;
  private roll = 0;
  private ghost = false;
  private cockpitOn = false;
  private blinkSide = 0;
  private blinkT = 0;
  /** Presentation-local phase; never write physics wheelSpin or integrate the rear axle for fronts. */
  readonly wheelAngles = [0, 0, 0, 0];
  readonly tyreFeedback = createTyreFeedback();
  private readonly contactMatrix = new THREE.Matrix4();
  private readonly contactNodes: (THREE.Object3D | null)[] = [null, null, null, null];
  private contactInstances: THREE.InstancedMesh | null = null;
  private remoteSource?: { vx: number; vy: number; r: number; steerAngle: number; tune: PlayerCar['tune']; omega?: ArrayLike<number> };
  /** A turn signal lamp is lit right now (the HUD arrow and the relay click follow it). */
  blinkLit = false;
  /** The cockpit's materials, including hidden instrument surfaces. */
  private readonly inside = new Set<THREE.Material>();
  get ready(): Promise<void> { return this.readiness; }

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
    // A builder may keep its placeholder alive after a failed download. That is not readiness.
    // A fresh instance can attach the model after the caller retries its download.
    // Headless instrument/animation consumers have no page URL for relative model requests and
    // retain the builder's placeholder contract. A real browser must also verify the download.
    const loaded = Promise.all([p.ready, !spare && typeof window !== 'undefined' ? waitForCar(car) : undefined]).then(() => {});
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelReady = () => {
        const error = new Error('Car view disposed before it was ready');
        error.name = 'AbortError';
        reject(error);
      };
    });
    this.readiness = Promise.race([loaded, cancelled]);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.45, L * 1.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    shadow.position.y = 0.02;
    shadow.renderOrder = 1;
    this.root.add(shadow);

    // One beam from each headlamp, just ahead of its glass (a light inside the bumper lit the grille up
    // like a torch), each aimed a little outward. Physical falloff (decay 2): with 1.4 cars 30-60 m ahead
    // were lit almost as hard as up close and bloomed. Wide, soft edges (penumbra 0.8): the light
    // spreads over the road instead of hard ovals.
    if (own) {
      for (const side of [-1, 1]) {
        const beam = new THREE.SpotLight(0xfff0d8, 520, 120, 0.46, 0.8, 2);
        beam.position.set(side * p.lampX, p.lamp.y, p.lamp.z);
        beam.target.position.set(side * (p.lampX + 1.4), 0, p.lamp.z - 40);
        this.headlights.push(beam);
        this.root.add(beam, beam.target);
      }
    }

    this.root.add(p.body, p.wheelRoot);
    // Keep the generated instruments in the same ghost/material lifecycle as the imported body.
    p.cockpit?.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) this.inside.add(m);
    });
    // Observe the detached branch without hiding failures from callers awaiting ready.
    void this.ready.then(() => {
      if (this.disposed) return;
      this.findWheelContacts();
      if (this.ghost) this.applyGhost();
    }).catch(() => {});
    this.findWheelContacts();
  }

  private findWheelContacts(): void {
    const corners = ['FL', 'FR', 'RL', 'RR'], a45 = ['LF', 'RF', 'LR', 'RR'];
    for (let i = 0; i < 4; i++) this.contactNodes[i] = this.parts.wheelRoot.getObjectByName(`Wheel_${corners[i]}`)?.parent
      ?? this.parts.body.getObjectByName(`WHEEL_${a45[i]}`) ?? null;
    this.contactInstances = null;
    this.parts.wheelRoot.traverse(o => {
      if (!this.contactInstances && o instanceof THREE.InstancedMesh && o.count === 4) this.contactInstances = o;
    });
  }

  /** Current rendered tyre centre projected onto the flat road, in floating-origin coordinates. */
  wheelContact(index: number, out: THREE.Vector3): THREE.Vector3 {
    const node = this.contactNodes[index], mesh = this.contactInstances;
    if (node) node.getWorldPosition(out);
    else if (mesh) {
      mesh.getMatrixAt(index, this.contactMatrix);
      out.setFromMatrixPosition(this.contactMatrix).applyMatrix4(mesh.matrixWorld);
    } else {
      out.set(index % 2 ? .8 : -.8, 0, index < 2 ? -1.35 : 1.35).applyMatrix4(this.root.matrixWorld);
    }
    out.y = this.root.position.y + .018;
    return out;
  }

  /**
   * This car's own materials, looked up when needed (an imported model arrives after construction).
   * Materials shared by every car of a model are never touched: fading or disposing them would hit
   * all the other cars too.
   */
  private ownMaterials(withInside: boolean): Set<THREE.Material> {
    const out = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) if (!isShared(m) && (withInside || !this.inside.has(m))) out.add(m);
    });
    if (withInside) for (const m of this.inside) out.add(m);
    return out;
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

  setPaint(color: number): void { this.parts.setPaint(color); }

  setHighBeam(on: boolean): void {
    for (const beam of this.headlights) {
      const side = Math.sign(beam.position.x);
      beam.intensity = on ? 1500 : 520;
      beam.distance = on ? 240 : 120;
      beam.angle = on ? .32 : .46;
      beam.penumbra = on ? .65 : .8;
      beam.target.position.set(side * (this.parts.lampX + (on ? .6 : 1.4)), on ? .65 : 0, this.parts.lamp.z - (on ? 110 : 40));
    }
  }

  /** First-person view: draw the interior, skip the wheels (never seen from inside). */
  setCockpit(on: boolean): void {
    this.cockpitOn = on && this.parts.cockpit !== null;
    if (this.parts.cockpit) this.parts.cockpit.group.visible = this.cockpitOn;
    this.parts.wheelRoot.visible = !this.cockpitOn;
    this.parts.setCockpit?.(this.cockpitOn);
    this.applyGhost();
  }

  /** Online spawn protection: the car is drawn see-through while traffic passes through it. */
  setGhost(on: boolean): void {
    if (on === this.ghost) return;
    this.ghost = on;
    this.applyGhost();
  }

  private applyGhost(): void {
    const on = this.ghost;
    // The generated Porsche cluster and the alternate cockpit surfaces must fade with the body too.
    for (const m of this.ownMaterials(true)) {
      const base = (m.userData.baseOpacity ??= m.opacity) as number;
      const baseTransparent = (m.userData.baseTransparent ??= m.transparent) as boolean;
      const baseDepthWrite = (m.userData.baseDepthWrite ??= m.depthWrite) as boolean;
      const transparent = on || baseTransparent;
      const changed = m.transparent !== transparent;
      m.transparent = transparent;
      m.opacity = on ? base * 0.35 : base;
      m.depthWrite = on ? false : baseDepthWrite;
      if (changed) m.needsUpdate = true;
    }
  }

  update(dt: number, car: PlayerCar, pos: THREE.Vector3, yaw: number, remote = false): void {
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const p = this.parts;
    this.root.position.copy(pos);
    this.root.rotation.y = -yaw;
    // Suspension feel: nose dives under braking, body rolls out of the turn.
    this.pitch = damp(this.pitch, clamp(car.accLong * 0.004, -0.04, 0.03), 8, dt);
    this.roll = damp(this.roll, clamp(car.accLat * 0.005, -0.05, 0.05), 8, dt);
    p.body.rotation.set(this.pitch, 0, this.roll);
    if (remote) {
      // Remote physics instances contain default/stale omega, not network telemetry. Until the
      // coordinator wires this optional presentation tuple, show honest signed rolling fallback.
      const source = this.remoteSource ??= { vx: 0, vy: 0, r: 0, steerAngle: 0, tune: car.tune };
      source.vx = car.vx; source.vy = car.vy; source.r = car.r; source.steerAngle = car.steerAngle;
      source.tune = car.tune;
      source.omega = (car as PlayerCar & { visualWheelOmega?: ArrayLike<number> }).visualWheelOmega;
      sampleTyreFeedback(source, this.tyreFeedback);
    } else sampleTyreFeedback(car, this.tyreFeedback);
    for (let i = 0; i < 4; i++) this.wheelAngles[i] = (this.wheelAngles[i] + this.tyreFeedback.wheels[i].omega * dt) % (Math.PI * 2);
    // Keep phase advancing in cockpit/bumper views so switching cameras never resumes stale wheels.
    p.wheels.update(car.steerAngle, this.wheelAngles[0], this.wheelAngles);
    p.tail.color.copy(car.brake > 0.05 ? p.tailBrake : p.tailIdle);
    // Turn signals: a new side starts lit, like a real relay.
    if (car.blinker !== this.blinkSide) {
      this.blinkSide = car.blinker;
      this.blinkT = 0;
    } else this.blinkT += dt;
    this.blinkLit = this.blinkSide !== 0 && this.blinkT % BLINK_PERIOD < BLINK_LIT;
    p.indicators.set(this.blinkLit && this.blinkSide === 1, this.blinkLit && this.blinkSide === 2, car.brake > 0.05);
    if (p.updateCabin) p.updateCabin(car, dt);
    else if (this.cockpitOn||this.car===1) p.cockpit?.update(car, dt);
  }

  /** Take it out of the scene and free its materials (geometry is shared between cars of a model). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReady();
    this.parts.dispose?.();
    this.root.removeFromParent();
    for (const m of this.ownMaterials(true)) if (!this.parts.managedMaterials?.has(m)) m.dispose();
  }
}
