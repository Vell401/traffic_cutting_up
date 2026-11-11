import type { CarId } from '../sim/cars';
import type { PhysicsId } from '../sim/physics';
import type { DriveInput } from '../sim/vehicle';
import type { Sim } from '../sim/world';
import { ClientCore } from './clientCore';
import { Link, onlineTokenKey, type LinkConditions } from './link';
import type { ChatMessage, ClientMsg, PlayerInfo } from './protocol';

export type OnlineState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed';

const RETRY_MS = [500, 1000, 2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000];

const loadToken = (key: string): string | undefined => {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (key: string, t: string): void => {
  try {
    sessionStorage.setItem(key, t);
  } catch {
    /* no storage: a reload joins as a new driver */
  }
};
const clearToken = (key: string): void => {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* no storage */
  }
};

export interface SessionHooks {
  onState(state: OnlineState, text: string): void;
  onPlayers(list: PlayerInfo[]): void;
  onFeed(text: string): void;
  onChat?(message: ChatMessage): void;
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
  private readonly tokenKey: string;
  private left = false;

  constructor(
    sim: Sim,
    private readonly url: string,
    private readonly conditions: LinkConditions,
    private readonly hooks: SessionHooks,
  ) {
    this.tokenKey = onlineTokenKey(url, sim.map.id);
    this.core = new ClientCore(sim, {
      send: (d) => this.link?.send(d),
      onTeleport: () => hooks.onTeleport(),
      onPlayers: (list) => {
        this.rememberCar(list);
        hooks.onPlayers(list);
      },
      onFeed: (text) => hooks.onFeed(text),
      onChat: (message) => hooks.onChat?.(message),
      onAnnounce: (text) => hooks.onAnnounce(text),
      onWelcome: (msg) => {
        this.rememberCar(msg.players);
        saveToken(this.tokenKey, msg.token);
        this.attempts = 0;
        this.setState('joined', '');
      },
      onReject: (text) => {
        this.rejected = true;
        this.link?.close();
        this.setState('failed', text);
      },
    });
  }

  start(name: string, physics: PhysicsId, car: CarId, color?: number): void {
    if (this.link || this.state !== 'idle' || this.core.id !== 0) this.leave();
    this.left = false;
    window.clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.name = name;
    this.physics = physics;
    this.car = car;
    this.color = color;
    this.rejected = false;
    this.connect();
  }

  private rememberCar(players: PlayerInfo[]): void {
    const own = players.find((p) => p.id === this.core.id);
    if (!own) return;
    this.car = own.car;
    this.physics = own.physics;
    this.color = own.color;
  }

  private setState(state: OnlineState, text: string): void {
    this.state = state;
    this.hooks.onState(state, text);
  }

  private connect(): void {
    if (this.left) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', this.attempts === 0 ? 'Подключение…' : 'Связь потеряна — переподключение…');
    if (this.left) return;
    let link: Link;
    try {
      link = new Link(this.url, this.conditions);
    } catch {
      this.setState('failed', 'Неверный адрес сервера');
      return;
    }
    this.link = link;
    link.onOpen = () => {
      if (this.link === link) this.core.hello(this.name, this.physics, this.car, this.core.token || loadToken(this.tokenKey), this.color, this.core.id !== 0);
    };
    link.onMessage = (d) => {
      if (this.link === link) this.core.receive(d, performance.now());
    };
    link.onClose = () => {
      if (this.link === link) this.lost();
    };
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

  /** True means sent, not server acceptance (the server also applies its own rate limit). */
  sendChat(text: string): boolean {
    return this.state === 'joined' && this.core.sendChat(text);
  }

  /** Resolves after the new authoritative snapshot, rejects on refusal, disconnect or 10 s timeout. */
  changeCar(car: CarId, color: number): Promise<void> {
    if (this.state !== 'joined') return Promise.reject(new Error('Нет подключения к серверу'));
    return this.core.changeCar(car, color);
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
    if (this.left) return;
    this.left = true;
    this.state = 'idle';
    window.clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.link?.close(JSON.stringify({ t: 'leave' } satisfies ClientMsg));
    this.link = null;
    this.core.dispose();
    clearToken(this.tokenKey);
    this.attempts = 0;
  }
}
