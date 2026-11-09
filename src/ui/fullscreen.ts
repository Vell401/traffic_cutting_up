type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Native fullscreen is requested synchronously by a button's real user gesture, never after join. */
export class Fullscreen {
  private readonly buttons = new Set<HTMLButtonElement>();
  private readonly listeners = new AbortController();
  private immersive = false;
  private busy = false;
  private message = '';
  private readonly notices = new Set<HTMLElement>();

  constructor(private readonly root: FullscreenRoot = document.documentElement, private readonly doc: FullscreenDocument = document) {
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
      doc.addEventListener(event, () => {
        // Native exit (including Esc / OS gestures) is authoritative, not a second fake fullscreen.
        this.immersive = false;
        if (this.native) this.message = '';
        this.sync();
      }, { signal: this.listeners.signal });
    }
  }

  get native(): boolean { return !!(this.doc.fullscreenElement || this.doc.webkitFullscreenElement); }

  button(): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'fullscreen-button';
    button.addEventListener('click', () => { void this.toggle(); button.blur(); }, { signal: this.listeners.signal });
    this.buttons.add(button);
    this.sync();
    return button;
  }

  notice(): HTMLElement {
    const note = this.doc.createElement('p');
    note.className = 'fullscreen-notice';
    note.setAttribute('role', 'status');
    this.notices.add(note);
    this.sync();
    return note;
  }

  async toggle(): Promise<void> {
    if (this.busy) return;
    if (this.native) {
      this.busy = true;
      try {
        const exit = this.doc.exitFullscreen ?? this.doc.webkitExitFullscreen;
        await exit?.call(this.doc);
      } catch { this.message = 'Не удалось выйти из полного экрана. Используйте кнопку браузера или Esc.'; }
      finally { this.busy = false; this.sync(); }
    } else if (this.immersive) {
      this.immersive = false;
      this.message = '';
      this.sync();
    } else await this.enter();
  }

  async enter(): Promise<boolean> {
    if (this.native || this.busy) return this.native;
    const request = this.root.requestFullscreen ?? this.root.webkitRequestFullscreen;
    if (!request) { this.fallback(); return false; }
    this.busy = true;
    try {
      // This call must stay before the first await: transient user activation is short-lived.
      await request.call(this.root);
      this.message = '';
      const orientation = this.doc.defaultView?.screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> } | undefined;
      try { if (this.native) void orientation?.lock?.('landscape').catch(() => {}); } catch { /* orientation is optional */ }
      return this.native;
    } catch { this.fallback(); return false; }
    finally { this.busy = false; this.sync(); }
  }

  private fallback(): void {
    this.immersive = true;
    const ios = /iPad|iPhone|iPod/.test(this.doc.defaultView?.navigator.userAgent ?? '') ||
      (this.doc.defaultView?.navigator.platform === 'MacIntel' && (this.doc.defaultView?.navigator.maxTouchPoints ?? 0) > 1);
    this.message = ios
      ? 'Полный экран недоступен в этой вкладке. Safari: «Поделиться» → «На экран Домой». Сейчас включён только компактный режим страницы.'
      : 'Браузер не разрешил полный экран. Включён только компактный режим страницы; играть можно без полного экрана.';
    this.sync();
  }

  private sync(): void {
    this.doc.documentElement.classList.toggle('immersive', this.immersive);
    this.doc.documentElement.classList.toggle('native-fullscreen', this.native);
    for (const button of this.buttons) {
      button.textContent = this.native ? 'Выйти из экрана' : this.immersive ? 'Обычный вид' : 'Полный экран';
      button.setAttribute('aria-pressed', String(this.native || this.immersive));
      button.title = this.message || (this.native ? 'Выйти из полноэкранного режима' : 'Полный экран (если поддерживается браузером)');
      if (this.message) button.setAttribute('aria-description', this.message);
      else button.removeAttribute('aria-description');
    }
    for (const note of this.notices) { note.textContent = this.message; note.hidden = !this.message; }
  }

  dispose(): void {
    this.listeners.abort();
    for (const button of this.buttons) button.remove();
    for (const note of this.notices) note.remove();
    this.buttons.clear(); this.notices.clear();
    this.doc.documentElement.classList.remove('immersive', 'native-fullscreen');
  }
}
