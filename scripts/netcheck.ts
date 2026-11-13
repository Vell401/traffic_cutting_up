/*
 * Ride-quality report for the netcode (plan stage 3): a headless server and two bot clients over
 * simulated links, across latencies, jitter, stalls, low frame rates and deliberate crashes.
 *
 *   npm run netcheck            60 s per case
 *   npm run netcheck -- 120     longer runs
 *
 * Columns: ahead = prediction horizon in 120 Hz steps (≈ RTT + buffering), corrections = how often
 * the server disagreed with our prediction and by how much (p50 / p95 / max, cm), crashes predicted
 * on the client (each car hit) vs runs the server ended (a hit within 2 s of the last one does not end
 * another run). Without contacts the prediction is exact (0 corrections).
 */
import { NetSession, link, type NetClient } from '../tests/netsim';
import { resolveMap } from '../src/sim/maps';

const args = process.argv.slice(2);
const mapAt = args.indexOf('--map');
const map = resolveMap(mapAt < 0 ? undefined : args[mapAt + 1] ?? '').id;
if (mapAt >= 0) args.splice(mapAt, 2);
const seconds = Number(args[0]) || 60;

interface Case {
  name: string;
  delay: number;
  jitter: number;
  stall: number;
  fps: number;
  reckless: boolean;
}

const CASES: Case[] = [
  { name: 'LAN', delay: 2, jitter: 1, stall: 0, fps: 60, reckless: false },
  { name: '30 ms', delay: 15, jitter: 5, stall: 0, fps: 60, reckless: false },
  { name: '80 ms ±30', delay: 40, jitter: 30, stall: 0, fps: 60, reckless: false },
  { name: '150 ms ±50', delay: 75, jitter: 50, stall: 0, fps: 60, reckless: false },
  { name: '150 ms stalls', delay: 75, jitter: 30, stall: 0.01, fps: 60, reckless: false },
  { name: '80 ms 30 fps', delay: 40, jitter: 20, stall: 0, fps: 30, reckless: false },
  { name: '80 ms 20 fps', delay: 40, jitter: 20, stall: 0, fps: 20, reckless: false },
  { name: '80 ms crashes', delay: 40, jitter: 20, stall: 0, fps: 60, reckless: true },
  { name: '150 ms crashes 30 fps', delay: 75, jitter: 40, stall: 0, fps: 30, reckless: true },
];

const cm = (m: number) => (m * 100).toFixed(1).padStart(6);

console.log(`${seconds} s per case, 2 drivers (Grip + R34 RWD), server traffic as in a session\n`);
console.log('case                    ahead   corrections  p50     p95     max (cm)   hits seen / runs ended');
console.log('Count/max cover every correction; p50/p95 are exact up to 16384 events, then labelled reservoir estimates.');
for (const c of CASES) {
  const net = new NetSession(11, {}, false, map);
  const l = link(c.delay, c.jitter, c.stall);
  const clients: NetClient[] = [
    net.add({ name: 'A', physics: 1, up: l, down: l, fps: c.fps, bot: { kmh: 220, weave: !c.reckless, reckless: c.reckless } }),
    net.add({ name: 'B', physics: 2, up: l, down: l, fps: c.fps, bot: { kmh: 200, weave: true } }),
  ];
  let ahead = 0;
  let aheadN = 0;
  net.run(seconds, (now) => {
    clients.forEach((cl) => {
      const st = cl.core.stats;
      if (now % 100 === 0 && cl.core.ready) {
        ahead += st.horizon;
        aheadN++;
      }
    });
  });
  const corrections = net.corrections.summary();
  const crashesClient = clients.reduce((n, cl) => n + cl.localCrashes, 0);
  const runsServer = clients.reduce((n, cl) => n + (cl.events.get('runEnd') ?? 0), 0);
  console.log(
    `${c.name.padEnd(22)} ${(ahead / Math.max(1, aheadN)).toFixed(1).padStart(6)}  ${String(corrections.count).padStart(10)}  ${cm(corrections.p50)}  ${cm(corrections.p95)}  ${cm(corrections.max)}      ${crashesClient} / ${runsServer}${corrections.sampled ? ' (p50/p95 reservoir estimates, n=16384)' : ''}`,
  );
}
