/**
 * Car bodies offered in the start menu. Purely cosmetic: the body is the model and its cameras, the
 * hitbox and the handling come from the physics choice. Online the server passes it on to the others.
 * Models and camera rigs live in render/cars.ts.
 */
export type CarId = 1 | 2 | 3;

export interface CarInfo {
  id: CarId;
  name: string;
  desc: string;
}

export const CARS: readonly CarInfo[] = [
  { id: 1, name: 'Coupe', desc: 'Простое синее купе' },
  { id: 2, name: 'R34', desc: 'Японское купе 90-х: серебро с синими полосами, проработанный салон, вид из кабины (C)' },
  { id: 3, name: 'Mercedes-AMG A45 S', desc: 'Компактный AMG-хэтчбек 4MATIC+: 1605 кг, усиленная тормозная система, спортивное сцепление' },
];

export const carId = (v: unknown): CarId => (v === 2 || v === 3 ? v : 1);
