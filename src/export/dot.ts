import type { NodeStatus, PlanNode, Snapshot } from '../core/types.js';
import { isMultiRepo, issueLabel, nodeIndex, oneLine } from './shared.js';

const FILL: Record<NodeStatus, string> = {
  ready: '#d1fae5',
  blocked: '#fef3c7',
  'in-cycle': '#fecaca',
  'blocked-by-cycle': '#fed7aa',
};

/** Escapes text for a double-quoted DOT string: backslash and quote, newlines as `\n`. */
export function escapeDot(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const q = (text: string): string => `"${escapeDot(text)}"`;

export function toDot(snapshot: Snapshot): string {
  const { plan } = snapshot;
  const multi = isMultiRepo(plan);
  const nodes = nodeIndex(plan);
  const emitted = new Set<string>();

  const nodeLine = (node: PlanNode, indent: string): string => {
    emitted.add(node.key);
    const attrs = [
      `label=${q(`${issueLabel(node, multi)} ${oneLine(node.title)}`)}`,
      `fillcolor=${q(FILL[node.status])}`,
    ];
    if (node.external) attrs.push('style="rounded,filled,dashed"');
    if (node.url) attrs.push(`URL=${q(node.url)}`);
    return `${indent}${q(node.key)} [${attrs.join(', ')}];`;
  };

  const lines: string[] = [
    'digraph "execution-view" {',
    '  rankdir=LR;',
    '  node [shape=box, style="rounded,filled"];',
  ];

  // Wave names are 1-based, matching the Markdown export.
  plan.waves.forEach((wave, i) => {
    const members = wave.map((k) => nodes.get(k)).filter((n): n is PlanNode => n !== undefined);
    lines.push(`  subgraph "wave_${i + 1}" {`, '    rank=same;');
    for (const node of members) lines.push(nodeLine(node, '    '));
    lines.push('  }');
  });

  const unschedulable = plan.unschedulable
    .map((k) => nodes.get(k))
    .filter((n): n is PlanNode => n !== undefined);
  if (unschedulable.length > 0) {
    lines.push('  subgraph "unschedulable" {', '    rank=same;');
    for (const node of unschedulable) lines.push(nodeLine(node, '    '));
    lines.push('  }');
  }

  // Defensive: nodes that belong to no wave and are not listed as unschedulable.
  for (const node of plan.nodes) {
    if (!emitted.has(node.key)) lines.push(nodeLine(node, '  '));
  }

  for (const edge of plan.edges) {
    lines.push(`  ${q(edge.from)} -> ${q(edge.to)};`);
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}
