/** Random source in [0, 1). Defaults to Math.random; tests pass a seeded one to reproduce situations. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();

export const pickWeighted = <T extends { weight: number }>(rng: Rng, items: readonly T[]): T => {
  let total = 0;
  for (const it of items) total += it.weight;
  let x = rng() * total;
  for (const it of items) {
    x -= it.weight;
    if (x <= 0) return it;
  }
  return items[items.length - 1];
};
