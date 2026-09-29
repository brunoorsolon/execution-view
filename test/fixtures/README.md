# Test fixtures

## `demo.json`: the Acme demo roadmap

A mini-roadmap of two repositories, `acme/api` and `acme/web`, used by the
fixture provider (`src/providers/fixture.ts`), by `config.demo.yaml`, by the
Docker smoke test and by the service tests. The top-level `_comment` field is
ignored by the loader.

It holds 25 issues: 23 open and 2 closed (`acme/api#1`, `acme/web#1`).
The browser URL of an issue is `https://fixture.local/<owner>/<repo>/issues/<n>`.

This file is also the **expected-results spec** for the service, plan and
export tests. All values below assume the view from `config.demo.yaml`:
`repos: [acme/api, acme/web]`, `priorityLabels: [P0, P1, P2]`, native and body
dependencies enabled, default keywords, `webHosts: ['fixture.local']`, no scope
filters.

### Expected totals

| Item          | Expected                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Plan nodes    | 23 (all open issues), 0 external                                                                                                           |
| Edges         | 34 (see the edge list below)                                                                                                               |
| Waves         | 7 (waves 0 to 6)                                                                                                                           |
| Ready         | 4: `acme/api#2`, `acme/api#3`, `acme/web#2`, `acme/web#5`                                                                                  |
| Blocked       | 14                                                                                                                                         |
| Unschedulable | 5: cycle `acme/api#11`, `#12`, `#13`; blocked-by-cycle `acme/api#14`, `acme/web#7`                                                         |
| Cycles        | one: `[acme/api#11, acme/api#12, acme/api#13]`                                                                                             |
| Warnings      | `cycle` (1), `blocked-by-cycle` (1, lists `acme/api#14` and `acme/web#7`), `dangling-reference` (1: `acme/api#10` refers to `acme/api#99`) |
| Critical path | `acme/api#2`, `#4`, `#5`, `#6`, `#8`, `#15`, `acme/web#9` (7 nodes)                                                                        |

Closed dependencies (`acme/api#1` from `acme/api#2`, `acme/web#1` from
`acme/web#2`) are satisfied: they produce no edge, no node and no warning.

### Issues

`Wave` and `Order` are the expected `PlanNode.wave` and `PlanNode.order`.
`P` is the expected `PlanNode.priority` (3 means no priority label).
Dependencies are listed as they are written; `native` means the `blockedBy` field.

