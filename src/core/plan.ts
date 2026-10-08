import { canonicalJson } from './hash.js';
import { compareKeys } from './keys.js';
import type {
  DependencyEdge,
  DependencySource,
  Issue,
  IssueKey,
  NodeStatus,
  OrderingMode,
  Plan,
  PlanNode,
  PlanWarning,
} from './types.js';

export interface PlanInput {
  viewId: string;
  /** Every node of the plan: open issues only. */
  issues: Issue[];
  /** Keys of issues that are external (see PlanNode.external). */
  externalKeys: IssueKey[];
  /** Edges between keys of `issues`. Edges referencing unknown keys are dropped. */
  edges: DependencyEdge[];
  /** `Parent` hierarchies between keys of `issues`. Links referencing unknown keys are dropped. Never an edge. */
  parentLinks?: ParentLink[];
  /** Warnings collected upstream; merged into the plan's warnings. */
  warnings: PlanWarning[];
  priorityLabels: string[];
  /** How the linear order is built; default 'priority'. */
  orderingMode?: OrderingMode;
}

/** A `Parent:` relation between two issues of the plan. A hierarchy link only. */
export interface ParentLink {
  parent: IssueKey;
  child: IssueKey;
}

/** Plain code-unit comparison (never localeCompare). */
function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** compareKeys, but never throws: malformed keys (from upstream warnings) sort by code unit. */
function safeCompareKeys(a: IssueKey, b: IssueKey): number {
  try {
    return compareKeys(a, b);
  } catch {
    return cmp(a, b);
  }
}

function compareWarnings(a: PlanWarning, b: PlanWarning): number {
  let c = cmp(a.code, b.code);
  if (c !== 0) return c;
  const ka = a.issues[0];
  const kb = b.issues[0];
  if (ka !== kb) {
    if (ka === undefined) return -1;
    if (kb === undefined) return 1;
    c = safeCompareKeys(ka, kb);
    if (c !== 0) return c;
  }
  c = cmp(a.message, b.message);
  if (c !== 0) return c;
  // Total order: fall back to the full issue list.
  return cmp(canonicalJson(a.issues), canonicalJson(b.issues));
}

/** Binary min-heap over node indices with a caller-supplied "a comes before b" predicate. */
class IndexHeap {
  private readonly items: number[] = [];
  constructor(private readonly less: (a: number, b: number) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    const items = this.items;
    let i = items.length;
    items.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(value, items[parent]!)) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = value;
  }

  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && this.less(items[child + 1]!, items[child]!)) child++;
        if (!this.less(items[child]!, last)) break;
        items[i] = items[child]!;
        i = child;
      }
      items[i] = last;
    }
    return top;
  }
}

/**
 * Iterative Tarjan (no recursion, so 10k+ node chains are fine). Nodes are visited in index
 * order (which is compareKeys order) and successor lists are sorted ascending. Returns the
 * component id of every node and the size of every component.
 */
function stronglyConnectedComponents(succ: number[][]): { comp: Int32Array; sizes: number[] } {
  const n = succ.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    callNode.push(root);
    callEdge.push(0);
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;

    while (callNode.length > 0) {
      const top = callNode.length - 1;
      const v = callNode[top]!;
      const edgePos = callEdge[top]!;
      const out = succ[v]!;
      if (edgePos < out.length) {
        callEdge[top] = edgePos + 1;
        const w = out[edgePos]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          callNode.push(w);
          callEdge.push(0);
        } else if (onStack[w] === 1) {
          if (index[w]! < low[v]!) low[v] = index[w]!;
        }
      } else {
        if (low[v] === index[v]) {
          const id = sizes.length;
          let size = 0;
          for (;;) {
            const w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = id;
            size++;
            if (w === v) break;
          }
          sizes.push(size);
        }
        callNode.pop();
        callEdge.pop();
        if (callNode.length > 0) {
          const parent = callNode[callNode.length - 1]!;
          if (low[v]! < low[parent]!) low[parent] = low[v]!;
        }
      }
    }
  }
  return { comp, sizes };
}

