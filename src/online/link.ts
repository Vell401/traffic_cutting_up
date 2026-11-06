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
export function serverUrl(params: URLSearchParams): string {
  const fromParam = params.get('server');
  if (fromParam) return fromParam;
  const fromEnv = import.meta.env.VITE_ONLINE_URL as string | undefined;
  if (fromEnv) return fromEnv;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** The server's /health endpoint next to its WebSocket URL. */
export function healthUrl(ws: string): string {
  return ws.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') + '/health';
}
