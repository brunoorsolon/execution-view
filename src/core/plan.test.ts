import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from './hash.js';
import { buildPlan, type PlanInput } from './plan.js';
import type {
  DependencyEdge,
  DependencySource,
  Issue,
  IssueKey,
  OrderingMode,
  Plan,
} from './types.js';

function issue(key: IssueKey, extra: Partial<Issue> = {}): Issue {
  const m = /^(.+)\/(.+)#(\d+)$/.exec(key)!;
  return {
    key,
    repo: { owner: m[1]!, repo: m[2]! },
    number: Number(m[3]),
    title: `Title ${key}`,
    state: 'open',
    url: `https://example.test/${m[1]}/${m[2]}/issues/${m[3]}`,
    body: '',
    labels: [],
    assignees: [],
    milestone: null,
    nativeRelations: [],
    ...extra,
  };
}

function edge(
  from: IssueKey,
  to: IssueKey,
  sources: DependencySource[] = ['native'],
): DependencyEdge {
  return { from, to, sources };
}

function input(
  keys: IssueKey[],
  edges: DependencyEdge[],
  extra: Partial<PlanInput> = {},
): PlanInput {
  return {
    viewId: 'v',
    issues: keys.map((k) => issue(k)),
    externalKeys: [],
    edges,
    warnings: [],
    priorityLabels: [],
    ...extra,
  };
}

const K = (n: number): IssueKey => `o/r#${n}`;

function node(plan: Plan, key: IssueKey) {
  const n = plan.nodes.find((x) => x.key === key);
  if (!n) throw new Error(`no node ${key}`);
  return n;
}

