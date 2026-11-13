import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyPhysics, createCar } from '../src/sim/physics';
import { Sim } from '../src/sim/world';
import type { CarId } from '../src/sim/cars';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const section = (start: string, end: string) => {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeGreaterThan(a);
  return main.slice(a, b);
};
/** Execute the real handlers (only erase TS), without booting WebGL/audio and unrelated DOM. */
const run = (source: string, env: Record<string, unknown>) => new Function(...Object.keys(env),
  `return ${stripTypeScriptTypes(`(function () {\n${source}\n})`)}();`)(...Object.values(env));

afterEach(() => vi.restoreAllMocks());

function garage(state = 'pause', online = false) {
  const sim = new Sim(() => .5, { physics: 5 });
  Object.assign(sim.score, { score: 2400, near: 3, runTime: 30, topKmh: 210, combo: 2, mult: 1.5 });
  const submitSolo = vi.fn().mockResolvedValue(undefined), waitForCar = vi.fn().mockResolvedValue(undefined);
  const loading = { begin: vi.fn(), stage: vi.fn().mockResolvedValue(undefined), set: vi.fn(), finish: vi.fn(), fail: vi.fn() };
  let visual = 4, saved = 4;
  const saveCar = vi.fn((id: number) => { saved = id; });
  const view = { setPaint: vi.fn(), setCar: vi.fn((id: number) => { visual = id; }), render: vi.fn(), prepareCar: vi.fn().mockResolvedValue(undefined) };
  const session = online ? { core: { id: 7, players: [{ id: 7, car: 2, color: 0x123456, physics: 2 }] }, changeCar: vi.fn(async () => { sim.setPhysics(2, false); }) } : null;
  const code = `let car = 4, paint = 0, choosingCar = false, restoringCar = false, carReady = true, carRevision = 0, pendingShift = 0, blinker = 0;
    ${section("sim.events.on('runEnd',", '\nfunction start():')}
    ${section('async function chooseCar(', '\n/** A dropped garage ACK')}
    ${section('async function syncAuthoritativeCar(', '\nconst paintInput')}
    return { chooseCar, syncAuthoritativeCar, car: () => car, ready: () => carReady };`;
  const { chooseCar, syncAuthoritativeCar, car, ready } = run(code, {
    sim, state, session, bodyPhysics, createCar, waitForCar, loading,
    TEST: false, ONLINE: false, leaders: { submitSolo }, playerName: () => 'Driver', saveBest: vi.fn(),
    hud: { tag: vi.fn() }, loadPaint: () => 0x123456, saveCar, loadCameraMode: () => 'chase',
    sound: { setCar: vi.fn() }, view,
    showPaint: vi.fn(), showCar: vi.fn(), showPauseCar: vi.fn(), mouse: { centre: vi.fn() },
  }) as { chooseCar(id: CarId): Promise<void>; syncAuthoritativeCar(): Promise<void>; car(): CarId; ready(): boolean };
  return { sim, chooseCar, syncAuthoritativeCar, car, ready, submitSolo, waitForCar, loading, view, session, saveCar, visual: () => visual, saved: () => saved };
}

