import type { MapId } from '../sim/maps';

type PreferenceStore = Pick<Storage, 'getItem' | 'setItem'>;
const MAP_KEY = 'tcu.map';

export const SERVER_OPTIONS: readonly { map: MapId; name: string; description: string }[] = [
  { map: 'highway', name: 'Night Highway', description: 'Ночной хайвей · город, тоннели и мосты' },
  { map: 'miami', name: 'Miami Night', description: 'Кольцо 30 км · пляжи, дамбы через залив, даунтаун и марина' },
];

function browserStore(): PreferenceStore | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function validMap(value: string | null): value is MapId {
  return value === 'highway' || value === 'miami';
}

/** Resolve before constructing Sim, WebSocket, API clients or a renderer. */
export function selectedMap(params: URLSearchParams, store = browserStore()): MapId {
  const requested = params.get('map');
  if (validMap(requested)) return requested;
  try {
    const saved = store?.getItem(MAP_KEY) ?? null;
    if (validMap(saved)) return saved;
  } catch { /* URL/default selection still works when storage is blocked. */ }
  return 'highway';
}

export function saveSelectedMap(map: MapId, store = browserStore()): void {
  try { store?.setItem(MAP_KEY, map); } catch { /* Selection is also encoded in the URL. */ }
}

/** A built-in server choice deliberately drops a previous custom-server override. */
export function mapNavigation(current: URL, map: MapId): URL {
  const next = new URL(current.href);
  next.searchParams.set('map', map);
  next.searchParams.delete('server');
  return next;
}

/** Preserve map, custom endpoint, debug and network options while changing play mode. */
export function modeNavigation(current: URL, mode: 'solo' | 'online'): URL {
  const next = new URL(current.href);
  for (const key of ['solo', 'online', 'test']) next.searchParams.delete(key);
  if (mode === 'solo') next.searchParams.set('solo', '');
  return next;
}

const skyKey = (map: MapId) => map === 'highway' ? 'tcu.sky' : `tcu.sky.${map}`;
export function loadMapSky(map: MapId, fallback: string, store = browserStore()): string {
  try { return store?.getItem(skyKey(map)) || fallback; } catch { return fallback; }
}
export function saveMapSky(map: MapId, sky: string, store = browserStore()): void {
  try { store?.setItem(skyKey(map), sky); } catch { /* Current scene remains usable. */ }
}

/** Native select works with keyboard, phone pickers and screen readers. Selection reloads
 * through the caller: never replace a road underneath an active prediction core. */
export function mountServerPicker(root: HTMLElement, selected: MapId, onSelect: (map: MapId) => void): () => void {
  const select = document.createElement('select');
  select.id = 'serverChoice';
  select.setAttribute('aria-label', 'Онлайн-сервер и карта');
  const description = document.createElement('div');
  description.id = 'serverChoiceDescription';
  description.className = 'odesc';
  select.setAttribute('aria-describedby', description.id);
  for (const server of SERVER_OPTIONS) {
    const option = document.createElement('option');
    option.value = server.map; option.textContent = server.name;
    select.append(option);
  }
  select.value = selected;
  description.textContent = SERVER_OPTIONS.find(server => server.map === selected)!.description;
  const change = () => {
    if (validMap(select.value) && select.value !== selected) onSelect(select.value);
  };
  // Keep native navigation/type-ahead (including Enter/Space) out of driving input.
  // Do not prevent defaults or stop keyup: Input's capture listener must release
  // any key that was already held when focus entered the picker.
  const keydown = (event: KeyboardEvent) => event.stopPropagation();
  select.addEventListener('keydown', keydown);
  select.addEventListener('change', change);
  root.replaceChildren(select, description);
  return () => {
    select.removeEventListener('keydown', keydown);
    select.removeEventListener('change', change);
    select.remove(); description.remove();
  };
}