describe('buildPlan', () => {
  it('handles empty input', () => {
    const plan = buildPlan(input([], []));
    expect(plan).toEqual({
      viewId: 'v',
      nodes: [],
      edges: [],
      order: [],
      waves: [],
      cycles: [],
      unschedulable: [],
      criticalPath: [],
      warnings: [],
      stats: { total: 0, ready: 0, blocked: 0, unschedulable: 0, external: 0, edges: 0, waves: 0 },
    });
  });

  it('copies issue fields into nodes', () => {
    const plan = buildPlan({
      ...input([], []),
      issues: [
        issue(K(1), {
          labels: ['a', 'b'],
          assignees: ['bob'],
          milestone: 'M1',
          title: 'Hello',
          url: 'https://x.test/1',
        }),
      ],
    });
    expect(plan.nodes[0]).toEqual({
      key: K(1),
      repo: { owner: 'o', repo: 'r' },
      number: 1,
      title: 'Hello',
      url: 'https://x.test/1',
      labels: ['a', 'b'],
      assignees: ['bob'],
      milestone: 'M1',
      external: false,
      status: 'ready',
      wave: 0,
      order: 0,
      blockedBy: [],
      blocks: [],
      parents: [],
      children: [],
      priority: 0,
      remainingDepth: 1,
    });
  });

  it('orders a chain', () => {
    const plan = buildPlan(input([K(3), K(1), K(2)], [edge(K(1), K(2)), edge(K(2), K(3))]));
    expect(plan.order).toEqual([K(1), K(2), K(3)]);
    expect(plan.waves).toEqual([[K(1)], [K(2)], [K(3)]]);
    expect(plan.criticalPath).toEqual([K(1), K(2), K(3)]);
    expect(plan.nodes.map((n) => n.remainingDepth)).toEqual([3, 2, 1]);
    expect(plan.nodes.map((n) => n.status)).toEqual(['ready', 'blocked', 'blocked']);
    expect(node(plan, K(2)).blockedBy).toEqual([K(1)]);
    expect(node(plan, K(2)).blocks).toEqual([K(3)]);
    expect(plan.stats).toMatchObject({ total: 3, ready: 1, blocked: 2, waves: 3, edges: 2 });
  });

  it('handles a diamond', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4)],
        [edge(K(1), K(2)), edge(K(1), K(3)), edge(K(2), K(4)), edge(K(3), K(4))],
      ),
    );
    expect(plan.order).toEqual([K(1), K(2), K(3), K(4)]);
    expect(plan.waves).toEqual([[K(1)], [K(2), K(3)], [K(4)]]);
    expect(node(plan, K(4)).blockedBy).toEqual([K(2), K(3)]);
    expect(node(plan, K(1)).blocks).toEqual([K(2), K(3)]);
    expect(plan.criticalPath).toEqual([K(1), K(2), K(4)]);
  });

  it('parent links fill parents and children without changing edges, waves or order', () => {
    const keys = [K(1), K(2), K(3)];
    const withEdges = input(keys, [edge(K(1), K(2)), edge(K(2), K(3))]);
    const withParent: PlanInput = {
      ...input(keys, [edge(K(1), K(2)), edge(K(2), K(3))]),
      parentLinks: [
        { parent: K(1), child: K(2) },
        { parent: K(1), child: K(3) },
      ],
    };
    const base = buildPlan(withEdges);
    const plan = buildPlan(withParent);
    expect(plan.edges).toEqual(base.edges);
    expect(plan.order).toEqual(base.order);
    expect(plan.waves).toEqual(base.waves);
    expect(plan.criticalPath).toEqual(base.criticalPath);
    expect(plan.stats).toEqual(base.stats);
    expect(node(plan, K(1)).parents).toEqual([]);
    expect(node(plan, K(1)).children).toEqual([K(2), K(3)]);
    expect(node(plan, K(2)).parents).toEqual([K(1)]);
    expect(node(plan, K(3)).parents).toEqual([K(1)]);
  });

  it('drops parent links that reference issues outside the plan and self-links', () => {
    const plan = buildPlan({
      ...input([K(1)], []),
      parentLinks: [
        { parent: K(99), child: K(1) },
        { parent: K(1), child: K(98) },
        { parent: K(1), child: K(1) },
      ],
    });
    expect(node(plan, K(1)).parents).toEqual([]);
    expect(node(plan, K(1)).children).toEqual([]);
  });

  it('the content hash covers parents and children', () => {
    const keys = [K(1), K(2)];
    const without = buildPlan(input(keys, []));
    const withParent = buildPlan({
      ...input(keys, []),
      parentLinks: [{ parent: K(1), child: K(2) }],
    });
    expect(contentHash(withParent)).not.toBe(contentHash(without));
  });

  it('puts independent nodes in wave 0 in key order', () => {
    const plan = buildPlan(input([K(10), K(2), K(7)], []));
    expect(plan.order).toEqual([K(2), K(7), K(10)]);
    expect(plan.waves).toEqual([[K(2), K(7), K(10)]]);
    expect(plan.criticalPath).toEqual([K(2)]);
    expect(plan.stats.ready).toBe(3);
  });

  it('uses priority labels to change the order', () => {
    const base = input([K(1), K(2), K(3)], []);
    base.issues[2] = issue(K(3), { labels: ['P0'] });
    base.issues[1] = issue(K(2), { labels: ['p1', 'bug'] });
    const plan = buildPlan({ ...base, priorityLabels: ['P0', 'P1'] });
    expect(plan.order).toEqual([K(3), K(2), K(1)]);
    expect(node(plan, K(3)).priority).toBe(0);
    expect(node(plan, K(2)).priority).toBe(1);
    expect(node(plan, K(1)).priority).toBe(2);
  });

  it('takes the minimum priority index over all labels', () => {
    const base = input([K(1)], []);
    base.issues[0] = issue(K(1), { labels: ['P2', 'p0'] });
    const plan = buildPlan({ ...base, priorityLabels: ['P0', 'P1', 'P2'] });
    expect(plan.nodes[0]!.priority).toBe(0);
  });

  it('matches priority labels exactly, not as substrings', () => {
    const base = input([K(1)], []);
    base.issues[0] = issue(K(1), { labels: ['P00', 'xp0'] });
    const plan = buildPlan({ ...base, priorityLabels: ['P0'] });
    expect(plan.nodes[0]!.priority).toBe(1);
  });

  it('priority does not violate dependencies', () => {
    const base = input([K(1), K(2)], [edge(K(1), K(2))]);
    base.issues[1] = issue(K(2), { labels: ['P0'] });
    const plan = buildPlan({ ...base, priorityLabels: ['P0'] });
    expect(plan.order).toEqual([K(1), K(2)]);
  });

  it('breaks ties by remainingDepth: the node unblocking a long chain goes first', () => {
    // 1 has no dependents; 5 starts a chain 5 -> 6 -> 7. Both are ready.
    const plan = buildPlan(input([K(1), K(5), K(6), K(7)], [edge(K(5), K(6)), edge(K(6), K(7))]));
    expect(plan.order).toEqual([K(5), K(6), K(1), K(7)]);
    expect(node(plan, K(5)).remainingDepth).toBe(3);
    expect(node(plan, K(1)).remainingDepth).toBe(1);
    // Priority still beats depth.
    const base = input([K(1), K(5), K(6), K(7)], [edge(K(5), K(6)), edge(K(6), K(7))]);
    base.issues[0] = issue(K(1), { labels: ['P0'] });
    expect(buildPlan({ ...base, priorityLabels: ['P0'] }).order).toEqual([K(1), K(5), K(6), K(7)]);
  });

  it('handles a 2-node cycle with downstream nodes', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5)],
        [edge(K(1), K(2)), edge(K(2), K(1)), edge(K(2), K(3)), edge(K(3), K(4))],
      ),
    );
    expect(plan.cycles).toEqual([[K(1), K(2)]]);
    expect(node(plan, K(1)).status).toBe('in-cycle');
    expect(node(plan, K(2)).status).toBe('in-cycle');
    expect(node(plan, K(3)).status).toBe('blocked-by-cycle');
    expect(node(plan, K(4)).status).toBe('blocked-by-cycle');
    expect(node(plan, K(5)).status).toBe('ready');
    expect(plan.unschedulable).toEqual([K(1), K(2), K(3), K(4)]);
    for (const k of [K(1), K(2), K(3), K(4)]) {
      const n = node(plan, k);
      expect(n.wave).toBeNull();
      expect(n.order).toBeNull();
      expect(n.remainingDepth).toBe(0);
    }
    expect(plan.order).toEqual([K(5)]);
    expect(plan.waves).toEqual([[K(5)]]);
    expect(plan.criticalPath).toEqual([K(5)]);
    // Edges touching unschedulable nodes are kept.
    expect(plan.edges).toHaveLength(4);
    expect(node(plan, K(3)).blockedBy).toEqual([K(2)]);
    expect(plan.warnings).toEqual([
      {
        code: 'blocked-by-cycle',
        message: '2 issues are blocked by a dependency cycle: o/r#3, o/r#4',
        issues: [K(3), K(4)],
      },
      { code: 'cycle', message: 'Dependency cycle: o/r#1 → o/r#2', issues: [K(1), K(2)] },
    ]);
    expect(plan.stats).toMatchObject({ total: 5, ready: 1, blocked: 0, unschedulable: 4 });
  });

  it('handles a 3-node cycle with a schedulable prerequisite and downstream nodes', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5), K(6)],
        [
          edge(K(1), K(2)), // prerequisite of the cycle, schedulable
          edge(K(2), K(3)),
          edge(K(3), K(4)),
          edge(K(4), K(2)),
          edge(K(4), K(5)),
          edge(K(5), K(6)),
        ],
      ),
    );
    expect(plan.cycles).toEqual([[K(2), K(3), K(4)]]);
    expect(plan.warnings.find((w) => w.code === 'cycle')!.message).toBe(
      'Dependency cycle: o/r#2 → o/r#3 → o/r#4',
    );
    expect(plan.unschedulable).toEqual([K(2), K(3), K(4), K(5), K(6)]);
    expect(plan.order).toEqual([K(1)]);
    expect(node(plan, K(1)).status).toBe('ready');
    expect(node(plan, K(1)).remainingDepth).toBe(1);
    expect(node(plan, K(5)).status).toBe('blocked-by-cycle');
    expect(node(plan, K(6)).status).toBe('blocked-by-cycle');
    expect(plan.warnings.filter((w) => w.code === 'blocked-by-cycle')).toHaveLength(1);
  });

  it('reports several cycles sorted by first element', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4)],
        [edge(K(4), K(3)), edge(K(3), K(4)), edge(K(2), K(1)), edge(K(1), K(2))],
      ),
    );
    expect(plan.cycles).toEqual([
      [K(1), K(2)],
      [K(3), K(4)],
    ]);
    expect(plan.warnings.filter((w) => w.code === 'cycle').map((w) => w.issues[0])).toEqual([
      K(1),
      K(3),
    ]);
  });

  it('drops self-loops with one warning per issue', () => {
    const plan = buildPlan(
      input([K(1), K(2)], [edge(K(1), K(1)), edge(K(1), K(1), ['body']), edge(K(1), K(2))]),
    );
    expect(plan.edges).toEqual([edge(K(1), K(2))]);
    expect(plan.warnings).toEqual([
      {
        code: 'self-reference',
        message: 'o/r#1 declares a dependency on itself',
        issues: [K(1)],
      },
    ]);
    expect(plan.cycles).toEqual([]);
    expect(node(plan, K(1)).status).toBe('ready');
    expect(plan.order).toEqual([K(1), K(2)]);
  });

  it('merges duplicate edges and unions their sources', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2)],
        [
          edge(K(1), K(2), ['sub-issue']),
          edge(K(1), K(2), ['native', 'body']),
          edge(K(1), K(2), ['body']),
        ],
      ),
    );
    expect(plan.edges).toEqual([edge(K(1), K(2), ['body', 'native', 'sub-issue'])]);
    expect(plan.stats.edges).toBe(1);
    expect(node(plan, K(2)).blockedBy).toEqual([K(1)]);
  });

  it('drops edges with unknown endpoints silently', () => {
    const plan = buildPlan(
      input([K(1), K(2)], [edge(K(1), K(99)), edge(K(98), K(2)), edge(K(97), K(97))]),
    );
    expect(plan.edges).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.nodes.every((n) => n.blockedBy.length === 0 && n.blocks.length === 0)).toBe(true);
  });

  it('dedupes nodes by key', () => {
    const plan = buildPlan({
      ...input([], []),
      issues: [issue(K(1), { title: 'B' }), issue(K(1), { title: 'A' }), issue(K(2))],
    });
    expect(plan.nodes.map((n) => n.key)).toEqual([K(1), K(2)]);
    // The winner does not depend on input order.
    const reversed = buildPlan({
      ...input([], []),
      issues: [issue(K(2)), issue(K(1), { title: 'A' }), issue(K(1), { title: 'B' })],
    });
    expect(canonicalJson(reversed)).toBe(canonicalJson(plan));
  });

  it('flags external nodes', () => {
    const plan = buildPlan(
      input([K(1), K(2), K(3)], [edge(K(1), K(2))], { externalKeys: [K(1), 'x/y#5'] }),
    );
    expect(node(plan, K(1)).external).toBe(true);
    expect(node(plan, K(2)).external).toBe(false);
    expect(plan.stats.external).toBe(1);
  });

  it('orders keys across repositories', () => {
    const keys = ['b/a#1', 'a/y#2', 'a/x#10', 'a/x#9'];
    const plan = buildPlan(input(keys, []));
    expect(plan.nodes.map((n) => n.key)).toEqual(['a/x#9', 'a/x#10', 'a/y#2', 'b/a#1']);
    expect(plan.order).toEqual(['a/x#9', 'a/x#10', 'a/y#2', 'b/a#1']);
    const linked = buildPlan(
      input(keys, [edge('b/a#1', 'a/x#10'), edge('a/y#2', 'a/x#10'), edge('a/x#9', 'a/x#10')]),
    );
    expect(node(linked, 'a/x#10').blockedBy).toEqual(['a/x#9', 'a/y#2', 'b/a#1']);
    expect(linked.edges.map((e) => e.from)).toEqual(['a/x#9', 'a/y#2', 'b/a#1']);
  });

  it('computes the critical path through the deepest chain, ties by key', () => {
    // Chain 1 -> 2 -> 3 -> 4 and a shorter branch 1 -> 5; separate chain 6 -> 7 -> 8 -> 9 ties.
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5), K(6), K(7), K(8), K(9)],
        [
          edge(K(1), K(2)),
          edge(K(2), K(3)),
          edge(K(3), K(4)),
          edge(K(1), K(5)),
          edge(K(6), K(7)),
          edge(K(7), K(8)),
          edge(K(8), K(9)),
        ],
      ),
    );
    expect(plan.criticalPath).toEqual([K(1), K(2), K(3), K(4)]);
  });

  it('follows the successor with the max remainingDepth, ties by key', () => {
    // 1 -> 2 (leaf), 1 -> 3 -> 5, 1 -> 4 -> 6: 3 and 4 tie at depth 2, so 3 wins.
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5), K(6)],
        [edge(K(1), K(2)), edge(K(1), K(3)), edge(K(1), K(4)), edge(K(3), K(5)), edge(K(4), K(6))],
      ),
    );
    expect(plan.criticalPath).toEqual([K(1), K(3), K(5)]);
  });

  it('computes wave as the longest path from a root and groups waves by order', () => {
    // 1 -> 3, 2 -> 3, 3 -> 4, 2 -> 4, 5 alone.
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5)],
        [edge(K(1), K(3)), edge(K(2), K(3)), edge(K(3), K(4)), edge(K(2), K(4))],
      ),
    );
    expect(node(plan, K(1)).wave).toBe(0);
    expect(node(plan, K(2)).wave).toBe(0);
    expect(node(plan, K(5)).wave).toBe(0);
    expect(node(plan, K(3)).wave).toBe(1);
    expect(node(plan, K(4)).wave).toBe(2);
    expect(plan.waves).toEqual([[K(1), K(2), K(5)], [K(3)], [K(4)]]);
    // waves[i] is sorted by position in order.
    for (const w of plan.waves) {
      const positions = w.map((k) => plan.order.indexOf(k));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    for (const n of plan.nodes) {
      expect(plan.order[n.order!]).toBe(n.key);
      expect(plan.waves[n.wave!]).toContain(n.key);
    }
  });

  it('keeps the order valid: every prerequisite comes first', () => {
    const plan = buildPlan(
      input(
        [K(1), K(2), K(3), K(4), K(5)],
        [edge(K(5), K(1)), edge(K(4), K(1)), edge(K(1), K(3)), edge(K(2), K(3))],
      ),
    );
    for (const e of plan.edges) {
      expect(node(plan, e.from).order!).toBeLessThan(node(plan, e.to).order!);
    }
  });

  it('merges, dedupes and sorts warnings', () => {
    const upstream = [
      {
        code: 'fetch-error' as const,
        message: 'boom',
        issues: [K(2)],
      },
      {
        code: 'dangling-reference' as const,
        message: 'o/r#10 references o/r#404',
        issues: [K(10)],
      },
      {
        code: 'dangling-reference' as const,
        message: 'o/r#2 references o/r#405',
        issues: [K(2)],
      },
      { code: 'fetch-error' as const, message: 'boom', issues: [K(2)] },
      { code: 'native-unsupported' as const, message: 'no native', issues: [] },
      { code: 'fetch-error' as const, message: 'aaa', issues: ['b/a#1', 'a/b#1'] },
    ];
    const plan = buildPlan(input([K(1), K(2)], [edge(K(1), K(1))], { warnings: upstream }));
    expect(plan.warnings.map((w) => [w.code, w.issues[0], w.message])).toEqual([
      ['dangling-reference', K(2), 'o/r#2 references o/r#405'],
      ['dangling-reference', K(10), 'o/r#10 references o/r#404'],
      ['fetch-error', 'a/b#1', 'aaa'],
      ['fetch-error', K(2), 'boom'],
      ['native-unsupported', undefined, 'no native'],
      ['self-reference', K(1), 'o/r#1 declares a dependency on itself'],
    ]);
    expect(plan.warnings[2]!.issues).toEqual(['a/b#1', 'b/a#1']);
  });

  it('sorts an empty issues list first within a code', () => {
    const plan = buildPlan(
      input([], [], {
        warnings: [
          { code: 'fetch-error', message: 'with issue', issues: [K(1)] },
          { code: 'fetch-error', message: 'zzz no issue', issues: [] },
        ],
      }),
    );
    expect(plan.warnings.map((w) => w.message)).toEqual(['zzz no issue', 'with issue']);
  });

  it('does not mutate its input', () => {
    const inp = input([K(2), K(1)], [edge(K(1), K(2)), edge(K(1), K(2), ['body'])], {
      warnings: [{ code: 'fetch-error', message: 'x', issues: ['b/a#1', 'a/b#1'] }],
    });
    const before = canonicalJson(inp);
    buildPlan(inp);
    expect(canonicalJson(inp)).toBe(before);
  });
});

