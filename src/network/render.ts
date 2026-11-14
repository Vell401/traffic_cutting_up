import * as THREE from 'three';
import { edgeById, roadSampleDistances, sampleEdge, type RoadNetwork, type Vec3 } from './geometry';
import { BRIDGE_DECK_THICKNESS, bridgePierClearance, bridgePierGeometry } from './structures';
import { msdPresentationCorridor } from './msdCorridor';
import { createRoadMaterials } from './roadMaterials';
import { planRoadMarkings } from './roadMarkings';
import { emitRoadInfrastructure } from './roadInfrastructure';
import { emitMsdEnvironment, ENV_FACADES, ENV_FOLIAGE } from './msdEnvironment';
import { planPilotDivergeSurface, planPilotJunctionSurface, pilotMergeEdges, pilotMarkingPoint } from './pilotJunctionSurface';

export interface RenderCar extends Vec3 { id: string; edgeId: string; s: number; d: number; heading: number; grade: number; player: boolean; tunnel: boolean }
type Batch = { x: number; z: number; radius: number; group: THREE.Group; vertices: Map<string, number[]>; uvs: Map<string, number[]>; colors: number[] };
/** 512 m batches: with merged vertex-coloured solids this keeps draw calls to a few hundred. */
const CHUNK = 512;
/** Draw distance (m): chunks beyond it are hidden; linear sky fog hides the cut. */
export const ROAD_VIEW_DISTANCE = 1500;
export const FOG_START = 650;
export const ASPHALT_DEPTH_BUCKETS = 8;
export function asphaltMaterialKey(kind: string, index: number): string {
  return `asphalt:${kind === 'parking' ? 'parking' : 'road'}:${index % ASPHALT_DEPTH_BUCKETS}`;
}
export function roadChunkVisible(x: number, z: number, radius: number, eye: Pick<Vec3, 'x' | 'z'>): boolean {
  return Math.hypot(x - eye.x, z - eye.z) <= ROAD_VIEW_DISTANCE + radius;
}

