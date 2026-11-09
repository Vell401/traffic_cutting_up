import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTuning, tuningFields, type GlobalTuning } from '../src/sim/tuning';
import { restoreTuning } from '../server/restoreTuning';

type Setting = { key: string; value: string };
// @ts-expect-error The helper is plain JavaScript so old Node images can execute it without a build.
const helper = await import('../deploy/rollback-settings.mjs');
const { snapshotSettings, restoreSettings } = helper as {
  snapshotSettings(db: DatabaseSync | null): Setting[];
  restoreSettings(db: DatabaseSync, rows: Setting[]): void;
};
const deploy = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync)
  : 'bash';

// The previous revision-3 validator's strict checks, kept independent of restoreTuning.
// Its revision guard rejects the whole payload, not just the migrated R34 fields.
function previousValidator(value: unknown): GlobalTuning {
  const v = value as GlobalTuning;
  const baseline = defaultTuning();
  if (!v || typeof v !== 'object' || !v.cars || !v.traffic || v.r34Revision !== 3 || Object.keys(v).some(k => !['cars', 'traffic', 'r34Revision'].includes(k))) throw new Error('Invalid settings');
  if (Object.keys(v.cars).some(id => !Object.hasOwn(baseline.cars, id))) throw new Error('Unknown car');
  for (const [id, fields] of Object.entries(baseline.cars)) {
    const car = v.cars[id];
    if (!car || typeof car !== 'object' || Object.keys(car).length !== Object.keys(fields).length) throw new Error('Incomplete car');
    for (const key of Object.keys(car)) {
      const field = tuningFields(id).find(f => f.key === key);
      if (!Object.hasOwn(fields, key) || !field) throw new Error('Unknown field');
      const n = car[field.key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < field.min || n > field.max) throw new Error('Invalid field');
    }
  }
  const t = v.traffic;
  const pair = (p: unknown, min: number, max: number) => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) && p[0] <= p[1];
  if (Object.keys(t).some(k => !['lanes', 'truckMin', 'truckMax', 'wallMin', 'wallMax'].includes(k)) || !Array.isArray(t.lanes) || t.lanes.length !== 4 || !t.lanes.every(p => pair(p, 10, 250)) || !pair([t.truckMin, t.truckMax], 10, 180) || !pair([t.wallMin, t.wallMax], 10, 180)) throw new Error('Invalid traffic');
  return structuredClone(v);
}