/** Tiny seeded PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const MODES: OrderingMode[] = ['priority', 'waves'];

describe('buildPlan ordering mode', () => {
  // 1 -> 2 is a chain (waves 0 and 1); 4 is independent (wave 0). 1 and 2 carry P0, 4 has none.
  const interleaving = (): PlanInput => {
    const base = input([K(1), K(2), K(4)], [edge(K(1), K(2))], { priorityLabels: ['P0'] });
    base.issues[0] = issue(K(1), { labels: ['P0'] });
    base.issues[1] = issue(K(2), { labels: ['P0'] });
    return base;
  };

  it("defaults to 'priority' and is identical to the explicit mode", () => {
    const base = interleaving();
    expect(canonicalJson(buildPlan(base))).toBe(
      canonicalJson(buildPlan({ ...base, orderingMode: 'priority' })),
    );
  });

  it('priority mode can put a later-wave issue before an earlier-wave one', () => {
    const plan = buildPlan({ ...interleaving(), orderingMode: 'priority' });
    expect(plan.order).toEqual([K(1), K(2), K(4)]);
    expect(node(plan, K(2)).wave).toBe(1);
    expect(node(plan, K(4)).wave).toBe(0);
  });

  it('waves mode finishes a wave before starting the next', () => {
    const plan = buildPlan({ ...interleaving(), orderingMode: 'waves' });
    expect(plan.order).toEqual([K(1), K(4), K(2)]);
    expect(plan.waves).toEqual([[K(1), K(4)], [K(2)]]);
  });

  it('waves mode: order is non-decreasing in wave; within a wave by priority, depth, key', () => {
    const rand = mulberry32(2024);
    const keys: IssueKey[] = [];
    for (let i = 1; i <= 80; i++) keys.push(`o/r#${i}`);
    const edges: DependencyEdge[] = [];
    for (let n = 0; n < 110; n++) {
      const a = Math.floor(rand() * keys.length);
      const b = Math.floor(rand() * keys.length);
      if (a === b) continue;
      edges.push(edge(keys[Math.min(a, b)]!, keys[Math.max(a, b)]!));
    }
    const labelPool = ['P0', 'P1', 'P2'];
    const base = input(keys, edges, { priorityLabels: labelPool });
    base.issues = keys.map((k) => issue(k, { labels: labelPool.filter(() => rand() < 0.2) }));
    const plan = buildPlan({ ...base, orderingMode: 'waves' });
    expect(plan.order).toHaveLength(80);
    const byKey = new Map(plan.nodes.map((n) => [n.key, n]));
    for (let i = 1; i < plan.order.length; i++) {
      const a = byKey.get(plan.order[i - 1]!)!;
      const b = byKey.get(plan.order[i]!)!;
      expect(a.wave!).toBeLessThanOrEqual(b.wave!);
      if (a.wave === b.wave) {
        const ka = [a.priority, -a.remainingDepth];
        const kb = [b.priority, -b.remainingDepth];
        const c = ka[0]! - kb[0]! || ka[1]! - kb[1]!;
        expect(c < 0 || (c === 0 && a.number < b.number)).toBe(true);
      }
    }
    // The waves list and the order agree: concatenating the waves gives the order.
    expect(plan.waves.flat()).toEqual(plan.order);
    // Dependencies are respected.
    const pos = new Map(plan.order.map((k, i) => [k, i]));
    for (const e of plan.edges) expect(pos.get(e.from)!).toBeLessThan(pos.get(e.to)!);
  });
});

describe('buildPlan determinism', () => {
  it('produces identical output for shuffled inputs', () => {
    const rand = mulberry32(12345);
    const keys: IssueKey[] = [];
    for (const repo of ['a/x', 'a/y', 'b/a']) {
      for (let i = 1; i <= 14; i++) keys.push(`${repo}#${i}`);
    }
    const labelPool = ['P0', 'p1', 'P2', 'bug', 'feature'];
    const issues = keys.map((k) =>
      issue(k, { labels: labelPool.filter(() => rand() < 0.25).sort() }),
    );
    const edges: DependencyEdge[] = [];
    const sourcePool: DependencySource[] = ['native', 'body', 'sub-issue'];
    for (let n = 0; n < 90; n++) {
      const from = keys[Math.floor(rand() * keys.length)]!;
      const to = keys[Math.floor(rand() * keys.length)]!;
      const sources = shuffle(sourcePool, rand).slice(0, 1 + Math.floor(rand() * 3));
      edges.push({ from, to, sources });
      if (rand() < 0.2) edges.push({ from, to, sources: shuffle(sourcePool, rand).slice(0, 1) });
    }
    edges.push({ from: 'zz/none#1', to: keys[0]!, sources: ['body'] });
    const warnings = [
      { code: 'fetch-error' as const, message: 'x', issues: ['b/a#1', 'a/x#2'] },
      { code: 'dangling-reference' as const, message: 'y', issues: ['a/y#3'] },
      { code: 'fetch-error' as const, message: 'x', issues: ['a/x#2', 'b/a#1'] },
    ];
    const externalKeys = ['a/x#3', 'b/a#4', 'a/y#9'];

    for (const orderingMode of MODES) {
      const make = (r: () => number): PlanInput => ({
        viewId: 'v',
        issues: shuffle(issues, r),
        externalKeys: shuffle(externalKeys, r),
        edges: shuffle(edges, r),
        warnings: shuffle(warnings, r),
        priorityLabels: ['P0', 'P1', 'P2'],
        orderingMode,
      });

      const reference = buildPlan(make(mulberry32(1)));
      // Sanity: the random graph actually exercises cycles, waves and warnings.
      expect(reference.cycles.length).toBeGreaterThan(0);
      expect(reference.order.length).toBeGreaterThan(0);
      const expected = canonicalJson(reference);

      const shuffler = mulberry32(999);
      for (let run = 0; run < 50; run++) {
        const plan = buildPlan(make(shuffler));
        expect(canonicalJson(plan)).toBe(expected);
      }
    }
  });

  it('produces identical output for shuffled acyclic inputs', () => {
    const rand = mulberry32(777);
    const keys: IssueKey[] = [];
    for (let i = 1; i <= 60; i++) keys.push(`o/r#${i}`);
    const edges: DependencyEdge[] = [];
    for (let n = 0; n < 150; n++) {
      const a = Math.floor(rand() * keys.length);
      const b = Math.floor(rand() * keys.length);
      if (a === b) continue;
      edges.push(edge(keys[Math.min(a, b)]!, keys[Math.max(a, b)]!));
    }
    for (const orderingMode of MODES) {
      const make = (r: () => number): PlanInput => ({
        viewId: 'v',
        issues: shuffle(keys, r).map((k) => issue(k)),
        externalKeys: [],
        edges: shuffle(edges, r),
        warnings: [],
        priorityLabels: [],
        orderingMode,
      });
      const expected = canonicalJson(buildPlan(make(mulberry32(5))));
      const shuffler = mulberry32(6);
      for (let run = 0; run < 50; run++) {
        expect(canonicalJson(buildPlan(make(shuffler)))).toBe(expected);
      }
      expect(buildPlan(make(mulberry32(5))).cycles).toEqual([]);
    }
  });
});

describe('buildPlan scale', () => {
  it('handles 5000 nodes and 20000 edges quickly', () => {
    const rand = mulberry32(42);
    const n = 5000;
    const keys: IssueKey[] = [];
    for (let i = 1; i <= n; i++) keys.push(`o/r${i % 3}#${i}`);
    const edges: DependencyEdge[] = [];
    while (edges.length < 20000) {
      const a = Math.floor(rand() * n);
      const b = Math.floor(rand() * n);
      if (a === b) continue;
      edges.push(edge(keys[Math.min(a, b)]!, keys[Math.max(a, b)]!));
    }
    const start = performance.now();
    const plan = buildPlan(input(keys, edges));
    const elapsed = performance.now() - start;
    expect(plan.nodes).toHaveLength(n);
    expect(plan.order).toHaveLength(n);
    expect(plan.cycles).toEqual([]);
    expect(elapsed).toBeLessThan(3000);
  });

  it('handles a 10000-node chain without recursion problems', () => {
    const keys: IssueKey[] = [];
    const edges: DependencyEdge[] = [];
    for (let i = 1; i <= 10000; i++) keys.push(K(i));
    for (let i = 1; i < 10000; i++) edges.push(edge(K(i), K(i + 1)));
    // Close the loop so the whole chain is one SCC.
    const plan = buildPlan(input(keys, [...edges, edge(K(10000), K(1))]));
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]).toHaveLength(10000);
    expect(plan.order).toEqual([]);
    const acyclic = buildPlan(input(keys, edges));
    expect(acyclic.waves).toHaveLength(10000);
    expect(acyclic.criticalPath).toHaveLength(10000);
  });
});
