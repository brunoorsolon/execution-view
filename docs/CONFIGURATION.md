# Configuration

execution-view is configured with a YAML file, with environment variables only ("env-only mode"), or with a file plus environment overrides. The annotated reference file is [`config.example.yaml`](../config.example.yaml); this page documents every option.

Contents:

- [Where the configuration comes from](#where-the-configuration-comes-from)
- [Config file reference](#config-file-reference)
- [Environment variables](#environment-variables)
- [Validation](#validation)
- [Examples](#examples)

## Where the configuration comes from

The config file path is chosen in this order:

1. `--config <path>` (or `-c <path>`) on the CLI. `serve` accepts it too: `node dist/cli/index.js serve --config /etc/ev/config.yaml`.
2. The `EV_CONFIG` environment variable.
3. `./config.yaml` in the current working directory (in the Docker image: `/app/config.yaml`).

Rules:

- A path given explicitly (1 or 2) **must exist**, otherwise the app stops with `Config file not found: <path>`.
- If the default `./config.yaml` does not exist, the app falls back to **env-only mode** when `EV_PROVIDER` is set, and otherwise fails with `No configuration found: ...`.
- If a config file **is** found, it is used and the env-only variables (`EV_PROVIDER`, `EV_REPOS`, ...) are ignored. Only the [override variables](#overrides-apply-on-top-of-a-config-file-and-in-env-only-mode) still apply.
- `npm start` runs `node dist/server/index.js`, which takes no command-line flags: use `EV_CONFIG` there, or run `node dist/cli/index.js serve --config <path>`.
- The Docker image deliberately does not set `EV_CONFIG`. Mount your file at `/app/config.yaml`, or use env-only mode, or set `EV_CONFIG` yourself (for example `EV_CONFIG=/app/config.demo.yaml` for the demo).
- Relative `path` values of `fixture` sources are resolved against the **directory of the config file**.

## Config file reference

The schema is **strict**: an unknown key is an error, and all errors are reported together. Top level keys: `server`, `cache`, `sources` (required), `views` (required).

### `server`

| Key                            | Type            | Default   | Description                                                                                                                                     |
| ------------------------------ | --------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`                  | string          | `0.0.0.0` | Address to listen on. Overridden by `EV_HOST`.                                                                                                  |
| `server.port`                  | integer 1-65535 | `8080`    | Port to listen on. Overridden by `EV_PORT`.                                                                                                     |
| `server.basicAuth`             | object          | none      | Enables HTTP basic auth for the whole app except `/healthz`. Overridden entirely by `EV_BASIC_AUTH`.                                            |
| `server.basicAuth.username`    | string          | required  | The user name (required when `basicAuth` is present).                                                                                           |
| `server.basicAuth.passwordEnv` | string          | none      | Name of the environment variable that holds the password (recommended). Wins over `password` when the variable is set and not blank.            |
| `server.basicAuth.password`    | string          | none      | Inline password (discouraged). Used when `passwordEnv` is absent or its variable is unset. One of the two is required, otherwise startup fails. |

### `cache`

| Key                | Type               | Default | Description                                                                                                                     |
| ------------------ | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cache.ttlSeconds` | integer, 0 or more | `300`   | How long a view's snapshot is served from memory. `0` disables caching (every request refetches). Overridden by `EV_CACHE_TTL`. |

### `sources`

A list (at least one) of places where issues come from.

| Key                  | Type                            | Default                                                         | Description                                                                                                                                                                                   |
| -------------------- | ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources[].id`       | string, `^[a-z0-9][a-z0-9-_]*$` | required                                                        | Unique identifier, referenced by `views[].source`.                                                                                                                                            |
| `sources[].kind`     | `github`, `gitea` or `fixture`  | required                                                        | The provider. Forgejo should work with `gitea` but is untested.                                                                                                                               |
| `sources[].baseUrl`  | URL (`http://` or `https://`)   | `https://api.github.com` for `github`; **required** for `gitea` | API root. GitHub Enterprise Server: `https://<host>/api/v3`. Gitea: the instance root; the API is at `<baseUrl>/api/v1`. Trailing slashes are removed. Ignored for `fixture`.                 |
| `sources[].webUrl`   | URL                             | derived (see below)                                             | Browser root, used to recognise full issue URLs in issue bodies (only URLs on this host are references). Trailing slashes are removed.                                                        |
| `sources[].tokenEnv` | string                          | none                                                            | Name of the environment variable that holds the API token (recommended). A variable that is unset or blank is **not an error**: a warning is printed and the next fallback is used.           |
| `sources[].token`    | string                          | none                                                            | Inline token (discouraged: do not commit it). Used when `tokenEnv` is absent or its variable is unset. With no token at all, access is anonymous (public repositories only, low rate limits). |
| `sources[].path`     | string                          | required for `fixture`                                          | Fixture JSON file, relative to the config file's directory.                                                                                                                                   |

Derived `webUrl`: for `github`, `https://github.com` when `baseUrl` is `https://api.github.com`, otherwise `baseUrl` without a trailing `/api/v3`; for `gitea`, `baseUrl`; for `fixture`, none (issue URLs default to `https://fixture.local/...`, and URLs in bodies are only recognised if you set `webUrl` explicitly, as `config.demo.yaml` does).

### `views`

A list (at least one). A view is a set of repositories of one source that are planned together: one graph, one order.

| Key                                       | Type                            | Default                                            | Description                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `views[].id`                              | string, `^[a-z0-9][a-z0-9-_]*$` | required                                           | Unique identifier; used in URLs (`/api/views/<id>/...`) and CLI arguments.                                                                                                                                                                     |
| `views[].title`                           | string (not empty)              | the `id`                                           | Display title.                                                                                                                                                                                                                                 |
| `views[].source`                          | string                          | required                                           | The `id` of one of the `sources`.                                                                                                                                                                                                              |
| `views[].repos`                           | list of `owner/repo`            | required (at least one)                            | Repositories to read (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`). Lowercased, deduplicated and sorted.                                                                                                                                               |
| `views[].dependencies.native`             | boolean                         | `true`                                             | Use the platform's native relations (GitHub issue dependencies, Gitea dependencies).                                                                                                                                                           |
| `views[].dependencies.body`               | boolean                         | `true`                                             | Parse dependency lines in issue bodies.                                                                                                                                                                                                        |
| `views[].dependencies.subIssues`          | boolean                         | `false`                                            | GitHub only: a parent issue is blocked by each of its sub-issues. On other sources it is ignored, with a config warning. Independent of `native`.                                                                                              |
| `views[].dependencies.keywords.blockedBy` | list of strings                 | `[depends on, blocked by, requires, dependencies]` | Keywords meaning "this issue is blocked by ...". Replaces the default list. Case-insensitive, whitespace-flexible.                                                                                                                             |
| `views[].dependencies.keywords.blocks`    | list of strings                 | `[blocks, blocking, required by]`                  | Keywords meaning "this issue blocks ...". Replaces the default list. `[]` disables this direction.                                                                                                                                             |
| `views[].scope.labels`                    | list of strings                 | `[]`                                               | When non-empty, only issues with at least one of these labels are in scope.                                                                                                                                                                    |
| `views[].scope.excludeLabels`             | list of strings                 | `[]`                                               | Issues with any of these labels are out of scope.                                                                                                                                                                                              |
| `views[].scope.milestones`                | list of strings                 | `[]`                                               | When non-empty, only issues in one of these milestones (by title) are in scope.                                                                                                                                                                |
| `views[].ordering.priorityLabels`         | list of strings                 | `[]`                                               | Labels from highest to lowest priority, for example `[P0, P1, P2]`. Breaks ties in the linear order; it never lets an issue jump ahead of its prerequisites. Case-insensitive.                                                                 |
| `views[].ordering.mode`                   | `priority` or `waves`           | `priority`                                         | How the linear order (the `#` numbers) is built. `priority`: by priority, then critical path, which can number an issue of a later wave before one of an earlier wave. `waves`: wave by wave, and within a wave by priority and critical path. |

Scope filters combine with AND, are case-insensitive, and only choose the roots of the plan: out-of-scope prerequisites still appear, as external nodes. See [PREREQUISITES.md](PREREQUISITES.md#9-scope-filters). Keyword semantics are in [PREREQUISITES.md](PREREQUISITES.md#custom-keywords). The exact ordering rules for `priorityLabels` and `mode`, with a worked example, are in [DETERMINISM.md](DETERMINISM.md).

## Environment variables

Empty or blank values are treated as unset.

### Overrides (apply on top of a config file, and in env-only mode)

| Variable        | Effect                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `EV_HOST`       | Overrides `server.host`.                                                                                               |
| `EV_PORT`       | Overrides `server.port` (integer 1-65535, otherwise startup fails).                                                    |
| `EV_CACHE_TTL`  | Overrides `cache.ttlSeconds` (integer of 0 or more).                                                                   |
| `EV_BASIC_AUTH` | `user:password`. Overrides the whole `server.basicAuth` block. Split at the first colon; both parts must be non-empty. |
| `EV_CONFIG`     | Path of the config file (see the lookup order above).                                                                  |
| `NO_COLOR`      | When set, the CLI prints no ANSI colours (colours are only used on a terminal anyway).                                 |

Docker image defaults: `EV_HOST=0.0.0.0`, `EV_PORT=8080`.

### Env-only mode

Used when no config file is found and `EV_PROVIDER` is set. It builds one source (`id: default`) and one view (`id: default` unless `EV_VIEW_ID` is set) with all other options at their defaults.

| Variable             | Required    | Description                                                                                                                                      |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EV_PROVIDER`        | yes         | `github` or `gitea`.                                                                                                                             |
| `EV_REPOS`           | yes         | Comma-separated `owner/repo` list.                                                                                                               |
| `EV_BASE_URL`        | for `gitea` | API root for GitHub Enterprise Server (`https://<host>/api/v3`) or the instance root for Gitea. Defaults to `https://api.github.com` for GitHub. |
| `EV_TOKEN`           | no          | The token. Falls back to `GITHUB_TOKEN` (for `github`) or `GITEA_TOKEN` (for `gitea`).                                                           |
| `EV_VIEW_ID`         | no          | View id (default `default`; must match the id pattern).                                                                                          |
| `EV_VIEW_TITLE`      | no          | View title (default: the id).                                                                                                                    |
| `EV_PRIORITY_LABELS` | no          | Comma-separated priority labels, highest first.                                                                                                  |
| `EV_SUB_ISSUES`      | no          | `true` or `false`: sets `dependencies.subIssues`.                                                                                                |
| `EV_ORDERING_MODE`   | no          | `priority` (default) or `waves`: sets `ordering.mode`. Anything else is a configuration error.                                                   |

Env-only mode cannot express: several views or sources, scope filters, custom keywords, `native: false`, `body: false`, a `webUrl`. Use a config file for those.

## Validation

Startup (and every CLI command) validates the whole file and prints all problems at once, then exits with code 1. Example (a file with a typo, a bad repo and a wrong key):

```text
/path/to/bad.yaml: Invalid configuration:
  - sources[0]: Unrecognized key(s) in object: 'colour'
  - views[0].repos[0]: invalid repo "acme" (expected owner/repo)
  - views[0].dependencies: Unrecognized key(s) in object: 'subIssue'
```

Other checks: duplicate source ids, duplicate view ids, a view whose `source` does not exist, `gitea` without `baseUrl`, `fixture` without `path`, ids and URLs that do not match their patterns, and a basic-auth block without a usable password.

Non-fatal problems are printed as `warning: ...` (and by `check` as `config: ...`):

```text
warning: source "gt": environment variable NOPE_TOKEN is not set; using anonymous access
warning: view "v": subIssues is only supported by github sources; it is ignored
```

## Examples

### GitHub, single repository

```yaml
sources:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN

views:
  - id: app
    source: gh
    repos: [acme/app]
```

Run with `GITHUB_TOKEN` set in the environment.

### GitHub, several repositories, priority labels and a scope

```yaml
server:
  port: 8080

cache:
  ttlSeconds: 600

sources:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN

views:
  - id: platform
    title: Platform 1.0
    source: gh
    repos: [acme/api, acme/web, acme/infra]
    dependencies:
      subIssues: false
      keywords:
        blockedBy: [depends on, blocked by, requires, needs]
    scope:
      labels: [release-1.0]
      excludeLabels: [wontfix, icebox]
      milestones: []
    ordering:
      priorityLabels: [P0, P1, P2]
```

Issues that are not labelled `release-1.0` still show up, dashed as external, when a `release-1.0` issue depends on them.

### GitHub Enterprise Server

```yaml
sources:
  - id: ghes
    kind: github
    baseUrl: https://ghe.example.com/api/v3
    tokenEnv: GHES_TOKEN

views:
  - id: internal
    source: ghes
    repos: [platform/core]
    dependencies:
      native: false # skip native dependencies on GHES versions without them; use body lines
```

`webUrl` is derived as `https://ghe.example.com`. Full issue URLs on that host are accepted in issue bodies. Without `native: false`, a GHES version without issue dependencies still works: you get a `native-unsupported` warning per repository.

### Gitea

```yaml
sources:
  - id: gt
    kind: gitea
    baseUrl: https://gitea.example.com
    tokenEnv: GITEA_TOKEN

views:
  - id: team
    title: Team backlog
    source: gt
    repos: [team/app, team/lib]
    ordering:
      priorityLabels: [priority/high, priority/medium]
```

### Basic auth

```yaml
server:
  basicAuth:
    username: admin
    passwordEnv: EV_BASIC_AUTH_PASSWORD

sources:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN

views:
  - id: app
    source: gh
    repos: [acme/app]
```

Or, without a file: `EV_BASIC_AUTH=admin:change-me`. Use TLS in front of the app: see [DEPLOYMENT.md](DEPLOYMENT.md#basic-auth).

### Env-only, GitHub

```sh
EV_PROVIDER=github
EV_REPOS=acme/api,acme/web
GITHUB_TOKEN=ghp_your_token_here
EV_PRIORITY_LABELS=P0,P1,P2
```

(For example in a `.env` file used with docker-compose.) No config file is needed.

### Env-only, Gitea

```sh
EV_PROVIDER=gitea
EV_BASE_URL=https://gitea.example.com
EV_REPOS=team/app
GITEA_TOKEN=your_token_here
```

### Fixture / demo

```yaml
sources:
  - id: demo
    kind: fixture
    path: ./test/fixtures/demo.json
    webUrl: https://fixture.local

views:
  - id: demo
    title: Acme demo roadmap
    source: demo
    repos: [acme/api, acme/web]
    ordering:
      priorityLabels: [P0, P1, P2]
```

This is [`config.demo.yaml`](../config.demo.yaml). The fixture format is `{ "issues": [ ... ] }` with `owner`, `repo`, `number`, `title`, `state`, and optional `body`, `labels`, `assignees`, `milestone` and `blockedBy` (native relations, as `owner/repo#N` keys). See [`test/fixtures/README.md`](../test/fixtures/README.md) for the demo dataset and its expected results.
