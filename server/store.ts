/*
 * Persistent server data in one SQLite file (Node's built-in node:sqlite, no native modules):
 *   runs  every finished run worth keeping, solo (reported by the page) and online (the server's own)
 *   log   diagnostics: server warnings and errors, problems reported by players' pages (size-capped)
 */
import { DatabaseSync } from 'node:sqlite';

export type RunMode = 'solo' | 'online';

export interface RunRecord {
  mode: RunMode;
  name: string;
  score: number;
  car: number;
  physics: number;
  near: number;
  topKmh: number;
  seconds: number;
}

export interface LeaderEntry {
  rank: number;
  name: string;
  score: number;
  car: number;
  physics: number;
  near: number;
  topKmh: number;
  seconds: number;
  /** Unix ms. */
  at: number;
}

export interface LogRow {
  id: number;
  at: number;
  source: string;
  level: string;
  message: string;
  detail: string | null;
}

/** Runs below this are not worth a place on the board. */
export const MIN_SCORE = 1000;
/** The log keeps about this many newest rows. */
const LOG_KEEP = 20_000;

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertRun;
  private readonly topRuns;
  private readonly insertLog;
  private logs = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        car INTEGER NOT NULL,
        physics INTEGER NOT NULL,
        near INTEGER NOT NULL,
        top_kmh INTEGER NOT NULL,
        seconds REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_board ON runs (mode, score DESC);
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
      );
    `);
    this.insertRun = this.db.prepare(
      'INSERT INTO runs (mode, name, score, car, physics, near, top_kmh, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // Each name's best run (ties: the earlier one), best first.
    this.topRuns = this.db.prepare(`
      SELECT name, score, car, physics, near, top_kmh AS topKmh, seconds, created_at AS at FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY lower(name) ORDER BY score DESC, created_at ASC) AS rn
        FROM runs WHERE mode = ?
      ) WHERE rn = 1 ORDER BY score DESC, at ASC LIMIT ?
    `);
    this.insertLog = this.db.prepare('INSERT INTO log (at, source, level, message, detail) VALUES (?, ?, ?, ?, ?)');
  }

  /** Keep a run (below MIN_SCORE it is ignored). Returns whether it was stored. */
  addRun(r: RunRecord, at = Date.now()): boolean {
    if (r.score < MIN_SCORE) return false;
    this.insertRun.run(r.mode, r.name, Math.floor(r.score), r.car, r.physics, Math.floor(r.near), Math.round(r.topKmh), +r.seconds.toFixed(1), at);
    return true;
  }

  leaderboard(mode: RunMode, limit = 10): LeaderEntry[] {
    const rows = this.topRuns.all(mode, Math.max(1, Math.min(100, limit))) as unknown as Omit<LeaderEntry, 'rank'>[];
    return rows.map((r, i) => ({ rank: i + 1, ...r }));
  }

  log(source: 'server' | 'client', level: string, message: string, detail?: string, at = Date.now()): void {
    this.insertLog.run(at, source, level, message.slice(0, 500), detail ? detail.slice(0, 4000) : null);
    if (++this.logs % 200 === 0) this.db.exec(`DELETE FROM log WHERE id <= (SELECT MAX(id) - ${LOG_KEEP} FROM log)`);
  }

  recentLogs(limit = 100, source?: string): LogRow[] {
    const n = Math.max(1, Math.min(5000, limit));
    const rows = source
      ? this.db.prepare('SELECT * FROM log WHERE source = ? ORDER BY id DESC LIMIT ?').all(source, n)
      : this.db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?').all(n);
    return rows as unknown as LogRow[];
  }

  /** Delete every run of one player (any letter case) in one mode (admin: a cheated or offensive entry). */
  removeRuns(mode: RunMode, name: string): number {
    return Number(this.db.prepare('DELETE FROM runs WHERE mode = ? AND lower(name) = lower(?)').run(mode, name).changes);
  }

  close(): void {
    this.db.close();
  }
}
