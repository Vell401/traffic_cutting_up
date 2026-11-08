/**
 * Adapted from swift502/Sketchbook (MIT), commit
 * 62f4b7986fd1ce1e4f91daba89ef032c20a6ce55:
 * Car.physicsPreStep, SpringSimulator, SimulatorBase and FunctionLibrary.spring.
 * Coordinate sign is reversed for our right-positive rack. Unlike upstream, key release
 * disconnects the driver: the physical rack is then driven by tyre/caster torque, not target 0.
 * No air-spin controls, body rotation edits or path/road feedback are imported.
 */
export function sketchbookKeyTarget(key: number, forwardSpeed: number, lateralSpeed: number, lock: number, keyScale = 1): number {
  const correction = Math.atan2(lateralSpeed, Math.max(Math.abs(forwardSpeed), 3));
  const base = .8 * keyScale / Math.max(forwardSpeed * .3, 1);
  const target = key > 0 ? Math.max(base, correction) : key < 0 ? Math.min(-base, correction) : 0;
  // Upstream has binary actions. Preserve fractional network/bot input without promoting a
  // one-percent correction into a full key press; binary keyboard behavior is unchanged.
  return Math.max(-lock, Math.min(lock, target)) * Math.min(Math.abs(key), 1);
}

/** Original fixed-60-Hz spring and two-frame interpolation; every scalar is serialized. */
export class SketchbookSpring {
  position = 0;
  velocity = 0;
  target = 0;
  offset = 0;
  previousPosition = 0;
  previousVelocity = 0;
  nextPosition = 0;
  nextVelocity = 0;

  reset(): void { this.load(new Float64Array(8)); }
  save(out: Float64Array, o = 0): number {
    for (const x of [this.position, this.velocity, this.target, this.offset, this.previousPosition,
      this.previousVelocity, this.nextPosition, this.nextVelocity]) out[o++] = x;
    return o;
  }
  load(src: ArrayLike<number>, o = 0): number {
    this.position = src[o++]; this.velocity = src[o++]; this.target = src[o++]; this.offset = src[o++];
    this.previousPosition = src[o++]; this.previousVelocity = src[o++];
    this.nextPosition = src[o++]; this.nextVelocity = src[o++];
    return o;
  }
  simulate(dt: number): void {
    const frameTime = 1 / 60, total = this.offset + dt;
    const frames = Math.floor(total / frameTime);
    this.offset = total % frameTime;
    for (let i = 0; i < frames; i++) {
      this.previousPosition = this.nextPosition; this.previousVelocity = this.nextVelocity;
      this.nextVelocity = (this.nextVelocity + (this.target - this.nextPosition) / 10) * .6;
      this.nextPosition += this.nextVelocity;
    }
    const alpha = this.offset / frameTime;
    this.position = this.previousPosition + (this.nextPosition - this.previousPosition) * alpha;
    this.velocity = this.previousVelocity + (this.nextVelocity - this.previousVelocity) * alpha;
  }
}
