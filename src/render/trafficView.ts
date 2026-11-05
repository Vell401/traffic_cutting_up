import * as THREE from 'three';
import { lerp } from '../core/math';
import type { RoadPoint } from '../sim/road';
import { MAX_TRAFFIC, type TrafficCar } from '../sim/traffic';
import type { Box } from '../sim/vehicles';
import type { Sim } from '../sim/world';

const TAIL = new THREE.Color(0.9, 0.04, 0.03);
const TAIL_BRAKE = new THREE.Color(4.5, 0.16, 0.1);
const HEAD = new THREE.Color(2.4, 2.25, 1.9);
const BLINK_ON = new THREE.Color(3.2, 1.45, 0.08);
const BLINK_OFF = new THREE.Color(0.1, 0.05, 0.01);
const LIGHTS_PER_CAR = 6;

/**
 * All traffic in four draw calls: body boxes, glass/cargo boxes, every light, blob shadows.
 * Per-instance colour carries paint, brake state and blinkers.
 */
export class TrafficView {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh;
  private readonly top: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly col = new THREE.Color();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private cos = 1;
  private sin = 0;
  private wx = 0;
  private wz = 0;

  constructor(shadowTex: THREE.Texture) {
    const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const lightBox = new THREE.BoxGeometry(1, 1, 1);
    this.body = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.35 }), MAX_TRAFFIC);
    this.top = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.4 }), MAX_TRAFFIC);
    this.lights = new THREE.InstancedMesh(lightBox, new THREE.MeshBasicMaterial(), MAX_TRAFFIC * LIGHTS_PER_CAR);
    this.shadows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: 0.75, depthWrite: false }),
      MAX_TRAFFIC,
    );
    this.shadows.renderOrder = 1;
    for (const im of [this.body, this.top, this.lights, this.shadows]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
    }
    // Allocate instance colour buffers up front.
    this.body.setColorAt(0, this.col.set(1, 1, 1));
    this.top.setColorAt(0, this.col);
    this.lights.setColorAt(0, this.col);
  }

  update(sim: Sim, alpha: number, ox: number, oz: number, time: number): void {
    const road = sim.road;
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

      const spec = c.spec;
      this.place(this.body, n, spec.box1, c.color);
      this.place(this.top, n, spec.box2, c.color2);

      this.at(0, 0.03, 0);
      this.sc.set(spec.wid * 1.5, 1, spec.len * 1.25);
      this.m.compose(this.p, this.q, this.sc);
      this.shadows.setMatrixAt(n, this.m);

      li = this.carLights(c, li, blinkOn);
      n++;
    }
    for (const im of [this.body, this.top, this.shadows]) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
    this.lights.count = li;
    this.lights.instanceMatrix.needsUpdate = true;
    this.body.instanceColor!.needsUpdate = true;
    this.top.instanceColor!.needsUpdate = true;
    this.lights.instanceColor!.needsUpdate = true;
  }

  /** World (origin-relative) position of a car-local point; car faces -Z, +Z is the rear. */
  private at(lx: number, ly: number, lz: number): void {
    // Car heading yaw maps to rotation.y = -yaw: local (lx, lz) → world.
    const c = this.cos;
    const s = this.sin;
    this.p.set(this.wx + lx * c - lz * s, ly, this.wz + lx * s + lz * c);
  }

  private place(im: THREE.InstancedMesh, i: number, b: Box, color: number): void {
    this.at(0, b.y, b.z);
    this.sc.set(b.w, b.h, b.l);
    this.m.compose(this.p, this.q, this.sc);
    im.setMatrixAt(i, this.m);
    im.setColorAt(i, this.col.setHex(color));
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
    const hl = spec.len / 2;
    const hw = spec.wid / 2;
    const y = spec.lightY;
    const tail = c.braking ? TAIL_BRAKE : TAIL;
    this.light(i++, -(hw - 0.3), y, hl + 0.02, 0.4, 0.13, tail);
    this.light(i++, hw - 0.3, y, hl + 0.02, 0.4, 0.13, tail);
    this.light(i++, -(hw - 0.32), y - 0.08, -hl - 0.02, 0.36, 0.1, HEAD);
    this.light(i++, hw - 0.32, y - 0.08, -hl - 0.02, 0.36, 0.1, HEAD);
    const left = blinkOn && (c.blink === -1 || c.blink === 2);
    const right = blinkOn && (c.blink === 1 || c.blink === 2);
    this.light(i++, -(hw - 0.06), y + 0.1, hl + 0.025, 0.12, 0.1, left ? BLINK_ON : BLINK_OFF);
    this.light(i++, hw - 0.06, y + 0.1, hl + 0.025, 0.12, 0.1, right ? BLINK_ON : BLINK_OFF);
    return i;
  }
}
