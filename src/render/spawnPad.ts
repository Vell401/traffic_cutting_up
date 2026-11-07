import * as THREE from 'three';
import { RING_LEN, SPAWN_D, spawnS } from '../sim/ring';
import type { Road, RoadPoint } from '../sim/road';

const FREE = new THREE.Color(0.55, 0.58, 0.62);
const MINE = new THREE.Color(0xa259ff).multiplyScalar(1.9);
/** Box painted around a place: a bit bigger than a car. */
const BOX_W = 2.3;
const BOX_L = 5.6;
const LINE = 0.14;

function numberTexture(n: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.font = '800 104px "Chakra Petch", "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function wordTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.font = '800 92px "Chakra Petch", "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Place {
  root: THREE.Group;
  mat: THREE.MeshBasicMaterial;
}

/**
 * Online spawn pad: numbered boxes painted on the right shoulder, one per spawn place, lit in the
 * colour of the driver who owns it (ours in the accent colour, free ones grey), with SPAWN written on
 * the shoulder ahead of the first one. Drawn on the lap nearest to our car.
 */
export class SpawnPad {
  readonly group = new THREE.Group();
  private readonly places: Place[] = [];
  private readonly word: THREE.Mesh;
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };

  constructor(count: number) {
    const ground = (w: number, l: number) => new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const root = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: FREE.clone(), transparent: true, depthWrite: false });
      for (const [w, l, x, z] of [
        [BOX_W, LINE, 0, -BOX_L / 2],
        [BOX_W, LINE, 0, BOX_L / 2],
        [LINE, BOX_L, -BOX_W / 2, 0],
        [LINE, BOX_L, BOX_W / 2, 0],
      ]) {
        const m = new THREE.Mesh(ground(w, l), mat);
        m.position.set(x, 0.035, z);
        root.add(m);
      }
      if (count > 1) {
        // The number sits behind the box (cars face -Z), readable from the chase camera; it shares the box colour.
        const num = new THREE.Mesh(ground(1.5, 1.5), new THREE.MeshBasicMaterial({ map: numberTexture(i + 1), transparent: true, depthWrite: false }));
        num.position.set(0, 0.035, BOX_L / 2 + 1.1);
        (num.material as THREE.MeshBasicMaterial).color = mat.color;
        root.add(num);
      }
      root.visible = false;
      this.group.add(root);
      this.places.push({ root, mat });
    }
    this.word = new THREE.Mesh(
      // Across the shoulder, stretched along the road like painted road text (read at a grazing angle).
      ground(2.2, 1.5),
      new THREE.MeshBasicMaterial({ map: wordTexture('SPAWN'), color: new THREE.Color(1.3, 1.3, 1.3), transparent: true, depthWrite: false }),
    );
    this.word.visible = false;
    this.group.add(this.word);
    this.group.renderOrder = 1;
  }

  /** owners[i]: paint of the driver on place i (null = free); mine: our place (-1 unknown). */
  update(road: Road, ownS: number, ox: number, oz: number, owners: readonly (number | null)[], mine: number): void {
    for (let i = 0; i < this.places.length; i++) {
      const p = this.places[i];
      const home = spawnS(i);
      const s = home + RING_LEN * Math.round((ownS - home) / RING_LEN);
      const near = Math.abs(s - ownS) < 1200;
      p.root.visible = near;
      if (!near) continue;
      road.toWorld(s, SPAWN_D, this.pt);
      p.root.position.set(this.pt.x - ox, 0, this.pt.z - oz);
      p.root.rotation.y = -this.pt.th;
      const owner = owners[i];
      // One shared place: always in the accent colour.
      if (i === mine || this.places.length === 1) p.mat.color.copy(MINE);
      else if (owner != null) p.mat.color.setHex(owner).multiplyScalar(1.6);
      else p.mat.color.copy(FREE);
    }
    const first = spawnS(0) + 14;
    const s = first + RING_LEN * Math.round((ownS - first) / RING_LEN);
    this.word.visible = Math.abs(s - ownS) < 1200;
    if (this.word.visible) {
      road.toWorld(s, SPAWN_D, this.pt);
      this.word.position.set(this.pt.x - ox, 0.035, this.pt.z - oz);
      this.word.rotation.y = -this.pt.th;
    }
  }
}
