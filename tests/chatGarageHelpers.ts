import { GameServer, type Peer } from '../src/online/gameServer';
import { PROTOCOL_VERSION, rulesHash } from '../src/online/rules';
import type { ClientMsg, ServerMsg } from '../src/online/protocol';

export class RecordingPeer implements Peer {
  readonly messages: (Uint8Array | string)[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  buffered = 0;

  send(data: Uint8Array | string): void {
    this.messages.push(typeof data === 'string' ? data : data.slice());
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  json<T extends ServerMsg['t']>(type: T): Extract<ServerMsg, { t: T }>[] {
    return this.messages.filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m) as ServerMsg)
      .filter((m): m is Extract<ServerMsg, { t: T }> => m.t === type);
  }
}

export function attach(server: GameServer, name: string, overrides: Partial<Extract<ClientMsg, { t: 'hello' }>> = {}) {
  const peer = new RecordingPeer();
  const conn = server.connect(peer);
  conn.receive(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, rules: rulesHash(), name, physics: 4, car: 1, color: 0x123456, seq: 0, ...overrides }));
  const welcome = peer.json('welcome')[0];
  return { peer, conn, welcome, driver: welcome ? server.world.byId(welcome.id)! : undefined };
}

export function emptyServer(seed = 41): GameServer {
  let token = 0;
  const server = new GameServer({ seed, token: () => `token-${++token}` });
  server.world.traffic.enabled = false;
  return server;
}
