import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';
import type { MouseControl } from '../src/core/mouse';
import { inputFromQ, quantizeInput } from '../src/online/protocol';
import { W204Car } from '../src/sim/vehicleW204';
import type { DriveInput } from '../src/sim/vehicle';

afterEach(() => vi.unstubAllGlobals());

const setup = () => {
  const window = new EventTarget();
  const getGamepads = vi.fn<() => Gamepad[]>(() => []);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { getGamepads });
  const input = new Input();
  const key = (code: string, type = 'keydown') => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false }));
  return { input, key, window, getGamepads };
};

describe('driving input', () => {
  it('lets a chat-opening callback suppress the opening Enter default action', () => {
    const { input, key } = setup();
    input.onPress = (code, event) => { if (code === 'Enter') { event?.preventDefault(); input.setEnabled(false); } };
    expect(key('Enter')).toBe(false);
    expect(input.isDown('Enter')).toBe(false);
  });
  it('uses F for the clutch, leaves Ctrl free and keeps Shift boost separate', () => {
    const { input, key } = setup();
    key('ControlLeft'); key('ControlRight');
    input.poll();
    expect(input.drive.clutch).toBe(false);
    key('KeyF'); key('ShiftLeft'); key('KeyW');
    input.poll();
    expect(input.drive.clutch).toBe(true);
    expect(input.drive.boost).toBe(true);
    expect(input.drive.throttle).toBe(1);
    key('KeyF', 'keyup');
    input.poll();
    expect(input.drive.clutch).toBe(false);
    expect(input.drive.boost).toBe(true);
  });

  it('clears held and transient controls on suspension, but retains gearbox and signal settings', () => {
    const { input, key } = setup();
    for (const code of ['KeyD', 'KeyW', 'KeyS', 'KeyF', 'ShiftLeft', 'Space', 'KeyH']) key(code);
    input.drive.manual = true;
    input.drive.blinker = 1;
    input.drive.shift = 1;
    input.poll();
    expect(input.drive.throttle).toBe(1);
    input.setEnabled(false);
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.drive).toMatchObject({ steer: 0, throttle: 0, brake: 0, clutch: false,
      boost: false, handbrake: false, horn: false, analog: false, direct: false, shift: 0,
      manual: true, blinker: 1 });
    input.setEnabled(true);
    input.poll();
    expect(input.drive.throttle).toBe(0);
    expect(input.drive.steer).toBe(0);
    key('KeyW');
    input.poll();
    expect(input.drive.throttle).toBe(1);
  });

  it('ignores keyboard, mouse and gamepad input and callbacks while disabled', () => {
    const { input, key, getGamepads } = setup();
    const press = vi.fn();
    input.onPress = press;
    input.mouse = { active: true, steer: .6, throttle: 1, brake: 1, centre: vi.fn() } as unknown as MouseControl;
    const buttons = Array.from({ length: 11 }, () => ({ pressed: true, value: 1, touched: true }));
    getGamepads.mockReturnValue([{ connected: true, axes: [1], buttons } as unknown as Gamepad]);
    input.setEnabled(false);
    key('KeyW'); key('KeyF'); key('KeyP');
    // Browser defaults still belong to the chat, not the driving-input blocker.
    expect(key('Space')).toBe(true);
    for (let i = 0; i < 3; i++) input.poll();
    expect(press).not.toHaveBeenCalled();
    expect(getGamepads).not.toHaveBeenCalled();
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.drive).toMatchObject({ steer: 0, throttle: 0, brake: 0, clutch: false, boost: false, analog: false, direct: false });
    input.mouse = null;
    getGamepads.mockReturnValue([]);
    input.setEnabled(true);
    input.poll();
    expect(input.drive.throttle).toBe(0);
    expect(input.drive.clutch).toBe(false);
    expect(press).not.toHaveBeenCalled();
  });

  it('resets gamepad edge tracking when disabled and enabled again', () => {
    const { input, getGamepads } = setup();
    const press = vi.fn();
    input.onPress = press;
    const buttons = Array.from({ length: 10 }, (_, i) => ({ pressed: i === 9, value: +(i === 9), touched: false }));
    getGamepads.mockReturnValue([{ connected: true, axes: [0], buttons } as unknown as Gamepad]);
    input.poll(); input.poll();
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenLastCalledWith('KeyP');
    input.setEnabled(false);
    input.poll();
    expect(press).toHaveBeenCalledTimes(1);
    input.setEnabled(true);
    input.poll();
    expect(press).toHaveBeenCalledTimes(2);
  });

  it('does not restore held controls if a keyboard callback opens the chat', () => {
    const { input, key } = setup();
    input.onPress = () => input.setEnabled(false);
    key('KeyW');
    expect(input.isDown('KeyW')).toBe(false);
    input.poll();
    expect(input.drive.throttle).toBe(0);
  });

  it('stops the current poll if a gamepad callback opens the chat', () => {
    const { input, getGamepads } = setup();
    const press = vi.fn(() => input.setEnabled(false));
    input.onPress = press;
    const buttons = Array.from({ length: 11 }, () => ({ pressed: true, value: 1, touched: true }));
    getGamepads.mockReturnValue([{ connected: true, axes: [1], buttons } as unknown as Gamepad]);
    input.poll();
    expect(press).toHaveBeenCalledTimes(1);
    expect(input.drive).toMatchObject({ steer: 0, throttle: 0, brake: 0, handbrake: false, horn: false, boost: false });
    input.poll();
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('leaves held keys alone when an already enabled input is enabled again', () => {
    const { input, key } = setup();
    key('KeyW');
    input.setEnabled(true);
    input.poll();
    expect(input.drive.throttle).toBe(1);
  });

  it('keeps centred gamepad steering unassisted locally and over the wire until keyboard driving resumes', () => {
    const { input, key, getGamepads } = setup();
    const axes = [.8];
    const pad = { connected: true, axes, buttons: [] } as unknown as Gamepad;
    getGamepads.mockReturnValue([pad]);
    input.poll();
    expect(input.drive).toMatchObject({ analog: true, keyboardSteer: false });
    axes[0] = 0;
    input.poll();
    expect(input.drive).toMatchObject({ steer: 0, analog: false, keyboardSteer: false });
    const wire = inputFromQ(quantizeInput(input.drive, { steer: 0, throttle: 0, brake: 0, flags: 0 }), { steer: 0, throttle: 0, brake: 0 });
    const slide = (drive: DriveInput) => {
      const car = new W204Car(); car.reset(0, 0, 25); car.gear = 2; car.vy = -8; car.r = .7;
      car.step(1 / 120, drive, 0);
      return car;
    };
    expect(slide(input.drive).steerAngle).toBe(0);
    const local = slide(input.drive), remote = slide(wire);
    const a = new Float64Array(local.stateSize), b = new Float64Array(remote.stateSize);
    local.saveState(a); remote.saveState(b);
    expect([...b]).toEqual([...a]);
    input.poll(); // a still-connected centred controller must not become keyboard input next frame
    expect(input.drive.keyboardSteer).toBe(false);
    key('KeyW'); input.poll();
    expect(input.drive.keyboardSteer).toBe(true);
    expect(Math.abs(slide(input.drive).steerAngle)).toBeGreaterThan(0);
    getGamepads.mockReturnValue([]); input.poll();
    expect(input.drive.keyboardSteer).toBe(true);
  });

  it('does not activate keyboard rack assistance for a held-centre touch wheel', () => {
    const { input } = setup();
    input.touch.steer = 0; input.poll();
    expect(input.drive).toMatchObject({ steer: 0, analog: true, keyboardSteer: false });
    input.touch.steer = null; input.poll();
    expect(input.drive.keyboardSteer).toBe(false);
  });
});
