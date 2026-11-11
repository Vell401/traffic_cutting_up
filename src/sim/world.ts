import { laneCenter } from '../config';
import type { CarId } from './cars';
import { Emitter } from '../core/events';
import type { Rng } from '../core/rng';
import { Contacts, type Hit } from './contact';
import { Director } from './director';
import type { SimEvents } from './events';
import { getMap, type MapDefinition, type MapId } from './maps';
import { Road, type RoadScript } from './road';
import { Scoring } from './scoring';
import { Traffic } from './traffic';
import { createCar, type PhysicsId } from './physics';
import type { DriveInput, PlayerCar } from './vehicle';
import { clamp } from '../core/math';

const START_S = 300;
/** Showcase tracks start close to their beginning. */
const SHOWCASE_START_S = 60;
/** The car is brought to a stop this far before a finite track's end barrier. */
const END_STOP_GAP = 14;

export interface SimOptions {
  /** Immutable map selection. Miami solo uses its ring; highway solo stays procedural. */
  map?: MapId;
  /** Start on a finite scripted track (test showcase) instead of the endless road. */
  track?: RoadScript;
  /** Car physics variant (start menu). */
  physics?: PhysicsId;
  /**
   * Online client: the shared 12 km ring, no local traffic. The network code drives the player car,
   * the traffic cars and the other drivers; step() only runs for the menu's attract mode.
   */
  online?: boolean;
}

/** Another online driver, as this client draws it. */
export interface RemoteDriver {
  id: number;
  name: string;
  /** Body paint. */
  color: number;
  /** Body model (cosmetic). */
  carId: CarId;
  /** Display state only (never stepped): s is in this client's road frame. */
  car: PlayerCar;
  visible: boolean;
}

/** Whole simulation: pure TS, no rendering. Stepped at a fixed rate by the game loop. */
export class Sim {
  readonly events = new Emitter<SimEvents>();
  road: Road;
  player: PlayerCar;
  readonly traffic: Traffic;
  readonly score: Scoring;
  readonly director: Director;
  time = 0;
  /** Online: the other drivers (empty in single player). */
  readonly remotes: RemoteDriver[] = [];
  /**
   * Online: offset of the drawn car from the simulated one. When a server correction moves the predicted
   * car, the offset takes the jump and decays, so the car glides to the corrected spot.
   */
  readonly visual = { ds: 0, dd: 0, dpsi: 0 };
  /** Online spawn pad: paint of the driver on each place (null = free) and our own place. */
  readonly spawn = { owners: [] as (number | null)[], mine: -1 };
  readonly online: boolean;
  readonly map: MapDefinition;

  private readonly drivers: PlayerCar[] = [];
  private readonly contacts: Contacts;

  /** The car has been stopped at the end of a finite track. */
  trackEnded = false;

  constructor(
    private readonly rng: Rng = Math.random,
    options: SimOptions = {},
  ) {
    this.online = !!options.online;
    this.map = getMap(options.map ?? 'highway');
    this.player = createCar(options.physics ?? 1);
    this.drivers.push(this.player);
    this.road = new Road(rng, options.track ?? (this.online || this.map.id === 'miami' ? this.map.script : undefined));
    this.director = new Director(rng, this.events);
    this.traffic = new Traffic(rng, this.director);
    this.score = new Scoring(this.events);
    this.contacts = new Contacts(rng);
    this.traffic.ringLen = this.score.ringLen = this.contacts.ringLen = this.road.ringLen;
    this.events.on('runEnd', () => this.director.resetRun());
    const start = options.track ? SHOWCASE_START_S : START_S;
    this.player.reset(start, laneCenter(1), (options.track ? 160 : 100) / 3.6);
    this.road.ensure(start - 300, start + 1700);
    if (this.online) this.traffic.enabled = false;
    this.traffic.reset(this.drivers);
  }

  /** Swap in a finite showcase track and put the car at its start. */
  loadTrack(script: RoadScript, kmh = 160): void {
    this.road = new Road(this.rng, script);
    this.traffic.ringLen = this.score.ringLen = this.contacts.ringLen = this.road.ringLen;
    this.road.ensure(0, SHOWCASE_START_S + 1700);
    this.player.reset(SHOWCASE_START_S, laneCenter(1), kmh / 3.6);
    this.trackEnded = false;
    this.traffic.reset(this.player);
    this.score.resetRun();
  }

  /** Same spot/lane/speed; a solo garage selection ends the old run before replacing its identity. */
  setPhysics(id: PhysicsId, endRun = false): void {
    const old = this.player;
    if (old.physicsId === id) return;
    if (endRun) this.score.endRun();
    const car = createCar(id);
    car.reset(old.s, old.d, Math.max(old.vAlong, 0));
    car.psi = car.prevPsi = old.psi;
    this.player = car;
    this.drivers[0] = car;
  }

  /** Put the car back on a lane at the current spot. Counts as the end of the run. */
  respawn(): void {
    const p = this.player;
    this.score.endRun();
    p.reset(p.s, laneCenter(1), 90 / 3.6);
    this.traffic.clearAround(p.s, 120);
  }

  step(dt: number, input: DriveInput): void {
    const p = this.player;
    this.time += dt;
    this.road.ensure(p.s - 300, p.s + 1700);
    const s0 = p.s;
    input = this.endOfTrack(input);
    p.step(dt, input, this.road.curvature(p.s));
    this.director.step(p.s - s0);
    if (p.wallHit) {
      this.events.emit('wallHit', { speed: p.wallImpact });
      this.score.onWall();
    }
    this.traffic.step(dt, this.drivers);
    this.contacts.collide(p, this.traffic.cars, this.onHit);
    this.score.step(dt, p, this.traffic);
  }

  private readonly endInput: DriveInput = { steer: 0, throttle: 0, brake: 0 };

  /** Near the end of a finite track: take over the pedals and stop smoothly before the barrier. */
  private endOfTrack(input: DriveInput): DriveInput {
    const end = this.road.endS;
    if (end === Infinity) return input;
    const p = this.player;
    const left = end - END_STOP_GAP - p.s;
    this.traffic.limitS = end - 40;
    const v = Math.max(0, p.vAlong);
    if (left > 15 + (v * v) / (2 * 7)) return input;
    const need = (v * v) / (2 * Math.max(left, 0.5));
    this.endInput.steer = input.steer;
    this.endInput.analog = input.analog;
    this.endInput.throttle = 0;
    this.endInput.brake = left <= 0 ? 1 : clamp(need / (p.tune.brakeDecel * 0.9) + 0.15, 0, 1);
    if (!this.trackEnded && v < 0.5) {
      this.trackEnded = true;
      this.events.emit('trackEnd', {});
    }
    return this.endInput;
  }

  private readonly onHit = (h: Hit): void => {
    if (!h.first) return;
    this.events.emit('crash', { speed: h.speed });
    this.score.onCrash();
  };
}
