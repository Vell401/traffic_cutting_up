import type { DriveInput } from '../sim/vehicle';
import type { MouseControl } from './mouse';
import { isMenuControl } from '../ui/menuInput';

/** Keys whose browser default (scrolling, F1 help) must not fire. */
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1']);
const DEADZONE = 0.12;
const DRIVING_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** null steering means no finger owns the wheel (a held centre is deliberately different). */
export interface TouchInput {
  steer: number | null;
  throttle: number;
  brake: number;
  clutch: boolean;
  boost: boolean;
  handbrake: boolean;
}

/** Keyboard (layout independent, by KeyboardEvent.code), gamepad and independent touch source. */
export class Input {
  readonly drive: DriveInput = { steer: 0, throttle: 0, brake: 0, analog: false, boost: false };
  /** Fired once per key press (no auto-repeat). Gamepad buttons are mapped to key codes. */
  onPress: ((code: string, event?: KeyboardEvent) => void) | null = null;

  /** Mouse steering and pedals, when the player drives with the mouse. */
  mouse: MouseControl | null = null;
  readonly touch: TouchInput = { steer: null, throttle: 0, brake: 0, clutch: false, boost: false, handbrake: false };
  private readonly keys = new Set<string>();
  private padPrev: boolean[] = [];
  private readonly listeners = new AbortController();
  private enabled = true;
  private steeringDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';

  constructor() {
    const signal = this.listeners.signal;
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // Space must still activate a focused native button/summary instead of becoming a handbrake shortcut.
      if (BLOCK.has(e.code) && !(e.code === 'Space' && isMenuControl(e.target))) e.preventDefault();
      if (DRIVING_KEYS.has(e.code)) this.steeringDevice = 'keyboard';
      if (!e.repeat) this.onPress?.(e.code, e);
      if (this.enabled) this.keys.add(e.code);
    }, { signal });
    // UI sliders stop keydown propagation; releases must still clear keys held before opening a menu.
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), { capture: true, signal });
    window.addEventListener('blur', () => this.releaseAll(), { signal });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); }, { signal });
  }

  releaseTouch(): void {
    Object.assign(this.touch, { steer: null, throttle: 0, brake: 0, clutch: false, boost: false, handbrake: false });
  }

  /** Menus/lifecycle boundaries must never carry a held pedal into the next drive. */
  releaseAll(): void {
    this.keys.clear();
    this.releaseTouch();
    if (this.mouse) { this.mouse.throttle = this.mouse.brake = 0; this.mouse.centre(); }
    this.clearDrive();
  }

  dispose(): void {
    this.listeners.abort();
    this.releaseAll();
  }

  /** Suspend driving while a text field owns input; held controls must not leak across the change. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.releaseAll();
    this.padPrev = [];
    this.clearDrive();
  }

  poll(): void {
    if (!this.enabled) {
      this.clearDrive();
      return;
    }
    const k = this.keys;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let clutch = k.has('KeyF');
    let boost = k.has('ShiftLeft') || k.has('ShiftRight');
    let handbrake = k.has('Space');
    let horn = k.has('KeyH');
    let analog = false;
    let direct = false;
    const keyboardDriving = steer !== 0 || throttle > 0 || brake > 0;

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
    let padConnected = false;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      padConnected = true;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) {
        steer = Math.sign(ax) * Math.pow((Math.abs(ax) - DEADZONE) / (1 - DEADZONE), 1.6);
        analog = true;
        direct = false;
        this.steeringDevice = 'gamepad';
      } else if (!keyboardDriving && (pad.buttons[7]?.value > 0 || pad.buttons[6]?.value > 0 || pad.buttons[1]?.pressed)) {
        this.steeringDevice = 'gamepad';
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
    if (!padConnected && this.steeringDevice === 'gamepad') this.steeringDevice = 'keyboard';

    // Steering priority: a captured touch wheel (including centre), then the existing gamepad /
    // keyboard / mouse rules above. Pedals take max, held buttons OR: one source cannot release
    // another, and releasing touch immediately restores the other device's live value.
    const touch = this.touch;
    if (touch.steer !== null) {
      steer = Math.max(-1, Math.min(1, touch.steer));
      analog = true;
      direct = false;
      this.steeringDevice = 'touch';
    }
    if (!keyboardDriving && (touch.throttle > 0 || touch.brake > 0 || touch.handbrake)) this.steeringDevice = 'touch';
    throttle = Math.max(throttle, touch.throttle);
    brake = Math.max(brake, touch.brake);
    clutch ||= touch.clutch;
    boost ||= touch.boost;
    handbrake ||= touch.handbrake;

    // A gamepad onPress callback may have just opened the chat and suspended this very poll.
    if (!this.enabled) {
      this.clearDrive();
      return;
    }
    this.drive.steer = steer;
    this.drive.throttle = throttle;
    this.drive.brake = brake;
    this.drive.analog = analog;
    this.drive.keyboardSteer = !analog && !direct && this.steeringDevice === 'keyboard';
    this.drive.boost = boost;
    this.drive.clutch = clutch;
    this.drive.direct = direct;
    this.drive.handbrake = handbrake;
    this.drive.horn = horn;
  }

  /** A key (by KeyboardEvent.code) is held right now. */
  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  private clearDrive(): void {
    this.drive.steer = this.drive.throttle = this.drive.brake = 0;
    this.drive.analog = this.drive.direct = false;
    this.drive.keyboardSteer = false;
    this.drive.boost = this.drive.clutch = this.drive.handbrake = this.drive.horn = false;
    this.drive.shift = 0;
  }

  private padButton(pad: Gamepad, index: number, code: string): void {
    if (!this.enabled) return;
    const down = pad.buttons[index]?.pressed ?? false;
    const pressed = down && !this.padPrev[index];
    this.padPrev[index] = down;
    if (pressed) this.onPress?.(code);
  }
}
