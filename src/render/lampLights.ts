import * as THREE from 'three';
import { smoothstep } from '../core/math';
import type { Road, RoadPoint } from '../sim/road';
import type { LampAnchor, RoadView } from './roadView';

/** Candela of one lamp light at full weight. Kept low: it should glint on the paint, not flood the screen. */
const INTENSITY = 160;
/** Lights are centred a little ahead of the car, where the camera looks. */
const AHEAD = 6;

/**
 * A handful of real point lights hop between the street / tunnel lamps nearest to the car, so its
 * paint catches each lamp as it passes. The decals light the road everywhere else for free.
 * Weights fade to zero by the time a lamp drops out of the nearest set, so lights never pop.
 */
export class LampLights {
  readonly group = new THREE.Group();
  private readonly lights: THREE.PointLight[] = [];
  private readonly cand: LampAnchor[] = [];
  private readonly pt: RoadPoint = { x: 0, z: 0, th: 0, k: 0 };
  private center = 0;
  private readonly byDistance = (a: LampAnchor, b: LampAnchor) =>
    Math.abs(a.s - this.center) / a.spacing - Math.abs(b.s - this.center) / b.spacing;

  constructor(count = 4) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 24, 2);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  update(roadView: RoadView, road: Road, s: number, ox: number, oz: number): void {
    this.center = s + AHEAD;
    this.cand.length = 0;
    roadView.collectAnchors(s - 70, s + 90, this.cand);
    this.cand.sort(this.byDistance);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const a = this.cand[i];
      if (!a) {
        l.intensity = 0;
        continue;
      }
      const x = Math.abs(a.s - this.center) / a.spacing;
      road.toWorld(a.s, a.d, this.pt);
      l.position.set(this.pt.x - ox, a.y, this.pt.z - oz);
      l.color.copy(a.color);
      l.intensity = INTENSITY * (1 - smoothstep((x - 0.7) / 1.3));
    }
  }
}
