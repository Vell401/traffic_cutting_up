import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';
import { TouchControls } from '../src/ui/touchControls';
import { bodyPhysics, createCar } from '../src/sim/physics';
import { DocumentStub, ElementStub, event } from './mobileDom';

let win: EventTarget, doc: DocumentStub, input: Input, touch: TouchControls, root: ElementStub;
let pads: Gamepad[];
beforeEach(() => {
  win = new EventTarget(); doc = new DocumentStub(); pads = [];
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { getGamepads: () => pads });
  input = new Input(); touch = new TouchControls(input, code => input.onPress?.(code));
  root = touch.element as unknown as ElementStub;
  touch.setActive(true);
});
afterEach(() => { touch.dispose(); input.dispose(); vi.unstubAllGlobals(); });
function down(control: string, pointerId: number, clientX = 100): void {
  event(root.find(control), 'pointerdown', { pointerId, clientX, pointerType: 'touch', button: 0 });
}
function up(pointerId: number, type = 'pointerup'): void { event(win, type, { pointerId }); }
function key(code: string, type = 'keydown', repeat = false): void { event(win, type, { code, repeat }); }

describe('production multitouch and Input composition', () => {
  it('captures simultaneous wheel, pedals, boost, handbrake, clutch; only the released finger clears', () => {
    touch.setManual(true);
    down('steer', 1, 184); down('throttle', 2); down('brake', 3); down('boost', 4); down('handbrake', 5); down('clutch', 6);
    input.poll();
    expect(input.drive).toMatchObject({ steer: 1, throttle: 1, brake: 1, boost: true, handbrake: true, clutch: true, analog: true });
    expect(root.find('throttle').captures.has(2)).toBe(true);
    up(2, 'pointercancel'); input.poll();
    expect(input.drive).toMatchObject({ steer: 1, throttle: 0, brake: 1, boost: true, clutch: true });
    up(1); input.poll(); expect(input.drive.steer).toBe(0);
  });
  it('keeps a pedal held by another pointer and ignores unrelated/late releases', () => {
    down('throttle', 1); down('throttle', 2); up(1); up(999); input.poll();
    expect(input.drive.throttle).toBe(1);
    expect(root.find('throttle').getAttribute('aria-pressed')).toBe('true');
    up(2); input.poll(); expect(input.drive.throttle).toBe(0);
    event(root.find('throttle'), 'pointermove', { pointerId: 2, clientX: 0 });
    input.poll(); expect(input.drive.throttle).toBe(0);
  });
  it('uses the latest wheel finger then restores the still-held earlier one', () => {
    down('steer', 1, 16); down('steer', 2, 184); input.poll(); expect(input.drive.steer).toBe(1);
    up(2); input.poll(); expect(input.drive.steer).toBe(-1);
    event(root.find('steer'), 'pointermove', { pointerId: 1, clientX: 100 });
    input.poll(); expect(input.drive.steer).toBe(0);
  });
  it.each(['blur', 'resize', 'orientationchange', 'pagehide', 'visibility', 'pause', 'unmount', 'capture-loss'])('releases held gas on %s, without a pointerup', reason => {
    down('throttle', 1); down('steer', 2, 184); down('boost', 3);
    if (reason === 'visibility') { doc.hidden = true; event(doc, 'visibilitychange'); }
    else if (reason === 'pause') touch.setActive(false);
    else if (reason === 'unmount') touch.dispose();
    else if (reason === 'capture-loss') {
      for (const [control, pointerId] of [['throttle', 1], ['steer', 2], ['boost', 3]] as const) event(root.find(control), 'lostpointercapture', { pointerId });
    } else event(win, reason);
    input.poll(); expect(input.drive).toMatchObject({ steer: 0, throttle: 0, boost: false });
    expect(root.find('throttle').captures.size).toBe(0);
  });
  it('does not resume a stale finger after pause and ignores presses while inactive', () => {
    down('throttle', 1); touch.setActive(false); down('throttle', 2); touch.setActive(true);
    event(root.find('throttle'), 'pointermove', { pointerId: 1, clientX: 100 });
    input.poll(); expect(input.drive.throttle).toBe(0);
  });
  it('still releases through the window when pointer capture is rejected', () => {
    root.find('throttle').setPointerCapture = () => { throw new Error('detached'); };
    down('throttle', 12); input.poll(); expect(input.drive.throttle).toBe(1);
    up(12, 'pointercancel'); input.poll(); expect(input.drive.throttle).toBe(0);
  });
  it('touch steering owns centre too; pedals max and buttons OR; release restores live keyboard/gamepad', () => {
    key('KeyA'); key('KeyW'); key('ControlLeft'); key('ShiftLeft');
    pads = [{ connected: true, axes: [0.8], buttons: [] } as unknown as Gamepad];
    input.poll(); const padSteer = input.drive.steer;
    down('steer', 1, 100); down('brake', 2); input.poll();
    expect(input.drive).toMatchObject({ steer: 0, throttle: 1, brake: 1, clutch: true, boost: true, analog: true });
    touch.releaseAll(); input.poll(); expect(input.drive.steer).toBe(padSteer);
    pads = []; key('KeyW', 'keyup'); input.poll();
    expect(input.drive).toMatchObject({ steer: -1, throttle: 0, brake: 0 });
  });
  it('preserves keydown onPress-before-held and repeat semantics, Shift boost / Ctrl clutch', () => {
    const presses: boolean[] = [];
    input.onPress = code => presses.push(input.isDown(code));
    key('ShiftLeft'); key('ShiftLeft', 'keydown', true); key('ControlLeft');
    expect(presses).toEqual([false, false]); input.poll();
    expect(input.drive).toMatchObject({ boost: true, clutch: true });
    input.releaseAll(); input.poll(); expect(input.drive).toMatchObject({ boost: false, clutch: false });
  });
  it('hiding manual controls releases a held clutch but leaves gas alone', () => {
    touch.setManual(true); down('clutch', 1); down('throttle', 2); touch.setManual(false); input.poll();
    expect(input.drive).toMatchObject({ clutch: false, throttle: 1 });
  });
  it('routes pause/camera/manual shift as one-shot commands, not synthetic held keys', () => {
    const press = vi.fn(); input.onPress = press; touch.setManual(true);
    (touch.toolbar as unknown as ElementStub).children[0].click();
    (touch.toolbar as unknown as ElementStub).children[1].click();
    const manual = root.children[root.children.length - 1];
    manual.children[1].click(); manual.children[2].click();
    expect(press.mock.calls.flat()).toEqual(['KeyP', 'KeyV', 'KeyZ', 'KeyX']);
    expect(input.isDown('KeyX')).toBe(false);
  });
  it('does not remap any body physics or reverse pedal: same raw input for all four cars', () => {
    expect([1, 2, 3, 4].map(id => bodyPhysics(id as 1 | 2 | 3 | 4))).toEqual([4, 2, 3, 5]);
    down('brake', 1); input.poll(); expect(input.drive).toMatchObject({ throttle: 0, brake: 1 });
    const pedal = { ...input.drive };
    touch.releaseAll(); key('KeyS'); input.poll();
    expect(input.drive).toEqual(pedal);
    for (const body of [1, 2, 3, 4] as const) {
      const car = createCar(bodyPhysics(body)), keyboard = createCar(bodyPhysics(body));
      car.reset(0, 0, 0); keyboard.reset(0, 0, 0);
      for (let i = 0; i < 240; i++) { car.step(1 / 120, pedal, 0); keyboard.step(1 / 120, input.drive, 0); }
      const a = new Float64Array(car.stateSize), b = new Float64Array(keyboard.stateSize);
      car.saveState(a); keyboard.saveState(b);
      expect([...a]).toEqual([...b]);
      expect(car.physicsId).toBe(bodyPhysics(body));
    }
  });
});
