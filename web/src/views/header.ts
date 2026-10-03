import type { Snapshot } from '../../../src/core/types.js';
import { exportUrl, fetchSession, type ExportFormat } from '../api.js';
import { clear, h, icon, type Child } from '../dom.js';
import {
  hasQualifier,
  matchesQualifier,
  qualifierCount,
  toggleQualifier,
  type Field,
} from '../filter.js';
import { absoluteTime, relativeTime, shortHash } from '../format.js';
import { priorityName } from '../priority.js';
import type { Tab } from '../route.js';
import { effectiveViewId, problemCount, type AppState } from '../state.js';
import { loadTheme, saveTheme, type ThemePref } from '../theme.js';
import { createMenu } from './menu.js';
import {
  getIndex,
  nodeTarget,
  otherLabels,
  visibleKeys,
  type View,
  type ViewCtx,
} from './shared.js';

const EXPORTS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'json', label: 'JSON', hint: 'Full snapshot' },
  { format: 'md', label: 'Markdown', hint: 'Readable plan' },
  { format: 'mmd', label: 'Mermaid', hint: 'Diagram source' },
  { format: 'dot', label: 'DOT', hint: 'Graphviz' },
];

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: 'system', label: 'Match system' },
  { pref: 'light', label: 'Light' },
  { pref: 'dark', label: 'Dark' },
];

type Facet = [field: Field, value: string, label: string];

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** The filter menu's groups for a snapshot: every value present in the plan. */
function facetGroups(snapshot: Snapshot, multiRepo: boolean): [string, Facet[]][] {
  const nodes = snapshot.plan.nodes;
  const groups: [string, Facet[]][] = [
    [
      'Status',
      [
        ['status', 'ready', 'Ready'],
        ['status', 'blocked', 'Blocked'],
        ['status', 'cycle', 'In cycle'],
        ['status', 'blocked-by-cycle', 'Blocked by cycle'],
        ...(snapshot.plan.stats.external > 0
          ? ([['status', 'external', 'External']] as Facet[])
          : []),
      ],
    ],
    [
      'Priority',
      [
        ...snapshot.priorityLabels.map((p): Facet => ['priority', p, p]),
        ['priority', 'none', 'No priority'],
      ],
    ],
    [
      'Assignee',
      [
        ...uniqSorted(nodes.flatMap((n) => n.assignees)).map((a): Facet => [
          'assignee',
          a,
          `@${a}`,
        ]),
        ['no', 'assignee', 'Unassigned'],
      ],
    ],
    [
      'Milestone',
      [
        ...uniqSorted(nodes.flatMap((n) => (n.milestone ? [n.milestone] : []))).map((m): Facet => [
          'milestone',
          m,
          m,
        ]),
        ['no', 'milestone', 'No milestone'],
      ],
    ],
    [
      'Label',
      uniqSorted(nodes.flatMap((n) => otherLabels(n, priorityName(snapshot, n)))).map(
        (l): Facet => ['label', l, l],
      ),
    ],
  ];
  if (multiRepo) {
    groups.push([
      'Repository',
      uniqSorted(nodes.map((n) => `${n.repo.owner}/${n.repo.repo}`)).map((r): Facet => [
        'repo',
        r,
        r,
      ]),
    ]);
  }
  groups.push(['Path', [['is', 'critical', 'On the critical path']]]);
  return groups.filter(([, facets]) => facets.length > 0);
}

