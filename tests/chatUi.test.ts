import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, CHAT_IDLE_MS } from '../src/ui/chat';

/** Just the DOM surface used by Chat, so these interaction tests do not require a browser runner. */
class Element extends EventTarget {
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
  };
  children: Element[] = [];
  parent: Element | null = null;
  textContent = '';
  className = '';
  value = '';
  hidden = true;
  focused = false;
  scrollTop = 0;
  scrollHeight = 100;
  get childElementCount(): number { return this.children.length; }
  get firstElementChild(): Element | null { return this.children[0] ?? null; }
  append(...children: Element[]): void { for (const child of children) this.appendChild(child); }
  appendChild(child: Element): void { child.parent = this; this.children.push(child); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren(): void { this.children = []; }
  focus(): void { this.focused = true; }
  blur(): void { this.focused = false; }
  requestSubmit(): void { this.dispatchEvent(new Event('submit', { cancelable: true })); }
}

let elements: Record<string, Element>;
beforeEach(() => {
  vi.useFakeTimers();
  elements = Object.fromEntries(['chat', 'chatMessages', 'chatForm', 'chatInput', 'body'].map(id => [id, new Element()]));
  vi.stubGlobal('document', {
    body: elements.body,
    getElementById: (id: string) => elements[id],
    createElement: () => new Element(),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('chat overlay', () => {
  const setup = (available = true) => {
    const hooks = { available: () => available, send: vi.fn(() => true), focus: vi.fn() };
    return { chat: new Chat(hooks), hooks };
  };

  it('captures typing, sends trimmed text and returns controls on Enter', () => {
    const { chat, hooks } = setup();
    chat.open();
    expect(chat.active).toBe(true);
    expect(elements.chatInput.focused).toBe(true);
    expect(hooks.focus).toHaveBeenLastCalledWith(true);
    const key = new Event('keydown', { cancelable: true, bubbles: true });
    Object.assign(key, { code: 'KeyW' });
    const stop = vi.spyOn(key, 'stopPropagation');
    elements.chat.dispatchEvent(key);
    expect(stop).toHaveBeenCalledOnce();
    elements.chatInput.value = '  Всем привет  ';
    const enter = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Enter', isComposing: false, repeat: false });
    elements.chat.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(hooks.send).toHaveBeenCalledWith('Всем привет');
    expect(elements.chatInput.value).toBe('');
    expect(chat.active).toBe(false);
    expect(hooks.focus).toHaveBeenLastCalledWith(false);
  });

  it('fades after six inactive seconds and restarts the clock on a new message', () => {
    const { chat } = setup();
    chat.receive('A', 'Первое');
    vi.advanceTimersByTime(CHAT_IDLE_MS - 1);
    expect(elements.chat.classes.has('visible')).toBe(true);
    chat.receive('B', 'Второе');
    vi.advanceTimersByTime(CHAT_IDLE_MS - 1);
    expect(elements.chat.classes.has('visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(elements.chat.classes.has('visible')).toBe(false);
  });

  it('closes an idle editor without losing its draft or leaving controls locked', () => {
    const { chat, hooks } = setup();
    chat.open();
    elements.chatInput.value = 'Черновик';
    vi.advanceTimersByTime(CHAT_IDLE_MS);
    expect(chat.active).toBe(false);
    expect(elements.chat.classes.has('visible')).toBe(false);
    expect(elements.chatInput.value).toBe('Черновик');
    expect(hooks.focus).toHaveBeenLastCalledWith(false);
  });

  it('keeps an unsent message in the editor and never renders message text as HTML', () => {
    const { chat, hooks } = setup();
    hooks.send.mockReturnValue(false);
    chat.open();
    elements.chatInput.value = 'test';
    elements.chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(chat.active).toBe(true);
    expect(elements.chatInput.value).toBe('test');
    for (let i = 0; i < 60; i++) chat.receive('<img>', '<script>alert(1)</script>');
    expect(elements.chatMessages.childElementCount).toBe(40);
    expect(elements.chatMessages.children[0].children[0].textContent).toBe('<img>');
    expect(elements.chatMessages.children[0].children[1].textContent).toBe('<script>alert(1)</script>');
    chat.reset();
    expect(elements.chatMessages.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not capture driving controls when not connected', () => {
    const { chat, hooks } = setup(false);
    chat.open();
    expect(chat.active).toBe(false);
    expect(hooks.focus).not.toHaveBeenCalled();
  });
});
