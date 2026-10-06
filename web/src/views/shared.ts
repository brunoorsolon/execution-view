import type { DependencySource, IssueKey, PlanNode } from '../../../src/core/types.js';
import type { AppState, Store } from '../state.js';
import {
  displayStatus,
  sourceLabel,
  statusLabel,
  workflowStatus,
  type DisplayStatus,
} from '../format.js';
import type { Tab } from '../route.js';
import { h } from '../dom.js';

export { getIndex, isVisible, nodeTarget, visibleKeys } from '../state.js';

export interface Actions {
  /** Select (or clear with null) a node; a node the filter hides is revealed first. */
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

export function statusBadges(node: PlanNode): HTMLElement {
  const badge = (status: DisplayStatus): HTMLElement =>
    h('span', { class: `badge st-${status}` }, statusLabel(status));
  const shown = displayStatus(node);
  const workflow = workflowStatus(node.labels);
  return h(
    'span',
    { class: 'status-badges' },
    badge(shown),
    workflow !== null && workflow !== shown ? badge(workflow) : null,
  );
}

export function labelChip(label: string): HTMLElement {
  return h('span', { class: 'label', title: label }, label);
}

/**
 * Text marker naming where a dependency link was declared. Reads on its own
 * ("native", "body", "native + body"), never colour alone.
 */
export function sourceTag(sources: readonly DependencySource[]): HTMLElement | null {
  if (sources.length === 0) return null;
  return h(
    'span',
    { class: 'src-tag', title: `Declared by: ${sourceLabel(sources)}` },
    sourceLabel(sources),
  );
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