| Issue         | Title                             | State  | Declared dependencies (form)                                | Demonstrates                                                   | P   | Wave | Order | Expected outcome                                    |
| ------------- | --------------------------------- | ------ | ----------------------------------------------------------- | -------------------------------------------------------------- | --- | ---- | ----- | --------------------------------------------------- |
| `acme/api#1`  | Bootstrap repository and CI       | closed | none                                                        | closed prerequisite                                            | 3   | n/a  | n/a   | not in the plan                                     |
| `acme/api#2`  | Design database schema            | open   | `Depends on #1` (closed)                                    | closed dependency is satisfied; root of the critical path      | 0   | 0    | 0     | ready                                               |
| `acme/api#3`  | Set up migration tooling          | open   | `**Blocks:** #6`                                            | `Blocks` keyword (reverse edge)                                | 1   | 0    | 3     | ready                                               |
| `acme/api#4`  | Implement authentication with JWT | open   | `Depends on #2`                                             | plain `Depends on`                                             | 0   | 1    | 1     | blocked by `acme/api#2`                             |
| `acme/api#5`  | Users and memberships endpoints   | open   | `- Blocked by: #2, #4`                                      | list item, colon, several refs                                 | 1   | 2    | 4     | blocked by `#2`, `#4`                               |
| `acme/api#6`  | Projects endpoints                | open   | `- [ ] requires #5`; native `acme/api#2`; `#3` via `Blocks` | task checkbox, native, mixed sources                           | 1   | 3    | 5     | blocked by `#2`, `#3`, `#5`                         |
| `acme/api#7`  | Rate limiting and API keys        | open   | `## Depends on` section with items `- #4` and `- #5`        | heading section form                                           | 2   | 3    | 11    | blocked by `#4`, `#5`                               |
| `acme/api#8`  | Publish OpenAPI documentation     | open   | `Depends on #6, #7`                                         | fan-in                                                         | 2   | 4    | 12    | blocked by `#6`, `#7`                               |
| `acme/api#9`  | Webhook notifications             | open   | `Depends on #6` and native `acme/api#6`                     | same edge from body and native: `sources: [body, native]`      | 2   | 4    | 13    | blocked by `#6`                                     |
| `acme/api#10` | Full-text search endpoint         | open   | `Depends on #2, #99`                                        | dangling reference (`acme/api#99` does not exist)              | 2   | 1    | 16    | blocked by `#2`; `dangling-reference`               |
| `acme/api#11` | Background job queue              | open   | `Depends on #12`                                            | cycle member                                                   | 1   | null | null  | in-cycle                                            |
| `acme/api#12` | Job retry and dead-letter policy  | open   | `- Blocked by: #13`                                         | cycle member                                                   | 2   | null | null  | in-cycle                                            |
| `acme/api#13` | Job dashboard and metrics         | open   | native `acme/api#11`                                        | cycle member closed through a native relation                  | 1   | null | null  | in-cycle                                            |
| `acme/api#14` | Nightly report export             | open   | `Depends on #12, #2`                                        | downstream of a cycle                                          | 2   | null | null  | blocked-by-cycle                                    |
| `acme/api#15` | Production deployment pipeline    | open   | `Depends on #8, #9`                                         | deep wave, P0 that has to wait                                 | 0   | 5    | 14    | blocked by `#8`, `#9`                               |
| `acme/api#16` | Audit logging                     | open   | `Depends on #4` only                                        | prose, code block, inline code and blockquote do NOT count     | 3   | 2    | 17    | blocked by `#4` only                                |
| `acme/web#1`  | Choose UI framework               | closed | none                                                        | closed prerequisite (native)                                   | 3   | n/a  | n/a   | not in the plan                                     |
| `acme/web#2`  | App shell and routing             | open   | native `acme/web#1` (closed)                                | closed native dependency is satisfied                          | 0   | 0    | 2     | ready                                               |
| `acme/web#3`  | Login page                        | open   | `Depends on acme/api#4, #2`; `#5` via `Blocks`              | cross-repo ref `acme/api#N`; same-repo `#2` means `acme/web#2` | 0   | 2    | 7     | blocked by `acme/api#4`, `acme/web#2`, `acme/web#5` |
| `acme/web#4`  | Projects list page                | open   | `- Blocked by: acme/api#6, #3`; `#5` via `Blocks`           | cross-repo ref in a list item                                  | 1   | 4    | 8     | blocked by `acme/api#6`, `acme/web#3`, `acme/web#5` |
| `acme/web#5`  | Shared component library          | open   | `**Blocks:** #3, #4`                                        | `Blocks` with several refs                                     | 2   | 0    | 6     | ready                                               |
| `acme/web#6`  | Project detail page               | open   | `Depends on https://fixture.local/acme/api/issues/6, #5`    | URL reference; lowercase `p1` label counts as P1               | 1   | 4    | 9     | blocked by `acme/api#6`, `acme/web#5`               |
| `acme/web#7`  | Reports page                      | open   | `Depends on acme/api#14`                                    | cross-repo dependency on a blocked-by-cycle issue              | 1   | null | null  | blocked-by-cycle                                    |
| `acme/web#8`  | End-to-end test suite             | open   | `Depends on #4, #6`; native `acme/web#3`                    | native-only edge (`acme/web#3`) next to body edges             | 1   | 5    | 10    | blocked by `#3`, `#4`, `#6`                         |
| `acme/web#9`  | Production deployment to CDN      | open   | `Depends on #8, acme/api#15`                                | deepest wave; joins both repos                                 | 0   | 6    | 15    | blocked by `acme/web#8`, `acme/api#15`              |

