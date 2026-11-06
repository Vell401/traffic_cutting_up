import * as THREE from 'three';
import { lerp } from '../core/math';
import type { RoadPoint } from '../sim/road';
import { MAX_TRAFFIC, type TrafficCar } from '../sim/traffic';
import { VEHICLES } from '../sim/vehicles';
import type { Sim } from '../sim/world';
import { buildModel, defaults, type Kind, type LOD } from './trafficModels';

interface Batch {
  meshes: THREE.InstancedMesh[];
  signals: THREE.InstancedBufferAttribute;
  count: number;
}

/** Three draws per occupied type/LOD, plus shared blob shadows. Wheels are baked in.
 * Cargo tint and lamp states use semantic attributes, not extra per-car meshes.
 */
export class TrafficView {
  readonly group = new THREE.Group();
  private readonly types = new Map<string, Batch[]>();
  private readonly levels = new WeakMap<TrafficCar, { gen: number; lod: LOD }>();
  private readonly shadows: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly col = new THREE.Color();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly eye: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };

  constructor(shadowTex: THREE.Texture) {
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: defaults.roughness, metalness: defaults.metalness });
    const neutral = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .7, metalness: .1 });
    neutral.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float partRole;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `
        #include <color_vertex>
        vColor.xyz = color.xyz * mix(vec3(1.0), instanceColor, partRole);
      `);
    };
    neutral.customProgramCacheKey = () => 'traffic-cargo-v1';
    const lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    lights.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float partRole;\nattribute vec3 trafficSignal;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `
        #include <color_vertex>
        if (partRole < 1.5) vColor.xyz = vec3(2.4, 2.25, 1.9);
        else if (partRole < 2.5) vColor.xyz = mix(vec3(.9, .04, .03), vec3(2.6, .07, .04), trafficSignal.x);
        else vColor.xyz = mix(vec3(.1, .05, .01), vec3(3.2, 1.45, .08), partRole < 3.5 ? trafficSignal.y : trafficSignal.z);
      `);
    };
    lights.customProgramCacheKey = () => 'traffic-lamps-v1';
    const materials = [paint, neutral, lights];
    for (const spec of VEHICLES) {
      const batches = ([0, 1, 2] as LOD[]).map(lod => {
        // White cargo lets the instance colour select its final shade; neutral details retain theirs.
        const model = buildModel(spec.name as Kind, lod, { ...defaults, cargoColor: '#ffffff' });
        const signals = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAFFIC * 3), 3).setUsage(THREE.DynamicDrawUsage);
        model.parts[2].setAttribute('trafficSignal', signals);
        const meshes = model.parts.map((geo, i) => {
          const mesh = this.instanced(geo, materials[i]);
          mesh.name = `traffic/${spec.name}/lod${lod}/${['body', 'details', 'lights'][i]}`;
          return mesh;
        });
        return { meshes, signals, count: 0 };
      });
      this.types.set(spec.name, batches);
    }
    this.shadows = this.instanced(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0, map: shadowTex, transparent: true, opacity: .75, depthWrite: false }),
    );
    this.shadows.name = 'traffic/shadows';
    this.shadows.renderOrder = 1;
  }

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_TRAFFIC);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.setColorAt(0, this.col.setRGB(1, 1, 1));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  update(sim: Sim, alpha: number, ox: number, oz: number, time: number): void {
    for (const batches of this.types.values()) for (const b of batches) b.count = 0;
    // Distance to the player is independent of floating-origin resets and ring wrapping.
    sim.road.toWorld(lerp(sim.player.prevS, sim.player.s, alpha), lerp(sim.player.prevD, sim.player.d, alpha), this.eye);
    let n = 0;
    const blinkOn = time % .8 < .4;
    for (const c of sim.traffic.cars) {
      if (!c.active) continue;
      sim.road.toWorld(lerp(c.prevS, c.s, alpha), lerp(c.prevD, c.d, alpha), this.pt);
      const distance = Math.hypot(this.pt.x - this.eye.x, this.pt.z - this.eye.z);
      let state = this.levels.get(c);
      if (!state || state.gen !== c.gen) {
        state = { gen: c.gen, lod: distance < 45 ? 0 : distance < 120 ? 1 : 2 };
        this.levels.set(c, state);
      } else {
        // Separate enter/leave distances prevent flicker around a boundary.
        if (state.lod === 0 && distance > 50) state.lod = 1;
        if (state.lod === 1 && distance > 130) state.lod = 2;
        if (state.lod === 2 && distance < 110) state.lod = 1;
        if (state.lod === 1 && distance < 40) state.lod = 0;
      }
      const b = this.types.get(c.spec.name)![state.lod], i = b.count++;
      this.q.setFromAxisAngle(this.up, -(this.pt.th + lerp(c.prevYaw, c.yaw, alpha)));
      this.p.set(this.pt.x - ox, 0, this.pt.z - oz);
      this.sc.set(1, 1, 1);
      this.m.compose(this.p, this.q, this.sc);
      for (const mesh of b.meshes) mesh.setMatrixAt(i, this.m);
      b.meshes[0].setColorAt(i, this.col.setHex(c.color));
      b.meshes[1].setColorAt(i, this.col.setHex(c.color2));
      b.signals.setXYZ(i, Number(c.braking), Number(blinkOn && (c.blink === -1 || c.blink === 2)), Number(blinkOn && (c.blink === 1 || c.blink === 2)));
      this.p.y = .03;
      this.sc.set(c.spec.wid * 1.5, 1, c.spec.len * 1.25);
      this.m.compose(this.p, this.q, this.sc);
      this.shadows.setMatrixAt(n++, this.m);
    }
    for (const batches of this.types.values()) for (const b of batches) {
      for (const mesh of b.meshes) {
        mesh.count = b.count;
        mesh.visible = b.count > 0;
        if (b.count) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; }
      }
      if (b.count) b.signals.needsUpdate = true;
    }
    this.shadows.count = n;
    this.shadows.instanceMatrix.needsUpdate = true;
  }
}
