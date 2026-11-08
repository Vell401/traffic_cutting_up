/** Lower fill cost only for sustained GPU-bound frames, never for a join/loading stall. */
export class ResolutionBudget {
  ratio: number;
  private elapsed = 0;
  private frames = 0;
  private cpu = 0;

  constructor(private readonly maximum: number) { this.ratio = maximum; }

  observe(frameMs: number, cpuMs: number, active: boolean): boolean {
    if (!active || frameMs <= 0 || frameMs > 250) {
      this.elapsed = this.frames = this.cpu = 0;
      return false;
    }
    this.elapsed += frameMs; this.cpu += cpuMs; this.frames++;
    if (this.elapsed < 2500) return false;
    const average = this.elapsed / this.frames;
    const gpuBound = this.cpu / this.frames < average * .7;
    this.elapsed = this.frames = this.cpu = 0;
    const minimum = Math.min(this.maximum, .75);
    if (average < 34 || !gpuBound || this.ratio <= minimum) return false;
    this.ratio = Math.max(minimum, this.ratio * .8);
    return true;
  }
}
