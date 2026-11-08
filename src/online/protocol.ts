import type { DriveInput } from '../sim/vehicle';
import type { TrafficCar } from '../sim/traffic';
import type { CarId } from '../sim/cars';
import type { PhysicsId } from '../sim/physics';
import type { OnlineRules } from './rules';
import type { GlobalTuning } from '../sim/tuning';

/*
 * Wire format.
 *
 * Control messages are JSON text frames (rare). The two hot ones are binary, little-endian:
 *   client → server  INPUT     the driver's inputs, one per 120 Hz step, numbered by `seq`
 *   server → client  SNAPSHOT  30 per second: the server tick, the last input seq the server applied
 *                              for this driver (ack) and the car state after it, the score, the other
 *                              drivers and the traffic around the car.
 *
 * Inputs are quantized before the client uses them, so its prediction runs on exactly the numbers the
 * server will run on.
 */

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

/** Most inputs one INPUT message carries. */
export const MAX_INPUT_BATCH = 120;

// ------------------------------------------------------------------------- JSON messages

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  physics: PhysicsId;
  /** Body model (cosmetic). */
  car: CarId;
  /** Spawn place (0-based) the driver owns. */
  slot: number;
  score: number;
  best: number;
  /** On the road, away (no input) or disconnected (slot kept for a reconnect). */
  state: 'active' | 'away' | 'offline';
}

export type ClientMsg =
  /** seq: the client's last input number (0 for a fresh page): its next inputs follow it. */
  | { t: 'hello'; v: number; rules: string; name: string; physics: PhysicsId; car: CarId; seq: number; token?: string; color?: number }
  | { t: 'respawn' }
  | { t: 'ping'; c: number };

export type ServerMsg =
  | { t: 'welcome'; id: number; token: string; rules: OnlineRules; tick: number; ringLen: number; players: PlayerInfo[]; tuning?: GlobalTuning }
  | { t: 'tuning'; tuning: GlobalTuning }
  | { t: 'reject'; reason: 'full' | 'version' | 'rules' | 'bad' | 'kicked' | 'banned'; text: string }
  | { t: 'players'; list: PlayerInfo[] }
  | { t: 'ev'; name: string; data: Record<string, unknown> }
  | { t: 'feed'; text: string }
  /** A message from the admin page: a banner on every screen (menus too). */
  | { t: 'announce'; text: string }
  | { t: 'mode'; mode: string; label: string }
  | { t: 'pong'; c: number; tick: number };

