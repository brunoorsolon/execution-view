# execution-view: architecture and contracts

> **Status.** This document was the **implementation contract** for the first
> version. The code follows it, with the deviations listed below; where they
> differ, the code and the user documentation win for behaviour that users
> see. User-facing documentation: [README](../README.md),
> [PREREQUISITES](PREREQUISITES.md), [CONFIGURATION](CONFIGURATION.md),
> [DEPLOYMENT](DEPLOYMENT.md), [DETERMINISM](DETERMINISM.md) and [API](API.md).
>
> Known deviations from the text below:
>
> - The Gitea provider is tested in CI against live instances, not only mocked
>   HTTP: Gitea 1.25 and Forgejo 11 (`scripts/forge-integration.sh`, the
>   `forge-integration` job). Forgejo is supported through the `gitea` kind
>   with no provider changes.
> - `Snapshot` has a `priorityLabels: string[]` field: the view's configured
>   priority labels in rank order, so `PlanNode.priority` can be mapped to a
>   label name (`priority === priorityLabels.length` means none). It is not part
>   of `contentHash`. The Markdown export has a Priority column, and the web UI
>   shows the exact name.
> - `dependencies` is a default blocked-by keyword (the contract listed only
>   `depends on`, `blocked by` and `requires`), so a `## Dependencies` heading
>   and `Dependencies: #3` lines work without configuration. The singular
>   `Dependency` is not a default keyword.
> - `AppConfig` has an optional `warnings: string[]` (non-fatal problems found
>   while loading: a `tokenEnv` naming an unset variable, `subIssues` on a
>   non-GitHub source). The CLI and the server print them.
> - `parseConfig(yamlText, env, options?)` takes a third argument
>   `{ baseDir? }`: relative fixture `path` values resolve against the config
>   file's directory (default `process.cwd()`).
> - `server.basicAuth` needs `username` plus either `passwordEnv` or
>   `password`, not "both keys".
> - The Docker image does **not** set `EV_CONFIG` (an explicit path must exist,
>   which would break env-only mode). The default lookup is `/app/config.yaml`.
> - `dangling-reference` and `fetch-error` warnings are dropped when the issue
>   that declares the reference is not part of the plan (out of scope), so they
>   only describe what the user sees.
> - Sub-issue relations are kept only when `subIssues` is true, and native
>   relations only when `native` is true; the two toggles are independent
>   (also when fetching). Native relations of externally looked-up issues are
>   not fetched; their body relations are.
> - Gitea pagination uses `X-Total-Count` when the server sends it, and
>   otherwise stops on an empty page or a page shorter than the first one.
> - CLI: `plan --format` also accepts `mmd` (alias of `mermaid`); `views` and
>   `check` accept `--json`; `check` accepts several view ids. It exits `2`
>   only for `cycle` and `dangling-reference`; other warnings do not change the
>   exit code.
> - HTTP: all `/api/` responses carry `Cache-Control: no-store`; the snapshot
>   endpoint honours `If-None-Match` with the content hash as `ETag`
>   (`304`); exports have no `ETag`.
> - Static UI: files in `webDir` are resolved per request (no restart needed
>   after a rebuild, and a `webDir` created after startup is served). `index.html`
>   (also via the SPA fallback) is `Cache-Control: no-cache`; files under
>   `assets/` are `public, max-age=31536000, immutable`; other files `no-cache`.
> - Markdown and DOT exports number waves from 1; `PlanNode.wave` in JSON is
>   0-based.
> - The `native-unsupported` hint printed by `check` for Gitea and the message
>   of the Gitea provider use the same hedged wording for the dependencies
>   setting (repository settings, or `DEFAULT_ENABLE_DEPENDENCIES` in `app.ini`).

This document is the source of truth for the implementation. Every ticket refers
to it. If a ticket and this document disagree, this document wins. Change it
only in a dedicated PR.

## 1. Goal

