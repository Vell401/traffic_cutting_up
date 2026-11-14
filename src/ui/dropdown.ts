/*
 * Rounded dropdowns.
 *
 * The control stays a native <select>: it keeps the platform's keyboard behaviour, its accessible
 * name and role, and on phones the system picker. What changes is how it looks. The closed control
 * is styled round with its own chevron, and for mouse users the option list is ours: a rounded panel
 * of rounded rows (with an optional second line of description) instead of the square system popup.
 *
 * The panel is only a picture of the select's options. It never takes focus, picking a row sets the
 * select's value and fires the same input/change events a native choice would.
 */

export interface DropdownOptions {
  /** Second line under an option's name. */
  describe?: (value: string) => string | undefined;
}

const finePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

/** Returns a disposer that removes the listeners and any open panel. */
export function roundedSelect(select: HTMLSelectElement, options: DropdownOptions = {}): () => void {
  select.classList.add('dropdown-select');
  let panel: HTMLDivElement | null = null;

  const mark = (): void => {
    if (!panel) return;
    for (const row of panel.children) row.classList.toggle('selected', (row as HTMLElement).dataset.value === select.value);
    panel.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  const close = (): void => {
    if (!panel) return;
    panel.remove();
    panel = null;
    select.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };

  function outside(event: Event): void {
    const target = event.target as Node | null;
    if (target && (panel?.contains(target) || target === select)) return;
    close();
  }

  const choose = (value: string): void => {
    close();
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const open = (): void => {
    const list = document.createElement('div');
    list.className = 'dropdown-list';
    // A picture of the options for sighted pointer users; assistive technology reads the select itself.
    list.setAttribute('aria-hidden', 'true');
    for (const option of select.options) {
      const row = document.createElement('div');
      row.className = 'dropdown-item';
      row.dataset.value = option.value;
      if (option.disabled) row.classList.add('disabled');
      const name = document.createElement('span');
      name.textContent = option.textContent;
      row.append(name);
      const about = options.describe?.(option.value);
      if (about) {
        const line = document.createElement('small');
        line.textContent = about;
        row.append(line);
      }
      // pointerdown, not click: the select must keep focus, and a click would come after a blur.
      row.addEventListener('pointerdown', event => {
        event.preventDefault();
        if (!option.disabled) choose(option.value);
      });
      list.append(row);
    }
    (document.fullscreenElement ?? document.body).append(list);
    panel = list;
    select.classList.add('open');
    // Under the control, as wide as it; above it when there is no room below.
    const box = select.getBoundingClientRect();
    const gap = 8;
    list.style.minWidth = `${Math.round(box.width)}px`;
    const height = list.offsetHeight;
    const below = window.innerHeight - box.bottom - gap;
    const above = box.top - gap;
    const up = height > below && above > below;
    list.style.maxHeight = `${Math.max(120, Math.floor(up ? above : below) - gap)}px`;
    list.style.left = `${Math.round(Math.max(gap, Math.min(box.left, window.innerWidth - list.offsetWidth - gap)))}px`;
    if (up) list.style.bottom = `${Math.round(window.innerHeight - box.top + gap)}px`;
    else list.style.top = `${Math.round(box.bottom + gap)}px`;
    list.classList.toggle('up', up);
    mark();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  };

  const mousedown = (event: MouseEvent): void => {
    // Touch and pen keep the system picker; so does anything but the primary button.
    if (event.button !== 0 || !finePointer() || select.disabled) return;
    event.preventDefault();
    select.focus();
    if (panel) close();
    else open();
  };

  const keydown = (event: KeyboardEvent): void => {
    if (panel) {
      // Arrows keep changing the native value underneath; these just put the panel away.
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') close();
      return;
    }
    if (!finePointer() || select.disabled) return;
    const opens = event.key === ' ' || event.key === 'Enter' || event.key === 'F4' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'));
    if (!opens) return;
    event.preventDefault();
    open();
  };

  select.addEventListener('mousedown', mousedown);
  select.addEventListener('keydown', keydown);
  select.addEventListener('change', mark);
  select.addEventListener('blur', close);
  return () => {
    close();
    select.removeEventListener('mousedown', mousedown);
    select.removeEventListener('keydown', keydown);
    select.removeEventListener('change', mark);
    select.removeEventListener('blur', close);
    select.classList.remove('dropdown-select');
  };
}
