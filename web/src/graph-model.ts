import type { IssueKey, PlanNode, Point } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export function edgeId(from: IssueKey, to: IssueKey): string {
  return `${from}->${to}`;
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const MIN_CONTROL_OFFSET = 40;

/**
 * SVG path for a chain of cubic beziers through `points`, with horizontal
 * tangents at every anchor (the edge leaves a node to the right and enters the
 * next one from the left).
 */
export function bezierPath(points: readonly Point[]): string {
  const first = points[0];
  if (first === undefined) return '';
  let d = `M${num(first.x)} ${num(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = Math.max(MIN_CONTROL_OFFSET, Math.abs(b.x - a.x) * 0.5);
    d += ` C${num(a.x + dx)} ${num(a.y)} ${num(b.x - dx)} ${num(b.y)}` + ` ${num(b.x)} ${num(b.y)}`;
  }
  return d;
}

const GUTTER = 18;
const CORNER = 8;
/** Half a node height plus half the row gap, for a 64px card and a 24px gap. */
const ROW_GAP_OFFSET = 44;

/**
 * Path for a layout edge. Forward edges are plain beziers. An edge that goes
 * backwards or stays in its column (between members of a cycle, which share the
 * "Unschedulable" column) would sweep across the cards, so it is routed around
 * them instead: out to the right gutter, along the gap between two rows, and in
 * from the left gutter of the target.
 */
export function edgePath(points: readonly Point[], rowGapOffset = ROW_GAP_OFFSET): string {
  const a = points[0];
  const b = points[points.length - 1];
  if (points.length !== 2 || a === undefined || b === undefined || b.x > a.x) {
    return bezierPath(points);
  }
  const dir = b.y >= a.y ? 1 : -1;
  const ym = a.y + dir * rowGapOffset;
  const gx1 = a.x + GUTTER;
  const gx2 = b.x - GUTTER;
  const r = CORNER;
  return [
    `M${num(a.x)} ${num(a.y)}`,
    `H${num(gx1 - r)}`,
    `Q${num(gx1)} ${num(a.y)} ${num(gx1)} ${num(a.y + dir * r)}`,
    `V${num(ym - dir * r)}`,
    `Q${num(gx1)} ${num(ym)} ${num(gx1 - r)} ${num(ym)}`,
    `H${num(gx2 + r)}`,
    `Q${num(gx2)} ${num(ym)} ${num(gx2)} ${num(ym + dir * r)}`,
    `V${num(b.y - dir * r)}`,
    `Q${num(gx2)} ${num(b.y)} ${num(gx2 + r)} ${num(b.y)}`,
    `H${num(b.x)}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Card layout
// ---------------------------------------------------------------------------

/** Card and spacing sizes of the graph, in canvas pixels. */
export interface Geometry {
  cardW: number;
  cardH: number;
  colGap: number;
  rowGap: number;
  pad: number;
}

export const GEOMETRY: Geometry = { cardW: 256, cardH: 124, colGap: 72, rowGap: 16, pad: 20 };

export interface PackedColumn {
  /** Layout layer: the wave index, or waves.length for the unschedulable column. */
  layer: number;
  /** Left edge of the column's cards. */
  x: number;
  /** Visible keys, top to bottom. */
  keys: IssueKey[];
}

export interface PackedLayout {
  width: number;
  height: number;
  columns: PackedColumn[];
  /** Top-left corner of each visible card. */
  pos: Map<IssueKey, Point>;
}

/**
 * Places the visible cards. Columns and the order inside a column come from
 * the server layout (`layer`, `row`, already crossing-reduced); hidden cards
 * leave no gap and a column with no visible card is dropped.
 */
export function packLayout(
  nodes: readonly { key: IssueKey; layer: number; row: number }[],
  visible: ReadonlySet<IssueKey> | null,
  g: Geometry = GEOMETRY,
): PackedLayout {
  const byLayer = new Map<number, { key: IssueKey; row: number }[]>();
  for (const n of nodes) {
    if (visible !== null && !visible.has(n.key)) continue;
    const list = byLayer.get(n.layer);
    if (list) list.push(n);
    else byLayer.set(n.layer, [n]);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const pos = new Map<IssueKey, Point>();
  const columns: PackedColumn[] = [];
  let maxRows = 0;
  layers.forEach((layer, col) => {
    const list = byLayer.get(layer)!.sort((a, b) => a.row - b.row);
    const x = g.pad + col * (g.cardW + g.colGap);
    list.forEach((n, row) => pos.set(n.key, { x, y: g.pad + row * (g.cardH + g.rowGap) }));
    columns.push({ layer, x, keys: list.map((n) => n.key) });
    maxRows = Math.max(maxRows, list.length);
  });
  const n = columns.length;
  return {
    width: n === 0 ? 0 : g.pad * 2 + n * g.cardW + (n - 1) * g.colGap,
    height: maxRows === 0 ? 0 : g.pad * 2 + maxRows * g.cardH + (maxRows - 1) * g.rowGap,
    columns,
    pos,
  };
}

/**
 * Dependencies between visible issues that only run through hidden ones
 * (`a -> hidden -> b`), so a filtered graph still shows that `b` waits on `a`.
 * Pairs that already have a direct edge are left out. Sorted by (from, to).
 */
export function indirectEdges(
  out: Map<IssueKey, IssueKey[]>,
  visible: ReadonlySet<IssueKey>,
): EdgeLike[] {
  const result: EdgeLike[] = [];
  for (const from of [...visible].sort()) {
    const direct = new Set(out.get(from) ?? []);
    const seen = new Set<IssueKey>();
    const stack = (out.get(from) ?? []).filter((k) => !visible.has(k));
    for (const k of stack) seen.add(k);
    const found: IssueKey[] = [];
    while (stack.length > 0) {
      for (const next of out.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (!visible.has(next)) stack.push(next);
        else if (next !== from && !direct.has(next)) found.push(next);
      }
    }
    for (const to of found.sort()) result.push({ from, to });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export interface EdgeLike {
  from: IssueKey;
  to: IssueKey;
}

export interface Adjacency {
  /** key -> direct dependents (from -> to). */
  out: Map<IssueKey, IssueKey[]>;
  /** key -> direct prerequisites. */
  in: Map<IssueKey, IssueKey[]>;
}

export function buildAdjacency(edges: readonly EdgeLike[]): Adjacency {
  const out = new Map<IssueKey, IssueKey[]>();
  const inn = new Map<IssueKey, IssueKey[]>();
  const push = (m: Map<IssueKey, IssueKey[]>, k: IssueKey, v: IssueKey): void => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const e of edges) {
    push(out, e.from, e.to);
    push(inn, e.to, e.from);
  }
  return { out, in: inn };
}

/**
 * Every key reachable from `start` by following `next` (transitive closure),
 * excluding `start` itself. Iterative with a visited set, so it terminates on
 * cyclic graphs.
 */
export function reachable(next: Map<IssueKey, IssueKey[]>, start: IssueKey): Set<IssueKey> {
  const seen = new Set<IssueKey>();
  const stack: IssueKey[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const n of next.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  seen.delete(start);
  return seen;
}

/** All transitive prerequisites of `key`. */
export function upstreamOf(adj: Adjacency, key: IssueKey): Set<IssueKey> {
  return reachable(adj.in, key);
}

/** All transitive dependents of `key`. */
export function downstreamOf(adj: Adjacency, key: IssueKey): Set<IssueKey> {
  return reachable(adj.out, key);
}

export type EdgeRole = 'up' | 'down' | 'both';

export interface Highlight {
  up: Set<IssueKey>;
  down: Set<IssueKey>;
  /** Edge id -> role, for the edges of the upstream/downstream subgraphs. */
  edges: Map<string, EdgeRole>;
}

/** Nodes and edges to highlight when `key` is selected. */
export function computeHighlight(
  adj: Adjacency,
  edges: readonly EdgeLike[],
  key: IssueKey,
): Highlight {
  const up = upstreamOf(adj, key);
  const down = downstreamOf(adj, key);
  const edgeRoles = new Map<string, EdgeRole>();
  for (const e of edges) {
    const isUp = up.has(e.from) && (up.has(e.to) || e.to === key);
    const isDown = down.has(e.to) && (down.has(e.from) || e.from === key);
    if (isUp && isDown) edgeRoles.set(edgeId(e.from, e.to), 'both');
    else if (isUp) edgeRoles.set(edgeId(e.from, e.to), 'up');
    else if (isDown) edgeRoles.set(edgeId(e.from, e.to), 'down');
  }
  return { up, down, edges: edgeRoles };
}

/** Edge ids between consecutive nodes of the critical path. */
export function criticalPathEdges(path: readonly IssueKey[]): Set<string> {
  const set = new Set<string>();
  for (let i = 1; i < path.length; i++) set.add(edgeId(path[i - 1]!, path[i]!));
  return set;
}

/**
 * A readable loop through a strongly connected component: the shortest cycle
 * through its first node, as a closed path ("a", "b", "c", "a"), plus the
 * members that are not on that path. Deterministic given sorted edges.
 */
export function cyclePath(
  scc: readonly IssueKey[],
  edges: readonly EdgeLike[],
): { path: IssueKey[]; extra: IssueKey[] } {
  const start = scc[0];
  if (start === undefined) return { path: [], extra: [] };
  const members = new Set(scc);
  const adj = buildAdjacency(edges.filter((e) => members.has(e.from) && members.has(e.to)));
  const prev = new Map<IssueKey, IssueKey>();
  const queue: IssueKey[] = [start];
  let closing: IssueKey | null = null;
  for (let qi = 0; qi < queue.length && closing === null; qi++) {
    const cur = queue[qi]!;
    for (const n of adj.out.get(cur) ?? []) {
      if (n === start) {
        closing = cur;
        break;
      }
      if (!prev.has(n)) {
        prev.set(n, cur);
        queue.push(n);
      }
    }
  }
  if (closing === null) return { path: [], extra: [...scc] };
  const reversed: IssueKey[] = [];
  for (let cur: IssueKey | undefined = closing; cur !== undefined; cur = prev.get(cur)) {
    reversed.push(cur);
    if (cur === start) break;
  }
  const path = [...reversed.reverse(), start];
  const onPath = new Set(path);
  return { path, extra: scc.filter((k) => !onPath.has(k)) };
}

// ---------------------------------------------------------------------------
// Pan / zoom math
// ---------------------------------------------------------------------------

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
export const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/**
 * Transform that shows the whole `content` in `viewport`: centred horizontally
 * and aligned to the top (wave headers stay close to the toolbar). It never
 * zooms in past 1:1 (small graphs are not blown up) and respects the zoom limits.
 */
export function fitTransform(content: Size, viewport: Size, padding = 24): Transform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return IDENTITY;
  }
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const k = clampZoom(Math.min(availW / content.width, availH / content.height, 1));
  return {
    k,
    x: (viewport.width - content.width * k) / 2,
    y: Math.min(padding, (viewport.height - content.height * k) / 2),
  };
}

/** Multiplies the zoom by `factor` keeping the content point under (cx, cy) fixed. */
export function zoomAt(t: Transform, factor: number, cx: number, cy: number): Transform {
  const k = clampZoom(t.k * factor);
  const ratio = k / t.k;
  return { k, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
}

/** Zoom factor for a wheel event (smooth, symmetric: zooming in then out is neutral). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, ctrlKey = false): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (ctrlKey ? 0.01 : 0.0015));
}

export function panBy(t: Transform, dx: number, dy: number): Transform {
  return { k: t.k, x: t.x + dx, y: t.y + dy };
}

/**
 * Keeps the zoom and moves the view so that `rect` (in content coordinates)
 * is visible inside `region` (in screen coordinates). Returns `t` unchanged
 * when it already is; otherwise centres the rect in the region.
 */
export function ensureVisible(t: Transform, rect: Rect, region: Rect, margin = 16): Transform {
  const left = rect.x * t.k + t.x;
  const top = rect.y * t.k + t.y;
  const right = left + rect.width * t.k;
  const bottom = top + rect.height * t.k;
  if (
    left >= region.x + margin &&
    top >= region.y + margin &&
    right <= region.x + region.width - margin &&
    bottom <= region.y + region.height - margin
  ) {
    return t;
  }
  const cx = region.x + region.width / 2;
  const cy = region.y + region.height / 2;
  return {
    k: t.k,
    x: cx - (rect.x + rect.width / 2) * t.k,
    y: cy - (rect.y + rect.height / 2) * t.k,
  };
}

export function transformAttr(t: Transform): string {
  return `translate(${num(t.x)} ${num(t.y)}) scale(${Math.round(t.k * 10000) / 10000})`;
}
