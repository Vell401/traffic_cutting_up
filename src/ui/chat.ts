/** A small bounded chat log; idle time is real time, even while the solo simulation is paused. */
export const CHAT_IDLE_MS = 6000;
const MAX_MESSAGES = 40;

export interface ChatHooks {
  available(): boolean;
  send(text: string): boolean;
  focus(active: boolean): void;
}

export class Chat {
  private readonly root = document.getElementById('chat')!;
  private readonly messages = document.getElementById('chatMessages')!;
  private readonly form = document.getElementById('chatForm') as HTMLFormElement;
  private readonly input = document.getElementById('chatInput') as HTMLInputElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  active = false;

  constructor(private readonly hooks: ChatHooks) {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (text && !hooks.send(text)) {
        this.receive('Система', 'Сообщение не отправлено. Проверьте соединение или повторите чуть позже.', true);
        this.touch();
        return;
      }
      this.input.value = '';
      this.close();
    });
    this.root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      this.touch();
      if (event.code === 'Escape') { event.preventDefault(); this.close(); }
      else if (event.code === 'Enter' && !event.isComposing) {
        event.preventDefault();
        if (!event.repeat) this.form.requestSubmit();
      }
    });
    this.root.addEventListener('keyup', (event) => event.stopPropagation());
    this.input.addEventListener('input', () => this.touch());
    this.root.addEventListener('pointerdown', () => this.touch());
    this.messages.addEventListener('scroll', () => { if (this.active) this.touch(); });
  }

  open(): void {
    if (this.active) return;
    if (!this.hooks.available()) {
      this.receive('Система', 'Общий чат доступен после подключения к серверу.', true);
      return;
    }
    this.active = true;
    this.root.classList.add('editing');
    document.body.classList.add('chatting');
    this.form.hidden = false;
    this.hooks.focus(true);
    this.input.focus({ preventScroll: true });
    this.touch();
  }

  close(): void {
    if (this.active) {
      this.active = false;
      this.root.classList.remove('editing');
      document.body.classList.remove('chatting');
      this.form.hidden = true;
      this.input.blur();
      this.hooks.focus(false);
    }
    this.touch();
  }

  receive(name: string, text: string, system = false): void {
    const row = document.createElement('div');
    row.className = `chat-message${system ? ' system' : ''}`;
    const author = document.createElement('b');
    author.textContent = name;
    const body = document.createElement('span');
    body.textContent = text;
    row.append(author, body);
    this.messages.appendChild(row);
    while (this.messages.childElementCount > MAX_MESSAGES) this.messages.firstElementChild!.remove();
    this.messages.scrollTop = this.messages.scrollHeight;
    this.touch();
  }

  reset(): void {
    this.close();
    clearTimeout(this.timer);
    this.input.value = '';
    this.messages.replaceChildren();
    this.root.classList.remove('visible');
  }

  private touch(): void {
    clearTimeout(this.timer);
    this.root.classList.add('visible');
    this.timer = setTimeout(() => {
      this.close();
      clearTimeout(this.timer);
      this.root.classList.remove('visible');
    }, CHAT_IDLE_MS);
  }
}
