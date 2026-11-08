import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function diagnostics() {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('window', { addEventListener() {}, setTimeout });
  vi.stubGlobal('navigator', { userAgent: 'test' });
  const module = await import('../src/diag');
  module.initDiag('/api', 'online', 'high', { addEventListener() {} } as unknown as HTMLCanvasElement, null);
  return { ...module, fetch };
}

describe('performance diagnostics', () => {
  it('includes CPU times and scene load in a sustained low-FPS report', async () => {
    const { diagFrame, fetch } = await diagnostics();
    for (let i = 0; i < 200; i++) diagFrame(50, 2, 4, () => ({ calls: 123, traffic: 300 }));
    await vi.advanceTimersByTimeAsync(5000);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.items[0].msg).toContain('20 fps');
    expect(JSON.parse(body.items[0].detail)).toEqual({ simulationMs: 2, renderCpuMs: 4, calls: 123, traffic: 300 });
  });

  it('does not mistake startup, background tabs or an interrupted frame window for slow driving', async () => {
    const { diagFrame, fetch } = await diagnostics();
    for (let i = 0; i < 200; i++) diagFrame(50, 2, 4, undefined, false);
    vi.stubGlobal('document', { hidden: true });
    for (let i = 0; i < 200; i++) diagFrame(50);
    vi.stubGlobal('document', { hidden: false });
    for (let i = 0; i < 199; i++) diagFrame(50);
    diagFrame(2000);
    diagFrame(50);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
