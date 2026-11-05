type Handler<T> = (payload: T) => void;

/** Minimal typed event bus. The sim emits; audio, HUD and FX listen. */
export class Emitter<M> {
  private handlers: { [K in keyof M]?: Handler<M[K]>[] } = {};

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    const list = (this.handlers[type] ??= []);
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const list = this.handlers[type];
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }
}