export function buildPlan(input: PlanInput): Plan {
  // ---- 1. Normalize nodes: sort by key, first occurrence wins.
  const sortedIssues = input.issues
    .map((issue) => ({ issue, tie: '' }))
    .sort((a, b) => compareKeys(a.issue.key, b.issue.key));
  // Break ties between duplicate keys by content so the winner never depends on input order.
  for (let i = 0; i < sortedIssues.length;) {
    let j = i + 1;
    while (j < sortedIssues.length && sortedIssues[j]!.issue.key === sortedIssues[i]!.issue.key) {
      j++;
    }
    if (j - i > 1) {
      const group = sortedIssues.slice(i, j);
      for (const g of group) g.tie = canonicalJson(g.issue);
      group.sort((a, b) => cmp(a.tie, b.tie));
      for (let k = 0; k < group.length; k++) sortedIssues[i + k] = group[k]!;
    }
    i = j;
  }
  const issues: Issue[] = [];
  for (const { issue } of sortedIssues) {
    if (issues.length > 0 && issues[issues.length - 1]!.key === issue.key) continue;
    issues.push(issue);
  }
  const n = issues.length;
  const indexOf = new Map<IssueKey, number>();
  for (let i = 0; i < n; i++) indexOf.set(issues[i]!.key, i);
  const keyOf = (i: number): IssueKey => issues[i]!.key;

  // Parent hierarchy. Node indices follow key order, so sorting indices gives compareKeys order.
  const parentIndices = new Map<number, Set<number>>(); // child -> its parents
  const childIndices = new Map<number, Set<number>>(); // parent -> its children
  for (const link of input.parentLinks ?? []) {
    const parent = indexOf.get(link.parent);
    const child = indexOf.get(link.child);
    if (parent === undefined || child === undefined || parent === child) continue;
    let parents = parentIndices.get(child);
    if (parents === undefined) parentIndices.set(child, (parents = new Set()));
    parents.add(parent);
    let children = childIndices.get(parent);
    if (children === undefined) childIndices.set(parent, (children = new Set()));
    children.add(child);
  }

  // Normalize edges. Node indices follow key order, so index order is compareKeys order.
  const selfLoops = new Set<number>();
  const merged = new Map<number, Set<DependencySource>>();
  for (const edge of input.edges) {
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      selfLoops.add(from);
      continue;
    }
    const id = from * n + to;
    let sources = merged.get(id);
    if (!sources) {
      sources = new Set();
      merged.set(id, sources);
    }
    for (const s of edge.sources) sources.add(s);
  }
  const edgeIds = [...merged.keys()].sort((a, b) => a - b);
  const edges: DependencyEdge[] = [];
  const succ: number[][] = Array.from({ length: n }, () => []);
  const pred: number[][] = Array.from({ length: n }, () => []);
  for (const id of edgeIds) {
    const from = Math.floor(id / n);
    const to = id - from * n;
    edges.push({
      from: keyOf(from),
      to: keyOf(to),
      sources: [...merged.get(id)!].sort(),
    });
    succ[from]!.push(to); // ascending in `to`, because ids are sorted
    pred[to]!.push(from); // ascending in `from`, because ids are sorted
  }

  const generated: PlanWarning[] = [];
  for (const i of [...selfLoops].sort((a, b) => a - b)) {
    generated.push({
      code: 'self-reference',
      message: `${keyOf(i)} declares a dependency on itself`,
      issues: [keyOf(i)],
    });
  }

  // ---- 2. Strongly connected components.
  const { comp, sizes } = stronglyConnectedComponents(succ);
  const inCycle = new Uint8Array(n);
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = comp[i]!;
    if (sizes[c]! > 1) {
      inCycle[i] = 1;
      let list = members.get(c);
      if (!list) {
        list = [];
        members.set(c, list);
      }
      list.push(i); // ascending
    }
  }
  const cycleIdx = [...members.values()].sort((a, b) => a[0]! - b[0]!);
  const cycles: IssueKey[][] = cycleIdx.map((c) => c.map(keyOf));
  for (const c of cycles) {
    generated.push({
      code: 'cycle',
      message: `Dependency cycle: ${c.join(' → ')}`,
      issues: c,
    });
  }

  // Everything reachable from an in-cycle node (and not itself in a cycle) is blocked.
  const blockedByCycle = new Uint8Array(n);
  const visit: number[] = [];
  for (let i = 0; i < n; i++) if (inCycle[i] === 1) visit.push(i);
  while (visit.length > 0) {
    const v = visit.pop()!;
    for (const w of succ[v]!) {
      if (inCycle[w] === 0 && blockedByCycle[w] === 0) {
        blockedByCycle[w] = 1;
        visit.push(w);
      }
    }
  }
  const blockedList: IssueKey[] = [];
  for (let i = 0; i < n; i++) if (blockedByCycle[i] === 1) blockedList.push(keyOf(i));
  if (blockedList.length > 0) {
    const noun = blockedList.length === 1 ? 'issue is' : 'issues are';
    generated.push({
      code: 'blocked-by-cycle',
      message: `${blockedList.length} ${noun} blocked by a dependency cycle: ${blockedList.join(', ')}`,
      issues: blockedList,
    });
  }

  // ---- 3. Schedulable DAG (only edges between schedulable nodes).
  const schedulable = new Uint8Array(n);
  for (let i = 0; i < n; i++) schedulable[i] = inCycle[i] === 0 && blockedByCycle[i] === 0 ? 1 : 0;
  const dagSucc: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    if (schedulable[v] === 0) continue;
    for (const w of succ[v]!) {
      if (schedulable[w] === 1) {
        dagSucc[v]!.push(w);
        indeg[w]!++;
      }
    }
  }

  // Priorities: the first entry of priorityLabels matching any label wins (min index).
  const priorityIndex = new Map<string, number>();
  input.priorityLabels.forEach((label, i) => {
    const lower = label.toLowerCase();
    if (!priorityIndex.has(lower)) priorityIndex.set(lower, i);
  });
  const priority = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = input.priorityLabels.length;
    for (const label of issues[i]!.labels) {
      const p = priorityIndex.get(label.toLowerCase());
      if (p !== undefined && p < best) best = p;
    }
    priority[i] = best;
  }

  // Any topological order, used for wave (forward) and remainingDepth (backward).
  const topo: number[] = [];
  const remaining = Int32Array.from(indeg);
  for (let i = 0; i < n; i++) if (schedulable[i] === 1 && remaining[i] === 0) topo.push(i);
  for (let head = 0; head < topo.length; head++) {
    for (const w of dagSucc[topo[head]!]!) {
      if (--remaining[w]! === 0) topo.push(w);
    }
  }
  const wave = new Int32Array(n);
  const depth = new Int32Array(n);
  for (const v of topo) {
    for (const w of dagSucc[v]!) if (wave[w]! < wave[v]! + 1) wave[w] = wave[v]! + 1;
  }
  for (let k = topo.length - 1; k >= 0; k--) {
    const v = topo[k]!;
    let best = 0;
    for (const w of dagSucc[v]!) if (depth[w]! > best) best = depth[w]!;
    depth[v] = best + 1;
  }

  // Kahn with a priority queue: (priority asc, remainingDepth desc, key asc); in 'waves' mode
  // the wave comes first, so the order never interleaves waves.
  const waveMajor = input.orderingMode === 'waves';
  const heap = new IndexHeap((a, b) => {
    if (waveMajor && wave[a] !== wave[b]) return wave[a]! < wave[b]!;
    if (priority[a] !== priority[b]) return priority[a]! < priority[b]!;
    if (depth[a] !== depth[b]) return depth[a]! > depth[b]!;
    return a < b;
  });
  const waiting = Int32Array.from(indeg);
  for (let i = 0; i < n; i++) if (schedulable[i] === 1 && waiting[i] === 0) heap.push(i);
  const orderIdx: number[] = [];
  const orderPos = new Int32Array(n).fill(-1);
  while (heap.size > 0) {
    const v = heap.pop();
    orderPos[v] = orderIdx.length;
    orderIdx.push(v);
    for (const w of dagSucc[v]!) if (--waiting[w]! === 0) heap.push(w);
  }

  const waves: IssueKey[][] = [];
  for (const v of orderIdx) {
    const w = wave[v]!;
    while (waves.length <= w) waves.push([]);
    waves[w]!.push(keyOf(v));
  }

  // Critical path: start at the deepest node (ties: key order), follow the deepest successor.
  const criticalPath: IssueKey[] = [];
  let cur = -1;
  for (let i = 0; i < n; i++) {
    if (schedulable[i] === 1 && (cur === -1 || depth[i]! > depth[cur]!)) cur = i;
  }
  while (cur !== -1) {
    criticalPath.push(keyOf(cur));
    let next = -1;
    for (const w of dagSucc[cur]!) if (next === -1 || depth[w]! > depth[next]!) next = w;
    cur = next;
  }

  // ---- 4. Nodes.
  const external = new Set(input.externalKeys);
  const nodes: PlanNode[] = [];
  const unschedulable: IssueKey[] = [];
  let ready = 0;
  let blocked = 0;
  let externalCount = 0;
  for (let i = 0; i < n; i++) {
    const issue = issues[i]!;
    let status: NodeStatus;
    if (inCycle[i] === 1) status = 'in-cycle';
    else if (blockedByCycle[i] === 1) status = 'blocked-by-cycle';
    else if (pred[i]!.length === 0) status = 'ready';
    else status = 'blocked';
    if (status === 'ready') ready++;
    else if (status === 'blocked') blocked++;
    const isSchedulable = schedulable[i] === 1;
    if (!isSchedulable) unschedulable.push(issue.key);
    const isExternal = external.has(issue.key);
    if (isExternal) externalCount++;
    nodes.push({
      key: issue.key,
      repo: { owner: issue.repo.owner, repo: issue.repo.repo },
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: [...issue.labels],
      assignees: [...issue.assignees],
      milestone: issue.milestone,
      updatedAt: issue.updatedAt,
      external: isExternal,
      status,
      wave: isSchedulable ? wave[i]! : null,
      order: isSchedulable ? orderPos[i]! : null,
      blockedBy: pred[i]!.map(keyOf),
      blocks: succ[i]!.map(keyOf),
      parents: [...(parentIndices.get(i) ?? [])].sort((a, b) => a - b).map(keyOf),
      children: [...(childIndices.get(i) ?? [])].sort((a, b) => a - b).map(keyOf),
      priority: priority[i]!,
      remainingDepth: isSchedulable ? depth[i]! : 0,
    });
  }

  // ---- 6. Warnings: input + generated, deduped by canonical JSON, sorted.
  const seen = new Set<string>();
  const warnings: PlanWarning[] = [];
  for (const w of [...input.warnings, ...generated]) {
    const normalized: PlanWarning = {
      code: w.code,
      message: w.message,
      issues: [...new Set(w.issues)].sort(safeCompareKeys),
    };
    const id = canonicalJson(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    warnings.push(normalized);
  }
  warnings.sort(compareWarnings);

  return {
    viewId: input.viewId,
    nodes,
    edges,
    order: orderIdx.map(keyOf),
    waves,
    cycles,
    unschedulable,
    criticalPath,
    warnings,
    stats: {
      total: nodes.length,
      ready,
      blocked,
      unschedulable: unschedulable.length,
      external: externalCount,
      edges: edges.length,
      waves: waves.length,
    },
  };
}
