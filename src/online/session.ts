import type { CarId } from '../sim/cars';
import type { PhysicsId } from '../sim/physics';
import type { DriveInput } from '../sim/vehicle';
import type { Sim } from '../sim/world';
import { ClientCore } from './clientCore';
import { Link, type LinkConditions } from './link';
import type { PlayerInfo } from './protocol';

export type OnlineState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed';

const TOKEN_KEY = 'tcu.online.token';
const RETRY_MS = [500, 1000, 2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000];

const loadToken = (): string | undefined => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (t: string): void => {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* no storage: a reload joins as a new driver */
  }
};

export interface SessionHooks {
  onState(state: OnlineState, text: string): void;
  onPlayers(list: PlayerInfo[]): void;
  onFeed(text: string): void;
  onAnnounce(text: string): void;
  onTeleport(): void;
}

/**
 * Browser side of an online session: the socket (with reconnects), the prediction core and the
 * session token. A reload of the tab within the server's reconnect window comes back to the same car
 * and score (the token lives in sessionStorage).
 */
export class OnlineSession {
  readonly core: ClientCore;
  state: OnlineState = 'idle';
  private link: Link | null = null;
  private attempts = 0;
  private name = '';
  private physics: PhysicsId = 1;
  private car: CarId = 1;
  private color: number | undefined;
  private retryTimer = 0;
  private rejected = false;

  constructor(
    sim: Sim,
    private readonly url: string,
    private readonly conditions: LinkConditions,
    private readonly hooks: SessionHooks,
  ) {
    this.core = new ClientCore(sim, {
      send: (d) => this.link?.send(d),
      onTeleport: () => hooks.onTeleport(),
      onPlayers: (list) => hooks.onPlayers(list),
      onFeed: (text) => hooks.onFeed(text),
      onAnnounce: (text) => hooks.onAnnounce(text),
      onWelcome: (msg) => {
        saveToken(msg.token);
        this.attempts = 0;
        this.setState('joined', '');
      },
      onReject: (text) => {
        this.rejected = true;
        this.setState('failed', text);
      },
    });
  }

  start(name: string, physics: PhysicsId, car: CarId, color?: number): void {
    this.name = name;
    this.physics = physics;
    this.car = car;
    this.color = color;
    this.rejected = false;
    this.connect();
  }

  private setState(state: OnlineState, text: string): void {
    this.state = state;
    this.hooks.onState(state, text);
  }

  private connect(): void {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', this.attempts === 0 ? 'Подключение…' : 'Связь потеряна — переподключение…');
    let link: Link;
    try {
      link = new Link(this.url, this.conditions);
    } catch {
      this.setState('failed', 'Неверный адрес сервера');
      return;
    }
    this.link = link;
    link.onOpen = () => this.core.hello(this.name, this.physics, this.car, this.core.token || loadToken(), this.color);
    link.onMessage = (d) => this.core.receive(d, performance.now());
    link.onClose = () => this.lost();
  }

  private lost(): void {
    this.link = null;
    this.core.disconnected();
    if (this.rejected || this.state === 'idle') return;
    const wasJoined = this.state === 'joined' || this.state === 'reconnecting';
    if (!wasJoined && this.attempts === 0) {
      this.setState('failed', 'Сервер не отвечает');
      return;
    }
    if (this.attempts >= RETRY_MS.length) {
      this.setState('failed', 'Не удалось восстановить связь с сервером');
      return;
    }
    const wait = RETRY_MS[this.attempts++];
    this.setState('reconnecting', 'Связь потеряна — переподключение…');
    this.retryTimer = window.setTimeout(() => this.connect(), wait);
  }

  requestRespawn(): void {
    if (this.state === 'joined') this.core.requestRespawn();
  }

  /** One 120 Hz step of our car. */
  step(input: DriveInput): void {
    this.core.step(input);
  }

  /** Per rendered frame: smoothing, sending inputs, pings. */
  frame(dt: number): void {
    if (this.link?.open) this.core.frame(dt, performance.now());
  }

  leave(): void {
    this.state = 'idle';
    window.clearTimeout(this.retryTimer);
    this.link?.close();
    this.link = null;
  }
}
