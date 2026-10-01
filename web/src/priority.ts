import type { PlanNode, Snapshot } from '../../src/core/types.js';

/**
 * The configured priority label of a node, or null when it has none.
 * `node.priority` indexes `snapshot.priorityLabels`; an index outside the list
 * (normally `priorityLabels.length`) means "no priority label".
 */
export function priorityName(
  snapshot: Pick<Snapshot, 'priorityLabels'>,
  node: Pick<PlanNode, 'priority'>,
): string | null {
  return snapshot.priorityLabels[node.priority] ?? null;
}
