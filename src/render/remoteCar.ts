import * as THREE from 'three';
import type { CarId } from '../sim/cars';
import type { PlayerCar } from '../sim/vehicle';
import { PlayerView } from './playerView';

/** Screen-door fade: no transparent sorting, extra render pass or changes to shared materials. */
export function revealMaterials(root: THREE.Object3D): { value: number } {
  const amount = { value: 0 };
  const copies = new Map<THREE.Material, THREE.Material>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const copy = (material: THREE.Material) => {
      let m = copies.get(material);
      if (m) return m;
      const programKey = material.customProgramCacheKey();
      m = material.userData.shared ? material.clone() : material;
      delete m.userData.shared;
      const original = material.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        original.call(m!, shader, renderer);
        shader.uniforms.remoteReveal = amount;
        shader.fragmentShader = 'uniform float remoteReveal;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
          #include <clipping_planes_fragment>
          float threshold = fract(dot(floor(gl_FragCoord.xy), vec2(0.75487766, 0.56984029)));
          if (remoteReveal <= threshold) discard;
        `);
      };
      m.customProgramCacheKey = () => `${programKey}/remote-reveal-v1`;
      copies.set(material, m);
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
  });
  return amount;
}

const box = new THREE.BoxGeometry(1, 1, 1);
const tyre = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 8).rotateZ(Math.PI / 2);

/** A cheap distant silhouette remains visible while the detailed car is prepared off-screen. */
export class RemoteCar {
  readonly root = new THREE.Group();
  private readonly proxy = new THREE.Group();
  private readonly paint: THREE.MeshStandardMaterial;
  private detail: PlayerView | null = null;
  private reveal: { value: number } | null = null;
  private disposed = false;
  private preparing = false;
  private fade = 0;

  constructor(readonly car: CarId, private color: number, private readonly shadow: THREE.Texture, private readonly length: number, private readonly width: number) {
    this.paint = new THREE.MeshStandardMaterial({ color, roughness: .55, metalness: .25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x101319, roughness: .8 });
    const lamps = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.4, 2.1) });
    const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, .04, .02) });
    const part = (w: number, h: number, l: number, x: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(box, material);
      mesh.scale.set(w, h, l); mesh.position.set(x, y, z); this.proxy.add(mesh);
    };
    part(width, .55, length, 0, .57, 0, this.paint);
    part(width * .8, car === 3 ? .55 : .4, length * .48, 0, 1.03, .1, dark);
    for (const side of [-1, 1]) {
      part(.45, .08, .04, side * width * .32, .7, -length / 2, lamps);
      part(.45, .08, .04, side * width * .32, .7, length / 2, tail);
      for (const axle of [-1, 1]) {
        const wheel = new THREE.Mesh(tyre, dark);
        wheel.position.set(side * width * .47, .33, axle * length * .3); this.proxy.add(wheel);
      }
    }
    this.root.add(this.proxy);
  }

  setPaint(color: number): void { this.color = color; this.paint.color.setHex(color); this.detail?.setPaint(color); }

  async prepare(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    if (this.disposed || this.preparing) return;
    this.preparing = true;
    // Called outside render(), and serialized by View to avoid join/reconnect bursts.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (this.disposed) return;
    const view = this.detail = new PlayerView(this.car, this.color, this.shadow, this.length, this.width, false);
    await view.ready;
    if (this.disposed) return;
    this.reveal = revealMaterials(view.root);
    await renderer.compileAsync(view.root, camera, scene);
    if (!this.disposed) { view.root.visible = false; this.root.add(view.root); }
  }

  update(dt: number, car: PlayerCar, pos: THREE.Vector3, yaw: number, distance: number): void {
    this.root.position.copy(pos); this.root.rotation.y = -yaw;
    const view = this.detail;
    if (!view?.root.parent || !this.reveal) return;
    // Hysteresis prevents rebuilding/toggling a detailed car at the distance boundary.
    const close = distance < (view.root.visible ? 160 : 130);
    view.root.visible = close;
    this.fade = close ? Math.min(1, this.fade + dt / .4) : 0;
    this.reveal.value = this.fade;
    this.proxy.visible = this.fade < 1;
    // Keep a prepared detail's wheel phase current behind the proxy; no hidden-time catch-up burst.
    view.update(dt, car, zero, 0, true);
  }

  dispose(): void {
    this.disposed = true;
    this.detail?.dispose();
    const materials = new Set<THREE.Material>();
    this.proxy.traverse(o => { const m = (o as THREE.Mesh).material; if (m) for (const mat of Array.isArray(m) ? m : [m]) materials.add(mat); });
    for (const m of materials) m.dispose();
    this.root.removeFromParent();
  }
}

const zero = new THREE.Vector3();
