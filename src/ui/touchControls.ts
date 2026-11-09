import type { Input } from '../core/input';

type Hold = 'steer' | 'throttle' | 'brake' | 'handbrake' | 'boost' | 'clutch';
interface Finger { control: Hold; element: HTMLElement; steer: number }

/** DOM controls own pointer lifetimes; Input owns device composition. No synthetic held keys. */
export class TouchControls {
  readonly element = document.createElement('section');
  readonly toolbar = document.createElement('div');
  private readonly readout = document.createElement('output');
  private readonly manual = document.createElement('div');
  private readonly fingers = new Map<number, Finger>();
  private readonly listeners = new AbortController();
  private active = false;

  constructor(private readonly input: Input, press: (code: string) => void) {
    const root = this.element;
    root.id = 'touchControls';
    root.setAttribute('aria-label', 'Управление автомобилем');
    root.hidden = true;
    this.toolbar.className = 'touch-toolbar';
    this.action(this.toolbar, 'Пауза', 'KeyP', press);
    this.action(this.toolbar, 'Камера', 'KeyV', press);
    this.readout.className = 'touch-readout';
    this.readout.setAttribute('aria-label', 'Скорость и передача');
    this.toolbar.append(this.readout);
    root.append(this.toolbar);
    const wheel = document.createElement('div');
    wheel.className = 'touch-wheel-group';
    this.hold(wheel, 'steer', '◀   РУЛЬ   ▶', 'Руль: ведите палец влево или вправо');
    const aux = document.createElement('div');
    aux.className = 'touch-aux';
    this.hold(aux, 'handbrake', 'Ручник');
    this.hold(aux, 'boost', 'Нитро');
    wheel.append(aux);
    const pedals = document.createElement('div');
    pedals.className = 'touch-pedals';
    this.hold(pedals, 'brake', 'Тормоз / R', 'Тормоз / задний ход');
    this.hold(pedals, 'throttle', 'ГАЗ');
    this.manual.className = 'touch-manual';
    this.manual.hidden = true;
    this.hold(this.manual, 'clutch', 'Сцепл.');
    this.action(this.manual, '−', 'KeyZ', press, 'Передача вниз');
    this.action(this.manual, '+', 'KeyX', press, 'Передача вверх');
    root.append(wheel, pedals, this.manual);
    const signal = this.listeners.signal;
    window.addEventListener('pointerup', e => this.release(e.pointerId), { signal });
    window.addEventListener('pointercancel', e => this.release(e.pointerId), { signal });
    window.addEventListener('blur', () => this.releaseAll(), { signal });
    window.addEventListener('resize', () => this.releaseAll(), { signal });
    window.addEventListener('orientationchange', () => this.releaseAll(), { signal });
    window.addEventListener('pagehide', () => this.releaseAll(), { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); }, { signal });
    root.addEventListener('contextmenu', e => e.preventDefault(), { signal });
    document.body.append(root);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.element.hidden = !active;
    if (!active) this.releaseAll();
  }

  setManual(manual: boolean): void {
    if (this.manual.hidden === !manual) return;
    this.manual.hidden = !manual;
    // Hiding a held clutch must release its capture, not just its appearance.
    for (const [id, finger] of this.fingers) if (finger.control === 'clutch') this.release(id);
  }

  update(speed: string, gear: string): void {
    const text = `${speed} км/ч · ${gear}`;
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  releaseAll(): void {
    for (const id of [...this.fingers.keys()]) this.release(id);
    this.input.releaseTouch();
  }

  dispose(): void {
    this.setActive(false);
    this.releaseAll();
    this.listeners.abort();
    this.element.remove();
  }

  private action(parent: HTMLElement, label: string, code: string, press: (code: string) => void, aria = label): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', aria);
    button.addEventListener('click', () => { if (this.active) press(code); button.blur(); }, { signal: this.listeners.signal });
    parent.append(button);
  }

  private hold(parent: HTMLElement, control: Hold, label: string, aria = label): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.touch = control;
    button.textContent = label;
    button.setAttribute('aria-label', aria);
    button.setAttribute('aria-pressed', 'false');
    const signal = this.listeners.signal;
    button.addEventListener('pointerdown', e => {
      if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault(); // no compatibility mousedown, focus or browser pan/zoom
      const finger: Finger = { control, element: button, steer: 0 };
      this.fingers.set(e.pointerId, finger);
      try { button.setPointerCapture(e.pointerId); } catch { /* global up/cancel still releases */ }
      this.move(finger, e.clientX);
      this.sync();
    }, { signal });
    button.addEventListener('pointermove', e => {
      const finger = this.fingers.get(e.pointerId);
      if (!finger || finger.element !== button) return;
      this.move(finger, e.clientX);
      this.sync();
    }, { signal });
    button.addEventListener('lostpointercapture', e => this.release(e.pointerId), { signal });
    parent.append(button);
  }

  private move(finger: Finger, x: number): void {
    if (finger.control !== 'steer') return;
    const rect = finger.element.getBoundingClientRect();
    const value = Math.max(-1, Math.min(1, (x - rect.left - rect.width / 2) / (rect.width * 0.42 || 1)));
    finger.steer = Math.abs(value) < 0.08 ? 0 : value;
  }

  private release(id: number): void {
    const finger = this.fingers.get(id);
    if (!finger) return;
    this.fingers.delete(id); // delete first: releasePointerCapture can synchronously emit lost capture
    try { if (finger.element.hasPointerCapture(id)) finger.element.releasePointerCapture(id); } catch { /* already detached */ }
    finger.element.setAttribute('aria-pressed', 'false');
    this.sync();
  }

  private sync(): void {
    this.input.releaseTouch();
    for (const finger of this.fingers.values()) {
      if (finger.control === 'steer') this.input.touch.steer = finger.steer; // latest finger owns steering
      else if (finger.control === 'throttle' || finger.control === 'brake') this.input.touch[finger.control] = 1;
      else this.input.touch[finger.control] = true;
      finger.element.setAttribute('aria-pressed', 'true');
    }
  }
}
