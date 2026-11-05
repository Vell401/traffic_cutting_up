import * as THREE from 'three';
import { lerp } from '../core/math';
import type { RoadPoint } from '../sim/road';
import { MAX_TRAFFIC, type TrafficCar } from '../sim/traffic';
import { VEHICLES } from '../sim/vehicles';
import type { Sim } from '../sim/world';
import { buildVehicle, buildWheel, type VehicleModel } from './carModels';

const TAIL = new THREE.Color(0.9, 0.04, 0.03);
const TAIL_BRAKE = new THREE.Color(4.5, 0.16, 0.1);
const HEAD = new THREE.Color(2.4, 2.25, 1.9);
const BLINK_ON = new THREE.Color(3.2, 1.45, 0.08);
const BLINK_OFF = new THREE.Color(0.1, 0.05, 0.01);
const LIGHTS_PER_CAR = 6;
/** Lamps sit this far beyond the nominal length so they clear the bevelled body. */
const LAMP_OUT = 0.08;

interface TypeMeshes {
  model: VehicleModel;
  body: THREE.InstancedMesh;
  cargo: THREE.InstancedMesh | null;
  count: number;
}

/**
 * Traffic drawn with one instanced mesh per vehicle type (plus cargo boxes for trucks), all wheels in
 * one instanced mesh, every lamp in another and the blob shadows in a third: ~12 draw calls for up to
 * 72 vehicles. Per-instance colour carries paint, cargo colour, brake state and blinkers.
 */
export class TrafficView {
  readonly group = new THREE.Group();
  private readonly types = new Map<string, TypeMeshes>();
  private readonly wheels: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qWheel = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly col = new THREE.Color();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private cos = 1;
  private sin = 0;
  private wx = 0;
  private wz = 0;
  private wheelCount = 0;

  constructor(shadowTex: THREE.Texture) {
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    const cargo = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
    for (const spec of VEHICLES) {
      const model = buildVehicle(spec.name, spec.len, spec.wid);
      const body = this.instanced(model.body, paint, MAX_TRAFFIC);
      const cargoMesh = model.cargo ? this.instanced(model.cargo, cargo, MAX_TRAFFIC) : null;
      this.types.set(spec.name, { model, body, cargo: cargoMesh, count: 0 });
    }
    this.wheels = this.instanced(buildWheel(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }), MAX_TRAFFIC * 4);
    this.lights = this.instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), MAX_TRAFFIC * LIGHTS_PER_CAR);
    this.shadows = this.instanced(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: 0.75, depthWrite: false }),
      MAX_TRAFFIC,
    );
    this.shadows.renderOrder = 1;
  }

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.count = 0;
    im.setColorAt(0, this.col.set(1, 1, 1));
    this.group.add(im);
    return im;
  }

  update(sim: Sim, alpha: number, ox: number, oz: number, time: number): void {
    const road = sim.road;
    for (const t of this.types.values()) t.count = 0;
    this.wheelCount = 0;
    let n = 0;
    let li = 0;
    const blinkOn = time % 0.8 < 0.4;
    for (const c of sim.traffic.cars) {
      if (!c.active) continue;
      const s = lerp(c.prevS, c.s, alpha);
      const d = lerp(c.prevD, c.d, alpha);
      const yawLocal = lerp(c.prevYaw, c.yaw, alpha);
      road.toWorld(s, d, this.pt);
      const yaw = this.pt.th + yawLocal;
      this.cos = Math.cos(yaw);
      this.sin = Math.sin(yaw);
      this.wx = this.pt.x - ox;
      this.wz = this.pt.z - oz;
      this.q.setFromAxisAngle(this.up, -yaw);

      const t = this.types.get(c.spec.name)!;
      this.sc.set(1, 1, 1);
      this.at(0, 0, 0);
      this.m.compose(this.p, this.q, this.sc);
      t.body.setMatrixAt(t.count, this.m);
      t.body.setColorAt(t.count, this.col.setHex(c.color));
      if (t.cargo) {
        t.cargo.setMatrixAt(t.count, this.m);
        t.cargo.setColorAt(t.count, this.col.setHex(c.color2));
      }
      t.count++;

      this.placeWheels(t.model, c);

      this.at(0, 0.03, 0);
      this.sc.set(c.spec.wid * 1.5, 1, c.spec.len * 1.25);
      this.m.compose(this.p, this.q, this.sc);
      this.shadows.setMatrixAt(n, this.m);

      li = this.carLights(c, li, blinkOn);
      n++;
    }
    for (const t of this.types.values()) {
      for (const im of t.cargo ? [t.body, t.cargo] : [t.body]) {
        im.count = t.count;
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor!.needsUpdate = true;
      }
    }
    this.shadows.count = n;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.wheels.count = this.wheelCount;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.lights.count = li;
    this.lights.instanceMatrix.needsUpdate = true;
    this.lights.instanceColor!.needsUpdate = true;
  }

  /** Origin-relative world position of a car-space point (car faces -Z, +Z is the rear). */
  private at(lx: number, ly: number, lz: number): void {
    const c = this.cos;
    const s = this.sin;
    this.p.set(this.wx + lx * c - lz * s, ly, this.wz + lx * s + lz * c);
  }

  private placeWheels(model: VehicleModel, c: TrafficCar): void {
    // Rolling is invisible at night; crashed cars keep their wheels where they are.
    this.qWheel.copy(this.q);
    for (const axle of model.axles) {
      const x = c.spec.wid / 2 - axle.width / 2 - 0.02;
      for (const side of [-1, 1]) {
        this.at(side * x, axle.r, -axle.f);
        this.sc.set(axle.width, axle.r, axle.r);
        this.m.compose(this.p, this.qWheel, this.sc);
        this.wheels.setMatrixAt(this.wheelCount++, this.m);
      }
    }
  }

  private light(i: number, lx: number, ly: number, lz: number, w: number, h: number, color: THREE.Color): void {
    this.at(lx, ly, lz);
    this.sc.set(w, h, 0.05);
    this.m.compose(this.p, this.q, this.sc);
    this.lights.setMatrixAt(i, this.m);
    this.lights.setColorAt(i, color);
  }

  private carLights(c: TrafficCar, i: number, blinkOn: boolean): number {
    const spec = c.spec;
    const rear = spec.len / 2 + LAMP_OUT;
    const front = -spec.len / 2 - LAMP_OUT;
    const hw = spec.wid / 2;
    const y = spec.lightY;
    const tail = c.braking ? TAIL_BRAKE : TAIL;
    this.light(i++, -(hw - 0.3), y, rear, 0.4, 0.13, tail);
    this.light(i++, hw - 0.3, y, rear, 0.4, 0.13, tail);
    this.light(i++, -(hw - 0.34), y - 0.08, front, 0.36, 0.1, HEAD);
    this.light(i++, hw - 0.34, y - 0.08, front, 0.36, 0.1, HEAD);
    const left = blinkOn && (c.blink === -1 || c.blink === 2);
    const right = blinkOn && (c.blink === 1 || c.blink === 2);
    this.light(i++, -(hw - 0.08), y + 0.1, rear + 0.005, 0.12, 0.1, left ? BLINK_ON : BLINK_OFF);
    this.light(i++, hw - 0.08, y + 0.1, rear + 0.005, 0.12, 0.1, right ? BLINK_ON : BLINK_OFF);
    return i;
  }
}
