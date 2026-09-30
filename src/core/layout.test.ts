import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_OPTIONS, computeLayout } from './layout.js';
import { compareKeys, parseKey } from './keys.js';
import type { IssueKey, Layout, Plan, PlanNode } from './types.js';

interface N {
  key: IssueKey;
  wave: number | null;
}

/** Minimal valid Plan from nodes (with waves) and edges. `order` defaults to (wave, key). */
function makePlan(nodes: N[], edges: [IssueKey, IssueKey][], order?: IssueKey[]): Plan {
  const schedulable = nodes.filter((n) => n.wave !== null);
  const linear =
    order ??
    [...schedulable]
      .sort((a, b) => a.wave! - b.wave! || compareKeys(a.key, b.key))
      .map((n) => n.key);
  const waveCount = schedulable.reduce((m, n) => Math.max(m, n.wave! + 1), 0);
  const waves: IssueKey[][] = Array.from({ length: waveCount }, (_, w) =>
    linear.filter((key) => nodes.find((n) => n.key === key)!.wave === w),
  );
  const planNodes: PlanNode[] = nodes
    .map((n) => {
      const { repo, number } = parseKey(n.key);
      return {
        key: n.key,
        repo,
        number,
        title: `Issue ${number}`,
        url: `https://example.test/${n.key}`,
        labels: [],
        assignees: [],
        milestone: null,
        external: false,
        status: n.wave === null ? ('in-cycle' as const) : ('ready' as const),
        wave: n.wave,
        order: n.wave === null ? null : linear.indexOf(n.key),
        blockedBy: [],
        blocks: [],
        priority: 0,
        remainingDepth: n.wave === null ? 0 : 1,
      };
    })
    .sort((a, b) => compareKeys(a.key, b.key));
  const planEdges = [...edges]
    .sort((a, b) => compareKeys(a[0], b[0]) || compareKeys(a[1], b[1]))
    .map(([from, to]) => ({ from, to, sources: ['body' as const] }));
  const unschedulable = nodes
    .filter((n) => n.wave === null)
    .map((n) => n.key)
    .sort(compareKeys);
  return {
    viewId: 'test',
    nodes: planNodes,
    edges: planEdges,
    order: linear,
    waves,
    cycles: [],
    unschedulable,
    criticalPath: [],
    warnings: [],
    stats: {
      total: nodes.length,
      ready: 0,
      blocked: 0,
      unschedulable: unschedulable.length,
      external: 0,
      edges: planEdges.length,
      waves: waveCount,
    },
  };
}

const k = (n: number): IssueKey => `acme/api#${n}`;

/** Crossings between edges that span the same pair of layers, given row and layer lookups. */
function countCrossings(
  plan: Plan,
  rowOf: (key: IssueKey) => number,
  layerOf: (key: IssueKey) => number,
): number {
  let crossings = 0;
  for (let i = 0; i < plan.edges.length; i++) {
    for (let j = i + 1; j < plan.edges.length; j++) {
      const a = plan.edges[i]!;
      const b = plan.edges[j]!;
      if (layerOf(a.from) !== layerOf(b.from) || layerOf(a.to) !== layerOf(b.to)) continue;
      if ((rowOf(a.from) - rowOf(b.from)) * (rowOf(a.to) - rowOf(b.to)) < 0) crossings++;
    }
  }
  return crossings;
}

function layoutCrossings(plan: Plan, layout: Layout): number {
  const byKey = new Map(layout.nodes.map((n) => [n.key, n]));
  return countCrossings(
    plan,
    (key) => byKey.get(key)!.row,
    (key) => byKey.get(key)!.layer,
  );
}

