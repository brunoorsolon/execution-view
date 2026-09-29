import './styles.css';
import { errorMessage, fetchSnapshot, fetchViews, refreshSnapshot } from './api.js';
import { h } from './dom.js';
import { parseHash, serializeHash, type Route, type Tab } from './route.js';
import { effectiveViewId, INITIAL_STATE, Store } from './state.js';
import { createGraphView } from './views/graph.js';
import { createHeader } from './views/header.js';
import { createOrderView } from './views/order.js';
import { createProblemsView } from './views/problems.js';
import type { Actions, View, ViewCtx } from './views/shared.js';
import { createStates } from './views/states.js';

const store = new Store({ ...INITIAL_STATE, route: parseHash(location.hash) });

// ---------------------------------------------------------------- navigation

/** Writes the route to the URL hash. `replace` avoids a history entry (typing in the filter). */
function navigate(route: Route, replace = false): void {
  const hash = serializeHash(route);
  if (replace) {
    history.replaceState(null, '', hash);
    store.dispatch({ type: 'route', route });
  } else if (location.hash !== hash) {
    location.hash = hash; // hashchange dispatches the route
  }
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
  refresh: () => void refresh(),
  reload: () => {
    const viewId = effectiveViewId(store.get());
    if (viewId !== null) void loadSnapshot(viewId);
  },
};

// ------------------------------------------------------------------------ UI

const ctx: ViewCtx = { store, actions };
const header = createHeader(ctx);
const states = createStates(ctx);
const graph = createGraphView(ctx);
const order = createOrderView(ctx);
const problems = createProblemsView(ctx);

const main = h('main', { class: 'main' }, graph.el, order.el, problems.el);
const app = document.getElementById('app');
if (!app) throw new Error('missing #app');
app.append(header.el, states.el, main);

const views: View[] = [header, states, graph, order, problems];

function render(): void {
  const state = store.get();
  main.hidden = !states.showsContent(state);
  for (const v of views) v.update(state, state);
}

let prevState = store.get();
store.subscribe((state) => {
  main.hidden = !states.showsContent(state);
  for (const v of views) v.update(state, prevState);
  prevState = state;
  document.title = titleFor(state);
  // A snapshot for another view is needed when the effective view changed.
  const viewId = effectiveViewId(state);
  if (viewId !== null && viewId !== state.loadedViewId) {
    void loadSnapshot(viewId);
  }
  // Canonicalise the URL once the default view is known.
  if (viewId !== null && state.route.viewId !== viewId) {
    navigate({ ...state.route, viewId }, true);
  }
});

function titleFor(state: ReturnType<Store['get']>): string {
  const view = state.views?.find((v) => v.id === effectiveViewId(state));
  return view ? `${view.title} · execution-view` : 'execution-view';
}

window.addEventListener('hashchange', () => {
  store.dispatch({ type: 'route', route: parseHash(location.hash) });
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
  }
});

render();

fetchViews().then(
  (list) => store.dispatch({ type: 'views-loaded', views: list }),
  (e: unknown) => store.dispatch({ type: 'views-failed', error: errorMessage(e) }),
);
