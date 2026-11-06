import * as THREE from 'three';
import { clamp, damp, smoothstep } from '../../core/math';
import type { PlayerCar } from '../../sim/vehicle';
import * as G from './gauges';
import { Bucket, Grid } from './grid';
import { cabinShell } from './livery';
import * as S from './r34Shape';

/*
 * R34 cockpit (right-hand drive), built only for our own car and drawn only in the first-person
 * view: dash with the instrument binnacle, live gauges, the dash-top multi-function display, A-pillar
 * gauges, steering wheel with the driver's hands, door cards, headliner and pillars (the greenhouse
 * lining), mirror. Model space like r34Shape (f forward, z = -f).
 */

export interface Cockpit {
  readonly group: THREE.Group;
  /** Camera anchor at the driver's eye. */
  readonly eye: THREE.Object3D;
  update(car: PlayerCar, dt: number): void;
}

const V = (x: number, y: number, f: number) => new THREE.Vector3(x, y, -f);
const EYE = V(S.EYE.x, S.EYE.y, S.EYE.f);
const UP = new THREE.Vector3(0, 1, 0);

function canvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function canvasTex(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Orientation that turns +z toward the eye. */
function facingEye(pos: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(EYE, pos, UP));
}

function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Interior plastics: a faint emissive keeps them readable at night (nothing lights a cabin from inside). */
const mat = (color: number, roughness: number, metalness = 0, emissive = 0x0a0b0c) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive });

// ---------------------------------------------------------------- dash

/** Dash section (f, y) from the windshield down to the knees: plain, and in front of the driver (binnacle and recess). */
const DASH_PLAIN: [number, number][] = [
  [0.575, 0.888], [0.47, 0.905], [0.36, 0.922], [0.26, 0.935], [0.19, 0.938], [0.15, 0.928],
  [0.128, 0.905], [0.118, 0.86], [0.112, 0.78], [0.11, 0.7], [0.13, 0.6], [0.18, 0.54],
];
const DASH_BINNACLE: [number, number][] = [
  [0.575, 0.888], [0.47, 0.905], [0.36, 0.93], [0.28, 0.975], [0.2, 0.996], [0.12, 0.986],
  [0.094, 0.962], [0.116, 0.95], [0.244, 0.927], [0.198, 0.772], [0.12, 0.735], [0.18, 0.54],
];
const BIN_X0 = 0.19;
const BIN_X1 = 0.56;
const CLUSTER = { x: (BIN_X0 + BIN_X1) / 2, y: 0.85, f: 0.221, w: 0.33 };

function buildDash(bk: Bucket): void {
  const xs: number[] = [];
  for (let x = -0.78; x < 0.78 + 1e-9; x += 0.04) xs.push(x);
  for (const [a, b] of [[BIN_X0 - 0.04, BIN_X0 + 0.01], [BIN_X1 - 0.01, BIN_X1 + 0.04], [-0.18, -0.12], [0.12, 0.18]]) {
    for (let x = a; x <= b + 1e-9; x += 0.01) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  const cols = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 0.004);
  const g = new Grid(cols.length, DASH_PLAIN.length);
  cols.forEach((x, i) => {
    const w = smoothstep((x - (BIN_X0 - 0.03)) / 0.03) * smoothstep((BIN_X1 + 0.03 - x) / 0.03);
    const stack = smoothstep((0.16 - Math.abs(x)) / 0.03);
    DASH_PLAIN.forEach(([f, y], j) => {
      const [fb, yb] = DASH_BINNACLE[j];
      let ff = f + (fb - f) * w;
      const yy = y + (yb - y) * w;
      if (j >= 6 && j <= 10) ff -= 0.045 * stack;
      g.set(i, j, x, yy, -ff);
    });
  });
  // i runs right, j from the windshield back and down: Ti × Tj points down into the dash.
  g.emit([bk], () => 0, () => [0, 0], { flip: true });
}

/** Door card: sill under the glass, upper panel, armrest, lower panel (right door, mirrored left). */
function buildDoors(bk: Bucket): void {
  const fs: number[] = [];
  for (let f = 0.52; f > -0.98; f -= 0.04) fs.push(f);
  fs.reverse();
  const rows = (f: number): [number, number][] => {
    const xb = S.baseX(f);
    const yb = S.baseY(f);
    return [
      [xb - 0.012, yb + 0.004],
      [xb - 0.05, yb + 0.006],
      [xb - 0.074, yb - 0.008],
      [xb - 0.08, yb - 0.06],
      [xb - 0.075, 0.72],
      [xb - 0.13, 0.69],
      [xb - 0.14, 0.664],
      [xb - 0.082, 0.64],
      [xb - 0.07, 0.4],
    ];
  };
  const g = new Grid(fs.length, 9);
  fs.forEach((f, i) => rows(f).forEach(([x, y], j) => g.set(i, j, x, y, -f)));
  g.emit([bk], () => 0, () => [0, 0], { mirror: true });
}

