# Prerequisites

execution-view does not guess. It shows the order implied by the dependencies **you declared** in your issue tracker. If nothing is declared, you get a flat list with no edges. This page explains every prerequisite, exactly, so that you can prepare your repositories and your token before you run the app.

Contents:

1. [What the app reads](#1-what-the-app-reads)
2. [How dependencies are declared: overview](#2-how-dependencies-are-declared-overview)
3. [Option A: native dependencies](#3-option-a-native-dependencies)
4. [Option B: issue body syntax](#4-option-b-issue-body-syntax)
5. [Cross-repository and external issues](#5-cross-repository-and-external-issues)
6. [Cycles and dangling references](#6-cycles-and-dangling-references)
7. [Tokens and permissions](#7-tokens-and-permissions)
8. [API usage and rate limits](#8-api-usage-and-rate-limits)
9. [Scope filters](#9-scope-filters)
10. [Checklist and verification](#10-checklist-and-verification)

Statements about the user interface or the settings of GitHub and Gitea are marked **(may vary by version)**: they come from the platforms' documented behaviour, not from this repository's code, and platforms rename things. Everything else on this page describes what this app does, and is checked against its source code.

## 1. What the app reads

| Item                                                   | Read?          | Notes                                                                                                                                |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Open** issues of every repository listed in the view | Yes            | These are the issues that appear in the plan.                                                                                        |
| Pull requests                                          | No             | Ignored in listings. A reference to a pull request number is treated as a reference to an issue that does not exist (see section 6). |
| Title, state, URL, labels, assignees, milestone        | Yes            | Labels feed priority and scope filters; the rest is displayed.                                                                       |
| **Body** of each issue                                 | Yes            | Parsed for dependency lines (section 4). The body is used for parsing only; it is not part of the plan or of the API output.         |
| Native dependency relations                            | Yes (default)  | GitHub "blocked by" relations, Gitea "dependencies". Switch off with `dependencies.native: false`.                                   |
| Sub-issues (GitHub)                                    | Opt-in         | Only with `dependencies.subIssues: true` (section 3).                                                                                |
| **Comments**                                           | **No**         | A `Depends on #5` written in a comment is invisible to the app. Put it in the issue body.                                            |
| Closed issues of the view's repositories               | Only by lookup | Fetched one by one, only when an open issue references them, to learn that they are closed (satisfied).                              |
| Issues in other repositories                           | Only by lookup | Fetched one by one when referenced (section 5).                                                                                      |

**"Done" means closed.** An issue is done when its state is `closed`, whatever the close reason (completed, "not planned", duplicate). A closed prerequisite never blocks: the relation is silently dropped and the closed issue does not appear in the plan. There is no other notion of "done" (labels, project board columns and milestones do not count).

**Everything is a snapshot.** Each refresh reads the tracker from scratch; nothing is stored between refreshes except an in-memory cache (section 8).

## 2. How dependencies are declared: overview

There are two sources of dependencies. Use either one, or both. They are **merged as a union**: an edge declared by both sources (or declared twice, or from both sides) collapses into a single edge that records all its sources.

| Source                   | Where you write it                                | Works on                                  | Best for                                             |
| ------------------------ | ------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| **A. Native**            | The tracker's own relations UI                    | GitHub (if available), Gitea (if enabled) | Teams that already use the platform feature          |
| **B. Issue body syntax** | A line such as `Depends on #12` in the issue body | GitHub, GHES, Gitea                       | Portability; older GHES; anything reviewable as text |

Direction. Every relation is turned into an edge "**from** must be closed before **to** can start":

| You write, on issue **X**                       | Meaning           | Edge   |
| ----------------------------------------------- | ----------------- | ------ |
| `Depends on #Y` (also `Blocked by`, `Requires`) | X is blocked by Y | Y to X |
| `Blocks #Y` (also `Blocking`, `Required by`)    | X blocks Y        | X to Y |
| Native "blocked by Y" on X                      | X is blocked by Y | Y to X |
| Native "blocking Y" on X                        | Y is blocked by X | X to Y |

The app reads native relations only in the "blocked by" direction, from each open issue of your view (for a relation set as "blocking" on X, it is read from Y's side). So a native relation is only seen when the **blocked** issue is open and belongs to a repository of the view, or is reached through a lookup (section 5; native relations of looked-up external issues are not fetched, but their body lines are read).

The plan only contains issues that are in scope plus the open issues they (transitively) depend on. An issue in another repository that merely depends on one of yours (it is a _dependent_, not a prerequisite) is not shown.

## 3. Option A: native dependencies

### GitHub

Open an issue, find the **Relationships** area of the sidebar, and use **Mark as blocked by** (choose the prerequisite issue) or **Mark as blocking** (choose the issue that waits for this one). This is GitHub's "issue dependencies" feature. **(may vary by version: the labels and the location of these controls can change)**

- The app calls `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by` for each issue.
- **GitHub Enterprise Server versions that do not have issue dependencies** answer `404` on that endpoint. The app then emits a `native-unsupported` warning for that repository, skips native dependencies there, and relies on issue body syntax (option B). Nothing else breaks. To avoid the extra requests, set `dependencies.native: false` on that view.
- **Sub-issues.** A parent and its sub-issues form a _hierarchy_, not an _ordering_, so by default the app ignores sub-issues. With `dependencies.subIssues: true` (default `false`; GitHub sources only), a parent issue is treated as **blocked by each of its sub-issues**: it is ready only when all its open sub-issues are done. On GitHub Enterprise Server versions without sub-issues, the `sub_issues` endpoint answers `404` and you get a `native-unsupported` warning. `subIssues` is ignored on Gitea (the app prints a config warning).

### Gitea

Forgejo uses the same API and is supported with `kind: gitea` (env-only mode: `EV_PROVIDER=gitea`). CI tests the app against live Gitea 1.25 and Forgejo 11 instances (`scripts/forge-integration.sh`); other versions are expected to work but are not tested.

Open an issue and use the **Dependencies** section of the sidebar: add the issue that **this issue depends on**. **(may vary by version)**

For this to work, dependencies must be enabled:

- **Per repository:** in the repository settings, in the issues section, enable the option for issue dependencies (it may be labelled "Enable issue dependencies" or similar) **(may vary by version: the exact label and location can differ, which is why the app's own message only says to enable issue dependencies in the repository settings)**.
- **Per instance:** `[service] DEFAULT_ENABLE_DEPENDENCIES` in `app.ini` sets the default for new repositories (`true` by default in Gitea). **(may vary by version)**
- **Across repositories:** a dependency on an issue in another repository needs `[service] ALLOW_CROSS_REPOSITORY_DEPENDENCIES` (`true` by default in Gitea). **(may vary by version)**

If dependencies are disabled, the dependencies endpoint answers `404`, and the app emits `native-unsupported` and relies on option B.

The app calls `GET /api/v1/repos/{owner}/{repo}/issues/{number}/dependencies` for every open issue (see section 8 for what that costs). Gitea's "blocks" side is not read; it is seen from the blocked issue's side.

## 4. Option B: issue body syntax

Body syntax works everywhere and is the portable, reviewable choice. The parser is strict on purpose: **only explicit declarations count, and casual prose is ignored**. This keeps the graph predictable: a sentence like "this depends on #3 being fixed upstream" must not silently change your plan.

### The rules

**Rule 1: keyword lines.** A line declares relations when, after optional leading whitespace, it starts with:

1. an optional list marker (`-`, `*`, `+` or `1.`),
2. an optional task checkbox (`[ ]`, `[x]`, `[X]`),
3. an optional bold marker (`**` or `__`),
4. a **keyword** (case-insensitive, words separated by any whitespace),
5. then optionally the closing bold marker and/or a colon, and then the references.

The keyword must end at a word boundary (`Blocksmith #3` does not match `Blocks`) and must keep its spaces (`Dependson #3` does not match `Depends on`). **Every** reference on the rest of the same line gets the keyword's direction.

Default keywords:

| Direction                      | Keywords                                               |
| ------------------------------ | ------------------------------------------------------ |
| "this issue is blocked by ..." | `depends on`, `blocked by`, `requires`, `dependencies` |
| "this issue blocks ..."        | `blocks`, `blocking`, `required by`                    |

You can change them in the config (see [Custom keywords](#custom-keywords)).

**Rule 2: section form.** A markdown heading (`#` to `######`) whose text equals a keyword (case-insensitive, ignoring bold markers, closing `#`s and a trailing colon) starts a section. Every **list item** under it (`-`, `*`, `+`, `1.`, with or without a checkbox, any indentation) contributes its references, with that keyword's direction, until the next heading of any level. Plain text lines inside the section are ignored.

**Rule 3: reference forms.**

| Form                                   | Meaning                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#123`                                 | Issue 123 of the **same repository** as the issue that contains the reference                                                                                                                                                                                                                                                             |
| `owner/repo#123`                       | Issue 123 of another repository (owner and repo are case-insensitive)                                                                                                                                                                                                                                                                     |
| `https://<host>/owner/repo/issues/123` | Same as above, but only when `<host>` is the web host of the configured source (for example `github.com`, or the host of `webUrl`/`baseUrl`). URLs on other hosts are ignored. Pull request URLs (`/pull/N`) are not references. A URL under a sub-path install (`https://example.com/gitea/o/r/issues/1`) is not supported: use `o/r#1`. |

A `#123` must not be glued to a word or to a `/` before it (`foo#1` and `a/b/#1` are not references) and must not continue with word characters (`#3abc` is not a reference). Issue numbers start at 1.

**Rule 4: ignored regions.** Nothing inside these is read, even if it looks like a declaration:

- fenced code blocks (``` or `~~~`; an unclosed fence ignores the rest of the body),
- inline code spans (`` `like this` ``),
- HTML comments, including multi-line ones (`<!-- ... -->`),
- blockquote lines (starting with `>`).

**Rule 5: prose is ignored, on purpose.** The keyword has to be at the start of the line (after markers). "This depends on #3" is not a declaration.

Bodies are read line by line, so a keyword and its references must be **on the same line** (in section form, each reference goes on its own list item under the heading). Line endings may be `\n`, `\r\n` or `\r`.

### Accepted and not accepted

Assume default keywords and a source on `github.com`.

| Body text                                              | Result                                | Why                                                                                                          |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Depends on #12`                                       | Accepted: blocked by #12              | Keyword line                                                                                                 |
| `depends on #12, #13 and acme/api#4`                   | Accepted: three prerequisites         | All references on a keyword line count, in any separator                                                     |
| `Depends on: #12`                                      | Accepted                              | Optional colon                                                                                               |
| `- Blocked by: owner/repo#4`                           | Accepted                              | List marker, colon, cross-repo reference                                                                     |
| `* [ ] requires #9`, `- [x] requires #9`               | Accepted                              | Task-list checkbox (checked or not)                                                                          |
| `1. Depends on #9`                                     | Accepted                              | Numbered list marker                                                                                         |
| `**Blocks:** #20`, `**Depends on**: #20`               | Accepted (blocks #20, blocked by #20) | Bold keyword, colon inside or outside the bold                                                               |
| `__Depends on__ #20`                                   | Accepted                              | Underscore bold                                                                                              |
| `DEPENDS ON #3`, `Depends  on   #3`                    | Accepted                              | Case-insensitive; runs of whitespace are fine                                                                |
| `Required by #3`, `Blocking #3`                        | Accepted: this issue blocks #3        | "blocks" keywords                                                                                            |
| `Depends on https://github.com/o/r/issues/9`           | Accepted: blocked by o/r#9            | URL on the configured web host                                                                               |
| `## Depends on` then `- #3` and `- acme/x#4`           | Accepted                              | Section form                                                                                                 |
| `    - depends on #3` (indented)                       | Accepted                              | Leading whitespace is allowed                                                                                |
| `This depends on #3`                                   | **Not accepted**                      | Mid-sentence prose. The line must start with the keyword                                                     |
| `Depends on` then `#3` on the next line                | **Not accepted**                      | The reference must be on the keyword's line                                                                  |
| `Depends on` then `- #3` on the next line              | **Not accepted**                      | Same. Use a `## Depends on` heading if you want a list                                                       |
| `## Depends on` then `#3` (no list marker)             | **Not accepted**                      | Section items must be list items                                                                             |
| `## Dependencies` then `- #3`                          | Accepted                              | "Dependencies" is a default keyword. Section form, like `## Depends on`                                      |
| `Dependencies: #3`, `- Dependencies: #3`               | Accepted                              | Keyword line form                                                                                            |
| `## Dependency` then `- #3`, `Dependenciesfoo #3`      | **Not accepted**                      | Only the plural `Dependencies` is a default keyword, and it must end at a word boundary                      |
| `- Depends on #3` then `- and #4`                      | Only #3 accepted                      | The second line has no keyword                                                                               |
| Inside a ``` fence: `Depends on #3`                    | **Not accepted**                      | Fenced code is ignored                                                                                       |
| `` `Depends on #3` `` or ``Depends on `#3` ``          | **Not accepted**                      | Inline code is ignored (also when it wraps only the reference)                                               |
| `<!-- Depends on #3 -->`                               | **Not accepted**                      | HTML comments are ignored (useful for template hints)                                                        |
| `> Depends on #3`                                      | **Not accepted**                      | Quoted text is ignored                                                                                       |
| `Depends on #0`, `Depends on #3abc`, `Depends on GH-3` | **Not accepted**                      | Not a valid reference                                                                                        |
| `Depends on owner/repo/#3`                             | **Not accepted**                      | Not a valid reference form (`owner/repo#3` is)                                                               |
| `Depends on https://other.example/o/r/issues/9`        | **Not accepted**                      | URL host is not the source's web host                                                                        |
| `Depends on https://github.com/o/r/pull/9`             | **Not accepted**                      | Only `/issues/N` URLs                                                                                        |
| `Blocked by #3 and blocks #4`                          | Both become "blocked by"              | One keyword per line: all references take the **first** keyword's direction. Put `Blocks #4` on its own line |
| `Dependson #3`                                         | **Not accepted**                      | The keyword must end at a word boundary and keep its space                                                   |
| A comment saying `Depends on #3`                       | **Not accepted**                      | Comments are not read                                                                                        |

Also good to know: a reference that is accepted by the parser but points at a **pull request** or a non-existent issue becomes a `dangling-reference` warning (section 6).

### Custom keywords

Keywords are set per view under `dependencies.keywords`. A list you provide **replaces** the default list for that direction (it does not extend it), so repeat the defaults you still want. A missing list keeps its default; an empty list (`[]`) disables that direction.

For example, to also accept `needs` (as in `## Needs` or `Needs: #3`):

```yaml
views:
  - id: platform
    source: gh
    repos: [acme/api]
    dependencies:
      keywords:
        blockedBy: [depends on, blocked by, requires, dependencies, needs]
```

A heading is recognised whenever its text equals one of the configured keywords, so `## Needs` followed by list items then works as a section. Keywords are matched case-insensitively, longest first, and multi-word keywords match across any whitespace.

### Recommended issue template

Put the section in your issue template so that dependencies are declared in a form the parser accepts. Keep hints inside an HTML comment (comments are ignored), and never put a real reference in the placeholder text, because it would be read.

`.github/ISSUE_TEMPLATE/task.md` (GitHub), or `.gitea/issue_template/task.md` (Gitea; the location and front matter may vary by Gitea version):

```md
---
name: Task
about: A unit of work that may depend on other issues
title: ''
labels: ''
---

## What

Describe the work.

## Depends on

<!-- One issue per list item, for example "- #12" or "- owner/repo#12". Leave empty if none. -->

## Blocks

<!-- Issues that cannot start before this one is done. Leave empty if none. -->
```

`## Dependencies` works in a template as well as `## Depends on`. A short alternative that needs no headings:

```md
Depends on: #12, owner/repo#7
Blocks: #30
```

## 5. Cross-repository and external issues

- **`owner/repo#N` and URL references** are looked up through the same source (same host, same token). The token therefore needs **read access to those repositories as well**, even when they are not listed in `repos`. Without access, the platform answers `404`, which the app cannot tell apart from a missing issue: you get a `dangling-reference` warning.
- References between different sources (a GitHub issue that depends on a Gitea issue) are not supported.
- An open issue that is **not** in the view's open set (another repository, or filtered out by a scope filter, see section 9) but is a prerequisite of a planned issue is added to the plan as an **external** node. In the web UI it has a dashed border; the exports mark it too (`(external)` in Markdown, a dashed style in Mermaid and DOT, `external: true` in JSON). Its own body lines are read and followed, transitively, so its prerequisites also appear. Its native relations are not fetched.
- A referenced issue that is **closed** is satisfied: no node, no edge, no warning.
- **The 200 lookup cap.** For each refresh, the app performs at most **200 single-issue lookups** for issues that are not in the open set (closed, missing and external issues all count). Lookups are done breadth-first in sorted order. Past the cap, the remaining references are not resolved and one `external-unresolved` warning lists them. If you hit it, narrow the view or add the repositories that hold those issues to `repos` (issues in `repos` are listed in bulk and do not count as lookups).
- Only **prerequisites** of in-scope issues are pulled in. Issues that merely depend on yours are shown only if they are themselves in scope.

## 6. Cycles and dangling references

**Cycle.** Issues that (transitively) depend on each other: A depends on B, B on C, C on A. No valid order exists, so every issue of the cycle is marked `in-cycle` and left out of the waves and the order. Everything downstream of a cycle is marked `blocked-by-cycle` (also unschedulable). Both groups are shown together in a separate column of the graph and in the Problems view, and the plan carries a `cycle` warning (one per cycle) and a `blocked-by-cycle` warning. **Fix:** remove one of the relations in the cycle (a body line or a native dependency), typically the one that is not a real "must be done first". A cycle can span sources: a body line on one issue plus a native dependency on another.

**Self-reference.** An issue that lists itself is reported as `self-reference`; the relation is dropped and the issue stays schedulable.

**Dangling reference.** A reference to an issue that cannot be found: the number or repository has a typo, the issue was deleted or transferred, it is a **pull request** (only issues count), or the token cannot read that repository. To the API, all of these look like "not found". The relation is dropped and a `dangling-reference` warning names the declaring issue and the reference. **Fix:** correct the reference, or remove it, or give the token access. A dangling reference does not block anything (the relation is dropped), so the plan may be too optimistic until you fix it. `dangling-reference` and `fetch-error` warnings about issues that are not part of the plan (for example declared by an out-of-scope issue) are not reported.

**Fetch error.** If looking up a referenced issue fails for another reason (rate limit, server error, network), the app warns with `fetch-error` and treats the issue as an open external node titled `(unavailable)`, so it still blocks. Failing to list a repository's issues fails the whole view (see the troubleshooting table in section 10).

## 7. Tokens and permissions

The app only ever sends `GET` requests and needs **read-only** access. Use a dedicated token with the fewest permissions, and give it via an environment variable (`tokenEnv` in the config, or `GITHUB_TOKEN` / `GITEA_TOKEN` / `EV_TOKEN` in env-only mode). **Never commit tokens** to Git; `.env` is git-ignored, and `config.yaml` should not contain an inline `token`. The token is never logged, and it is redacted from error messages; the app also refuses to send it to a host other than the configured one.

### GitHub and GitHub Enterprise Server

Permission names and screens **(may vary by version)**:

| Token type                         | What to select                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fine-grained PAT** (recommended) | Resource owner: the user or organisation that owns the repositories. **Repository access:** select every repository listed in the view **and every repository that is only referenced** from those (cross-repo dependencies). **Repository permissions:** **Issues: Read-only**. "Metadata: Read-only" is added automatically. |
| **Classic PAT**                    | Scope `repo` for private repositories. Public repositories need no scope. (Classic tokens are broader than needed; prefer a fine-grained one where your platform version has them.)                                                                                                                                            |
| GHES                               | The same, created on your GHES host. Set the source's `baseUrl` to `https://<host>/api/v3`.                                                                                                                                                                                                                                    |
| No token                           | Works for **public** repositories only, at the anonymous rate limit of 60 requests per hour **(may vary by version)**. Not recommended: a single refresh of a view of any size can use it up.                                                                                                                                  |

If your organisation enforces SAML single sign-on, the token may need to be authorised for the organisation **(may vary by version)**.

### Gitea

**Settings, Applications, Generate New Token.** Select the scopes `read:issue` and `read:repository` **(scoped tokens exist in Gitea 1.19 and later; older versions have unscoped tokens; the exact scope names may vary by version)**. The token owner must be able to read every repository involved (owner or collaborator, or organisation membership). Anonymous access works for public repositories if the instance allows it.

## 8. API usage and rate limits

Every refresh of a view makes requests to your tracker. Derived from the provider code, per repository of the view:

**GitHub / GHES**

| Requests                             | Count                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List open issues                     | `ceil(open / 100)` (page size 100; GitHub's issue list also contains pull requests, so open PRs count toward the pages)                                                            |
| Native dependencies (`native: true`) | 1 per open issue whose `issue_dependencies_summary.total_blocked_by` is greater than 0 **or absent** (issues that report 0 are skipped); more when one issue has over 100 blockers |
| Sub-issues (`subIssues: true`)       | 1 per open issue whose `sub_issues_summary.total` is greater than 0 or absent                                                                                                      |
| Lookups                              | 1 per distinct referenced issue that is not in the open set (closed, external or missing), at most 200 per refresh                                                                 |

**Gitea**

| Requests                             | Count                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| List open issues                     | `ceil(open / 50)` pages (`limit=50`; a server may cap the page size lower, which means more pages) |
| Native dependencies (`native: true`) | 1 per open issue (more when an issue has over 50 dependencies)                                     |
| Lookups                              | Same as GitHub                                                                                     |

The per-issue dependency and sub-issue requests run with a concurrency of 4; lookups of referenced issues run at most 4 at a time (one batch per level of references). Transient failures (HTTP 429, 502, 503, 504, network errors) are retried up to 3 times with exponential backoff, honouring `Retry-After`. When GitHub reports an exhausted rate limit and the reset is within 60 seconds, the app waits for it; if the reset is further away the refresh fails with a message that includes the reset time.

**Example.** A GitHub view with 100 open issues, all with dependencies, and 10 referenced closed or external issues: 1 + 100 + 10 = 111 requests per refresh. Set that against your platform's rate limit (GitHub documents 5,000 requests per hour for authenticated users and 60 for anonymous ones **(may vary by version)**).

**Cache.** Results are cached in memory per view for `cache.ttlSeconds` (default **300**, `0` disables caching). Page loads and exports within the TTL cost nothing; the first request after it expires (or a click on Refresh, or `?refresh=1`, or `POST /api/views/:id/refresh`) refetches. Simultaneous requests for the same view share one fetch, and a failed fetch is not cached. So the steady-state cost is at most one refresh per view per TTL, and only while somebody is looking. The CLI always fetches fresh. Raise the TTL, or set `dependencies.native: false`, if you are close to a limit.

## 9. Scope filters

By default a view plans every open issue of its repositories. `scope` narrows the **roots** of the plan (the filters are applied after fetching, so API usage does not change):

| Key             | An issue is in scope when...                         |
| --------------- | ---------------------------------------------------- |
| `labels`        | (when non-empty) it has at least one of these labels |
| `excludeLabels` | it has none of these labels                          |
| `milestones`    | (when non-empty) its milestone title is one of these |

All three must hold. Matching is case-insensitive and exact.

The plan is then: the in-scope issues, **plus all their open prerequisites, transitively**. A prerequisite that is out of scope (filtered out, or in another repository) is included as an **external** node, so the order stays correct: you cannot start an in-scope issue before its prerequisite is done, wherever it lives. Out-of-scope issues that only depend on in-scope ones are dropped.

Example: `scope: { labels: [release-1.0] }` shows the release's issues and, dashed, the unlabelled issues they still wait for.

## 10. Checklist and verification

Before you run against a real repository:

- [ ] Dependencies are declared **natively** and/or as **body lines** on the issue (not in comments), using the syntax of section 4.
- [ ] Body lines start with a keyword (`Depends on`, `Blocked by`, `Requires`, `Dependencies`, `Blocks`, ...) and keep the references on the same line, or use a `## Depends on` (or `## Dependencies`) heading with list items.
- [ ] For native dependencies: the feature exists on your platform version, and on Gitea it is enabled for the repository (and cross-repository dependencies are allowed if you use them).
- [ ] The token is **read-only**, is stored in an environment variable, and can read **every repository** involved, including repositories that are only referenced.
- [ ] Referenced issues are **issues, not pull requests**.
- [ ] You understand that closing an issue (for any reason) releases the issues that wait for it.
- [ ] For GHES, `baseUrl` ends in `/api/v3`; for Gitea, `baseUrl` is the instance root (no `/api/v1`).
- [ ] You have run `execution-view check` and it exits `0` (or you understand each warning).

### Verify with `execution-view check`

`check` loads the configuration, fetches every view (or the views you name), and prints statistics and problems with a hint per warning code.

```sh
node dist/cli/index.js check
```

Add view ids to check only those (`check platform`) and `--json` for machine-readable output. In the Docker image, the entrypoint is already the CLI:

```sh
docker run --rm -e GITHUB_TOKEN -v "$PWD/config.yaml:/app/config.yaml:ro" ghcr.io/brunoorsolon/execution-view:1 check
```

A clean view looks like this (a small fixture of five issues):

```text
✔ mini (mini) · fixture · acme/app
  5 issues · 2 ready · 3 blocked · 0 unschedulable · 0 external · 5 dependencies · 3 waves
```

The demo has problems on purpose (`node dist/cli/index.js -c config.demo.yaml check`):

```text
✖ demo (Acme demo roadmap) · fixture · acme/api, acme/web
  23 issues · 4 ready · 14 blocked · 5 unschedulable · 0 external · 34 dependencies · 7 waves
  ⚠ blocked-by-cycle: 2 issues are blocked by a dependency cycle: acme/api#14, acme/web#7
    hint: these issues wait on an issue that is part of a cycle; resolve the cycle first and they will be scheduled
  ✖ cycle: Dependency cycle: acme/api#11 → acme/api#12 → acme/api#13
    hint: break the cycle by removing one of these dependencies (a `Depends on` / `Blocked by` line in an issue body, or a native dependency in the tracker)
  ✖ dangling-reference: acme/api#10 references acme/api#99, which does not exist or is not accessible
    hint: check the issue number and the repo name in the reference, and that the token can read that repo (a typo, a deleted issue and a missing access right all look the same to the API)
```

("dependencies" in the statistics line counts edges of the graph.) If a view has no edges at all, `check` adds a hint that no dependencies were found.

**Exit codes**

| Code | Meaning                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------- |
| `0`  | Every view fetched, no cycles and no dangling references (other warnings may still be printed with `⚠`) |
| `1`  | Configuration error, unknown view id, or a view could not be fetched (takes precedence over `2`)        |
| `2`  | At least one view has a `cycle` or a `dangling-reference`                                               |

Only cycles and dangling references make the exit code non-zero; `native-unsupported`, `fetch-error` and the other warnings are printed (`⚠`) but exit `0`, so read the output as well as the code in CI.

### Warning codes

| Code                  | Meaning                                                                                                                                                                          | How to fix                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`               | A set of issues depend on each other in a loop; none of them can be ordered. One warning per cycle, lists its issues.                                                            | Remove one relation of the loop (body line or native dependency).                                                                   |
| `blocked-by-cycle`    | Issues downstream of a cycle. They are unschedulable until the cycle is resolved.                                                                                                | Fix the cycle; these follow automatically.                                                                                          |
| `self-reference`      | An issue lists itself as a prerequisite. The relation is ignored.                                                                                                                | Remove the self-reference from the body or native dependencies.                                                                     |
| `dangling-reference`  | A declared relation points at an issue that does not exist, is a pull request, or is not readable by the token. The relation is dropped.                                         | Correct the number or repository; use `owner/repo#N` for other repositories; make sure the token can read that repository.          |
| `external-unresolved` | The 200-lookup cap was hit; some referenced issues outside the view were not resolved and their relations are missing.                                                           | Add the repositories that hold those issues to `repos`, narrow the view with `scope`, or reduce cross-references.                   |
| `native-unsupported`  | The native dependencies (or sub-issues) endpoint answered `404`: GHES without the feature, or Gitea with dependencies disabled. Native relations of that repository are skipped. | Enable dependencies (Gitea repository and instance settings), upgrade GHES, or set `dependencies.native: false` and use body lines. |
| `fetch-error`         | A referenced issue could not be fetched (rate limit, server error, network). It is shown as an open external node `(unavailable)`.                                               | Check the token, the network, the `baseUrl` and the rate limit, then refresh.                                                       |

### Troubleshooting

| Symptom                                                                            | Likely cause                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetch failed: GET https://api.github.com/repos/o/r/issues failed with status 404` | Wrong `owner/repo`, or the token cannot see the repository (private repositories answer `404` instead of `403` **(may vary by version)**). |
| `... failed with status 401`                                                       | Missing, expired or wrong token.                                                                                                           |
| `... rate limit exceeded ...`                                                      | Rate limit exhausted (section 8): raise `cache.ttlSeconds`, use a token, or wait for the reset time in the message.                        |
| `config: environment variable GITHUB_TOKEN is not set; using anonymous access`     | The variable named by `tokenEnv` is empty in the environment of the app. In Docker, pass it with `-e` or `--env-file`.                     |
| No edges (`0 dependencies`) although you declared some                             | Syntax not accepted (section 4), relations in comments, native feature not enabled, or `native`/`body` switched off in the config.         |
| A dependency is missing only for issues in another repository                      | The token cannot read that repository (it shows as `dangling-reference`), or the repository is in another source.                          |
| An issue is unexpectedly "ready"                                                   | Its prerequisite is closed (any reason), or the declaration was dropped as dangling.                                                       |
