import type { IssueKey, PlanNode, Snapshot } from '../../../src/core/types.js';
import { clear, h, icon, ICONS, type Child } from '../dom.js';
import { displayKey, plural, statusLabel } from '../format.js';
import { cyclePath } from '../graph-model.js';
import type { SnapshotIndex } from '../state.js';
import {
  filteredOut,
  getIndex,
  issueLink,
  labelChip,
  statusPill,
  type View,
  type ViewCtx,
} from './shared.js';

const MAX_LABELS = 3;

export function createOrderView(ctx: ViewCtx): View {
  const root = h('div', { class: 'order-pane' });
  const scroller = h('div', { class: 'table-scroll' });
  root.append(scroller);

  let builtFor: Snapshot | null = null;
  let rows = new Map<IssueKey, HTMLTableRowElement>();
  let lastSelected: IssueKey | null = null;

  function labelCell(n: PlanNode): HTMLElement {
    const shown = n.labels.slice(0, MAX_LABELS);
    const rest = n.labels.length - shown.length;
    return h(
      'span',
      { class: 'chips' },
      ...shown.map((l) => labelChip(l)),
      rest > 0
        ? h(
            'span',
            { class: 'chip chip-more', title: n.labels.slice(MAX_LABELS).join(', ') },
            `+${rest}`,
          )
        : null,
    );
  }

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
      displayKey(k, index.multiRepo),
    );
  }

  function row(n: PlanNode, index: SnapshotIndex, reason: string | null): HTMLTableRowElement {
    const critical = index.criticalNodes.has(n.key);
    const tr = h(
      'tr',
      {
        class: `row${critical ? ' critical' : ''}${n.external ? ' external' : ''}`,
        'data-key': n.key,
      },
      h(
        'td',
        { class: 'col-num' },
        n.order === null ? h('span', { class: 'muted' }, '–') : String(n.order + 1),
        critical
          ? h(
              'span',
              {
                class: 'star',
                title: 'On the critical path',
                'aria-label': 'On the critical path',
              },
              '★',
            )
          : null,
      ),
      h(
        'td',
        { class: 'col-issue' },
        issueLink(n.key, n.url, displayKey(n.key, index.multiRepo), `${n.key} (open in a new tab)`),
        n.external ? h('span', { class: 'tag tag-external' }, 'ext') : null,
      ),
      h(
        'td',
        { class: 'col-title' },
        h('div', { class: 'title-text', title: n.title }, n.title),
        reason !== null ? h('div', { class: 'reason' }, reason) : null,
      ),
      h('td', { class: 'col-status' }, statusPill(statusLabel(n.status), n.status)),
      h('td', { class: 'col-labels' }, labelCell(n)),
      h(
        'td',
        { class: 'col-assignees' },
        n.assignees.length > 0
          ? h('span', { title: n.assignees.join(', ') }, n.assignees.map((a) => `@${a}`).join(', '))
          : h('span', { class: 'muted' }, '–'),
      ),
      h(
        'td',
        { class: 'col-blocked' },
        n.blockedBy.length > 0
          ? h('span', { class: 'keys' }, ...n.blockedBy.map((k) => keyButton(k, index)))
          : h('span', { class: 'muted' }, '–'),
      ),
      h(
        'td',
        { class: 'col-actions' },
        h(
          'button',
          {
            class: 'btn btn-icon',
            type: 'button',
            title: 'Show in graph',
            'aria-label': `Show ${n.key} in graph`,
            onclick: (e: Event) => {
              e.stopPropagation();
              ctx.actions.showInGraph(n.key);
            },
          },
          icon(ICONS.graph),
        ),
      ),
    );
    tr.addEventListener('click', () => ctx.actions.select(n.key));
    rows.set(n.key, tr);
    return tr;
  }

  function sectionRow(cls: string, ...content: Child[]): HTMLTableRowElement {
    return h(
      'tr',
      { class: `section-row ${cls}` },
      h('td', { colspan: 8 }, h('div', { class: 'section-head' }, ...content)),
    );
  }

  function build(snapshot: Snapshot, index: SnapshotIndex): void {
    clear(scroller);
    rows = new Map();
    const { plan } = snapshot;
    const tbody = h('tbody');
    plan.waves.forEach((wave, i) => {
      tbody.append(
        sectionRow(
          'wave-row',
          h('strong', null, `Wave ${i + 1}`),
          h('span', { class: 'sep' }, '·'),
          plural(wave.length, 'issue'),
          wave.length > 1 ? h('span', { class: 'sep' }, '·') : null,
          wave.length > 1 ? 'can run in parallel' : null,
        ),
      );
      for (const key of wave) {
        const n = index.nodes.get(key);
        if (n) tbody.append(row(n, index, null));
      }
    });

    if (plan.unschedulable.length > 0) {
      tbody.append(
        sectionRow(
          'wave-row unsched-row',
          h('strong', null, 'Unschedulable'),
          h('span', { class: 'sep' }, '·'),
          plural(plan.unschedulable.length, 'issue'),
          h('span', { class: 'sep' }, '·'),
          'cannot be ordered until the cycle is resolved',
        ),
      );
      for (const key of plan.unschedulable) {
        const n = index.nodes.get(key);
        if (!n) continue;
        tbody.append(row(n, index, unschedulableReason(n, snapshot, index)));
      }
    }

    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', { class: 'col-num' }, '#'),
        h('th', { class: 'col-issue' }, 'Issue'),
        h('th', { class: 'col-title' }, 'Title'),
        h('th', { class: 'col-status' }, 'Status'),
        h('th', { class: 'col-labels' }, 'Labels'),
        h('th', { class: 'col-assignees' }, 'Assignees'),
        h('th', { class: 'col-blocked' }, 'Blocked by'),
        h('th', { class: 'col-actions' }, ''),
      ),
    );
    scroller.append(h('table', { class: 'order-table' }, head, tbody));
  }

  function unschedulableReason(n: PlanNode, snapshot: Snapshot, index: SnapshotIndex): string {
    if (n.status === 'in-cycle') {
      const scc = snapshot.plan.cycles.find((c) => c.includes(n.key));
      if (scc) {
        const { path } = cyclePath(scc, snapshot.plan.edges);
        const text = (path.length > 0 ? path : scc)
          .map((k) => displayKey(k, index.multiRepo))
          .join(' → ');
        return `In cycle: ${text}`;
      }
      return 'In a dependency cycle';
    }
    const via = n.blockedBy.filter((k) => index.unschedulable.has(k));
    return via.length > 0
      ? `Blocked by cycle, via ${via.map((k) => displayKey(k, index.multiRepo)).join(', ')}`
      : 'Blocked by a cycle';
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
        lastSelected = null;
      }
      const out = filteredOut(state, index);
      for (const [key, tr] of rows) {
        tr.classList.toggle('selected', key === state.selected);
        tr.classList.toggle('filtered', out.has(key));
      }
      if (tabVisible && state.selected !== null && state.selected !== lastSelected) {
        rows.get(state.selected)?.scrollIntoView({ block: 'nearest' });
      }
      lastSelected = state.selected;
    },
  };
}