// ---------------------------------------------------------------- build

export function buildR34Cockpit(shellGeo: THREE.BufferGeometry): Cockpit {
  const group = new THREE.Group();
  group.name = 'cockpit';
  const dashMat = mat(0x18191c, 0.86);
  const panelMat = mat(0x222428, 0.82);
  const leather = mat(0x101113, 0.55, 0, 0x040405);
  const metal = mat(0x3a3e44, 0.42, 0.7, 0x000000);
  metal.envMapIntensity = 0.5;
  const gloveMat = mat(0x24272d, 0.7, 0, 0x0b0c0e);
  const sleeveMat = mat(0x3a4250, 0.9, 0, 0x0d0f13);
  const shellMat = cabinShell(0x34363b);
  shellMat.emissive.setHex(0x0d0e10);
  const needleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.32, 0.1) });
  const capMat = new THREE.MeshBasicMaterial({ color: 0x111215 });

  group.add(new THREE.Mesh(shellGeo, shellMat));

  // Dash, binnacle, centre stack; door cards.
  const dash = new Bucket();
  buildDash(dash);
  const panels = new Bucket();
  buildDoors(panels);

  // Centre stack face (vents, radio, climate) and the round side vents.
  const stackTex = canvasTex(canvas(512, 512));
  G.drawStack(stackTex.image as HTMLCanvasElement);
  const stack = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.27), new THREE.MeshStandardMaterial({ map: stackTex, roughness: 0.75, emissive: 0xffffff, emissiveMap: stackTex, emissiveIntensity: 0.05 }));
  stack.position.copy(V(0, 0.745, 0.064));
  group.add(stack);
  const ventTex = canvasTex(canvas(128, 128));
  G.drawVent(ventTex.image as HTMLCanvasElement);
  const ventMat = new THREE.MeshStandardMaterial({ map: ventTex, roughness: 0.75, transparent: true, alphaTest: 0.5 });
  for (const x of [-0.66, 0.66]) {
    const vent = new THREE.Mesh(new THREE.CircleGeometry(0.042, 24), ventMat);
    vent.position.copy(V(x, 0.86, 0.113));
    vent.rotation.y = x > 0 ? -0.15 : 0.15;
    group.add(vent);
  }

  // Instrument cluster in the binnacle, facing the eye.
  const PW = CLUSTER.w;
  const PH = (PW * G.CLUSTER_H) / G.CLUSTER_W;
  const clusterCv = canvas(G.CLUSTER_W, G.CLUSTER_H);
  const clusterTex = canvasTex(clusterCv);
  const cluster = new THREE.Group();
  cluster.position.copy(V(CLUSTER.x, CLUSTER.y, CLUSTER.f - 0.004));
  cluster.rotation.x = -0.28;
  group.add(cluster);
  cluster.add(new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: clusterTex })));
  const dialPos = (d: G.DialSpec) => new THREE.Vector3((d.cx / G.CLUSTER_W - 0.5) * PW, (0.5 - d.cy / G.CLUSTER_H) * PH, 0.002);
  const dialR = (d: G.DialSpec) => (d.r / G.CLUSTER_W) * PW;
  const needleGeo = (len: number, w: number) => {
    const s = new THREE.Shape([new THREE.Vector2(-len * 0.18, -w), new THREE.Vector2(len, -w * 0.3), new THREE.Vector2(len, w * 0.3), new THREE.Vector2(-len * 0.18, w)]);
    return new THREE.ShapeGeometry(s);
  };
  const needle = (parent: THREE.Object3D, pos: THREE.Vector3, len: number, w: number) => {
    const m = new THREE.Mesh(needleGeo(len, w), needleMat);
    m.position.copy(pos);
    parent.add(m);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(w * 2.2, 16), capMat);
    cap.position.copy(pos).setZ(pos.z + 0.001);
    parent.add(cap);
    return m;
  };
  const speedNeedle = needle(cluster, dialPos(G.SPEEDO), dialR(G.SPEEDO) * 0.9, 0.0024);
  const tachNeedle = needle(cluster, dialPos(G.TACH), dialR(G.TACH) * 0.9, 0.0028);
  const boostNeedle = needle(cluster, dialPos(G.BOOST), dialR(G.BOOST) * 0.86, 0.0022);
  // Digital insert (gear, speed) low in the tach, shift light above it.
  const digCv = canvas(256, 128);
  const digTex = canvasTex(digCv);
  const dig = new THREE.Mesh(new THREE.PlaneGeometry(dialR(G.TACH) * 1.1, dialR(G.TACH) * 0.55), new THREE.MeshBasicMaterial({ map: digTex }));
  dig.position.copy(dialPos(G.TACH)).add(new THREE.Vector3(0, -dialR(G.TACH) * 0.55, -0.0005));
  cluster.add(dig);
  const shiftMat = new THREE.MeshBasicMaterial({ color: 0x220302 });
  const shift = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 16), shiftMat);
  shift.position.copy(dialPos(G.TACH)).add(new THREE.Vector3(0, PH * 0.5 + 0.004, 0));
  cluster.add(shift);

  // Multi-function display pod on the dash top centre.
  const mfdCv = canvas(256, 128);
  const mfdTex = canvasTex(mfdCv);
  const mfdPos = V(0, 0.966, 0.33);
  const mfdQ = facingEye(mfdPos);
  const pod = new THREE.ExtrudeGeometry(roundRect(0.215, 0.088, 0.012), { depth: 0.05, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 3 });
  pod.translate(0, 0, -0.056);
  pod.applyQuaternion(mfdQ).translate(mfdPos.x, mfdPos.y, mfdPos.z);
  dash.addGeometry(pod);
  const mfd = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.072), new THREE.MeshBasicMaterial({ map: mfdTex }));
  mfd.position.copy(mfdPos).add(new THREE.Vector3(0, 0, 0.0005).applyQuaternion(mfdQ));
  mfd.quaternion.copy(mfdQ);
  group.add(mfd);

  // Two gauges on the right A-pillar.
  const podCv = canvas(G.POD_W, G.POD_H);
  const podTex = canvasTex(podCv);
  G.drawPod(podCv);
  const podMat = new THREE.MeshBasicMaterial({ map: podTex });
  const pillarNeedles: THREE.Mesh[] = [];
  [V(0.688, 0.968, 0.345), V(0.664, 1.04, 0.255)].forEach((p, k) => {
    const q = facingEye(p);
    const housing = new THREE.CylinderGeometry(0.036, 0.03, 0.04, 24).rotateX(Math.PI / 2).translate(0, 0, -0.022);
    housing.applyQuaternion(q).translate(p.x, p.y, p.z);
    dash.addGeometry(housing);
    const face = new THREE.CircleGeometry(0.03, 28);
    const uv = face.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + k * 0.5);
    const holder = new THREE.Group();
    holder.position.copy(p);
    holder.quaternion.copy(q);
    holder.add(new THREE.Mesh(face, podMat));
    pillarNeedles.push(needle(holder, new THREE.Vector3(0, 0, 0.001), 0.024, 0.0014));
    group.add(holder);
  });

  // Steering wheel: column, three alloy spokes, leather rim with a red top marker.
  const W = S.WHEEL;
  const wheel = new THREE.Group();
  wheel.position.copy(V(W.x, W.y, W.f));
  wheel.rotation.x = -W.tilt;
  group.add(wheel);
  const spinner = new THREE.Group();
  wheel.add(spinner);
  const rim = new THREE.TorusGeometry(W.r, 0.0165, 14, 64);
  spinner.add(new THREE.Mesh(rim, leather));
  const marker = new THREE.Mesh(new THREE.TorusGeometry(W.r, 0.0172, 14, 6, 0.12), new THREE.MeshStandardMaterial({ color: 0xb3171a, roughness: 0.6 }));
  marker.rotation.z = Math.PI / 2 - 0.06;
  spinner.add(marker);
  const spokes = new Bucket();
  for (const sx of [-1, 1]) spokes.addGeometry(new THREE.BoxGeometry(0.13, 0.04, 0.01).translate(sx * 0.105, -0.004, -0.014));
  spokes.addGeometry(new THREE.BoxGeometry(0.036, 0.13, 0.01).translate(0, -0.11, -0.014));
  spinner.add(new THREE.Mesh(spokes.geometry(), metal));
  const hub = new Bucket();
  hub.addGeometry(new THREE.CylinderGeometry(0.058, 0.064, 0.045, 32).rotateX(Math.PI / 2).translate(0, 0, -0.01));
  hub.addGeometry(new THREE.CylinderGeometry(0.047, 0.052, 0.012, 32).rotateX(Math.PI / 2).translate(0, 0, 0.018));
  spinner.add(new THREE.Mesh(hub.geometry(), leather));
  const column = new THREE.CylinderGeometry(0.032, 0.042, 0.3, 16).rotateX(Math.PI / 2).translate(0, 0, -0.17);
  column.applyMatrix4(new THREE.Matrix4().compose(wheel.position, wheel.quaternion, new THREE.Vector3(1, 1, 1)));
  dash.addGeometry(column);
  const shroud = new THREE.BoxGeometry(0.12, 0.08, 0.16).translate(0, -0.01, -0.12);
  shroud.applyMatrix4(new THREE.Matrix4().compose(wheel.position, wheel.quaternion, new THREE.Vector3(1, 1, 1)));
  dash.addGeometry(shroud);
  for (const sx of [-1, 1]) {
    const stalk = new THREE.CylinderGeometry(0.006, 0.008, 0.13, 8).rotateZ(Math.PI / 2).translate(sx * 0.1, 0.01, -0.06);
    stalk.applyMatrix4(new THREE.Matrix4().compose(wheel.position, wheel.quaternion, new THREE.Vector3(1, 1, 1)));
    dash.addGeometry(stalk);
  }

  // Hands on the rim at ten to two; they turn with the wheel up to ~75° and then let it slide.
  const hands = new THREE.Group();
  wheel.add(hands);
  const glove = new Bucket();
  const cap = (r: number, len: number, x: number, y: number, z: number) => glove.addGeometry(new THREE.CapsuleGeometry(r, len, 4, 10).translate(x, y, z));
  cap(0.026, 0.05, 0.012, 0, 0.016); // back of the hand
  cap(0.017, 0.056, -0.006, 0, -0.019); // fingers round the front of the rim
  cap(0.013, 0.036, 0.022, -0.004, 0.036); // wrist
  const gloveGeo = glove.geometry();
  const thumb = new THREE.CapsuleGeometry(0.0105, 0.03, 4, 8).rotateZ(Math.PI / 2);
  const handFrames: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const th = side * 1.08;
    const h = new THREE.Group();
    h.position.set(W.r * Math.sin(th), W.r * Math.cos(th), 0);
    h.rotation.z = Math.PI / 2 - th;
    h.add(new THREE.Mesh(gloveGeo, gloveMat));
    const t = new THREE.Mesh(thumb, gloveMat);
    t.position.set(-0.024, -0.02 * side, 0.012);
    h.add(t);
    hands.add(h);
    handFrames.push(h);
  }
  // Forearms from fixed elbows to the wrists (rebuilt each frame).
  const armGeo = new THREE.CylinderGeometry(0.033, 0.046, 1, 14, 1, true).translate(0, 0.5, 0);
  const elbows = [V(0.12, 0.75, -0.54), V(0.6, 0.75, -0.54)];
  const arms = elbows.map(() => {
    const m = new THREE.Mesh(armGeo, sleeveMat);
    group.add(m);
    return m;
  });
  const wristLocal = new THREE.Vector3(0.03, 0, 0.05);

  // Rear-view mirror and sun visors.
  const mirPos = V(0, 1.218, -0.22);
  const mirQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 0.36, 0, 'YXZ'));
  const mirBody = new THREE.ExtrudeGeometry(roundRect(0.25, 0.066, 0.026), { depth: 0.026, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 4 });
  mirBody.translate(0, 0, -0.034).applyQuaternion(mirQ).translate(mirPos.x, mirPos.y, mirPos.z);
  dash.addGeometry(mirBody);
  dash.addGeometry(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 8).rotateX(-0.5).translate(0, 1.26, 0.2));
  // Dark glass: the room environment would make a bright mirror glow at night.
  const mirFace = new THREE.Mesh(new THREE.ShapeGeometry(roundRect(0.236, 0.054, 0.02), 4), new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 1, roughness: 0.12, envMapIntensity: 0.35 }));
  mirFace.position.copy(mirPos).add(new THREE.Vector3(0, 0, 0.0005).applyQuaternion(mirQ));
  mirFace.quaternion.copy(mirQ);
  group.add(mirFace);
  for (const x of [-0.37, 0.37]) {
    const f = -0.37;
    const y = S.screenY(f, x) - 0.022 - 0.013;
    panels.addGeometry(new THREE.BoxGeometry(0.34, 0.016, 0.15).rotateX(0.1).translate(x, y, -f));
  }

  group.add(new THREE.Mesh(dash.geometry(), dashMat), new THREE.Mesh(panels.geometry(), panelMat));

  // Eye anchor.
  const eye = new THREE.Object3D();
  eye.position.copy(EYE);
  group.add(eye);
  group.visible = false;

  // ---------------------------------------------------------------- live state
  let redline = 0;
  let sp = 0;
  let rpm = 0;
  let boost = -0.6;
  let oil = 70;
  let water = 72;
  let steer = 0;
  let digT = 0;
  let mfdT = 0;
  let lastGear = -1;
  let lastKmh = -1;
  let lastShift = false;
  const drawn = { fonts: false };
  void document.fonts?.ready.then(() => {
    drawn.fonts = true;
    redline = 0; // redraw every face with the real font
    G.drawPod(podCv);
    podTex.needsUpdate = true;
    G.drawStack(stackTex.image as HTMLCanvasElement);
    stackTex.needsUpdate = true;
  });
  const m = new THREE.Matrix4();
  const w = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const update = (car: PlayerCar, dt: number) => {
    if (car.tune.redline !== redline) {
      redline = car.tune.redline;
      G.drawCluster(clusterCv, redline);
      clusterTex.needsUpdate = true;
      lastGear = -1;
    }
    const kmh = Math.abs(car.vAlong) * 3.6;
    sp = damp(sp, kmh, 14, dt);
    rpm = damp(rpm, car.rpm, 16, dt);
    const boostT = clamp((car.rpm - 2300) / 2600, 0, 1) * car.throttle * 1.2 - (1 - car.throttle) * 0.62;
    boost = damp(boost, boostT, car.throttle > 0.5 ? 5 : 3, dt);
    oil = damp(oil, 84 + (rpm / redline) * 26, 0.04, dt);
    water = damp(water, 80 + (rpm / redline) * 10, 0.03, dt);
    speedNeedle.rotation.z = -G.dialAngle(sp, G.SPEEDO.min, G.SPEEDO.max);
    tachNeedle.rotation.z = -G.dialAngle(rpm, G.TACH.min, G.TACH.max);
    boostNeedle.rotation.z = -G.dialAngle(boost, G.BOOST.min, G.BOOST.max);
    pillarNeedles[0].rotation.z = -G.dialAngle(boost, G.POD_BOOST.min, G.POD_BOOST.max);
    pillarNeedles[1].rotation.z = -G.dialAngle(2.2 + (rpm / redline) * 5.2, G.POD_OIL.min, G.POD_OIL.max);
    const shiftOn = rpm > redline * 0.93;
    shiftMat.color.setRGB(shiftOn ? 4 : 0.13, shiftOn ? 0.5 : 0.012, shiftOn ? 0.12 : 0.008);

    digT -= dt;
    const kmhShown = Math.round(kmh);
    if (digT <= 0 && (car.gear !== lastGear || kmhShown !== lastKmh || shiftOn !== lastShift)) {
      digT = 0.1;
      lastGear = car.gear;
      lastKmh = kmhShown;
      lastShift = shiftOn;
      G.drawDigital(digCv, car.gear, kmhShown, shiftOn);
      digTex.needsUpdate = true;
    }
    mfdT -= dt;
    if (mfdT <= 0) {
      mfdT = 0.12;
      G.drawMfd(mfdCv, { boost, oil, water, throttle: car.throttle });
      mfdTex.needsUpdate = true;
    }

    // Steering: a lot of lock when slow, a little at speed (keyboard steering stays readable).
    const slow = clamp(1 - kmh / 90, 0, 1);
    steer = damp(steer, car.steerIn * (0.95 + 1.6 * slow), 18, dt);
    spinner.rotation.z = -steer;
    hands.rotation.z = -clamp(steer, -1.3, 1.3);

    // Forearms: elbow → wrist.
    wheel.updateMatrix();
    hands.updateMatrix();
    for (let k = 0; k < 2; k++) {
      const h = handFrames[k];
      h.updateMatrix();
      m.multiplyMatrices(wheel.matrix, hands.matrix).multiply(h.matrix);
      w.copy(wristLocal).applyMatrix4(m);
      const arm = arms[k];
      arm.position.copy(elbows[k]);
      dir.subVectors(w, elbows[k]);
      const len = dir.length();
      arm.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      arm.scale.set(1, len, 1);
    }
  };
  // First draw so the faces are never blank.
  update({ tune: { redline: 7600 }, vAlong: 0, rpm: 900, throttle: 0, gear: 1, steerIn: 0 } as PlayerCar, 0);

  return { group, eye, update };
}