Priority labels, milestones and assignees are spread over the issues
(`v0.1 Foundations`, `v0.2 Core API`, `v1.0 Launch`; alice, bob, carol, dave, erin,
frank). `acme/api#16` only has the label `tech-debt`, so it has no priority.

`Wave` and `Order` are null for the five unschedulable issues (and their
`remainingDepth` is 0). Closed issues are not part of the plan.

### Expected waves

| Wave | Issues (sorted by their position in the order)         |
| ---- | ------------------------------------------------------ |
| 0    | `acme/api#2`, `acme/web#2`, `acme/api#3`, `acme/web#5` |
| 1    | `acme/api#4`, `acme/api#10`                            |
| 2    | `acme/api#5`, `acme/web#3`, `acme/api#16`              |
| 3    | `acme/api#6`, `acme/api#7`                             |
| 4    | `acme/web#4`, `acme/web#6`, `acme/api#8`, `acme/api#9` |
| 5    | `acme/web#8`, `acme/api#15`                            |
| 6    | `acme/web#9`                                           |

### Expected linear order

Computed with the rule of ARCHITECTURE section 8 (minimum by priority, then
remaining depth descending, then key, among the available issues). There are
18 schedulable issues, so `order` runs from 0 to 17:

```
 0 acme/api#2     1 acme/api#4     2 acme/web#2     3 acme/api#3
 4 acme/api#5     5 acme/api#6     6 acme/web#5     7 acme/web#3
 8 acme/web#4     9 acme/web#6    10 acme/web#8    11 acme/api#7
12 acme/api#8    13 acme/api#9    14 acme/api#15   15 acme/web#9
16 acme/api#10   17 acme/api#16
```

### Expected edges (`from` must be closed before `to`)

34 edges, sorted by (from, to). Sources are `body` unless marked.

```
acme/api#2  -> acme/api#4, acme/api#5, acme/api#6 (native), acme/api#10, acme/api#14
acme/api#3  -> acme/api#6
acme/api#4  -> acme/api#5, acme/api#7, acme/api#16, acme/web#3
acme/api#5  -> acme/api#6, acme/api#7
acme/api#6  -> acme/api#8, acme/api#9 (body + native), acme/web#4, acme/web#6
acme/api#7  -> acme/api#8
acme/api#8  -> acme/api#15
acme/api#9  -> acme/api#15
acme/api#11 -> acme/api#13 (native)
acme/api#12 -> acme/api#11, acme/api#14
acme/api#13 -> acme/api#12
acme/api#14 -> acme/web#7
acme/api#15 -> acme/web#9
acme/web#2  -> acme/web#3
acme/web#3  -> acme/web#4, acme/web#8 (native)
acme/web#4  -> acme/web#8
acme/web#5  -> acme/web#3, acme/web#4, acme/web#6
acme/web#6  -> acme/web#8
acme/web#8  -> acme/web#9
```

### Other useful scenarios

- **Only `acme/web` in the view** (`repos: [acme/web]`): `acme/api#2`,
  `#4`, `#5`, `#6`, `#7`, `#8`, `#9`, `#11`, `#12`, `#13`, `#14` and `#15` become
  **external** nodes (they are transitive open prerequisites of web issues);
  `acme/api#10` and `acme/api#16` are not part of the plan. `acme/api#3` is not
  part of the plan either: it only declares `Blocks: #6` on itself, and nothing
  in the view or in the fetched external issues references it, so it is never
  discovered.
- **`native: false`** (or `body: false`): the edges whose only source is
  `native` (respectively `body`) disappear. `acme/api#13` then loses its only
  dependency, so the cycle is broken and `acme/api#11` to `#14` and `acme/web#7`
  become schedulable.
- **Scope `excludeLabels: [infra]`**: `acme/api#3`, `#15` and `acme/web#9` are
  out of scope. `acme/api#3` still appears as an external node because
  `acme/api#6` depends on it; `acme/api#15` and `acme/web#9` are dropped.
