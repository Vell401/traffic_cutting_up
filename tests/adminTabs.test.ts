import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, adminTabNavigation, isAdminTab, loadAdminTab, saveAdminTab, tabForKey, tabStorageKey } from '../src/admin/tabs';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};

describe('admin top-level tabs', () => {
  it('has six stable panels, separate from leaderboard/log filters', () => {
    expect(ADMIN_TABS.map(tab => tab.id)).toEqual(['overview', 'traffic', 'tuning', 'radio', 'leaderboard', 'logs']);
    const html = adminTabNavigation();
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html).toContain('role="tablist"');
    for (const tab of ADMIN_TABS) {
      expect(html).toContain(`id="admin-tab-${tab.id}"`);
      expect(html).toContain(`aria-controls="admin-panel-${tab.id}"`);
    }
    expect(html).not.toMatch(/boardTabs|logTabs/);
  });

  it('wraps arrows and supports Home/End without handling unrelated keys', () => {
    expect(tabForKey('overview', 'ArrowLeft')).toBe('logs');
    expect(tabForKey('logs', 'ArrowRight')).toBe('overview');
    expect(tabForKey('radio', 'ArrowLeft')).toBe('tuning');
    expect(tabForKey('radio', 'ArrowRight')).toBe('leaderboard');
    expect(tabForKey('radio', 'Home')).toBe('overview');
    expect(tabForKey('radio', 'End')).toBe('logs');
    for (const key of ['Tab', 'Enter', ' ', 'ArrowDown', 'Escape']) expect(tabForKey('radio', key)).toBeNull();
  });

  it('restores only for the same login and API routing scope', () => {
    const storage = memoryStorage();
    const server = 'https://example.test/map-a/api/admin';
    saveAdminTab(storage, server, 'secret-token-a', 'radio');
    expect(loadAdminTab(storage, server, 'secret-token-a')).toBe('radio');
    expect(loadAdminTab(storage, server, 'secret-token-b')).toBe('overview');
    expect(loadAdminTab(storage, 'https://example.test/map-b/api/admin', 'secret-token-a')).toBe('overview');
    expect([...storage.data.values()].join('')).not.toContain('secret-token-a');
    saveAdminTab(storage, 'https://example.test/map-b/api/admin', 'secret-token-a', 'traffic');
    expect(loadAdminTab(storage, server, 'secret-token-a')).toBe('radio');
  });

  it('rejects corrupt, obsolete and untrusted stored tab names', () => {
    const storage = memoryStorage(), server = '/api/admin';
    saveAdminTab(storage, server, 'login', 'radio');
    const valid = JSON.parse(storage.getItem(tabStorageKey(server))!);
    for (const value of ['null', 'false', '42', '{}', 'invalid', JSON.stringify({ ...valid, tab: '<img onerror=alert(1)>' }), JSON.stringify({ ...valid, tab: 'solo' })]) {
      storage.setItem(tabStorageKey(server), value);
      expect(loadAdminTab(storage, server, 'login')).toBe('overview');
    }
    expect(isAdminTab('__proto__')).toBe(false);
    expect(isAdminTab(null)).toBe(false);
  });

  it('works with unavailable or denied session storage', () => {
    const denied = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('full'); } };
    for (const storage of [undefined, denied]) {
      expect(loadAdminTab(storage, '/api/admin', 'login')).toBe('overview');
      expect(() => saveAdminTab(storage, '/api/admin', 'login', 'logs')).not.toThrow();
    }
  });
});
