import type { IssueKey, PlanNode } from '../../../src/core/types.js';
import { clear, h, icon } from '../dom.js';
import { plural, shortKey } from '../format.js';
import { downstreamOf, upstreamOf } from '../graph-model.js';
import { priorityName } from '../priority.js';
import type { AppState, SnapshotIndex } from '../state.js';
import {
  avatar,
  getIndex,
  labelChip,
  otherLabels,
  priorityTag,
  safeUrl,
  statusBadges,
  type View,
  type ViewCtx,
} from './shared.js';

/**
 * Details of the selected issue. Shown over the graph and next to the
 * execution order table; hidden on the Problems tab.
 */
export function createSidePanel(ctx: ViewCtx): View {
  const el = h('aside', { class: 'panel', 'aria-label': 'Issue details' });
  let renderedFor: { key: IssueKey | null; snapshot: unknown } = { key: null, snapshot: null };

  function relList(keys: readonly IssueKey[], index: SnapshotIndex): HTMLElement {
    if (keys.length === 0) return h('div', { class: 'rel-empty' }, 'None');
    return h(
      'ul',
      { class: 'rel-list' },
      ...keys.map((k) => {
        const n = index.nodes.get(k);
        return h(
          'li',
          null,
          h(
            'button',
            {
              class: 'rel-item',
              type: 'button',
              title: n ? `${k}: ${n.title}` : k,
              onclick: () => ctx.actions.select(k),
            },
            h('span', { class: 'card-key' }, shortKey(k, index.multiRepo)),
            h('span', { class: 't' }, n?.title ?? '(not in this snapshot)'),
            n ? statusBadges(n) : null,
          ),
        );
      }),
    );
  }

  function fact(label: string, ...value: (Node | string)[]): Node[] {
    return [h('dt', null, label), h('dd', null, ...value)];
  }

  function none(text = 'None'): HTMLElement {
    return h('span', { class: 'muted' }, text);
  }

  function render(n: PlanNode, state: AppState, index: SnapshotIndex): void {
    const snapshot = state.snapshot!;
    const plan = snapshot.plan;
    const up = upstreamOf(index.adjacency, n.key);
    const down = downstreamOf(index.adjacency, n.key);
    const prio = priorityName(snapshot, n);
    const labels = otherLabels(n, prio);
    clear(el);
    el.append(
      h(
        'div',
        { class: 'panel-head' },
        h('span', { class: 'card-key' }, n.key),
        n.external ? h('span', { class: 'badge st-external' }, 'External') : null,
        h('span', { class: 'spacer' }),
        h(
          'a',
          {
            class: 'btn btn-ghost',
            href: safeUrl(n.url),
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'Open issue',
          icon('external', 13),
        ),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-icon',
            type: 'button',
            title: 'Close (Esc)',
            'aria-label': 'Close details',
            onclick: () => ctx.actions.select(null),
          },
          icon('close'),
        ),
      ),
      h(
        'div',
        { class: 'panel-body' },
        h('h2', null, n.title),
        h(
          'div',
          { class: 'badges' },
          statusBadges(n),
          index.criticalNodes.has(n.key)
            ? h('span', { class: 'tag-crit' }, icon('critical', 13), 'On the critical path')
            : null,
        ),
        h(
          'div',
          { class: 'impact' },
          h(
            'div',
            null,
            h('b', null, String(up.size)),
            h('span', null, up.size === 1 ? 'issue must finish first' : 'issues must finish first'),
          ),
          h(
            'div',
            null,
            h('b', null, String(down.size)),
            h('span', null, down.size === 1 ? 'issue waits on this' : 'issues wait on this'),
          ),
        ),
        h(
          'dl',
          { class: 'facts' },
          ...fact(
            'Wave',
            n.wave === null ? 'Unschedulable' : `Wave ${n.wave + 1} of ${plan.waves.length}`,
          ),
          ...fact(
            'Position',
            n.order === null ? none('Not scheduled') : `${n.order + 1} of ${plan.order.length}`,
          ),
          ...fact('Priority', prio !== null ? priorityTag(prio, n.priority) : none()),
          ...fact('Milestone', n.milestone ?? none()),
          ...fact(
            'Assignees',
            ...(n.assignees.length > 0
              ? n.assignees.map((a) => h('span', { class: 'person' }, avatar(a), `@${a}`))
              : [none('Unassigned')]),
          ),
          ...fact('Labels', ...(labels.length > 0 ? labels.map((l) => labelChip(l)) : [none()])),
        ),
        h(
          'section',
          { class: 'rel-section rel-up' },
          h(
            'h3',
            null,
            h('span', { class: 'sw' }),
            'Parent',
            h('span', { class: 'n' }, String(n.parents.length)),
          ),
          relList(n.parents, index),
        ),
        h(
          'section',
          { class: 'rel-section rel-up' },
          h(
            'h3',
            null,
            h('span', { class: 'sw' }),
            'Blocked by',
            h('span', { class: 'n' }, String(n.blockedBy.length)),
          ),
          relList(n.blockedBy, index),
          up.size > n.blockedBy.length
            ? h(
                'p',
                { class: 'rel-note' },
                `Plus ${plural(up.size - n.blockedBy.length, 'indirect prerequisite')}, highlighted in the graph.`,
              )
            : null,
        ),
        h(
          'section',
          { class: 'rel-section rel-down' },
          h(
            'h3',
            null,
            h('span', { class: 'sw' }),
            'Blocks',
            h('span', { class: 'n' }, String(n.blocks.length)),
          ),
          relList(n.blocks, index),
          down.size > n.blocks.length
            ? h(
                'p',
                { class: 'rel-note' },
                `Plus ${plural(down.size - n.blocks.length, 'indirect dependent')}, highlighted in the graph.`,
              )
            : null,
        ),
        h(
          'section',
          { class: 'rel-section rel-down' },
          h(
            'h3',
            null,
            h('span', { class: 'sw' }),
            'Children',
            h('span', { class: 'n' }, String(n.children.length)),
          ),
          relList(n.children, index),
        ),
      ),
    );
  }

  return {
    el,
    update(state) {
      const index = getIndex(state);
      const node =
        state.selected !== null && state.route.tab !== 'problems'
          ? index?.nodes.get(state.selected)
          : undefined;
      el.classList.toggle('open', node !== undefined);
      if (node === undefined || index === null) {
        renderedFor = { key: null, snapshot: null };
        return;
      }
      if (renderedFor.key !== node.key || renderedFor.snapshot !== state.snapshot) {
        render(node, state, index);
        const body = el.querySelector('.panel-body');
        if (body) body.scrollTop = 0;
        renderedFor = { key: node.key, snapshot: state.snapshot };
      }
    },
  };
}
