import { describe, expect, it } from 'vitest';
import type { PlanNode } from '../../src/core/types.js';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  bezierPath,
  buildAdjacency,
  clampZoom,
  computeHighlight,
  criticalPathEdges,
  cyclePath,
  downstreamOf,
  edgePath,
  edgeId,
  ensureVisible,
  fitTransform,
  indirectEdges,
  packLayout,
  upstreamOf,
  wheelZoomFactor,
  zoomAt,
} from './graph-model.js';

describe('bezierPath', () => {
  it('builds a cubic bezier with horizontal tangents', () => {
    expect(
      bezierPath([
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ]),
    ).toBe('M0 0 C50 0 50 50 100 50');
  });

  it('uses a minimum control offset for very short edges', () => {
    expect(
      bezierPath([
        { x: 0, y: 10 },
        { x: 20, y: 10 },
      ]),
    ).toBe('M0 10 C40 10 -20 10 20 10');
  });

  it('chains segments through more than two points and handles empty input', () => {
    const d = bezierPath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 40 },
    ]);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d.endsWith('200 40')).toBe(true);
    expect(bezierPath([])).toBe('');
  });
});

describe('edgePath', () => {
  it('uses a bezier for forward edges', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ];
    expect(edgePath(pts)).toBe(bezierPath(pts));
  });

  it('routes same-column edges through the row gap and the gutters, ending at the target', () => {
    const down = edgePath([
      { x: 264, y: 56 },
      { x: 24, y: 144 },
    ]);
    expect(down.startsWith('M264 56 H')).toBe(true);
    expect(down.endsWith('H24')).toBe(true);
    expect(down).toContain('V');
    // horizontal traverse in the gap below the source row (56 + 44)
    expect(down).toContain('H14 Q6 100');
    const up = edgePath([
      { x: 264, y: 144 },
      { x: 24, y: 56 },
    ]);
    expect(up).toContain(' 100 '); // gap above the source row (144 - 44)
    expect(up.endsWith('H24')).toBe(true);
  });
});

// a -> b -> c -> a (cycle), c -> d, x -> a
const edges = [
  { from: 'o/r#1', to: 'o/r#2' },
  { from: 'o/r#2', to: 'o/r#3' },
  { from: 'o/r#3', to: 'o/r#1' },
  { from: 'o/r#3', to: 'o/r#4' },
  { from: 'o/r#9', to: 'o/r#1' },
];

describe('upstream / downstream closure', () => {
  const adj = buildAdjacency(edges);

  it('terminates on cycles and excludes the start node', () => {
    expect([...upstreamOf(adj, 'o/r#2')].sort()).toEqual(['o/r#1', 'o/r#3', 'o/r#9']);
    expect([...downstreamOf(adj, 'o/r#2')].sort()).toEqual(['o/r#1', 'o/r#3', 'o/r#4']);
  });

  it('follows chains transitively', () => {
    expect([...upstreamOf(adj, 'o/r#4')].sort()).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#9']);
    expect([...downstreamOf(adj, 'o/r#4')]).toEqual([]);
    expect([...downstreamOf(adj, 'o/r#9')].sort()).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4']);
  });

  it('handles an unknown key', () => {
    expect(upstreamOf(adj, 'o/r#404').size).toBe(0);
  });

  it('classifies highlighted edges', () => {
    const acyclic = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'z', to: 'd' },
    ];
    const hl = computeHighlight(buildAdjacency(acyclic), acyclic, 'b');
    expect([...hl.up]).toEqual(['a']);
    expect([...hl.down].sort()).toEqual(['c', 'd']);
    expect(hl.edges.get(edgeId('a', 'b'))).toBe('up');
    expect(hl.edges.get(edgeId('b', 'c'))).toBe('down');
    expect(hl.edges.get(edgeId('b', 'd'))).toBe('down');
    // z -> d touches the downstream node but is not a dependent path of b
    expect(hl.edges.has(edgeId('z', 'd'))).toBe(false);
  });
});

describe('criticalPathEdges', () => {
  it('lists edges between consecutive path nodes', () => {
    const set = criticalPathEdges(['a', 'b', 'c']);
    expect([...set]).toEqual(['a->b', 'b->c']);
  });
  it('is empty for paths shorter than two nodes', () => {
    expect(criticalPathEdges([]).size).toBe(0);
    expect(criticalPathEdges(['a']).size).toBe(0);
  });
});

describe('cyclePath', () => {
  it('finds the shortest closed loop through the first node', () => {
    const { path, extra } = cyclePath(['o/r#1', 'o/r#2', 'o/r#3'], edges);
    expect(path).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#1']);
    expect(extra).toEqual([]);
  });
  it('reports members that are not on the found loop', () => {
    const e = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'b' },
    ];
    const { path, extra } = cyclePath(['a', 'b', 'c'], e);
    expect(path).toEqual(['a', 'b', 'a']);
    expect(extra).toEqual(['c']);
  });
});