describe('resident menu and solo garage lifecycle', () => {
  it('submits the old run under its old body/physics before installing the new solo car', async () => {
    const h = garage();
    await h.chooseCar(2);
    expect(h.submitSolo).toHaveBeenCalledExactlyOnceWith({ name: 'Driver', score: 2400, car: 4, physics: 5, near: 3, topKmh: 210, seconds: 30 });
    expect(h.car()).toBe(2); expect(h.sim.player.physicsId).toBe(2);
    expect(h.sim.score).toMatchObject({ score: 0, near: 0, runTime: 0, topKmh: 0, combo: 0, mult: 1 });
    h.sim.score.score = 1300; h.sim.score.endRun();
    expect(h.submitSolo.mock.calls[1][0]).toMatchObject({ score: 1300, car: 2, physics: 2 });
  });

  it('does not end a run for the same car or a menu-only preview', async () => {
    const h = garage('menu');
    await h.chooseCar(4); expect(h.waitForCar).not.toHaveBeenCalled();
    await h.chooseCar(2);
    expect(h.submitSolo).not.toHaveBeenCalled(); expect(h.sim.score.score).toBe(2400);
  });

  it('keeps the old car/run when a replacement download fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage(); h.waitForCar.mockRejectedValueOnce(new Error('offline'));
    await h.chooseCar(2);
    expect(h.car()).toBe(4); expect(h.sim.player.physicsId).toBe(5);
    expect(h.sim.score.score).toBe(2400); expect(h.submitSolo).not.toHaveBeenCalled();
    expect(h.loading.fail).toHaveBeenCalledOnce();
  });

  it.each(['pause', 'menu'])('retains the old usable solo identity until late preparation succeeds (%s)', async state => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage(state); h.view.prepareCar.mockRejectedValueOnce(new Error('late upload'));
    await h.chooseCar(2);
    expect(h.car()).toBe(4); expect(h.sim.player.physicsId).toBe(5);
    expect(h.sim.score.score).toBe(2400); expect(h.submitSolo).not.toHaveBeenCalled();
    h.loading.fail.mock.calls[0][1]();
    await vi.waitFor(() => expect(h.view.prepareCar).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.car()).toBe(2));
  });

  it('retries preparation of an already accepted online identity without changing authoritative physics again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage('pause', true); h.view.prepareCar.mockRejectedValueOnce(new Error('late upload'));
    await h.chooseCar(2); expect(h.car()).toBe(2); expect(h.sim.player.physicsId).toBe(2);
    await h.chooseCar(2);
    expect(h.view.prepareCar).toHaveBeenCalledTimes(2); expect(h.session!.changeCar).toHaveBeenCalledOnce();
  });

  it.each(['pause', 'menu'])('does not commit a solo candidate whose final live draw throws and really retries (%s)', async state => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage(state); h.view.render.mockImplementationOnce(() => { throw new Error('live draw'); });
    await h.chooseCar(2);
    expect([h.car(), h.sim.player.physicsId, h.visual(), h.saved(), h.ready()]).toEqual([4, 5, 4, 4, true]);
    expect(h.sim.score.score).toBe(2400); expect(h.submitSolo).not.toHaveBeenCalled(); expect(h.saveCar).not.toHaveBeenCalled();
    h.loading.fail.mock.calls[0][1]();
    await vi.waitFor(() => expect(h.view.render).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.car()).toBe(2));
    expect(h.view.prepareCar).toHaveBeenCalledTimes(2);
    expect([h.car(), h.sim.player.physicsId, h.visual(), h.saved(), h.ready()]).toEqual([2, 2, 2, 2, true]);
    expect(h.submitSolo).toHaveBeenCalledTimes(state === 'pause' ? 1 : 0);
  });

  it('keeps accepted online physics but not visual readiness after a final live draw throws, then really retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage('pause', true); h.view.render.mockImplementationOnce(() => { throw new Error('live draw'); });
    await h.chooseCar(2);
    expect([h.car(), h.sim.player.physicsId, h.visual(), h.ready()]).toEqual([2, 2, 2, false]);
    h.loading.fail.mock.calls[0][1]();
    await vi.waitFor(() => expect(h.view.render).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.ready()).toBe(true));
    expect(h.view.prepareCar).toHaveBeenCalledTimes(2); expect(h.session!.changeCar).toHaveBeenCalledOnce();
    expect([h.car(), h.sim.player.physicsId, h.visual(), h.saved()]).toEqual([2, 2, 2, 2]);
  });

  it('actually retries authoritative restoration after committing the identity but failing preparation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = garage('play', true); h.sim.setPhysics(2, false);
    h.view.prepareCar.mockRejectedValueOnce(new Error('late upload'));
    await h.syncAuthoritativeCar(); expect(h.car()).toBe(2);
    h.loading.fail.mock.calls[0][1]();
    await vi.waitFor(() => expect(h.view.prepareCar).toHaveBeenCalledTimes(2));
    expect(h.sim.player.physicsId).toBe(2); expect(h.session!.changeCar).not.toHaveBeenCalled();
  });

  it.each([false, true])('refreshes both leaderboards every time the resident menu reopens (online=%s)', ONLINE => {
    let click!: () => void;
    const refresh = vi.fn().mockResolvedValue(undefined), leave = vi.fn();
    const classList = { add: vi.fn(), remove: vi.fn() };
    const handler = section("document.getElementById('menuBtn')!", "document.getElementById('resumeBtn')!");
    run(handler, {
      document: { getElementById: () => ({ addEventListener: (_: string, cb: () => void) => { click = cb; } }), body: { classList } },
      session: { leave }, metrics: {}, onlineHud: { reset: vi.fn() },
      sim: new Sim(() => .5, { online: ONLINE }), chat: { reset: vi.fn() }, touch: { releaseAll: vi.fn() },
      input: { releaseAll: vi.fn() }, mouse: { locked: false }, state: 'play', onlineMenu: true,
      pendingShift: 0, blinker: 0, acc: 0, sound: { setPaused: vi.fn() }, TEST: false,
      startEl: { classList }, pauseEl: { classList }, menuMessage: vi.fn(), fitMenu: vi.fn(), syncTouch: vi.fn(),
      leaders: { refresh }, ONLINE, probeServer: vi.fn(),
    });
    click(); click();
    expect(leave).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
