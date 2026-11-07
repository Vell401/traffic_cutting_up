/*
 * Persistent server data in one SQLite file (Node's built-in node:sqlite, no native modules):
 *   runs  every finished run worth keeping, solo (reported by the page) and online (the server's own)
 *   log   diagnostics: server warnings and errors, problems reported by players' pages (size-capped)
 *   settings  small JSON values kept across restarts (the admin page's traffic settings)
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
  private readonly placeOf;
  private readonly players;
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
    // One player's place among everyone's best runs (same order as the board).
    this.placeOf = this.db.prepare(`
      SELECT place, name, score, car, physics, near, topKmh, seconds, at FROM (
        SELECT name, score, car, physics, near, top_kmh AS topKmh, seconds, created_at AS at,
          ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC) AS place
        FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY lower(name) ORDER BY score DESC, created_at ASC) AS rn
          FROM runs WHERE mode = ?
        ) WHERE rn = 1
      ) WHERE lower(name) = lower(?)
    `);
    this.players = this.db.prepare('SELECT COUNT(DISTINCT lower(name)) AS n FROM runs WHERE mode = ?');
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

  /** A player's best run and place on a board (any letter case), or null without a run there. */
  placeOn(mode: RunMode, name: string): LeaderEntry | null {
    const row = this.placeOf.get(mode, name) as (Omit<LeaderEntry, 'rank'> & { place: number }) | undefined;
    if (!row) return null;
    const { place, ...rest } = row;
    return { rank: place, ...rest };
  }

  /** How many players have a run on a board. */
  playerCount(mode: RunMode): number {
    return Number((this.players.get(mode) as { n: number }).n);
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

  /** A stored setting (parsed JSON), or undefined. */
  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** Delete every run of one player (any letter case) in one mode (admin: a cheated or offensive entry). */
  removeRuns(mode: RunMode, name: string): number {
    return Number(this.db.prepare('DELETE FROM runs WHERE mode = ? AND lower(name) = lower(?)').run(mode, name).changes);
  }

  close(): void {
    this.db.close();
  }
}
