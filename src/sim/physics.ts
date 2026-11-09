import { PlayerCar } from './vehicle';
import { R34Car } from './vehicleR34';
import { MercedesCar } from './vehicleMercedes';
import { PorscheCar } from './vehiclePorsche';
import { W204Car } from './vehicleW204';
import type { CarId } from './cars';

/** Physics IDs are shared by menu-selected bodies, saved runs, and the network protocol. */
export type PhysicsId = 1 | 2 | 3 | 4 | 5;

export const physicsId = (v: unknown): PhysicsId => v === 2 || v === 3 || v === 4 || v === 5 ? v : 1;
export const bodyPhysics = (id: CarId): PhysicsId => id === 4 ? 5 : id === 1 ? 4 : id === 3 ? 3 : 2;

export interface PhysicsInfo {
  id: PhysicsId;
  name: string;
  desc: string;
}

/** Body-matched variants, in menu order (the AMG first). ID 1 remains protocol-compatible. */
export const PHYSICS: readonly PhysicsInfo[] = [
  { id: 3, name: 'AMG 4MATIC+', desc: 'Полный привод, 1605 кг, быстрый 8-ступенчатый автомат, уверенный зацеп и 664 whp' },
  { id: 5, name: 'C63 AMG W204', desc: 'M156 V8: 1800 кг, 610 Н·м, 7200 об/мин, RWD и 7AT' },
  { id: 4, name: 'GT3 RS', desc: 'Porsche: заднемоторный баланс, 1450 кг, 9000 об/мин, PDK, цепкие шины и точный руль' },
  { id: 2, name: 'R34 RWD', desc: 'Срыв задних шин от тяги, инерция кузова, перенос веса и автоконтрруление для клавиатуры' },
];

export function createCar(id: PhysicsId): PlayerCar {
  return id === 5 ? new W204Car() : id === 4 ? new PorscheCar() : id === 3 ? new MercedesCar() : id === 2 ? new R34Car() : new PlayerCar();
}
