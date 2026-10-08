import { compareKeys } from '../../src/core/keys.js';
import type { IssueKey, LayoutNode, PlanNode } from '../../src/core/types.js';

/** Order of the issues inside each wave. `execution` keeps the server's order. */
export type SortMode = 'execution' | 'number' | 'updated' | 'prereq' | 'dependents';

/** The modes that compare two nodes directly; `execution` reads the server's order. */
export type SortKey = Exclude<SortMode, 'execution'>;

export const SORT_MODES: readonly SortMode[] = [
  'execution',
  'number',
  'updated',
  'prereq',
  'dependents',
];

/** The mode a route without an explicit choice gets. */
export const DEFAULT_SORT: SortMode = 'number';

export function isSortMode(value: string | null): value is SortMode {
  return value !== null && (SORT_MODES as readonly string[]).includes(value);
}

/** Epoch milliseconds of an ISO timestamp; null when it is missing or unparseable. */
function instant(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Orders two plan nodes for `mode`. The issue number reads low to high; the
 * counts and the update time put the most first, because the most blocked, most
 * depended-on and most recently changed issue is what a reader looks for. An
 * unknown timestamp sorts last.
 */
export function compareNodes(a: PlanNode, b: PlanNode, mode: SortKey): number {
  switch (mode) {
    case 'number':
      return a.number - b.number;
    case 'updated': {
      const ta = instant(a.updatedAt);
      const tb = instant(b.updatedAt);
      if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
      return tb - ta;
    }
    case 'prereq':
      return b.blockedBy.length - a.blockedBy.length;
    case 'dependents':
      return b.blocks.length - a.blocks.length;
  }
}

/** `keys` under `mode`, ties broken with compareKeys so the result is a total order. */
export function sortKeys(
  keys: readonly IssueKey[],
  nodes: ReadonlyMap<IssueKey, PlanNode>,
  mode: SortKey,
): IssueKey[] {
  return [...keys].sort((a, b) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    const c = na !== undefined && nb !== undefined ? compareNodes(na, nb, mode) : 0;
    return c !== 0 ? c : compareKeys(a, b);
  });
}

/**
 * The layout nodes with each layer's `row` replaced by the rank its key holds
 * under `mode`, so `packLayout` stacks a wave column in that order. `execution`
 * keeps the server's rows.
 */
export function rankLayoutRows(
  nodes: readonly LayoutNode[],
  planNodes: ReadonlyMap<IssueKey, PlanNode>,
  mode: SortMode,
): readonly { key: IssueKey; layer: number; row: number }[] {
  if (mode === 'execution') return nodes;
  const byLayer = new Map<number, IssueKey[]>();
  for (const n of nodes) {
    const list = byLayer.get(n.layer);
    if (list) list.push(n.key);
    else byLayer.set(n.layer, [n.key]);
  }
  return [...byLayer].flatMap(([layer, keys]) =>
    sortKeys(keys, planNodes, mode).map((key, row) => ({ key, layer, row })),
  );
}
