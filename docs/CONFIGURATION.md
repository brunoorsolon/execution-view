# Configuration

Forge Desk is configured with a YAML file, with environment variables only ("env-only mode"), or with a file plus environment overrides. The annotated reference file is [`config.example.yaml`](../config.example.yaml); this page documents every option.

Contents:

- [Where the configuration comes from](#where-the-configuration-comes-from)
- [Config file reference](#config-file-reference)
- [Environment variables](#environment-variables)
- [Validation](#validation)
- [Examples](#examples)

## Where the configuration comes from

The config file path is chosen in this order:

1. `--config <path>` (or `-c <path>`) on the CLI. `serve` accepts it too: `node dist/cli/index.js serve --config /etc/ev/config.yaml`.
2. The `FD_CONFIG` environment variable.
3. `./config.yaml` in the current working directory (in the Docker image: `/app/config.yaml`).

Rules:

- A path given explicitly (1 or 2) **must exist**, otherwise the app stops with `Config file not found: <path>`.
- If the default `./config.yaml` does not exist, the app falls back to **env-only mode** when `FD_PROVIDER` is set, and otherwise fails with `No configuration found: ...`.
- If a config file **is** found, it is used and the env-only variables (`FD_PROVIDER`, `FD_REPOS`, ...) are ignored. Only the [override variables](#overrides-apply-on-top-of-a-config-file-and-in-env-only-mode) still apply.
- `npm start` runs `node dist/server/index.js`, which takes no command-line flags: use `FD_CONFIG` there, or run `node dist/cli/index.js serve --config <path>`.
- The Docker image deliberately does not set `FD_CONFIG`. Mount your file at `/app/config.yaml`, or use env-only mode, or set `FD_CONFIG` yourself (for example `FD_CONFIG=/app/config.demo.yaml` for the demo).
- Relative `path` values of `fixture` sources are resolved against the **directory of the config file**.

## Config file reference

The schema is **strict**: an unknown key is an error, and all errors are reported together. Top level keys: `server`, `cache`, `ui`, `webhooks`, `releases`, `sources` (required), `views` (required).

### `server`

| Key                            | Type            | Default   | Description                                                                                                                                     |
| ------------------------------ | --------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`                  | string          | `0.0.0.0` | Address to listen on. Overridden by `FD_HOST`.                                                                                                  |
| `server.port`                  | integer 1-65535 | `8080`    | Port to listen on. Overridden by `FD_PORT`.                                                                                                     |
| `server.basicAuth`             | object          | none      | Enables the login (login page and HTTP basic auth) for the whole app except `/healthz`. Overridden entirely by `FD_BASIC_AUTH`.                 |
| `server.basicAuth.username`    | string          | required  | The user name (required when `basicAuth` is present).                                                                                           |
| `server.basicAuth.passwordEnv` | string          | none      | Name of the environment variable that holds the password (recommended). Wins over `password` when the variable is set and not blank.            |
| `server.basicAuth.password`    | string          | none      | Inline password (discouraged). Used when `passwordEnv` is absent or its variable is unset. One of the two is required, otherwise startup fails. |

### `cache`

| Key                | Type               | Default | Description                                                                                                                     |
| ------------------ | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cache.ttlSeconds` | integer, 0 or more | `300`   | How long a view's snapshot is served from memory. `0` disables caching (every request refetches). Overridden by `FD_CACHE_TTL`. |

### `ui`

| Key                 | Type            | Default | Description                                                                                                                                                                                                                                                   |
| ------------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.refreshMinutes` | integer, 0-1440 | `5`     | How often the web UI refreshes the view it shows, like a click on Refresh. Switching back to a view already shown in the tab displays it as it was, without a fetch. `0` turns the timer off: only Refresh fetches again. Overridden by `FD_REFRESH_MINUTES`. |

### `webhooks`

Optional. Enables the webhook endpoints (`POST /api/webhooks/github` and `POST /api/webhooks/gitea`), which drop the cached snapshot of the views of a repository when the tracker reports an issue event. Without a secret the endpoints do not exist (`404`). Setup steps: [DEPLOYMENT.md](DEPLOYMENT.md#webhooks).

| Key                  | Type   | Default | Description                                                                                                                                                                                       |
| -------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks.secretEnv` | string | none    | Name of the environment variable that holds the shared secret (recommended). Wins over `secret` when the variable is set and not blank. A variable that is not set gives a warning, not an error. |
| `webhooks.secret`    | string | none    | Inline secret (discouraged). Used when `secretEnv` is absent or its variable is unset.                                                                                                            |

When neither yields a secret, startup prints a warning and webhooks stay disabled. `FD_WEBHOOK_SECRET` overrides the whole block (and also works without a config file).

### `sources`

A list (at least one) of places where issues come from.

| Key                  | Type                            | Default                                                         | Description                                                                                                                                                                                   |
| -------------------- | ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources[].id`       | string, `^[a-z0-9][a-z0-9-_]*$` | required                                                        | Unique identifier, referenced by `views[].source`.                                                                                                                                            |
| `sources[].kind`     | `github`, `gitea` or `fixture`  | required                                                        | The provider. Forgejo works with `gitea` (tested in CI against Forgejo 11 and Gitea 1.25).                                                                                                    |
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
| `views[].dependencies.body`               | `boolean` or `"strict"`         | `true`                                             | Parse dependency lines in issue bodies. `true`: keyword lines, sections and relation lines. `"strict"`: relation lines only. `false`: none. See [PREREQUISITES.md](PREREQUISITES.md).                                                          |
| `views[].dependencies.subIssues`          | boolean                         | `false`                                            | GitHub only: a parent issue is blocked by each of its sub-issues. On other sources it is ignored, with a config warning. Independent of `native`.                                                                                              |
| `views[].dependencies.keywords.blockedBy` | list of strings                 | `[depends on, blocked by, requires, dependencies]` | Keywords meaning "this issue is blocked by ...". Replaces the default list. Case-insensitive, whitespace-flexible.                                                                                                                             |
| `views[].dependencies.keywords.blocks`    | list of strings                 | `[blocks, blocking, required by]`                  | Keywords meaning "this issue blocks ...". Replaces the default list. `[]` disables this direction.                                                                                                                                             |
| `views[].scope.labels`                    | list of strings                 | `[]`                                               | When non-empty, only issues with at least one of these labels are in scope.                                                                                                                                                                    |
| `views[].scope.excludeLabels`             | list of strings                 | `[]`                                               | Issues with any of these labels are out of scope.                                                                                                                                                                                              |
| `views[].scope.milestones`                | list of strings                 | `[]`                                               | When non-empty, only issues in one of these milestones (by title) are in scope.                                                                                                                                                                |
| `views[].ordering.priorityLabels`         | list of strings                 | `[]`                                               | Labels from highest to lowest priority, for example `[P0, P1, P2]`. Breaks ties in the linear order; it never lets an issue jump ahead of its prerequisites. Case-insensitive.                                                                 |
| `views[].ordering.mode`                   | `priority` or `waves`           | `priority`                                         | How the linear order (the `#` numbers) is built. `priority`: by priority, then critical path, which can number an issue of a later wave before one of an earlier wave. `waves`: wave by wave, and within a wave by priority and critical path. |

Scope filters combine with AND, are case-insensitive, and only choose the roots of the plan: out-of-scope prerequisites still appear, as external nodes. See [PREREQUISITES.md](PREREQUISITES.md#9-scope-filters). Keyword semantics are in [PREREQUISITES.md](PREREQUISITES.md#custom-keywords). The exact ordering rules for `priorityLabels` and `mode`, with a worked example, are in [DETERMINISM.md](DETERMINISM.md).

### `releases`

Optional and disabled by default. Planning-only YAML and env-only mode need no release configuration, credentials or writable state; they keep their existing behavior. Enabling releases adds release publication to the same server and requires the application login (`server.basicAuth` or `FD_BASIC_AUTH`). Volume setup, forge permissions, SSH trust, recovery, backup and the legacy cutover are in [RELEASES.md](RELEASES.md).

```yaml
releases:
  enabled: true
  publicOrigin: https://forge-desk.example.com
  stateDir: /var/lib/forge-desk
  repositories:
    - id: app
      source: gt # an existing gitea source
      repo: example/app
      origin: ssh://git@gitea.example.com/example/app.git
      apiTokenFile: /run/secrets/forge_desk_release_token
      expectedApiUser: release-bot
      ci:
        workflowPath: .gitea/workflows/validate.yaml
      ssh:
        privateKeyFile: /run/secrets/forge_desk_release_key
        knownHostsFile: /run/secrets/forge_desk_known_hosts
      tagger:
        name: Forge Desk Release Bot
        email: releases@example.com
```

| Key                                          | Type                      | Default  | Description                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases.enabled`                           | boolean                   | `false`  | Turns release publication on. The remaining fields are only required when enabled.                                                                                                                                |
| `releases.publicOrigin`                      | URL origin                | required | The operator-approved external origin used to validate browser requests. HTTPS only, without a path, query or fragment; plain HTTP is accepted only for a loopback test deployment (`localhost`, `127.x`, `::1`). |
| `releases.stateDir`                          | absolute path             | required | Private release state directory. Must exist as a real directory (not a symlink), be owned by the runtime user, and be `0700`.                                                                                     |
| `releases.repositories`                      | list (at least one)       | required | The explicit release allowlist. Repository ids are unique; each entry references an existing `gitea` source and an explicit `owner/repo`. Browser input can only use these ids, never arbitrary URLs or paths.    |
| `releases.repositories[].origin`             | `ssh://` URL              | required | Push origin for tags. Must be `ssh://user@host[:port]/owner/repo[.git]` with no password, query, fragment or option-bearing parts, and its path must match `repo`.                                                |
| `releases.repositories[].apiTokenFile`       | absolute path             | one of   | A read-only file holding the dedicated release API token. Exactly one of `apiTokenFile` or `apiTokenEnv` is required; inline tokens are rejected.                                                                 |
| `releases.repositories[].apiTokenEnv`        | environment variable name | one of   | The variable holding the dedicated release API token. Exactly one of the two selectors is required, and the value must not be a planning source token.                                                            |
| `releases.repositories[].expectedApiUser`    | string                    | required | The API account the release token must belong to. Prevents silently adopting whatever account a supplied token happens to use.                                                                                    |
| `releases.repositories[].ci.workflowPath`    | relative path             | required | The designated successful push workflow, for example `.gitea/workflows/validate.yaml`. Must be a relative `.yml`/`.yaml` path inside the repository.                                                              |
| `releases.repositories[].ssh.privateKeyFile` | absolute path             | required | Dedicated SSH private key. Must be readable and owned by the runtime user, and not readable by group or others (`0600`).                                                                                          |
| `releases.repositories[].ssh.knownHostsFile` | absolute path             | required | Trusted host keys for the SSH origin. Must be readable by the runtime user and not writable by group or others (`0600` or `0644`).                                                                                |
| `releases.repositories[].tagger.name`        | string                    | required | Name on the annotated tag object.                                                                                                                                                                                 |
| `releases.repositories[].tagger.email`       | email                     | required | Email on the annotated tag object.                                                                                                                                                                                |

Only Gitea sources can be release repositories; the initial publication target is Gitea 1.26.1, and the release client verifies the server identity before trusting remote observations. Forgejo and other server versions are unsupported until their publication behavior is verified. The final image carries real `git`, `ssh` and `flock`, and the state directory must be a private local volume; see [RELEASES.md](RELEASES.md#image-and-runtime).

Enabled startup validates these local prerequisites before the server listens: the state directory's ownership and privacy, each secret file's readability, and the SSH key permission rules. A violation stops startup with a diagnostic naming the path and permissions, and the mounted permissions are never changed. The checks make no forge request, so a temporary forge outage cannot keep Planning from starting.

Enabled startup then claims release execution for that state directory through an OS-backed exclusive lock on `owner.lock` (created `0600`), using `flock` from util-linux or BusyBox on `PATH`. Exactly one application process can own a release state directory, so a second process pointed at the same directory refuses to start with a diagnostic naming it, and killing an owner releases the lock with the process. While release work is running the owner also holds `work.lock`, so a replacement owner is refused until that work ends even if the ownership helper itself died; the refusal names the directory and never starts work beside the previous owner. Shared and network filesystems (NFS, CIFS/SMB, Ceph, 9p, FUSE including virtiofs and host-shared mounts) and multi-replica deployments are unsupported and are refused rather than claimed. Within the owner, release work for one forge-qualified repository runs one operation at a time while different repositories proceed independently. `SIGTERM` stops admitting new release work, waits up to five seconds for accepted work, and then releases the locks; work that outlives that bound keeps both locks until it ends and is released then, and if it never ends the container's stop grace terminates the process. Reaching that forced-termination path leaves the durable intent as the record the next start reconciles, and the logs report the work that was still running. Planning-only mode takes no lock and needs none of this.

## Environment variables

Empty or blank values are treated as unset.

Before 3.0.1 these variables started with `EV_` instead of `FD_`. An `EV_` name still works until the next major release and still wins over its `FD_` counterpart, so an existing deployment keeps its behavior; startup prints a warning for each one, naming the `FD_` name to rename it to. Rename the variable in `.env` and in the compose file's `environment:` lines together, because Compose passes the container only the names listed there. Variable names you chose yourself in `tokenEnv`, `passwordEnv` or `secretEnv` are read as written.

### Overrides (apply on top of a config file, and in env-only mode)

| Variable             | Effect                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `FD_HOST`            | Overrides `server.host`.                                                                                               |
| `FD_PORT`            | Overrides `server.port` (integer 1-65535, otherwise startup fails).                                                    |
| `FD_CACHE_TTL`       | Overrides `cache.ttlSeconds` (integer of 0 or more).                                                                   |
| `FD_REFRESH_MINUTES` | Overrides `ui.refreshMinutes` (integer 0-1440).                                                                        |
| `FD_BASIC_AUTH`      | `user:password`. Overrides the whole `server.basicAuth` block. Split at the first colon; both parts must be non-empty. |
| `FD_WEBHOOK_SECRET`  | The webhook secret. Overrides the whole `webhooks` block and enables the webhook endpoints (also in env-only mode).    |
| `FD_CONFIG`          | Path of the config file (see the lookup order above).                                                                  |
| `NO_COLOR`           | When set, the CLI prints no ANSI colours (colours are only used on a terminal anyway).                                 |

Docker image defaults: `FD_HOST=0.0.0.0`, `FD_PORT=8080`.

### Env-only mode

Used when no config file is found and `FD_PROVIDER` is set. It builds one source (`id: default`) and one view (`id: default` unless `FD_VIEW_ID` is set) with all other options at their defaults.

| Variable             | Required    | Description                                                                                                                                      |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FD_PROVIDER`        | yes         | `github` or `gitea`.                                                                                                                             |
| `FD_REPOS`           | yes         | Comma-separated `owner/repo` list.                                                                                                               |
| `FD_BASE_URL`        | for `gitea` | API root for GitHub Enterprise Server (`https://<host>/api/v3`) or the instance root for Gitea. Defaults to `https://api.github.com` for GitHub. |
| `FD_TOKEN`           | no          | The token. Falls back to `GITHUB_TOKEN` (for `github`) or `GITEA_TOKEN` (for `gitea`).                                                           |
| `FD_VIEW_ID`         | no          | View id (default `default`; must match the id pattern).                                                                                          |
| `FD_VIEW_TITLE`      | no          | View title (default: the id).                                                                                                                    |
| `FD_PRIORITY_LABELS` | no          | Comma-separated priority labels, highest first.                                                                                                  |
| `FD_SUB_ISSUES`      | no          | `true` or `false`: sets `dependencies.subIssues`.                                                                                                |
| `FD_ORDERING_MODE`   | no          | `priority` (default) or `waves`: sets `ordering.mode`. Anything else is a configuration error.                                                   |

Env-only mode cannot express: several views or sources, scope filters, custom keywords, `native: false`, `body: false` or `body: strict`, a `webUrl`. Use a config file for those.

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
    repos:
      - acme/app
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
    repos:
      - acme/api
      - acme/web
      - acme/infra
    dependencies:
      subIssues: false
      body: strict # keep agent prose out of the graph; relation lines only
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
    repos:
      - platform/core
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
    repos:
      - team/app
      - team/lib
    ordering:
      priorityLabels: [priority/high, priority/medium]
```

### Login

```yaml
server:
  basicAuth:
    username: admin
    passwordEnv: FD_BASIC_AUTH_PASSWORD

sources:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN

views:
  - id: app
    source: gh
    repos:
      - acme/app
```

Or, without a file: `FD_BASIC_AUTH=admin:change-me`. Use TLS in front of the app: see [DEPLOYMENT.md](DEPLOYMENT.md#login).

### Webhooks

```yaml
webhooks:
  secretEnv: FD_WEBHOOK_SECRET

sources:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN

views:
  - id: app
    source: gh
    repos:
      - acme/app
```

Or, without a file: `FD_WEBHOOK_SECRET=<a long random string>`. See [DEPLOYMENT.md](DEPLOYMENT.md#webhooks) for the tracker side.

### Env-only, GitHub

```sh
FD_PROVIDER=github
FD_REPOS=acme/api,acme/web
GITHUB_TOKEN=ghp_your_token_here
FD_PRIORITY_LABELS=P0,P1,P2
```

(For example in the `environment:` block of `docker-compose.yml`, with the token written as `GITHUB_TOKEN=${GITHUB_TOKEN}` and its value in `.env`.) No config file is needed.

### Env-only, Gitea

```sh
FD_PROVIDER=gitea
FD_BASE_URL=https://gitea.example.com
FD_REPOS=team/app
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
    repos:
      - acme/api
      - acme/web
    ordering:
      priorityLabels: [P0, P1, P2]
```

This is [`config.demo.yaml`](../config.demo.yaml). The fixture format is `{ "issues": [ ... ] }` with `owner`, `repo`, `number`, `title`, `state`, and optional `body`, `labels`, `assignees`, `milestone`, `updatedAt` (an ISO 8601 timestamp) and `blockedBy` (native relations, as `owner/repo#N` keys). See [`test/fixtures/README.md`](../test/fixtures/README.md) for the demo dataset and its expected results.
