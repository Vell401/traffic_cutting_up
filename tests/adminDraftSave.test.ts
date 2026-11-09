import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTuning, type CarTuning, type GlobalTuning } from '../src/sim/tuning';

// Minimal DOM for the production entry point: parse its real markup, bubble
// events, and serialize its real forms. No save/render/controller code is mocked.
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  attributes: Record<string, string> = {};
  listeners = new Map<string, Set<(event: Event) => void>>();
  value = '';
  hidden = false;
  textContent = '';
  tabIndex = 0;
  inert = false;
  private html = '';
  constructor(readonly tag = 'div') {}
  get id() { return this.attributes.id ?? ''; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v])); }
  get className() { return this.attributes.class ?? ''; }
  set className(value: string) { this.attributes.class = value; }
  classList = {
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (force ?? !names.has(name)) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    },
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
  };
  get innerHTML() { return this.html; }
  set innerHTML(html: string) {
    this.html = html;
    for (const child of this.children) child.parent = null;
    this.children = [];
    const stack: Node[] = [this];
    for (const match of html.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
      const [, close, tag, attrs] = match;
      if (close) {
        if (stack.at(-1)?.tag === tag) stack.pop();
        continue;
      }
      const node = new Node(tag);
      for (const attr of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.attributes[attr[1]] = attr[2] ?? '';
      node.value = node.attributes.value ?? '';
      stack.at(-1)!.appendChild(node);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) stack.push(node);
    }
  }
  appendChild(node: Node) { node.parent = this; this.children.push(node); return node; }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attr = selector.match(/^(\w+)?\[([\w-]+)(?:=([^\]]+))?\]$/);
    if (attr) return (!attr[1] || this.tag === attr[1]) && attr[2] in this.attributes && (attr[3] === undefined || this.attributes[attr[2]] === attr[3].replaceAll('"', ''));
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  contains(node: Node | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  fire(type: string) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: this });
    for (let node: Node | null = this; node; node = node.parent) for (const listener of node.listeners.get(type) ?? []) listener(event);
  }
  focus() { dom.activeElement = this; }
  blur() { dom.activeElement = null; }
  reportValidity() {
    return this.querySelectorAll('input').every(input => input.attributes.type !== 'number' || (input.value !== '' && Number.isFinite(Number(input.value)) && Number(input.value) >= Number(input.attributes.min) && Number(input.value) <= Number(input.attributes.max)));
  }
  get elements() { return { namedItem: (name: string) => this.querySelector(`[name=${name}]`) }; }
}

