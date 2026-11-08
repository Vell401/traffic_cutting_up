import { PlayerCar } from './vehicle';
import { R34Car } from './vehicleR34';
import { MercedesCar } from './vehicleMercedes';
import { PorscheCar } from './vehiclePorsche';

/** Physics IDs are shared by menu-selected bodies, saved runs, and the network protocol. */
export type PhysicsId = 1 | 2 | 3 | 4;

export interface PhysicsInfo {
  id: PhysicsId;
  name: string;
  desc: string;
}

/** Body-matched variants, in menu order (the AMG first). ID 1 remains protocol-compatible. */
export const PHYSICS: readonly PhysicsInfo[] = [
  { id: 3, name: 'AMG 4MATIC+', desc: 'Полный привод, 1605 кг, быстрый 8-ступенчатый автомат, уверенный зацеп и 664 whp' },
  { id: 4, name: 'GT3 RS', desc: 'Porsche: заднемоторный баланс, 1450 кг, 9000 об/мин, PDK, цепкие шины и точный руль' },
  { id: 2, name: 'R34 Drift', desc: 'Задний привод, плавный управляемый занос, помощь в контррулении и мягкий возврат зацепа' },
];

export function createCar(id: PhysicsId): PlayerCar {
  return id === 4 ? new PorscheCar() : id === 3 ? new MercedesCar() : id === 2 ? new R34Car() : new PlayerCar();
}