export function createHeader(ctx: ViewCtx): View {
  // ------------------------------------------------------------- top bar
  const select = h('select', {
    id: 'view-select',
    'aria-label': 'View',
    disabled: true,
    onchange: () => ctx.actions.setView(select.value),
  });
  const repos = h('span', { class: 'repos' });
  const fetched = h('span', { class: 'fetched' });
  const hash = h('span', { class: 'hash' });
  const freshness = h('div', { class: 'freshness' }, fetched, hash);

  const refreshLabel = h('span', { class: 'btn-label' }, 'Refresh');
  const refreshBtn = h(
    'button',
    { class: 'btn', type: 'button', onclick: () => ctx.actions.refresh() },
    icon('refresh'),
    refreshLabel,
  );
  const refreshErrorText = h('span', { class: 'inline-error-text' });
  const refreshError = h(
    'span',
    { class: 'inline-error', role: 'alert', hidden: true },
    icon('alert', 14),
    refreshErrorText,
    h(
      'button',
      {
        class: 'btn btn-ghost btn-icon btn-xs',
        type: 'button',
        title: 'Dismiss',
        'aria-label': 'Dismiss error',
        onclick: () => ctx.store.dispatch({ type: 'dismiss-refresh-error' }),
      },
      icon('close', 12),
    ),
  );

  const exportBtn = h(
    'button',
    { class: 'btn', type: 'button', disabled: true },
    icon('download'),
    h('span', { class: 'btn-label' }, 'Export'),
  );
  const exportMenu = createMenu(exportBtn, () => {
    const viewId = effectiveViewId(ctx.store.get());
    if (viewId === null) return [];
    return [
      h('div', { class: 'menu-label' }, 'Download this snapshot'),
      ...EXPORTS.map((ex) =>
        h(
          'a',
          {
            class: 'menu-item',
            role: 'menuitem',
            href: exportUrl(viewId, ex.format),
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          h('span', null, ex.label),
          h('span', { class: 'hint' }, ex.hint),
        ),
      ),
    ];
  });

  let theme = loadTheme();
  let username: string | null = null;
  fetchSession().then(
    (s) => (username = s.username),
    () => undefined, // no login configured
  );
  const themeMenu = createMenu(
    h(
      'button',
      {
        class: 'btn btn-ghost btn-icon',
        type: 'button',
        title: 'Theme',
        'aria-label': 'Theme',
      },
      icon('theme'),
    ),
    () => [
      h('div', { class: 'menu-label' }, 'Theme'),
      ...THEMES.map(({ pref, label }) =>
        h(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(theme === pref),
            onclick: () => {
              theme = pref;
              saveTheme(pref);
            },
          },
          label,
        ),
      ),
      ...(username === null
        ? []
        : [
            h('div', { class: 'menu-label' }, `Signed in as ${username}`),
            h(
              'form',
              { method: 'post', action: 'logout' },
              h('button', { class: 'menu-item', type: 'submit', role: 'menuitem' }, 'Log out'),
            ),
          ]),
    ],
  );

  const topbar = h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('graph', 15)),
      h('span', { class: 'brand-name' }, 'execution-view'),
    ),
    h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
    h('div', { class: 'view-switch' }, select, icon('chevron', 13), repos),
    h('div', { class: 'spacer' }),
    freshness,
    refreshError,
    refreshBtn,
    exportMenu.wrap,
    themeMenu.wrap,
  );

  // -------------------------------------------------------------- tab bar
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const problemsBadge = h('span', { class: 'count', hidden: true });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  for (const [tab, label, ic] of [
    ['graph', 'Graph', 'graph'],
    ['order', 'Execution order', 'order'],
    ['problems', 'Problems', 'warning'],
  ] as const) {
    const btn = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${tab}`,
        onclick: () => ctx.actions.setTab(tab),
      },
      icon(ic, 14),
      label,
      tab === 'problems' ? problemsBadge : null,
    );
    tabButtons.set(tab, btn);
    tabs.append(btn);
  }

  const filterCount = h('span', { class: 'fcount' });
  const facetMenu = createMenu(
    h(
      'button',
      {
        class: 'btn',
        id: 'filter-button',
        type: 'button',
        title: 'Filter by status, priority, people and more',
      },
      icon('filter'),
      h('span', { class: 'btn-label' }, 'Filter'),
      filterCount,
    ),
    () => buildFacets(),
    { keepOpen: true, className: 'facet-menu' },
  );

  function buildFacets(): Child[] {
    const state = ctx.store.get();
    const snapshot = state.snapshot;
    const index = getIndex(state);
    if (snapshot === null || index === null) return [h('div', { class: 'menu-label' }, 'Loading…')];
    const q = state.route.q;
    const targets = snapshot.plan.nodes.map((n) => nodeTarget(n, snapshot, index));
    const visible = visibleKeys(state, index);
    return [
      h(
        'div',
        { class: 'facet-grid' },
        ...facetGroups(snapshot, index.multiRepo).map(([title, facets]) =>
          h(
            'div',
            { class: 'facet-group' },
            h('div', { class: 'menu-label' }, title),
            h(
              'div',
              { class: 'facet-opts' },
              ...facets.map(([field, value, label]) => {
                const on = hasQualifier(q, field, value);
                const count = targets.filter((t) =>
                  matchesQualifier(field, value.toLowerCase(), t),
                ).length;
                return h(
                  'button',
                  {
                    class: 'facet-opt',
                    type: 'button',
                    role: 'menuitemcheckbox',
                    'aria-checked': String(on),
                    onclick: () =>
                      ctx.actions.setQuery(toggleQualifier(ctx.store.get().route.q, field, value)),
                  },
                  h('span', { class: 'cb', 'aria-hidden': 'true' }, on ? icon('check', 11) : null),
                  h('span', { class: 'fl', title: label }, label),
                  h('span', { class: 'fc' }, String(count)),
                );
              }),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'facet-foot' },
        h(
          'span',
          { class: 'muted' },
          'Or type it: ',
          h('code', null, 'status:blocked @bob -label:docs'),
        ),
        h(
          'span',
          { class: 'fm' },
          visible === null ? '' : `${visible.size} of ${snapshot.plan.nodes.length} match`,
        ),
        h(
          'button',
          {
            class: 'link-btn',
            type: 'button',
            disabled: q.trim() === '',
            onclick: () => ctx.actions.setQuery(''),
          },
          'Clear all',
        ),
      ),
    ];
  }

  const filterInput = h('input', {
    id: 'filter-input',
    class: 'filter-input',
    type: 'search',
    placeholder: 'Search, or status:ready @bob label:P0',
    title:
      'Text matches title or key. Qualifiers: status:, priority:, label:, @person, milestone:, repo:, is:critical, no:assignee; a leading - excludes. Press / to focus.',
    'aria-label': 'Filter issues',
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: () => ctx.actions.setQuery(filterInput.value),
  });
  const matchCount = h('span', { class: 'match', hidden: true });
  const clearBtn = h(
    'button',
    {
      class: 'filter-clear',
      type: 'button',
      title: 'Clear filter',
      'aria-label': 'Clear filter',
      hidden: true,
      onclick: (e: Event) => {
        e.preventDefault();
        ctx.actions.setQuery('');
        filterInput.focus();
      },
    },
    icon('close', 13),
  );
  const filter = h(
    'label',
    { class: 'filter' },
    icon('search'),
    filterInput,
    matchCount,
    clearBtn,
    h('span', { class: 'kbd', 'aria-hidden': 'true' }, '/'),
  );

  const tabbar = h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Sections' },
    tabs,
    h('div', { class: 'spacer' }),
    facetMenu.wrap,
    filter,
  );

  const el = h('header', { class: 'app-header' }, topbar, tabbar);

  // ------------------------------------------------------------- update
  let fetchedIso: string | null = null;
  let lastViews: unknown = null;
  setInterval(() => {
    if (fetchedIso !== null)
      fetched.textContent = `Fetched ${relativeTime(fetchedIso, Date.now())}`;
  }, 15_000);

  return {
    el,
    update(state: AppState, prev: AppState) {
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
      repos.textContent = view ? view.repos.join(' · ') : '';
      repos.title = view ? `${view.kind}: ${view.repos.join(', ')}` : '';

      for (const [tab, btn] of tabButtons) {
        const active = state.route.tab === tab;
        btn.setAttribute('aria-selected', String(active));
      }

      const snap = state.snapshot;
      if (snap !== prev.snapshot || fetchedIso === null) {
        if (snap) {
          fetchedIso = snap.fetchedAt;
          fetched.title = `Fetched at ${absoluteTime(snap.fetchedAt)}`;
          fetched.textContent = `Fetched ${relativeTime(snap.fetchedAt, Date.now())}`;
          hash.textContent = shortHash(snap.contentHash);
          hash.title = `Content hash ${snap.contentHash}`;
          const problems = problemCount(snap);
          problemsBadge.textContent = String(problems);
          problemsBadge.hidden = problems === 0;
        } else {
          fetchedIso = null;
          problemsBadge.hidden = true;
        }
      }
      freshness.hidden = snap === null;

      refreshBtn.disabled = state.refreshing || viewId === null;
      exportBtn.disabled = viewId === null;
      refreshBtn.classList.toggle('busy', state.refreshing);
      refreshLabel.textContent = state.refreshing ? 'Refreshing' : 'Refresh';
      refreshError.hidden = state.refreshError === null;
      refreshErrorText.textContent = state.refreshError ?? '';
      refreshError.title = state.refreshError ?? '';

      const q = state.route.q;
      if (document.activeElement !== filterInput && filterInput.value !== q) filterInput.value = q;
      clearBtn.hidden = q.trim() === '';
      const index = getIndex(state);
      const visible = index === null ? null : visibleKeys(state, index);
      matchCount.hidden = visible === null || snap === null;
      if (visible !== null && snap !== null) {
        matchCount.textContent = `${visible.size} of ${snap.plan.nodes.length}`;
      }
      const qc = qualifierCount(q);
      filterCount.textContent = qc > 0 ? String(qc) : '';
      facetMenu.wrap.firstElementChild?.classList.toggle('active', qc > 0);
      if (q !== prev.route.q || snap !== prev.snapshot) facetMenu.refresh();
    },
  };
}
