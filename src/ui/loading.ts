/** Percentages mark completed preparation stages; asset progress comes from transferred bytes. */
class LoadingScreen {
  private readonly root = document.getElementById('loading')!;
  private readonly bar = document.getElementById('loadingBar')!;
  private readonly percent = document.getElementById('loadingPercent')!;
  private readonly label = document.getElementById('loadingLabel')!;
  private readonly action = document.getElementById('loadingAction') as HTMLButtonElement;
  private progress = 0;
  private revision = 0;
  context = 'boot';
  active = true;

  private lockUI(locked: boolean): void {
    for (const element of document.body.children)
      if (element instanceof HTMLElement && element !== this.root) element.inert = locked;
  }

  begin(context: string, title: string): void {
    this.context = context; this.active = true; this.progress = 0; this.revision++;
    this.lockUI(true);
    this.root.hidden = false; this.root.classList.remove('leaving', 'failed');
    this.root.setAttribute('aria-busy', 'true');
    document.getElementById('loadingTitle')!.textContent = title;
    this.action.hidden = true;
    this.set(0, 'Подготовка');
  }

  set(value: number, text: string): void {
    this.progress = Math.max(this.progress, Math.min(100, Math.round(value)));
    this.bar.style.width = `${this.progress}%`;
    this.percent.textContent = `${this.progress}%`;
    this.root.querySelector('[role="progressbar"]')!.setAttribute('aria-valuenow', String(this.progress));
    this.label.textContent = text;
  }

  async stage(value: number, text: string): Promise<void> {
    this.set(value, text);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  finish(): void {
    if (!this.active) return;
    const revision = this.revision;
    this.set(100, 'Готово. Хорошей дороги!');
    this.root.setAttribute('aria-busy', 'false');
    // Briefly display the completed state, then reveal the already-rendered scene.
    setTimeout(() => {
      if (revision !== this.revision) return;
      this.root.classList.add('leaving');
      setTimeout(() => {
        if (revision !== this.revision) return;
        this.root.hidden = true; this.active = false; this.lockUI(false);
      }, 650);
    }, 320);
  }

  fail(text: string, retry: () => void = () => location.reload(), action = 'Повторить загрузку'): void {
    this.revision++;
    this.root.classList.remove('leaving'); this.root.classList.add('failed');
    this.root.setAttribute('aria-busy', 'false');
    this.label.textContent = text;
    this.action.textContent = action; this.action.hidden = false;
    this.action.onclick = () => { this.root.hidden = true; this.active = false; this.lockUI(false); retry(); };
  }
}

export const loading = new LoadingScreen();
