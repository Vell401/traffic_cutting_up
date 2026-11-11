import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { ClientCore } from '../src/online/clientCore';
import { CHAT_MAX_LENGTH, cleanChat } from '../src/online/protocol';
import { Sim } from '../src/sim/world';
import { attach, emptyServer, RecordingPeer } from './chatGarageHelpers';

describe('online chat', () => {
  it('cleans controls and bidi overrides, trims, bounds length and keeps Unicode intact', () => {
    expect(cleanChat('  Привет\u0000\n\r\t\u007f\u0085\u202e\u2066 мир  ')).toBe('Привет мир');
    expect(cleanChat('x'.repeat(300))).toHaveLength(CHAT_MAX_LENGTH);
    expect(cleanChat('x'.repeat(199) + '🚗')).toBe('x'.repeat(199));
    expect(cleanChat('🚗'.repeat(200))).toBe('🚗'.repeat(100));
    expect(cleanChat('семья 👩‍👩‍👧‍👦')).toBe('семья 👩‍👩‍👧‍👦');
    expect(cleanChat(null)).toBe('');
  });

  it('broadcasts plain text to joined players, using only the server identity', () => {
    const server = emptyServer();
    const a = attach(server, '  <Alice>\n ');
    const b = attach(server, 'Bob');
    const menu = new RecordingPeer();
    server.connect(menu);
    a.conn.receive(JSON.stringify({ t: 'chat', text: '  hi\n\u0000<script>  ', id: b.welcome.id, name: 'Admin' }));
    const expected = [{ t: 'chat', id: a.welcome.id, name: 'Alice', text: 'hi<script>' }];
    expect(a.peer.json('chat')).toEqual(expected);
    expect(b.peer.json('chat')).toEqual(expected);
    expect(menu.json('chat')).toEqual([]);
    // Chat is data, not HTML; the UI must insert message text using textContent.
  });

  it('caps forged clients at 200 and ignores empty messages without consuming the rate budget', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    a.conn.receive(JSON.stringify({ t: 'chat', text: '\n \u0000\t ' }));
    a.conn.receive(JSON.stringify({ t: 'chat', text: 'я'.repeat(1000) }));
    expect(a.peer.json('chat')).toHaveLength(1);
    expect(a.peer.json('chat')[0].text).toBe('я'.repeat(200));
  });

  it('rate limits each player independently, and keeps the limit when the token reconnects', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    const b = attach(server, 'Bob');
    a.conn.receive(JSON.stringify({ t: 'chat', text: 'one' }));
    a.conn.receive(JSON.stringify({ t: 'chat', text: 'flood' }));
    b.conn.receive(JSON.stringify({ t: 'chat', text: 'independent' }));
    a.conn.close();
    const back = attach(server, 'Forged', { token: a.welcome.token });
    back.conn.receive(JSON.stringify({ t: 'chat', text: 'reconnect flood' }));
    expect(b.peer.json('chat').map((m) => m.text)).toEqual(['one', 'independent']);
    for (let i = 0; i < server.world.rules.tickHz; i++) server.tick();
    back.conn.receive(JSON.stringify({ t: 'chat', text: 'after one second' }));
    expect(b.peer.json('chat').at(-1)).toMatchObject({ id: a.welcome.id, name: 'Alice', text: 'after one second' });
    expect(back.conn.closed).toBe(false);
  });

  it('does not let pre-hello, offline or malformed senders broadcast', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    const outsider = server.connect(new RecordingPeer());
    outsider.receive(JSON.stringify({ t: 'chat', text: 'before hello' }));
    expect(outsider.violations).toBe(1);
    for (const text of [null, 42, {}, []]) a.conn.receive(JSON.stringify({ t: 'chat', text }));
    expect(a.conn.violations).toBe(4);
    a.conn.close();
    a.conn.receive(JSON.stringify({ t: 'chat', text: 'closed' }));
    expect(a.peer.json('chat')).toEqual([]);
  });

  it('preserves the existing total message and frame size limits', () => {
    const server = emptyServer();
    const a = attach(server, 'Alice');
    a.conn.receive(JSON.stringify({ t: 'chat', text: 'x'.repeat(2048) }));
    expect(a.conn.violations).toBe(1);
    for (let i = 0; i < 401; i++) a.conn.receive(JSON.stringify({ t: 'chat', text: 'flood' }));
    expect(a.conn.closed).toBe(true);
    expect(a.peer.closes.at(-1)).toEqual({ code: 1008, reason: 'rate' });
  });

  it('exposes clean outbound text and the authoritative onChat callback in ClientCore', () => {
    const send = vi.fn();
    const onChat = vi.fn();
    const core = new ClientCore(new Sim(mulberry32(4), { online: true }), { send, onChat });
    expect(core.sendChat('not joined')).toBe(false);
    core.id = 7;
    expect(core.sendChat('\n ')).toBe(false);
    expect(core.sendChat('  hello\u0000 ')).toBe(true);
    expect(JSON.parse(send.mock.calls[0][0] as string)).toEqual({ t: 'chat', text: 'hello' });
    core.receive(JSON.stringify({ t: 'chat', id: 2, name: 'Server Name', text: 'Привет' }), 0);
    expect(onChat).toHaveBeenCalledWith({ id: 2, name: 'Server Name', text: 'Привет' });
  });
});
