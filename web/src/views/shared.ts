import type { IssueKey, PlanNode, Snapshot } from '../../../src/core/types.js';
import type { AppState, Store } from '../state.js';
import { effectiveViewId, indexSnapshot, type SnapshotIndex } from '../state.js';
import { compileFilter, type FilterTarget } from '../filter.js';
import type { Tab } from '../route.js';
import { h } from '../dom.js';

export interface Actions {
  /** Select (or clear with null) a node. */
  select(key: IssueKey | null): void;
  /** Select the node and switch to the graph tab. */
  showInGraph(key: IssueKey): void;
  setTab(tab: Tab): void;
  setView(viewId: string): void;
  setQuery(q: string): void;
  refresh(): void;
  reload(): void;
}

export interface ViewCtx {
  store: Store;
  actions: Actions;
}

export interface View {
  el: HTMLElement;
  update(state: AppState, prev: AppState): void;
}

const indexCache = new WeakMap<Snapshot, SnapshotIndex>();

/** Index of the snapshot of `state`, computed once per snapshot object. */
export function getIndex(state: AppState): SnapshotIndex | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;
  let index = indexCache.get(snapshot);
  if (index === undefined) {
    const viewId = effectiveViewId(state);
    const repos = state.views?.find((v) => v.id === viewId)?.repos ?? [];
    index = indexSnapshot(snapshot, repos);
    indexCache.set(snapshot, index);
  }
  return index;
}

export function nodeTarget(n: PlanNode): FilterTarget {
  return { key: n.key, number: n.number, title: n.title, labels: n.labels };
}

let lastQuery: string | null = null;
let lastFilter: ((t: FilterTarget) => boolean) | null = null;

/** Compiled filter for the query (memoized), or null when nothing is filtered. */
export function filterFor(q: string): ((t: FilterTarget) => boolean) | null {
  if (q !== lastQuery) {
    lastQuery = q;
    lastFilter = compileFilter(q);
  }
  return lastFilter;
}

/** Keys of nodes that do NOT match the filter (empty set when no filter). */
export function filteredOut(state: AppState, index: SnapshotIndex): Set<IssueKey> {
  const f = filterFor(state.route.q);
  const out = new Set<IssueKey>();
  if (f === null) return out;
  for (const n of index.nodes.values()) if (!f(nodeTarget(n))) out.add(n.key);
  return out;
}

export function statusPill(label: string, status: string): HTMLElement {
  return h('span', { class: `pill status-${status}` }, label);
}

export function labelChip(label: string, extraClass = ''): HTMLElement {
  return h('span', { class: `chip ${extraClass}`.trim(), title: label }, label);
}

/** Only http(s) URLs are linked; anything else (javascript:, data:) becomes an inert "#". */
export function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

export function issueLink(key: IssueKey, url: string, text: string, title?: string): HTMLElement {
  return h(
    'a',
    {
      class: 'issue-link',
      href: safeUrl(url),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: title ?? key,
    },
    text,
  );
}
