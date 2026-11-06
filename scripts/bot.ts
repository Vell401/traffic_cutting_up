/*
 * Headless bot drivers for a running game server (testing online alone):
 *   npm run bot                     two bots on ws://localhost:8787/ws
 *   npm run bot -- 3 ws://host/ws   three bots on another server
 * Each bot is a full client (prediction included) driving with a simple lane-keeping autopilot.
 */
import { mulberry32 } from '../src/core/rng';
import { ClientCore } from '../src/online/clientCore';
import { Sim } from '../src/sim/world';
import { Bot } from '../tests/netsim';

const count = Math.max(1, Number(process.argv[2]) || 2);
const url = process.argv[3] ?? 'ws://localhost:8787/ws';
const NAMES = ['Bot Kira', 'Bot Max', 'Bot Lena', 'Bot Timur', 'Bot Ola'];

function start(i: number): void {
  const rng = mulberry32(100 + i);
  const sim = new Sim(rng, { online: true, physics: i % 2 === 0 ? 1 : 2 });
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const core = new ClientCore(sim, {
    send: (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    },
    onWelcome: (m) => console.log(`${NAMES[i % NAMES.length]}: joined as #${m.id}`),
    onReject: (t) => console.log(`${NAMES[i % NAMES.length]}: rejected (${t})`),
  });
  const bot = new Bot(sim, { kmh: 170 + i * 25, weave: true }, rng);
  ws.onopen = () => core.hello(NAMES[i % NAMES.length], sim.player.physicsId as 1 | 2);
  ws.onmessage = (e) => core.receive(e.data as ArrayBuffer | string, performance.now());
  ws.onclose = () => {
    console.log(`${NAMES[i % NAMES.length]}: disconnected`);
    process.exit(0);
  };
  let last = performance.now();
  let acc = 0;
  setInterval(() => {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    while (acc >= 1 / 120) {
      core.step(bot.drive(1 / 120));
      acc -= 1 / 120;
    }
    core.frame(0.016, now);
  }, 16);
  setInterval(() => {
    const st = core.stats;
    console.log(
      `${NAMES[i % NAMES.length]}: ${(sim.player.vAlong * 3.6).toFixed(0)} km/h  score ${Math.floor(sim.score.score)}  ping ${st.rtt.toFixed(0)} ms  ahead ${st.horizon}  corrections ${st.corrections} (max ${(st.maxCorrection * 100).toFixed(1)} cm)`,
    );
  }, 10_000);
}

for (let i = 0; i < count; i++) setTimeout(() => start(i), i * 400);