/** Static vertices are chunk-local; all displayed transforms are relative to a moving origin. */
export class NetworkRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, .1, 2400);
  private readonly chunks = new Map<string, Batch>();
  private readonly cars = new Map<string, THREE.Group>();
  private readonly cube = new THREE.BoxGeometry(1, 1, 1);
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly asphaltKeys = new Map<string, string>();
  /** Opaque single-colour keys drawn through one vertex-coloured material per chunk. */
  private readonly solidColors = new Map<string, [number, number, number]>();
  private readonly cameraWorld = new THREE.Vector3();
  private readonly interiorLight = new THREE.PointLight(0xd6eaff, 90, 45, 1.4);
  private initialized = false;
  freeCamera = false;
  flightSpeed = 300;
  private flightYaw = 0;
  private flightPitch = 0;

  toggleFreeCamera(): boolean {
    this.freeCamera = !this.freeCamera;
    if (this.freeCamera) {
      const direction = this.camera.getWorldDirection(new THREE.Vector3());
      this.flightYaw = Math.atan2(direction.x, -direction.z);
      this.flightPitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    }
    return this.freeCamera;
  }

  /** Development inspection only: place the free camera at a world pose. */
  inspect(position: Vec3, yaw: number, pitch: number): void {
    this.freeCamera = true;
    this.cameraWorld.set(position.x, position.y, position.z);
    this.flightYaw = yaw; this.flightPitch = Math.max(-1.55, Math.min(1.55, pitch));
  }

  look(dx: number, dy: number): void {
    if (!this.freeCamera) return;
    this.flightYaw += dx * .002;
    this.flightPitch = Math.max(-1.55, Math.min(1.55, this.flightPitch - dy * .002));
  }

  fly(dt: number, forward: number, right: number, up: number, fast: boolean): void {
    if (!this.freeCamera) return;
    const move = new THREE.Vector3(
      Math.sin(this.flightYaw) * Math.cos(this.flightPitch) * forward + Math.cos(this.flightYaw) * right,
      Math.sin(this.flightPitch) * forward + up,
      -Math.cos(this.flightYaw) * Math.cos(this.flightPitch) * forward + Math.sin(this.flightYaw) * right,
    );
    if (move.lengthSq() > 1) move.normalize();
    this.cameraWorld.addScaledVector(move, dt * this.flightSpeed * (fast ? 5 : 1));
  }
  private readonly resize = () => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };

  constructor(canvas: HTMLCanvasElement, private readonly network: RoadNetwork) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.scene.background = new THREE.Color('#a9c6d6');
    // Fog reaches the sky colour before the chunk cull distance, so no pop-in edge.
    this.scene.fog = new THREE.Fog('#a9c6d6', FOG_START, ROAD_VIEW_DISTANCE - 50);
    this.camera.far = ROAD_VIEW_DISTANCE + CHUNK;
    this.camera.updateProjectionMatrix();
    this.scene.add(new THREE.HemisphereLight(0xd9efff, 0x576050, 2.4));
    this.scene.add(this.interiorLight);
    const sun = new THREE.DirectionalLight(0xffefdc, 2.5);
    sun.position.set(-200, 400, 100); this.scene.add(sun);
    for (const [key, color] of Object.entries({ road: '#343e46', parking: '#515961', line: '#ece7c9', barrier: '#a7b1b4', tunnel: '#68737a', support: '#929a9d', water: '#337e99', shore: '#b6ac88', ground: '#647864', block: '#89969e', glass: '#263e50', player: '#ffb442', car: '#67b9c6' })) {
      this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: .85, side: THREE.DoubleSide,
        depthTest: true, depthWrite: true,
        ...(key === 'line' ? { emissive: color, emissiveIntensity: .3 } : {}),
        ...(key === 'tunnel' ? { emissive: '#35414d', emissiveIntensity: .25 } : {}) }));
    }
    const corridor = msdPresentationCorridor(network);
    for (const [key, material] of createRoadMaterials(this.renderer.capabilities.getMaxAnisotropy())) this.materials.set(key, material);
    for (const [key, color] of Object.entries({ infrastructureMetal: '#9da5a9', infrastructureConcrete: '#a6a7a3',
      infrastructureWhite: '#f4f4ef', infrastructureRed: '#ba2828', infrastructureBlue: '#2466a0', infrastructureDark: '#25292b' })) {
      this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: key === 'infrastructureMetal' ? .5 : .85,
        metalness: key === 'infrastructureMetal' ? .5 : 0, side: THREE.DoubleSide }));
    }
    // Section-01 environment palette: plain authored colours, no imagery-derived textures.
    const environment: Record<string, string> = { 'env:grass': '#6f8150', 'env:paved': '#8d8c86', 'env:ballast': '#7b7268',
      'env:rail': '#55504b', 'env:roof': '#5e6162', 'env:pipe': '#c9cdd0', 'env:steel': '#7c8488', 'env:truss': '#c9832e', 'env:trunk': '#4e3e2f',
      'env:fence': '#3e4448', 'env:wall': '#b8b5ab', 'env:noise': '#b9d4dc', 'env:lamp': '#efeadb', 'env:tank': '#d8d8d4',
      'env:water': '#4a6f7c', 'env:pylon': '#8e979b', 'env:wire': '#2e3236', 'env:turf': '#6f8150' };
    ENV_FACADES.forEach((color, i) => { environment[`env:facade:${i}`] = color; });
    ENV_FOLIAGE.forEach((color, i) => { environment[`env:foliage:${i}`] = color; });
    for (const [key, color] of Object.entries(environment)) this.materials.set(key, new THREE.MeshStandardMaterial({ color,
      roughness: key === 'env:rail' || key === 'env:steel' ? .55 : .95, metalness: key === 'env:rail' || key === 'env:steel' ? .45 : 0,
      side: THREE.DoubleSide, ...(key === 'env:lamp' ? { emissive: '#fff2c8', emissiveIntensity: .35 } : {}),
      // Ground layers sit a few centimetres below roads; push them back in depth so
      // distant asphalt (itself offset by up to 8 units) never loses to grass.
      ...(key === 'env:grass' || key === 'env:paved' ? { polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: key === 'env:grass' ? 12 : 10 } : {}),
      // Transparent acrylic noise screens (frames at ≈5100–5390 m); water slightly glossy.
      ...(key === 'env:noise' ? { transparent: true, opacity: .38, depthWrite: false } : {}),
      ...(key === 'env:water' ? { roughness: .25, metalness: .1 } : {}) }));
    // Merge opaque plain-colour environment/furniture keys into one draw per chunk.
    for (const [key, material] of this.materials) {
      const merge = key.startsWith('infrastructure') || key === 'support'
        || key.startsWith('env:') && !['env:grass', 'env:paved', 'env:noise', 'env:water'].includes(key);
      if (merge) this.solidColors.set(key, [material.color.r, material.color.g, material.color.b]);
    }
    this.materials.set('solid', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88, side: THREE.DoubleSide }));
    // Keep the original renderer outside the selected corridor; selected asphalt shares one material.
    network.edges.forEach((edge, index) => {
      if (corridor.has(edge.id)) return;
      const key = asphaltMaterialKey(edge.kind, index);
      this.asphaltKeys.set(edge.id, key);
      if (this.materials.has(key)) return;
      const material = this.materials.get(edge.kind === 'parking' ? 'parking' : 'road')!.clone();
      material.polygonOffset = true; material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1 + index % ASPHALT_DEPTH_BUCKETS;
      this.materials.set(key, material);
    });
    this.build(network);
    for (const batch of this.chunks.values()) {
      for (const [key, positions] of batch.vertices) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const uvs = batch.uvs.get(key);
        if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        if (key === 'solid') geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 3));
        geometry.computeVertexNormals(); geometry.computeBoundingSphere();
        batch.group.add(new THREE.Mesh(geometry, this.materials.get(key)!));
      }
      batch.vertices.clear(); batch.uvs.clear(); batch.colors = []; this.scene.add(batch.group);
    }
    window.addEventListener('resize', this.resize); this.resize();
  }

  private quad(original: string, a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    const color = this.solidColors.get(original), key = color ? 'solid' : original;
    const x = Math.floor((a.x + b.x + c.x + d.x) / 4 / CHUNK) * CHUNK;
    const z = Math.floor((a.z + b.z + c.z + d.z) / 4 / CHUNK) * CHUNK;
    const id = `${x}:${z}`;
    let batch = this.chunks.get(id);
    if (!batch) { batch = { x, z, radius: 0, group: new THREE.Group(), vertices: new Map(), uvs: new Map(), colors: [] }; this.chunks.set(id, batch); }
    for (const p of [a, b, c, d]) batch.radius = Math.max(batch.radius, Math.hypot(p.x - x, p.z - z));
    const vertices = batch.vertices.get(key) ?? []; batch.vertices.set(key, vertices);
    for (const p of [a, b, c, a, c, d]) vertices.push(p.x - x, p.y, p.z - z);
    if (color) for (let i = 0; i < 6; i++) batch.colors.push(color[0], color[1], color[2]);
    if (key === 'msd:asphalt') {
      const uvs = batch.uvs.get(key) ?? []; batch.uvs.set(key, uvs);
      // Global metric UVs remain identical across chunk and source-edge seams (2 m aggregate tile).
      for (const p of [a, b, c, a, c, d]) uvs.push(p.x / 2, p.z / 2);
    }
  }

  private box(key: string, p: Vec3, w: number, h: number, l: number, heading = 0): void {
    const corners: Vec3[] = [];
    for (const y of [-.5, .5]) for (const z of [-.5, .5]) for (const x of [-.5, .5]) corners.push({
      x: p.x + x * w * Math.cos(heading) - z * l * Math.sin(heading), y: p.y + y * h,
      z: p.z + x * w * Math.sin(heading) + z * l * Math.cos(heading),
    });
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) this.quad(key, corners[a], corners[b], corners[c], corners[d]);
  }

  private build(network: RoadNetwork): void {
    const corridor = msdPresentationCorridor(network);
    const markings = planRoadMarkings(network, corridor);
    const merge = planPilotJunctionSurface(network), pilotArms = pilotMergeEdges(network);
    // Two explicit, disjoint pilot junctions; their arm sets never share an edge.
    const pilot = { surfaces: new Map([...merge.surfaces, ...planPilotDivergeSurface(network).surfaces]) };
    const pierClear = bridgePierClearance(network);
    const degree = new Map<string, number>();
    for (const e of network.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    for (const edge of network.edges) {
      const polished = corridor.has(edge.id);
      // Match the backend's varying width and grade rather than flattening control points.
      const point = (s: number, fraction: number, y = 0) => {
        const surface = sampleEdge(edge, s);
        const p = sampleEdge(edge, s, fraction * surface.halfWidth); return { x: p.x, y: p.y + y, z: p.z };
      };
      const strip = (key: string, a: number, b: number, left: number, right: number, y = 0) => this.quad(key, point(a, left, y), point(b, left, y), point(b, right, y), point(a, right, y));
      const distances = polished ? roadSampleDistances(edge) : undefined;
      const intervals = distances ? distances.slice(0, -1).map((s, i) => [s, distances[i + 1]] as const)
        : Array.from({ length: Math.ceil(edge.length / 5) }, (_, i) => [i * 5, Math.min(edge.length, i * 5 + 5)] as const);
      for (const [s, end] of intervals) {
        const mid = (s + end) / 2, p = sampleEdge(edge, mid);
        if (!pilot.surfaces.has(edge.id)) strip(polished ? 'msd:asphalt' : this.asphaltKeys.get(edge.id)!, s, end, -1, 1);
        const throat = ((degree.get(edge.from) ?? 0) > 2 && s < 60) || ((degree.get(edge.to) ?? 0) > 2 && edge.length - end < 60);
        for (const side of [-1, 1]) {
          if (!polished && !throat) strip('line', s, end, side * .93 - .009, side * .93 + .009, .035);
          // No end caps. Leave generous branch/merge throats open, including tangent leads.
          const open = ((degree.get(edge.from) ?? 0) > 2 && s < 100) || ((degree.get(edge.to) ?? 0) > 2 && edge.length - end < 100);
          if (!polished && !open && edge.kind !== 'parking') {
            this.quad('barrier', point(s, side, .08), point(end, side, .08), point(end, side, .95), point(s, side, .95));
            strip('barrier', s, end, side - .025, side + .025, .95);
          }
          if (edge.kind === 'tunnel' && !open) this.quad('tunnel', point(s, side * 1.04, 0), point(end, side * 1.04, 0), point(end, side * 1.04, 6.5), point(s, side * 1.04, 6.5));
          if (!network.id.startsWith('moscow-osm') && (edge.kind === 'road' || edge.kind === 'parking') && p.y > 5 && !throat) {
            const a = sampleEdge(edge, s, side * (sampleEdge(edge, s).halfWidth + 24));
            const b = sampleEdge(edge, end, side * (sampleEdge(edge, end).halfWidth + 24));
            this.quad('ground', point(s, side, -.18), point(end, side, -.18), { ...b, y: 4 }, { ...a, y: 4 });
          }
          // Short diverging shoulder hatches identify the gore after the unmarked throat.
          if (!polished && !throat && !open && Math.floor(s / 5) % 2 === 0
            && (((degree.get(edge.from) ?? 0) > 2 && s < 140) || ((degree.get(edge.to) ?? 0) > 2 && edge.length - end < 140))) {
            this.quad('line', point(s, side * .96, .05), point(s + 1, side * .96, .05), point(end, side * .78, .05), point(end - 1, side * .78, .05));
          }
        }
        if (edge.kind === 'tunnel') {
          strip('tunnel', s, end, -1.04, 1.04, 6.5);
          if (Math.floor(s / 5) % 5 === 0) strip('line', s, Math.min(end, s + .6), -.65, .65, 6.45);
        }
        if (!polished && !throat && Math.floor(mid / 12) % 2 === 0) for (let lane = 1; lane < Math.max(edge.lanes, edge.endLanes ?? 0); lane++) {
          const f0 = -1 + 2 * lane / p.lanes;
          if (f0 < .85) strip('line', s, end, f0 - .008, f0 + .008, .04);
        }
        if (edge.kind === 'bridge') {
          if (Math.floor(s / 5) % 16 === 0 && p.y > 0) {
            const pier = bridgePierGeometry(edge, mid);
            if (pier.height > 0 && pierClear(edge.id, { ...p, y: pier.top })) {
              this.box('support', pier.center, pier.width, pier.height, pier.length, pier.heading);
            }
          }
          // The deck carries a 1.5 m cornice beyond the carriageway: roadside rails
          // (1.1 m out) and lamp columns stand on structure, not in the air.
          const edgePoint = (at: number, side: number, y = 0) => { const q = sampleEdge(edge, at, side * (sampleEdge(edge, at).halfWidth + (polished ? 1.5 : 0))); return { x: q.x, y: q.y + y, z: q.z }; };
          this.quad('support', edgePoint(s, -1, -BRIDGE_DECK_THICKNESS), edgePoint(end, -1, -BRIDGE_DECK_THICKNESS), edgePoint(end, 1, -BRIDGE_DECK_THICKNESS), edgePoint(s, 1, -BRIDGE_DECK_THICKNESS));
          for (const side of [-1, 1]) {
            this.quad('support', edgePoint(s, side), edgePoint(end, side), edgePoint(end, side, -BRIDGE_DECK_THICKNESS), edgePoint(s, side, -BRIDGE_DECK_THICKNESS));
            if (polished) this.quad('infrastructureConcrete', point(s, side, -.01), point(end, side, -.01), edgePoint(end, side, -.01), edgePoint(s, side, -.01));
          }
        }
        if (!throat && edge.kind === 'parking' && Math.floor(s / 5) % 2 === 0) strip('line', s, Math.min(end, s + .15), .5, .88, .045);
        if (!network.id.startsWith('moscow-osm') && edge.kind === 'road' && p.y > 5 && Math.floor(s / 5) % 24 === 0) {
          // Abstract district masses beyond the shoulder; never on the driving ribbon.
          const q = sampleEdge(edge, mid, p.halfWidth + 55);
          const h = 12 + (Math.floor(mid) % 31);
          this.box('ground', { ...q, y: 2 }, 60, 4, 65, p.heading);
          this.box('block', { ...q, y: 4 + h / 2 }, 18, h, 24, p.heading);
        }
      }
      for (const triangle of pilot.surfaces.get(edge.id) ?? []) this.quad('msd:asphalt', triangle[0], triangle[1], triangle[2], triangle[2]);
      for (const marking of markings.segments.get(edge.id) ?? []) {
        const p = (s: number, d: number) => { const point = pilotMarkingPoint(edge, s, d, pilotArms); return { x: point.x, y: point.y + .025, z: point.z }; };
        const half = marking.width / 2;
        this.quad('msd:line', p(marking.start, marking.d0 - half), p(marking.end, marking.d1 - half),
          p(marking.end, marking.d1 + half), p(marking.start, marking.d0 + half));
      }
    }
    emitRoadInfrastructure(network, corridor, (key, a, b, c, d) => this.quad(key, a, b, c, d),
      (key, p, w, h, l, heading) => this.box(key, p, w, h, l, heading));
    // Dev diagnostics only: ?msdEnv=0 skips the environment layer for A/B profiling.
    const environmentEnabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('msdEnv') !== '0';
    if (environmentEnabled) emitMsdEnvironment(network, (key, a, b, c) => this.quad(key, a, b, c, c), (key, p, w, h, l, heading) => this.box(key, p, w, h, l, heading));
    if (network.id.startsWith('moscow-osm')) {
      // Neutral plan-view ground: do not reuse the fictional bay as Moscow geography.
      const xs = network.nodes.map(n => n.position.x), zs = network.nodes.map(n => n.position.z);
      const x0 = Math.min(...xs) - 1000, x1 = Math.max(...xs) + 1000;
      const z0 = Math.min(...zs) - 1000, z1 = Math.max(...zs) + 1000;
      const y = Math.min(-2, ...network.nodes.map(n => n.position.y - 2));
      this.quad('ground', { x: x0, y, z: z0 }, { x: x0, y, z: z1 }, { x: x1, y, z: z1 }, { x: x1, y, z: z0 });
      return;
    }
    // Sea level is zero: R0's -38 m tunnel is below water, its 42 m bridge above.
    // Land is an approximate island/coast mask, not a sheet through underground ramps.
    const xs = network.nodes.map(n => n.position.x), zs = network.nodes.map(n => n.position.z);
    const minX = Math.min(...xs) - 1800, maxX = Math.max(...xs) + 1800;
    const minZ = Math.min(...zs) - 1800, maxZ = Math.max(...zs) + 1800;
    const cutouts = new Set<string>();
    const tile = 64;
    for (const edge of network.edges) for (let s = 0; s <= edge.length; s += 12) {
      const p = sampleEdge(edge, s);
      if (p.y > 12) continue;
      const cx = Math.floor(p.x / tile), cz = Math.floor(p.z / tile);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cutouts.add(`${cx + dx}:${cz + dz}`);
    }
    for (let x = Math.floor(minX / tile) * tile; x < maxX; x += tile) for (let z = Math.floor(minZ / tile) * tile; z < maxZ; z += tile) {
      const coast = 2600 + 380 * Math.sin(z / 1300);
      const westernBay = x < -3600 && z > 1200 && z < 3300;
      const land = network.id === 'prototype' || (!westernBay && (x < coast || Math.hypot((x - 4300) / 700, (z - 3300) / 1600) < 1));
      const cut = cutouts.has(`${x / tile}:${z / tile}`);
      const key = land ? (x > coast - 128 ? 'shore' : 'ground') : 'water';
      // Missing land tiles are intentional open cuts at low ramps/portals, with a seabed below.
      const y = land ? cut ? -55 : 4 : 0;
      this.quad(key, { x, y, z }, { x, y, z: z + tile }, { x: x + tile, y, z: z + tile }, { x: x + tile, y, z });
    }
  }

  draw(cars: RenderCar[], focus: RenderCar, dt: number): void {
    const eye = this.freeCamera ? this.cameraWorld : focus;
    const ox = Math.floor(eye.x / CHUNK) * CHUNK, oz = Math.floor(eye.z / CHUNK) * CHUNK;
    for (const batch of this.chunks.values()) {
      batch.group.visible = roadChunkVisible(batch.x, batch.z, batch.radius, eye);
      if (batch.group.visible) batch.group.position.set(batch.x - ox, 0, batch.z - oz);
    }
    const active = new Set(cars.map(c => c.id));
    for (const [id, mesh] of this.cars) if (!active.has(id)) { this.scene.remove(mesh); this.cars.delete(id); }
    for (const car of cars) {
      let mesh = this.cars.get(car.id);
      if (!mesh) {
        mesh = new THREE.Group();
        const body = new THREE.Mesh(this.cube, this.materials.get(car.player ? 'player' : 'car'));
        body.scale.set(1.8, .8, 4.6); body.position.y = .6;
        const cabin = new THREE.Mesh(this.cube, this.materials.get('glass'));
        cabin.scale.set(1.55, .65, 2.3); cabin.position.set(0, 1.2, .1);
        mesh.add(body, cabin); this.cars.set(car.id, mesh); this.scene.add(mesh);
      }
      mesh.visible = Math.hypot(car.x - eye.x, car.z - eye.z) < 6000;
      mesh.position.set(car.x - ox, car.y + .08, car.z - oz);
      mesh.rotation.set(Math.atan(car.grade), -car.heading, 0, 'YXZ');
    }
    const tunnel = focus.tunnel;
    const distance = tunnel ? 7 : 12, height = tunnel ? 2.8 : 5;
    const desired = new THREE.Vector3(focus.x - Math.sin(focus.heading) * distance, focus.y + height - focus.grade * distance, focus.z + Math.cos(focus.heading) * distance);
    const edge = edgeById(this.network, focus.edgeId);
    const behind = sampleEdge(edge, focus.s - distance, focus.d);
    if (tunnel) {
      // Keep the chase camera in the bore even when the driver scrapes a wall or the grade changes.
      const safeD = Math.max(-behind.halfWidth + 1, Math.min(behind.halfWidth - 1, focus.d));
      const safe = sampleEdge(edge, focus.s - distance, safeD);
      desired.set(safe.x, safe.y + height, safe.z);
    }
    if (!this.freeCamera) {
    if (!this.initialized || this.cameraWorld.distanceTo(desired) > 80) { this.cameraWorld.copy(desired); this.initialized = true; }
    else this.cameraWorld.lerp(desired, 1 - Math.exp(-dt * 9));
    if (tunnel) this.cameraWorld.copy(desired);
    else this.cameraWorld.y = Math.max(this.cameraWorld.y, behind.y + 1.2);
    }
    this.camera.position.set(this.cameraWorld.x - ox, this.cameraWorld.y, this.cameraWorld.z - oz);
    if (this.freeCamera) {
      this.camera.lookAt(this.camera.position.x + Math.sin(this.flightYaw) * Math.cos(this.flightPitch), this.camera.position.y + Math.sin(this.flightPitch), this.camera.position.z - Math.cos(this.flightYaw) * Math.cos(this.flightPitch));
    } else this.camera.lookAt(focus.x - ox + Math.sin(focus.heading) * 10, focus.y + 1.2 + focus.grade * 10, focus.z - oz - Math.cos(focus.heading) * 10);
    this.interiorLight.position.set(focus.x - ox, focus.y + 3.5, focus.z - oz);
    this.interiorLight.intensity = tunnel ? 90 : 0;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.scene.traverse(object => { if (object instanceof THREE.Mesh && object.geometry !== this.cube) object.geometry.dispose(); });
    this.cube.dispose();
    const textures = new Set<THREE.Texture>();
    for (const material of this.materials.values()) { if (material.map) textures.add(material.map); material.dispose(); }
    for (const texture of textures) texture.dispose();
    this.renderer.dispose(); this.scene.clear(); this.chunks.clear(); this.cars.clear();
  }
}
