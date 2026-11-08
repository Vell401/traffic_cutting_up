import type { WebGLRenderer } from 'three';
import { scoreTune, trafficTune } from '../config';
import { CAMERA_RIGS } from '../render/car';
import { CARS } from '../sim/cars';
import type { DriftTune } from '../sim/vehicleDrift';
import type { R34Tune } from '../sim/vehicleR34';
import { R34_TUNE_FIELDS } from '../sim/r34TuningFields';
import type { Sim } from '../sim/world';

export interface Debug {
  update(): void;
  setVisible(v: boolean): void;
}

/** Tuning panel + GPU/CPU stats. Loaded lazily, so it costs nothing until opened with the ` key. */
export async function createDebug(renderer: WebGLRenderer, sim: Sim): Promise<Debug> {
  const [{ Pane }, { default: Stats }] = await Promise.all([import('tweakpane'), import('stats-gl')]);

  const stats = new Stats({ trackGPU: true, horizontal: true });
  await stats.init(renderer);
  stats.dom.style.cssText += ';position:fixed;left:0;top:0;z-index:20';
  document.body.appendChild(stats.dom);

  const pane = new Pane({ title: 'Tuning  ( ` )' });
  pane.element.parentElement!.style.zIndex = '20';

  const tele = { kmh: 0, slipDeg: 0, latG: 0, psiDeg: 0, cars: 0, drawCalls: 0, tris: 0,
    progressKmh: 0, rearWheelKmh: 0, steeringInput: 0, rackDeg: 0, yawDeg: 0, frontFy: 0, rearFy: 0 };
  const t = pane.addFolder({ title: 'Telemetry' });
  t.addBinding(tele, 'kmh', { readonly: true, format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'slipDeg', { readonly: true, label: 'slip °', format: (v: number) => v.toFixed(1) });
  t.addBinding(tele, 'latG', { readonly: true, label: 'lat g', format: (v: number) => v.toFixed(2) });
  t.addBinding(tele, 'psiDeg', { readonly: true, label: 'ψ °', format: (v: number) => v.toFixed(1) });
  t.addBinding(tele, 'cars', { readonly: true, format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'drawCalls', { readonly: true, label: 'draw calls', format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'tris', { readonly: true, label: 'triangles', format: (v: number) => v.toFixed(0) });
  if (sim.player.physicsId === 2) {
    const drift = pane.addFolder({ title: 'R34 · physical feedback', expanded: false });
    for (const [key, label] of [
      ['progressKmh', 'road km/h'], ['rearWheelKmh', 'rear wheels km/h'], ['steeringInput', 'steering input'],
      ['rackDeg', 'road wheels °'], ['yawDeg', 'yaw °/s'], ['frontFy', 'front Fy, N'], ['rearFy', 'rear Fy, N'],
    ] as const) drift.addBinding(tele, key, { readonly: true, label, format: (v: number) => v.toFixed(2) });
  }

  // Bound to the car picked in the menu (each physics variant has its own tune object).
  const carTune = sim.player.tune;
  const v2 = sim.player.physicsId !== 1;
  const car = pane.addFolder({ title: `Car · physics ${sim.player.physicsId}` });
  car.addBinding(carTune, 'powerKW', { min: 100, max: 700, step: 10 });
  car.addBinding(carTune, 'gripFront', { min: 0.6, max: 1.8, step: 0.01 });
  car.addBinding(carTune, 'gripRear', { min: 0.6, max: 1.8, step: 0.01 });
  car.addBinding(carTune, 'steerGripScale', { min: 0.5, max: 2, step: 0.01, label: sim.player.physicsId === 2 ? 'key demand ×' : 'steer lock ×grip' });
  car.addBinding(carTune, 'steerRate', { min: 1, max: 30, step: 0.5, ...(sim.player.physicsId === 2 ? { label: 'raw/reverse steer rate' } : {}) });
  car.addBinding(carTune, 'steerReturn', { min: 1, max: 40, step: 0.5, ...(sim.player.physicsId === 2 ? { label: 'raw/reverse return' } : {}) });
  if (!v2) car.addBinding(carTune, 'yawAssist', { min: 0, max: 1, step: 0.01 });
  car.addBinding(carTune, 'tractionControl', { min: 0, max: 1, step: 0.01, label: 'traction ctrl' });
  car.addBinding(carTune, 'aeroDrag', { min: 0.1, max: 1, step: 0.01 });
  car.addBinding(carTune, 'brakeDecel', { min: 4, max: 16, step: 0.1 });
  if (sim.player.physicsId === 2) {
    const rt = carTune as R34Tune;
    const r34 = pane.addFolder({ title: 'R34 · Tyres / Keyboard steering' });
    for (const f of R34_TUNE_FIELDS) if (f.key in rt) r34.addBinding(rt, f.key, { min: f.min, max: f.max, step: f.step, label: f.key });
    r34.addBinding(rt, 'maxSteerLow', { min: .2, max: 1.1, step: .01, label: 'mechanical lock, rad' });
    r34.addBinding(rt, 'torqueNm', { min: 100, max: 1200, step: 10, label: 'torque, N·m' });
    r34.addBinding(rt, 'lsdLock', { min: 0, max: 1, step: .01, label: 'LSD lock' });
  } else if (v2) {
    // Physics №2 extras (ranges from its author; the lag and ESP range must stay above zero).
    const rt = carTune as DriftTune;
    const rwd = pane.addFolder({ title: sim.player.physicsId === 4 ? 'GT3 RS' : sim.player.physicsId === 3 ? 'AMG' : 'V8 RWD' });
    rwd.addBinding(rt, 'escAssist', { min: 0, max: 1, step: 0.05, label: 'ESP' });
    rwd.addBinding(rt, 'escSlip', { min: 0.08, max: 0.35, step: 0.01, label: 'ESP from, rad' });
    rwd.addBinding(rt, 'tcSlip', { min: 0.05, max: 0.3, step: 0.01, label: 'TC slip' });
    rwd.addBinding(rt, 'rearStiffness', { min: 0.9, max: 1.4, step: 0.01, label: 'rear stiffness' });
    rwd.addBinding(rt, 'rollFront', { min: 0.4, max: 0.7, step: 0.01, label: 'roll front' });
    rwd.addBinding(rt, 'loadSensitivity', { min: 0, max: 0.35, step: 0.01, label: 'load sens.' });
    rwd.addBinding(rt, 'loadLag', { min: 0.03, max: 0.25, step: 0.01, label: 'load lag, s' });
    rwd.addBinding(rt, 'torqueNm', { min: 450, max: 900, step: 10, label: 'torque, N·m' });
    rwd.addBinding(rt, 'brakeFront', { min: 0.55, max: 0.72, step: 0.01, label: 'brake front' });
    rwd.addBinding(rt, 'steerRateSpeed', { min: 15, max: 60, step: 1, label: 'steer heavy from' });
  }

  const tr = pane.addFolder({ title: 'Traffic', expanded: false });
  tr.addBinding(trafficTune, 'density', { min: 1, max: 15, step: 0.5, label: 'cars/km/lane' });
  tr.addBinding(trafficTune, 'rudeShare', { min: 0, max: 0.5, step: 0.01 });
  tr.addBinding(trafficTune, 'whim', { min: 0, max: 0.5, step: 0.01 });
  tr.addBinding(trafficTune, 'blinkerTime', { min: 0.3, max: 3, step: 0.1 });
  tr.addBinding(trafficTune, 'laneChangeTime', { min: 1.5, max: 6, step: 0.1 });

  const sc = pane.addFolder({ title: 'Score', expanded: false });
  sc.addBinding(scoreTune, 'nearGap', { min: 0.3, max: 2, step: 0.05 });
  sc.addBinding(scoreTune, 'minSpeedKmh', { min: 0, max: 200, step: 5 });
  sc.addBinding(scoreTune, 'comboTime', { min: 1, max: 10, step: 0.1 });
  sc.addBinding(scoreTune, 'multPerCombo', { min: 0.05, max: 1, step: 0.05 });

  // Cameras belong to the car: one folder per body.
  for (const info of CARS) {
    const rig = CAMERA_RIGS[info.id];
    const cam = pane.addFolder({ title: `Camera · ${info.name}`, expanded: false });
    cam.addBinding(rig.chase, 'dist', { min: 3, max: 12, step: 0.1 });
    cam.addBinding(rig.chase, 'height', { min: 0.8, max: 4, step: 0.05 });
    cam.addBinding(rig.chase, 'yawLag', { min: 1, max: 20, step: 0.5 });
    cam.addBinding(rig.chase, 'fovMin', { min: 40, max: 90, step: 1 });
    cam.addBinding(rig.chase, 'fovMax', { min: 40, max: 110, step: 1 });
    cam.addBinding(rig.hood, 'f', { min: -1, max: 2.5, step: 0.01, label: 'hood fwd' });
    cam.addBinding(rig.hood, 'y', { min: 0.6, max: 2, step: 0.01, label: 'hood height' });
    if (rig.cockpit) {
      cam.addBinding(rig.cockpit, 'fov', { min: 45, max: 95, step: 1, label: 'cockpit fov' });
      cam.addBinding(rig.cockpit, 'fovFast', { min: 45, max: 105, step: 1, label: 'cockpit fov fast' });
      cam.addBinding(rig.cockpit, 'pitch', { min: -0.3, max: 0.15, step: 0.005, label: 'cockpit pitch' });
    }
  }

  let frame = 0;
  return {
    update() {
      stats.update();
      if (++frame % 6 !== 0) return;
      const p = sim.player;
      tele.kmh = (p.physicsId === 2 ? p.speed : p.vAlong) * 3.6;
      tele.slipDeg = (Math.atan2(p.vy, p.physicsId === 2 ? p.vx : Math.max(p.vx, 1)) * 180) / Math.PI;
      if (p.physicsId === 2) {
        const r34 = p as typeof p & { rearWheelspin?: number; forceFront?: number; forceRear?: number };
        tele.progressKmh = p.vAlong * 3.6;
        tele.rearWheelKmh = (p.vx + (r34.rearWheelspin ?? 0)) * 3.6;
        tele.steeringInput = p.steerIn; tele.rackDeg = p.steerAngle * 180 / Math.PI;
        tele.yawDeg = p.r * 180 / Math.PI;
        tele.frontFy = r34.forceFront ?? 0; tele.rearFy = r34.forceRear ?? 0;
      }
      tele.latG = p.accLat / 9.81;
      tele.psiDeg = (p.psi * 180) / Math.PI;
      tele.cars = sim.traffic.activeCount;
      tele.drawCalls = renderer.info.render.calls;
      tele.tris = renderer.info.render.triangles;
      pane.refresh();
    },
    setVisible(v: boolean) {
      pane.hidden = !v;
      stats.dom.style.display = v ? '' : 'none';
    },
  };
}
