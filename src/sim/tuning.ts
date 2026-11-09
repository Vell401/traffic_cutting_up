import { carTune, trafficTune } from '../config';
import { r34Tune } from './vehicleR34';
import { R34_TUNE_FIELDS } from './r34TuningFields';
import { mercedesTune } from './vehicleMercedes';
import { porscheTune } from './vehiclePorsche';
import { w204Tune } from './vehicleW204';

export const TUNE_FIELDS = [
  { key: 'powerKW', label: 'Мощность, кВт', min: 30, max: 1500, step: 1 },
  { key: 'torqueNm', label: 'Крутящий момент, Н·м', min: 50, max: 2500, step: 1 },
  { key: 'mass', label: 'Масса, кг', min: 600, max: 3500, step: 1 },
  { key: 'brakeDecel', label: 'Сила торможения, м/с²', min: 2, max: 30, step: .1 },
  { key: 'brakeAssist', label: 'Усиление тормозов, м/с²', min: 0, max: 8, step: .1 },
  { key: 'brakeFront', label: 'Доля тормозов спереди', min: .3, max: .85, step: .01 },
  { key: 'gripFront', label: 'Сцепление спереди', min: .4, max: 3, step: .01 },
  { key: 'gripRear', label: 'Сцепление сзади', min: .4, max: 3, step: .01 },
  { key: 'longGrip', label: 'Продольное сцепление', min: .5, max: 2, step: .01 },
  { key: 'frontDrive', label: 'Доля привода спереди', min: 0, max: 1, step: .01 },
  { key: 'tractionControl', label: 'Трекшн-контроль', min: 0, max: 1, step: .01 },
  { key: 'escAssist', label: 'Стабилизация ESP', min: 0, max: 1, step: .01 },
  { key: 'lsdLock', label: 'Блокировка дифференциала', min: 0, max: 1, step: .01 },
  { key: 'aeroDrag', label: 'Аэродинамическое сопротивление', min: .1, max: 2, step: .01 },
  { key: 'rollingRes', label: 'Сопротивление качению', min: 0, max: 40, step: .1 },
  { key: 'steerGripScale', label: 'Поворот на скорости', min: .5, max: 2.5, step: .01 },
  { key: 'maxSteerLow', label: 'Максимальный угол руля, рад', min: .2, max: .8, step: .01 },
  { key: 'steerRate', label: 'Скорость поворота руля', min: 2, max: 30, step: .1 },
  { key: 'steerReturn', label: 'Возврат руля', min: 2, max: 50, step: .1 },
  { key: 'engineBrakeNm', label: 'Торможение двигателем, Н·м', min: 0, max: 300, step: 1 },
  { key: 'driveEff', label: 'КПД трансмиссии', min: .5, max: 1, step: .01 },
  { key: 'shiftTime', label: 'Время переключения, с', min: .04, max: .8, step: .005 },
] as const;
export type TuneKey = typeof TUNE_FIELDS[number]['key'] | typeof R34_TUNE_FIELDS[number]['key'];
export type CarTuning = Partial<Record<TuneKey, number>>;
export interface GlobalTuning {
  r34Revision?: number;
  cars: Record<string, CarTuning>;
  traffic: { lanes: [number, number][]; truckMin: number; truckMax: number; wallMin: number; wallMax: number };
}
export const TUNE_CARS = [
  { id: '5', name: 'Mercedes-Benz C63 AMG W204' },
  { id: '3', name: 'Mercedes-AMG A45 S' }, { id: '4', name: 'Porsche 911 GT3 RS' },
  { id: '2', name: 'R34 · RWD / Auto Countersteer' }, { id: '1', name: 'Grip (совместимость)' },
];
/** Other cars retain their exact original control set and ranges. */
export function tuningFields(id: string) {
  if (id !== '2') return TUNE_FIELDS;
  // Imported physical coefficients (including 55° in radians) need not be multiples
  // of a UI step. Never make the browser reject an unchanged R34 baseline form.
  const legacyOnly = new Set<string>(['brakeAssist', 'frontDrive', 'escAssist']);
  return [...TUNE_FIELDS.filter(f => !legacyOnly.has(f.key)).map(f => {
    if (f.key === 'maxSteerLow') return { ...f, max: 1.1 };
    if (f.key === 'steerGripScale') return { ...f, label: 'R34 · клавиатурный выворот ×' };
    if (f.key === 'steerRate') return { ...f, label: 'R34 · скорость руля без ассиста / в R' };
    if (f.key === 'steerReturn') return { ...f, label: 'R34 · возврат руля без ассиста / в R' };
    return f;
  }), ...R34_TUNE_FIELDS].map(f => {
    const value = (r34Tune as unknown as Record<string, unknown>)[f.key];
    const steps = typeof value === 'number' ? (value - f.min) / f.step : 0;
    return Math.abs(steps - Math.round(steps)) > 1e-7 ? { ...f, step: 'any' as const } : f;
  });
}
const tunes: Record<string, Record<string, unknown>> = { '1': carTune, '2': r34Tune, '3': mercedesTune, '4': porscheTune, '5': w204Tune };
const baseline: GlobalTuning = {
  r34Revision: 3,
  cars: Object.fromEntries(Object.entries(tunes).map(([id, tune]) => [id, Object.fromEntries(tuningFields(id).flatMap(f => typeof tune[f.key] === 'number' ? [[f.key, tune[f.key]]] : []))])),
  traffic: { lanes: trafficTune.laneSpeedKmh.map(v => [...v] as [number, number]), truckMin: 80, truckMax: 92, wallMin: 86, wallMax: 100 },
};
export const trafficSpeed = { truckMin: 80, truckMax: 92, wallMin: 86, wallMax: 100 };
export const defaultTuning = (): GlobalTuning => structuredClone(baseline);
export function currentTuning(): GlobalTuning {
  const result = defaultTuning();
  for (const [id, fields] of Object.entries(result.cars)) for (const key of Object.keys(fields) as TuneKey[]) fields[key] = tunes[id][key] as number;
  result.traffic = { lanes: trafficTune.laneSpeedKmh.map(v => [...v] as [number, number]), ...trafficSpeed };
  return result;
}

