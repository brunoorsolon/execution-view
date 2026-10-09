import { DEFAULT_SORT, isSortMode, type SortMode } from './sort.js';

export type Tab = 'graph' | 'order' | 'problems';

export const TABS: readonly Tab[] = ['graph', 'order', 'problems'];

export interface Route {
  /** null: not specified, use the first view. */
  viewId: string | null;
  tab: Tab;
  /** Filter query. */
  q: string;
  /** Order of the issues inside each wave. */
  sort: SortMode;
}

export const DEFAULT_ROUTE: Route = {
  viewId: null,
  tab: 'graph',
  q: '',
  sort: DEFAULT_SORT,
};

function isTab(s: string | undefined): s is Tab {
  return s !== undefined && (TABS as readonly string[]).includes(s);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses `#/view/<id>/<tab>?q=<query>&sort=<mode>`. Tolerant: unknown input gives defaults. */
export function parseHash(hash: string): Route {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  let q = '';
  let sort: SortMode = DEFAULT_SORT;
  const qi = s.indexOf('?');
  if (qi >= 0) {
    const params = new URLSearchParams(s.slice(qi + 1));
    q = params.get('q') ?? '';
    const raw = params.get('sort');
    sort = isSortMode(raw) ? raw : DEFAULT_SORT;
    s = s.slice(0, qi);
  }
  const parts = s.split('/').filter((p) => p !== '');
  let viewId: string | null = null;
  let tab: Tab = 'graph';
  if (parts[0] === 'view' && parts[1] !== undefined) {
    viewId = safeDecode(parts[1]);
    if (isTab(parts[2])) tab = parts[2];
  }
  return { viewId, tab, q, sort };
}

export function serializeHash(route: Route): string {
  let query = route.q === '' ? '' : `?q=${encodeURIComponent(route.q)}`;
  if (route.sort !== DEFAULT_SORT) query += `${query === '' ? '?' : '&'}sort=${route.sort}`;
  if (route.viewId === null) return `#/${query}`;
  return `#/view/${encodeURIComponent(route.viewId)}/${route.tab}${query}`;
}
