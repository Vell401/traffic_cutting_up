import * as THREE from 'three';
import { clamp, damp } from '../../core/math';
import type { PlayerCar } from '../../sim/vehicle';

/** The delivered metric atlas: 0–320 km/h over 240°, 0–8 krpm over 270°. */
export const W204_DIALS = {
  speed: { max: 320, start: -150 * Math.PI / 180, sweep: 240 * Math.PI / 180 },
  tach: { max: 8000, start: -135 * Math.PI / 180, sweep: 270 * Math.PI / 180 },
} as const;
export const W204_READOUT = { width: 256, height: 128, hz: 12 } as const;

type Needle = { node: THREE.Object3D; zero: THREE.Quaternion; axis: THREE.Vector3 };
type Replacement = { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] };
type AssistSymbol = 'tcs_PBR' | 'esc_PBR';
type SymbolName = 'signal_L_PBR' | 'signal_R_PBR' | 'highbeam_PBR' | 'lowbeam_PBR' | 'parkingbrake_PBR' | AssistSymbol;
const SYMBOLS: readonly SymbolName[] = ['signal_L_PBR', 'signal_R_PBR', 'highbeam_PBR', 'lowbeam_PBR', 'parkingbrake_PBR', 'tcs_PBR', 'esc_PBR'];
export const W204_ASSIST_LAMP = { on: 0xffc238, dark: 0x000000, period: .5, lit: .28 } as const;
type AssistTelemetry = PlayerCar & {
  tractionControlEnabled?: boolean; espEnabled?: boolean; slipRear?: number; esc?: number;
  tune: PlayerCar['tune'] & { tcSlip?: number; escAssist?: number };
};

/** ESP is measured intervention. TC is a conservative wheel-slip indication, not invented torque telemetry. */
export function w204AssistState(car: PlayerCar): { tcOff: boolean; tcActive: boolean; espOff: boolean; espActive: boolean } {
  const state = car as AssistTelemetry, tune = state.tune;
  // Missing/non-finite assistance strength is unknown, not an OFF state, intervention or fault.
  const tcKnown = Number.isFinite(tune?.tractionControl), espKnown = Number.isFinite(tune?.escAssist);
  const tcOff = state.tractionControlEnabled === false || (tcKnown && tune.tractionControl <= 0);
  const espOff = state.espEnabled === false || (espKnown && tune.escAssist! <= 0);
  const tcArmed = state.tractionControlEnabled === true && tcKnown && tune.tractionControl > 0;
  const espArmed = state.espEnabled === true && espKnown && tune.escAssist! > 0;
  // Match the rear slip threshold used by DriftCar. Slip alone while coasting/braking, in neutral,
  // on a shift/fuel cut or with the handbrake up must not be presented as a TC intervention.
  // Clutch/actual TC torque-cut telemetry is not public; never access the solver's private driveTq.
  const powered = car.gear > 0 && car.throttle > .05 && car.brake < .02 && !car.handbrake && car.shiftT <= 0
    && Number.isFinite(car.rpm) && car.rpm < (tune?.redline ?? 0);
  const tcActive = !tcOff && tcArmed && powered && Number.isFinite(state.slipRear)
    && Number.isFinite(tune?.tcSlip) && state.slipRear! > tune.tcSlip! + .01;
  const espActive = !espOff && espArmed && Number.isFinite(state.esc) && state.esc! > .04;
  return { tcOff, tcActive, espOff, espActive };
}

const FONT: Record<string, string> = {
  '0': '111/101/101/101/111', '1': '010/110/010/010/111', '2': '111/001/111/100/111',
  '3': '111/001/111/001/111', '4': '101/101/111/001/001', '5': '111/100/111/001/111',
  '6': '111/100/111/101/111', '7': '111/001/010/010/010', '8': '111/101/111/101/111', '9': '111/101/111/001/111',
  D: '110/101/101/101/110', M: '101/111/111/101/101', N: '101/111/111/111/101', R: '110/101/110/101/101',
  K: '101/101/110/101/101', H: '101/101/111/101/101', '/': '001/001/010/100/100',
  O: '111/101/101/101/111', F: '111/100/110/100/100', T: '111/010/010/010/010',
  C: '111/100/100/100/111', E: '111/100/110/100/111', S: '111/100/111/001/111', P: '110/101/110/100/100',
};

