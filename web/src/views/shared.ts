import type { IssueKey, PlanNode, Snapshot } from '../../../src/core/types.js';
import type { AppState, Store } from '../state.js';
import { effectiveViewId, indexSnapshot, type SnapshotIndex } from '../state.js';
import { compileFilter, type FilterTarget } from '../filter.js';
import { displayStatus, isClaimed, statusLabel, type DisplayStatus } from '../format.js';
import { priorityName } from '../priority.js';
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

export function nodeTarget(n: PlanNode, snapshot: Snapshot, index: SnapshotIndex): FilterTarget {
  return {
    key: n.key,
    number: n.number,
    title: n.title,
    labels: n.labels,
    assignees: n.assignees,
    milestone: n.milestone,
    repo: `${n.repo.owner}/${n.repo.repo}`,
    status: n.status,
    external: n.external,
    priority: priorityName(snapshot, n),
    critical: index.criticalNodes.has(n.key),
  };
}

let visibleFor: { snapshot: Snapshot; q: string; keys: Set<IssueKey> | null } | null = null;

/**
 * Keys of the issues that match the filter, or null when nothing is filtered.
 * Memoized per (snapshot, query): the same Set object is returned until either
 * changes, so views can compare it by identity.
 */
export function visibleKeys(state: AppState, index: SnapshotIndex): Set<IssueKey> | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;
  if (visibleFor?.snapshot === snapshot && visibleFor.q === state.route.q) return visibleFor.keys;
  const f = compileFilter(state.route.q);
  let keys: Set<IssueKey> | null = null;
  if (f !== null) {
    keys = new Set();
    for (const n of snapshot.plan.nodes) if (f(nodeTarget(n, snapshot, index))) keys.add(n.key);
  }
  visibleFor = { snapshot, q: state.route.q, keys };
  return keys;
}

export function isVisible(keys: Set<IssueKey> | null, key: IssueKey): boolean {
  return keys === null || keys.has(key);
}

export function statusBadges(node: PlanNode): HTMLElement {
  const badge = (status: DisplayStatus): HTMLElement =>
    h('span', { class: `badge st-${status}` }, statusLabel(status));
  return h(
    'span',
    { class: 'status-badges' },
    badge(displayStatus(node)),
    node.status !== 'ready' && isClaimed(node.labels) ? badge('in-progress') : null,
  );
}

export function labelChip(label: string): HTMLElement {
  return h('span', { class: 'label', title: label }, label);
}

/** Priority tag; the most urgent configured priority is filled. */
export function priorityTag(name: string, rank: number): HTMLElement {
  return h('span', { class: `prio${rank === 0 ? ' prio-top' : ''}` }, name);
}

/** Labels of a node without its priority label (shown separately). */
export function otherLabels(n: PlanNode, priority: string | null): string[] {
  const p = priority?.toLowerCase();
  return n.labels.filter((l) => l.toLowerCase() !== p);
}

const AVATAR_TONES = 6;

export function avatar(login: string): HTMLElement {
  let hash = 0;
  for (const c of login) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return h(
    'span',
    { class: `avatar tone-${hash % AVATAR_TONES}`, title: `@${login}`, 'aria-hidden': 'true' },
    login.slice(0, 2),
  );
}

export function avatars(logins: readonly string[], max = 3): HTMLElement {
  if (logins.length === 0) return h('span', { class: 'muted small' }, 'None');
  return h(
    'span',
    { class: 'avatars', title: logins.map((a) => `@${a}`).join(', ') },
    ...logins.slice(0, max).map(avatar),
    h('span', { class: 'sr-only' }, logins.map((a) => `@${a}`).join(', ')),
  );
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
