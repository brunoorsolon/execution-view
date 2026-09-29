import { exportUrl, type ExportFormat } from '../api.js';
import { clear, h, icon, ICONS } from '../dom.js';
import { absoluteTime, relativeTime, shortHash } from '../format.js';
import type { Tab } from '../route.js';
import { effectiveViewId, problemCount, type AppState } from '../state.js';
import type { View, ViewCtx } from './shared.js';

const EXPORTS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'json', label: 'JSON', hint: 'Full snapshot' },
  { format: 'md', label: 'Markdown', hint: 'Readable plan' },
  { format: 'mmd', label: 'Mermaid', hint: 'Diagram source' },
  { format: 'dot', label: 'DOT', hint: 'Graphviz' },
];

export function createHeader(ctx: ViewCtx): View {
  // ---- row 1
  const select = h('select', {
    class: 'view-select',
    'aria-label': 'View',
    onchange: () => ctx.actions.setView(select.value),
  });
  const repos = h('span', { class: 'repos' });
  const fetched = h('span', { class: 'meta-item fetched' });
  const hash = h('span', { class: 'meta-item hash mono' });
  const refreshBtn = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onclick: () => ctx.actions.refresh() },
    icon(ICONS.refresh),
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', { class: 'btn-label' }, 'Refresh'),
  );
  const refreshError = h(
    'span',
    { class: 'inline-error', role: 'alert', hidden: true },
    h('span', { class: 'inline-error-text' }),
    h(
      'button',
      {
        class: 'btn btn-icon btn-xs',
        type: 'button',
        title: 'Dismiss',
        'aria-label': 'Dismiss error',
        onclick: () => ctx.store.dispatch({ type: 'dismiss-refresh-error' }),
      },
      icon(ICONS.close, 12),
    ),
  );

  const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
  const exportBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: (e: Event) => {
        e.stopPropagation();
        setMenu(menu.hidden);
      },
    },
    icon(ICONS.download),
    'Export',
    icon(ICONS.chevron, 12),
  );
  const exportWrap = h('div', { class: 'export' }, exportBtn, menu);
  function setMenu(open: boolean): void {
    menu.hidden = !open;
    exportBtn.setAttribute('aria-expanded', String(open));
  }
  document.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });

  const row1 = h(
    'div',
    { class: 'header-row header-main' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }),
      'execution-view',
    ),
    select,
    repos,
    h('div', { class: 'spacer' }),
    fetched,
    hash,
    refreshError,
    refreshBtn,
    exportWrap,
  );

  // ---- row 2
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const problemsBadge = h('span', { class: 'badge' }, '0');
  const tabDefs: { tab: Tab; label: string }[] = [
    { tab: 'graph', label: 'Graph' },
    { tab: 'order', label: 'Execution order' },
    { tab: 'problems', label: 'Problems' },
  ];
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  for (const { tab, label } of tabDefs) {
    const btn = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${tab}`,
        onclick: () => ctx.actions.setTab(tab),
      },
      label,
      tab === 'problems' ? problemsBadge : null,
    );
    tabButtons.set(tab, btn);
    tabs.append(btn);
  }

  const stats = h('div', { class: 'stats', 'aria-label': 'Statistics' });
  const filterInput = h('input', {
    class: 'filter-input',
    type: 'search',
    placeholder: 'Filter: text, label:P1, #12, owner/repo#12',
    'aria-label': 'Filter issues',
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: () => ctx.actions.setQuery(filterInput.value),
  });
  const filter = h('label', { class: 'filter' }, icon(ICONS.search), filterInput);
  const row2 = h(
    'div',
    { class: 'header-row header-sub' },
    tabs,
    stats,
    h('div', { class: 'spacer' }),
    filter,
  );

  const el = h('header', { class: 'app-header' }, row1, row2);

  // ---- update
  let fetchedIso: string | null = null;
  let lastViews: unknown = null;
  let lastSnapshot: unknown = null;

  function tick(): void {
    if (fetchedIso !== null)
      fetched.textContent = `fetched ${relativeTime(fetchedIso, Date.now())}`;
  }
  setInterval(tick, 15_000);

  function stat(label: string, value: number, cls: string, title?: string): HTMLElement {
    return h(
      'span',
      { class: 'stat', title: title ?? label },
      h('span', { class: `dot ${cls}` }),
      h('strong', null, String(value)),
      h('span', { class: 'stat-label' }, label),
    );
  }

  return {
    el,
    update(state: AppState) {
      const viewId = effectiveViewId(state);
      const views = state.views ?? [];
      if (lastViews !== state.views) {
        lastViews = state.views;
        clear(select);
        for (const v of views) select.append(h('option', { value: v.id }, v.title));
        select.disabled = views.length <= 1;
      }
      if (viewId !== null && select.value !== viewId) select.value = viewId;
      const view = views.find((v) => v.id === viewId);
      repos.textContent = view ? view.repos.join(', ') : '';
      repos.title = view ? `${view.kind}: ${view.repos.join(', ')}` : '';

      for (const [tab, btn] of tabButtons) {
        const active = state.route.tab === tab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
      }

      const snap = state.snapshot;
      if (lastSnapshot !== snap) {
        lastSnapshot = snap;
        clear(menu);
        if (viewId !== null) {
          for (const ex of EXPORTS) {
            menu.append(
              h(
                'a',
                {
                  class: 'menu-item',
                  role: 'menuitem',
                  href: exportUrl(viewId, ex.format),
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  onclick: () => setMenu(false),
                },
                h('span', null, ex.label),
                h('span', { class: 'muted' }, ex.hint),
              ),
            );
          }
        }
        clear(stats);
        if (snap) {
          const s = snap.plan.stats;
          stats.append(
            stat('total', s.total, 'dot-total', 'Issues in the plan'),
            stat('ready', s.ready, 'status-ready', 'Ready to start'),
            stat('blocked', s.blocked, 'status-blocked', 'Waiting for prerequisites'),
            stat('unschedulable', s.unschedulable, 'status-in-cycle', 'In or blocked by a cycle'),
            stat(
              'external',
              s.external,
              'dot-external',
              'Outside the view, pulled in as prerequisites',
            ),
            stat('waves', s.waves, 'dot-total', 'Parallel batches'),
          );
          fetchedIso = snap.fetchedAt;
          fetched.title = `Fetched at ${absoluteTime(snap.fetchedAt)}`;
          fetched.textContent = `fetched ${relativeTime(snap.fetchedAt, Date.now())}`;
          hash.textContent = shortHash(snap.contentHash);
          hash.title = `Content hash: ${snap.contentHash}`;
          problemsBadge.textContent = String(problemCount(snap));
          problemsBadge.hidden = false;
          problemsBadge.classList.toggle('badge-zero', problemCount(snap) === 0);
        } else {
          fetchedIso = null;
          fetched.textContent = '';
          fetched.title = '';
          hash.textContent = '';
          hash.title = '';
          problemsBadge.hidden = true;
        }
      }

      refreshBtn.disabled = state.refreshing || viewId === null;
      refreshBtn.classList.toggle('busy', state.refreshing);
      const label = refreshBtn.querySelector('.btn-label');
      if (label) label.textContent = state.refreshing ? 'Refreshing' : 'Refresh';
      refreshError.hidden = state.refreshError === null;
      const errText = refreshError.querySelector('.inline-error-text');
      if (errText) errText.textContent = state.refreshError ?? '';
      refreshError.title = state.refreshError ?? '';

      if (document.activeElement !== filterInput && filterInput.value !== state.route.q) {
        filterInput.value = state.route.q;
      }
    },
  };
}