/** A tiny deterministic raster avoids DOM/canvas dependencies and whole-dashboard uploads. */
class ReadoutRaster {
  readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) { this.data = new Uint8Array(width * height * 4); }
  rect(x: number, y: number, w: number, h: number, color: readonly number[]): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * this.width + xx) * 4;
      this.data[i] = color[0]; this.data[i + 1] = color[1]; this.data[i + 2] = color[2]; this.data[i + 3] = color[3] ?? 255;
    }
  }
  text(value: string, cx: number, cy: number, scale: number): void {
    let x = Math.round(cx - (value.length * 4 - 1) * scale / 2);
    const y = Math.round(cy - 5 * scale / 2);
    for (const c of value) {
      FONT[c]?.split('/').forEach((row, j) => {
        for (let i = 0; i < 3; i++) if (row[i] === '1') this.rect(x + i * scale, y + j * scale, scale, scale, [205, 218, 211]);
      });
      x += 4 * scale;
    }
  }
  texture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.data, this.width, this.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.flipY = true; t.generateMipmaps = false;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }
}

/** Remap an authored quad, not an eye-facing rectangle floating over the cluster. */
function mapQuad(g: THREE.BufferGeometry, first: number, rect: readonly number[], width: number, height: number): void {
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  const bounds = new THREE.Box3();
  for (let i = first; i < first + 4; i++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i));
  for (let i = first; i < first + 4; i++) {
    // The intact Mercedes_W204 parent turns local +X into model-world -X.
    const u = 1 - (p.getX(i) - bounds.min.x) / (bounds.max.x - bounds.min.x);
    const v = 1 - (p.getY(i) - bounds.min.y) / (bounds.max.y - bounds.min.y);
    uv.setXY(i, (rect[0] + u * rect[2]) / width, 1 - (rect[1] + v * rect[3]) / height);
  }
}

function symbolTexture(name: SymbolName, off = false): THREE.DataTexture {
  const r = new ReadoutRaster(32, 32), white = [255, 255, 255];
  if (name.startsWith('signal_')) {
    for (let y = 5; y < 27; y++) for (let x = 3; x < 29; x++) {
      const xx = name === 'signal_L_PBR' ? x : 31 - x;
      if ((xx >= 13 && xx < 28 && y >= 12 && y < 20) || (xx < 17 && Math.abs(y - 15.5) < xx - 2)) r.rect(x, y, 1, 1, white);
    }
  } else if (name === 'tcs_PBR' || name === 'esc_PBR') {
    // A compact car/skid telltale. OFF is baked once, not uploaded on each blink.
    r.rect(11, 3, 10, 2, white); r.rect(9, 5, 2, 5, white); r.rect(21, 5, 2, 5, white);
    r.rect(7, 10, 18, 7, white); r.rect(8, 17, 3, 3, white); r.rect(21, 17, 3, 3, white);
    for (let x = 8; x < 13; x++) r.rect(x, 20 + (x % 3), 2, 2, white);
    for (let x = 20; x < 25; x++) r.rect(x, 20 + ((x + 1) % 3), 2, 2, white);
    r.text(off ? 'OFF' : name === 'tcs_PBR' ? 'TC' : 'ESP', 16, 28, 1);
  } else if (name === 'parkingbrake_PBR') {
    for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if (d > 11 && d < 14) r.rect(x, y, 1, 1, white);
    }
    r.rect(12, 8, 3, 17, white); r.rect(15, 8, 7, 3, white); r.rect(19, 11, 3, 5, white); r.rect(15, 16, 7, 3, white);
  } else {
    for (let y = 7; y < 25; y++) for (let x = 16; x < 29; x++) {
      const d = ((x - 17) / 11) ** 2 + ((y - 16) / 9) ** 2;
      if ((d < 1 && d > .48) || x < 19) r.rect(x, y, 1, 1, white);
    }
    for (let y = 8; y <= 23; y += 7) for (let x = 3; x < 13; x++) r.rect(x, y + (name === 'lowbeam_PBR' ? Math.floor((12 - x) / 3) : 0), 1, 2, white);
  }
  return r.texture();
}

