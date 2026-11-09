import * as THREE from 'three';
import { damp } from '../../core/math';
import type { PlayerCar } from '../../sim/vehicle';
import type { Cockpit } from './r34Interior';

/** Use the authored Mercedes cabin; no substitute cluster geometry or guessed needle axes. */
export class W204Cockpit implements Cockpit {
  readonly group = new THREE.Group();
  readonly eye = new THREE.Object3D();
  private wheel?: THREE.Object3D;
  private readonly rest = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private angle = 0;

  constructor(body: THREE.Group) {
    this.eye.position.set(-.344, 1.16, .17);
    body.add(this.eye, this.group);
  }

  attach(model: THREE.Group): void {
    this.wheel = model.getObjectByName('SteeringWheel');
    if (this.wheel) this.rest.copy(this.wheel.quaternion);
    // Read before attaching to the suspended/moving body: these are model-world coordinates.
    const anchor = model.getObjectByName('CockpitCamera');
    if (anchor) anchor.getWorldPosition(this.eye.position);
  }

  update(car: PlayerCar, dt: number): void {
    const real = car.steerAngle * 13.5, felt = car.steerIn * 1.75;
    this.angle = damp(this.angle, Math.abs(real) >= Math.abs(felt) ? real : felt, 14, dt);
    // Authored local +Y points toward the driver; right input turns clockwise.
    this.wheel?.quaternion.copy(this.rest).multiply(this.turn.setFromAxisAngle(this.axis, -this.angle));
  }
}
