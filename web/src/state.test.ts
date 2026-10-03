import { describe, expect, it } from 'vitest';
import type { PlanNode, Snapshot } from '../../src/core/types.js';
import type { ViewSummary } from './api.js';
import { DEFAULT_ROUTE, type Tab } from './route.js';
import {
  INITIAL_STATE,
  Store,
  effectiveViewId,
  indexSnapshot,
  problemCount,
  reducer,
  warningsByCode,
  type AppState,
} from './state.js';

const views: ViewSummary[] = [
  { id: 'a', title: 'A', source: 's', kind: 'fixture', repos: ['o/r'] },
  { id: 'b', title: 'B', source: 's', kind: 'fixture', repos: ['o/r', 'o/q'] },
];

function node(key: string, extra: Partial<PlanNode> = {}): PlanNode {
  const [ownerRepo = '', num = '0'] = key.split('#');
  const [owner = '', repo = ''] = ownerRepo.split('/');
  return {
    key,
    repo: { owner, repo },
    number: Number(num),
    title: key,
    url: `https://x/${key}`,
    labels: [],
    assignees: [],
    milestone: null,
    external: false,
    status: 'ready',
    wave: 0,
    order: 0,
    blockedBy: [],
    blocks: [],
    priority: 0,
    remainingDepth: 1,
    ...extra,
  };
}

function snapshot(keys: string[]): Snapshot {
  return {
    viewId: 'a',
    title: 'A',
    fetchedAt: '2026-01-01T00:00:00Z',
    contentHash: 'h'.repeat(64),
    priorityLabels: [],
    orderingMode: 'priority',
    plan: {
      viewId: 'a',
      nodes: keys.map((k) => node(k)),
      edges: [{ from: keys[0]!, to: keys[1] ?? keys[0]!, sources: ['body'] }],
      order: keys,
      waves: [keys],
      cycles: [],
      unschedulable: [],
      criticalPath: keys,
      warnings: [
        { code: 'dangling-reference', message: 'm1', issues: [keys[0]!] },
        { code: 'dangling-reference', message: 'm2', issues: [] },
        { code: 'fetch-error', message: 'm3', issues: [] },
      ],
      stats: {
        total: keys.length,
        ready: 1,
        blocked: 0,
        unschedulable: 0,
        external: 0,
        edges: 1,
        waves: 1,
      },
    },
    layout: { width: 10, height: 10, nodes: [], edges: [] },
  };
}

describe('effectiveViewId', () => {
  it('uses the routed view when it exists, else the first', () => {
    const base = { views, route: DEFAULT_ROUTE };
    expect(effectiveViewId(base)).toBe('a');
    expect(effectiveViewId({ ...base, route: { ...DEFAULT_ROUTE, viewId: 'b' } })).toBe('b');
    expect(effectiveViewId({ ...base, route: { ...DEFAULT_ROUTE, viewId: 'zzz' } })).toBe('a');
    expect(effectiveViewId({ views: null, route: DEFAULT_ROUTE })).toBeNull();
    expect(effectiveViewId({ views: [], route: DEFAULT_ROUTE })).toBeNull();
  });
});