/** Strict, atomic validation: reject unknown keys and never partially apply a bad form. */
export function validateTuning(value: unknown): GlobalTuning {
  const v = value as GlobalTuning;
  if (!v || typeof v !== 'object' || !v.cars || !v.traffic || v.r34Revision !== 3 || Object.keys(v).some(k => !['cars', 'traffic', 'r34Revision'].includes(k))) throw new Error('Неверные настройки');
  if (Object.keys(v.cars).some(id => !Object.hasOwn(baseline.cars, id))) throw new Error('Неизвестная машина');
  for (const [id, fields] of Object.entries(baseline.cars)) {
    const car = v.cars[id];
    if (!car || typeof car !== 'object' || Object.keys(car).length !== Object.keys(fields).length) throw new Error('Неполные настройки машины');
    for (const [key] of Object.entries(car)) {
      const field = tuningFields(id).find(f => f.key === key);
      const n = car[key as TuneKey];
      if (!Object.hasOwn(fields, key) || !field || typeof n !== 'number' || !Number.isFinite(n) || n < field.min || n > field.max) throw new Error(`Недопустимое значение: ${key}`);
    }
  }
  const t = v.traffic;
  const pair = (p: unknown, min: number, max: number) => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) && p[0] <= p[1];
  if (Object.keys(t).some(k => !['lanes', 'truckMin', 'truckMax', 'wallMin', 'wallMax'].includes(k)) || !Array.isArray(t.lanes) || t.lanes.length !== 4 || !t.lanes.every(p => pair(p, 10, 250)) || !pair([t.truckMin, t.truckMax], 10, 180) || !pair([t.wallMin, t.wallMax], 10, 180)) throw new Error('Неверные диапазоны скорости трафика');
  return structuredClone(v);
}
export function applyTuning(value: GlobalTuning): void {
  const v = validateTuning(value);
  for (const [id, fields] of Object.entries(v.cars)) Object.assign(tunes[id], fields);
  trafficTune.laneSpeedKmh = v.traffic.lanes;
  Object.assign(trafficSpeed, { truckMin: v.traffic.truckMin, truckMax: v.traffic.truckMax, wallMin: v.traffic.wallMin, wallMax: v.traffic.wallMax });
}
