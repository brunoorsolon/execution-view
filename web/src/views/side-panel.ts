import type { IssueKey, PlanNode } from '../../../src/core/types.js';
import { clear, h, icon, ICONS } from '../dom.js';
import { displayKey, plural, statusLabel } from '../format.js';
import type { AppState, SnapshotIndex } from '../state.js';
import { getIndex, labelChip, safeUrl, statusPill, type View, type ViewCtx } from './shared.js';

export function createSidePanel(ctx: ViewCtx): View {
  const el = h('aside', { class: 'side-panel', hidden: true, 'aria-label': 'Issue details' });
  let renderedFor: { key: IssueKey | null; snapshot: unknown } = { key: null, snapshot: null };

  function depList(keys: readonly IssueKey[], index: SnapshotIndex): HTMLElement {
    if (keys.length === 0) return h('div', { class: 'muted' }, 'None');
    return h(
      'ul',
      { class: 'dep-list' },
      ...keys.map((k) => {
        const n = index.nodes.get(k);
        return h(
          'li',
          null,
          h(
            'button',
            {
              class: 'dep-item',
              type: 'button',
              title: n ? `${k}: ${n.title}` : k,
              onclick: () => ctx.actions.select(k),
            },
            h('span', { class: `dot status-${n?.status ?? 'ready'}` }),
            h('span', { class: 'dep-key' }, displayKey(k, index.multiRepo)),
            h('span', { class: 'dep-title' }, n?.title ?? ''),
          ),
        );
      }),
    );
  }

  function fact(label: string, ...value: (Node | string)[]): HTMLElement {
    return h('div', { class: 'fact' }, h('dt', null, label), h('dd', null, ...value));
  }

  function render(n: PlanNode, state: AppState, index: SnapshotIndex): void {
    clear(el);
    const total = state.snapshot?.plan.order.length ?? 0;
    const wave = n.wave === null ? 'Unschedulable' : `Wave ${n.wave + 1}`;
    const order = n.order === null ? 'not scheduled' : `#${n.order + 1} of ${total}`;
    const prio = index.priorityLabels.get(n.priority);
    const onCritical = index.criticalNodes.has(n.key);

    el.append(
      h(
        'header',
        { class: 'side-head' },
        h(
          'span',
          { class: 'side-key' },
          displayKey(n.key, true),
          n.external ? h('span', { class: 'tag tag-external' }, 'external') : null,
        ),
        h(
          'button',
          {
            class: 'btn btn-icon',
            type: 'button',
            title: 'Close (Esc)',
            'aria-label': 'Close details',
            onclick: () => ctx.actions.select(null),
          },
          icon(ICONS.close),
        ),
      ),
      h(
        'h2',
        { class: 'side-title' },
        h(
          'a',
          {
            href: safeUrl(n.url),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Open the issue',
          },
          n.title,
          icon(ICONS.external, 12),
        ),
      ),
      h(
        'div',
        { class: 'side-badges' },
        statusPill(statusLabel(n.status), n.status),
        onCritical ? h('span', { class: 'tag tag-critical' }, '★ On critical path') : null,
      ),
      h(
        'dl',
        { class: 'facts' },
        fact('Wave', wave),
        fact('Order', order),
        fact('Priority', prio ?? h('span', { class: 'muted' }, 'none')),
        fact('Milestone', n.milestone ?? h('span', { class: 'muted' }, 'none')),
        fact(
          'Labels',
          n.labels.length > 0
            ? h('span', { class: 'chips' }, ...n.labels.map((l) => labelChip(l)))
            : h('span', { class: 'muted' }, 'none'),
        ),
        fact(
          'Assignees',
          n.assignees.length > 0
            ? h('span', null, n.assignees.map((a) => `@${a}`).join(', '))
            : h('span', { class: 'muted' }, 'unassigned'),
        ),
      ),
      h('h3', { class: 'side-section' }, `Blocked by (${n.blockedBy.length})`),
      depList(n.blockedBy, index),
      h('h3', { class: 'side-section' }, `Blocks (${n.blocks.length})`),
      depList(n.blocks, index),
      h(
        'p',
        { class: 'side-foot muted' },
        `${plural(index.adjacency.in.get(n.key)?.length ?? 0, 'direct prerequisite')}, ${plural(
          index.adjacency.out.get(n.key)?.length ?? 0,
          'direct dependent',
        )}.`,
      ),
    );
  }

  return {
    el,
    update(state) {
      const index = getIndex(state);
      const node = state.selected !== null ? index?.nodes.get(state.selected) : undefined;
      if (node === undefined || index === null) {
        el.hidden = true;
        renderedFor = { key: null, snapshot: null };
        return;
      }
      el.hidden = false;
      if (renderedFor.key !== node.key || renderedFor.snapshot !== state.snapshot) {
        render(node, state, index);
        el.scrollTop = 0;
        renderedFor = { key: node.key, snapshot: state.snapshot };
      }
    },
  };
}
