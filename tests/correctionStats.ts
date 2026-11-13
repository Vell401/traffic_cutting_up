import { mulberry32 } from '../src/core/rng';

/** Headless telemetry only: exact count/max, exact percentiles up to a bounded reservoir.
 * Longer runs use uniform reservoir sampling, with their percentile estimates explicitly labelled.
 * Its private RNG never consumes simulation/link randomness.
 */
export class CorrectionStats {
  private readonly sizes: number[] = [];
  private readonly rng = mulberry32(37);
  private count = 0;
  private max = 0;

  record(size: number): void {
    this.count++;
    this.max = Math.max(this.max, size);
    if (this.sizes.length < 16_384) this.sizes.push(size);
    else {
      const index = Math.floor(this.rng() * this.count);
      if (index < this.sizes.length) this.sizes[index] = size;
    }
  }

  summary() {
    const sorted = this.sizes.slice().sort((a, b) => a - b);
    const pct = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    return { count: this.count, max: this.max, p50: pct(0.5), p95: pct(0.95), samples: sorted.length, sampled: this.count > sorted.length };
  }
}
