/** Shared by the real browser acceptance and its failure-path regressions. */
export function peerWelcome(ws: WebSocket, hello: unknown, timeoutMs = 15_000): Promise<{ id: number; players: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, welcome?: { id: number; players: number }) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (error) reject(error); else resolve(welcome!);
    };
    const timer = setTimeout(() => { finish(Error('peer welcome timeout')); ws.close(); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = event => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.t === 'welcome') finish(undefined, { id: msg.id, players: msg.players.length });
        else if (msg.t === 'reject') finish(Error(msg.reason));
      } catch { finish(Error('invalid peer welcome')); }
    };
    ws.onerror = () => finish(Error('peer connection'));
    ws.onclose = () => finish(Error('peer closed before welcome'));
  });
}
