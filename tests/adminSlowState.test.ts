import { afterEach, describe, expect, it, vi } from 'vitest';

// A small DOM fixture, not a replacement controller: main.ts and tabs.ts run unchanged.
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  id = '';
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  inert = false;
  disabled = false;
  tabIndex = 0;
  private html = '';
  constructor(readonly tag = 'div') { super(); }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name); },
  };
  set innerHTML(html: string) {
    this.html = html;
    for (const child of this.children) child.parent = null;
    this.children = [];
    const stack: Element[] = [this];
    for (const match of html.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const child = new Element(match[2]);
      for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1)!.appendChild(child);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(child.tag)) stack.push(child);
    }
  }
  get innerHTML(): string { return this.html; }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'value') this.value = value;
    if (name === 'inert') this.inert = true;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: Element): void { child.parent = this; this.children.push(child); }
  contains(child: Element | null): boolean { return child === this || this.children.some(node => node.contains(child)); }
  get isConnected(): boolean { return this.tag === 'body' || !!this.parent?.isConnected; }
  get options(): Element[] { return this.children; }
  get elements(): { namedItem: (name: string) => Element | null } { return { namedItem: name => this.querySelector(`[name=${name}]`) }; }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector.startsWith('[')) {
      const [key, value] = selector.slice(1, -1).split('=');
      return this.attributes.has(key) && (value === undefined || this.getAttribute(key) === value);
    }
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] {
    const parts = selector.split(' ');
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    if (parts.length > 1) return this.querySelectorAll(parts[0]).flatMap(child => child.querySelectorAll(parts.slice(1).join(' ')));
    return descendants.filter(child => child.matches(selector));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  click(): void {
    const event = new Event('click');
    Object.defineProperty(event, 'target', { value: this });
    for (let node: Element | null = this; node; node = node.parent) node.dispatchEvent(event);
  }
  focus(): void {}
  blur(): void {}
}

const state = (map: unknown = 'highway', tick = 1) => ({
  map,
  server: { version: `slow-${tick}`, uptimeS: 60, rssMB: 20, connections: 0, stepAvgMs: 1, stepMaxMs: 2, tick, seed: 3, rules: 'test' },
  rules: { maxPlayers: 8, tickHz: 30, ringKm: 12 },
  traffic: { on: true, cars: 2 }, modes: [], drivers: [], bans: [],
  tuning: { cars: {}, traffic: {} }, defaults: { cars: {}, traffic: {} }, radio: { playlists: [] },
});
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function fixture(options: { map?: unknown; status?: number; latency?: number } = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  const body = new Element('body'), app = new Element();
  app.id = 'app'; body.appendChild(app);
  const document = {
    body, activeElement: null,
    getElementById: (id: string) => body.querySelector(`#${id}`),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (tag: string) => new Element(tag),
  };
  const data = new Map([['tcu.admin.highway', 'old-token']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', new URL('http://localhost/admin.html?map=highway'));
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('confirm', () => true);
  let inflight = 0, maximum = 0, completed = 0, started = 0;
  const signals: AbortSignal[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/login')) return response({ token: 'new-token' });
    if (url.endsWith('/state')) {
      const index = ++started;
      const auth = (init.headers as Record<string, string>).authorization;
      signals.push(init.signal as AbortSignal);
      maximum = Math.max(maximum, ++inflight);
      // Deliberately ignore AbortSignal, so stale successes/401s exercise epoch guards.
      await new Promise(resolve => setTimeout(resolve, options.latency ?? 2400));
      --inflight; ++completed;
      return response(state(options.map, index), auth === 'Bearer old-token' ? options.status : 200);
    }
    if (url.includes('/board?')) return response({ entries: [] });
    if (url.includes('/logs?')) return response({ rows: [] });
    return response({});
  });
  vi.stubGlobal('fetch', fetch);
  await import('../src/admin/main');
  const el = (id: string) => document.getElementById(id)!;
  const login = async () => {
    const form = app.querySelector('form')!;
    form.elements.namedItem('password')!.value = 'password';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { el, app, document, storage, fetch, signals, login, stats: () => ({ started, completed, inflight, maximum }) };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('production admin slow state polling', () => {
  it('accepts the first 2.4s response and keeps rendering through 8s with only one state request in flight', async () => {
    const f = await fixture();
    expect(f.document.querySelector('.wrap')!.inert).toBe(true);
    f.el('saveMax').click(); // Synthetic events bypass inert, but must still fail the map guard.
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.stats().started).toBe(1);
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/players'))).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.document.querySelector('.wrap')!.inert).toBe(false);
    expect(f.el('meta').textContent).toContain('slow-1');
    f.el('saveMax').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/players'))).toBe(true);
    await vi.advanceTimersByTimeAsync(5600);
    expect(f.stats()).toEqual({ started: 4, completed: 3, inflight: 1, maximum: 1 });
    expect(f.el('meta').textContent).toContain('slow-3');
    expect(f.el('live').className).not.toContain('bad');
    expect(f.fetch.mock.calls.some(([url]) => /\/(board|logs)\?/.test(url))).toBe(false);
    f.el('admin-tab-logs').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('/logs?'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('/logs?'))).toHaveLength(2);
    f.el('admin-tab-overview').click();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('/logs?'))).toHaveLength(2);
    expect(f.stats().maximum).toBe(1);
  });

  it.each(['miami', null, {}])('never enables mutations for a slow unverified map %j', async map => {
    const f = await fixture({ map });
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.stats().completed).toBe(3);
    expect(f.stats().maximum).toBe(1);
    expect(f.document.querySelector('.wrap')!.inert).toBe(true);
    expect(f.el('meta').textContent).toBe('');
    expect(f.el('live').textContent).toContain('действия заблокированы');
    f.el('saveMax').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/players'))).toBe(false);
  });

  it.each([200, 401])('ignores a late old-session %s without releasing the new poll or enabling its controls', async status => {
    const f = await fixture({ status });
    await vi.advanceTimersByTimeAsync(2000); // Queue a coalesced old-session poll.
    f.el('logout').click();
    expect(f.signals[0].aborted).toBe(true);
    expect(f.storage.getItem('tcu.admin.highway')).toBeNull();
    expect(f.fetch.mock.calls.find(([url]) => url.endsWith('/logout'))![1].signal!.aborted).toBe(false);
    await f.login();
    expect(f.stats().started).toBe(2);
    await vi.advanceTimersByTimeAsync(400); // Old response arrives; new response is not ready.
    expect(f.storage.getItem('tcu.admin.highway')).toBe('new-token');
    expect(f.app.querySelector('.login')).toBeNull();
    expect(f.document.querySelector('.wrap')!.inert).toBe(true);
    expect(f.el('meta').textContent).toBe('');
    await vi.advanceTimersByTimeAsync(1600); // New timer must still coalesce with its request.
    expect(f.stats().started).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.document.querySelector('.wrap')!.inert).toBe(false);
    expect(f.el('meta').textContent).toContain('slow-2');
    expect(f.stats().started).toBe(3);
  });
});
