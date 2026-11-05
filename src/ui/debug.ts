import type { WebGLRenderer } from 'three';
import { cameraTune, carTune, scoreTune, trafficTune } from '../config';
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

  const tele = { kmh: 0, slipDeg: 0, latG: 0, psiDeg: 0, cars: 0, drawCalls: 0, tris: 0 };
  const t = pane.addFolder({ title: 'Telemetry' });
  t.addBinding(tele, 'kmh', { readonly: true, format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'slipDeg', { readonly: true, label: 'slip °', format: (v: number) => v.toFixed(1) });
  t.addBinding(tele, 'latG', { readonly: true, label: 'lat g', format: (v: number) => v.toFixed(2) });
  t.addBinding(tele, 'psiDeg', { readonly: true, label: 'ψ °', format: (v: number) => v.toFixed(1) });
  t.addBinding(tele, 'cars', { readonly: true, format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'drawCalls', { readonly: true, label: 'draw calls', format: (v: number) => v.toFixed(0) });
  t.addBinding(tele, 'tris', { readonly: true, label: 'triangles', format: (v: number) => v.toFixed(0) });

  const car = pane.addFolder({ title: 'Car' });
  car.addBinding(carTune, 'powerKW', { min: 100, max: 700, step: 10 });
  car.addBinding(carTune, 'gripFront', { min: 0.6, max: 1.8, step: 0.01 });
  car.addBinding(carTune, 'gripRear', { min: 0.6, max: 1.8, step: 0.01 });
  car.addBinding(carTune, 'steerGripScale', { min: 0.5, max: 2, step: 0.01, label: 'steer lock ×grip' });
  car.addBinding(carTune, 'steerRate', { min: 1, max: 12, step: 0.1 });
  car.addBinding(carTune, 'steerReturn', { min: 1, max: 15, step: 0.1 });
  car.addBinding(carTune, 'yawAssist', { min: 0, max: 1, step: 0.01 });
  car.addBinding(carTune, 'aeroDrag', { min: 0.1, max: 1, step: 0.01 });
  car.addBinding(carTune, 'brakeDecel', { min: 4, max: 16, step: 0.1 });

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

  const cam = pane.addFolder({ title: 'Camera', expanded: false });
  cam.addBinding(cameraTune, 'dist', { min: 3, max: 12, step: 0.1 });
  cam.addBinding(cameraTune, 'height', { min: 0.8, max: 4, step: 0.05 });
  cam.addBinding(cameraTune, 'yawLag', { min: 1, max: 20, step: 0.5 });
  cam.addBinding(cameraTune, 'fovMin', { min: 40, max: 90, step: 1 });
  cam.addBinding(cameraTune, 'fovMax', { min: 40, max: 110, step: 1 });

  let frame = 0;
  return {
    update() {
      stats.update();
      if (++frame % 6 !== 0) return;
      const p = sim.player;
      tele.kmh = p.vAlong * 3.6;
      tele.slipDeg = (Math.atan2(p.vy, Math.max(p.vx, 1)) * 180) / Math.PI;
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
