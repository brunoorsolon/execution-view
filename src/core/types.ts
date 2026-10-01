export type ProviderKind = 'github' | 'gitea' | 'fixture';

/** Canonical issue key: "owner/repo#number". owner and repo are lowercased. */
export type IssueKey = string;

/** owner and repo are always lowercased. */
export interface RepoRef {
  owner: string;
  repo: string;
}

export type IssueState = 'open' | 'closed';

/** A reference to an issue as written in a body or returned by an API, before resolution. */
export interface IssueRef {
  /** null means "same repository as the issue that contains the reference". */
  owner: string | null;
  repo: string | null;
  number: number;
}

export type DependencySource = 'native' | 'body' | 'sub-issue';

/**
 * A relation declared on an issue.
 * kind 'blocked-by': the issue that declares it cannot start before `ref` is closed.
 * kind 'blocks':     `ref` cannot start before the issue that declares it is closed.
 */
export interface RawRelation {
  kind: 'blocked-by' | 'blocks';
  ref: IssueRef;
  source: DependencySource;
}

export interface Issue {
  key: IssueKey;
  repo: RepoRef;
  number: number;
  title: string;
  state: IssueState;
  /** Browser URL of the issue. */
  url: string;
  body: string;
  /** Sorted ascending (code-unit order), unique. */
  labels: string[];
  /** Logins, sorted ascending, unique. */
  assignees: string[];
  milestone: string | null;
  /** Relations reported by the provider API (native dependencies, sub-issues). */
  nativeRelations: RawRelation[];
}

/** `from` must be closed before `to` can start. */
export interface DependencyEdge {
  from: IssueKey;
  to: IssueKey;
  /** Sorted ascending, unique. */
  sources: DependencySource[];
}

export type WarningCode =
  | 'cycle'
  | 'blocked-by-cycle'
  | 'self-reference'
  | 'dangling-reference'
  | 'external-unresolved'
  | 'native-unsupported'
  | 'fetch-error';

export interface PlanWarning {
  code: WarningCode;
  message: string;
  /** Sorted with compareKeys. */
  issues: IssueKey[];
}

export type NodeStatus = 'ready' | 'blocked' | 'in-cycle' | 'blocked-by-cycle';

export interface PlanNode {
  key: IssueKey;
  repo: RepoRef;
  number: number;
  title: string;
  url: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  /** True when the issue is outside the view's scope (another repo, or filtered out)
   *  but is pulled in because an in-scope issue (transitively) depends on it. */
  external: boolean;
  status: NodeStatus;
  /** 0-based parallel batch index; null when unschedulable. */
  wave: number | null;
  /** 0-based position in Plan.order; null when unschedulable. */
  order: number | null;
  /** Keys of open direct prerequisites, sorted with compareKeys. */
  blockedBy: IssueKey[];
  /** Keys of open direct dependents, sorted with compareKeys. */
  blocks: IssueKey[];
  /** Index of the first matching entry of ordering.priorityLabels; priorityLabels.length when none match. Lower = more urgent. */
  priority: number;
  /** Number of nodes on the longest dependent chain starting at this node (1 = nothing depends on it). 0 when unschedulable. */
  remainingDepth: number;
}

export interface PlanStats {
  total: number;
  ready: number;
  blocked: number;
  unschedulable: number;
  external: number;
  edges: number;
  waves: number;
}

export interface Plan {
  viewId: string;
  /** Sorted with compareKeys. */
  nodes: PlanNode[];
  /** Only edges between keys present in nodes. Sorted by (from, to) with compareKeys. */
  edges: DependencyEdge[];
  /** Linear execution order of all schedulable nodes. */
  order: IssueKey[];
  /** waves[i] = keys with wave === i, sorted by their position in `order`. */
  waves: IssueKey[][];
  /** Strongly connected components with more than one node. Each sorted with compareKeys; list sorted by first element. */
  cycles: IssueKey[][];
  /** Nodes with status in-cycle or blocked-by-cycle, sorted with compareKeys. */
  unschedulable: IssueKey[];
  /** Longest dependency chain among schedulable nodes, in execution order. */
  criticalPath: IssueKey[];
  /** Sorted by (code, first issue key, message). */
  warnings: PlanWarning[];
  stats: PlanStats;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  key: IssueKey;
  /** Top-left corner. Integers. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Column index: the node's wave, or waves.length for unschedulable nodes. */
  layer: number;
  /** Row index inside the layer. */
  row: number;
}

export interface LayoutEdge {
  from: IssueKey;
  to: IssueKey;
  /** Polyline anchor points: source right-middle, then target left-middle. Integers. */
  points: Point[];
}

export interface Layout {
  width: number;
  height: number;
  /** Sorted with compareKeys. */
  nodes: LayoutNode[];
  /** Same order as Plan.edges. */
  edges: LayoutEdge[];
}

/**
 * How the linear order is built. `priority`: by (priority, remainingDepth, key), which can
 * interleave waves. `waves`: wave by wave, and within a wave by the same three criteria.
 */
export type OrderingMode = 'priority' | 'waves';

export interface Snapshot {
  viewId: string;
  title: string;
  /** ISO timestamp of the fetch. Not part of the content hash. */
  fetchedAt: string;
  /** sha256 hex of canonicalJson({ plan, layout }). */
  contentHash: string;
  /**
   * The view's configured priority labels, in rank order (index 0 is the most
   * urgent). `PlanNode.priority` indexes into this list;
   * `PlanNode.priority === priorityLabels.length` means no priority label.
   * Not part of the content hash: a change here already changes the hash through
   * the `priority` values.
   */
  priorityLabels: string[];
  /**
   * The view's ordering mode. Not part of the content hash: `plan.order` already reflects it,
   * so a change of mode changes the hash through the order.
   */
  orderingMode: OrderingMode;
  plan: Plan;
  layout: Layout;
}

export interface FetchResult {
  issues: Issue[];
  warnings: PlanWarning[];
}

export interface ListOptions {
  /** Fetch native dependency relations (GitHub issue dependencies, Gitea dependencies). */
  native: boolean;
  /** GitHub only: a parent issue is blocked by each of its sub-issues. Ignored elsewhere. */
  subIssues: boolean;
}

export interface IssueProvider {
  readonly kind: ProviderKind;
  /** All OPEN issues of the repository (pull requests excluded), sorted by number ascending. */
  listOpenIssues(repo: RepoRef, options: ListOptions): Promise<FetchResult>;
  /** One issue in any state. null when it does not exist, is a pull request, or is not accessible (404/410). Other errors throw. */
  getIssue(repo: RepoRef, number: number): Promise<Issue | null>;
}
