import { carTune, scoreTune, trafficTune, SIM_HZ } from '../config';
import { driftTune } from '../sim/vehicleDrift';
import { SPAWN_D, SPAWN_GAP, SPAWN_S, ringScript } from '../sim/ring';
import { VEHICLES } from '../sim/vehicles';
import type { TrafficPreset } from '../sim/director';

/** Bumped on any change to the message formats. */
export const PROTOCOL_VERSION = 6;

/**
 * Session settings the server decides and sends in `welcome`. The client never picks traffic: it is one
 * shared world. Each driver only picks their own car physics.
 */
export interface OnlineRules {
  tickHz: number;
  /** A snapshot goes to every driver each this many ticks (120 / 4 = 30 per second). */
  snapshotEvery: number;
  maxPlayers: number;
  traffic: TrafficPreset;
  /** Fixed difficulty 0..1 (single player ramps it with the run distance). */
  intensity: number;
  /** Traffic modes change after about this long, s. */
  modeSeconds: number;
  /** Spawn protection after joining or respawning, s. */
  ghostSeconds: number;
  /** No input for this long (tab hidden, connection stalled): the car leaves the road, s. */
  awaySeconds: number;
  /** A dropped connection keeps its place, score and best this long, s. */
  reconnectSeconds: number;
  /** Input queue depth over which the server applies two inputs per tick to catch up. */
  inputHigh: number;
  /** Input queue limit; a client that runs further ahead is cut back (and counted as a violation). */
  inputMax: number;
  /** Traffic sent to a driver: this far behind and ahead of the car, m. */
  viewBehind: number;
  viewAhead: number;
}

export const DEFAULT_RULES: OnlineRules = {
  tickHz: SIM_HZ,
  snapshotEvery: 4,
  maxPlayers: 50,
  traffic: 1,
  intensity: 0.45,
  modeSeconds: 40,
  ghostSeconds: 3,
  awaySeconds: 0.75,
  reconnectSeconds: 60,
  inputHigh: 6,
  inputMax: 240,
  viewBehind: 260,
  viewAhead: 1000,
};

/** FNV-1a over a string, as 8 hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let cached = '';

/**
 * Version of the game rules: a hash of every tunable that the server and the client's prediction must
 * agree on (car physics, traffic, scoring, vehicles, the ring). A client with different rules (stale
 * page after a deploy) is turned away instead of mispredicting everything. Computed once, before any
 * debug panel can edit the tunables.
 */
export function rulesHash(): string {
  if (!cached) {
    cached = fnv1a(
      JSON.stringify({ v: PROTOCOL_VERSION, carTune, driftTune, trafficTune, scoreTune, VEHICLES, ring: ringScript(), spawn: [SPAWN_S, SPAWN_GAP, SPAWN_D] }),
    );
  }
  return cached;
}
