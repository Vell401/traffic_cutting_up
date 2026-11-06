/*
 * Read the diagnostics log and the leaderboard from the server's database:
 *
 *   node dist-server/logs.js              last 50 log rows (server and pages)
 *   node dist-server/logs.js 200 client   last 200 rows reported by pages
 *   node dist-server/logs.js top online   online leaderboard (or: top solo)
 *
 * On the VPS: docker compose exec game node dist-server/logs.js 100
 */
import { Store, type RunMode } from './store';

const [a = '50', b] = process.argv.slice(2);
const store = new Store(process.env.DB_PATH ?? 'data/traffic.db');
if (a === 'top') {
  const mode: RunMode = b === 'online' ? 'online' : 'solo';
  console.log(`leaderboard ${mode}`);
  for (const e of store.leaderboard(mode, 50)) {
    console.log(`${String(e.rank).padStart(3)}  ${e.name.padEnd(16)} ${String(e.score).padStart(9)}  car ${e.car} physics ${e.physics}  near ${e.near}  ${e.topKmh} km/h  ${new Date(e.at).toISOString()}`);
  }
} else {
  const rows = store.recentLogs(Number(a) || 50, b === 'client' || b === 'server' ? b : undefined).reverse();
  for (const r of rows) {
    console.log(`${new Date(r.at).toISOString()} ${r.source.padEnd(6)} ${r.level.padEnd(5)} ${r.message}`);
    if (r.detail) console.log(`    ${r.detail}`);
  }
}
store.close();
