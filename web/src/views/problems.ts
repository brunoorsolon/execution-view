import type { IssueKey, PlanWarning, Snapshot } from '../../../src/core/types.js';
import { clear, h, icon } from '../dom.js';
import { plural, shortKey } from '../format.js';
import { cyclePath, edgeId } from '../graph-model.js';
import type { IconName } from '../icons.js';
import { warningsByCode, type SnapshotIndex } from '../state.js';
import { getIndex, sourceTag, type View, type ViewCtx } from './shared.js';

/**
 * Title and explanation per warning code. Cycles and blocked-by-cycle issues
 * have their own sections (from the plan structure), so their warnings are not
 * listed again.
 */
export const WARNING_EXPLANATIONS: Record<string, { title: string; text: string }> = {
  cycle: {
    title: 'Dependency cycle',
    text: 'Each issue in this loop blocks the next one, so none of them can start. Remove one of these dependencies to break the loop.',
  },
  'blocked-by-cycle': {
    title: 'Waiting on the cycle',
    text: 'These issues are not in a cycle themselves, but they depend (directly or transitively) on one, so they cannot be scheduled until it is broken.',
  },
  'self-reference': {
    title: 'Issue depends on itself',
    text: 'An issue lists itself as a dependency. The self-reference is ignored.',
  },
  'dangling-reference': {
    title: 'Reference to a missing issue',
    text: 'An issue body points to an issue that does not exist or that the configured token cannot read. The reference is ignored.',
  },
  'external-unresolved': {
    title: 'External issues not followed',
    text: 'Some prerequisites outside the view were not followed because the limit of extra fetches was reached, so the plan may be incomplete.',
  },
  'native-unsupported': {
    title: 'Native dependencies unavailable',
    text: 'The provider (or its version) does not expose native issue dependencies, so only dependencies written in issue bodies were used.',
  },
  'fetch-error': {
    title: 'An issue could not be fetched',
    text: 'It is treated as an open external issue titled "(unavailable)", so its own dependencies are unknown.',
  },
};

const STRUCTURAL = new Set(['cycle', 'blocked-by-cycle']);

