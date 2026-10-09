import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { errorMessage, fetchSettings, fetchSnapshot, fetchViews, refreshSnapshot } from './api.js';
import { h } from './dom.js';
import { parseHash, serializeHash, type Route, type Tab } from './route.js';
import {
  effectiveViewId,
  getIndex,
  INITIAL_STATE,
  isVisible,
  Store,
  visibleKeys,
} from './state.js';
import { applyTheme, loadTheme } from './theme.js';
import { createGraphView } from './views/graph.js';
import { createHeader } from './views/header.js';
import { createOrderView } from './views/order.js';
import { createProblemsView } from './views/problems.js';
import { type Actions, type View, type ViewCtx } from './views/shared.js';
import { createSidePanel } from './views/side-panel.js';
import { createStates } from './views/states.js';
import { createSummary } from './views/summary.js';

applyTheme(loadTheme());

const store = new Store({ ...INITIAL_STATE, route: parseHash(location.hash) });

// ---------------------------------------------------------------- navigation

/** Writes the route to the URL hash. `replace` avoids a history entry (typing in the filter). */
function navigate(route: Route, replace = false): void {
  const hash = serializeHash(route);
  if (replace) {
    history.replaceState(null, '', hash);
  } else if (location.hash !== hash) {
    location.hash = hash; // hashchange re-dispatches the same route; the sync dispatch below covers callers that act first
  } else {
    return;
  }
  // Dispatch synchronously so a caller that acts right after navigate, or a
  // microtask that resolves before the hashchange event, sees the new route.
  store.dispatch({ type: 'route', route });
}

function currentRoute(): Route {
  const state = store.get();
  const viewId = effectiveViewId(state);
  return { ...state.route, viewId: viewId ?? state.route.viewId };
}

// ------------------------------------------------------------------- loading

let loadToken = 0;

async function loadSnapshot(viewId: string): Promise<void> {
  const token = ++loadToken;
  store.dispatch({ type: 'load-start', viewId });
  if (store.get().status === 'ready') return; // loaded earlier in this tab
  try {
    const snapshot = await fetchSnapshot(viewId);
    if (token === loadToken) store.dispatch({ type: 'load-done', viewId, snapshot });
  } catch (e) {
    if (token === loadToken)
      store.dispatch({ type: 'load-failed', viewId, error: errorMessage(e) });
  }
}

async function refresh(): Promise<void> {
  const state = store.get();
  const viewId = effectiveViewId(state);
  if (viewId === null || state.refreshing) return;
  const token = ++loadToken;
  store.dispatch({ type: 'refresh-start', viewId });
  try {
    const snapshot = await refreshSnapshot(viewId);
    if (token === loadToken) store.dispatch({ type: 'refresh-done', viewId, snapshot });
  } catch (e) {
    if (token === loadToken)
      store.dispatch({ type: 'refresh-failed', viewId, error: errorMessage(e) });
  }
}

// ------------------------------------------------------------------- actions

const actions: Actions = {
  select: (key) => store.dispatch({ type: 'select', key }),
  showInGraph: (key) => {
    store.dispatch({ type: 'select', key });
    navigate({ ...currentRoute(), tab: 'graph' });
  },
  setTab: (tab: Tab) => navigate({ ...currentRoute(), tab }),
  setView: (viewId) => navigate({ ...currentRoute(), viewId }),
  setQuery: (q) => navigate({ ...currentRoute(), q }, true),
  setSort: (sort) => navigate({ ...currentRoute(), sort }),
  refresh: () => void refresh(),
  reload: () => {
    const viewId = effectiveViewId(store.get());
    if (viewId !== null) void loadSnapshot(viewId);
  },
};

// ------------------------------------------------------------------------ UI

const ctx: ViewCtx = { store, actions };
const header = createHeader(ctx);
const summary = createSummary(ctx);
const states = createStates(ctx);
const graph = createGraphView(ctx);
const order = createOrderView(ctx);
const problems = createProblemsView(ctx);
const panel = createSidePanel(ctx);

const main = h('main', { class: 'main' }, graph.el, order.el, problems.el, panel.el);
const app = document.getElementById('app');
if (!app) throw new Error('missing #app');
app.append(header.el, summary.el, states.el, main);

const views: View[] = [header, summary, states, graph, order, problems, panel];

function layoutMain(state: ReturnType<Store['get']>): void {
  main.hidden = !states.showsContent(state);
  main.classList.toggle('panel-open', state.selected !== null && state.route.tab !== 'problems');
}

function render(): void {
  const state = store.get();
  layoutMain(state);
  for (const v of views) v.update(state, state);
}

let prevState = store.get();
store.subscribe((state) => {
  // A selected issue that the filter hides is deselected.
  const index = getIndex(state);
  if (state.selected !== null && index !== null) {
    if (!isVisible(visibleKeys(state, index), state.selected)) {
      store.dispatch({ type: 'select', key: null });
      return;
    }
  }
  layoutMain(state);
  for (const v of views) v.update(state, prevState);
  prevState = state;
  document.title = titleFor(state);
  // A snapshot for another view is needed when the effective view changed.
  const viewId = effectiveViewId(state);
  if (viewId !== null && viewId !== state.loadedViewId) {
    void loadSnapshot(viewId);
  }
  // Keep the URL in step with the route: the canonical view id, and the filter
  // a reveal changed in the store.
  if (viewId !== null) {
    const route = { ...state.route, viewId };
    if (location.hash !== serializeHash(route)) navigate(route, true);
  }
});

function titleFor(state: ReturnType<Store['get']>): string {
  const view = state.views?.find((v) => v.id === effectiveViewId(state));
  return view ? `${view.title} · execution-view` : 'execution-view';
}

window.addEventListener('hashchange', () => {
  const route = parseHash(location.hash);
  const current = store.get().route;
  // Skip the echo of our own navigate(); this only handles back/forward and manual edits.
  if (
    current.viewId !== route.viewId ||
    current.tab !== route.tab ||
    current.q !== route.q ||
    current.sort !== route.sort
  ) {
    store.dispatch({ type: 'route', route });
  }
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (typing && target instanceof HTMLInputElement) target.blur();
    if (store.get().selected !== null) actions.select(null);
  } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('.filter-input')?.focus();
  } else if (
    (e.key === 'f' || e.key === 'F') &&
    !typing &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    store.get().route.tab === 'graph'
  ) {
    graph.fit();
  }
});

render();

fetchViews().then(
  (list) => store.dispatch({ type: 'views-loaded', views: list }),
  (e: unknown) => store.dispatch({ type: 'views-failed', error: errorMessage(e) }),
);

fetchSettings().then(
  ({ refreshMinutes }) => {
    if (refreshMinutes > 0) setInterval(() => void refresh(), refreshMinutes * 60_000);
  },
  () => {}, // no timer; the Refresh button still works
);