// ------------------------------------------------------------------------- binary helpers

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  pos = 0;

  constructor(size = 4096) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private room(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
  }

  u8(v: number): void {
    this.room(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  i8(v: number): void {
    this.room(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
  }
  u16(v: number): void {
    this.room(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  i16(v: number): void {
    this.room(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /** A copy of what was written (safe to hand to a socket while the writer is reused). */
  bytes(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }
}

export class Reader {
  private view: DataView;
  pos = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }

  get left(): number {
    return this.view.byteLength - this.pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : Math.round(v));

// ------------------------------------------------------------------------- inputs

/** Input flag bits. A shift request sits in exactly one input, so both sides shift on the same step. */
export const IN_ANALOG = 1;
export const IN_MANUAL = 2;
export const IN_SHIFT_UP = 4;
export const IN_SHIFT_DOWN = 8;
export const IN_BLINK_LEFT = 16;
export const IN_BLINK_RIGHT = 32;
export const IN_BOOST = 64;
export const IN_DIRECT = 128;
export const IN_HANDBRAKE = 256;
export const IN_HORN = 512;
export const IN_TC_ON = 1024;
export const IN_ESP_ON = 2048;
export const IN_ASSIST_STATE = 4096;
export const IN_CLUTCH = 8192;
export const IN_ASSIST_AND_CLUTCH = 16384;
/** Every input flag bit a client may set (the server masks the rest off). */
export const IN_ALL = 32767;

/** Bytes of one input step in an INPUT message. */
export const INPUT_BYTES = 6;

/** Integer form of one input step: steer -32767..32767, pedals 0..255, flags (IN_*, 16 bits). */
export interface InputQ {
  steer: number;
  throttle: number;
  brake: number;
  flags: number;
}

export function quantizeInput(inp: DriveInput, out: InputQ): InputQ {
  out.steer = clampInt((Number.isFinite(inp.steer) ? inp.steer : 0) * 32767, -32767, 32767);
  out.throttle = clampInt((Number.isFinite(inp.throttle) ? inp.throttle : 0) * 255, 0, 255);
  out.brake = clampInt((Number.isFinite(inp.brake) ? inp.brake : 0) * 255, 0, 255);
  const shift = inp.shift ?? 0;
  out.flags =
    (inp.analog ? IN_ANALOG : 0) |
    (inp.manual ? IN_MANUAL : 0) |
    (shift > 0 ? IN_SHIFT_UP : shift < 0 ? IN_SHIFT_DOWN : 0) |
    (inp.blinker === 1 ? IN_BLINK_LEFT : inp.blinker === 2 ? IN_BLINK_RIGHT : 0) |
    (inp.boost ? IN_BOOST : 0) |
    (inp.direct ? IN_DIRECT : 0) |
    (inp.handbrake ? IN_HANDBRAKE : 0) |
    (inp.horn ? IN_HORN : 0) |
    (inp.tractionControlEnabled !== undefined || inp.espEnabled !== undefined ? IN_ASSIST_STATE : 0) |
    (inp.clutch !== undefined ? IN_ASSIST_AND_CLUTCH : 0) |
    (inp.tractionControlEnabled === true ? IN_TC_ON : 0) |
    (inp.espEnabled === true ? IN_ESP_ON : 0);
  if (inp.clutch) out.flags |= IN_CLUTCH;
  return out;
}

/** The DriveInput both sides step with for a quantized input. */
export function inputFromQ(q: InputQ, out: DriveInput): DriveInput {
  out.steer = q.steer / 32767;
  out.throttle = q.throttle / 255;
  out.brake = q.brake / 255;
  out.analog = (q.flags & IN_ANALOG) !== 0;
  out.manual = (q.flags & IN_MANUAL) !== 0;
  out.shift = q.flags & IN_SHIFT_UP ? 1 : q.flags & IN_SHIFT_DOWN ? -1 : 0;
  out.blinker = q.flags & IN_BLINK_LEFT ? 1 : q.flags & IN_BLINK_RIGHT ? 2 : 0;
  out.boost = (q.flags & IN_BOOST) !== 0;
  out.direct = (q.flags & IN_DIRECT) !== 0;
  out.handbrake = (q.flags & IN_HANDBRAKE) !== 0;
  out.horn = (q.flags & IN_HORN) !== 0;
  if (q.flags & IN_ASSIST_AND_CLUTCH) out.clutch = (q.flags & IN_CLUTCH) !== 0;
  if (q.flags & IN_ASSIST_STATE) {
    out.tractionControlEnabled = (q.flags & IN_TC_ON) !== 0;
    out.espEnabled = (q.flags & IN_ESP_ON) !== 0;
  }
  return out;
}

/** INPUT: u8 kind, u32 first seq, u8 count, count × (i16 steer, u8 throttle, u8 brake, u16 flags). */
export function writeInputs(w: Writer, firstSeq: number, inputs: readonly InputQ[], from: number, count: number): void {
  w.u8(MSG_INPUT);
  w.u32(firstSeq);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    const q = inputs[from + i];
    w.i16(q.steer);
    w.u8(q.throttle);
    w.u8(q.brake);
    w.u16(q.flags);
  }
}

/** Parse an INPUT message (kind byte already read). Returns null on a malformed message. */
export function readInputs(r: Reader, out: InputQ[]): { firstSeq: number; count: number } | null {
  if (r.left < 5) return null;
  const firstSeq = r.u32();
  const count = r.u8();
  if (count === 0 || count > MAX_INPUT_BATCH || r.left !== count * INPUT_BYTES) return null;
  for (let i = 0; i < count; i++) {
    const q = (out[i] ??= { steer: 0, throttle: 0, brake: 0, flags: 0 });
    q.steer = Math.max(-32767, r.i16());
    q.throttle = r.u8();
    q.brake = r.u8();
    q.flags = r.u16() & IN_ALL;
  }
  return { firstSeq, count };
}

// ------------------------------------------------------------------------- snapshot

export const OWN_GHOST = 1;
export const OWN_AWAY = 2;
export const REMOTE_GHOST = 1;
export const REMOTE_BRAKE = 2;
export const REMOTE_BLINK_LEFT = 4;
export const REMOTE_BLINK_RIGHT = 8;
export const REMOTE_HORN = 16;

export interface SnapScore {
  score: number;
  best: number;
  combo: number;
  comboT: number;
  mult: number;
  near: number;
  runTime: number;
  topKmh: number;
}

export interface SnapDriver {
  id: number;
  flags: number;
  s: number;
  d: number;
  psi: number;
  vx: number;
  vy: number;
  r: number;
  steer: number;
  gear: number;
}

export interface SnapCar {
  id: number;
  gen: number;
  spec: number;
  colorIdx: number;
  color2Idx: number;
  s: number;
  d: number;
  v: number;
  acc: number;
  yaw: number;
  yawRate: number;
  vd: number;
  /** Lane change progress 0..1, -1 when not changing. */
  laneT: number;
  targetLane: number;
  laneOff: number;
  laneFromD: number;
  blink: number;
  braking: boolean;
  crashed: boolean;
}

/** One decoded snapshot. The decoder reuses it (and its arrays) for the next one. */
export interface Snapshot {
  tick: number;
  ack: number;
  epoch: number;
  queue: number;
  flags: number;
  physics: number;
  state: Float64Array;
  stateLen: number;
  score: SnapScore;
  drivers: SnapDriver[];
  driverCount: number;
  cars: SnapCar[];
  carCount: number;
}

export interface SnapshotOwn {
  tick: number;
  ack: number;
  epoch: number;
  queue: number;
  flags: number;
  physics: number;
  state: Float64Array;
  stateLen: number;
  score: SnapScore;
}

const wrapPi = (a: number): number => {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Header, own car and score. Remote drivers and cars follow (writeDriver / writeCar after a count). */
export function writeSnapshotHead(w: Writer, own: SnapshotOwn): void {
  w.u8(MSG_SNAPSHOT);
  w.u32(own.tick);
  w.u32(own.ack);
  w.u16(own.epoch & 0xffff);
  w.u8(Math.min(255, own.queue));
  w.u8(own.flags);
  w.u8(own.physics);
  w.u8(own.stateLen);
  for (let i = 0; i < own.stateLen; i++) w.f64(own.state[i]);
  const sc = own.score;
  w.f64(sc.score);
  w.f64(sc.best);
  w.u16(Math.min(65535, sc.combo));
  w.f32(sc.comboT);
  w.f32(sc.mult);
  w.u16(Math.min(65535, sc.near));
  w.f32(sc.runTime);
  w.f32(sc.topKmh);
}

export function writeDriver(w: Writer, id: number, flags: number, s: number, d: number, psi: number, vx: number, vy: number, r: number, steer: number, gear: number): void {
  w.u8(id);
  w.u8(flags);
  w.f32(s);
  w.f32(d);
  w.f32(psi);
  w.f32(vx);
  w.f32(vy);
  w.f32(r);
  w.i8(clampInt(steer * 127, -127, 127));
  w.u8(gear === -1 ? 255 : gear);
}

/** 26 bytes per traffic car. */
export function writeCar(w: Writer, c: TrafficCar, specIndex: number): void {
  w.u16(c.id);
  w.u8(c.gen & 0xff);
  w.u8(specIndex);
  w.u8(c.colorIdx);
  w.i8(c.color2Idx);
  w.f32(c.s);
  w.i16(clampInt(c.d * 1000, -32767, 32767));
  w.u16(clampInt(c.v * 100, 0, 65535));
  w.i8(clampInt(c.acc * 10, -127, 127));
  w.i16(clampInt(wrapPi(c.yaw) * 10000, -32767, 32767));
  w.i16(clampInt(c.yawRate * 1000, -32767, 32767));
  w.i16(clampInt(c.vd * 1000, -32767, 32767));
  w.u8(c.laneT < 0 ? 255 : clampInt(c.laneT * 250, 0, 250));
  const blink = c.blink === -1 ? 1 : c.blink === 1 ? 2 : c.blink === 2 ? 3 : 0;
  w.u8((c.targetLane & 15) | (blink << 4) | (c.braking ? 64 : 0) | (c.crashed ? 128 : 0));
  w.i16(clampInt(c.laneFromD * 1000, -32767, 32767));
  w.i8(clampInt(c.laneOff * 100, -127, 127));
}

export function newSnapshot(): Snapshot {
  return {
    tick: 0,
    ack: 0,
    epoch: 0,
    queue: 0,
    flags: 0,
    physics: 1,
    state: new Float64Array(64),
    stateLen: 0,
    score: { score: 0, best: 0, combo: 0, comboT: 0, mult: 1, near: 0, runTime: 0, topKmh: 0 },
    drivers: [],
    driverCount: 0,
    cars: [],
    carCount: 0,
  };
}

/** Decode a SNAPSHOT (kind byte already read) into `out`. Returns false on a malformed message. */
export function readSnapshot(r: Reader, out: Snapshot): boolean {
  if (r.left < 16) return false;
  out.tick = r.u32();
  out.ack = r.u32();
  out.epoch = r.u16();
  out.queue = r.u8();
  out.flags = r.u8();
  out.physics = r.u8();
  out.stateLen = r.u8();
  if (out.stateLen > out.state.length || r.left < out.stateLen * 8 + 39) return false; // state, 36 B score, driver and car counts
  for (let i = 0; i < out.stateLen; i++) out.state[i] = r.f64();
  const sc = out.score;
  sc.score = r.f64();
  sc.best = r.f64();
  sc.combo = r.u16();
  sc.comboT = r.f32();
  sc.mult = r.f32();
  sc.near = r.u16();
  sc.runTime = r.f32();
  sc.topKmh = r.f32();

  const nd = r.u8();
  if (r.left < nd * 26 + 2) return false;
  for (let i = 0; i < nd; i++) {
    const d = (out.drivers[i] ??= { id: 0, flags: 0, s: 0, d: 0, psi: 0, vx: 0, vy: 0, r: 0, steer: 0, gear: 1 });
    d.id = r.u8();
    d.flags = r.u8();
    d.s = r.f32();
    d.d = r.f32();
    d.psi = r.f32();
    d.vx = r.f32();
    d.vy = r.f32();
    d.r = r.f32();
    d.steer = r.i8() / 127;
    const gear = r.u8();
    d.gear = gear === 255 ? -1 : gear;
  }
  out.driverCount = nd;

  const nc = r.u16();
  if (r.left !== nc * 26) return false;
  for (let i = 0; i < nc; i++) {
    const c = (out.cars[i] ??= {
      id: 0, gen: 0, spec: 0, colorIdx: 0, color2Idx: -1, s: 0, d: 0, v: 0, acc: 0, yaw: 0, yawRate: 0, vd: 0,
      laneT: -1, targetLane: 0, laneFromD: 0, laneOff: 0, blink: 0, braking: false, crashed: false,
    });
    c.id = r.u16();
    c.gen = r.u8();
    c.spec = r.u8();
    c.colorIdx = r.u8();
    c.color2Idx = r.i8();
    c.s = r.f32();
    c.d = r.i16() / 1000;
    c.v = r.u16() / 100;
    c.acc = r.i8() / 10;
    c.yaw = r.i16() / 10000;
    c.yawRate = r.i16() / 1000;
    c.vd = r.i16() / 1000;
    const lt = r.u8();
    c.laneT = lt === 255 ? -1 : lt / 250;
    const bits = r.u8();
    c.targetLane = bits & 15;
    const blink = (bits >> 4) & 3;
    c.blink = blink === 1 ? -1 : blink === 2 ? 1 : blink === 3 ? 2 : 0;
    c.braking = (bits & 64) !== 0;
    c.crashed = (bits & 128) !== 0;
    c.laneFromD = r.i16() / 1000;
    c.laneOff = r.i8() / 100;
  }
  out.carCount = nc;
  return true;
}
