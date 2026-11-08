/** R34-specific cost: the general perfcheck intentionally uses legacy physics ID 1. */
import { R34Car, r34Tune } from '../src/sim/vehicleR34';

for (const population of [5, 25, 50]) {
  const cars = Array.from({ length: population }, (_, index) => {
    const car = new R34Car(structuredClone(r34Tune));
    car.reset(0, 0, (60 + index % 8 * 10) / 3.6);
    return car;
  });
  const times: number[] = [];
  for (let tick = 0; tick < 1200; tick++) {
    const start = performance.now();
    for (let i = 0; i < cars.length; i++) {
      // Explicit unlimited pad: no body velocity/yaw/rack edits. Vary entry/hold/transition
      // phases so the nonlinear tyre solve isn't benchmarked only at a braked standstill.
      const car = cars[i], phase = (tick + i * 17) % 720;
      car.d = car.prevD = 0;
      car.step(1 / 120, {
        steer: phase < 60 ? 1 : phase < 360 ? 0 : phase < 420 ? -1 : 0,
        throttle: phase < 600 ? 1 : 0, brake: phase >= 660 ? .5 : 0,
      }, 0);
    }
    if (tick >= 240) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({
    physics: 'R34 / Chrono TMeasy + Sketchbook', players: population,
    stateFloats: cars[0].stateSize,
    ms: {
      mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
      p95: +times[Math.floor(times.length * .95)].toFixed(3),
      max: +times.at(-1)!.toFixed(3),
    },
  }));
}
