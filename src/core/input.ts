import type { DriveInput } from '../sim/vehicle';
import type { MouseControl } from './mouse';

/** Keys whose browser default (scrolling, F1 help) must not fire. */
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1']);
const DEADZONE = 0.12;

/** Keyboard (layout independent, by KeyboardEvent.code) and gamepad. */
export class Input {
  readonly drive: DriveInput = { steer: 0, throttle: 0, brake: 0, analog: false, boost: false };
  /** Fired once per key press (no auto-repeat). Gamepad buttons are mapped to key codes. */
  onPress: ((code: string) => void) | null = null;

  /** Mouse steering and pedals, when the player drives with the mouse. */
  mouse: MouseControl | null = null;
  private readonly keys = new Set<string>();
  private padPrev: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (BLOCK.has(e.code)) e.preventDefault();
      if (!e.repeat) this.onPress?.(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  poll(): void {
    const k = this.keys;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let boost = k.has('ShiftLeft') || k.has('ShiftRight');
    let handbrake = k.has('Space');
    let horn = k.has('KeyH');
    let analog = false;
    let direct = false;

    // Mouse steering: the wheel stays where the mouse left it and its travel is the wheel angle;
    // held keys still steer over it.
    const m = this.mouse;
    if (m?.active) {
      if (steer === 0) {
        steer = m.steer;
        analog = true;
        direct = true;
      }
      throttle = Math.max(throttle, m.throttle);
      brake = Math.max(brake, m.brake);
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) {
        steer = Math.sign(ax) * Math.pow((Math.abs(ax) - DEADZONE) / (1 - DEADZONE), 1.6);
        analog = true;
        direct = false;
      }
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      boost ||= pad.buttons[5]?.pressed ?? false;
      handbrake ||= pad.buttons[1]?.pressed ?? false;
      horn ||= pad.buttons[10]?.pressed ?? false;
      this.padButton(pad, 9, 'KeyP');
      this.padButton(pad, 0, 'Enter');
      this.padButton(pad, 3, 'KeyR');
      break;
    }

    this.drive.steer = steer;
    this.drive.throttle = throttle;
    this.drive.brake = brake;
    this.drive.analog = analog;
    this.drive.boost = boost;
    this.drive.direct = direct;
    this.drive.handbrake = handbrake;
    this.drive.horn = horn;
  }

  /** A key (by KeyboardEvent.code) is held right now. */
  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  private padButton(pad: Gamepad, index: number, code: string): void {
    const down = pad.buttons[index]?.pressed ?? false;
    if (down && !this.padPrev[index]) this.onPress?.(code);
    this.padPrev[index] = down;
  }
}
