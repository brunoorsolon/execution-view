import { compareKeys } from '../core/keys.js';
import type { NodeStatus, PlanNode, Snapshot } from '../core/types.js';

export const TRICKY_TITLE = 'Fix "login" | SSO [wip] #42 <b>';

interface NodeSpec {
  repo: string;
  number: number;
  title: string;
  status: NodeStatus;
  external?: boolean;
  wave: number | null;
  order: number | null;
  blockedBy?: string[];
  blocks?: string[];
  /** Index in the snapshot's priorityLabels; default 2 (no priority label). */
  priority?: number;
}

function node(spec: NodeSpec): PlanNode {
  const [owner, repo] = spec.repo.split('/') as [string, string];
  return {
    key: `${spec.repo}#${spec.number}`,
    repo: { owner, repo },
    number: spec.number,
    title: spec.title,
    url: `https://github.com/${spec.repo}/issues/${spec.number}`,
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    external: spec.external ?? false,
    status: spec.status,
    wave: spec.wave,
    order: spec.order,
    blockedBy: spec.blockedBy ?? [],
    blocks: spec.blocks ?? [],
    parents: [],
    children: [],
    priority: spec.priority ?? 2,
    remainingDepth: spec.wave === null ? 0 : 1,
  };
}

/**
 * Hand-made snapshot: 2 waves, a cycle (#10 <-> #11), a blocked-by-cycle node (#12),
 * an external node, a title with awkward characters (#2) and warnings.
 *
 * `externalRepo` is where the external node lives: 'acme/lib' makes the plan span two
 * repositories, 'acme/api' keeps it to one.
 */
export function makeSnapshot(externalRepo: 'acme/lib' | 'acme/api' = 'acme/lib'): Snapshot {
  const ext = `${externalRepo}#${externalRepo === 'acme/lib' ? 7 : 99}`;
  const extNumber = externalRepo === 'acme/lib' ? 7 : 99;
  const nodes: PlanNode[] = [
    node({
      repo: 'acme/api',
      number: 1,
      title: 'Set up schema',
      priority: 0,
      status: 'ready',
      wave: 0,
      order: 1,
      blocks: ['acme/api#2', 'acme/api#3'],
    }),
    node({
      repo: 'acme/api',
      number: 2,
      title: TRICKY_TITLE,
      priority: 1,
      status: 'blocked',
      wave: 1,
      order: 2,
      blockedBy: ['acme/api#1'],
    }),
    node({
      repo: 'acme/api',
      number: 3,
      title: 'Write docs',
      status: 'blocked',
      wave: 1,
      order: 3,
      blockedBy: ['acme/api#1', ext],
    }),
    node({
      repo: 'acme/api',
      number: 10,
      title: 'Cycle A',
      priority: 1,
      status: 'in-cycle',
      wave: null,
      order: null,
      blockedBy: ['acme/api#11'],
      blocks: ['acme/api#11'],
    }),
    node({
      repo: 'acme/api',
      number: 11,
      title: 'Cycle B',
      status: 'in-cycle',
      wave: null,
      order: null,
      blockedBy: ['acme/api#10'],
      blocks: ['acme/api#10', 'acme/api#12'],
    }),
    node({
      repo: 'acme/api',
      number: 12,
      title: 'Behind the cycle',
      status: 'blocked-by-cycle',
      wave: null,
      order: null,
      blockedBy: ['acme/api#11'],
    }),
    node({
      repo: externalRepo,
      number: extNumber,
      title: 'Upstream library release',
      status: 'ready',
      external: true,
      wave: 0,
      order: 0,
      blocks: ['acme/api#3'],
    }),
  ].sort((a, b) => compareKeys(a.key, b.key));

  const critical = ['acme/api#1', 'acme/api#2'];
  return {
    viewId: 'platform',
    title: 'Platform roadmap',
    fetchedAt: '2026-01-02T03:04:05.000Z',
    contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    priorityLabels: ['P0', 'P1'],
    orderingMode: 'priority',
    plan: {
      viewId: 'platform',
      nodes,
      edges: [
        { from: 'acme/api#1', to: 'acme/api#2', sources: ['native'] },
        { from: 'acme/api#1', to: 'acme/api#3', sources: ['body', 'native'] },
        { from: 'acme/api#10', to: 'acme/api#11', sources: ['body'] },
        { from: 'acme/api#11', to: 'acme/api#10', sources: ['body'] },
        { from: 'acme/api#11', to: 'acme/api#12', sources: ['body'] },
        { from: ext, to: 'acme/api#3', sources: ['native'] },
      ],
      order: [ext, 'acme/api#1', 'acme/api#2', 'acme/api#3'],
      waves: [
        [ext, 'acme/api#1'],
        ['acme/api#2', 'acme/api#3'],
      ],
      cycles: [['acme/api#10', 'acme/api#11']],
      unschedulable: ['acme/api#10', 'acme/api#11', 'acme/api#12'],
      criticalPath: critical,
      warnings: [
        {
          code: 'blocked-by-cycle',
          message: '1 issue is blocked by a cycle: acme/api#12',
          issues: ['acme/api#12'],
        },
        {
          code: 'cycle',
          message: 'Dependency cycle between acme/api#10 and acme/api#11',
          issues: ['acme/api#10', 'acme/api#11'],
        },
        {
          code: 'dangling-reference',
          message: 'acme/api#2 references acme/api#404 | which\ndoes not exist',
          issues: ['acme/api#2'],
        },
      ],
      stats: {
        total: 7,
        ready: 2,
        blocked: 2,
        unschedulable: 3,
        external: 1,
        edges: 6,
        waves: 2,
      },
    },
    layout: { width: 0, height: 0, nodes: [], edges: [] },
  };
}