export class W204Instruments {
  private readonly needles: Partial<Record<'speed' | 'tach', Needle>> = {};
  private readonly replacements: Replacement[] = [];
  private readonly hidden: { node: THREE.Object3D; visible: boolean }[] = [];
  private readonly symbols = new Map<SymbolName, THREE.MeshBasicMaterial>();
  private readonly assists = new Map<AssistSymbol, {
    material: THREE.MeshBasicMaterial; icon: THREE.Texture; off: THREE.Texture; active: boolean; phase: number;
  }>();
  private readonly textures: THREE.Texture[] = [];
  private readonly turn = new THREE.Quaternion();
  private readonly raster = new ReadoutRaster(W204_READOUT.width, W204_READOUT.height);
  readonly readouts: THREE.DataTexture;
  private speed = 0;
  private rpm = 0;
  private timer = 1;
  private key = '';
  private disposed = false;

  constructor(model: THREE.Group) {
    this.readouts = this.raster.texture();
    this.readouts.name = 'W204 live gear / speed'; this.textures.push(this.readouts);
    let face: THREE.Mesh | undefined;
    model.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === 'c63w204kene_c63_interior_dash_PBR') face = mesh;
    });
    for (const [kind, suffix] of [['speed', 'speedo'], ['tach', 'tacho']] as const) {
      const node = model.getObjectByName(`c63w204kene_needle_${suffix}_Selected`);
      if (node && face) this.needles[kind] = this.calibrate(node, face, W204_DIALS[kind].start);
    }
    model.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const name = mesh.material.name;
      if (name === 'c63w204kene_gauges_screen_PBR' && mesh.geometry.getAttribute('position').count === 12) {
        const geometry = mesh.geometry.clone();
        // Three retained LCD islands: transmission, digital speed, units.
        mapQuad(geometry, 0, [0, 0, 128, 64], 256, 128);
        mapQuad(geometry, 4, [0, 64, 128, 64], 256, 128);
        mapQuad(geometry, 8, [128, 64, 128, 64], 256, 128);
        this.replace(mesh, geometry, new THREE.MeshBasicMaterial({ map: this.readouts, toneMapped: false }));
      } else if (SYMBOLS.includes(name as SymbolName) && mesh.geometry.getAttribute('position').count === 4) {
        const symbol = name as SymbolName, texture = symbolTexture(symbol), geometry = mesh.geometry.clone();
        this.textures.push(texture); mapQuad(geometry, 0, [0, 0, 32, 32], 32, 32);
        const material = new THREE.MeshBasicMaterial({ map: texture, alphaTest: .25, toneMapped: false, color: 0x050805 });
        this.symbols.set(symbol, material); this.replace(mesh, geometry, material);
        if (symbol === 'tcs_PBR' || symbol === 'esc_PBR') {
          const off = symbolTexture(symbol, true); this.textures.push(off);
          material.color.setHex(W204_ASSIST_LAMP.dark);
          this.assists.set(symbol, { material, icon: texture, off, active: false, phase: 0 });
        }
      } else if (name === 'abs_PBR') {
        // There is no ABS fault telemetry: an enabled slip limiter is not a malfunction.
        this.hidden.push({ node: mesh, visible: mesh.visible }); mesh.visible = false;
      }
    });
  }

  private updateAssist(symbol: AssistSymbol, off: boolean, active: boolean, dt: number): void {
    const lamp = this.assists.get(symbol);
    if (!lamp) return;
    lamp.phase = active && lamp.active ? (lamp.phase + dt) % W204_ASSIST_LAMP.period : 0;
    lamp.active = active;
    lamp.material.map = off ? lamp.off : lamp.icon;
    lamp.material.color.setHex(off || (active && lamp.phase < W204_ASSIST_LAMP.lit) ? W204_ASSIST_LAMP.on : W204_ASSIST_LAMP.dark);
    lamp.material.userData.assistState = off ? 'off' : active ? 'active' : 'ready';
  }

  private replace(mesh: THREE.Mesh, geometry: THREE.BufferGeometry, material: THREE.MeshBasicMaterial): void {
    this.replacements.push({ mesh, geometry: mesh.geometry, material: mesh.material });
    const original = mesh.material as THREE.Material;
    material.name = original.name; material.opacity = original.opacity; material.side = original.side;
    mesh.geometry = geometry; mesh.material = material;
  }

  private calibrate(node: THREE.Object3D, face: THREE.Mesh, start: number): Needle {
    // Read the actual nearby dial normal, not world/local Z: the speedo was exported unposed,
    // whereas the tach has a baked quaternion. Both retained meshes point along their local +Z.
    const p = face.geometry.getAttribute('position'), normals = face.geometry.getAttribute('normal');
    const origin = node.getWorldPosition(new THREE.Vector3()), point = new THREE.Vector3();
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < p.count; i++) {
      const d = point.fromBufferAttribute(p, i).applyMatrix4(face.matrixWorld).distanceToSquared(origin);
      if (d < distance) { distance = d; nearest = i; }
    }
    const normal = new THREE.Vector3().fromBufferAttribute(normals, nearest).transformDirection(face.matrixWorld);
    if (normal.z < 0) normal.negate();
    const right = new THREE.Vector3(1, 0, 0).projectOnPlane(normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();
    const direction = right.multiplyScalar(Math.cos(start)).addScaledVector(up, Math.sin(start));
    const x = new THREE.Vector3().crossVectors(normal, direction).normalize();
    const parent = node.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    const zero = parent.clone().multiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, normal, direction)));
    // Parent-space pre-multiplication preserves the calibrated face normal for the entire sweep.
    return { node, zero, axis: normal.applyQuaternion(parent).normalize() };
  }

  update(car: PlayerCar, dt: number, highBeam: boolean, left: boolean, right: boolean): void {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? clamp(dt, 0, .25) : 0;
    const speed = Number.isFinite(car.speed) ? car.speed : Number.isFinite(car.vAlong) ? Math.abs(car.vAlong) : 0;
    this.speed = damp(this.speed, clamp(speed * 3.6, 0, W204_DIALS.speed.max), 12, dt);
    this.rpm = damp(this.rpm, Number.isFinite(car.rpm) ? clamp(car.rpm, 0, W204_DIALS.tach.max) : 0, 14, dt);
    for (const [kind, value] of [['speed', this.speed], ['tach', this.rpm]] as const) {
      const n = this.needles[kind], dial = W204_DIALS[kind];
      if (n) n.node.quaternion.copy(this.turn.setFromAxisAngle(n.axis, -value / dial.max * dial.sweep)).multiply(n.zero);
    }
    this.symbols.get('signal_L_PBR')?.color.setHex(left ? 0x79e76e : 0x030803);
    this.symbols.get('signal_R_PBR')?.color.setHex(right ? 0x79e76e : 0x030803);
    this.symbols.get('highbeam_PBR')?.color.setHex(highBeam ? 0x4b93ff : 0x010204);
    this.symbols.get('lowbeam_PBR')?.color.setHex(highBeam ? 0x030803 : 0x75d669);
    this.symbols.get('parkingbrake_PBR')?.color.setHex(car.handbrake ? 0xf0442c : 0x080201);
    const assists = w204AssistState(car);
    this.updateAssist('tcs_PBR', assists.tcOff, assists.tcActive, dt);
    this.updateAssist('esc_PBR', assists.espOff, assists.espActive, dt);
    this.timer += dt;
    if (this.timer < 1 / W204_READOUT.hz) return;
    this.timer = 0;
    const kmh = Math.round(clamp(speed * 3.6, 0, 999));
    const gear = car.gear === 0 ? 'R' : car.gear === -1 ? 'N' : `${car.manual ? 'M' : 'D'}${Number.isFinite(car.gear) ? clamp(car.gear, 1, 7) : 1}`;
    const key = `${kmh}/${gear}`;
    if (key === this.key) return;
    this.key = key;
    this.raster.rect(0, 0, 256, 128, [5, 10, 9]);
    this.raster.text(gear, 64, 32, 9); this.raster.text(String(kmh), 64, 96, 8); this.raster.text('KM/H', 192, 96, 6);
    this.readouts.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.replacements) {
      item.mesh.geometry.dispose(); (item.mesh.material as THREE.Material).dispose();
      item.mesh.geometry = item.geometry; item.mesh.material = item.material;
    }
    for (const item of this.hidden) item.node.visible = item.visible;
    for (const texture of this.textures) texture.dispose();
  }
}
