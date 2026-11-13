import * as THREE from 'three';
import type { TyreFeedback } from '../presentation/tyres';

export const TYRE_EFFECT_BUDGET = Object.freeze({ smoke: 240, skids: 1536, smokePerWheelSecond: 42, skidLife: 24, draws: 2 });

/** Fractional emission credits are per contact, not per rendered frame. */
export class TyreEmissionClock {
  private readonly credit = new Float64Array(4);
  take(wheel: number, intensity: number, dt: number): number {
    if (!(dt > 0)) return 0;
    if (!(intensity > .025)) { this.credit[wheel] = 0; return 0; }
    const total = this.credit[wheel] + Math.min(1, intensity) * TYRE_EFFECT_BUDGET.smokePerWheelSecond * Math.min(dt, .1);
    const count = Math.floor(total + 1e-9);
    this.credit[wheel] = Math.max(0, total - count);
    return count;
  }
  reset(): void { this.credit.fill(0); }
}

const smokeVertex = `
attribute vec3 centre;
attribute vec3 puff;
varying vec2 vUv;
varying vec2 vPuff;
void main() {
  vUv = uv; vPuff = puff.yz;
  vec4 eye = modelViewMatrix * vec4(centre, 1.0);
  eye.xy += position.xy * puff.x;
  gl_Position = projectionMatrix * eye;
}`;
const smokeFragment = `
varying vec2 vUv;
varying vec2 vPuff;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float a = vPuff.y * 6.2831853, c=cos(a), s=sin(a);
  p = mat2(c,-s,s,c)*p;
  float n = noise(p*3.8+vPuff.y*41.0);
  float fine = noise(p*9.0+n*2.0+vPuff.y*17.0);
  float edge = 1.0-smoothstep(.22,1.0,length(p)+(.5-n)*.29);
  float alpha = edge * (.32+.68*n) * (.65+.35*fine) * vPuff.x;
  if(alpha < .002) discard;
  gl_FragColor = vec4(mix(vec3(.34,.37,.40),vec3(.65,.67,.69),n), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Two fixed GPU pools. World-space doubles survive origin shifts and road-ring seams. */
export class TyreEffects {
  readonly group = new THREE.Group();
  readonly smoke: THREE.Mesh;
  readonly skids: THREE.InstancedMesh;
  readonly emission = new TyreEmissionClock();
  private readonly centres = new Float32Array(TYRE_EFFECT_BUDGET.smoke * 3);
  private readonly puffs = new Float32Array(TYRE_EFFECT_BUDGET.smoke * 3);
  private readonly world = new Float64Array(TYRE_EFFECT_BUDGET.smoke * 3);
  private readonly velocity = new Float32Array(TYRE_EFFECT_BUDGET.smoke * 3);
  private readonly life = new Float32Array(TYRE_EFFECT_BUDGET.smoke);
  private readonly duration = new Float32Array(TYRE_EFFECT_BUDGET.smoke);
  private readonly power = new Float32Array(TYRE_EFFECT_BUDGET.smoke);
  private readonly seed = new Float32Array(TYRE_EFFECT_BUDGET.smoke);
  private readonly markWorld = new Float64Array(TYRE_EFFECT_BUDGET.skids * 4);
  private readonly markLife = new Float32Array(TYRE_EFFECT_BUDGET.skids);
  private readonly markPower = new Float32Array(TYRE_EFFECT_BUDGET.skids);
  private readonly markAlpha = new Float32Array(TYRE_EFFECT_BUDGET.skids);
  private readonly markDirty = new Uint8Array(TYRE_EFFECT_BUDGET.skids);
  private readonly last = new Float64Array(8);
  private readonly trail = new Uint8Array(4);
  private nextSmoke = 0;
  private nextMark = 0;
  private smokeEmitted = 0;
  private marksEmitted = 0;
  private smokeAlive = 0;
  private marksAlive = 0;
  private smokePending = false;
  private marksPending = false;
  private ox = NaN;
  private oz = NaN;
  private disposed = false;
  private readonly contact = new THREE.Vector3();
  private readonly dummy = new THREE.Object3D();

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    geometry.setAttribute('centre', new THREE.InstancedBufferAttribute(this.centres, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('puff', new THREE.InstancedBufferAttribute(this.puffs, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount = TYRE_EFFECT_BUDGET.smoke;
    this.smoke = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: smokeVertex, fragmentShader: smokeFragment, transparent: true, depthWrite: false }));
    this.smoke.frustumCulled = false; this.smoke.renderOrder = 3;
    this.smoke.visible = false;
    const skidGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    skidGeo.setAttribute('markAlpha', new THREE.InstancedBufferAttribute(this.markAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.skids = new THREE.InstancedMesh(skidGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      vertexShader: `attribute float markAlpha; varying vec2 vUv; varying float vAlpha;
        void main(){vUv=uv;vAlpha=markAlpha;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
        if(markAlpha<=0.0)gl_Position=vec4(2.0,2.0,2.0,1.0);}`,
      fragmentShader: `varying vec2 vUv; varying float vAlpha;
        void main(){float edge=smoothstep(0.0,.12,vUv.x)*smoothstep(0.0,.12,1.0-vUv.x);
        float grain=.77+.23*sin(vUv.x*115.0);gl_FragColor=vec4(.012,.014,.016,vAlpha*edge*grain);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    }), TYRE_EFFECT_BUDGET.skids);
    this.skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.skids.frustumCulled = false; this.skids.renderOrder = 1;
    this.skids.visible = false;
    this.group.add(this.skids, this.smoke);
    this.group.name = 'TyreEffects/pooled';
  }

  /** `contact` writes this frame's rendered wheel pose, relative to the current origin. */
  emit(dt: number, feedback: TyreFeedback, contact: (i: number, out: THREE.Vector3) => THREE.Vector3,
    yaw: number, steer: number, ox: number, oz: number, enabled = true): void {
    if (this.disposed || !(dt > 0)) return;
    if (!enabled) { this.resetTrails(); return; }
    for (let i = 0; i < 4; i++) {
      const w = feedback.wheels[i];
      contact(i, this.contact);
      const x = this.contact.x + ox, z = this.contact.z + oz;
      const angle = yaw + (i < 2 ? steer : 0), fx = Math.sin(angle), fz = -Math.cos(angle);
      // Contact-frame transport, not a rear-facing wind tied to the previous car yaw.
      const vx = (fx * w.contactLongitudinal + Math.cos(angle) * w.contactLateral) * .24 - fx * w.longitudinalSlipSpeed * .035;
      const vz = (fz * w.contactLongitudinal + Math.sin(angle) * w.contactLateral) * .24 - fz * w.longitudinalSlipSpeed * .035;
      const count = this.emission.take(i, w.normalLoad > 100 ? w.smokeIntensity : 0, dt);
      for (let k = 0; k < count; k++) this.puff(x, this.contact.y + .08, z, vx, vz, w.smokeIntensity);
      const contactSpeed = Math.hypot(w.contactLongitudinal, w.contactLateral);
      const rubbing = w.normalLoad > 100 && w.slipIntensity > .18;
      if (!rubbing) { this.trail[i] = 0; continue; }
      const o = i * 2, dx = x - this.last[o], dz = z - this.last[o + 1], distance = Math.hypot(dx, dz);
      if (contactSpeed < .45) {
        // A stationary burnout leaves a contact patch, not a long trail or new geometry each frame.
        if (!this.trail[i] && Math.abs(w.longitudinalSlipSpeed) > 2) this.mark(x - fx * .09, z - fz * .09, x + fx * .09, z + fz * .09, w.slipIntensity);
        this.last[o] = x; this.last[o + 1] = z; this.trail[i] = 1;
        continue;
      }
      if (this.trail[i] && distance >= .16 && distance < 4) {
        this.mark(this.last[o], this.last[o + 1], x, z, w.slipIntensity);
      } else if (this.trail[i] && distance < .16) continue;
      this.last[o] = x; this.last[o + 1] = z; this.trail[i] = 1;
    }
  }

  private puff(x: number, y: number, z: number, vx: number, vz: number, intensity: number): void {
    const i = this.nextSmoke, o = i * 3;
    this.nextSmoke = (i + 1) % TYRE_EFFECT_BUDGET.smoke; this.smokeEmitted++;
    this.smokePending = true;
    this.world[o] = x + (Math.random() - .5) * .13; this.world[o + 1] = y; this.world[o + 2] = z + (Math.random() - .5) * .13;
    this.velocity[o] = vx + (Math.random() - .5) * .5;
    this.velocity[o + 1] = .32 + Math.random() * .38;
    this.velocity[o + 2] = vz + (Math.random() - .5) * .5;
    this.life[i] = this.duration[i] = 1.1 + Math.random() * .65;
    this.power[i] = intensity; this.seed[i] = Math.random();
  }

  private mark(ax: number, az: number, bx: number, bz: number, intensity: number): void {
    const i = this.nextMark, o = i * 4;
    this.nextMark = (i + 1) % TYRE_EFFECT_BUDGET.skids; this.marksEmitted++;
    this.marksPending = true;
    this.markWorld[o] = ax; this.markWorld[o + 1] = az; this.markWorld[o + 2] = bx; this.markWorld[o + 3] = bz;
    this.markLife[i] = TYRE_EFFECT_BUDGET.skidLife; this.markPower[i] = intensity;
    this.markDirty[i] = 1;
  }

  update(dt: number, ox: number, oz: number): void {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const rebase = ox !== this.ox || oz !== this.oz;
    let centresDirty = false, puffsDirty = false, matricesDirty = false, alphaDirty = false;
    if ((this.smokeAlive || this.smokePending) && (dt > 0 || rebase || this.smokePending)) {
      this.smokeAlive = 0;
      for (let i = 0; i < TYRE_EFFECT_BUDGET.smoke; i++) {
        const o = i * 3;
        this.life[i] = Math.max(0, this.life[i] - dt);
        if (!this.life[i]) {
          if (this.puffs[o] || this.puffs[o + 1]) puffsDirty = true;
          this.puffs[o] = this.puffs[o + 1] = 0; continue;
        }
        this.smokeAlive++;
        const drag = Math.exp(-dt * .65), travel = (1 - drag) / .65;
        this.world[o] += this.velocity[o] * travel; this.world[o + 2] += this.velocity[o + 2] * travel;
        this.velocity[o] *= drag; this.velocity[o + 2] *= drag;
        this.world[o + 1] += this.velocity[o + 1] * dt;
        const age = 1 - this.life[i] / this.duration[i];
        this.centres[o] = this.world[o] - ox; this.centres[o + 1] = this.world[o + 1]; this.centres[o + 2] = this.world[o + 2] - oz;
        this.puffs[o] = .28 + age * (1.45 + this.power[i] * .65);
        this.puffs[o + 1] = (.13 + this.power[i] * .15) * Math.min(1, age * 12) * (1 - age) ** 1.6;
        this.puffs[o + 2] = this.seed[i] + age * .045;
        centresDirty = true;
        if (dt > 0 || this.smokePending) puffsDirty = true;
      }
    }
    this.smoke.visible = this.smokeAlive > 0;
    if (centresDirty) this.smoke.geometry.getAttribute('centre').needsUpdate = true;
    if (puffsDirty) this.smoke.geometry.getAttribute('puff').needsUpdate = true;
    if ((this.marksAlive || this.marksPending) && (dt > 0 || rebase || this.marksPending)) {
      this.marksAlive = 0;
      for (let i = 0; i < TYRE_EFFECT_BUDGET.skids; i++) {
        this.markLife[i] = Math.max(0, this.markLife[i] - dt);
        const alpha = this.markAlpha[i];
        this.markAlpha[i] = this.markLife[i] ? .38 * this.markPower[i] * Math.min(1, this.markLife[i] / 6) : 0;
        if (alpha !== this.markAlpha[i]) alphaDirty = true;
        if (!this.markLife[i]) continue;
        this.marksAlive++;
        const o = i * 4, ax = this.markWorld[o], az = this.markWorld[o + 1], bx = this.markWorld[o + 2], bz = this.markWorld[o + 3];
        if (this.markDirty[i]) {
          // A mark's orientation/size never changes. Keep Three's exact composition for new/reused
          // slots; thereafter only floating-origin translation changes (same Float32 rounding).
          this.dummy.position.set((ax + bx) * .5 - ox, .018, (az + bz) * .5 - oz);
          this.dummy.rotation.set(0, Math.atan2(bx - ax, bz - az), 0);
          this.dummy.scale.set(.205, 1, Math.hypot(bx - ax, bz - az) + .035);
          this.dummy.updateMatrix(); this.skids.setMatrixAt(i, this.dummy.matrix);
          this.markDirty[i] = 0;
          matricesDirty = true;
        } else if (rebase) {
          const matrix = this.skids.instanceMatrix.array, m = i * 16;
          matrix[m + 12] = (ax + bx) * .5 - ox;
          matrix[m + 14] = (az + bz) * .5 - oz;
          matricesDirty = true;
        }
      }
    }
    this.skids.visible = this.marksAlive > 0;
    if (matricesDirty) this.skids.instanceMatrix.needsUpdate = true;
    if (alphaDirty) this.skids.geometry.getAttribute('markAlpha').needsUpdate = true;
    this.smokePending = this.marksPending = false;
    this.ox = ox; this.oz = oz;
  }

  resetTrails(): void { this.trail.fill(0); this.emission.reset(); }
  get stats(): { smokeEmitted: number; marksEmitted: number; smokeAlive: number; marksAlive: number } {
    return { smokeEmitted: this.smokeEmitted, marksEmitted: this.marksEmitted,
      smokeAlive: this.life.reduce((n, l) => n + Number(l > 0), 0), marksAlive: this.markLife.reduce((n, l) => n + Number(l > 0), 0) };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.smoke.geometry.dispose(); (this.smoke.material as THREE.Material).dispose();
    this.skids.geometry.dispose(); (this.skids.material as THREE.Material).dispose(); this.skids.dispose();
    this.group.removeFromParent(); this.resetTrails(); this.life.fill(0); this.markLife.fill(0);
  }
}
