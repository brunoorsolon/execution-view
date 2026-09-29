import { compareKeys } from './keys.js';
import type { IssueKey, Layout, LayoutEdge, LayoutNode, Plan } from './types.js';

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  hGap?: number;
  vGap?: number;
  padding?: number;
}

export const DEFAULT_LAYOUT_OPTIONS: Required<LayoutOptions> = {
  nodeWidth: 240,
  nodeHeight: 64,
  hGap: 96,
  vGap: 24,
  padding: 24,
};

/** Number of (down sweep, up sweep) iterations of the crossing reduction. */
const SWEEP_ITERATIONS = 4;

interface Slot {
  key: IssueKey;
  layer: number;
  row: number;
}

/**
 * Deterministic layered layout. Layer = wave (unschedulable nodes go in the
 * layer after the last wave). Depends only on the content of the plan, never
 * on the order of `plan.nodes`. The input plan is not mutated.
 */
export function computeLayout(plan: Plan, options: LayoutOptions = {}): Layout {
  const { nodeWidth, nodeHeight, hGap, vGap, padding } = { ...DEFAULT_LAYOUT_OPTIONS, ...options };

  const orderIndex = new Map<IssueKey, number>();
  plan.order.forEach((key, i) => {
    if (!orderIndex.has(key)) orderIndex.set(key, i);
  });

  // Unique nodes sorted with compareKeys, so the node array order is irrelevant.
  const sortedNodes = [...plan.nodes].sort((a, b) => compareKeys(a.key, b.key));
  const slots = new Map<IssueKey, Slot>();
  for (const node of sortedNodes) {
    if (slots.has(node.key)) continue;
    slots.set(node.key, {
      key: node.key,
      layer: node.wave === null ? plan.waves.length : node.wave,
      row: 0,
    });
  }

  // Group into layers with the initial row order.
  let layerCount = 0;
  for (const slot of slots.values()) layerCount = Math.max(layerCount, slot.layer + 1);
  const layers: Slot[][] = Array.from({ length: layerCount }, () => []);
  for (const slot of slots.values()) layers[slot.layer]!.push(slot);
  for (const layer of layers) {
    layer.sort((a, b) => {
      const ia = orderIndex.get(a.key);
      const ib = orderIndex.get(b.key);
      if (ia !== undefined && ib !== undefined && ia !== ib) return ia - ib;
      if ((ia === undefined) !== (ib === undefined)) return ia === undefined ? 1 : -1;
      return compareKeys(a.key, b.key);
    });
    layer.forEach((slot, row) => (slot.row = row));
  }

  // Adjacency over plan.edges (only between known nodes).
  const preds = new Map<IssueKey, IssueKey[]>();
  const succs = new Map<IssueKey, IssueKey[]>();
  for (const edge of plan.edges) {
    if (!slots.has(edge.from) || !slots.has(edge.to)) continue;
    if (!succs.has(edge.from)) succs.set(edge.from, []);
    if (!preds.has(edge.to)) preds.set(edge.to, []);
    succs.get(edge.from)!.push(edge.to);
    preds.get(edge.to)!.push(edge.from);
  }

  const sortLayer = (layer: Slot[], neighbours: Map<IssueKey, IssueKey[]>, down: boolean): void => {
    const barycenter = new Map<IssueKey, number>();
    for (const slot of layer) {
      let sum = 0;
      let count = 0;
      for (const nKey of neighbours.get(slot.key) ?? []) {
        const n = slots.get(nKey)!;
        if (down ? n.layer < slot.layer : n.layer > slot.layer) {
          sum += n.row;
          count++;
        }
      }
      barycenter.set(slot.key, count === 0 ? slot.row : sum / count);
    }
    // Array.prototype.sort is stable; ties are broken by the current row.
    layer.sort((a, b) => {
      const ba = barycenter.get(a.key)!;
      const bb = barycenter.get(b.key)!;
      return ba < bb ? -1 : ba > bb ? 1 : a.row - b.row;
    });
    layer.forEach((slot, row) => (slot.row = row));
  };

  for (let iteration = 0; iteration < SWEEP_ITERATIONS; iteration++) {
    for (let l = 0; l < layers.length; l++) sortLayer(layers[l]!, preds, true);
    for (let l = layers.length - 1; l >= 0; l--) sortLayer(layers[l]!, succs, false);
  }

  const maxRows = layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  const width =
    layerCount === 0 ? padding * 2 : padding * 2 + layerCount * nodeWidth + (layerCount - 1) * hGap;
  const height =
    maxRows === 0 ? padding * 2 : padding * 2 + maxRows * nodeHeight + (maxRows - 1) * vGap;

  const nodes: LayoutNode[] = [...slots.values()]
    .map((slot) => ({
      key: slot.key,
      x: Math.round(padding + slot.layer * (nodeWidth + hGap)),
      y: Math.round(padding + slot.row * (nodeHeight + vGap)),
      width: Math.round(nodeWidth),
      height: Math.round(nodeHeight),
      layer: slot.layer,
      row: slot.row,
    }))
    .sort((a, b) => compareKeys(a.key, b.key));

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const edges: LayoutEdge[] = [];
  for (const edge of plan.edges) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      points: [
        { x: Math.round(from.x + from.width), y: Math.round(from.y + from.height / 2) },
        { x: Math.round(to.x), y: Math.round(to.y + to.height / 2) },
      ],
    });
  }

  return { width: Math.round(width), height: Math.round(height), nodes, edges };
}