Produce **deterministic** views of the open issues of one or more repositories
hosted on **GitHub** (github.com or GitHub Enterprise Server) or **Gitea**
(Forgejo works through the Gitea provider):

- how the issues depend on each other (a dependency graph)
- the order to execute them in (a linear order, plus "waves" of work that can
  run in parallel)
- what is wrong with the declared dependencies (cycles, dangling references)

**Deterministic** means that the same issue data always gives byte-identical
plan JSON, the same order, and the same layout coordinates. Nothing depends on
wall-clock time, randomness, hash-map iteration order, API response order or
locale. Every sort uses an explicit comparator with a total order.

## 2. Tech stack

- Node.js 22, TypeScript (strict), ESM (`"type": "module"`, `NodeNext` module
  resolution, so relative imports use a `.js` suffix in `src/`)
- Server: Fastify 5 and `@fastify/static`
- Config: `yaml` + `zod`
- CLI: `commander`
- Web UI: Vite + vanilla TypeScript (no framework), SVG rendering
- Tests: Vitest. Formatting: Prettier. Type checking: `tsc --noEmit`
- HTTP client: the global `fetch`. Providers take an injectable `fetch` so
  tests never touch the network
- Container: multi-stage Dockerfile on `node:22-alpine`

## 3. Repository layout

```
src/
  core/
    types.ts        # all shared types (section 5), no runtime code
    keys.ts         # makeKey, parseKey, compareKeys, compareRefs
    hash.ts         # canonicalJson, contentHash
    parser.ts       # body dependency parser                       (ticket: parser)
    plan.ts         # buildPlan: graph, cycles, order, waves       (ticket: plan engine)
    layout.ts       # computeLayout                                (ticket: layout)
  export/
    markdown.ts mermaid.ts dot.ts json.ts index.ts                 (ticket: exporters)
  config/
    schema.ts load.ts                                              (ticket: config)
  providers/
    http.ts         # shared fetch helpers: pagination, retries, concurrency limiter
    github.ts gitea.ts fixture.ts index.ts                         (provider tickets)
  service/
    planService.ts resolve.ts                                      (ticket: service)
  server/
    app.ts index.ts                                                (ticket: server)
  cli/
    index.ts                                                       (ticket: CLI)
web/
  index.html  src/*.ts  src/*.css  vite.config.ts  tsconfig.json   (ticket: web UI)
test/fixtures/     # shared JSON fixtures
docs/
```

Tests sit next to the code as `*.test.ts`.

## 4. Data flow

```
config ─► PlanService.getSnapshot(viewId)
            │ for each repo in view: provider.listOpenIssues()  (issues + native relations)
            │ parser.parseBodyRelations(issue.body)              (body relations)
            │ resolve.ts: turn relations into edges; fetch refs that are not
            │             in the open set (provider.getIssue) to learn whether
            │             they are closed (satisfied), open elsewhere (external
            │             node), or missing (dangling warning); apply view scope
            ▼
          core/plan.ts buildPlan()  ─►  Plan
          core/layout.ts computeLayout(plan) ─► Layout
          contentHash({plan, layout})
            ▼
          Snapshot  ─► HTTP API / CLI / exporters / web UI
```

## 5. Core types (`src/core/types.ts`), verbatim contract

```ts
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

export interface Snapshot {
  viewId: string;
  title: string;
  /** ISO timestamp of the fetch. Not part of the content hash. */
  fetchedAt: string;
  /** sha256 hex of canonicalJson({ plan, layout }). */
  contentHash: string;
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
```

## 6. Helpers (`src/core/keys.ts`, `src/core/hash.ts`)

- `makeKey(repo: RepoRef, number: number): IssueKey` returns `"owner/repo#N"`, lowercased.
- `parseKey(key: IssueKey): { repo: RepoRef; number: number }` throws on malformed input.
- `compareKeys(a, b)`: compare `owner/repo` with plain code-unit comparison
  (`a < b ? -1 : a > b ? 1 : 0`, never `localeCompare`), then `number`
  numerically. This is the total order used everywhere.