describe('reducer', () => {
  const loaded = (): AppState =>
    reducer(reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'a' }), {
      type: 'load-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1', 'o/r#2']),
    });

  it('tracks the load lifecycle', () => {
    const loading = reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'a' });
    expect(loading.status).toBe('loading');
    const s = loaded();
    expect(s.status).toBe('ready');
    expect(s.snapshot?.plan.nodes).toHaveLength(2);
    const failed = reducer(loading, { type: 'load-failed', viewId: 'a', error: 'boom' });
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('boom');
  });

  it('ignores results for a view that is no longer loaded', () => {
    const loading = reducer({ ...INITIAL_STATE, views }, { type: 'load-start', viewId: 'b' });
    expect(
      reducer(loading, { type: 'load-done', viewId: 'a', snapshot: snapshot(['o/r#1']) }),
    ).toBe(loading);
    expect(reducer(loading, { type: 'load-failed', viewId: 'a', error: 'x' })).toBe(loading);
  });

  it('keeps the selection across a refresh only while the node exists', () => {
    const selected = reducer(loaded(), { type: 'select', key: 'o/r#2' });
    const kept = reducer(selected, {
      type: 'refresh-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1', 'o/r#2', 'o/r#3']),
    });
    expect(kept.selected).toBe('o/r#2');
    const dropped = reducer(selected, {
      type: 'refresh-done',
      viewId: 'a',
      snapshot: snapshot(['o/r#1']),
    });
    expect(dropped.selected).toBeNull();
  });

  it('clears the selection when another view is loaded', () => {
    const selected = reducer(loaded(), { type: 'select', key: 'o/r#2' });
    const other = reducer(selected, { type: 'load-start', viewId: 'b' });
    expect(other.selected).toBeNull();
    expect(other.snapshot).toBeNull();
  });

  it('shows and dismisses refresh errors without dropping the snapshot', () => {
    let s = reducer(loaded(), { type: 'refresh-start', viewId: 'a' });
    expect(s.refreshing).toBe(true);
    s = reducer(s, { type: 'refresh-failed', viewId: 'a', error: 'bad gateway' });
    expect(s.refreshing).toBe(false);
    expect(s.refreshError).toBe('bad gateway');
    expect(s.snapshot).not.toBeNull();
    s = reducer(s, { type: 'dismiss-refresh-error' });
    expect(s.refreshError).toBeNull();
  });
});

describe('Store', () => {
  it('notifies subscribers only on change', () => {
    const store = new Store();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: 'select', key: 'o/r#1' });
    store.dispatch({ type: 'select', key: 'o/r#1' });
    expect(calls).toBe(1);
    off();
    store.dispatch({ type: 'select', key: null });
    expect(calls).toBe(1);
    expect(store.get().selected).toBeNull();
  });
});

describe('select reveals a hidden issue', () => {
  const loaded = (q: string, tab: Tab = 'graph'): Store => {
    const store = new Store({ ...INITIAL_STATE, views, route: { ...DEFAULT_ROUTE, tab, q } });
    store.dispatch({ type: 'load-start', viewId: 'a' });
    store.dispatch({ type: 'load-done', viewId: 'a', snapshot: snapshot(['o/r#1', 'o/q#1']) });
    return store;
  };

  it('narrows the filter to the repository of a hidden issue', () => {
    const store = loaded('repo:o/r');
    store.dispatch({ type: 'select', key: 'o/q#1' });
    expect(store.get().route.q).toBe('repo:o/q');
    expect(store.get().selected).toBe('o/q#1');
  });

  it('keeps the filter for an issue it already shows', () => {
    const store = loaded('repo:o/r');
    const route = store.get().route;
    store.dispatch({ type: 'select', key: 'o/r#1' });
    expect(store.get().route).toBe(route);
    expect(store.get().selected).toBe('o/r#1');
  });

  it('stays on the current tab', () => {
    const store = loaded('repo:o/r', 'problems');
    store.dispatch({ type: 'select', key: 'o/q#1' });
    expect(store.get().route.tab).toBe('problems');
  });
});

describe('snapshot helpers', () => {
  it('indexes nodes, detects multi-repo views and critical edges', () => {
    const snap = snapshot(['o/r#1', 'o/r#2']);
    const single = indexSnapshot(snap, ['o/r']);
    expect(single.multiRepo).toBe(false);
    expect(single.nodes.get('o/r#2')?.number).toBe(2);
    expect(single.criticalEdges.has('o/r#1->o/r#2')).toBe(true);
    expect(indexSnapshot(snap, ['o/r', 'o/q']).multiRepo).toBe(true);
    expect(indexSnapshot(snapshot(['o/r#1', 'o/q#1']), []).multiRepo).toBe(true);
  });

  it('counts problems and groups warnings by code in order', () => {
    const snap = snapshot(['o/r#1']);
    expect(problemCount(snap)).toBe(3);
    const groups = warningsByCode(snap.plan.warnings);
    expect([...groups.keys()]).toEqual(['dangling-reference', 'fetch-error']);
    expect(groups.get('dangling-reference')).toHaveLength(2);
  });
});
