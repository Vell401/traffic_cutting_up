import type { MapId } from '../sim/maps';
import { mapNavigation, selectedMap, SERVER_OPTIONS } from '../ui/serverPicker';

export interface AdminInstance {
  map: MapId;
  name: string;
  api: string;
  tokenKey: string;
  tabKey: string;
}

export function adminInstance(params: URLSearchParams): AdminInstance {
  const map = selectedMap(params);
  const name = SERVER_OPTIONS.find(server => server.map === map)!.name;
  return {
    map, name,
    // Deliberately same-origin catalogue endpoints, not arbitrary game ?server= URLs.
    api: map === 'miami' ? '/miami/api/admin' : '/api/admin',
    tokenKey: `tcu.admin.${map}`,
    tabKey: `tcu.admin.tab.${map}`,
  };
}

export function adminMapNavigation(current: URL, map: MapId): URL {
  const next = mapNavigation(current, map);
  for (const key of ['token', 'password']) next.searchParams.delete(key);
  return next;
}

/** Do not enable moderation/tuning against a proxy accidentally targeting another world. */
export function matchesAdminInstance(identity: unknown, expected: MapId): boolean {
  if (typeof identity === 'string') return identity === expected;
  if (!identity || typeof identity !== 'object') return false;
  return 'id' in identity && identity.id === expected;
}
