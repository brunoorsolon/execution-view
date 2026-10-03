import type { IssueKey, PlanNode, Snapshot } from '../../../src/core/types.js';
import { clear, h, icon } from '../dom.js';
import { plural, shortKey } from '../format.js';
import { cyclePath } from '../graph-model.js';
import { orderingExplanation } from '../ordering.js';
import { priorityName } from '../priority.js';
import type { SnapshotIndex } from '../state.js';
import {
  avatars,
  getIndex,
  isVisible,
  issueLink,
  labelChip,
  otherLabels,
  priorityTag,
  statusBadges,
  visibleKeys,
  type View,
  type ViewCtx,
} from './shared.js';

const COLS = 7;

interface Group {
  tr: HTMLTableRowElement;
  count: HTMLElement;
  text: string;
  keys: readonly IssueKey[];
}

export function createOrderView(ctx: ViewCtx): View {
  const root = h('div', { class: 'pane pane-scroll order-pane' });
  const note = h('p', null);
  const noMatch = h(
    'div',
    { class: 'state-center', hidden: true },
    h(
      'div',
      { class: 'box' },
      h('h2', null, 'No issues match this filter'),
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => ctx.actions.setQuery('') },
        'Clear filter',
      ),
    ),
  );
  const tableBox = h('div', { class: 'table-box' });
  root.append(
    h('div', { class: 'order-wrap' }, h('div', { class: 'order-intro' }, note), noMatch, tableBox),
  );

  let builtFor: Snapshot | null = null;
  let filteredFor: Set<IssueKey> | null | undefined;
  let rows = new Map<IssueKey, HTMLTableRowElement>();
  let groups: Group[] = [];
  let lastSelected: IssueKey | null = null;

  function keyButton(k: IssueKey, index: SnapshotIndex): HTMLElement {
    const n = index.nodes.get(k);
    return h(
      'button',
      {
        class: 'key-btn',
        type: 'button',
        title: n ? `${k}: ${n.title}` : k,
        onclick: (e: Event) => {
          e.stopPropagation();
          ctx.actions.select(k);
        },
      },
      shortKey(k, index.multiRepo),
    );
  }

  function row(
    n: PlanNode,
    snapshot: Snapshot,
    index: SnapshotIndex,
    reason: string | null,
  ): HTMLTableRowElement {
    const prio = priorityName(snapshot, n);
    const critical = index.criticalNodes.has(n.key);
    const tr = h(
      'tr',
      { class: `row${n.external ? ' external' : ''}`, 'data-key': n.key, tabindex: 0 },
      h(
        'td',
        { class: 'c-num' },
        n.order === null ? '–' : String(n.order + 1),
        critical
          ? h(
              'span',
              {
                class: 'crit',
                title: 'On the critical path',
                'aria-label': 'On the critical path',
              },
              icon('critical', 13),
            )
          : null,
      ),
      h(
        'td',
        { class: 'c-issue' },
        issueLink(n.key, n.url, shortKey(n.key, index.multiRepo), `${n.key} (opens the issue)`),
      ),
      h(
        'td',
        { class: 'c-title' },
        h('div', { class: 't' }, n.title),
        h(
          'div',
          { class: 'labels' },
          prio !== null ? priorityTag(prio, n.priority) : null,
          n.external ? h('span', { class: 'badge st-external' }, 'External') : null,
          ...otherLabels(n, prio).map((l) => labelChip(l)),
        ),
        reason !== null ? h('div', { class: 'reason' }, reason) : null,
      ),
      h('td', { class: 'c-status' }, statusBadges(n)),
      h('td', { class: 'c-people' }, avatars(n.assignees)),
      h(
        'td',
        { class: 'c-blocked' },
        n.blockedBy.length > 0
          ? h('div', { class: 'keys' }, ...n.blockedBy.map((k) => keyButton(k, index)))
          : h('span', { class: 'muted' }, 'Nothing'),
      ),
      h(
        'td',
        { class: 'c-act' },
        h(
          'button',
          {
            class: 'btn btn-ghost btn-icon',
            type: 'button',
            title: 'Show in graph',
            'aria-label': `Show ${n.key} in graph`,
            onclick: (e: Event) => {
              e.stopPropagation();
              ctx.actions.showInGraph(n.key);
            },
          },
          icon('graph'),
        ),
      ),
    );
    tr.addEventListener('click', () =>
      ctx.actions.select(ctx.store.get().selected === n.key ? null : n.key),
    );
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === tr) ctx.actions.select(n.key);
    });
    rows.set(n.key, tr);
    return tr;
  }

  function groupRow(
    cls: string,
    title: string,
    text: string,
    keys: readonly IssueKey[],
  ): HTMLTableRowElement {
    const count = h('span', null, text);
    const tr = h(
      'tr',
      { class: `group${cls}` },
      h(
        'td',
        { colspan: COLS },
        h('div', { class: 'group-head' }, h('strong', null, title), count),
      ),
    );
    groups.push({ tr, count, text, keys });
    return tr;
  }

  function unschedulableReason(n: PlanNode, snapshot: Snapshot, index: SnapshotIndex): string {
    if (n.status === 'in-cycle') {
      const scc = snapshot.plan.cycles.find((c) => c.includes(n.key));
      if (scc) {
        const { path } = cyclePath(scc, snapshot.plan.edges);
        const loop = path.length > 0 ? path : scc;
        return `Part of the loop ${loop.map((k) => shortKey(k, index.multiRepo)).join(' → ')}`;
      }
      return 'Part of a dependency cycle';
    }
    const via = n.blockedBy.filter((k) => index.unschedulable.has(k));
    return via.length > 0
      ? `Waits on the cycle through ${via.map((k) => shortKey(k, index.multiRepo)).join(', ')}`
      : 'Waits on a dependency cycle';
  }

  function build(snapshot: Snapshot, index: SnapshotIndex): void {
    note.textContent = orderingExplanation(snapshot.orderingMode);
    rows = new Map();
    groups = [];
    const { plan } = snapshot;
    const tbody = h('tbody');
    plan.waves.forEach((wave, i) => {
      tbody.append(
        groupRow(
          '',
          `Wave ${i + 1}`,
          wave.length > 1 ? `${wave.length} issues, can run in parallel` : '1 issue',
          wave,
        ),
      );
      const sorted = [...wave].sort(
        (a, b) => (index.nodes.get(a)?.order ?? 0) - (index.nodes.get(b)?.order ?? 0),
      );
      for (const key of sorted) {
        const n = index.nodes.get(key);
        if (n) tbody.append(row(n, snapshot, index, null));
      }
    });
    if (plan.unschedulable.length > 0) {
      tbody.append(
        groupRow(
          ' unsched',
          'Unschedulable',
          `${plural(plan.unschedulable.length, 'issue')}. They can be ordered once the cycle is broken.`,
          plan.unschedulable,
        ),
      );
      for (const key of plan.unschedulable) {
        const n = index.nodes.get(key);
        if (n) tbody.append(row(n, snapshot, index, unschedulableReason(n, snapshot, index)));
      }
    }
    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', { class: 'c-num' }, '#'),
        h('th', { class: 'c-issue' }, 'Issue'),
        h('th', { class: 'c-title' }, 'Title'),
        h('th', { class: 'c-status' }, 'Status'),
        h('th', { class: 'c-people' }, 'Assignees'),
        h('th', { class: 'c-blocked' }, 'Blocked by'),
        h('th', { class: 'c-act' }, h('span', { class: 'sr-only' }, 'Actions')),
      ),
    );
    clear(tableBox);
    tableBox.append(h('table', { class: 'order' }, head, tbody));
  }

  function applyFilter(keys: Set<IssueKey> | null): void {
    for (const [key, tr] of rows) tr.hidden = !isVisible(keys, key);
    for (const g of groups) {
      const shown = keys === null ? g.keys.length : g.keys.filter((k) => keys.has(k)).length;
      g.tr.hidden = shown === 0;
      g.count.textContent = shown < g.keys.length ? `${shown} of ${g.keys.length} shown` : g.text;
    }
    const empty = keys !== null && keys.size === 0;
    noMatch.hidden = !empty;
    tableBox.hidden = empty;
  }

  return {
    el: root,
    update(state) {
      const tabVisible = state.route.tab === 'order';
      root.hidden = !tabVisible;
      const index = getIndex(state);
      if (state.snapshot === null || index === null) return;
      if (builtFor !== state.snapshot) {
        build(state.snapshot, index);
        builtFor = state.snapshot;
        filteredFor = undefined;
        lastSelected = null;
      }
      const keys = visibleKeys(state, index);
      if (filteredFor !== keys) {
        filteredFor = keys;
        applyFilter(keys);
      }
      for (const [key, tr] of rows) tr.classList.toggle('selected', key === state.selected);
      if (tabVisible && state.selected !== null && state.selected !== lastSelected) {
        rows.get(state.selected)?.scrollIntoView({ block: 'nearest' });
      }
      lastSelected = state.selected;
    },
  };
}
