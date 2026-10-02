import { append, clear, h, type Child } from '../dom.js';

export interface Menu {
  wrap: HTMLElement;
  isOpen(): boolean;
  /** Rebuilds the content (when open). */
  refresh(): void;
  close(): void;
}

const openMenus = new Set<Menu>();

document.addEventListener('click', () => {
  for (const m of [...openMenus]) m.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const m of [...openMenus]) m.close();
});

/**
 * A button with a popover menu. `build` returns the content each time it opens
 * (and on `refresh`). With `keepOpen`, clicks inside do not close it (checkbox
 * menus); otherwise any click closes it.
 */
export function createMenu(
  button: HTMLButtonElement,
  build: () => Child[],
  opts: { keepOpen?: boolean; className?: string } = {},
): Menu {
  const panel = h('div', {
    class: `menu ${opts.className ?? ''}`.trim(),
    role: 'menu',
    hidden: true,
  });
  const wrap = h('div', { class: 'menu-wrap' }, button, panel);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  function render(): void {
    clear(panel);
    append(panel, build());
  }

  const menu: Menu = {
    wrap,
    isOpen: () => !panel.hidden,
    refresh() {
      if (!panel.hidden) render();
    },
    close() {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      openMenus.delete(menu);
    },
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !panel.hidden;
    for (const m of [...openMenus]) m.close();
    if (wasOpen) return;
    render();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openMenus.add(menu);
    panel.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  });
  if (opts.keepOpen) panel.addEventListener('click', (e) => e.stopPropagation());
  return menu;
}
