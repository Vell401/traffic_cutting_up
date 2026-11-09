import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminInstance, adminMapNavigation, matchesAdminInstance } from '../src/admin/instance';

afterEach(() => vi.unstubAllGlobals());
describe('admin actions are tied to an explicit built-in online instance', () => {
  it('uses separate endpoints, credentials and tab preferences for the two maps', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const highway = adminInstance(new URLSearchParams('map=highway'));
    const miami = adminInstance(new URLSearchParams('map=miami'));
    expect(highway.api).toBe('/api/admin'); expect(miami.api).toBe('/miami/api/admin');
    expect(highway.tokenKey).not.toBe(miami.tokenKey); expect(highway.tabKey).not.toBe(miami.tabKey);
  });
  it('never redirects admin credentials to an arbitrary custom game server', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(adminInstance(new URLSearchParams('map=miami&server=https://untrusted.test')).api).toBe('/miami/api/admin');
    const next = adminMapNavigation(new URL('https://game.test/admin.html?token=secret&password=secret&server=https://untrusted.test'), 'miami');
    expect(next.pathname).toBe('/admin.html'); expect(next.origin).toBe('https://game.test');
    expect(next.search).toBe('?map=miami');
  });
  it('requires authoritative map identity before actions can be enabled', () => {
    expect(matchesAdminInstance('miami', 'miami')).toBe(true);
    expect(matchesAdminInstance({ id: 'miami' }, 'miami')).toBe(true);
    for (const identity of [undefined, null, {}, 'highway', { id: 'highway' }]) {
      expect(matchesAdminInstance(identity, 'miami')).toBe(false);
    }
  });
});
