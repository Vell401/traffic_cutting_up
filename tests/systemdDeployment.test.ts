import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const unitPath = fileURLToPath(new URL('../deploy/traffic-server.service', import.meta.url));
const unit = readFileSync(unitPath, 'utf8');
const sections = new Map<string, Map<string, string[]>>();
let section = '';
for (const raw of unit.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) continue;
  if (/^\[.+\]$/.test(line)) {
    section = line.slice(1, -1);
    sections.set(section, new Map());
    continue;
  }
  const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
  if (!assignment || !sections.has(section)) throw new Error(`Invalid unit line: ${line}`);
  const entries = sections.get(section)!;
  entries.set(assignment[1], [...(entries.get(assignment[1]) ?? []), assignment[2]]);
}
const service = sections.get('Service')!;
const values = (key: string) => service.get(key) ?? [];
const environment = Object.fromEntries(values('Environment').map(value => {
  const separator = value.indexOf('=');
  return [value.slice(0, separator), value.slice(separator + 1)];
}));
const stateRoots = values('StateDirectory').flatMap(value => value.split(/\s+/)).map(name => posix.join('/var/lib', name));
const logRoots = values('LogsDirectory').flatMap(value => value.split(/\s+/)).map(name => posix.join('/var/log', name));
const contains = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

// These are configuration/schema assertions, NOT a simulated systemd mount namespace
// or a chmod/write probe (which would not prove ProtectSystem behavior on Windows/root).
describe('systemd durable storage and sandbox configuration', () => {
  it('uses valid sections and known service directives, without duplicate singleton settings', () => {
    expect([...sections.keys()]).toEqual(['Unit', 'Service', 'Install']);
    const allowed = new Set([
      'Type', 'User', 'Group', 'WorkingDirectory', 'ExecStart', 'Environment',
      'StateDirectory', 'StateDirectoryMode', 'LogsDirectory', 'LogsDirectoryMode', 'UMask',
      'Restart', 'RestartSec', 'MemoryMax', 'NoNewPrivileges', 'ProtectSystem', 'ProtectHome', 'PrivateTmp',
    ]);
    for (const [key, entries] of service) {
      expect(allowed.has(key), `Unknown/unreviewed service directive: ${key}`).toBe(true);
      if (key !== 'Environment') expect(entries, `Duplicate ${key}`).toHaveLength(1);
    }
    expect(Object.keys(environment)).toHaveLength(values('Environment').length);
  });

  it('starts Node as the unprivileged traffic account with privately created durable directories', () => {
    expect(values('Type')).toEqual(['simple']);
    expect(values('User')).toEqual(['traffic']);
    expect(values('Group')).toEqual(['traffic']);
    expect(values('WorkingDirectory')).toEqual(['/opt/traffic']);
    expect(values('ExecStart')).toEqual(['/usr/bin/node dist-server/main.js']);
    expect(values('StateDirectory')).toEqual(['traffic']);
    expect(values('StateDirectoryMode')).toEqual(['0700']);
    expect(values('LogsDirectory')).toEqual(['traffic/sessions']);
    expect(values('LogsDirectoryMode')).toEqual(['0700']);
    expect(values('UMask')).toEqual(['0077']);
    // Directory creation/ownership is performed by systemd, not a privileged shell
    // or an unprivileged ExecStartPre trying to mkdir inside a read-only /opt.
    expect(values('ExecStartPre')).toEqual([]);
  });

  it('explicitly places SQLite, its WAL/SHM siblings and uploaded radio under the managed state directory', () => {
    expect(environment.DB_PATH).toBe('/var/lib/traffic/traffic.db');
    expect(environment.RADIO_DIR).toBe('/var/lib/traffic/radio');
    for (const path of [environment.DB_PATH, `${environment.DB_PATH}-wal`, `${environment.DB_PATH}-shm`, environment.RADIO_DIR]) {
      expect(stateRoots.some(root => contains(root, path)), `${path} must be in managed writable state`).toBe(true);
    }
    // SQLite must be able to create siblings, not just write an allowlisted DB file.
    expect(stateRoots).toContain(posix.dirname(environment.DB_PATH));
    expect(posix.dirname(environment.RADIO_DIR)).toBe(posix.dirname(environment.DB_PATH));
  });

  it('keeps replay journaling opt-in and provides its directory even on a clean installation', () => {
    expect(environment.JOURNAL_DIR).toBeUndefined();
    const journalPath = unit.match(/^# Environment=JOURNAL_DIR=(\S+)\s*$/m)?.[1];
    expect(journalPath).toBe('/var/log/traffic/sessions');
    expect(logRoots).toContain(journalPath);
    // Neither the active unit nor its opt-in journal setting references an absent
    // /opt directory that systemd would need to mount before Node could create it.
    expect(values('ReadWritePaths')).toEqual([]);
    expect(unit).not.toMatch(/^\s*(?:ReadWritePaths|Environment=JOURNAL_DIR)=.*\/opt\/traffic\/sessions/m);
  });

  it('retains the strict sandbox and leaves application code outside writable managed roots', () => {
    expect(values('ProtectSystem')).toEqual(['strict']);
    expect(values('ProtectHome')).toEqual(['true']);
    expect(values('NoNewPrivileges')).toEqual(['true']);
    expect(values('PrivateTmp')).toEqual(['true']);
    expect([...stateRoots, ...logRoots]).toEqual(['/var/lib/traffic', '/var/log/traffic/sessions']);
    for (const path of ['/opt/traffic', '/opt/traffic/dist-server/main.js', '/etc', '/usr', '/']) {
      expect([...stateRoots, ...logRoots].some(root => contains(root, path)), path).toBe(false);
    }
  });
});

const analyzer = process.platform === 'linux'
  ? spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' })
  : undefined;
const canVerify = analyzer?.status === 0;
describe('systemd native unit schema validation (not a service launch)', () => {
  it.skipIf(!canVerify)('passes systemd-analyze verify when available on Linux', () => {
    const result = spawnSync('systemd-analyze', ['verify', '--man=no', unitPath], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
