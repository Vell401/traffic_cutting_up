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
import { Sparks } from './sparks';
import { TyreEffects } from './tyreEffects';
import { HORIZON, MOON_DIR, applySky, makeSky, skyPreset, type SkyId } from './sky';
import { makeRadialTexture } from './textures';
import { TrafficView } from './trafficView';
import { RemoteCar, revealMaterials } from './remoteCar';
import { ResolutionBudget } from './resolution';
import { r34ChaseYaw } from './r34Feedback';
import { prepareObject } from './prepareObject';

/** Re-centre the render origin when the car drifts this far from it (keeps float32 precise on the GPU). */
const ORIGIN_SHIFT = 1000;

export class View {
  private paint: number;
  private highBeam = false;
  private scoreDistortion = 0;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly roadView: RoadView;
  private playerView: PlayerView;
  private readonly playerViews = new Map<CarId, { view: PlayerView; length: number; width: number }>();
  private readonly carPreparations = new WeakMap<PlayerView, Promise<void>>();
  private readonly preparedCars = new WeakSet<PlayerView>();
  private carSelection = 0;
  private preparingOwnCar: Promise<void> | null = null;
  private readonly trafficView: TrafficView;
  private readonly lampLights = new LampLights();
  private readonly sky: THREE.Group;
  private readonly chase = new ChaseCamera();
  private readonly post: Post;
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;
  private readonly sparks = new Sparks();
  private readonly tyreEffects = new TyreEffects();
  private readonly tyreContact = (i: number, out: THREE.Vector3): THREE.Vector3 => this.playerView.wheelContact(i, out);
  private readonly farGround: FarGround;
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
  private readonly remoteViews = new Map<number, { view: RemoteCar; color: number; car: CarId; physics: number; frame: number; prepared: boolean; retryAt: number }>();
  private remoteQueue: Promise<void> = Promise.resolve();
  private readonly remoteSpares: PlayerView[] = [];
  private onlinePreparation: Promise<void> | null = null;
  private frame = 0;
  private readonly shadowTex: THREE.Texture;
  private readonly v3 = new THREE.Vector3();
  private readonly ptRemote: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private readonly spawnPad: SpawnPad | null;
  private readonly anchor: CockpitAnchor;
  private readonly resolution: ResolutionBudget;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly sim: Sim,
    quality: QualityPreset,
    car: CarId,
    paint = 0x1f4fd8,
  ) {
    this.paint = paint;
    // MSAA, tone mapping and output encoding happen in the post chain, not on the default framebuffer.
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    this.resolution = new ResolutionBudget(r.getPixelRatio());
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
    const room = new RoomEnvironment();
    try {
      this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    } finally {
      // RoomEnvironment.dispose owns its unique geometries/materials, not instance buffers.
      room.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
      room.dispose();
      pmrem.dispose();
    }
    this.scene.environmentIntensity = 0.12;

    const shadowTex = makeRadialTexture(64, 1.2);
    this.shadowTex = shadowTex;
    this.farGround = new FarGround(sim.map.theme);
    this.roadView = new RoadView(quality, r.capabilities.getMaxAnisotropy(), sim.map.theme);
    this.playerView = new PlayerView(car, this.paint, shadowTex, sim.player.tune.length, sim.player.tune.width);
    this.playerViews.set(car, { view: this.playerView, length: sim.player.tune.length, width: sim.player.tune.width });
    this.chase.setRig(CAMERA_RIGS[car]);
    this.anchor = { eye: this.playerView.eye ?? this.playerView.root, body: this.playerView.body, car: sim.player };
    this.trafficView = new TrafficView(shadowTex);
    this.sky = makeSky();
    this.scene.add(this.roadView.group, this.playerView.root, this.trafficView.group, this.sky, this.lampLights.group, this.tyreEffects.group, this.sparks.points, this.farGround.mesh, this.blimp.group);
    this.post = new Post(r, this.scene, this.camera, quality);
    this.spawnPad = sim.online ? new SpawnPad(sim.map.spawn.places, sim.map.id) : null;
    if (this.spawnPad) this.scene.add(this.spawnPad.group);
    sim.events.on('nearMiss', (e) => {
      this.scoreFeedback(0.25, e.gap < 0.3 ? 0.8 : 0.45);
    });
    sim.events.on('laneSplit', () => {
      this.scoreFeedback(0.35, 0.9);
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
    // Keep live frames from replacing compileAsync's in-flight material programs. The loader owns
    // this short interval; variants and renderer state are still restored at every synchronous step.
    if (this.preparingOwnCar && this.carPreparations.get(this.playerView) === this.preparingOwnCar) return;
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
    const r34 = this.playerView.car === 2 && p.physicsId === 2;
    this.playerView.root.updateMatrixWorld(true);
    this.tyreEffects.emit(dt, this.playerView.tyreFeedback, this.tyreContact, yaw,
      p.steerAngle, this.ox, this.oz, !p.ghost);
    this.tyreEffects.update(dt, this.ox, this.oz);
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
    const cameraYaw = r34 && !this.chase.rigid && !this.chase.lookBack ? r34ChaseYaw(yaw, p.vx, p.vy) : yaw;
    const cameraKmh = (r34 ? p.speed : p.vAlong) * 3.6;
    this.chase.update(dt, this.camera, this.carPos, cameraYaw, cameraKmh, cockpit);
    this.sky.position.copy(this.camera.position);
    this.farGround.update(sim.road, s, this.camera.position);
    this.blimp.update(sim.road, s, this.ox, this.oz, this.time);
    this.spawnPad?.update(sim.road, s, this.ox, this.oz, sim.spawn.owners, sim.spawn.mine);

    if (!this.warmedUp) this.warmUp();
    this.renderer.info.reset();
    this.post.render(dt, cameraKmh);
  }

  /** Other online drivers: cheap silhouettes first, detailed bodies only nearby. */
  private updateRemotes(alpha: number, dt: number, ownS: number): void {
    const sim = this.sim;
    const frame = ++this.frame;
    for (const r of sim.remotes) {
      let entry = this.remoteViews.get(r.id);
      if (entry && (entry.car !== r.carId || entry.physics !== r.car.physicsId)) {
        entry.view.dispose();
        entry = undefined;
      }
      if (!entry) {
        const view = new RemoteCar(r.carId, r.color, this.shadowTex, r.car.tune.length, r.car.tune.width);
        this.scene.add(view.root);
        entry = { view, color: r.color, car: r.carId, physics: r.car.physicsId, frame, prepared: false, retryAt: 0 };
        this.remoteViews.set(r.id, entry);
      }
      entry.frame = frame;
      if (entry.color !== r.color) { entry.color = r.color; entry.view.setPaint(r.color); }
      const c = r.car;
      const s = lerp(c.prevS, c.s, alpha);
      // Others' ghosts (on the spawn pad, back from the pits) are invisible; ours is see-through.
      const near = r.visible && !c.ghost && s > ownS - 400 && s < ownS + 1300;
      entry.view.root.visible = near;
      if (!near) continue;
      const distance = Math.abs(s - ownS);
      if (!entry.prepared && this.time >= entry.retryAt && distance < 180) {
        entry.prepared = true;
        const remote = entry.view;
        this.remoteQueue = this.remoteQueue.then(() => remote.prepare(this.renderer, this.camera, this.scene)).catch(error => {
          const current = this.remoteViews.get(r.id);
          if (current?.view === remote) {
            current.prepared = false;
            current.retryAt = this.time + 5;
          }
          console.warn('Remote car preparation failed', error);
        });
      }
      const d = lerp(c.prevD, c.d, alpha);
      const psi = lerp(c.prevPsi, c.psi, alpha);
      sim.road.toWorld(s, d, this.ptRemote);
      this.v3.set(this.ptRemote.x - this.ox, 0, this.ptRemote.z - this.oz);
      entry.view.update(dt, c, this.v3, this.ptRemote.th + psi, distance);
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
    this.tyreEffects.resetTrails();
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

  /** Attach, compile and upload all own-car camera/material variants before readiness. */
  prepareCar(): Promise<void> {
    const player = this.playerView;
    const existing = this.carPreparations.get(player);
    if (existing) return existing;
    const selection = this.carSelection;
    const current = () => player === this.playerView && selection === this.carSelection && this.playerViews.get(player.car)?.view === player;
    const prepare = (async () => {
      try { await player.ready; }
      catch (error) {
        // Attachment readiness is immutable: retry must build a fresh instance, not reuse rejection.
        if (this.playerViews.get(player.car)?.view === player) this.playerViews.delete(player.car);
        player.dispose();
        throw error;
      }
      if (!current()) return;
      for (const cockpit of player.hasCockpit ? [false, true] : [false]) {
        for (const ghost of [false, true]) {
          await prepareObject(this.renderer, this.scene, this.camera, player.root, {
            current,
            variant: () => {
              player.setCockpit(cockpit); player.setGhost(ghost);
              return () => { player.setCockpit(this.cameraMode === 'cockpit'); player.setGhost(this.sim.player.ghost); };
            },
          });
          if (!current()) return;
        }
      }
      // Bumper now hides only visuals: its world-lighting configuration is the same as chase.
    })().then(() => {
      // A superseded menu choice was not actually compiled; it is still preparable later.
      if (current()) this.preparedCars.add(player);
      else if (this.carPreparations.get(player) === prepare) this.carPreparations.delete(player);
    }, error => {
      if (this.carPreparations.get(player) === prepare) this.carPreparations.delete(player);
      throw error;
    }).finally(() => { if (this.preparingOwnCar === prepare) this.preparingOwnCar = null; });
    this.carPreparations.set(player, prepare);
    this.preparingOwnCar = prepare;
    return prepare;
  }

  adaptResolution(frameMs: number, cpuMs: number, active: boolean): void {
    if (!this.resolution.observe(frameMs, cpuMs, active)) return;
    this.renderer.setPixelRatio(this.resolution.ratio);
    this.resize();
  }

  /** Optional full remote warm-up. Avoid blocking boot on every model's texture upload. */
  prepareOnlineCars(): Promise<void> {
    return this.onlinePreparation ??= this.prepareOnlineCarSources().then(() => {
      // Optional failures must not block play, but a later explicit warmup can retry missing bodies.
      if (this.remoteSpares.length < 4) this.onlinePreparation = null;
    }, error => { this.onlinePreparation = null; throw error; });
  }

  private async prepareOnlineCarSources(): Promise<void> {
    await this.playerView.ready;
    for (const id of [1, 2, 3, 4] as const) {
      if (this.remoteSpares.some(spare => spare.car === id)) continue;
      const spare = new PlayerView(id, 0x888888, this.shadowTex, 4.6, 1.9, false);
      try {
        await spare.ready;
        revealMaterials(spare.root).value = 1;
        spare.root.position.copy(this.playerView.root.position);
        this.scene.add(spare.root);
        await prepareObject(this.renderer, this.scene, this.camera, spare.root);
        spare.root.visible = false;
        this.remoteSpares.push(spare); // Keep shared shader programs resident for future joins.
      } catch (error) {
        spare.dispose();
        console.warn(`Optional online car warmup failed (${id}); it can be retried`, error);
      }
    }
  }

  cycleCamera(): CameraMode {
    const mode = this.chase.cycle();
    this.applyCameraMode();
    return mode;
  }

  /** Our car's body changed (menu choice): new model, its own camera rig (keeping `mode` if it has one). */
  setCar(car: CarId, mode?: CameraMode, dimensions = this.sim.player.tune): CameraMode {
    if (car === this.playerView.car && this.playerViews.get(car)?.view === this.playerView) {
      if (mode) this.chase.setRig(CAMERA_RIGS[car], mode);
      this.applyCameraMode();
      return this.chase.mode;
    }
    this.carSelection = (this.carSelection ?? 0) + 1;
    if (!this.preparedCars.has(this.playerView)) this.carPreparations.delete(this.playerView);
    this.tyreEffects.resetTrails();
    const { length, width } = dimensions;
    const cached = this.playerViews.get(car);
    if (cached && (cached.length !== length || cached.width !== width)) {
      cached.view.dispose();
      this.playerViews.delete(car);
    }
    const next = this.playerViews.get(car)?.view ?? new PlayerView(car, this.paint, this.shadowTex, length, width);
    this.playerViews.set(car, { view: next, length, width });
    next.setPaint(this.paint);
    next.setHighBeam(this.highBeam);
    next.setGhost(this.sim.player.ghost);
    // Keep the four bounded car instances and their programs/textures resident across menu choices.
    // Detaching also removes the old headlights; a hidden Group would still complicate warm-up.
    this.playerView.root.removeFromParent();
    this.playerView = next;
    this.scene.add(next.root);
    const m = this.chase.setRig(CAMERA_RIGS[car], mode);
    this.applyCameraMode();
    return m;
  }

  private applyCameraMode(): void {
    const mode = this.chase.mode;
    this.playerView.setVisualsVisible(mode !== 'bumper');
    this.playerView.setCockpit(mode === 'cockpit');
  }

  setPaint(color: number): void { this.paint = color; this.playerView.setPaint(color); }
  setHighBeam(on: boolean): void { this.highBeam = on; this.playerView.setHighBeam(on); }
  setScoreDistortion(level: number): void {
    this.scoreDistortion = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.post.setScoreDistortion(this.scoreDistortion);
  }

  private scoreFeedback(kick: number, pulse: number): void {
    if (this.scoreDistortion > 0) this.chase.kick(kick * this.scoreDistortion);
    this.post.scorePulse(pulse);
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