/** Crossings of the initial ordering (position in plan.order, no sweeps). */
function initialCrossings(plan: Plan): number {
  const layerOf = (key: IssueKey): number =>
    plan.nodes.find((n) => n.key === key)!.wave ?? plan.waves.length;
  const rowOf = (key: IssueKey): number => {
    const layer = layerOf(key);
    const inLayer = plan.nodes
      .filter((n) => layerOf(n.key) === layer)
      .map((n) => n.key)
      .sort((a, b) => {
        const ia = plan.order.indexOf(a);
        const ib = plan.order.indexOf(b);
        return ia >= 0 && ib >= 0 ? ia - ib : compareKeys(a, b);
      });
    return inLayer.indexOf(key);
  };
  return countCrossings(plan, rowOf, layerOf);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const sample = (): Plan =>
  makePlan(
    [
      { key: k(1), wave: 0 },
      { key: k(2), wave: 0 },
      { key: k(3), wave: 1 },
      { key: k(4), wave: 1 },
      { key: k(5), wave: 2 },
      { key: k(6), wave: null },
      { key: k(7), wave: null },
      { key: 'other/repo#1', wave: 0 },
    ],
    [
      [k(1), k(4)],
      [k(2), k(3)],
      [k(3), k(5)],
      [k(4), k(5)],
      [k(1), k(5)],
      ['other/repo#1', k(3)],
      [k(6), k(7)],
    ],
  );

describe('computeLayout', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_LAYOUT_OPTIONS).toEqual({
      nodeWidth: 240,
      nodeHeight: 64,
      hGap: 96,
      vGap: 24,
      padding: 24,
    });
  });

  it('assigns layers from waves and puts unschedulable nodes in the last column', () => {
    const plan = sample();
    const layout = computeLayout(plan);
    const layerOf = new Map(layout.nodes.map((n) => [n.key, n.layer]));
    expect(layerOf.get(k(1))).toBe(0);
    expect(layerOf.get(k(2))).toBe(0);
    expect(layerOf.get('other/repo#1')).toBe(0);
    expect(layerOf.get(k(3))).toBe(1);
    expect(layerOf.get(k(5))).toBe(2);
    expect(plan.waves.length).toBe(3);
    expect(layerOf.get(k(6))).toBe(3);
    expect(layerOf.get(k(7))).toBe(3);
  });

  it('positions nodes by the spec formulas and sizes the canvas', () => {
    const layout = computeLayout(sample());
    for (const n of layout.nodes) {
      expect(n.x).toBe(24 + n.layer * (240 + 96));
      expect(n.y).toBe(24 + n.row * (64 + 24));
      expect(n.width).toBe(240);
      expect(n.height).toBe(64);
    }
    // 4 layers, max 3 rows (layer 0)
    expect(layout.width).toBe(48 + 4 * 240 + 3 * 96);
    expect(layout.height).toBe(48 + 3 * 64 + 2 * 24);
  });

  it('does not add an unschedulable column when nothing is unschedulable', () => {
    const plan = makePlan(
      [
        { key: k(1), wave: 0 },
        { key: k(2), wave: 1 },
      ],
      [[k(1), k(2)]],
    );
    const layout = computeLayout(plan);
    expect(Math.max(...layout.nodes.map((n) => n.layer))).toBe(1);
    expect(layout.width).toBe(48 + 2 * 240 + 96);
    expect(layout.height).toBe(48 + 64);
  });

  it('handles an empty plan', () => {
    const layout = computeLayout(makePlan([], []));
    expect(layout).toEqual({ width: 48, height: 48, nodes: [], edges: [] });
  });

  it('handles a plan with only unschedulable nodes, ordered by compareKeys', () => {
    const plan = makePlan(
      [
        { key: k(10), wave: null },
        { key: k(2), wave: null },
      ],
      [[k(2), k(10)]],
    );
    const layout = computeLayout(plan);
    expect(layout.nodes.map((n) => [n.key, n.layer, n.row])).toEqual([
      [k(2), 0, 0],
      [k(10), 0, 1],
    ]);
  });

  it('never overlaps nodes and keeps every node inside the bounding box', () => {
    const layout = computeLayout(sample());
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(24);
      expect(n.y).toBeGreaterThanOrEqual(24);
      expect(n.x + n.width + 24).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height + 24).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i]!;
        const b = layout.nodes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    // rows are 0..n-1 within each layer
    const rows = new Map<number, number[]>();
    for (const n of layout.nodes) rows.set(n.layer, [...(rows.get(n.layer) ?? []), n.row]);
    for (const list of rows.values()) {
      expect([...list].sort((a, b) => a - b)).toEqual(list.map((_, i) => i));
    }
  });

  it('returns nodes sorted with compareKeys', () => {
    const layout = computeLayout(sample());
    const keys = layout.nodes.map((n) => n.key);
    expect(keys).toEqual([...keys].sort(compareKeys));
  });

  it('removes crossings that the initial order has', () => {
    const plan = makePlan(
      [
        { key: k(1), wave: 0 },
        { key: k(2), wave: 0 },
        { key: k(3), wave: 1 },
        { key: k(4), wave: 1 },
      ],
      [
        [k(1), k(4)],
        [k(2), k(3)],
      ],
    );
    expect(initialCrossings(plan)).toBe(1);
    expect(layoutCrossings(plan, computeLayout(plan))).toBe(0);
  });

  it('reduces crossings on a larger crossed graph', () => {
    const nodes: N[] = [];
    for (let i = 1; i <= 4; i++) nodes.push({ key: k(i), wave: 0 });
    for (let i = 5; i <= 8; i++) nodes.push({ key: k(i), wave: 1 });
    for (let i = 9; i <= 12; i++) nodes.push({ key: k(i), wave: 2 });
    const edges: [IssueKey, IssueKey][] = [
      [k(1), k(8)],
      [k(2), k(7)],
      [k(3), k(6)],
      [k(4), k(5)],
      [k(5), k(12)],
      [k(6), k(11)],
      [k(7), k(10)],
      [k(8), k(9)],
    ];
    const plan = makePlan(nodes, edges);
    const before = initialCrossings(plan);
    const after = layoutCrossings(plan, computeLayout(plan));
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(after).toBe(0);
  });

  it('uses neighbours from any earlier layer for edges that span several layers', () => {
    const plan = makePlan(
      [
        { key: k(1), wave: 0 },
        { key: k(2), wave: 0 },
        { key: k(3), wave: 1 },
        { key: k(4), wave: 2 },
        { key: k(5), wave: 2 },
      ],
      [
        [k(1), k(5)],
        [k(2), k(4)],
        [k(1), k(3)],
        [k(3), k(4)],
      ],
    );
    const layout = computeLayout(plan);
    const row = (key: IssueKey): number => layout.nodes.find((n) => n.key === key)!.row;
    // 5 hangs off 1 (row 0) only, 4 hangs off 2 and 3: 5 must sit above 4
    expect(row(k(1))).toBeLessThan(row(k(2)));
    expect(row(k(5))).toBeLessThan(row(k(4)));
  });

  it('keeps edges in plan.edges order with anchor points on the node sides', () => {
    const plan = sample();
    const layout = computeLayout(plan);
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual(plan.edges.map((e) => [e.from, e.to]));
    const byKey = new Map(layout.nodes.map((n) => [n.key, n]));
    for (const e of layout.edges) {
      const from = byKey.get(e.from)!;
      const to = byKey.get(e.to)!;
      expect(e.points).toEqual([
        { x: from.x + from.width, y: from.y + from.height / 2 },
        { x: to.x, y: to.y + to.height / 2 },
      ]);
    }
  });

  it('skips edges whose endpoints are not nodes', () => {
    const plan = makePlan(
      [
        { key: k(1), wave: 0 },
        { key: k(2), wave: 1 },
      ],
      [
        [k(1), k(2)],
        [k(1), k(99)],
      ],
    );
    const layout = computeLayout(plan);
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual([[k(1), k(2)]]);
  });

  it('produces integer coordinates even with fractional options', () => {
    const layout = computeLayout(sample(), {
      nodeWidth: 200.4,
      nodeHeight: 61.5,
      hGap: 10.3,
      vGap: 7.7,
      padding: 3.3,
    });
    const values = [
      layout.width,
      layout.height,
      ...layout.nodes.flatMap((n) => [n.x, n.y, n.width, n.height]),
      ...layout.edges.flatMap((e) => e.points.flatMap((p) => [p.x, p.y])),
    ];
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });

  it('honours custom options', () => {
    const plan = makePlan(
      [
        { key: k(1), wave: 0 },
        { key: k(2), wave: 0 },
        { key: k(3), wave: 1 },
      ],
      [[k(1), k(3)]],
    );
    const layout = computeLayout(plan, {
      nodeWidth: 100,
      nodeHeight: 20,
      hGap: 50,
      vGap: 10,
      padding: 5,
    });
    expect(layout.width).toBe(10 + 2 * 100 + 50);
    expect(layout.height).toBe(10 + 2 * 20 + 10);
    const n1 = layout.nodes.find((n) => n.key === k(1))!;
    const n3 = layout.nodes.find((n) => n.key === k(3))!;
    expect(n3).toMatchObject({ x: 5 + 150, width: 100, height: 20 });
    expect(layout.edges[0]!.points).toEqual([
      { x: 5 + 100, y: n1.y + 10 },
      { x: n3.x, y: n3.y + 10 },
    ]);
  });

  it('falls back to defaults for omitted options', () => {
    const layout = computeLayout(sample(), { hGap: 10 });
    expect(layout.nodes.find((n) => n.key === k(3))!.x).toBe(24 + 250);
    expect(layout.nodes[0]!.width).toBe(240);
  });

  it('is deterministic across repeated calls and does not mutate the plan', () => {
    const plan = sample();
    const snapshot = JSON.parse(JSON.stringify(plan)) as Plan;
    const a = computeLayout(plan);
    const b = computeLayout(plan);
    expect(a).toEqual(b);
    expect(plan).toEqual(snapshot);
  });

  it('does not depend on the order of plan.nodes', () => {
    const plan = sample();
    const expected = computeLayout(plan);
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled: Plan = { ...plan, nodes: shuffle(plan.nodes, seed) };
      expect(computeLayout(shuffled)).toEqual(expected);
    }
  });
});
