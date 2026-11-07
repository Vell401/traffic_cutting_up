import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { lerp } from '../core/math';
import type { CarId } from '../sim/cars';
import type { RoadPoint } from '../sim/road';
import type { Sim } from '../sim/world';
import type { QualityPreset } from '../settings';
import { ChaseCamera, type CameraMode, type CockpitAnchor } from './camera';
import { CAMERA_RIGS } from './car';
import { LampLights } from './lampLights';
import { PlayerView } from './playerView';
import { Post } from './post';
import { RoadView } from './roadView';
import { Blimp, FarGround } from './scenery';
import { SpawnPad } from './spawnPad';
import { SPAWN_PLACES } from '../sim/ring';
import { Sparks } from './sparks';
import { HORIZON, MOON_DIR, applySky, makeSky, skyPreset, type SkyId } from './sky';
import { makeRadialTexture } from './textures';
import { TrafficView } from './trafficView';

/** Re-centre the render origin when the car drifts this far from it (keeps float32 precise on the GPU). */
const ORIGIN_SHIFT = 1000;
/** Our car's colour: the coupe's paint, the R34's stripes. */
const OWN_PAINT = 0x1f4fd8;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly roadView: RoadView;
  private playerView: PlayerView;
  private readonly trafficView: TrafficView;
  private readonly lampLights = new LampLights();
  private readonly sky: THREE.Group;
  private readonly chase = new ChaseCamera();
  private readonly post: Post;
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;
  private readonly sparks = new Sparks();
  private readonly farGround = new FarGround();
  private readonly blimp = new Blimp();
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly carPos = new THREE.Vector3();
  private carYaw = 0;
  private carWorldX = 0;
  private carWorldZ = 0;
  private ox = 0;
  private oz = 0;
  private time = 0;
  private warmedUp = false;
  /** Online: other drivers' cars (id → view, with the body and paint it was built with). */
  private readonly remoteViews = new Map<number, { view: PlayerView; color: number; car: CarId; physics: number; frame: number }>();
  private frame = 0;
  private readonly shadowTex: THREE.Texture;
  private readonly v3 = new THREE.Vector3();
  private readonly ptRemote: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly spawnPad: SpawnPad | null;
  private readonly anchor: CockpitAnchor;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly sim: Sim,
    quality: QualityPreset,
    car: CarId,
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

    // A little more sky fill: softer, more even night light (shadow sides less black). The sky preset
    // sets both lights (setSky).
    this.hemi = new THREE.HemisphereLight(0x5d6c9c, 0x1d1813, 1.1);
    this.scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0xa9bcff, 0.55);
    this.moon.position.copy(MOON_DIR).multiplyScalar(100);
    this.scene.add(this.moon);

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.12;
    pmrem.dispose();

    const shadowTex = makeRadialTexture(64, 1.2);
    this.shadowTex = shadowTex;
    this.roadView = new RoadView(quality, r.capabilities.getMaxAnisotropy());
    this.playerView = new PlayerView(car, OWN_PAINT, shadowTex, sim.player.tune.length, sim.player.tune.width);
    this.chase.setRig(CAMERA_RIGS[car]);
    this.anchor = { eye: this.playerView.eye ?? this.playerView.root, body: this.playerView.body, car: sim.player };
    this.trafficView = new TrafficView(shadowTex);
    this.sky = makeSky();
    this.scene.add(this.roadView.group, this.playerView.root, this.trafficView.group, this.sky, this.lampLights.group, this.sparks.points, this.farGround.mesh, this.blimp.group);
    this.post = new Post(r, this.scene, this.camera, quality);
    this.spawnPad = sim.online ? new SpawnPad(SPAWN_PLACES) : null;
    if (this.spawnPad) this.scene.add(this.spawnPad.group);
    // Online, other drivers may bring the other bodies: build and compile them now (hidden), not when
    // their car first comes into view (~150 ms of geometry, livery and shaders).
    if (sim.online) {
      for (const id of [1, 2, 3] as const) {
        const spare = new PlayerView(id, 0x888888, shadowTex, sim.player.tune.length, sim.player.tune.width, false, true);
        spare.root.visible = false;
        this.scene.add(spare.root);
      }
    }

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
    // Rubbing another driver's car.
    sim.events.on('bump', (e) => {
      this.chase.kick(Math.min(0.7, 0.25 + e.speed * 0.06));
      this.post.pulse(0.4);
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

    // Online: sim.visual carries the remainder of a server correction, gliding out.
    const vis = sim.visual;
    const s = lerp(p.prevS, p.s, alpha) + vis.ds;
    const d = lerp(p.prevD, p.d, alpha) + vis.dd;
    const psi = lerp(p.prevPsi, p.psi, alpha) + vis.dpsi;
    sim.road.toWorld(s, d, this.pt);
    if (Math.abs(this.pt.x - this.ox) > ORIGIN_SHIFT || Math.abs(this.pt.z - this.oz) > ORIGIN_SHIFT) {
      this.ox = Math.round(this.pt.x);
      this.oz = Math.round(this.pt.z);
    }
    const yaw = this.pt.th + psi;
    this.carPos.set(this.pt.x - this.ox, 0, this.pt.z - this.oz);

    this.playerView.update(dt, p, this.carPos, yaw);
    this.playerView.setGhost(p.ghost);
    if (sim.remotes.length > 0 || this.remoteViews.size > 0) this.updateRemotes(alpha, dt, s);
    this.carYaw = yaw;
    this.carWorldX = this.pt.x;
    this.carWorldZ = this.pt.z;
    if (p.scrapeSide !== 0 && p.speed > 8) this.sparkAtWall(Math.min(8, Math.max(1, Math.round(p.speed * dt * 6))), 3);
    this.sparks.update(dt, this.ox, this.oz);
    this.trafficView.update(sim, alpha, this.ox, this.oz, this.time);
    this.roadView.update(sim.road, s - 150, s + 1300, this.ox, this.oz);
    this.lampLights.update(this.roadView, sim.road, s, this.ox, this.oz);
    let cockpit: CockpitAnchor | null = null;
    const eye = this.playerView.eye;
    if (eye) {
      this.anchor.eye = eye;
      this.anchor.body = this.playerView.body;
      this.anchor.car = p;
      cockpit = this.anchor;
    }
    this.chase.boost = p.boostOn;
    this.chase.update(dt, this.camera, this.carPos, yaw, p.vAlong * 3.6, cockpit);
    this.sky.position.copy(this.camera.position);
    this.farGround.update(sim.road, s, this.camera.position);
    this.blimp.update(sim.road, s, this.ox, this.oz, this.time);
    this.spawnPad?.update(sim.road, s, this.ox, this.oz, sim.spawn.owners, sim.spawn.mine);

    if (!this.warmedUp) this.warmUp();
    this.renderer.info.reset();
    this.post.render(dt, p.vAlong * 3.6);
  }

  /** Other online drivers: interpolated like our car, drawn while within sight of the road we draw. */
  private updateRemotes(alpha: number, dt: number, ownS: number): void {
    const sim = this.sim;
    const frame = ++this.frame;
    for (const r of sim.remotes) {
      let entry = this.remoteViews.get(r.id);
      if (entry && (entry.color !== r.color || entry.car !== r.carId || entry.physics !== r.car.physicsId)) {
        entry.view.dispose();
        entry = undefined;
      }
      if (!entry) {
        const view = new PlayerView(r.carId, r.color, this.shadowTex, r.car.tune.length, r.car.tune.width, false);
        this.scene.add(view.root);
        entry = { view, color: r.color, car: r.carId, physics: r.car.physicsId, frame };
        this.remoteViews.set(r.id, entry);
      }
      entry.frame = frame;
      const c = r.car;
      const s = lerp(c.prevS, c.s, alpha);
      // Others' ghosts (on the spawn pad, back from the pits) are invisible; ours is see-through.
      const near = r.visible && !c.ghost && s > ownS - 400 && s < ownS + 1300;
      entry.view.root.visible = near;
      if (!near) continue;
      const d = lerp(c.prevD, c.d, alpha);
      const psi = lerp(c.prevPsi, c.psi, alpha);
      sim.road.toWorld(s, d, this.ptRemote);
      this.v3.set(this.ptRemote.x - this.ox, 0, this.ptRemote.z - this.oz);
      entry.view.update(dt, c, this.v3, this.ptRemote.th + psi);
      entry.view.setGhost(c.ghost);
    }
    for (const [id, entry] of this.remoteViews) {
      if (entry.frame === frame) continue;
      entry.view.dispose();
      this.remoteViews.delete(id);
    }
  }

  /** Screen position (CSS px) of a name tag above another driver's car; false when not on screen. */
  remoteTag(id: number, out: { x: number; y: number; dist: number }): boolean {
    const entry = this.remoteViews.get(id);
    if (!entry || !entry.view.root.visible) return false;
    const pos = entry.view.root.position;
    out.dist = pos.distanceTo(this.carPos);
    this.v3.set(pos.x, 2.1, pos.z).project(this.camera);
    if (this.v3.z > 1 || this.v3.x < -1.1 || this.v3.x > 1.1 || this.v3.y < -1.1 || this.v3.y > 1.1) return false;
    out.x = (this.v3.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-this.v3.y * 0.5 + 0.5) * window.innerHeight;
    return true;
  }

  /** After a teleport: no camera swing from the old heading. */
  snapCamera(): void {
    this.chase.snap();
  }

  /** Our car's turn signal lamp is lit this frame (HUD arrow, relay click). */
  get blinkLit(): boolean {
    return this.playerView.blinkLit;
  }

  /** Mouse drag with the left button: look around (see ChaseCamera.mouseLook). */
  /** Switch the sky: dome, stars, fog, background and the ambient light all follow. */
  setSky(id: SkyId): void {
    const p = skyPreset(id);
    applySky(this.sky, p);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(HORIZON);
    fog.near = p.fogNear;
    fog.far = p.fogFar;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemi;
    this.moon.color.setHex(p.moon);
    this.moon.intensity = p.moonLight;
  }

  /** C held: rear view. */
  setLookBack(on: boolean): void {
    this.chase.lookBack = on;
  }

  look(dx: number, dy: number): void {
    this.chase.mouseLook(dx, dy);
  }

  get cameraMode(): CameraMode {
    return this.chase.mode;
  }

  cycleCamera(): CameraMode {
    const mode = this.chase.cycle();
    this.applyCameraMode();
    return mode;
  }

  /** Our car's body changed (menu choice): new model, its own camera rig (keeping `mode` if it has one). */
  setCar(car: CarId, mode?: CameraMode): CameraMode {
    if (car === this.playerView.car) {
      if (mode) this.chase.setRig(CAMERA_RIGS[car], mode);
      this.applyCameraMode();
      return this.chase.mode;
    }
    const old = this.playerView;
    const next = new PlayerView(car, OWN_PAINT, this.shadowTex, this.sim.player.tune.length, this.sim.player.tune.width);
    old.dispose();
    this.playerView = next;
    // Compile before adding: the scene's lights plus the new car's own spot, as they will be drawn.
    this.renderer.compile(next.root, this.camera, this.scene);
    this.scene.add(next.root);
    const m = this.chase.setRig(CAMERA_RIGS[car], mode);
    this.applyCameraMode();
    return m;
  }

  private applyCameraMode(): void {
    const mode = this.chase.mode;
    this.playerView.root.visible = mode !== 'bumper';
    this.playerView.setCockpit(mode === 'cockpit');
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
