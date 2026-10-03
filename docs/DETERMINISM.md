# Determinism

execution-view is built so that **the same issue data and the same configuration always produce the same output, byte for byte**. This page states the guarantees, the exact rules that produce the order, the layout and the hash, and what can change the output.

Contents:

- [The guarantees](#the-guarantees)
- [Keys and the total order](#keys-and-the-total-order)
- [Waves](#waves)
- [Linear order](#linear-order)
- [Critical path](#critical-path)
- [Cycles](#cycles)
- [Layout](#layout)
- [The content hash](#the-content-hash)
- [What can change the output](#what-can-change-the-output)
- [Worked example](#worked-example)

## The guarantees

Given the same issue data (titles, states, labels, relations, bodies) and the same configuration, you always get the same `plan`, the same `layout` and the same `contentHash`. Specifically, the output does not depend on:

- **the order in which the API returns issues, relations or pages** (everything is sorted before use, and duplicates are resolved by content, not by arrival order),
- the time of the request (`fetchedAt` is the only timestamp, and it is excluded from the hash),
- randomness, hash-map iteration order or the machine's locale (all comparisons are plain UTF-16 code-unit comparisons, never `localeCompare`),
- concurrency (requests to the tracker run in parallel, but results are sorted before use),
- the cache (a cached snapshot is the same object that was built by the fetch).

## Keys and the total order

Every issue has a canonical **key**: `owner/repo#number`, with owner and repo **lowercased** (`Acme/API#7` is `acme/api#7`). Keys are compared by:

1. the string `owner/repo`, by UTF-16 code unit,
2. then the issue **number**, numerically (so `#9` sorts before `#10`).

This "key order" is the tie-breaker of last resort everywhere below, so every ordering decision has a single answer.

## Waves

The plan graph has an edge `A to B` when A must be closed before B can start. Only **open** issues are nodes (closed prerequisites are satisfied and dropped).

- `wave(n) = 0` when the node has no open prerequisites; otherwise `wave(n) = 1 + max(wave(p))` over its prerequisites `p`. In other words, a node's wave is the **length of the longest chain of prerequisites** leading to it, counted from a root.
- All issues of one wave can be worked on in parallel once the earlier waves are done. The number of waves is the minimum number of sequential steps.
- In JSON, waves are **0-based** (`node.wave`, `plan.waves[0]` is the first wave). The Markdown and DOT exports number them from **1** (`Wave 1`, `wave_1`).
- `plan.waves[i]` lists the keys of wave `i`, sorted by their position in the linear order.
- The **remaining depth** of a node is the number of nodes on the longest chain that starts at it and follows the issues that depend on it: `1 + max(remainingDepth of dependents)`, or `1` when nothing depends on it. It is an intermediate value used for ordering (`PlanNode.remainingDepth`).

## Linear order

`plan.order` is a linear order of all schedulable issues that respects every dependency. It is computed with **Kahn's algorithm**: repeatedly take the next issue among those whose prerequisites are all already placed. When several issues are available, the next one depends on the view's ordering mode. In the default mode (`ordering.mode: priority`) the next one is the minimum by:

1. **priority**, ascending: the index of the first matching entry of `ordering.priorityLabels` (matching case-insensitively, exact label names; if an issue carries several priority labels the smallest index wins). Issues with no priority label get `priorityLabels.length` and so come after all prioritised ones. With no `priorityLabels`, every issue has the same priority and this step has no effect.
2. **remaining depth**, descending: prefer the issue that unblocks the longest chain (so long chains start early).
3. **key order**, ascending.

Priority is a preference among _available_ issues only: it never lets an issue jump ahead of its prerequisites.

Because priority and depth are compared before anything else, the numbering of this order can **interleave waves**: an issue from wave 2 can be numbered before an issue from wave 1 once its prerequisites are done and it has a higher priority (or a longer chain behind it). That is correct, and the waves still show what can run in parallel, but it can be surprising.

With `ordering.mode: waves` the next one is the minimum by:

1. **wave**, ascending (computed before ordering starts, as above).
2. **priority**, ascending.
3. **remaining depth**, descending.
4. **key order**, ascending.

Kahn's algorithm is the same; only the comparison changes. The order therefore runs wave by wave: `order` is non-decreasing in `wave`, and `plan.waves[i]` concatenated in wave order equals `plan.order`. Within a wave, issues are ordered by priority, then remaining depth, then key. The mode is reported as `Snapshot.orderingMode` and is not hashed on its own: `plan.order` already reflects it, so changing the mode changes the content hash whenever it changes the order. The default, `priority`, is what every plan used before the option existed.

## Critical path

The critical path is the longest chain of dependencies among the schedulable issues (`plan.criticalPath`, listed in execution order):

1. Start at the node with the greatest remaining depth (ties: the smallest key).
2. Repeatedly move to the dependent with the greatest remaining depth (ties: the smallest key), until a node without dependents is reached.

If several chains have the same length, exactly one is reported, chosen by the tie-breaks above. Its length equals the number of waves.

## Cycles

Cycles are found with strongly connected components (Tarjan's algorithm, visiting nodes and edges in key order).

- A component of more than one issue is a **cycle**: its issues get status `in-cycle`, and the plan gets one `cycle` warning per cycle, listing its members sorted by key.
- Every issue reachable from a cycle (and not itself in one) gets status `blocked-by-cycle`, with a single `blocked-by-cycle` warning listing them all.
- These issues are **unschedulable**: `wave` and `order` are `null`, `remainingDepth` is `0`, and they appear in none of `waves`, `order` or `criticalPath`. They are listed in `plan.unschedulable`. All other issues are ordered as if the cycle did not exist.
- An issue that depends on itself is not a cycle: the self-edge is dropped, a `self-reference` warning is added, and the issue stays schedulable.

## Layout

`layout` gives coordinates for drawing the graph, computed only from the plan:

1. **Layers.** The layer (column) of a node is its wave. Unschedulable nodes go in one extra layer after the last wave (`layer = plan.waves.length`).
2. **Initial rows.** Inside a layer, nodes start in the order of `plan.order` (unschedulable nodes by key).
3. **Crossing reduction.** Four iterations, each made of a left-to-right sweep (each layer is sorted by the average row of the node's neighbours in earlier layers) and a right-to-left sweep (average row of neighbours in later layers). A node without neighbours on the relevant side keeps its current row as its value. The sort is stable and ties keep the current row.
4. **Coordinates**, all integers: `x = 24 + layer * (240 + 96)`, `y = 24 + row * (64 + 24)`. Nodes are 240 by 64. `layout.width` and `layout.height` are the bounding box plus the 24 padding.
5. **Edges.** Each edge gets two points: the middle of the right side of the source node, and the middle of the left side of the target node.

## The content hash

`snapshot.contentHash` is the SHA-256 (hex) of the **canonical JSON** of `{ plan, layout }`. Canonical JSON has object keys sorted recursively (by code unit), no whitespace, and keeps array order.

**Covered:** everything in `plan` and `layout`: the view id, each node's key, title, URL, labels, assignees, milestone, external flag, status, wave, order, priority and depth, the `parents` and `children` hierarchy, all edges and their sources, the order, waves, cycles, critical path, the stats and the **text of the warnings**, and all layout coordinates.

**Not covered:** `fetchedAt` (the only clock value), and the view's `title` (it is stored beside the plan, not in it).

Because titles, labels and assignees are part of the plan, the hash changes when _anything shown_ changes, not only when the order changes. To find out whether the **order** changed, compare `plan.order`.

### Using the hash

- **ETag.** The snapshot endpoint returns `ETag: "<contentHash>"` and answers `304 Not Modified` to a matching `If-None-Match`. A client can poll cheaply and only download when the plan changed (see [API.md](API.md)).
- **Comparing runs.** The Markdown export shows the first 12 characters of the hash (`hash \`1097a5d86c60\``). Two runs with the same hash produced identical plans and layouts:

```sh
node dist/cli/index.js plan demo -f json | jq -r .contentHash
```

- **Regression checks.** Store the hash next to a planning meeting or a release: a different hash later means that something the view shows has changed.

Note that the JSON and Markdown exports contain `fetchedAt`, so diff `.plan` (or compare hashes) rather than whole files.

## What can change the output

| Change                                                                                                         | Effect                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| An issue is opened, closed (any reason) or transferred                                                         | Nodes, edges, waves and order change                                                                 |
| A relation is added or removed (native, body line, sub-issue)                                                  | Edges, waves, order, critical path, cycles                                                           |
| A `Parent: [...]` relation line is added or removed                                                            | `parents`/`children` and the hash change; edges, waves, order and critical path do not               |
| A body reference is edited, or moved into or out of an ignored region                                          | Same as a relation                                                                                   |
| An issue's title, labels, assignees, milestone or URL changes                                                  | The node fields and the hash change; the order changes only if a priority or scope label is involved |
| A priority label is added or removed                                                                           | `priority` and, possibly, the order                                                                  |
| `ordering.priorityLabels`, `ordering.mode`, `scope`, `repos`, `keywords`, `native`, `body`, `subIssues` change | Different nodes, edges or order                                                                      |
| A referenced issue becomes inaccessible (token, permissions, deletion)                                         | A `dangling-reference` warning appears and the edge disappears                                       |
| A refresh fails partway (rate limit, network)                                                                  | A `fetch-error` warning, or the whole refresh fails; the failed result is not cached                 |
| The order in which the API returns things                                                                      | **Nothing**                                                                                          |
| The time, the cache TTL, the port, basic auth, the view's display `title`                                      | **Nothing** in the plan or the hash                                                                  |

## Worked example

Five issues in `acme/app`. `priorityLabels` is `[P0, P1, P2]`.

| Issue | Title   | Labels | Body                    |
| ----- | ------- | ------ | ----------------------- |
| #1    | Schema  | P1     |                         |
| #2    | API     |        | `Depends on #1`         |
| #3    | UI      |        | `Depends on #1`         |
| #4    | Docs    | P0     |                         |
| #5    | Release |        | `Depends on #2, #3, #4` |

**Waves** (longest chain from a root):

| Issue | Wave (0-based) | Remaining depth | Priority |
| ----- | -------------- | --------------- | -------- |
| #1    | 0              | 3 (#1, #2, #5)  | 1 (P1)   |
| #4    | 0              | 2 (#4, #5)      | 0 (P0)   |
| #2    | 1              | 2               | 3 (none) |
| #3    | 1              | 2               | 3 (none) |
| #5    | 2              | 1               | 3 (none) |

**Order.** Available at the start: #1 (priority 1, depth 3) and #4 (priority 0, depth 2). Priority comes first, so #4 goes first, even though #1 unblocks a longer chain. Then #1. Then #2 and #3 become available with equal priority and depth, so the key decides: #2, then #3. #5 is last. Result: `#4, #1, #2, #3, #5`.

**Waves by position:** wave 0 is `[#4, #1]`, wave 1 is `[#2, #3]`, wave 2 is `[#5]`. **Critical path:** start at #1 (depth 3), then #2 and #3 tie at depth 2, the smaller key wins: `#1, #2, #5`.

Real output of `plan mini -f md` for this data (fixture provider, so the URLs are `fixture.local`):

```text
# mini

View `mini` · fetched 2026-09-29T08:55:15.554Z · hash `1097a5d86c60`

5 issues · 2 ready · 3 blocked · 0 unschedulable · 0 external · 5 dependencies · 3 waves

## Execution order

Waves are numbered from 1. Issues in the same wave can be worked on in parallel once all earlier waves are done. ★ marks the critical path. The # column favours priority labels and the critical path: an issue from a later wave can come before an earlier-wave issue once its prerequisites are done.

### Wave 1

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 1 | [#4](https://fixture.local/acme/app/issues/4) | Docs | P0 | ready |  |
| 2 ★ | [#1](https://fixture.local/acme/app/issues/1) | Schema | P1 | ready |  |

### Wave 2

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 3 ★ | [#2](https://fixture.local/acme/app/issues/2) | API |  | blocked | #1 |
| 4 | [#3](https://fixture.local/acme/app/issues/3) | UI |  | blocked | #1 |

### Wave 3

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 5 ★ | [#5](https://fixture.local/acme/app/issues/5) | Release |  | blocked | #2, #3, #4 |
```

The "#" column is the position in the linear order (1-based in Markdown; `order` is 0-based in JSON). The full content hash of this plan is `1097a5d86c6003c4a601af62bb6cb0f5ae620a5193dbe1c52612914607154907`, and the layout is:

| Issue | Layer | Row | x   | y   |
| ----- | ----- | --- | --- | --- |
| #4    | 0     | 0   | 24  | 24  |
| #1    | 0     | 1   | 24  | 112 |
| #2    | 1     | 0   | 360 | 24  |
| #3    | 1     | 1   | 360 | 112 |
| #5    | 2     | 0   | 696 | 24  |

### The same issues in both ordering modes

Three issues in `acme/app`, `priorityLabels` `[P0, P1, P2]`:

| Issue | Title  | Labels | Body            |
| ----- | ------ | ------ | --------------- |
| #1    | Schema | P1     |                 |
| #2    | API    | P0     | `Depends on #1` |
| #3    | Docs   |        |                 |

Waves: #1 and #3 are in wave 0, #2 is in wave 1.

- **`priority` (default).** Available at the start: #1 (priority 1, depth 2) and #3 (no priority, depth 1). #1 goes first. Now #2 becomes available with priority 0 (P0) and beats #3, which has no priority, so #2 goes before #3, even though it is in a later wave. Result: `#1, #2, #3`.
- **`waves`.** #1 goes first (wave 0, priority 1 before none). Wave 0 is finished before wave 1 starts, so #3 comes next, then #2. Result: `#1, #3, #2`.

Real output of `plan -f md` for this data in each mode (the `#` column is the position in the linear order; the two modes differ only in the legend line, the numbers and the hash):

```text
# priority mode (ordering.mode omitted)

## Execution order

Waves are numbered from 1. Issues in the same wave can be worked on in parallel once all earlier waves are done. ★ marks the critical path. The # column favours priority labels and the critical path: an issue from a later wave can come before an earlier-wave issue once its prerequisites are done.

### Wave 1

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 1 ★ | [#1](https://fixture.local/acme/app/issues/1) | Schema | P1 | ready |  |
| 3 | [#3](https://fixture.local/acme/app/issues/3) | Docs |  | ready |  |

### Wave 2

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 2 ★ | [#2](https://fixture.local/acme/app/issues/2) | API | P0 | blocked | #1 |
```

```text
# waves mode (ordering.mode: waves)

## Execution order

Waves are numbered from 1. Issues in the same wave can be worked on in parallel once all earlier waves are done. ★ marks the critical path. The # column runs wave by wave; within a wave, by priority and critical path.

### Wave 1

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 1 ★ | [#1](https://fixture.local/acme/app/issues/1) | Schema | P1 | ready |  |
| 2 | [#3](https://fixture.local/acme/app/issues/3) | Docs |  | ready |  |

### Wave 2

| # | Issue | Title | Priority | Status | Blocked by |
| --- | --- | --- | --- | --- | --- |
| 3 ★ | [#2](https://fixture.local/acme/app/issues/2) | API | P0 | blocked | #1 |
```

In priority mode the API issue (#2, wave 2) is numbered 2, before the Docs issue (#3, wave 1) numbered 3; in waves mode it is numbered 3.

To reproduce the first example, save the issues as a fixture (`{ "issues": [ { "owner": "acme", "repo": "app", "number": 1, "title": "Schema", "state": "open", "labels": ["P1"], "body": "" }, ... ] }`, see [CONFIGURATION.md](CONFIGURATION.md#fixture--demo)) and point a `fixture` source at it. Re-running gives the same hash every time, whatever order the issues are listed in the file.
