import { getMap, type MapId } from '../sim/maps';

/*
 * Browser WebSocket with optional simulated network conditions, for testing the netcode by hand:
 *   ?lag=120      round trip added, ms (half each way)
 *   ?jitter=40    extra random delay per message, 0..jitter ms (order is kept, like TCP)
 *   ?stall=0.01   chance per message of a 250 ms stall
 */

export interface LinkConditions {
  lag: number;
  jitter: number;
  stall: number;
}

export function conditionsFromUrl(params: URLSearchParams): LinkConditions {
  const num = (k: string) => Math.max(0, Number(params.get(k)) || 0);
  return { lag: num('lag'), jitter: num('jitter'), stall: Math.min(1, num('stall')) };
}

type Data = ArrayBuffer | Uint8Array | string;

/** In-order delayed delivery. */
class Delay {
  private last = 0;
  constructor(private readonly c: LinkConditions) {}
  run(fn: () => void): void {
    const c = this.c;
    if (c.lag === 0 && c.jitter === 0 && c.stall === 0) {
      fn();
      return;
    }
    const now = performance.now();
    let at = now + c.lag / 2 + Math.random() * c.jitter;
    if (c.stall > 0 && Math.random() < c.stall) at += 250;
    at = Math.max(at, this.last);
    this.last = at;
    setTimeout(fn, at - now);
  }
}

export class Link {
  onOpen: (() => void) | null = null;
  onMessage: ((data: ArrayBuffer | string) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  private readonly ws: WebSocket;
  private readonly out: Delay;
  private readonly inc: Delay;
  private closed = false;

  constructor(url: string, conditions: LinkConditions) {
    this.out = new Delay(conditions);
    this.inc = new Delay(conditions);
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onmessage = (e) => {
      const data = e.data as ArrayBuffer | string;
      this.inc.run(() => {
        if (!this.closed) this.onMessage?.(data);
      });
    };
    this.ws.onclose = (e) => {
      if (this.closed) return;
      this.closed = true;
      this.onClose?.(e.code, e.reason);
    };
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(data: Data): void {
    // Copy: the sender reuses its buffer, and the send may be delayed.
    const payload = typeof data === 'string' ? data : data instanceof Uint8Array ? data.slice() : data;
    this.out.run(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(payload);
    });
  }

  close(): void {
    this.closed = true;
    this.ws.close(1000, 'bye');
  }
}

/** Where the game server is: ?server=, the build-time VITE_ONLINE_URL, or /ws on this site. */
export function serverUrl(params: URLSearchParams, mapId: MapId = 'highway'): string {
  getMap(mapId);
  const fromParam = params.get('server');
  if (fromParam) return fromParam;
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const fromEnv = mapId === 'miami' ? env?.VITE_MIAMI_ONLINE_URL : env?.VITE_ONLINE_URL;
  if (fromEnv) return fromEnv;
  const page = pageLocation();
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}${mapId === 'miami' ? '/miami' : ''}/ws`;
}

function pageLocation(): { protocol: string; host: string; href: string } {
  return (globalThis as typeof globalThis & { location?: { protocol: string; host: string; href: string } }).location ?? { protocol: 'http:', host: 'localhost', href: 'http://localhost/' };
}

/** Canonical endpoint + map, never the old global reconnect token. */
export function onlineTokenKey(endpoint: string, mapId: MapId = 'highway'): string {
  getMap(mapId);
  const url = new URL(endpoint, pageLocation().href);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return `tcu.online.token:${mapId}:${url.toString()}`;
}

/** The server's HTTP API (…/api) next to its WebSocket URL. */
export function apiBase(ws: string): string {
  return siblingUrl(ws, 'api');
}

/** The server's /health endpoint next to its WebSocket URL. */
export function healthUrl(ws: string): string {
  return siblingUrl(ws, 'health');
}

function siblingUrl(ws: string, sibling: string): string {
  const url = new URL(ws);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/' + sibling;
  url.search = url.hash = '';
  return url.toString();
}
