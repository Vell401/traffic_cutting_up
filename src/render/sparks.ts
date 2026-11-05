import * as THREE from 'three';
import { makeRadialTexture } from './textures';

const MAX = 480;
const HOT = new THREE.Color(4.5, 2.1, 0.6);
const GRAVITY = 9.8;

/**
 * Sparks from barrier scrapes and crashes: a fixed pool of additive points, simulated on the CPU in
 * world coordinates (doubles) and drawn relative to the floating origin. Colours above 1 feed the bloom.
 */
export class Sparks {
  readonly points: THREE.Points;
  private readonly wx = new Float64Array(MAX);
  private readonly wy = new Float64Array(MAX);
  private readonly wz = new Float64Array(MAX);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly maxLife = new Float32Array(MAX).fill(1);
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private next = 0;
  private alive = 0;

  constructor() {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.26,
        sizeAttenuation: true,
        map: makeRadialTexture(32, 1.2),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /** Emit `count` sparks at a world point, inheriting (vx, vz) plus a random spray of `spread` m/s. */
  emit(x: number, y: number, z: number, vx: number, vz: number, count: number, spread: number): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.wx[i] = x;
      this.wy[i] = y;
      this.wz[i] = z;
      const a = Math.random() * Math.PI * 2;
      const s = spread * (0.3 + Math.random() * 0.7);
      this.vel[i * 3] = vx + Math.cos(a) * s;
      this.vel[i * 3 + 1] = 1 + Math.random() * spread * 0.6;
      this.vel[i * 3 + 2] = vz + Math.sin(a) * s;
      const l = 0.25 + Math.random() * 0.45;
      this.life[i] = l;
      this.maxLife[i] = l;
    }
    this.alive = MAX;
  }

  update(dt: number, ox: number, oz: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) {
        this.col[o] = this.col[o + 1] = this.col[o + 2] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      this.vel[o + 1] -= GRAVITY * dt;
      this.wx[i] += this.vel[o] * dt;
      this.wy[i] += this.vel[o + 1] * dt;
      this.wz[i] += this.vel[o + 2] * dt;
      if (this.wy[i] < 0.02) {
        this.wy[i] = 0.02;
        this.vel[o + 1] *= -0.3;
        this.vel[o] *= 0.7;
        this.vel[o + 2] *= 0.7;
      }
      const k = Math.pow(Math.max(0, this.life[i] / this.maxLife[i]), 1.5);
      this.pos[o] = this.wx[i] - ox;
      this.pos[o + 1] = this.wy[i];
      this.pos[o + 2] = this.wz[i] - oz;
      this.col[o] = HOT.r * k;
      this.col[o + 1] = HOT.g * k;
      this.col[o + 2] = HOT.b * k;
    }
    this.alive = alive;
    const g = this.points.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
  }
}