- `compareRefs(a: IssueRef, b: IssueRef)`: null owner/repo sorts first, then as above.
- `canonicalJson(value: unknown): string` gives JSON with object keys sorted
  recursively (code-unit order) and no whitespace. Arrays keep their order.
  `undefined` properties are dropped. Non-finite numbers throw.
- `contentHash(value: unknown): string` is the sha256 hex of `canonicalJson(value)` (`node:crypto`).

## 7. Body dependency parser (`src/core/parser.ts`)

```ts
export interface KeywordConfig {
  blockedBy: string[];
  blocks: string[];
}
export const DEFAULT_KEYWORDS: KeywordConfig = {
  blockedBy: ['depends on', 'blocked by', 'requires', 'dependencies'],
  blocks: ['blocks', 'blocking', 'required by'],
};
export interface ParseOptions {
  keywords?: KeywordConfig;
  /** Hostnames accepted in URL references (e.g. ['github.com']). Empty or undefined: URLs are ignored. */
  webHosts?: string[];
}
export function parseBodyRelations(body: string, options?: ParseOptions): RawRelation[];
```

Rules (these are the documented user contract, so tests must cover each one):

1. **Keyword lines.** A line declares relations when, after optional leading
   whitespace, an optional list marker (`-`, `*`, `+`, `1.`), an optional task
   checkbox (`[ ]`, `[x]`, `[X]`) and optional `**`/`__` emphasis, it starts
   with a keyword (case-insensitive), optionally followed by the closing
   emphasis and/or `:`. Every reference on the rest of that line is a relation
   of that keyword's kind. Keywords are matched longest first, and a keyword
   must end at a word boundary.
   Examples: `Depends on #12, #13`, `- Blocked by: owner/repo#4`,
   `**Blocks:** #20`, `- [ ] requires https://github.com/o/r/issues/9`.
2. **Section form.** A markdown heading (`#` to `######`) whose text, trimmed
   and without a trailing `:`, equals a keyword (case-insensitive) starts a
   section. Every **list item** line under it, up to the next heading of any
   level, contributes its references with that keyword's kind.
3. **Reference forms:** `#123`; `owner/repo#123`; and
   `https://<host>/<owner>/<repo>/issues/<n>` when `<host>` is in `webHosts`
   (paths with extra segments before `/owner/repo`, such as Gitea sub-path
   installs, are not supported in v1). `#123` must not be preceded by a word
   character or `/`, and `owner/repo#123` must not be preceded by a word
   character. owner/repo are lowercased. Same-repo references have
   `owner: null, repo: null`.
