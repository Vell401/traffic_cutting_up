import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { lerp } from '../core/math';
import type { RoadPoint } from '../sim/road';
import type { Sim } from '../sim/world';
import { ChaseCamera } from './camera';
import { LampLights } from './lampLights';
import { PlayerView } from './playerView';
import { RoadView } from './roadView';
import { HORIZON, MOON_DIR, makeSky } from './sky';
import { makeRadialTexture } from './textures';
import { TrafficView } from './trafficView';

/** Re-centre the render origin when the car drifts this far from it (keeps float32 precise on the GPU). */
const ORIGIN_SHIFT = 1000;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly roadView: RoadView;
  private readonly playerView: PlayerView;
  private readonly trafficView: TrafficView;
  private readonly lampLights = new LampLights();
  private readonly sky: THREE.Group;
  private readonly chase = new ChaseCamera();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly carPos = new THREE.Vector3();
  private ox = 0;
  private oz = 0;
  private time = 0;
  private warmedUp = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly sim: Sim,
  ) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.renderer = r;

    // Near plane at 0.5 m (the chase camera never gets closer to anything): 5× the depth precision of 0.1.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 3000);
    this.scene.background = HORIZON;
    this.scene.fog = new THREE.Fog(HORIZON, 70, 950);

    this.scene.add(new THREE.HemisphereLight(0x5d6c9c, 0x16120f, 0.9));
    const moon = new THREE.DirectionalLight(0xa9bcff, 0.55);
    moon.position.copy(MOON_DIR).multiplyScalar(100);
    this.scene.add(moon);

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.12;
    pmrem.dispose();

    const shadowTex = makeRadialTexture(64, 1.2);
    this.roadView = new RoadView(Math.min(8, r.capabilities.getMaxAnisotropy()));
    this.playerView = new PlayerView(0x1f4fd8, shadowTex, sim.player.tune.length, sim.player.tune.width);
    this.trafficView = new TrafficView(shadowTex);
    this.sky = makeSky();
    this.scene.add(this.roadView.group, this.playerView.root, this.trafficView.group, this.sky, this.lampLights.group);

    sim.events.on('nearMiss', () => this.chase.kick(0.25));
    sim.events.on('laneSplit', () => this.chase.kick(0.35));
    sim.events.on('wallHit', (e) => this.chase.kick(Math.min(0.9, 0.3 + e.speed * 0.08)));
    sim.events.on('crash', (e) => this.chase.kick(Math.min(1.2, 0.5 + e.speed * 0.05)));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(alpha: number, dt: number): void {
    const sim = this.sim;
    const p = sim.player;
    this.time += dt;

    const s = lerp(p.prevS, p.s, alpha);
    const d = lerp(p.prevD, p.d, alpha);
    const psi = lerp(p.prevPsi, p.psi, alpha);
    sim.road.toWorld(s, d, this.pt);
    if (Math.abs(this.pt.x - this.ox) > ORIGIN_SHIFT || Math.abs(this.pt.z - this.oz) > ORIGIN_SHIFT) {
      this.ox = Math.round(this.pt.x);
      this.oz = Math.round(this.pt.z);
    }
    const yaw = this.pt.th + psi;
    this.carPos.set(this.pt.x - this.ox, 0, this.pt.z - this.oz);

    this.playerView.update(dt, p, this.carPos, yaw);
    this.trafficView.update(sim, alpha, this.ox, this.oz, this.time);
    this.roadView.update(sim.road, s - 150, s + 1300, this.ox, this.oz);
    this.lampLights.update(this.roadView, sim.road, s, this.ox, this.oz);
    this.chase.update(dt, this.camera, this.carPos, yaw, p.vAlong * 3.6);
    this.sky.position.copy(this.camera.position);

    if (!this.warmedUp) this.warmUp();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Compile every shader up front. Meshes that are hidden at start (sign boards, empty builders)
   * would otherwise compile the first time they appear and stall that frame by 100+ ms.
   */
  private warmUp(): void {
    this.warmedUp = true;
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.camera);
    for (const o of hidden) o.visible = false;
  }
}
