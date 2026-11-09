import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export type ClientAddressResolver = (req: IncomingMessage) => string;
type Address = { family: 4 | 6; bits: bigint; text: string; mapped: boolean };

function address(text: string): Address | undefined {
  // Only bare IP literals: no ports, brackets, zone identifiers or DNS names.
  if (text.includes('%')) return;
  const family = isIP(text);
  if (family === 4) {
    const bytes = text.split('.').map(Number);
    return { family, bits: bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n), text: bytes.join('.'), mapped: false };
  }
  if (family !== 6) return;
  let hex = text.toLowerCase();
  if (hex.includes('.')) {
    const colon = hex.lastIndexOf(':');
    const bytes = hex.slice(colon + 1).split('.').map(Number);
    hex = hex.slice(0, colon + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const sides = hex.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const words = (sides.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]).map(s => parseInt(s, 16));
  const bits = words.reduce((n, word) => (n << 16n) | BigInt(word), 0n);
  // IPv4 and IPv4-mapped IPv6 must share one limiter/ban key and trust rule.
  if (bits >> 32n === 0xffffn) {
    const low = Number(bits & 0xffffffffn);
    return { family: 4, bits: BigInt(low), text: [low >>> 24, (low >>> 16) & 255, (low >>> 8) & 255, low & 255].join('.'), mapped: true };
  }
  return { family: 6, bits, text: words.map(word => word.toString(16)).join(':'), mapped: false };
}

/**
 * Trust contract: only listed socket peers may supply X-Forwarded-For. Each trusted
 * proxy must overwrite XFF or append its actual peer. Walk right-to-left, stopping
 * at the first untrusted hop (never use a caller-controlled leftmost entry).
 * Empty configuration trusts nobody. Invalid configuration fails startup.
 */
export function createClientAddressResolver(trustedProxies: string | readonly string[] = []): ClientAddressResolver {
  const entries = typeof trustedProxies === 'string' ? (trustedProxies.trim() ? trustedProxies.split(',') : []) : trustedProxies;
  if (entries.length > 128) throw new Error('TRUSTED_PROXIES has too many entries');
  const networks = entries.map(entry => {
    const parts = entry.trim().split('/');
    const ip = address(parts[0]);
    if (!ip || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
    const width = ip.family === 4 ? 32 : 128;
    let prefix = parts.length === 1 ? width : Number(parts[1]);
    if (ip.mapped && parts.length === 2) {
      if (prefix < 96 || prefix > 128) throw new Error(`Invalid mapped TRUSTED_PROXIES prefix: ${entry}`);
      prefix -= 96;
    }
    if (prefix < 0 || prefix > width) throw new Error(`Invalid TRUSTED_PROXIES prefix: ${entry}`);
    const shift = BigInt(width - prefix);
    return { family: ip.family, shift, network: ip.bits >> shift };
  });
  const trusted = (ip: Address) => networks.some(net => net.family === ip.family && ip.bits >> net.shift === net.network);
  return req => {
    const peer = address(req.socket.remoteAddress ?? '');
    if (!peer) return '?';
    if (!trusted(peer)) return peer.text;
    const header = req.headers['x-forwarded-for'];
    if (header === undefined) return peer.text;
    const fields = Array.isArray(header) ? header : [header];
    // Bound work before joining/splitting, and reject the entire chain on malformed input.
    if (fields.length > 32 || fields.reduce((n, field) => n + field.length + 1, 0) > 4096) return peer.text;
    const hops = fields.join(',').split(',');
    if (hops.length > 32) return peer.text;
    const chain = hops.map(hop => address(hop.trim()));
    if (chain.some(ip => !ip)) return peer.text;
    let current = peer;
    for (let i = chain.length - 1; i >= 0 && trusted(current); i--) current = chain[i]!;
    return current.text;
  };
}

/** Safe standalone/default identity: ignores forwarded headers. */
export const clientIp = createClientAddressResolver();
