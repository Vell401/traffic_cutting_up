export interface SimEvents {
  /** side: -1 the car was on our left, 1 on our right. */
  nearMiss: { points: number; gap: number; truck: boolean; combo: number; mult: number; side: number };
  /** Any pass within a few metres, scored or not (audio whoosh). */
  passBy: { side: number; gap: number; truck: boolean; relSpeed: number };
  laneSplit: { points: number; combo: number; mult: number };
  comboEnd: { reason: 'timeout' | 'wall' };
  wallHit: { speed: number };
  crash: { speed: number };
  /** A soft contact with another driver (online): the combo ends, the run goes on. */
  bump: { speed: number };
  runEnd: { score: number; best: number; newBest: boolean; time: number; near: number; topKmh: number };
  trafficMode: { mode: string; label: string };
  /** Stopped at the end barrier of a finite (showcase) track. */
  trackEnd: Record<string, never>;
}
