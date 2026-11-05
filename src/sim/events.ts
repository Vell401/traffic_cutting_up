export interface SimEvents {
  nearMiss: { points: number; gap: number; truck: boolean; combo: number; mult: number };
  laneSplit: { points: number; combo: number; mult: number };
  comboEnd: { reason: 'timeout' | 'wall' };
  wallHit: { speed: number };
  crash: { speed: number };
  runEnd: { score: number; best: number; newBest: boolean; time: number; near: number; topKmh: number };
}
