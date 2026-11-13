import * as THREE from 'three';
import { CHUNK_LEN, GROUND_LEVEL, type Road, type RoadChunk, type RoadPoint } from '../sim/road';
import { MIAMI, type MapTheme } from './miami';

const GROUND = new THREE.Color(0x0a0c0f);
const WATER = new THREE.Color(0x060c16);

/**
 * Ground (or water) from the edge of the chunk terrain to the horizon. Chunk terrain only reaches
 * 420 m from the road; from high up (viaducts, the bridge) a band of sky showed between its edge and
 * the horizon and distant buildings looked like they floated. This disc follows the camera at the
 * lowest terrain level in view, so it hides under nearer terrain and only fills that gap; when a
 * bridge is in view it becomes open water.
 */
export class FarGround {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshStandardMaterial;
  private disposed = false;
  private borrowed = false;

  constructor(private readonly theme: MapTheme = 'highway') {
    this.mat = new THREE.MeshStandardMaterial({ color: GROUND.clone(), roughness: 1, metalness: 0 });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(3200, 64).rotateX(-Math.PI / 2), this.mat);
    this.mesh.frustumCulled = false;
  }

  update(road: Road, s: number, camera: THREE.Vector3): void {
    let level = 0;
    let water = this.theme === 'miami';
    for (const c of road.chunks) {
      if (c.void || c.s0 + CHUNK_LEN < s - 300 || c.s0 > s + 1300) continue;
      level = Math.min(level, GROUND_LEVEL[c.kind]);
      if (c.kind === 'bridge') water = true;
    }
    this.mesh.position.set(camera.x, this.theme === 'miami' ? MIAMI.waterLevel - 0.35 : level - 0.35, camera.z);
    if (this.borrowed) return;
    if (this.theme === 'miami') this.mat.color.setHex(MIAMI.water);
    else this.mat.color.copy(water ? WATER : GROUND);
    this.mat.roughness = this.theme === 'miami' ? 0.32 : water ? 0.16 : 1;
    this.mat.metalness = this.theme === 'miami' ? 0.2 : water ? 0.6 : 0;
  }

  /** RoadView owns this material; the far disc only borrows it, including its shared normal map. */
  setMiamiMaterial(material: THREE.Material): void { this.mesh.material = material; this.borrowed = true; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** Advert panel texture for the blimp: fictional neon branding. */
function blimpAd(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 256;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#05060c';
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#ff3fb4';
  g.lineWidth = 10;
  g.strokeRect(12, 12, 1000, 232);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.font = '800 132px "Segoe UI", Arial, sans-serif';
  g.shadowColor = '#ff3fb4';
  g.shadowBlur = 24;
  g.fillStyle = '#ffd3f0';
  g.fillText('MIDNIGHT', 400, 132);
  g.shadowColor = '#3fe0ff';
  g.fillStyle = '#d6f8ff';
  g.font = '800 132px "Segoe UI", Arial, sans-serif';
  g.fillText('RUN', 845, 132);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The blimp is modelled at ~80 m and drawn this much bigger (≈ 165 m long). */
const BLIMP_SCALE = 2.1;

/**
 * A slow glowing blimp over the middle of the bay, shown while a bridge is within ~1.5 km: silver hull,
 * lit advert panels on both flanks (bloom), blinking navigation lights. Nothing of it is fogged: the
 * haze is a ground layer, and a fogged hull behind unfogged signs looked like floating panels.
 */
/**
 * Part of the hull's surface (ellipsoid with radius rx across, rz along) on one side, lifted a hair
 * off it: z from zFrom to zTo (texture u runs that way), up to halfAngle above and below the side.
 * Faces outward; the advert on it reads left to right from outside on either side.
 */
function hullPatch(side: number, zFrom: number, zTo: number, halfAngle: number, rx: number, rz: number): THREE.BufferGeometry {
  const NZ = 28;
  const NA = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NZ; i++) {
    const t = i / NZ;
    const z = zFrom + (zTo - zFrom) * t;
    const r = rx * Math.sqrt(Math.max(0, 1 - (z / rz) ** 2));
    for (let j = 0; j <= NA; j++) {
      const a = (j / NA - 0.5) * 2 * halfAngle;
      pos.push(side * r * Math.cos(a), r * Math.sin(a), z);
      uv.push(t, j / NA);
    }
  }
  for (let i = 0; i < NZ; i++) {
    for (let j = 0; j < NA; j++) {
      const a = i * (NA + 1) + j;
      const b = a + NA + 1;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Winding depends on the side and the direction of z: make the faces point away from the hull.
  const n = g.getAttribute('normal');
  if (n.getX(Math.floor(n.count / 2)) * side < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

export class Blimp {
  readonly group = new THREE.Group();
  private readonly navRed: THREE.MeshBasicMaterial;
  private readonly navGreen: THREE.MeshBasicMaterial;
  private readonly strobe: THREE.MeshBasicMaterial;
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };

  constructor() {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x8f97a3, emissive: 0x1c2029, roughness: 0.45, metalness: 0.35, fog: false });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e24, emissive: 0x07080a, roughness: 0.7, fog: false });
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), hullMat);
    hull.scale.set(9, 9, 37);
    this.group.add(hull);

    // Lit parts ignore the fog: a glowing sign reads through the haze long before the hull does.
    // The advert is printed on the hull itself (a flat board used to cut through its bulge mid-flank).
    const adMat = new THREE.MeshBasicMaterial({
      map: blimpAd(),
      color: new THREE.Color(1.7, 1.7, 1.7),
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    for (const side of [-1, 1]) {
      // Seen from the right (+x) the text runs toward the nose (-z), from the left toward the tail.
      const [from, to] = side > 0 ? [19, -19] : [-19, 19];
      this.group.add(new THREE.Mesh(hullPatch(side, from, to, 0.5, 9.06, 37.15), adMat));
    }
    const gondola = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 11), dark);
    gondola.position.set(0, -9.6, -4);
    this.group.add(gondola);
    const windows = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.7, 9), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.8), fog: false }));
    windows.position.set(0, -9.4, -4);
    this.group.add(windows);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 7), dark);
      fin.position.set(0, 0, 32);
      fin.rotation.z = (k * Math.PI) / 2;
      fin.geometry.translate(0, 7, 0);
      this.group.add(fin);
    }
    this.navRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.2), fog: false });
    this.navGreen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 5, 0.6), fog: false });
    this.strobe = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6), fog: false });
    const dot = new THREE.SphereGeometry(0.45, 8, 6);
    const add = (mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(dot, mat);
      m.position.set(x, y, z);
      this.group.add(m);
    };
    // Nav lights ahead of the advert (on it they blotted out a letter).
    add(this.navRed, -7, 0, -24);
    add(this.navGreen, 7, 0, -24);
    add(this.strobe, 0, 9.2, 0);
    add(this.strobe, 0, 0, 37.3);
    this.group.scale.setScalar(BLIMP_SCALE);
    this.group.visible = false;
  }

  update(road: Road, s: number, ox: number, oz: number, time: number): void {
    let bridge: RoadChunk | null = null;
    for (const c of road.chunks) {
      if (c.kind === 'bridge' && !c.void) {
        bridge = c;
        break;
      }
    }
    if (!bridge) {
      this.group.visible = false;
      return;
    }
    // Everything derives from the section start, not from whichever bridge chunk is loaded first:
    // that one changes as chunks unload behind the car (the blimp used to jump sides mid-bridge).
    const start = bridge.s0 - bridge.sectionIndex * CHUNK_LEN;
    const len = bridge.sectionLen * CHUNK_LEN;
    if (s < start - 1500 || s > start + len + 300) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const side = Math.round(start / CHUNK_LEN) % 2 === 0 ? 1 : -1;
    // Over the middle of the bay, nose turned in toward the road so the flank advert faces cars on
    // their way across (turned away, it was seen tail-on, as a ball).
    const along = start + len / 2 + 30 * Math.sin(time * 0.02);
    road.toWorld(along, side * 170, this.pt);
    this.group.position.set(this.pt.x - ox, 84 + 2.5 * Math.sin(time * 0.35), this.pt.z - oz);
    this.group.rotation.set(0, -this.pt.th + side * 0.5 +Math.sin(time * 0.04) * 0.08, 0.015 * Math.sin(time * 0.3));
    const blink = time % 1.4 < 0.12;
    this.strobe.color.setScalar(blink ? 7 : 0.05);
    const nav = 0.6 + 0.4 * Math.sin(time * 3);
    this.navRed.color.setRGB(5 * nav, 0.3 * nav, 0.2 * nav);
    this.navGreen.color.setRGB(0.3 * nav, 5 * nav, 0.6 * nav);
  }
}
