/** Reproducible simulation + snapshot fan-out load; no sockets, no machine-dependent pass threshold. */
import { laneCenter } from '../src/config';
import { GameServer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import { VEHICLES } from '../src/sim/vehicles';

for (const [players, density] of [[5, 10], [50, 10], [50, 80]]) {
  const game = new GameServer({ seed: 7 });
  game.configure({ mode: 'normal', modePerKm: { mode: 'normal', perKm: density } });
  for (let i = 0; i < players; i++) {
    const conn = game.connect({ send() {}, close() {}, buffered: 0 });
    conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name: `bot${i}`, physics: 1, car: 2, seq: 0 }));
    const dr = game.world.drivers[i];
    dr.car.s = i * game.world.ringLen / players;
    dr.car.d = 12; dr.car.ghost = true; dr.ghostT = Infinity;
  }
  const traffic = game.world.traffic;
  traffic.clearAround(0, Infinity);
  const spacing = 1000 / density;
  for (let s = 0; s < game.world.ringLen; s += spacing) for (let lane = 0; lane < 4; lane++) {
    traffic.spawnAt(VEHICLES[0], s, lane, 25, laneCenter(lane));
  }
  const times: number[] = [], simulation: number[] = [], snapshots: number[] = [];
  for (let tick = 1; tick <= 1200; tick++) {
    for (const dr of game.world.drivers) dr.push(tick, { steer: 0, throttle: 0, brake: 255, flags: 0 });
    const start = performance.now(); game.tick(() => performance.now());
    if (tick > 240) { times.push(performance.now() - start); simulation.push(game.timing.simulationMs); snapshots.push(game.timing.snapshotMs); }
  }
  const summary = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3), p95: +values[Math.floor(values.length * .95)].toFixed(3), max: +values.at(-1)!.toFixed(3) };
  };
  console.log(JSON.stringify({ players, density, traffic: traffic.activeCount, totalMs: summary(times), simulationMs: summary(simulation), snapshotMs: summary(snapshots) }));
}
