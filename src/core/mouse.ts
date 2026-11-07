import { clamp } from './math';

export type SteerMode = 'keys' | 'mouse';

/** Mouse travel for full lock at sensitivity 1, px (about half a screen, like a sim's mouse steering). */
const FULL_LOCK_PX = 900;

export interface MouseHooks {
  /** Turn the camera by a mouse move (px). */
  look(dx: number, dy: number): void;
  /** True while the player drives (not in a menu or paused): only then does the mouse take the wheel. */
  driving(): boolean;
  /** The mouse was let go while driving with it (Esc, another window): pause. */
  released(): void;
}

/**
 * Everything the mouse does on the game view.
 *
 * Keyboard mode: hold the left button and drag to look around.
 * Mouse mode (as in Assetto Corsa): a click captures the pointer; then side-to-side travel turns the
 * wheel and it stays where it was left, the left button is the throttle, the right one the brake,
 * the middle one held looks around. Esc lets the pointer go.
 */
export class MouseControl {
  mode: SteerMode;
  /** Steering speed multiplier, 0.05..3; default 0.3. */
  sens: number;
  /** Mouse-mode wheel position, -1..1, and pedals 0/1. */
  steer = 0;
  throttle = 0;
  brake = 0;
  private looking = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: MouseHooks,
    mode: SteerMode,
    sens: number,
  ) {
    this.mode = mode;
    this.sens = sens;
    canvas.addEventListener('mousedown', (e) => this.down(e));
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', (e) => this.buttons(e.buttons));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      if (this.locked) return;
      this.throttle = this.brake = 0;
      this.looking = false;
      if (this.mode === 'mouse' && hooks.driving()) hooks.released();
    });
    window.addEventListener('blur', () => this.buttons(0));
  }

  /** The pointer is captured for steering. */
  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Mouse steering in effect right now. */
  get active(): boolean {
    return this.mode === 'mouse' && this.locked;
  }

  setMode(mode: SteerMode): void {
    this.mode = mode;
    this.centre();
    if (mode === 'keys' && this.locked) document.exitPointerLock();
  }

  /** Straighten the wheel (new run, respawn). */
  centre(): void {
    this.steer = 0;
  }

  private down(e: MouseEvent): void {
    if (this.mode === 'mouse' && this.hooks.driving()) {
      if (!this.locked) {
        // The capturing click is not a pedal press.
        void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
        return;
      }
      this.buttons(e.buttons);
      e.preventDefault();
      return;
    }
    this.buttons(e.buttons);
  }

  /** Button state from the event's bitmask (handles chords: brake and throttle together). */
  private buttons(mask: number): void {
    if (this.active) {
      this.throttle = mask & 1 ? 1 : 0;
      this.brake = mask & 2 ? 1 : 0;
      this.looking = (mask & 4) !== 0;
    } else {
      this.throttle = this.brake = 0;
      this.looking = (mask & 1) !== 0;
    }
  }

  private move(e: MouseEvent): void {
    if (this.active) {
      this.steer = clamp(this.steer + (e.movementX * this.sens) / FULL_LOCK_PX, -1, 1);
      if (this.looking) this.hooks.look(e.movementX, e.movementY);
      return;
    }
    if (this.looking) {
      // A drag that started on the game view and left the window ends when the button does.
      if ((e.buttons & 1) === 0) this.looking = false;
      else this.hooks.look(e.movementX, e.movementY);
    }
  }
}
