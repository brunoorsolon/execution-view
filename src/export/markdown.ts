import type { IssueKey, OrderingMode, PlanNode, Snapshot } from '../core/types.js';
import { isMultiRepo, issueLabel, keyLabel, nodeIndex, oneLine, replaceChars } from './shared.js';

const MD_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '`': '\\`',
  '*': '\\*',
  _: '\\_',
  '[': '\\[',
  ']': '\\]',
  '|': '\\|',
  '<': '&lt;',
  '>': '&gt;',
};

/** Escapes text for a markdown table cell or heading: no newlines, no `|`, no inline markup. */
export function escapeMarkdown(text: string): string {
  return replaceChars(oneLine(text), /[\\`*_[\]|<>]/g, MD_ESCAPES);
}

/** Percent-encodes the characters that would end a markdown link destination early. */
function escapeUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function issueLink(node: PlanNode, multi: boolean): string {
  const text = escapeMarkdown(issueLabel(node, multi));
  const link = node.url ? `[${text}](${escapeUrl(node.url)})` : text;
  return node.external ? `${link} (external)` : link;
}

/** The legend sentence that explains how the # column is ordered. */
function orderLegend(mode: OrderingMode): string {
  if (mode === 'waves') {
    return 'The # column runs wave by wave; within a wave, by priority and critical path.';
  }
  return (
    'The # column favours priority labels and the critical path: an issue from a later wave can ' +
    'come before an earlier-wave issue once its prerequisites are done.'
  );
}

export function toMarkdown(snapshot: Snapshot): string {
  const { plan, priorityLabels } = snapshot;
  const multi = isMultiRepo(plan);
  const nodes = nodeIndex(plan);
  const position = new Map<IssueKey, number>();
  plan.order.forEach((key, i) => position.set(key, i + 1));
  const critical = new Set<IssueKey>(plan.criticalPath);

  const blockedBy = (node: PlanNode): string =>
    node.blockedBy.length === 0
      ? ''
      : escapeMarkdown(node.blockedBy.map((k) => keyLabel(k, nodes, multi)).join(', '));

  const priority = (node: PlanNode): string => escapeMarkdown(priorityLabels[node.priority] ?? '');

  const s = plan.stats;
  const out: string[] = [
    `# ${escapeMarkdown(snapshot.title)}`,
    '',
    `View \`${snapshot.viewId}\` · fetched ${snapshot.fetchedAt} · hash \`${snapshot.contentHash.slice(0, 12)}\``,
    '',
    `${s.total} issues · ${s.ready} ready · ${s.blocked} blocked · ${s.unschedulable} unschedulable · ` +
      `${s.external} external · ${s.edges} dependencies · ${s.waves} waves`,
    '',
    '## Execution order',
    '',
    'Waves are numbered from 1. Issues in the same wave can be worked on in parallel once all ' +
      'earlier waves are done. ★ marks the critical path. ' +
      orderLegend(snapshot.orderingMode),
  ];

  if (plan.waves.length === 0) {
    out.push('', '_No schedulable issues._');
  }

  plan.waves.forEach((wave, i) => {
    out.push(
      '',
      `### Wave ${i + 1}`,
      '',
      '| # | Issue | Title | Priority | Status | Blocked by |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const key of wave) {
      const node = nodes.get(key);
      if (!node) continue;
      const pos = `${position.get(key) ?? ''}${critical.has(key) ? ' ★' : ''}`.trim();
      out.push(
        `| ${pos} | ${issueLink(node, multi)} | ${escapeMarkdown(node.title)} | ${priority(node)} | ${node.status} | ${blockedBy(node)} |`,
      );
    }
  });

  const unschedulable = plan.unschedulable
    .map((k) => nodes.get(k))
    .filter((n): n is PlanNode => n !== undefined);
  if (unschedulable.length > 0) {
    out.push(
      '',
      '## Unschedulable',
      '',
      'These issues cannot be ordered because they are in a dependency cycle or depend on one.',
      '',
      '| Issue | Title | Priority | Status | Blocked by |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const node of unschedulable) {
      out.push(
        `| ${issueLink(node, multi)} | ${escapeMarkdown(node.title)} | ${priority(node)} | ${node.status} | ${blockedBy(node)} |`,
      );
    }
  }

  if (plan.cycles.length > 0) {
    out.push('', '## Cycles', '');
    plan.cycles.forEach((cycle, i) => {
      const members = cycle.map((k) => keyLabel(k, nodes, multi)).join(', ');
      out.push(`- Cycle ${i + 1}: ${escapeMarkdown(members)}`);
    });
  }

  if (plan.warnings.length > 0) {
    out.push('', '## Warnings', '');
    for (const w of plan.warnings) {
      out.push(`- **${w.code}**: ${oneLine(w.message)}`);
    }
  }

  return out.join('\n') + '\n';
}