let dom: { body: Node; activeElement: Node | null; getElementById: (id: string) => Node | null; querySelector: (selector: string) => Node | null; createElement: (tag: string) => Node };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function setup() {
  vi.resetModules();
  vi.useFakeTimers();
  const body = new Node('body'), app = new Node();
  app.attributes.id = 'app'; body.appendChild(app);
  dom = { body, activeElement: null, getElementById: id => body.querySelector(`#${id}`), querySelector: selector => body.querySelector(selector), createElement: tag => new Node(tag) };
  const storage = new Map([['tcu.admin.highway', 'test-session']]);
  vi.stubGlobal('document', dom);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost/admin.html' });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('FormData', class {
    entries: [string, string][];
    constructor(form: Node) { this.entries = form.querySelectorAll('input').map(input => [input.attributes.name, input.value]); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    get(name: string) { return this.entries.find(([key]) => key === name)?.[1] ?? null; }
  });
  const tuning = defaultTuning();
  tuning.cars['3'].powerKW = 495;
  const serverState = {
    map: 'highway', tuning, defaults: defaultTuning(),
    server: { version: 'test', uptimeS: 1, rssMB: 1, connections: 0, stepAvgMs: 0, stepMaxMs: 0, tick: 1, seed: 1, rules: 'test' },
    rules: { maxPlayers: 8, tickHz: 60, ringKm: 10 }, drivers: [], bans: [], modes: [],
    traffic: { on: false, cars: 0 }, radio: { playlists: [] },
  };
  type TuningBody = { car?: string; values?: CarTuning; traffic?: GlobalTuning['traffic']; resetCar?: string; resetTraffic?: boolean };
  const saves: { body: TuningBody; gate: ReturnType<typeof deferred<Response>> }[] = [];
  let nextStateGate: ReturnType<typeof deferred<void>> | null = null;
  const holdNextState = () => {
    const gate = deferred<void>(); nextStateGate = gate;
    return async () => { gate.resolve(); await settle(); };
  };
  const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/tuning')) {
      const gate = deferred<Response>();
      saves.push({ body: JSON.parse(String(options?.body)), gate });
      return gate.promise; // Deliberately ignore AbortSignal to exercise stale-session guards.
    }
    if (url.endsWith('/login')) return response({ token: 'new-session' });
    if (url.endsWith('/state')) {
      const gate = nextStateGate; nextStateGate = null;
      const snapshot = response(serverState);
      if (gate) await gate.promise;
      return snapshot;
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetch);
  await import('../src/admin/main');
  await settle();
  const get = (id: string) => dom.getElementById(id)!;
  const panel = (id: string) => get(`admin-tab-${id}`).fire('click');
  panel('tuning');
  const release = async (index = saves.length - 1) => {
    const save = saves[index], b = save.body;
    if (b.values && b.car) Object.assign(tuning.cars[b.car], b.values);
    if (b.traffic) tuning.traffic = structuredClone(b.traffic);
    if (b.resetCar) tuning.cars[b.resetCar] = structuredClone(serverState.defaults.cars[b.resetCar]);
    if (b.resetTraffic) tuning.traffic = structuredClone(serverState.defaults.traffic);
    save.gate.resolve(response({ tuning })); await settle();
  };
  const edit = (input: Node, value: number) => { input.value = String(value); input.fire('input'); };
  const poll = async () => { await vi.advanceTimersByTimeAsync(2000); await settle(); };
  return { get, panel, release, saves, serverState, edit, poll, fetch, holdNextState };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('production admin saves preserve newer mounted drafts', () => {
  for (const kind of ['car', 'traffic'] as const) {
    const formId = kind === 'car' ? 'carTuneForm' : 'trafficSpeedForm';
    const fieldName = kind === 'car' ? 'powerKW' : 'speed-0-0';
    const resetId = kind === 'car' ? 'resetCarTune' : 'resetTrafficSpeed';
    const submitted = kind === 'car' ? 496 : 120, newer = submitted + 1;
    const field = (get: (id: string) => Node) => get(formId).querySelector(`[name=${fieldName}]`)!;

    it(`${kind}: delayed save and pending refresh cannot erase a hidden newer edit`, async () => {
      const { get, edit, panel, release, serverState, poll } = await setup();
      const form = get(formId), input = field(get), mounted = get('admin-panel-tuning');
      edit(input, submitted); form.fire('submit'); edit(input, newer);
      panel('overview'); await release(); await poll(); panel('tuning');
      expect(kind === 'car' ? serverState.tuning.cars['3'].powerKW : serverState.tuning.traffic.lanes[0][0]).toBe(submitted);
      expect(field(get)).toBe(input); expect(input.value).toBe(String(newer));
      expect(get(formId)).toBe(form); expect(get('admin-panel-tuning')).toBe(mounted);
    });

    it(`${kind}: an unchanged valid save clears dirty state`, async () => {
      const { get, edit, release, serverState, poll } = await setup();
      edit(field(get), submitted); get(formId).fire('submit'); await release();
      if (kind === 'car') serverState.tuning.cars['3'].powerKW = newer;
      else serverState.tuning.traffic.lanes[0][0] = newer;
      await poll(); expect(field(get).value).toBe(String(newer));
    });

    it(`${kind}: confirmed saved state arriving late cannot replace a newer draft`, async () => {
      const { get, edit, release, panel, poll, holdNextState } = await setup();
      edit(field(get), submitted); get(formId).fire('submit');
      const releaseState = holdNextState(); await release();
      const input = field(get); edit(input, newer); panel('overview');
      await releaseState(); await poll(); panel('tuning');
      expect(field(get)).toBe(input); expect(input.value).toBe(String(newer));
    });

    it(`${kind}: edits made while reset is pending survive its completion`, async () => {
      const { get, edit, release, panel, poll } = await setup();
      get(resetId).fire('click'); const input = field(get); edit(input, newer);
      panel('overview'); await release(); await poll(); panel('tuning');
      expect(field(get)).toBe(input); expect(input.value).toBe(String(newer));
    });

    it(`${kind}: older completion cannot clear a newer reset draft`, async () => {
      const { get, edit, release, panel, poll } = await setup();
      edit(field(get), submitted); get(formId).fire('submit'); get(resetId).fire('click');
      edit(field(get), newer); await release(0); await release(1);
      panel('overview'); await poll(); panel('tuning');
      expect(field(get).value).toBe(String(newer));
    });

    it(`${kind}: an unchanged reset still clears dirty state`, async () => {
      const { get, edit, release, serverState, poll } = await setup();
      edit(field(get), submitted); get(resetId).fire('click'); await release();
      expect(field(get).value).toBe(String(kind === 'car' ? serverState.defaults.cars['3'].powerKW : serverState.defaults.traffic.lanes[0][0]));
      if (kind === 'car') serverState.tuning.cars['3'].powerKW = newer;
      else serverState.tuning.traffic.lanes[0][0] = newer;
      await poll(); expect(field(get).value).toBe(String(newer));
    });

    it(`${kind}: stale login completion cannot touch the new session draft`, async () => {
      const { get, edit, release, panel, poll, fetch } = await setup();
      edit(field(get), submitted); get(formId).fire('submit'); get('logout').fire('click'); await settle();
      const login = dom.querySelector('form')!;
      login.querySelector('[name=password]')!.value = 'password'; login.fire('submit'); await settle(); panel('tuning');
      edit(field(get), newer); const input = field(get), calls = fetch.mock.calls.length;
      await release(0); expect(fetch.mock.calls.length).toBe(calls);
      panel('overview'); await poll(); panel('tuning');
      expect(field(get)).toBe(input); expect(input.value).toBe(String(newer));
    });
  }

  it('car identity changes invalidate an old save even after switching back', async () => {
    const { get, edit, release, panel, poll } = await setup();
    edit(get('carTuneFields').querySelector('[name=powerKW]')!, 496); get('carTuneForm').fire('submit');
    const picker = get('tuneCar');
    picker.value = '5'; picker.fire('change'); picker.value = '3'; picker.fire('change');
    const input = get('carTuneFields').querySelector('[name=powerKW]')!;
    edit(input, 497); panel('overview'); await release(); await poll(); panel('tuning');
    expect(get('carTuneFields').querySelector('[name=powerKW]')).toBe(input); expect(input.value).toBe('497');
  });

  it('completion for another car cannot clear the newly selected car draft', async () => {
    const { get, edit, release, panel, poll } = await setup();
    edit(get('carTuneFields').querySelector('[name=powerKW]')!, 496); get('carTuneForm').fire('submit');
    const picker = get('tuneCar'); picker.value = '5'; picker.fire('change');
    const input = get('carTuneFields').querySelector('[name=powerKW]')!; edit(input, 400);
    panel('overview'); await release(); await poll(); panel('tuning');
    expect(picker.value).toBe('5'); expect(input.value).toBe('400');
    expect(get('carTuneFields').querySelector('[name=powerKW]')).toBe(input);
  });

  it('car saves cannot clear traffic dirty state, and vice versa', async () => {
    const { get, edit, release, panel, poll } = await setup();
    edit(get('carTuneFields').querySelector('[name=powerKW]')!, 496); get('carTuneForm').fire('submit');
    const speed = get('trafficSpeedForm').querySelector('[name=speed-0-0]')!;
    edit(speed, 120); get('trafficSpeedForm').fire('submit'); edit(speed, 121);
    const power = get('carTuneFields').querySelector('[name=powerKW]')!; edit(power, 497);
    await release(1); await release(0); panel('overview'); await poll(); panel('tuning');
    expect(power.value).toBe('497'); expect(speed.value).toBe('121');
    expect(get('carTuneFields').querySelector('[name=powerKW]')).toBe(power);
    expect(get('trafficSpeedForm').querySelector('[name=speed-0-0]')).toBe(speed);
  });
});