function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE runs (id INTEGER PRIMARY KEY, score INTEGER); CREATE TABLE log (message TEXT)');
  return db;
}
const set = (db: DatabaseSync, key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
const get = (db: DatabaseSync, key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Setting | undefined)?.value;
function customized() {
  const saved = { ...defaultTuning(), r34Revision: 3 };
  Object.assign(saved.cars['2'], { gripFront: 1.16, gripRear: .93, longGrip: 1.04, powerKW: 480 });
  saved.cars['1'].powerKW = 440;
  saved.cars['3'].powerKW = 650;
  saved.cars['4'].mass = 1500;
  saved.cars['5'].powerKW = 520;
  saved.traffic.lanes[0] = [95, 105];
  return saved;
}

describe('settings-only SQLite rollback', () => {
  it('proves old-validator rejection in actual in-memory SQLite, then restores all custom tuning without rewinding other data', () => {
    const db = database();
    try {
      const saved = customized();
      expect(previousValidator(saved)).toEqual(saved);
      set(db, 'tuning', saved);
      set(db, 'traffic', { intensity: 2.4 });
      set(db, 'radio', { secretFixture: 'private-library', playlists: ['before'] });
      set(db, 'map', 'highway');
      const backup = snapshotSettings(db);
      expect(backup.map(r => r.key)).toEqual(['map', 'radio', 'traffic', 'tuning']);
      set(db, 'tuning', restoreTuning(saved));
      expect(() => previousValidator(JSON.parse(get(db, 'tuning')!))).toThrow();
      // Writes that happened after deployment must survive rollback.
      set(db, 'traffic', { intensity: 3.1 });
      set(db, 'radio', { playlists: ['before', 'new-upload'] });
      set(db, 'new-valid-key', { keep: true });
      db.exec("INSERT INTO runs VALUES (1, 54321); INSERT INTO log VALUES ('post-deploy')");
      restoreSettings(db, backup);
      expect(get(db, 'tuning')).toBe(backup.find(r => r.key === 'tuning')!.value);
      expect(previousValidator(JSON.parse(get(db, 'tuning')!))).toEqual(saved);
      expect(JSON.parse(get(db, 'traffic')!)).toEqual({ intensity: 3.1 });
      expect(JSON.parse(get(db, 'radio')!)).toEqual({ playlists: ['before', 'new-upload'] });
      expect(get(db, 'map')).toBe('"highway"');
      expect(get(db, 'new-valid-key')).toBe('{"keep":true}');
      expect(db.prepare('SELECT score FROM runs').get()?.score).toBe(54321);
      expect(db.prepare('SELECT message FROM log').get()?.message).toBe('post-deploy');
      restoreSettings(db, backup); // Recovery can be retried after a later instance fails.
      expect(JSON.parse(get(db, 'tuning')!)).toEqual(saved);
    } finally { db.close(); }
  });

  it('reads uncheckpointed WAL settings through SQLite, not a copy of the main database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'settings-wal-'));
    const path = join(directory, 'traffic.db');
    const writer = database(path);
    let reader: DatabaseSync | undefined;
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
      mkdirSync(join(directory, 'radio'));
      writeFileSync(join(directory, 'radio/new-upload.mp3'), 'post-deploy upload');
      set(writer, 'tuning', customized());
      expect(existsSync(`${path}-wal`)).toBe(true);
      reader = new DatabaseSync(path, { readOnly: true });
      const backup = snapshotSettings(reader);
      expect(JSON.parse(backup[0].value)).toEqual(customized());
      set(writer, 'tuning', restoreTuning(customized()));
      restoreSettings(writer, backup);
      expect(previousValidator(JSON.parse(get(reader, 'tuning')!))).toEqual(customized());
      expect(readFileSync(join(directory, 'radio/new-upload.mp3'), 'utf8')).toBe('post-deploy upload');
    } finally {
      reader?.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves same-schema admin changes instead of restoring every captured key', () => {
    const db = database();
    try {
      for (const revision of [3, 4]) {
        set(db, 'tuning', { ...customized(), r34Revision: revision });
        const backup = snapshotSettings(db);
        const changed = { ...customized(), r34Revision: revision };
        changed.cars['3'].powerKW = 700;
        set(db, 'tuning', changed);
        restoreSettings(db, backup);
        expect(JSON.parse(get(db, 'tuning')!)).toEqual(changed);
      }
    } finally { db.close(); }
  });

  it('recovers a missing tuning row rather than reporting healthy shipped defaults', () => {
    const db = database();
    try {
      set(db, 'tuning', customized());
      const backup = snapshotSettings(db);
      db.exec("DELETE FROM settings WHERE key = 'tuning'");
      restoreSettings(db, backup);
      expect(previousValidator(JSON.parse(get(db, 'tuning')!))).toEqual(customized());
    } finally { db.close(); }
  });

  it('does not print raw SQLite/file errors or secret-bearing arguments on CLI failure', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', 'restore', '/data/.rollback-settings-missing.json', 'game'], {
      input: readFileSync(new URL('../deploy/rollback-settings.mjs', import.meta.url), 'utf8'),
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: '/private-secret-fixture/traffic.db', NODE_NO_WARNINGS: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Settings recovery operation failed');
    expect(result.stderr).not.toMatch(/private-secret-fixture|ENOENT|stack|readFileSync/);
    expect(result.stdout).toBe('');
  });

  it('handles absent tuning and restores legacy migration inputs byte-for-byte', () => {
    const db = database();
    try {
      const empty = snapshotSettings(db);
      set(db, 'tuning', defaultTuning());
      restoreSettings(db, empty);
      expect(get(db, 'tuning')).toBeUndefined();
      for (const revision of [undefined, 1, 2, 3]) {
        set(db, 'tuning', { ...customized(), r34Revision: revision });
        const backup = snapshotSettings(db);
        set(db, 'tuning', defaultTuning());
        restoreSettings(db, backup);
        expect(get(db, 'tuning')).toBe(backup[0].value);
      }
      expect(snapshotSettings(null)).toEqual([]);
    } finally { db.close(); }
  });

  it('fails closed and atomically on corruption, unknown migrations or SQL write errors', () => {
    const db = database();
    try {
      set(db, 'tuning', customized());
      const backup = snapshotSettings(db);
      for (const bad of ['not json', JSON.stringify({ r34Revision: 5 })]) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'tuning'").run(bad);
        expect(() => restoreSettings(db, backup)).toThrow();
        expect(get(db, 'tuning')).toBe(bad);
      }
      set(db, 'tuning', restoreTuning(customized()));
      const migrated = get(db, 'tuning');
      expect(() => restoreSettings(db, [...backup, ...backup])).toThrow();
      db.exec("CREATE TRIGGER refuse_restore BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'private-data'); END");
      expect(() => restoreSettings(db, backup)).toThrow();
      expect(get(db, 'tuning')).toBe(migrated);
      db.exec('DROP TRIGGER refuse_restore');
      restoreSettings(db, backup);
      expect(get(db, 'tuning')).toBe(backup[0].value);
    } finally { db.close(); }
  });
});

