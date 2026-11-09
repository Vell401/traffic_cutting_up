// Fed to Node 22 through stdin; never starts the server or copies a live SQLite file.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** Capture every persisted setting, including traffic/radio, in one SQLite read transaction. */
export function snapshotSettings(db) {
  if (!db) return [];
  db.exec('BEGIN');
  try {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    const rows = present ? db.prepare('SELECT key, value FROM settings ORDER BY key').all() : [];
    db.exec('COMMIT');
    return rows;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Only tuning is migrated at startup. Never rewind traffic, radio, map identity or run data. */
export function restoreSettings(db, rows) {
  if (!Array.isArray(rows) || rows.some(r => !r || typeof r.key !== 'string' || typeof r.value !== 'string') ||
      new Set(rows.map(r => r.key)).size !== rows.length) throw new Error('Invalid settings snapshot');
  db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
  try {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    const before = rows.find(r => r.key === 'tuning')?.value;
    if (!present) {
      if (before !== undefined) throw new Error('Missing settings table');
    } else {
      const current = db.prepare("SELECT value FROM settings WHERE key = 'tuning'").get()?.value;
      if (current === undefined && before !== undefined) {
        // A missing tuning row must not turn a successful rollback into shipped defaults.
        db.prepare("INSERT INTO settings (key, value) VALUES ('tuning', ?)").run(before);
        if (db.prepare("SELECT value FROM settings WHERE key = 'tuning'").get()?.value !== before) {
          throw new Error('Settings restore verification failed');
        }
      } else if (current !== undefined && current !== before) {
        const revision = raw => {
          const value = JSON.parse(raw);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tuning');
          return value.r34Revision;
        };
        const oldRevision = before === undefined ? undefined : revision(before);
        const newRevision = revision(current);
        // Preserve valid same-schema admin changes. Fail closed on an unknown migration.
        if (newRevision !== oldRevision || before === undefined) {
          if (newRevision !== 4 || ![undefined, 1, 2, 3].includes(oldRevision)) {
            throw new Error('Unrecognized tuning migration');
          }
          if (before === undefined) db.prepare("DELETE FROM settings WHERE key = 'tuning'").run();
          else db.prepare("UPDATE settings SET value = ? WHERE key = 'tuning'").run(before);
          const restored = db.prepare("SELECT value FROM settings WHERE key = 'tuning'").get()?.value;
          if (restored !== before) throw new Error('Settings restore verification failed');
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cli() {
  const [action, path, instance] = process.argv.slice(2);
  const database = process.env.DB_PATH || '/data/traffic.db';
  let db;
  try {
    if (!path || !/^\/data\/\.rollback-settings-[\w-]+\.json$/.test(path) ||
        !['game', 'game-miami'].includes(instance)) throw new Error('Invalid arguments');
    if (action === 'discard') {
      unlinkSync(path);
      return;
    }
    if (action === 'backup') {
      if (existsSync(database)) {
        db = new DatabaseSync(database, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 10000');
      }
      const backup = { format: 1, instance, database, databaseExisted: Boolean(db), settings: snapshotSettings(db) };
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(backup));
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } else if (action === 'restore') {
      const backup = JSON.parse(readFileSync(path, 'utf8'));
      if (backup.format !== 1 || backup.instance !== instance || backup.database !== database) {
        throw new Error('Wrong settings snapshot');
      }
      // A missing existing database is data loss, not permission to create an empty replacement.
      if (!existsSync(database)) {
        if (backup.databaseExisted === false && Array.isArray(backup.settings) && backup.settings.length === 0) return;
        throw new Error('Database missing during recovery');
      }
      db = new DatabaseSync(database);
      restoreSettings(db, backup.settings);
    } else throw new Error('Invalid action');
  } catch {
    // SQLite errors can contain saved values. Never log settings, credentials or raw exceptions.
    console.error('Settings recovery operation failed; keep servers stopped and inspect the retained snapshot locally.');
    process.exitCode = 1;
  } finally { db?.close(); }
}

if (process.argv[1] === '-') cli();
