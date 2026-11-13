import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminInstance, adminMapNavigation, matchesAdminInstance } from '../src/admin/instance';

afterEach(() => vi.unstubAllGlobals());
describe('admin actions are tied to an explicit built-in online instance', () => {
  it('shares one central credential but isolates target endpoints and tab preferences', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const highway = adminInstance(new URLSearchParams('map=highway'));
    const miami = adminInstance(new URLSearchParams('map=miami'));
    expect(highway.api).toBe('/api/admin'); expect(miami.api).toBe('/api/admin/maps/miami');
    expect(highway.tokenKey).toBe('tcu.admin'); expect(miami.tokenKey).toBe('tcu.admin');
    expect(highway.tabKey).not.toBe(miami.tabKey);
  });
  it('never redirects admin credentials to an arbitrary custom game server', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(adminInstance(new URLSearchParams('map=miami&server=https://untrusted.test')).api).toBe('/api/admin/maps/miami');
    const next = adminMapNavigation(new URL('https://game.test/admin.html?token=secret&password=secret&server=https://untrusted.test'), 'miami');
    expect(next.pathname).toBe('/admin.html'); expect(next.origin).toBe('https://game.test');
    expect(next.search).toBe('?map=miami');
  });
  it.each([
    ['highway', 'miami', '/api/admin/maps/miami'],
    ['miami', 'highway', '/api/admin'],
  ] as const)('keeps the replaced %s → %s deep link aligned with its allowlisted API', (from, to, api) => {
    const next = adminMapNavigation(new URL(`https://game.test/admin.html?map=${from}&server=https://untrusted.test&token=secret&password=secret`), to);
    expect(next.href).toBe(`https://game.test/admin.html?map=${to}`);
    expect(adminInstance(next.searchParams)).toMatchObject({ map: to, api, tokenKey: 'tcu.admin' });
  });
  it('requires authoritative map identity before actions can be enabled', () => {
    expect(matchesAdminInstance('miami', 'miami')).toBe(true);
    expect(matchesAdminInstance({ id: 'miami' }, 'miami')).toBe(true);
    for (const identity of [undefined, null, {}, 'highway', { id: 'highway' }]) {
      expect(matchesAdminInstance(identity, 'miami')).toBe(false);
    }
  });
});