type Scenario = { previous?: boolean; miami?: boolean; failure?: string };
function mockedDeploy({ previous = true, miami = true, failure = 'startup' }: Scenario = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'settings-deploy-'));
  const trace = join(directory, 'trace');
  mkdirSync(join(directory, 'deploy'));
  writeFileSync(join(directory, 'deploy/deploy.sh'), deploy);
  writeFileSync(join(directory, 'deploy/rollback-settings.mjs'), '// helper is supplied on stdin, not baked into an old image');
  try {
    const result = spawnSync(bash!, ['-c', `
      set -euo pipefail
      stop_count=0
      docker() {
        printf '%s\n' "$*" >> "$TRACE"
        case "$*" in
          'image inspect '*) [ "$PREVIOUS" = 1 ]; return ;;
          'compose ps -q game') echo old-highway; return ;;
          'compose ps -q game-miami') [ "$MIAMI" != 1 ] || echo old-miami; return 0 ;;
          inspect*) echo sha256:running; return ;;
          'compose build '*) [ "$FAILURE" != build ]; return ;;
          'compose stop web game game-miami')
            stop_count=$((stop_count + 1))
            [[ "$FAILURE" != rollback-stop || "$stop_count" != 2 ]]; return ;;
          'compose run '*)
            if [[ "$*" == *' backup '* && "$FAILURE" == backup ]]; then return 1; fi
            if [[ "$*" == *'game-miami --input-type=module - backup '* && "$FAILURE" == miami-backup ]]; then return 1; fi
            if [[ "$*" == *' restore '* && "$FAILURE" == restore ]]; then return 1; fi
            if [[ "$*" == *'game-miami --input-type=module - restore '* && "$FAILURE" == miami-restore ]]; then return 1; fi
            return 0 ;;
          'compose up '*) [[ "$FAILURE" == external || "$FAILURE" == success ]]; return ;;
          'compose -f '*)
            cat "$5" >> "$TRACE"
            [ "$FAILURE" != recovery-start ]; return ;;
          run*) [ "$FAILURE" != external ]; return ;;
        esac
        return 0
      }
      openssl() { echo 'IP:fixture'; }
      curl() {
        case "\${!#}" in
          *'/api/admin/state') printf 401 ;;
          *'/version.json') echo '{"version":"fixture"}' ;;
          'https://fixture/') echo '<script src="/assets/fixture.js"></script>' ;;
          'http://fixture/') printf 308 ;;
          *) echo '{"ok":true,"map":"fixture","version":"fixture"}' ;;
        esac
      }
      source "$DEPLOY"
    `, join(directory, 'deploy/deploy.sh').replaceAll('\\', '/')], {
      encoding: 'utf8',
      env: { ...process.env, TRACE: trace, DEPLOY: join(directory, 'deploy/deploy.sh'), TMPDIR: directory,
        SITE_ADDRESS: 'fixture', GIT_SHA: 'fixture', CERT_DIR: directory, SKIP_TESTS: '1',
        PREVIOUS: previous ? '1' : '0', MIAMI: miami ? '1' : '0', FAILURE: failure },
    });
    return { ...result, trace: readFileSync(trace, 'utf8') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe.skipIf(!bash)('deployment rollback orchestration with mocked Docker (no daemon)', () => {
  it('passes Bash syntax validation', () => {
    const result = spawnSync(bash!, ['-n'], { input: deploy, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['startup', 'external'])('backs up both stopped worlds before startup and restores before previous images: %s failure', failure => {
    const result = mockedDeploy({ failure });
    expect(result.status, result.stderr).toBe(1);
    const commands = result.trace.split('\n');
    const index = (part: string) => commands.findIndex(command => command.includes(part));
    expect(index('compose build --pull')).toBeLessThan(index('compose stop web game game-miami'));
    expect(index('compose stop web game game-miami')).toBeLessThan(index('game --input-type=module - backup'));
    expect(index('game --input-type=module - backup')).toBeLessThan(index('game-miami --input-type=module - backup'));
    expect(index('game-miami --input-type=module - backup')).toBeLessThan(index('compose up -d'));
    expect(index('compose up -d')).toBeLessThan(index('game --input-type=module - restore'));
    expect(index('game-miami --input-type=module - restore')).toBeLessThan(index('tag traffic-game:previous'));
    expect(index('tag traffic-game:previous')).toBeLessThan(index('compose -f compose.yaml'));
    expect(result.trace).toContain('image: traffic-game-miami:previous');
    expect(result.trace).toContain('--rm -T --no-deps --pull never --entrypoint node');
    expect(result.trace).not.toContain('compose logs');
    expect(result.stdout).not.toContain('deployed fixture:');
  });

  it.each(['restore', 'miami-restore'])('does not tag or restart any previous binary after %s fails', failure => {
    const result = mockedDeploy({ failure });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('servers remain stopped');
    expect(result.trace).not.toContain('tag traffic-game:previous traffic-game:latest');
    expect(result.trace).not.toContain('compose -f compose.yaml');
    expect(result.trace).not.toContain(' discard ');
  });

  it.each(['backup', 'miami-backup'])('does not start either new world after an incomplete %s', failure => {
    const result = mockedDeploy({ failure });
    expect(result.status).toBe(1);
    expect(result.trace).not.toContain('compose up ');
    expect(result.trace).not.toContain(' restore ');
    expect(result.stderr).toContain('no new server started');
    expect(result.trace).not.toContain(' discard ');
  });

  it('never restores or starts old images if writers cannot be stopped for recovery', () => {
    const result = mockedDeploy({ failure: 'rollback-stop' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot stop writers');
    expect(result.trace).not.toContain(' restore ');
    expect(result.trace).not.toContain('compose -f');
    expect(result.trace).not.toContain(' discard ');
  });

  it('keeps old containers running on build failure', () => {
    const result = mockedDeploy({ failure: 'build' });
    expect(result.status).toBe(1);
    expect(result.trace).not.toContain('compose stop');
    expect(result.trace).not.toContain(' backup ');
  });

  it('keeps first Miami stopped and its volume intact on highway-only recovery', () => {
    const result = mockedDeploy({ miami: false });
    expect(result.status).toBe(1);
    expect(result.trace).toContain('compose stop game-miami');
    expect(result.trace).toContain('game --input-type=module - restore');
    expect(result.trace).not.toContain('game-miami --input-type=module - restore');
    expect(result.trace).not.toContain('image: traffic-game-miami:previous');
    expect(result.trace).toContain('--wait-timeout 120 game web\n');
    expect(result.trace).not.toMatch(/volume (rm|prune)|compose down/);
  });

  it('stops an unsuccessful recovery, retaining snapshots and never claiming success', () => {
    const result = mockedDeploy({ failure: 'recovery-start' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rollback failed; servers stopped');
    expect(result.trace.match(/compose stop web game game-miami/g)).toHaveLength(3);
    expect(result.trace).not.toContain(' discard ');
  });

  it('fails closed without previous images', () => {
    const result = mockedDeploy({ previous: false, miami: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no previous game/web images');
    expect(result.trace).not.toContain('compose -f');
  });

  it('discards settings snapshots only after successful external verification', () => {
    const result = mockedDeploy({ failure: 'success' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace.match(/ - discard /g)).toHaveLength(2);
    expect(result.trace).not.toContain(' - restore ');
    expect(result.stdout).toContain('deployed fixture:');
  });
});
