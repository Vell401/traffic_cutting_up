import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** One wheel position in car space (x right, z back; the right-side wheels, x > 0, face +x). */
export interface WheelPos {
  x: number;
  y: number;
  z: number;
  front: boolean;
}

export interface WheelLook {
  /** Rolling parts, axis along x, outer face toward +x. */
  tyre: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  /** Steers with the wheel but does not roll (brake caliper). */
  fixed: THREE.BufferGeometry | null;
  tyreMat: THREE.Material;
  rimMat: THREE.Material;
  fixedMat: THREE.Material | null;
}

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/**
 * Four wheels as instanced meshes (tyres, rims, calipers: three draw calls). The left wheels are the
 * right ones turned round (a mirror matrix would turn the faces inside out).
 */
export class WheelSet {
  readonly group = new THREE.Group();
  readonly materials: THREE.Material[];
  private readonly rolling: THREE.InstancedMesh[];
  private readonly fixed: THREE.InstancedMesh | null;
  private readonly m = new THREE.Matrix4();
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);

  constructor(
    look: WheelLook,
    private readonly pos: readonly WheelPos[],
  ) {
    const n = pos.length;
    this.rolling = [new THREE.InstancedMesh(look.tyre, look.tyreMat, n), new THREE.InstancedMesh(look.rim, look.rimMat, n)];
    this.fixed = look.fixed && look.fixedMat ? new THREE.InstancedMesh(look.fixed, look.fixedMat, n) : null;
    const all = this.fixed ? [...this.rolling, this.fixed] : this.rolling;
    for (const m of all) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.materials = all.map((m) => m.material as THREE.Material);
    this.update(0, 0);
    for (const m of all) m.computeBoundingSphere();
  }

  /** steer: front wheel angle (rad, + = right); spin: rolled angle (rad). */
  update(steer: number, spin: number): void {
    for (let i = 0; i < this.pos.length; i++) {
      const w = this.pos[i];
      const left = w.x < 0;
      // Positive steer turns the car right, i.e. a rotation by -steer about +y.
      this.p.set(w.x, w.y, w.z);
      if (this.fixed) {
        // Calipers stay at the back of the wheel on both sides: the left ones are turned about z.
        this.qa.setFromAxisAngle(Y, w.front ? -steer : 0);
        if (left) this.qa.multiply(this.qz);
        this.m.compose(this.p, this.qa, this.one);
        this.fixed.setMatrixAt(i, this.m);
      }
      this.qa.setFromAxisAngle(Y, (w.front ? -steer : 0) + (left ? Math.PI : 0));
      this.qb.setFromAxisAngle(X, left ? spin : -spin);
      this.qb.premultiply(this.qa);
      this.m.compose(this.p, this.qb, this.one);
      for (const r of this.rolling) r.setMatrixAt(i, this.m);
    }
    for (const r of this.rolling) r.instanceMatrix.needsUpdate = true;
    if (this.fixed) this.fixed.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- geometry

function tint(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([r, gr, b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  return geo;
}

/** Profile (radius, axial offset) revolved about the x axis. */
function lathe(profile: [number, number][], segments: number): THREE.BufferGeometry {
  // LatheGeometry revolves (x = radius, y = height) about +y; turn it so the axis is +x.
  const g = new THREE.LatheGeometry(
    profile.map(([r, a]) => new THREE.Vector2(r, a)),
    segments,
  );
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** Low-profile tyre: crowned tread, rounded shoulders, sidewall down to the rim lip. */
export function sportTyre(radius: number, width: number, rimR: number): THREE.BufferGeometry {
  const h = width / 2;
  const prof: [number, number][] = [
    [rimR + 0.004, -h + 0.012],
    [rimR + 0.02, -h + 0.004],
    [radius - 0.05, -h],
    [radius - 0.022, -h + 0.008],
    [radius - 0.006, -h + 0.03],
    [radius, -h * 0.55],
    [radius + 0.002, 0],
    [radius, h * 0.55],
    [radius - 0.006, h - 0.03],
    [radius - 0.022, h - 0.008],
    [radius - 0.05, h],
    [rimR + 0.02, h - 0.004],
    [rimR + 0.004, h - 0.012],
  ];
  const g = lathe(prof, 44);
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

/**
 * Six-spoke forged-style rim with a deep lip, centre cap, five lug nuts and the brake disc behind
 * it; vertex colours carry the metal shades.
 */
export function sportRim(rimR: number, width: number): THREE.BufferGeometry {
  const h = width / 2;
  const face = h - 0.012;
  const parts: THREE.BufferGeometry[] = [];
  const metal = [0.78, 0.8, 0.83] as const;
  const dark = [0.18, 0.19, 0.2] as const;
  // Barrel (seen through the spokes) and the polished lip.
  parts.push(tint(lathe([[rimR - 0.012, face - 0.03], [rimR - 0.012, -h + 0.01]], 40), ...dark));
  parts.push(
    tint(
      lathe(
        [
          [rimR + 0.012, face - 0.006],
          [rimR + 0.006, face + 0.004],
          [rimR - 0.004, face - 0.004],
          [rimR - 0.016, face - 0.03],
        ],
        40,
      ),
      0.9,
      0.91,
      0.93,
    ),
  );
  // Spokes: tapered, concave (the hub sits deeper than the lip), slightly twisted pairs.
  const SPOKES = 6;
  for (let k = 0; k < SPOKES; k++) {
    const a = (k / SPOKES) * Math.PI * 2;
    const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 4);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      // Box local: z along the spoke (0 at hub → 1 at lip), y across, x depth.
      const t = p.getZ(i) + 0.5;
      const r = 0.055 + t * (rimR - 0.07);
      const w = (0.034 + t * 0.026) * (p.getY(i) + 0.5 - 0.5);
      const depth = face - 0.036 + t * 0.016 + (p.getX(i) + 0.5) * 0.024 - (1 - t) * 0.012;
      p.setXYZ(i, depth, w, r);
    }
    g.rotateX(a);
    g.computeVertexNormals();
    parts.push(tint(g, ...metal));
  }
  // Hub, centre cap and lug nuts.
  parts.push(tint(lathe([[0.068, face - 0.03], [0.06, face - 0.006], [0.04, face + 0.002], [0.001, face + 0.004]], 24), ...metal));
  parts.push(tint(lathe([[0.03, face + 0.002], [0.026, face + 0.008], [0.001, face + 0.012]], 18), 0.08, 0.08, 0.09));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const nut = new THREE.CylinderGeometry(0.0075, 0.0085, 0.018, 6).rotateZ(Math.PI / 2);
    nut.translate(face + 0.006, Math.cos(a) * 0.045, Math.sin(a) * 0.045);
    parts.push(tint(nut, 0.85, 0.86, 0.88));
  }
  // Brake disc (with its hat) behind the spokes.
  parts.push(tint(lathe([[0.07, -0.02], [0.175, -0.02], [0.175, 0.006], [0.07, 0.006], [0.07, -0.02]], 36), 0.33, 0.33, 0.34));
  parts.push(tint(lathe([[0.07, 0.006], [0.07, 0.03], [0.001, 0.03]], 24), 0.22, 0.22, 0.23));
  for (const g of parts) if (!g.getAttribute('normal')) g.computeVertexNormals();
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

/** Brake caliper straddling the disc at the back of the wheel (fixed: steers, never rolls). */
export function caliper(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const a0 = -0.55;
  const a1 = 0.55;
  s.absarc(0, 0, 0.192, a0, a1, false);
  s.absarc(0, 0, 0.138, a1, a0, true);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 10 });
  // Shape x → back (+z), shape y → up; the extrusion becomes the axle direction and straddles the disc.
  g.translate(0, 0, -0.02);
  g.rotateY(-Math.PI / 2);
  g.deleteAttribute('uv');
  return g;
}

/** Plain wheels for the simple coupe: cylinder tyre and hub. */
export function plainWheel(radius: number, width: number): { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry } {
  const tyre = new THREE.CylinderGeometry(radius, radius, width, 24).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(radius * 0.65, radius * 0.65, width + 0.01, 12).rotateZ(Math.PI / 2);
  return { tyre, rim };
}
