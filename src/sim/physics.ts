import { PlayerCar } from './vehicle';
import { DriftCar } from './vehicleDrift';

/** Car physics variants offered in the start menu. */
export type PhysicsId = 1 | 2;

export interface PhysicsInfo {
  id: PhysicsId;
  name: string;
  desc: string;
}

export const PHYSICS: readonly PhysicsInfo[] = [
  { id: 1, name: 'Grip', desc: 'Аркада: цепко и точно, без заносов' },
  { id: 2, name: 'V8 RWD', desc: 'Тяжёлый заднеприводный седан: перенос веса, лёгкий занос на газу' },
];

export function createCar(id: PhysicsId): PlayerCar {
  return id === 2 ? new DriftCar() : new PlayerCar();
}
