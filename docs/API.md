# HTTP API

The server (`execution-view serve`, or `npm start`) exposes a small JSON API next to the web UI (read-only, apart from the optional webhook receivers). All paths are at the root (there is no base-path option). The examples assume a local server on port 8080 started with the demo config:

```sh
EV_CONFIG=config.demo.yaml npm start
```

Contents:

- [Endpoints](#endpoints)
- [Common behaviour](#common-behaviour)
- [Authentication](#authentication)
- [Snapshot schema](#snapshot-schema)
- [Examples](#examples)

## Endpoints

| Method | Path                            | Description                                                             | Success                               |
| ------ | ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/healthz`                      | Liveness check. **No authentication.**                                  | `200` `{"status":"ok"}`               |
| GET    | `/api/views`                    | The configured views                                                    | `200` array of view summaries         |
| GET    | `/api/settings`                 | Settings for the web UI and the running version                         | `200` `{"refreshMinutes":5,...}`      |
| GET    | `/api/views/:id/snapshot`       | The plan and layout of a view                                           | `200` snapshot with `ETag`, or `304`  |
| POST   | `/api/views/:id/refresh`        | Force a refetch from the tracker, ignoring the cache                    | `200` snapshot with `ETag`            |
| GET    | `/api/views/:id/export.:format` | The snapshot rendered as a file: `json`, `md`, `mmd` (Mermaid) or `dot` | `200` text with `Content-Disposition` |
| POST   | `/api/webhooks/github`          | Webhook receiver for GitHub issue events (only with a secret)           | `202` `{"invalidated":[...]}`         |
| POST   | `/api/webhooks/gitea`           | Webhook receiver for Gitea / Forgejo issue events (only with a secret)  | `202` `{"invalidated":[...]}`         |
| GET    | `/api/session`                  | The signed-in user (only with a login configured)                       | `200` `{"username":"admin"}`          |
| GET    | `/login`                        | The login page (only with a login configured). **No authentication.**   | `200` HTML                            |
| POST   | `/login`                        | Form login: `username` and `password`, form-encoded                     | `303` to the UI, with session cookie  |
| POST   | `/logout`                       | Ends the session and clears the cookie                                  | `303` to the login page               |
| GET    | `/` and other paths             | The web UI (static files)                                               | `200` HTML/JS/CSS                     |

### `GET /api/views`

Returns one summary per configured view:

```json
[
  {
    "id": "demo",
    "title": "Acme demo roadmap",
    "source": "demo",
    "kind": "fixture",
    "repos": ["acme/api", "acme/web"]
  }
]
```

`kind` is the provider kind of the view's source (`github`, `gitea` or `fixture`).

### `GET /api/settings`

Returns the settings the web UI reads at startup:

```json
{ "refreshMinutes": 5, "version": "2.0.1" }
```

`refreshMinutes` is `ui.refreshMinutes` (or `EV_REFRESH_MINUTES`): the UI calls `POST /api/views/:id/refresh` for the view it shows at that interval. `0` means no automatic refresh.

`version` is the running server's version. The theme menu shows it at the bottom.

### `GET /api/views/:id/snapshot`

| Parameter       | Where  | Description                                                                                                                                      |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | path   | The view id.                                                                                                                                     |
| `refresh`       | query  | `1` or `true` bypasses the cache and refetches (concurrent refreshes of a view share one fetch). Any other value is ignored.                     |
| `If-None-Match` | header | An earlier `ETag`. When it matches the current content hash, the server answers `304` with no body. (`*` and weak `W/"..."` forms are accepted.) |

Response headers: `ETag: "<contentHash>"`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`. The `ETag` is the snapshot's [content hash](DETERMINISM.md#the-content-hash): it changes when the plan or layout changes, and **not** when only `fetchedAt` changes, so a refresh that finds nothing new still answers `304` to a client that sends the last `ETag`.

### `POST /api/views/:id/refresh`

Same response as the snapshot endpoint (always `200` with a body, `ETag` header), after forcing a refetch. Send no body.

### `GET /api/views/:id/export.:format`

| `:format` | Content-Type                       | `Content-Disposition`              | Content                                                                          |
| --------- | ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `json`    | `application/json; charset=utf-8`  | `inline; filename="<viewId>.json"` | The full snapshot, indented, ending in a newline                                 |
| `md`      | `text/markdown; charset=utf-8`     | `inline; filename="<viewId>.md"`   | Waves as tables (with a Priority column), unschedulable issues, cycles, warnings |
| `mmd`     | `text/plain; charset=utf-8`        | `inline; filename="<viewId>.mmd"`  | A Mermaid `flowchart LR`                                                         |
| `dot`     | `text/vnd.graphviz; charset=utf-8` | `inline; filename="<viewId>.dot"`  | A Graphviz `digraph`, one `rank=same` group per wave                             |

`?refresh=1` works here too. Exports have no `ETag`. Any other extension answers `404`. The CLI produces the same text: `execution-view plan <viewId> -f md|json|mermaid|dot`.

### `POST /api/webhooks/github` and `POST /api/webhooks/gitea`

Receivers for the tracker's webhooks: a verified delivery drops the cached snapshot of every view whose repositories include the repository named in the payload, so the next request refetches. They exist only when a webhook secret is configured (`webhooks` in the config, or `EV_WEBHOOK_SECRET`); otherwise they answer `404` like any unknown path. Setup: [DEPLOYMENT.md](DEPLOYMENT.md#webhooks).

- **Authentication** is the signature, not basic auth: these two `POST` paths (and nothing else) are exempt from basic auth. The signature is the HMAC-SHA256 of the raw request body, keyed with the secret, compared in constant time.
  - `/api/webhooks/github`: header `X-Hub-Signature-256: sha256=<hex>`.
  - `/api/webhooks/gitea`: header `X-Gitea-Signature: <hex>` or `X-Forgejo-Signature: <hex>` (plain hex, no prefix), or `X-Hub-Signature-256: sha256=<hex>` (Gitea and Forgejo send that one too). One valid signature is enough.
- **Body:** JSON only (`Content-Type: application/json`); other content types answer `415`. The limit is 1 MiB (`413` above it). Configure GitHub webhooks with content type `application/json`, not `application/x-www-form-urlencoded`.
- **Events:** a `ping` (`X-GitHub-Event`, `X-Gitea-Event` or `X-Forgejo-Event` equal to `ping`) answers `200` `{"ok":true}` and invalidates nothing. Any other event reads `repository.full_name` (compared in lower case), invalidates the matching views and answers `202` `{"invalidated":["<viewId>", ...]}` with the ids sorted. An unknown repository, or a payload without `repository.full_name`, answers `202` `{"invalidated":[]}`. The event type is not otherwise inspected, so subscribe only to the issue events you need.

| Status | When                                           | Body                            |
| ------ | ---------------------------------------------- | ------------------------------- |
| `200`  | Verified `ping`                                | `{"ok":true}`                   |
| `202`  | Verified delivery                              | `{"invalidated":["demo"]}`      |
| `400`  | Verified delivery whose body is not valid JSON | `{"error":"Invalid JSON body"}` |
| `401`  | Signature missing, malformed or wrong          | `{"error":"Invalid signature"}` |
| `404`  | No webhook secret is configured                | `{"error":"Not found"}`         |
| `413`  | Body larger than 1 MiB                         | `{"error":"<message>"}`         |
| `415`  | Content type other than `application/json`     | `{"error":"<message>"}`         |

```sh
BODY='{"action":"opened","repository":{"full_name":"acme/api"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$EV_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST http://localhost:8080/api/webhooks/github \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: sha256=$SIG" \
  --data "$BODY"
```

Each accepted delivery is logged at info level (event, repository, invalidated views); the secret and the signature are never logged.

### Static UI

Everything else is served from the built web UI directory (`dist/web`). A `GET` for an unknown path that does not start with `/api/` and that accepts `text/html` falls back to `index.html` (single-page app); other unknown paths answer `404` `{"error":"Not found"}`. If the web UI has not been built, `/` shows a short "The web UI is not built" page and the API still works.

## Common behaviour

| Status | When                                                                                                              | Body                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `200`  | Success                                                                                                           | See above                                                   |
| `304`  | `If-None-Match` matches the snapshot's `ETag`                                                                     | none (headers `ETag`, `Cache-Control`)                      |
| `401`  | The login is enabled and there is no valid session cookie or basic-auth header                                    | `{"error":"Unauthorized"}`                                  |
| `404`  | Unknown view id, unknown export format, or unknown path                                                           | `{"error":"Unknown view: nope"}` or `{"error":"Not found"}` |
| `502`  | The tracker could not be reached or answered with an error (bad token, rate limit, network, repository not found) | `{"error":"<message>"}`, with tokens redacted               |
| `500`  | Unexpected internal error                                                                                         | `{"error":"Internal Server Error"}`                         |

- Every response under `/api/` carries `Cache-Control: no-store`. Caching is done by the server (see `cache.ttlSeconds`) and by `ETag`.
- Successful fetches are cached in memory per view for `cache.ttlSeconds` (default 300). The snapshot's `fetchedAt` tells you when the data was read. A failed fetch is not cached.
- Concurrent requests for the same view share one fetch.
- All requests to the tracker are `GET`s; this API never writes to your tracker (the webhook endpoints only receive deliveries and drop cached data).
- The cache can also be dropped by [webhooks](#post-apiwebhooksgithub-and-post-apiwebhooksgitea); the TTL remains as a safety net.

## Authentication

When `server.basicAuth` (or `EV_BASIC_AUTH`) is configured, **every** path except `/healthz`, `/login` and `/logout` requires a session cookie from the login page or an HTTP basic-auth header with the same credentials, including the web UI and the exports. The only other exception is the pair of `POST /api/webhooks/*` endpoints (when enabled), which require a valid signature instead. Use it over TLS (see [DEPLOYMENT.md](DEPLOYMENT.md#login)).

Scripts send basic auth preemptively; there is no `WWW-Authenticate` challenge, because it would make browsers show their own dialog instead of the login page:

```sh
curl -u admin:change-me http://localhost:8080/api/views
```

Without credentials, a browser page load (`GET` with `Accept: text/html`) is redirected to the login page, and everything else gets:

```text
HTTP/1.1 401 Unauthorized
content-type: application/json; charset=utf-8
cache-control: no-store

{"error":"Unauthorized"}
```

## Snapshot schema

A snapshot is the JSON document returned by the snapshot, refresh and `export.json` endpoints. The authoritative TypeScript definitions are in [`src/core/types.ts`](../src/core/types.ts) (`Snapshot`, `Plan`, `PlanNode`, `Layout`, ...).

| Field            | Description                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewId`         | The view id                                                                                                                                                                                                                                                                                                                           |
| `title`          | The view title                                                                                                                                                                                                                                                                                                                        |
| `fetchedAt`      | ISO timestamp of the fetch. **Not** part of the hash                                                                                                                                                                                                                                                                                  |
| `contentHash`    | SHA-256 hex of the canonical JSON of `{ plan, layout }`                                                                                                                                                                                                                                                                               |
| `priorityLabels` | The view's configured `ordering.priorityLabels`, in rank order (index 0 is the most urgent). `plan.nodes[].priority` indexes into it, and `priority === priorityLabels.length` means the issue has no priority label. **Not** part of the hash: changing the configured labels already changes the hash through the `priority` values |
| `orderingMode`   | `priority` or `waves`: the view's `ordering.mode`. In `priority` mode `plan.order` can interleave waves; in `waves` mode it runs wave by wave. **Not** part of the hash on its own: `plan.order` already reflects it, so changing the mode changes the hash whenever it changes the order                                             |
| `plan`           | The dependency plan (below)                                                                                                                                                                                                                                                                                                           |
| `layout`         | Coordinates for drawing the graph (below)                                                                                                                                                                                                                                                                                             |

### `plan`

| Field           | Description                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewId`        | The view id                                                                                                                                                                                                               |
| `nodes`         | One entry per issue in the plan, sorted by key (see below)                                                                                                                                                                |
| `edges`         | `{ from, to, sources }`: `from` must be closed before `to` can start. `sources` is a sorted subset of `native`, `body`, `sub-issue`                                                                                       |
| `order`         | Keys of all schedulable issues in execution order                                                                                                                                                                         |
| `waves`         | `waves[i]` are the keys of parallel wave `i` (0-based), in `order` position                                                                                                                                               |
| `cycles`        | Each dependency cycle as a list of keys                                                                                                                                                                                   |
| `unschedulable` | Keys of issues in a cycle or blocked by one                                                                                                                                                                               |
| `criticalPath`  | The longest dependency chain, in execution order                                                                                                                                                                          |
| `warnings`      | `{ code, message, issues }`. Codes: `cycle`, `blocked-by-cycle`, `self-reference`, `dangling-reference`, `external-unresolved`, `native-unsupported`, `fetch-error` ([meaning and fixes](PREREQUISITES.md#warning-codes)) |
| `stats`         | `total`, `ready`, `blocked`, `unschedulable`, `external`, `edges`, `waves`                                                                                                                                                |

A node has: `key` (`owner/repo#number`, lowercase), `repo`, `number`, `title`, `url`, `labels`, `assignees`, `milestone` (or `null`), `external` (boolean), `status` (`ready`, `blocked`, `in-cycle` or `blocked-by-cycle`), `wave` and `order` (0-based, `null` when unschedulable), `blockedBy` and `blocks` (keys of open direct prerequisites and dependents), `parents` and `children` (keys of the `Parent:` hierarchy; never dependencies), `priority` (index in `priorityLabels`, or `priorityLabels.length`) and `remainingDepth`.

### `layout`

`width` and `height` of the drawing; `nodes` (`key`, `x`, `y`, `width`, `height`, `layer`, `row`) and `edges` (`from`, `to`, `points`: two `{x, y}` anchors, source right-middle to target left-middle). All numbers are integers. How they are computed: [DETERMINISM.md](DETERMINISM.md#layout).

Abridged real output (a five-issue view):

```json
{
  "viewId": "mini",
  "title": "mini",
  "fetchedAt": "2026-09-29T09:03:17.028Z",
  "contentHash": "1097a5d86c6003c4a601af62bb6cb0f5ae620a5193dbe1c52612914607154907",
  "priorityLabels": ["P0", "P1", "P2"],
  "orderingMode": "priority",
  "plan": {
    "viewId": "mini",
    "nodes": [
      {
        "key": "acme/app#2",
        "repo": { "owner": "acme", "repo": "app" },
        "number": 2,
        "title": "API",
        "url": "https://fixture.local/acme/app/issues/2",
        "labels": [],
        "assignees": [],
        "milestone": null,
        "external": false,
        "status": "blocked",
        "wave": 1,
        "order": 2,
        "blockedBy": ["acme/app#1"],
        "blocks": ["acme/app#5"],
        "parents": [],
        "children": [],
        "priority": 3,
        "remainingDepth": 2
      }
    ],
    "order": ["acme/app#4", "acme/app#1", "acme/app#2", "acme/app#3", "acme/app#5"],
    "waves": [["acme/app#4", "acme/app#1"], ["acme/app#2", "acme/app#3"], ["acme/app#5"]],
    "criticalPath": ["acme/app#1", "acme/app#2", "acme/app#5"]
  }
}
```

## Examples

Health check:

```sh
curl -s http://localhost:8080/healthz
```

```json
{ "status": "ok" }
```

List the views:

```sh
curl -s http://localhost:8080/api/views
```

Get the snapshot and read a few fields (requires `jq`):

```sh
curl -s http://localhost:8080/api/views/demo/snapshot | jq '{hash: .contentHash, stats: .plan.stats, order: .plan.order[:3]}'
```

Show the response headers (`ETag`, `Cache-Control`):

```sh
curl -sI http://localhost:8080/api/views/demo/snapshot
```

Conditional request: only download when the plan changed. When the `ETag` still matches, the server answers `304` with no body (use the `ETag` of your own last response):

```sh
curl -s -o /dev/null -D - -H 'If-None-Match: "e65915280f17fb5d65c72e4ea75d62cc77dd08b00268a9f820ecd2bfef3cb3b0"' http://localhost:8080/api/views/demo/snapshot
```

```text
HTTP/1.1 304 Not Modified
etag: "e65915280f17fb5d65c72e4ea75d62cc77dd08b00268a9f820ecd2bfef3cb3b0"
cache-control: no-store
```

Force a refetch from the tracker:

```sh
curl -s -X POST http://localhost:8080/api/views/demo/refresh -o /dev/null -w '%{http_code}\n'
```

```sh
curl -s 'http://localhost:8080/api/views/demo/snapshot?refresh=1' | jq -r .fetchedAt
```

Download exports:

```sh
curl -s http://localhost:8080/api/views/demo/export.md -o demo.md
```

```sh
curl -s http://localhost:8080/api/views/demo/export.mmd -o demo.mmd
```

```sh
curl -s http://localhost:8080/api/views/demo/export.dot | dot -Tsvg -o demo.svg
```

(`dot` is Graphviz.) Unknown view:

```sh
curl -si http://localhost:8080/api/views/nope/snapshot
```

```text
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8
cache-control: no-store

{"error":"Unknown view: nope"}
```
