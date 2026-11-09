import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fullscreen } from '../src/ui/fullscreen';
import { DocumentStub, ElementStub, event } from './mobileDom';

let doc: DocumentStub, root: ElementStub, fullscreen: Fullscreen;
beforeEach(() => {
  doc = new DocumentStub(); root = doc.documentElement;
  fullscreen = new Fullscreen(root as unknown as HTMLElement, doc as unknown as Document);
});
afterEach(() => fullscreen.dispose());
function api(request: () => Promise<void> | void): void { Object.assign(root, { requestFullscreen: request }); }

describe('production fullscreen gesture and lifecycle', () => {
  it('calls the document-root native API immediately in the real button event, before any await', async () => {
    let resolve!: () => void;
    const request = vi.fn(() => new Promise<void>(done => { resolve = done; })); api(request);
    const button = fullscreen.button() as unknown as ElementStub;
    button.click(); expect(request).toHaveBeenCalledOnce();
    expect(request.mock.instances[0]).toBe(root);
    doc.fullscreenElement = root; event(doc, 'fullscreenchange'); resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(fullscreen.native).toBe(true);
    expect(button.textContent).toBe('Выйти из экрана');
    doc.fullscreenElement = null; event(doc, 'fullscreenchange');
    expect(button.textContent).toBe('Полный экран');
    expect(root.classes.has('immersive')).toBe(false);
  });
  it('unsupported iOS is an honest CSS fallback with Add to Home Screen instructions and explicit exit', async () => {
    doc.defaultView.navigator.userAgent = 'iPhone';
    const notice = fullscreen.notice();
    expect(await fullscreen.enter()).toBe(false);
    expect(fullscreen.native).toBe(false);
    expect(notice.textContent).toContain('На экран Домой');
    expect(root.classes.has('immersive')).toBe(true);
    await fullscreen.toggle(); expect(root.classes.has('immersive')).toBe(false);
  });
  it('rejection or synchronous denial cannot block play or become an unhandled rejection', async () => {
    for (const request of [() => Promise.reject(new Error('denied')), () => { throw new Error('denied'); }]) {
      api(request);
      expect(await fullscreen.enter()).toBe(false);
      expect(fullscreen.notice().textContent).toContain('играть можно');
      expect(fullscreen.native).toBe(false);
    }
  });
  it('orientation lock rejection or unsupported API never undoes successful native fullscreen', async () => {
    for (const lock of [undefined, () => Promise.reject(new Error('unsupported')), () => { throw new Error('unsupported'); }]) {
      doc.defaultView.screen.orientation = { lock };
      api(async () => { doc.fullscreenElement = root; event(doc, 'fullscreenchange'); });
      expect(await fullscreen.enter()).toBe(true);
      expect(root.classes.has('immersive')).toBe(false);
      doc.fullscreenElement = null;
    }
  });
  it('exits native mode and detects external exits on every registered button', async () => {
    api(async () => { doc.fullscreenElement = root; event(doc, 'fullscreenchange'); });
    const exit = vi.fn(async () => { doc.fullscreenElement = null; event(doc, 'fullscreenchange'); });
    Object.assign(doc, { exitFullscreen: exit });
    const a = fullscreen.button(), b = fullscreen.button();
    await fullscreen.enter(); await fullscreen.toggle();
    expect(exit).toHaveBeenCalledOnce(); expect(a.textContent).toBe('Полный экран'); expect(b.textContent).toBe(a.textContent);
  });
  it('uses prefixed document-root fullscreen when standard APIs are absent', async () => {
    Object.assign(root, { webkitRequestFullscreen: async () => {
      Object.assign(doc, { webkitFullscreenElement: root }); event(doc, 'webkitfullscreenchange');
    } });
    expect(await fullscreen.enter()).toBe(true);
  });
});
