import { miamiScript } from './miami';
import { ringScript, SPAWN_S, SPAWN_D, SPAWN_GAP, SPAWN_PLACES } from './ring';
import type { RoadScript } from './road';

export type MapId = 'highway' | 'miami';

export interface MapDefinition {
  readonly id: MapId;
  readonly name: string;
  readonly revision: number;
  readonly theme: 'highway' | 'miami';
  readonly script: RoadScript;
  readonly spawn: {
    readonly s: number;
    readonly d: number;
    readonly gap: number;
    readonly places: number;
    /** Protected interval relative to the front pad: (-protectionBehind, protectionLength). */
    readonly protectionLength: number;
    readonly protectionBehind: number;
    readonly protectionInset: number;
  };
  readonly defaultSky: 'night' | 'miami-night';
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const spawn = { s: SPAWN_S, d: SPAWN_D, gap: SPAWN_GAP, places: SPAWN_PLACES, protectionLength: 30, protectionBehind: 12, protectionInset: 1.6 };
const MAPS: Readonly<Record<MapId, MapDefinition>> = freeze({
  highway: { id: 'highway', name: 'Highway', revision: 1, theme: 'highway', script: ringScript(), spawn, defaultSky: 'night' },
  miami: { id: 'miami', name: 'Miami', revision: 1, theme: 'miami', script: miamiScript(), spawn: { ...spawn, s: 300 }, defaultSky: 'miami-night' },
});

/** Pure registry access. Never silently route an unknown map to highway. */
export function getMap(id: MapId): MapDefinition {
  if (!Object.hasOwn(MAPS, id)) throw new Error(`Unknown map: ${String(id)}`);
  return MAPS[id];
}

export function resolveMap(id: unknown = 'highway'): MapDefinition {
  if (id !== 'highway' && id !== 'miami') throw new Error(`Unknown map: ${String(id)}`);
  return getMap(id);
}

export const mapSpawnS = (map: MapDefinition, place: number): number => map.spawn.s - place * map.spawn.gap;

/** Ring-aware on every positive/negative lap; strict interval edges preserve highway behavior. */
export function isSpawnProtected(map: MapDefinition, s: number, d: number, ringLen: number): boolean {
  const p = map.spawn;
  if (d < p.d - p.protectionInset) return false;
  const delta = s - p.s;
  const rel = delta - ringLen * Math.round(delta / ringLen);
  return rel < p.protectionLength && rel > -(p.places - 1) * p.gap - p.protectionBehind;
}
