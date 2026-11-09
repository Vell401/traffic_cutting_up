/** Top-level navigation only; leaderboard/log filters are deliberately separate. */
export const ADMIN_TABS = [
  { id: 'overview', label: 'Обзор и игроки' },
  { id: 'traffic', label: 'Трафик' },
  { id: 'tuning', label: 'Тюнинг' },
  { id: 'radio', label: 'Радио' },
  { id: 'leaderboard', label: 'Лидерборд' },
  { id: 'logs', label: 'Журнал' },
] as const;
export type AdminTab = typeof ADMIN_TABS[number]['id'];
type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function isAdminTab(value: unknown): value is AdminTab {
  return ADMIN_TABS.some(tab => tab.id === value);
}

export function tabForKey(current: AdminTab, key: string): AdminTab | null {
  const index = ADMIN_TABS.findIndex(tab => tab.id === current);
  if (key === 'Home') return ADMIN_TABS[0].id;
  if (key === 'End') return ADMIN_TABS[ADMIN_TABS.length - 1].id;
  if (key === 'ArrowRight') return ADMIN_TABS[(index + 1) % ADMIN_TABS.length].id;
  if (key === 'ArrowLeft') return ADMIN_TABS[(index + ADMIN_TABS.length - 1) % ADMIN_TABS.length].id;
  return null;
}

/** A non-secret session tag, not another copy of the bearer token in storage. */
function loginTag(login: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < login.length; i++) {
    a = Math.imul(a ^ login.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ login.charCodeAt(i);
  }
  return `${a >>> 0}-${b >>> 0}`;
}

export function tabStorageKey(server: string): string {
  return `tcu.admin.tab:${encodeURIComponent(server)}`;
}

export function loadAdminTab(storage: TabStorage | undefined, server: string, login: string): AdminTab {
  try {
    const saved = JSON.parse(storage?.getItem(tabStorageKey(server)) ?? 'null');
    if (saved?.login === loginTag(login) && isAdminTab(saved.tab)) return saved.tab;
  } catch { /* blocked storage or an old/corrupt preference */ }
  return 'overview';
}

export function saveAdminTab(storage: TabStorage | undefined, server: string, login: string, tab: AdminTab): void {
  try {
    storage?.setItem(tabStorageKey(server), JSON.stringify({ login: loginTag(login), tab }));
  } catch { /* navigation works without storage */ }
}

export function adminTabNavigation(): string {
  return `<nav class="admin-tabs" role="tablist" aria-label="Разделы админки" aria-orientation="horizontal">${ADMIN_TABS.map(tab =>
    `<button type="button" role="tab" id="admin-tab-${tab.id}" aria-controls="admin-panel-${tab.id}" aria-selected="false" tabindex="-1" data-admin-tab="${tab.id}">${tab.label}</button>`).join('')}</nav>`;
}

/** Panels are mounted once by the caller. Switching only changes hidden/ARIA. */
export function mountAdminTabs(root: HTMLElement, options: {
  server: string;
  login: string;
  storage?: TabStorage;
  onChange: (tab: AdminTab, previous: AdminTab | null) => void;
}): { readonly selected: AdminTab; destroy: () => void } {
  const nav = root.querySelector<HTMLElement>('.admin-tabs')!;
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>('[data-admin-tab]')];
  let selected = loadAdminTab(options.storage, options.server, options.login);
  const activate = (tab: AdminTab, focus: boolean, initial = false) => {
    const previous = initial ? null : selected;
    selected = tab;
    for (const button of buttons) {
      const active = button.dataset.adminTab === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(`#${button.getAttribute('aria-controls')}`)!;
      panel.hidden = !active;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.tabIndex = 0;
      if (active && focus) {
        button.focus({ preventScroll: true });
        button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
    saveAdminTab(options.storage, options.server, options.login, tab);
    if (initial || previous !== tab) options.onChange(tab, previous);
  };
  const click = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-admin-tab]');
    if (isAdminTab(button?.dataset.adminTab)) activate(button.dataset.adminTab, true);
  };
  const keydown = (event: KeyboardEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-admin-tab]');
    if (!isAdminTab(button?.dataset.adminTab) || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = tabForKey(button.dataset.adminTab, event.key);
    if (!next) return;
    event.preventDefault();
    activate(next, true);
  };
  nav.addEventListener('click', click);
  nav.addEventListener('keydown', keydown);
  activate(selected, false, true);
  return { get selected() { return selected; }, destroy: () => {
    nav.removeEventListener('click', click);
    nav.removeEventListener('keydown', keydown);
  } };
}
