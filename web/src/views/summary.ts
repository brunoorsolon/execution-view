import type { IssueKey } from '../../../src/core/types.js';
import { clear, h } from '../dom.js';
import { hasQualifier, toggleQualifier } from '../filter.js';
import { displayStatus, shortKey } from '../format.js';
import type { AppState } from '../state.js';
import { getIndex, isVisible, visibleKeys, type View, type ViewCtx } from './shared.js';

const CHIP_GAP = 8;

/**
 * The strip under the tabs: the issues that can start now (in execution order)
 * and the status breakdown, both for the issues that match the filter.
 */
export function createSummary(ctx: ViewCtx): View {
  const title = h('h2', null, 'Ready to start ', h('span', { class: 'n' }));
  const list = h('div', { class: 'ready-list' });
  const more = h('button', {
    class: 'ready-chip more-chip',
    type: 'button',
    title: 'Show only ready issues',
    onclick: () => {
      const q = ctx.store.get().route.q;
      if (!hasQualifier(q, 'status', 'ready'))
        ctx.actions.setQuery(toggleQualifier(q, 'status', 'ready'));
    },
  });
  const stack = h('div', { class: 'stack', 'aria-hidden': 'true' });
  const legend = h('div', { class: 'breakdown-legend' });
  const el = h(
    'section',
    { class: 'summary', 'aria-label': 'Summary', hidden: true },
    h('div', { class: 'start-now' }, title, list),
    h('div', { class: 'breakdown' }, stack, legend),
  );

  let chips: HTMLButtonElement[] = [];
  let builtFor: { snapshot: unknown; visible: unknown } = { snapshot: null, visible: null };

  /** Shows the chips that fit whole, then "+N more". */
  function fit(): void {
    if (el.hidden || chips.length === 0) return;
    for (const c of chips) {
      c.hidden = false;
      c.classList.remove('shrink');
    }
    more.hidden = false;
    more.textContent = `+${chips.length} more`;
    const moreW = more.offsetWidth;
    more.hidden = true;
    const avail = list.clientWidth;
    let used = 0;
    let shown = 0;
    for (let i = 0; i < chips.length; i++) {
      const w = chips[i]!.offsetWidth;
      const gap = i > 0 ? CHIP_GAP : 0;
      const rest = chips.length - i - 1;
      if (i > 0 && used + gap + w + (rest > 0 ? CHIP_GAP + moreW : 0) > avail) break;
      used += gap + w;
      shown++;
    }
    chips.forEach((c, i) => (c.hidden = i >= shown));
    if (shown === 1) chips[0]!.classList.add('shrink');
    if (shown < chips.length) {
      more.hidden = false;
      more.textContent = `+${chips.length - shown} more`;
    }
  }
  new ResizeObserver(fit).observe(el);

  function seg(cls: string, n: number): HTMLElement | null {
    return n > 0 ? h('span', { class: cls, style: `flex:${n}` }) : null;
  }
  function leg(cls: string, n: number, label: string): HTMLElement {
    return h('span', null, h('span', { class: `sw ${cls}` }), h('strong', null, String(n)), label);
  }

  function build(state: AppState): void {
    const snapshot = state.snapshot!;
    const index = getIndex(state)!;
    const visible = visibleKeys(state, index);
    const filtered = visible !== null;
    const nodes = snapshot.plan.nodes.filter((n) => isVisible(visible, n.key));
    const ready = snapshot.plan.order
      .map((k) => index.nodes.get(k))
      .filter((n) => n !== undefined && displayStatus(n) === 'ready' && isVisible(visible, n.key));

    title.querySelector('.n')!.textContent = String(ready.length);
    clear(list);
    more.hidden = true;
    chips = ready.map((n) =>
      h(
        'button',
        {
          class: 'ready-chip',
          type: 'button',
          'data-key': n!.key,
          title: `${n!.key}: ${n!.title}`,
          onclick: () => ctx.actions.select(n!.key),
        },
        h('span', { class: 'k' }, shortKey(n!.key, index.multiRepo)),
        h('span', { class: 't' }, n!.title),
      ),
    );
    if (chips.length === 0) {
      list.append(
        h(
          'span',
          { class: 'muted small' },
          filtered ? 'None of the matching issues can start yet.' : 'Nothing can start yet.',
        ),
      );
    }
    list.append(...chips, more);

    const count = (pred: (s: string) => boolean): number =>
      nodes.filter((n) => pred(displayStatus(n))).length;
    const st = {
      ready: count((s) => s === 'ready'),
      inProgress: count((s) => s === 'in-progress'),
      spec: count((s) => s === 'spec'),
      map: count((s) => s === 'map'),
      blocked: count((s) => s === 'blocked'),
      unsched: count((s) => s === 'in-cycle' || s === 'blocked-by-cycle'),
      external: nodes.filter((n) => n.external).length,
    };
    clear(stack);
    for (const s of [
      seg('s-ready', st.ready),
      seg('s-in-progress', st.inProgress),
      seg('s-spec', st.spec),
      seg('s-map', st.map),
      seg('s-blocked', st.blocked),
      seg('s-unsched', st.unsched),
    ])
      if (s) stack.append(s);
    clear(legend);
    if (filtered) {
      legend.append(
        h(
          'span',
          { class: 'showing' },
          h('strong', null, String(nodes.length)),
          `of ${snapshot.plan.nodes.length}`,
        ),
      );
    }
    if (!filtered || st.ready > 0) legend.append(leg('s-ready', st.ready, 'ready'));
    if (!filtered || st.inProgress > 0)
      legend.append(leg('s-in-progress', st.inProgress, 'in progress'));
    if (!filtered || st.spec > 0) legend.append(leg('s-spec', st.spec, 'spec'));
    if (!filtered || st.map > 0) legend.append(leg('s-map', st.map, 'map'));
    if (!filtered || st.blocked > 0) legend.append(leg('s-blocked', st.blocked, 'blocked'));
    if (!filtered || st.unsched > 0) legend.append(leg('s-unsched', st.unsched, 'unschedulable'));
    if (st.external > 0) legend.append(leg('s-ext', st.external, 'external'));
  }

  function markSelected(selected: IssueKey | null): void {
    for (const c of chips) c.classList.toggle('selected', c.dataset.key === selected);
  }

  return {
    el,
    update(state) {
      const index = getIndex(state);
      const show =
        state.route.tab !== 'problems' &&
        state.snapshot !== null &&
        index !== null &&
        state.snapshot.plan.nodes.length > 0;
      const wasHidden = el.hidden;
      el.hidden = !show;
      if (!show) return;
      const visible = visibleKeys(state, index);
      if (builtFor.snapshot !== state.snapshot || builtFor.visible !== visible) {
        builtFor = { snapshot: state.snapshot, visible };
        build(state);
        fit();
      } else if (wasHidden) {
        fit();
      }
      markSelected(state.selected);
    },
  };
}
