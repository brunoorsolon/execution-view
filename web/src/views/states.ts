import { append, clear, h, icon } from '../dom.js';
import type { AppState } from '../state.js';
import type { View, ViewCtx } from './shared.js';

export interface StatesView extends View {
  /** True when the main tabs should be visible (a snapshot with nodes is loaded). */
  showsContent(state: AppState): boolean;
}

/** Loading skeleton, error banner and the empty-view message. */
export function createStates(ctx: ViewCtx): StatesView {
  const banner = h('div', { class: 'banner', role: 'alert', hidden: true });
  const skeleton = h(
    'div',
    { class: 'skeleton', hidden: true, 'aria-busy': 'true', 'aria-label': 'Loading' },
    h(
      'div',
      { class: 'sk-strip' },
      h('div', { class: 'sk sk-chip' }),
      h('div', { class: 'sk sk-chip' }),
      h('div', { class: 'sk sk-chip' }),
    ),
    h(
      'div',
      { class: 'sk-cols' },
      ...[4, 3, 4, 2].map((n) =>
        h(
          'div',
          { class: 'sk-col' },
          h('div', { class: 'sk sk-head' }),
          ...Array.from({ length: n }, () => h('div', { class: 'sk sk-card' })),
        ),
      ),
    ),
  );
  const empty = h(
    'div',
    { class: 'state-center', hidden: true },
    h(
      'div',
      { class: 'box' },
      h('div', { class: 'glyph' }, icon('checkCircle', 20)),
      h('h2', null, 'No open issues in this view'),
      h(
        'p',
        null,
        'Everything in its repositories is closed, or the view’s scope filters exclude it. New issues appear after the next refresh.',
      ),
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => ctx.actions.refresh() },
        icon('refresh'),
        'Refresh now',
      ),
    ),
  );
  const el = h('div', { class: 'states' }, banner, skeleton, empty);

  function showBanner(title: string, message: string, retry: (() => void) | null): void {
    clear(banner);
    append(banner, [
      icon('alert', 18),
      h('div', { class: 'msg' }, h('strong', null, title), h('span', null, message)),
      retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Retry') : null,
    ]);
    banner.hidden = false;
  }

  function showsContent(state: AppState): boolean {
    return state.snapshot !== null && state.snapshot.plan.nodes.length > 0;
  }

  return {
    el,
    showsContent,
    update(state) {
      const noViews = state.views !== null && state.views.length === 0;
      let shown = false;
      if (state.viewsError !== null) {
        showBanner('Couldn’t load the views', state.viewsError, () => location.reload());
        shown = true;
      } else if (noViews) {
        showBanner(
          'No views configured',
          'Add a view to the server configuration, then reload.',
          null,
        );
        shown = true;
      } else if (state.status === 'error' && state.error !== null) {
        showBanner('Couldn’t load the snapshot', state.error, () => ctx.actions.reload());
        shown = true;
      }
      if (!shown) banner.hidden = true;

      const loading =
        !shown &&
        state.snapshot === null &&
        (state.views === null || state.status === 'loading' || state.status === 'idle');
      skeleton.hidden = !loading;
      empty.hidden = !(state.status === 'ready' && state.snapshot !== null && !showsContent(state));
      el.hidden = banner.hidden && skeleton.hidden && empty.hidden;
    },
  };
}
