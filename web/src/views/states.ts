import { append, clear, h, icon, ICONS } from '../dom.js';
import type { AppState } from '../state.js';
import type { View, ViewCtx } from './shared.js';

export interface StatesView extends View {
  /** True when the main tabs should be visible (a snapshot with nodes is loaded). */
  showsContent(state: AppState): boolean;
}

/** Loading skeleton, error banner and the empty-view message. */
export function createStates(ctx: ViewCtx): StatesView {
  const banner = h('div', { class: 'banner banner-error', role: 'alert', hidden: true });
  const skeleton = h(
    'div',
    { class: 'skeleton', hidden: true, 'aria-busy': 'true', 'aria-label': 'Loading' },
    ...[0, 1, 2, 3].map((col) =>
      h(
        'div',
        { class: 'skeleton-col' },
        h('div', { class: 'sk sk-head' }),
        ...Array.from({ length: 4 - (col % 2) }, () => h('div', { class: 'sk sk-card' })),
      ),
    ),
  );
  const empty = h(
    'div',
    { class: 'empty-state', hidden: true },
    h('div', { class: 'empty-title' }, 'This view has no open issues'),
    h(
      'div',
      { class: 'muted' },
      'Nothing matches the view scope, or the repositories have no open issues.',
    ),
  );
  const el = h('div', { class: 'states' }, banner, skeleton, empty);

  function showBanner(message: string, retry: (() => void) | null): void {
    clear(banner);
    append(banner, [
      icon(ICONS.alert, 16),
      h('span', { class: 'banner-text' }, message),
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
      let message: string | null = null;
      let retry: (() => void) | null = null;
      if (state.viewsError !== null) {
        message = `Could not load views: ${state.viewsError}`;
        retry = () => location.reload();
      } else if (noViews) {
        message = 'No views are configured on the server.';
      } else if (state.status === 'error' && state.error !== null) {
        message = state.error;
        retry = () => ctx.actions.reload();
      }
      if (message !== null) showBanner(message, retry);
      else banner.hidden = true;

      const loading =
        message === null &&
        state.snapshot === null &&
        (state.views === null || state.status === 'loading' || state.status === 'idle');
      skeleton.hidden = !loading;
      empty.hidden = !(state.status === 'ready' && state.snapshot !== null && !showsContent(state));
    },
  };
}
