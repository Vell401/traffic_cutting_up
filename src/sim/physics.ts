import { PlayerCar } from './vehicle';
import { DriftCar } from './vehicleDrift';
import { MercedesCar } from './vehicleMercedes';

/** Car physics variants offered in the start menu. */
export type PhysicsId = 1 | 2 | 3;

export interface PhysicsInfo {
  id: PhysicsId;
  name: string;
  desc: string;
}

export const PHYSICS: readonly PhysicsInfo[] = [
  { id: 1, name: 'Grip', desc: 'Аркада: цепко и точно, без заносов' },
  { id: 2, name: 'V8 RWD', desc: 'Тяжёлый заднеприводный седан: перенос веса, лёгкий занос на газу' },
  { id: 3, name: 'AMG 4MATIC+', desc: 'Полный привод, 1605 кг, быстрый 8-ступенчатый автомат, уверенный зацеп и 664 whp' },
];

export function createCar(id: PhysicsId): PlayerCar {
  return id === 3 ? new MercedesCar() : id === 2 ? new DriftCar() : new PlayerCar();
}