describe('zoom and pan math', () => {
  it('clamps zoom to the limits', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(MIN_ZOOM).toBe(0.2);
    expect(MAX_ZOOM).toBe(3);
  });

  it('fits a large graph into the viewport: centred horizontally, top-aligned', () => {
    const t = fitTransform({ width: 2000, height: 500 }, { width: 1000, height: 800 }, 0);
    expect(t.k).toBeCloseTo(0.5);
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBe(0);
    const padded = fitTransform({ width: 2000, height: 500 }, { width: 1000, height: 800 }, 24);
    expect(padded.y).toBe(24);
  });

  it('centres vertically when the content cannot fit even at the minimum zoom', () => {
    const t = fitTransform({ width: 1000, height: 1000 }, { width: 1000, height: 1000 }, 50);
    expect(t.y).toBeCloseTo(50);
    // content taller than the viewport even at the minimum zoom: centred
    const tall = fitTransform({ width: 100, height: 100000 }, { width: 1000, height: 1000 }, 50);
    expect(tall.k).toBe(MIN_ZOOM);
    expect(tall.y).toBeCloseTo((1000 - 100000 * MIN_ZOOM) / 2);
  });

  it('never zooms in past 1:1 when fitting a small graph', () => {
    const t = fitTransform({ width: 100, height: 100 }, { width: 1000, height: 800 });
    expect(t.k).toBe(1);
    expect(t.x).toBe(450);
    expect(t.y).toBe(24);
  });

  it('respects the padding and the minimum zoom, and survives empty sizes', () => {
    const padded = fitTransform({ width: 1000, height: 1000 }, { width: 1000, height: 1000 }, 50);
    expect(padded.k).toBeCloseTo(0.9);
    expect(fitTransform({ width: 100000, height: 100 }, { width: 500, height: 500 }).k).toBe(
      MIN_ZOOM,
    );
    expect(fitTransform({ width: 0, height: 0 }, { width: 500, height: 500 })).toEqual({
      x: 0,
      y: 0,
      k: 1,
    });
  });

  it('zooms towards the cursor: the point under the cursor stays put', () => {
    const t = { x: 30, y: -20, k: 1 };
    const cx = 400;
    const cy = 250;
    const before = { x: (cx - t.x) / t.k, y: (cy - t.y) / t.k };
    const z = zoomAt(t, 2, cx, cy);
    expect(z.k).toBe(2);
    expect((cx - z.x) / z.k).toBeCloseTo(before.x);
    expect((cy - z.y) / z.k).toBeCloseTo(before.y);
  });

  it('clamps zoomAt at the limits without drifting', () => {
    const near = { x: 10, y: 10, k: 2.9 };
    const z = zoomAt(near, 10, 100, 100);
    expect(z.k).toBe(MAX_ZOOM);
    expect((100 - z.x) / z.k).toBeCloseTo((100 - near.x) / near.k);
    const out = zoomAt({ x: 0, y: 0, k: 0.25 }, 0.01, 0, 0);
    expect(out.k).toBe(MIN_ZOOM);
  });

  it('maps wheel deltas to symmetric zoom factors', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
  });

  it('ensureVisible keeps the transform when the rect is visible and centres it otherwise', () => {
    const region = { x: 0, y: 0, width: 800, height: 600 };
    const t = { x: 0, y: 0, k: 1 };
    expect(ensureVisible(t, { x: 100, y: 100, width: 240, height: 64 }, region)).toBe(t);
    const moved = ensureVisible(t, { x: 2000, y: 100, width: 240, height: 64 }, region);
    expect(moved.k).toBe(1);
    expect(moved.x + (2000 + 120) * moved.k).toBeCloseTo(400);
    expect(moved.y + (100 + 32) * moved.k).toBeCloseTo(300);
  });
});

describe('packLayout', () => {
  const g = { cardW: 100, cardH: 50, colGap: 20, rowGap: 10, pad: 5 };
  const nodes = [
    { key: 'a', layer: 0, row: 0 },
    { key: 'b', layer: 0, row: 1 },
    { key: 'c', layer: 1, row: 0 },
    { key: 'd', layer: 2, row: 1 },
    { key: 'e', layer: 2, row: 0 },
  ];

  it('places every card by layer and row when nothing is hidden', () => {
    const p = packLayout(nodes, null, g);
    expect(p.columns.map((c) => [c.layer, c.x, c.keys])).toEqual([
      [0, 5, ['a', 'b']],
      [1, 125, ['c']],
      [2, 245, ['e', 'd']],
    ]);
    expect(p.pos.get('b')).toEqual({ x: 5, y: 65 });
    expect(p.width).toBe(5 * 2 + 3 * 100 + 2 * 20);
    expect(p.height).toBe(5 * 2 + 2 * 50 + 10);
  });

  it('packs visible cards to the top and drops empty columns, keeping the layer', () => {
    const p = packLayout(nodes, new Set(['b', 'd']), g);
    expect(p.columns.map((c) => [c.layer, c.x, c.keys])).toEqual([
      [0, 5, ['b']],
      [2, 125, ['d']],
    ]);
    expect(p.pos.get('d')).toEqual({ x: 125, y: 5 });
    expect(p.pos.has('a')).toBe(false);
    expect(p.height).toBe(60);
  });

  it('is empty when nothing is visible', () => {
    const p = packLayout(nodes, new Set(), g);
    expect(p).toEqual({ width: 0, height: 0, columns: [], pos: new Map() });
  });
});

describe('indirectEdges', () => {
  // a -> h1 -> h2 -> b, a -> c (direct), a -> h1 -> c, h2 -> a (cycle back)
  const { out } = buildAdjacency([
    { from: 'a', to: 'h1' },
    { from: 'h1', to: 'h2' },
    { from: 'h2', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'h1', to: 'c' },
    { from: 'h2', to: 'a' },
  ]);

  it('links visible issues through hidden ones, skipping direct pairs and self loops', () => {
    expect(indirectEdges(out, new Set(['a', 'b', 'c']))).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('is empty when nothing is hidden on the way', () => {
    expect(indirectEdges(out, new Set(['a', 'h1', 'h2', 'b', 'c']))).toEqual([]);
  });

  it('stops at the first visible issue on a path', () => {
    expect(indirectEdges(out, new Set(['a', 'h2', 'b']))).toEqual([{ from: 'a', to: 'h2' }]);
  });
});
