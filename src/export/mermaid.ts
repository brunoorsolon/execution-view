import { compareKeys } from '../core/keys.js';
import type { IssueKey, NodeStatus, PlanNode, Snapshot } from '../core/types.js';
import { isMultiRepo, issueLabel, oneLine, orderedNodes, replaceChars } from './shared.js';

const LABEL_ESCAPES: Record<string, string> = {
  '"': '#quot;',
  '#': '#35;',
  '&': '#amp;',
  '[': '#91;',
  ']': '#93;',
  '<': '#lt;',
  '>': '#gt;',
  '{': '#123;',
  '}': '#125;',
  '|': '#124;',
};

/** Escapes text for use inside a double-quoted Mermaid label. `#` is escaped in the same pass. */
export function escapeMermaidLabel(text: string): string {
  return replaceChars(oneLine(text), /["#&[\]<>{}|]/g, LABEL_ESCAPES);
}

const STATUS_CLASS: Record<NodeStatus, string> = {
  ready: 'ready',
  blocked: 'blocked',
  'in-cycle': 'inCycle',
  'blocked-by-cycle': 'blockedByCycle',
};

const STATUS_ORDER: NodeStatus[] = ['ready', 'blocked', 'in-cycle', 'blocked-by-cycle'];

const CLASS_DEFS: string[] = [
  'classDef ready fill:#d1fae5,stroke:#059669,color:#064e3b',
  'classDef blocked fill:#fef3c7,stroke:#d97706,color:#78350f',
  'classDef inCycle fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
  'classDef blockedByCycle fill:#ffedd5,stroke:#ea580c,color:#7c2d12',
  'classDef external stroke-dasharray:5 5',
];

function sanitizeKey(key: IssueKey): string {
  return 'n_' + key.replace(/[^A-Za-z0-9_]/g, '_');
}

export function toMermaid(snapshot: Snapshot): string {
  const { plan } = snapshot;
  const multi = isMultiRepo(plan);
  const nodes = orderedNodes(plan);

  // Sanitizing can map two distinct keys to the same id (`a-b/c#1` vs `a/b-c#1`);
  // disambiguate deterministically, in emission order.
  const ids = new Map<IssueKey, string>();
  const used = new Set<string>();
  const idOf = (key: IssueKey): string => {
    let id = ids.get(key);
    if (id === undefined) {
      const base = sanitizeKey(key);
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
      used.add(id);
      ids.set(key, id);
    }
    return id;
  };
  for (const node of nodes) idOf(node.key);

  const lines: string[] = ['flowchart LR'];

  for (const node of nodes) {
    const label = escapeMermaidLabel(`${issueLabel(node, multi)} ${node.title}`);
    lines.push(`  ${idOf(node.key)}["${label}"]`);
  }

  for (const line of CLASS_DEFS) lines.push(`  ${line}`);

  const byKey = (a: PlanNode, b: PlanNode): number => compareKeys(a.key, b.key);
  for (const status of STATUS_ORDER) {
    const members = nodes.filter((n) => n.status === status).sort(byKey);
    if (members.length > 0) {
      lines.push(`  class ${members.map((n) => idOf(n.key)).join(',')} ${STATUS_CLASS[status]}`);
    }
  }
  const externals = nodes.filter((n) => n.external).sort(byKey);
  if (externals.length > 0) {
    lines.push(`  class ${externals.map((n) => idOf(n.key)).join(',')} external`);
  }

  for (const node of nodes) {
    if (node.url) {
      const url = node.url.replace(/"/g, '%22').replace(/[\r\n]/g, '');
      lines.push(`  click ${idOf(node.key)} href "${url}" _blank`);
    }
  }

  for (const edge of plan.edges) {
    lines.push(`  ${idOf(edge.from)} --> ${idOf(edge.to)}`);
  }

  return lines.join('\n') + '\n';
}