4. **Ignored regions:** fenced code blocks (``` or ~~~), inline code spans,
   HTML comments (`<!-- -->`, including multi-line), and blockquote lines
   (starting with `>`).
5. Prose anywhere else is ignored. "This depends on #3" in the middle of a
   sentence is **not** a relation. This is deliberate: it is what keeps the
   parse explicit and predictable.
6. Output: `source: 'body'`, unique, sorted by kind (`blocked-by` before
   `blocks`) and then `compareRefs`.

## 8. Plan engine (`src/core/plan.ts`)

```ts
export interface PlanInput {
  viewId: string;
  /** Every node of the plan: open issues only. */
  issues: Issue[];
  /** Keys of issues that are external (see PlanNode.external). */
  externalKeys: IssueKey[];
  /** Edges between keys of `issues`. Edges referencing unknown keys are dropped. */
  edges: DependencyEdge[];
  /** Warnings collected upstream; merged into the plan's warnings. */
  warnings: PlanWarning[];
  priorityLabels: string[];
}
export function buildPlan(input: PlanInput): Plan;
```

Algorithm, where every iteration is over sorted collections:

1. Normalize: dedupe nodes by key; merge duplicate edges (union of sources);
   drop self-loops and emit one `self-reference` warning per issue; drop edges
   whose endpoints are unknown.
2. SCCs with Tarjan (or Kosaraju), iterating nodes and successors in
   `compareKeys` order. An SCC with more than one node gives `in-cycle` nodes
   and one `cycle` warning each. Every node reachable from an in-cycle node
   (and not itself in a cycle) is `blocked-by-cycle`. Emit a single
   `blocked-by-cycle` warning listing them all, if there are any.
3. Schedulable = all other nodes. On that DAG:
   - `remainingDepth(n) = 1 + max(remainingDepth(successors))`, or 1 when there are no successors.
   - `wave(n) = 0` when there are no predecessors, else `1 + max(wave(predecessors))`.
   - `order`: Kahn's algorithm. Among currently available nodes pick the
     minimum by **(priority asc, remainingDepth desc, compareKeys asc)**.
   - `criticalPath`: start at the minimum schedulable node by
     (remainingDepth desc, compareKeys asc). Repeatedly move to the successor
     with the maximum remainingDepth (ties: compareKeys). Stop at a node with
     no successors.
4. status: unschedulable as above; otherwise `ready` when `blockedBy` is empty, else `blocked`.
5. `priority`: index of the first entry in `priorityLabels` that the issue
   carries (case-insensitive exact label match), else `priorityLabels.length`.
6. Plan `warnings` = input warnings + generated warnings, deduped, sorted.

## 9. Layout (`src/core/layout.ts`)

```ts
export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  hGap?: number;
  vGap?: number;
  padding?: number;
}
// defaults: 240, 64, 96, 24, 24
export function computeLayout(plan: Plan, options?: LayoutOptions): Layout;
```

- Layer = `wave`. Unschedulable nodes go in layer `plan.waves.length`.
- Initial row order inside a layer: position in `plan.order`. Unschedulable
  nodes use compareKeys.
- Crossing reduction: 4 iterations. Each iteration does a left-to-right sweep
  that sorts each layer by the barycenter of predecessor rows, then a
  right-to-left sweep that sorts by the barycenter of successor rows. Nodes
  without neighbours on the relevant side keep their current row as their
  barycenter value. The sort is stable, with ties broken by current row.
- `x = padding + layer * (nodeWidth + hGap)`, `y = padding + row * (nodeHeight + vGap)`.
  `width` and `height` are the bounding box plus padding. Every value is an
  integer (`Math.round`).
- Edge points: `[{x: from.x + width, y: from.y + height/2}, {x: to.x, y: to.y + height/2}]`.

## 10. Exporters (`src/export/*`)

Each exporter is `(snapshot: Snapshot) => string`. The output is deterministic
and contains no timestamps except `fetchedAt`, which JSON includes as-is and
Markdown shows in a single header line.

- `toJson`: `JSON.stringify(snapshot, null, 2)` + `"\n"`.
- `toMarkdown`: title, summary stats, a waves table (wave, order, issue
  link, title, status, blocked by), then an unschedulable section, cycles and
  warnings.
- `toMermaid`: `flowchart LR`. Node ids `n_<sanitized key>`, labels
  `"#N title"` with quotes escaped, a `classDef` per status, and edges `a --> b`.
- `toDot`: `digraph` with `rankdir=LR`, nodes grouped by wave with `rank=same` subgraphs, and edges.

## 11. Configuration (`src/config/*`)

YAML file. The path comes from `--config`, then `EV_CONFIG`, then
`./config.yaml`. With no file, fall back to **env-only mode**.

```yaml
server:
  host: 0.0.0.0 # default
  port: 8080 # default
  basicAuth: # optional; both keys required if present
    username: admin
    passwordEnv: EV_BASIC_AUTH_PASSWORD
cache:
  ttlSeconds: 300 # default
sources:
  - id: gh
    kind: github
    baseUrl: https://api.github.com # default for github. GHES: https://ghe.example.com/api/v3
    webUrl: https://github.com # optional. Default: github.com for api.github.com, else baseUrl minus /api/v3
    tokenEnv: GITHUB_TOKEN # name of the env var holding the token (recommended)
    # token: ghp_xxx                    # inline token (discouraged)
  - id: gt
    kind: gitea
    baseUrl: https://gitea.example.com # instance root. The API is at <baseUrl>/api/v1
    tokenEnv: GITEA_TOKEN
  - id: demo
    kind: fixture
    path: ./test/fixtures/demo.json # fixture provider data file
views:
  - id: platform
    title: Platform roadmap
    source: gh
    repos: [acme/api, acme/web]
    dependencies:
      native: true # default true
      body: true # default true
      subIssues: false # default false (github only)
      keywords: # default DEFAULT_KEYWORDS
        blockedBy: [depends on, blocked by, requires, dependencies]
        blocks: [blocks, blocking, required by]
    scope:
      labels: [] # when non-empty, only issues with at least one of these labels are in scope
      excludeLabels: [] # issues with any of these labels are out of scope
      milestones: [] # when non-empty, only issues in one of these milestones are in scope
    ordering:
      priorityLabels: [] # e.g. [P0, P1, P2]
```

Validation: unique source ids, unique view ids, and `view.source` must exist.
`repos` entries match `owner/repo` and are lowercased. `id` values match
`^[a-z0-9][a-z0-9-_]*$`. `tokenEnv` naming a missing env var is **not** an
error (the token is null and a warning is logged). Anonymous access works for
public repos.

**Env-only mode**, used when no config file exists:
`EV_PROVIDER` (github|gitea, required), `EV_REPOS` (comma-separated
owner/repo, required), `EV_BASE_URL`, `EV_TOKEN` (falls back to
`GITHUB_TOKEN` / `GITEA_TOKEN`), `EV_VIEW_ID` (default `default`),
`EV_VIEW_TITLE`, `EV_PRIORITY_LABELS` (comma-separated), `EV_SUB_ISSUES`
(`true`/`false`). With neither a file nor `EV_PROVIDER`, fail with a clear
message.

These env vars override values in either mode: `EV_HOST`, `EV_PORT`,
`EV_CACHE_TTL`, `EV_BASIC_AUTH` (`user:password`).

```ts
export interface ResolvedSource {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  webUrl: string;
  token: string | null;
  path: string | null;
}
export interface ResolvedView {
  id: string;
  title: string;
  source: string;
  repos: RepoRef[];
  dependencies: { native: boolean; body: boolean; subIssues: boolean; keywords: KeywordConfig };
  scope: { labels: string[]; excludeLabels: string[]; milestones: string[] };
  ordering: { priorityLabels: string[] };
}
export interface AppConfig {
  server: { host: string; port: number; basicAuth: { username: string; password: string } | null };
  cache: { ttlSeconds: number };
  sources: ResolvedSource[];
  views: ResolvedView[];
}
export function loadConfig(opts?: {
  path?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): AppConfig;
export function parseConfig(yamlText: string, env: Record<string, string | undefined>): AppConfig;
```

## 12. Providers (`src/providers/*`)

Factories: `createGitHubProvider(opts)`, `createGiteaProvider(opts)`,
`createFixtureProvider(opts)`, and `createProvider(source: ResolvedSource, deps?: { fetch?: typeof fetch })`
in `index.ts`. Options: `{ baseUrl, webUrl, token, fetch?, concurrency? (default 4) }`.

Shared (`http.ts`): JSON GET with auth header, retry on 429/502/503/504 with
bounded exponential backoff (max 3 retries; honor `Retry-After`; the sleep
function is injectable so tests stay fast), `Link`-header pagination, and a
small concurrency limiter. Error messages must never include the token.

### GitHub

- Auth: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- List: `GET /repos/{o}/{r}/issues?state=open&per_page=100` with pagination. Skip items that have `pull_request`.
- Native dependencies (when `native`): for each issue where
  `issue_dependencies_summary.total_blocked_by > 0`, or where that field is
  absent, call `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by?per_page=100`
  (paginated). Each returned issue gives a `blocked-by` relation. Its owner and
  repo are parsed from `repository_url` (`.../repos/{owner}/{repo}`). On 404 for
  the first such call, mark native dependencies unsupported for this repo
  (older GHES), emit one `native-unsupported` warning, and stop calling.
- Sub-issues (when `subIssues`): for issues with
  `sub_issues_summary.total > 0` (or the field absent), call
  `GET /repos/{o}/{r}/issues/{n}/sub_issues?per_page=100`. Each child gives a
  `blocked-by` relation on the parent with `source: 'sub-issue'`. Handle 404
  the same way as above.
- getIssue: `GET /repos/{o}/{r}/issues/{n}`. 404/410 → null. Has `pull_request` → null.
- Mapping: `url` = `html_url`, labels from `labels[].name`, assignees from
  `assignees[].login`, milestone from `milestone.title`. Body null → `''`.

### Gitea (API v1)

- Auth: `Authorization: token <token>`.
- List: `GET /api/v1/repos/{o}/{r}/issues?state=open&type=issues&limit=50&page=N`
  until a page returns fewer than `limit` items. Skip anything with `pull_request` set.
- Native (when `native`): `GET /api/v1/repos/{o}/{r}/issues/{n}/dependencies`
  (paginated with `limit`/`page`) returns the issues this issue depends on:
  `blocked-by` relations. owner/repo come from `repository.owner` and
  `repository.name`. On 404 for the first call, emit `native-unsupported` and
  stop (dependencies disabled on the repo or instance).
- getIssue: `GET /api/v1/repos/{o}/{r}/issues/{n}`; 404 → null; `pull_request` set → null.
- Mapping: `url` = `html_url`; labels `labels[].name`; assignees
  `assignees[].login` (may be null); milestone `milestone.title`.
- `subIssues` is ignored.

### Fixture

Reads a JSON file: `{ "issues": FixtureIssue[] }`, where `FixtureIssue` has
`owner, repo, number, title, state, body?, labels?, assignees?, milestone?, blockedBy?: string[]`
(the keys of native blocked-by relations, such as `"acme/api#3"`). No
network access. Used for the demo, tests and the Docker smoke test.
`test/fixtures/demo.json` must show every feature: several waves, a parallel
branch, a cycle, a blocked-by-cycle node, a closed dependency (satisfied), a
dangling reference, a cross-repo dependency, and priority labels.

## 13. Plan service (`src/service/*`)

```ts
export class PlanService {
  constructor(
    config: AppConfig,
    deps?: { providerFor?: (source: ResolvedSource) => IssueProvider; now?: () => Date },
  );
  listViews(): { id: string; title: string; source: string; kind: ProviderKind; repos: string[] }[];
  getSnapshot(viewId: string, opts?: { refresh?: boolean }): Promise<Snapshot>; // throws UnknownViewError
}
```

Resolution (`resolve.ts`), deterministic:

1. `open` = union of `listOpenIssues` over the view's repos, processed in
   sorted repo order. Carry the fetch warnings through.
2. For every open issue, relations = native relations (if enabled) + body
   relations (if enabled, `parseBodyRelations(body, { keywords, webHosts: [host of source.webUrl] })`).
   A ref with `owner: null` resolves against the declaring issue's repo.
3. For every referenced key not in `open`, call `provider.getIssue` once
   (memoized per snapshot). Closed → the relation is satisfied and dropped.
   null → a `dangling-reference` warning naming the declaring issue and the ref,
   then dropped. Open → it becomes an **external** node. Its body relations
   are parsed and resolved too, transitively, capped at 200 extra fetches;
   past the cap, emit `external-unresolved`. `getIssue` throwing → a
   `fetch-error` warning, and the ref is treated as open external with the
   title `(unavailable)`.
4. Edges: `blocked-by` on X with ref Y gives `Y → X`. `blocks` on X with ref Y gives `X → Y`.
5. Scope: an in-scope issue is an open issue of a view repo that passes
   `scope.labels` / `excludeLabels` / `milestones` (case-insensitive). Plan
   nodes = in-scope issues ∪ all their transitive open prerequisites.
   Prerequisites that are not in scope are marked external.
6. `buildPlan`, then `computeLayout`, then `contentHash({ plan, layout })`, then `Snapshot`.

Caching: an in-memory map per view with a TTL of `cache.ttlSeconds`.
Concurrent `getSnapshot` calls for the same view share one in-flight promise.
`refresh: true` bypasses the TTL and still shares in-flight work. A failed
fetch is not cached.

## 14. HTTP API (`src/server/*`)

`buildApp(config, service, { webDir?: string }): FastifyInstance`, plus
`index.ts` to start it.

| Method | Path                                         | Response                                                                       |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/healthz`                                   | `{ status: "ok" }` (no auth)                                                   |
| GET    | `/api/views`                                 | `service.listViews()`                                                          |
| GET    | `/api/views/:id/snapshot?refresh=1`          | `Snapshot`                                                                     |
| POST   | `/api/views/:id/refresh`                     | `Snapshot` (forced refresh)                                                    |
| GET    | `/api/views/:id/export.(json\|md\|mmd\|dot)` | text, with the proper content-type and `Content-Disposition: inline`           |
| GET    | `/*`                                         | static web UI from `webDir` (default `dist/web`), SPA fallback to `index.html` |

Errors: unknown view → 404 `{ error }`; a provider error → 502 `{ error }`
(no token in the message). Optional basic auth protects everything except
`/healthz`.

## 15. CLI (`src/cli/index.ts`, bin `execution-view`)

- `execution-view serve [--config p]` starts the server.
- `execution-view views [--config p]` lists views.
- `execution-view plan <viewId> [--config p] [--format json|md|mermaid|dot] [--out file]` (default format `md`, default output stdout).
- `execution-view check [--config p]` validates the config, fetches every view,
  and prints stats and warnings per view. It exits with code 1 on a config or
  fetch error, and code 2 when any view has cycles or dangling references.
  This is how users verify the prerequisites.

## 16. Web UI (`web/`)

Single page, no framework:

- A header with a view selector, the repo list, `fetchedAt`, a short content
  hash, a Refresh button, and export links.
- The **Graph** tab renders an SVG from `Layout`, with wave column headers,
  status colours, external nodes with a dashed border, and bezier edges built
  from the edge points. Pan with drag, zoom with the wheel, and a "fit" button.
  Clicking a node selects it, highlights its upstream and downstream, and
  opens a side panel (title, link, labels, assignees, status, wave, order,
  blocked by, blocks).
- The **Execution order** tab shows a table grouped by wave with order #,
  issue, title, status, labels, and blocked by. Critical-path rows are marked.
- The **Problems** tab lists cycles, blocked-by-cycle nodes and warnings.
- A text filter (title, label, or `#N`) dims non-matching nodes and rows. It
  never changes the order.
- Light and dark themes via `prefers-color-scheme`. It must be usable at 1024px width.

## 17. Conventions for contributors (and agents)

- Branch per ticket: `ticket/<issue#>-<slug>`, created from the integration
  branch `claude/blissful-brown-20qnzf`. PRs target that branch.
- Do not touch `package.json`, the lockfile, tsconfig files or CI unless your
  ticket says so. If you need a new dependency, stop and report it.
- Before pushing, run `npm run typecheck && npm test && npm run format:check`.
  All must pass.
- No network access in tests. Use fixtures and an injected `fetch`.