export function createProblemsView(ctx: ViewCtx): View {
  const root = h('div', { class: 'pane pane-scroll problems-pane' });
  const wrap = h('div', { class: 'problems-wrap' });
  root.append(wrap);
  let builtFor: Snapshot | null = null;

  function issuePill(key: IssueKey, index: SnapshotIndex): HTMLElement {
    const n = index.nodes.get(key);
    const label = shortKey(key, index.multiRepo);
    if (!n)
      return h(
        'span',
        { class: 'issue-pill', title: key },
        h('span', { class: 'card-key' }, label),
      );
    return h(
      'button',
      {
        class: 'issue-pill',
        type: 'button',
        title: `Show ${key} in the graph`,
        onclick: () => ctx.actions.showInGraph(key),
      },
      h('span', { class: 'card-key' }, label),
      h('span', { class: 't' }, n.title),
    );
  }

  function head(ic: IconName, tone: string, title: string, count: string): HTMLElement {
    return h(
      'div',
      { class: `p-head tone-${tone}` },
      icon(ic, 18),
      h('h3', null, title),
      h('span', { class: 'n' }, count),
    );
  }

  function build(snapshot: Snapshot, index: SnapshotIndex): void {
    clear(wrap);
    const { plan } = snapshot;
    const blockedByCycle = plan.unschedulable.filter(
      (k) => index.nodes.get(k)?.status === 'blocked-by-cycle',
    );
    const other = [...warningsByCode(plan.warnings)].filter(([code]) => !STRUCTURAL.has(code));
    const total = plan.cycles.length + (blockedByCycle.length > 0 ? 1 : 0) + other.length;

    if (total === 0) {
      wrap.append(
        h(
          'div',
          { class: 'state-center' },
          h(
            'div',
            { class: 'box' },
            h('div', { class: 'glyph' }, icon('checkCircle', 20)),
            h('h2', null, 'No problems found'),
            h('p', null, 'Every dependency resolves and nothing loops.'),
          ),
        ),
      );
      return;
    }

    wrap.append(
      h(
        'div',
        { class: 'problems-lede' },
        h('h2', null, `${plural(total, 'problem')} in this plan`),
        plan.unschedulable.length > 0
          ? h(
              'p',
              null,
              `${plural(plan.unschedulable.length, 'issue')} can't be scheduled until the dependency cycle is broken. Fix the cycle first; the rest of the plan is unaffected.`,
            )
          : null,
      ),
    );

    plan.cycles.forEach((scc, i) => {
      const { path, extra } = cyclePath(scc, plan.edges);
      const loop = path.length > 0 ? path.slice(0, -1) : scc;
      const items: Node[] = [];
      const pushLink = (from: IssueKey, to: IssueKey): void => {
        items.push(icon('arrow', 16));
        const tag = sourceTag(index.edgeSources.get(edgeId(from, to)) ?? []);
        if (tag) items.push(tag);
      };
      loop.forEach((k, j) => {
        if (j > 0) pushLink(loop[j - 1]!, k);
        items.push(issuePill(k, index));
      });
      if (path.length > 0) {
        pushLink(loop[loop.length - 1]!, loop[0]!);
        items.push(
          h(
            'span',
            { class: 'issue-pill back', title: 'Back to the start of the loop' },
            icon('loop', 13),
            h('span', { class: 'card-key' }, shortKey(loop[0]!, index.multiRepo)),
          ),
        );
      }
      wrap.append(
        h(
          'section',
          { class: 'p-section' },
          head(
            'alert',
            'cycle',
            plan.cycles.length > 1 ? `Dependency cycle ${i + 1}` : 'Dependency cycle',
            plural(scc.length, 'issue'),
          ),
          h(
            'div',
            { class: 'p-card' },
            h('p', null, WARNING_EXPLANATIONS.cycle!.text),
            h('div', { class: 'loop' }, ...items),
            extra.length > 0
              ? h(
                  'div',
                  { class: 'loop' },
                  h('span', { class: 'muted small' }, 'Also in this cycle:'),
                  ...extra.map((k) => issuePill(k, index)),
                )
              : null,
          ),
        ),
      );
    });

    if (blockedByCycle.length > 0) {
      wrap.append(
        h(
          'section',
          { class: 'p-section' },
          head(
            'warning',
            'bbc',
            WARNING_EXPLANATIONS['blocked-by-cycle']!.title,
            plural(blockedByCycle.length, 'issue'),
          ),
          h(
            'div',
            { class: 'p-card' },
            h(
              'div',
              { class: 'p-rows' },
              ...blockedByCycle.map((k) => {
                const n = index.nodes.get(k)!;
                const via = n.blockedBy.filter((b) => index.unschedulable.has(b));
                return h(
                  'div',
                  { class: 'p-row' },
                  h('span', { class: 'card-key' }, shortKey(k, index.multiRepo)),
                  h('span', { class: 't' }, n.title),
                  via.length > 0
                    ? h(
                        'span',
                        { class: 'via' },
                        'via ',
                        h(
                          'span',
                          { class: 'mono' },
                          via.map((b) => shortKey(b, index.multiRepo)).join(', '),
                        ),
                      )
                    : h('span'),
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      type: 'button',
                      onclick: () => ctx.actions.showInGraph(k),
                    },
                    'Show',
                  ),
                );
              }),
            ),
          ),
        ),
      );
    }

    for (const [code, list] of other) wrap.append(warningSection(code, list, index));
  }

  function warningSection(code: string, list: PlanWarning[], index: SnapshotIndex): HTMLElement {
    const info = WARNING_EXPLANATIONS[code] ?? {
      title: code,
      text: 'The plan reported a warning of this kind.',
    };
    return h(
      'section',
      { class: 'p-section' },
      head('info', 'warn', info.title, String(list.length)),
      h(
        'div',
        { class: 'p-card' },
        h('p', null, info.text),
        ...list.flatMap((w) => [
          h('p', { class: 'warn-msg' }, w.message),
          w.issues.length > 0
            ? h('div', { class: 'loop' }, ...w.issues.map((k) => issuePill(k, index)))
            : null,
        ]),
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
