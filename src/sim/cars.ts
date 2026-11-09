/**
 * Car bodies offered in the start menu. Purely cosmetic: the body is the model and its cameras, the
 * hitbox and the handling come from the physics choice. Online the server passes it on to the others.
 * Models and camera rigs live in render/cars.ts.
 */
export type CarId = 1 | 2 | 3 | 4;

export interface CarInfo {
  id: CarId;
  name: string;
  desc: string;
}

/** In menu order (the A45 first); the ids are what the network and saved choices use. */
export const CARS: readonly CarInfo[] = [
  { id: 3, name: 'Mercedes-AMG A45 S', desc: 'Компактный AMG-хэтчбек 4MATIC+: 1605 кг, усиленная тормозная система, спортивное сцепление, салон с живым рулём (V)' },
  { id: 4, name: 'Mercedes-Benz C63 AMG W204', desc: 'Дорестайлинг: атмосферный M156 V8, 610 Н·м, задний привод и 7-ступенчатый автомат' },
  { id: 1, name: 'Porsche 911 GT3 RS', desc: 'IRL Spec 10: розовый кузов, чёрные диски, карбон и чёрный салон; вид из кабины (V)' },
  { id: 2, name: 'R34 RWD', desc: 'Левый руль, задний привод, пробуксовка и перенос веса. Клавиатура: автоконтрруление, газ управляет скольжением' },
];

export const carId = (v: unknown): CarId => (v === 2 || v === 3 || v === 4 ? v : 1);
