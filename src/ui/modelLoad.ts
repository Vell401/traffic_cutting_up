import { onModelLoad, type ModelLoad } from '../render/car';

const MB = 1024 * 1024;

/**
 * Download progress of a heavy car model: a line under the car choice in the menu and a small
 * toast at the bottom while driving. Both go away once the model is in.
 */
export function initModelLoad(): void {
  const els = ['carLoad', 'modelLoad'].map((id) => document.getElementById(id)!);
  let hideTimer = 0;
  onModelLoad((s: ModelLoad) => {
    window.clearTimeout(hideTimer);
    const pct = s.done ? 100 : Math.min(99, Math.floor((s.loaded / s.total) * 100));
    const text = s.failed
      ? `${s.name}: модель не загрузилась, обновите страницу`
      : s.done
        ? `${s.name} загружена`
        : s.unpacking
          ? `${s.name}: распаковка…`
          : `Загрузка ${s.name} · ${pct}% · ${(s.loaded / MB).toFixed(0)} из ${(s.total / MB).toFixed(0)} МБ`;
    for (const el of els) {
      el.hidden = false;
      el.classList.toggle('bad', s.failed);
      (el.querySelector('.lbar i') as HTMLElement).style.width = `${pct}%`;
      el.querySelector('span')!.textContent = text;
    }
    if (s.done) hideTimer = window.setTimeout(() => els.forEach((el) => (el.hidden = true)), 1500);
  });
}
