import * as THREE from 'three';
import { damp } from '../../core/math';
import type { PlayerCar } from '../../sim/vehicle';
import type { Cockpit } from './r34Interior';
import { W204Instruments } from './w204Instruments';

/** Keep the authored Mercedes cabin, dial faces, needles and LCD mounting surfaces. */
export class W204Cockpit implements Cockpit {
  readonly group = new THREE.Group();
  readonly eye = new THREE.Object3D();
  private wheel?: THREE.Object3D;
  private readonly rest = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private angle = 0;
  private instruments?: W204Instruments;
  private highBeam = false;
  private externalSignals = false;
  private left = false;
  private right = false;
  private blinkSide = 0;
  private blinkT = 0;
  private disposed = false;

  constructor(body: THREE.Group) {
    this.eye.position.set(-.344, 1.16, .17);
    body.add(this.eye, this.group);
    // The model adapter owns body.clear(); removal also releases private LCD/glyph resources.
    // No change to the shared GLB loader/material cache is needed.
    this.group.addEventListener('removed', () => this.dispose());
  }

  attach(model: THREE.Group): void {
    if (this.disposed) return;
    this.instruments?.dispose();
    this.wheel = model.getObjectByName('SteeringWheel');
    if (this.wheel) this.rest.copy(this.wheel.quaternion);
    // Read before attaching to the suspended/moving body: these are model-world coordinates.
    const anchor = model.getObjectByName('CockpitCamera');
    if (anchor) anchor.getWorldPosition(this.eye.position);
    this.instruments = new W204Instruments(model);
  }

  setHighBeam(on: boolean): void { this.highBeam = on; }
  /** PlayerView supplies the same relay phase used by the exterior lamps and click sound. */
  setSignals(left: boolean, right: boolean): void { this.externalSignals = true; this.left = left; this.right = right; }

  update(car: PlayerCar, dt: number): void {
    if (this.disposed) return;
    const real = car.steerAngle * 13.5, felt = car.steerIn * 1.75;
    this.angle = damp(this.angle, Math.abs(real) >= Math.abs(felt) ? real : felt, 14, dt);
    // Authored local +Y points toward the driver; right input turns clockwise.
    this.wheel?.quaternion.copy(this.rest).multiply(this.turn.setFromAxisAngle(this.axis, -this.angle));
    if (car.blinker !== this.blinkSide) { this.blinkSide = car.blinker; this.blinkT = 0; }
    else if (Number.isFinite(dt)) this.blinkT += Math.max(0, dt);
    for (let node: THREE.Object3D | null = this.group; node; node = node.parent) if (!node.visible) return;
    const lit = this.blinkSide !== 0 && this.blinkT % .7 < .38;
    this.instruments?.update(car, dt, this.highBeam, this.externalSignals ? this.left : lit && this.blinkSide === 1, this.externalSignals ? this.right : lit && this.blinkSide === 2);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.instruments?.dispose();
  }
}
