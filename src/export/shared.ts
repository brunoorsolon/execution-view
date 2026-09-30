import { compareKeys } from '../core/keys.js';
import type { IssueKey, Plan, PlanNode } from '../core/types.js';

/** Index of the plan's nodes by key. */
export function nodeIndex(plan: Plan): Map<IssueKey, PlanNode> {
  const map = new Map<IssueKey, PlanNode>();
  for (const node of plan.nodes) map.set(node.key, node);
  return map;
}

/** True when the plan spans more than one repository. */
export function isMultiRepo(plan: Plan): boolean {
  const repos = new Set<string>();
  for (const node of plan.nodes) repos.add(`${node.repo.owner}/${node.repo.repo}`);
  return repos.size > 1;
}

/** Short human label of an issue: `#N`, or the full `owner/repo#N` for multi-repo plans. */
export function issueLabel(node: PlanNode, multiRepo: boolean): string {
  return multiRepo ? node.key : `#${node.number}`;
}

/** Label for a key that may not be in the node index (falls back to the key itself). */
export function keyLabel(
  key: IssueKey,
  nodes: Map<IssueKey, PlanNode>,
  multiRepo: boolean,
): string {
  const node = nodes.get(key);
  return node ? issueLabel(node, multiRepo) : key;
}

/**
 * Nodes in presentation order: schedulable nodes by plan.order, then the
 * unschedulable ones by key, then (defensively) anything left, by key.
 */
export function orderedNodes(plan: Plan): PlanNode[] {
  const nodes = nodeIndex(plan);
  const seen = new Set<IssueKey>();
  const result: PlanNode[] = [];
  const push = (key: IssueKey): void => {
    const node = nodes.get(key);
    if (node && !seen.has(key)) {
      seen.add(key);
      result.push(node);
    }
  };
  for (const key of plan.order) push(key);
  for (const key of [...plan.unschedulable].sort(compareKeys)) push(key);
  for (const key of [...nodes.keys()].sort(compareKeys)) push(key);
  return result;
}

/** Collapses CR/LF runs into single spaces so a value stays on one line. */
export function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/** Replaces every character matched by `pattern` using `map`, in a single pass. */
export function replaceChars(text: string, pattern: RegExp, map: Record<string, string>): string {
  return text.replace(pattern, (ch) => map[ch] ?? ch);
}
