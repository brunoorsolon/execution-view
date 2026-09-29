import type { IssueKey, PlanWarning, Snapshot } from '../../../src/core/types.js';
import { clear, h, icon, ICONS } from '../dom.js';
import { displayKey, plural } from '../format.js';
import { cyclePath } from '../graph-model.js';
import { warningsByCode, type SnapshotIndex } from '../state.js';
import { getIndex, issueLink, statusPill, type View, type ViewCtx } from './shared.js';

/** Human explanation per warning code (the plan's own `message` is shown below it). */
export const WARNING_EXPLANATIONS: Record<string, { title: string; text: string }> = {
  cycle: {
    title: 'Dependency cycle',
    text: 'These issues depend on each other in a loop, so none of them can be started first. Remove one of the dependencies to break the loop.',
  },
  'blocked-by-cycle': {
    title: 'Blocked by a cycle',
    text: 'These issues are not part of a cycle themselves, but they depend (directly or transitively) on one, so they cannot be scheduled until the cycle is resolved.',
  },
  'self-reference': {
    title: 'Self reference',
    text: 'An issue lists itself as a dependency. The self-reference is ignored.',
  },
  'dangling-reference': {
    title: 'Dangling reference',
    text: 'An issue references another issue that does not exist or is not accessible with the configured token.',
  },
  'external-unresolved': {
    title: 'External issues not followed',
    text: 'Some prerequisites outside the view were not followed because the limit of extra fetches was reached, so the plan may be incomplete.',
  },
  'native-unsupported': {
    title: 'Native dependencies unsupported',
    text: 'The provider (or its version) does not expose native issue dependencies, so only dependencies written in issue bodies were used.',
  },
  'fetch-error': {
    title: 'Fetch error',
    text: 'Fetching an issue failed. It is treated as an open external issue titled "(unavailable)", so its own dependencies are unknown.',
  },
};

export function createProblemsView(ctx: ViewCtx): View {
  const root = h('div', { class: 'problems-pane' });
  let builtFor: Snapshot | null = null;

  function issueChip(key: IssueKey, index: SnapshotIndex): HTMLElement {
    const n = index.nodes.get(key);
    const label = displayKey(key, index.multiRepo);
    return h(
      'span',
      { class: 'issue-chip' },
      n ? issueLink(key, n.url, label, `${key}: ${n.title}`) : h('span', { class: 'mono' }, label),
      n
        ? h(
            'button',
            {
              class: 'btn btn-icon btn-xs',
              type: 'button',
              title: 'Show in graph',
              'aria-label': `Show ${key} in graph`,
              onclick: () => ctx.actions.showInGraph(key),
            },
            icon(ICONS.graph, 12),
          )
        : null,
    );
  }

  function section(title: string, count: number, ...body: (Node | null)[]): HTMLElement {
    return h(
      'section',
      { class: 'problem-section' },
      h('h2', null, title, h('span', { class: 'count' }, String(count))),
      ...body,
    );
  }

  function build(snapshot: Snapshot, index: SnapshotIndex): void {
    clear(root);
    const { plan } = snapshot;
    const blockedByCycle = plan.unschedulable.filter(
      (k) => index.nodes.get(k)?.status === 'blocked-by-cycle',
    );

    if (plan.cycles.length === 0 && blockedByCycle.length === 0 && plan.warnings.length === 0) {
      root.append(
        h(
          'div',
          { class: 'empty-state ok' },
          h(
            'div',
            { class: 'empty-title' },
            'No problems found: every dependency is resolvable and acyclic.',
          ),
        ),
      );
      return;
    }

    if (plan.cycles.length > 0) {
      root.append(
        section(
          'Cycles',
          plan.cycles.length,
          h('p', { class: 'muted lead' }, WARNING_EXPLANATIONS['cycle']!.text),
          ...plan.cycles.map((scc, i) => {
            const { path, extra } = cyclePath(scc, plan.edges);
            const seq = path.length > 0 ? path : scc;
            const items: (Node | string)[] = [];
            seq.forEach((k, j) => {
              if (j > 0) items.push(h('span', { class: 'arrow-sep', 'aria-hidden': 'true' }, '→'));
              items.push(issueChip(k, index));
            });
            return h(
              'div',
              { class: 'card cycle-card' },
              h(
                'div',
                { class: 'card-title' },
                `Cycle ${i + 1}`,
                h('span', { class: 'muted' }, ` · ${plural(scc.length, 'issue')}`),
              ),
              h('div', { class: 'cycle-path' }, ...items),
              extra.length > 0
                ? h(
                    'div',
                    { class: 'cycle-extra muted' },
                    'Also in this cycle: ',
                    ...extra.flatMap((k, j) => [j > 0 ? ', ' : '', issueChip(k, index)]),
                  )
                : null,
            );
          }),
        ),
      );
    }

    if (blockedByCycle.length > 0) {
      root.append(
        section(
          'Blocked by a cycle',
          blockedByCycle.length,
          h('p', { class: 'muted lead' }, WARNING_EXPLANATIONS['blocked-by-cycle']!.text),
          h(
            'ul',
            { class: 'plain-list' },
            ...blockedByCycle.map((k) => {
              const n = index.nodes.get(k)!;
              const via = n.blockedBy.filter((b) => index.unschedulable.has(b));
              return h(
                'li',
                { class: 'bbc-item' },
                issueChip(k, index),
                h('span', { class: 'bbc-title' }, n.title),
                statusPill('blocked by cycle', 'blocked-by-cycle'),
                via.length > 0
                  ? h(
                      'span',
                      { class: 'muted' },
                      `via ${via.map((b) => displayKey(b, index.multiRepo)).join(', ')}`,
                    )
                  : null,
              );
            }),
          ),
        ),
      );
    }

    if (plan.warnings.length > 0) {
      const groups = warningsByCode(plan.warnings);
      root.append(
        section(
          'Warnings',
          plan.warnings.length,
          ...[...groups].map(([code, list]) => warningGroup(code, list, index)),
        ),
      );
    }
  }

  function warningGroup(code: string, list: PlanWarning[], index: SnapshotIndex): HTMLElement {
    const info = WARNING_EXPLANATIONS[code] ?? {
      title: code,
      text: 'The plan reported a warning of this kind.',
    };
    return h(
      'div',
      { class: 'card warn-group' },
      h(
        'div',
        { class: 'card-title' },
        h('span', { class: 'code-badge' }, code),
        info.title,
        h('span', { class: 'count' }, String(list.length)),
      ),
      h('p', { class: 'muted explain' }, info.text),
      h(
        'ul',
        { class: 'plain-list warn-list' },
        ...list.map((w) =>
          h(
            'li',
            null,
            h('div', { class: 'warn-message' }, w.message),
            w.issues.length > 0
              ? h('div', { class: 'warn-issues' }, ...w.issues.map((k) => issueChip(k, index)))
              : null,
          ),
        ),
      ),
    );
  }

  return {
    el: root,
    update(state) {
      root.hidden = state.route.tab !== 'problems';
      const index = getIndex(state);
      if (state.snapshot === null || index === null) return;
      if (builtFor !== state.snapshot) {
        build(state.snapshot, index);
        builtFor = state.snapshot;
      }
    },
  };
}
