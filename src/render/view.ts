import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { lerp } from '../core/math';
import type { RoadPoint } from '../sim/road';
import type { Sim } from '../sim/world';
import type { QualityPreset } from '../settings';
import { ChaseCamera, type CameraMode } from './camera';
import { LampLights } from './lampLights';
import { PlayerView } from './playerView';
import { Post } from './post';
import { RoadView } from './roadView';
import { Sparks } from './sparks';
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
  private readonly post: Post;
  private readonly sparks = new Sparks();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly carPos = new THREE.Vector3();
  private carYaw = 0;
  private carWorldX = 0;
  private carWorldZ = 0;
  private ox = 0;
  private oz = 0;
  private time = 0;
  private warmedUp = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly sim: Sim,
    quality: QualityPreset,
  ) {
    // MSAA, tone mapping and output encoding happen in the post chain, not on the default framebuffer.
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    // Count draw calls for the whole frame (scene + post passes), reset once per frame in render().
    r.info.autoReset = false;
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
    this.roadView = new RoadView(quality, r.capabilities.getMaxAnisotropy());
    this.playerView = new PlayerView(0x1f4fd8, shadowTex, sim.player.tune.length, sim.player.tune.width);
    this.trafficView = new TrafficView(shadowTex);
    this.sky = makeSky();
    this.scene.add(this.roadView.group, this.playerView.root, this.trafficView.group, this.sky, this.lampLights.group, this.sparks.points);
    this.post = new Post(r, this.scene, this.camera, quality);

    sim.events.on('nearMiss', (e) => {
      this.chase.kick(0.25);
      this.post.pulse(e.gap < 0.3 ? 0.8 : 0.45);
    });
    sim.events.on('laneSplit', () => {
      this.chase.kick(0.35);
      this.post.pulse(0.9);
    });
    sim.events.on('wallHit', (e) => {
      this.chase.kick(Math.min(0.9, 0.3 + e.speed * 0.08));
      this.sparkAtWall(Math.round(20 + e.speed * 8), 4 + e.speed);
    });
    sim.events.on('crash', (e) => {
      this.chase.kick(Math.min(1.2, 0.5 + e.speed * 0.05));
      this.post.pulse(1);
      this.sparkAtNose(Math.round(40 + e.speed * 4), 5 + e.speed * 0.4);
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
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
    this.carYaw = yaw;
    this.carWorldX = this.pt.x;
    this.carWorldZ = this.pt.z;
    if (p.scrapeSide !== 0 && p.speed > 8) this.sparkAtWall(Math.min(8, Math.max(1, Math.round(p.speed * dt * 6))), 3);
    this.sparks.update(dt, this.ox, this.oz);
    this.trafficView.update(sim, alpha, this.ox, this.oz, this.time);
    this.roadView.update(sim.road, s - 150, s + 1300, this.ox, this.oz);
    this.lampLights.update(this.roadView, sim.road, s, this.ox, this.oz);
    this.chase.update(dt, this.camera, this.carPos, yaw, p.vAlong * 3.6);
    this.sky.position.copy(this.camera.position);

    if (!this.warmedUp) this.warmUp();
    this.renderer.info.reset();
    this.post.render(dt, p.vAlong * 3.6);
  }

  /** After a teleport: no camera swing from the old heading. */
  snapCamera(): void {
    this.chase.snap();
  }

  cycleCamera(): CameraMode {
    const mode = this.chase.cycle();
    this.playerView.root.visible = mode !== 'bumper';
    return mode;
  }

  /** Sparks where the car's flank rubs the barrier; they trail behind at part of the car's speed. */
  private sparkAtWall(count: number, spread: number): void {
    const p = this.sim.player;
    const side = p.wallSide || p.scrapeSide;
    if (side === 0 || count <= 0) return;
    const fx = Math.sin(this.carYaw);
    const fz = -Math.cos(this.carYaw);
    const rx = Math.cos(this.carYaw) * side;
    const rz = Math.sin(this.carYaw) * side;
    // From the rear half of the flank, slower than the car so they trail into the chase camera's view.
    const along = -Math.random() * p.tune.length * 0.5;
    const half = p.tune.width / 2;
    const v = p.vAlong * 0.8;
    this.sparks.emit(this.carWorldX + rx * half + fx * along, 0.35, this.carWorldZ + rz * half + fz * along, fx * v, fz * v, count, spread);
  }

  private sparkAtNose(count: number, spread: number): void {
    const p = this.sim.player;
    const fx = Math.sin(this.carYaw);
    const fz = -Math.cos(this.carYaw);
    const nose = p.tune.length / 2;
    const v = p.vAlong * 0.4;
    this.sparks.emit(this.carWorldX + fx * nose, 0.5, this.carWorldZ + fz * nose, fx * v, fz * v, count, spread);
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
