/** Small event/DOM fixture. Tests execute the production controllers without a DOM dependency. */
export class ElementStub extends EventTarget {
  readonly children: ElementStub[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
  };
  readonly captures = new Set<number>();
  parentElement: ElementStub | null = null;
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  type = '';
  title = '';
  rect = { left: 0, width: 200 };
  append(...nodes: ElementStub[]): void {
    for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; }
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getBoundingClientRect(): { left: number; width: number } { return this.rect; }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
  click(): void { this.dispatchEvent(new Event('click')); }
  blur(): void {}
  remove(): void {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  find(control: string): ElementStub {
    if (this.dataset.touch === control) return this;
    for (const child of this.children) { try { return child.find(control); } catch { /* search next */ } }
    throw new Error(`Missing touch control ${control}`);
  }
}

export class DocumentStub extends EventTarget {
  readonly documentElement = new ElementStub();
  readonly body = new ElementStub();
  hidden = false;
  fullscreenElement: ElementStub | null = null;
  defaultView = { navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 }, screen: { orientation: {} } };
  createElement(): ElementStub { return new ElementStub(); }
}

export function event(target: EventTarget, type: string, values: object = {}): Event {
  const e = Object.assign(new Event(type, { cancelable: true }), values);
  target.dispatchEvent(e);
  return e;
}
