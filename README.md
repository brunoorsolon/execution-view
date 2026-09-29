# execution-view

execution-view is a small self-hosted app that reads the **open issues** of your GitHub, GitHub Enterprise Server or Gitea repositories, builds a **dependency graph** from the relations you already declare (native issue dependencies and simple `Depends on #12` lines in issue bodies), and turns it into an **execution order**: what can start now, what can run in parallel, and what blocks everything else. The output is fully deterministic: the same issues always give the same order, the same layout and the same content hash. It has a web UI, a REST API, exports (JSON, Markdown, Mermaid, DOT) and a CLI that checks your setup.

![Dependency graph of the demo roadmap](docs/screenshots/graph.png)

## Features

- **Dependency graph** of open issues across one or more repositories, rendered as layered columns (one column per wave).
- **Execution order with parallel waves**: wave 1 can start now, everything inside a wave can run in parallel, and a linear order breaks ties by priority label.
- **Critical path**: the longest chain of dependencies, which sets the minimum number of sequential steps.
- **Cycle and dangling-reference detection**: circular dependencies and references to issues that do not exist or are not accessible are reported, not hidden.
- **Deterministic output and content hash**: no dependence on API response order, clocks or locale. The hash doubles as an `ETag`. See [docs/DETERMINISM.md](docs/DETERMINISM.md).
- **Exports** to JSON, Markdown, Mermaid and Graphviz DOT.
- **GitHub, GitHub Enterprise Server and Gitea** (Forgejo should work too, but is untested).
- **Docker** image and `docker-compose.yml`; also runs on plain Node.js 22.
- Read-only: it only issues `GET` requests to your tracker.

## Quickstart (demo in 1 minute)

The demo uses a bundled fixture (no network, no token): the "Acme demo roadmap", two repositories with 23 open issues, a cycle and a dangling reference.

### With Docker

```sh
docker build -t execution-view .
```

```sh
docker run --rm -p 8080:8080 -e EV_CONFIG=/app/config.demo.yaml execution-view
```

Open <http://localhost:8080>.

### Without Docker

Requires Node.js 22 or newer.

```sh
npm ci && npm run build && EV_CONFIG=config.demo.yaml npm start
```

Open <http://localhost:8080>.

## Use it on your repo

Read [Before you start: prerequisites](#before-you-start-prerequisites) first: without declared dependencies the graph is empty.

### Env-only (no config file)

GitHub:

```sh
docker run --rm -p 8080:8080 -e EV_PROVIDER=github -e EV_REPOS=owner/repo -e GITHUB_TOKEN execution-view
```

Gitea (`EV_BASE_URL` is the instance root, without `/api/v1`):

```sh
docker run --rm -p 8080:8080 -e EV_PROVIDER=gitea -e EV_BASE_URL=https://gitea.example.com -e EV_REPOS=owner/repo -e GITEA_TOKEN execution-view
```

`-e GITHUB_TOKEN` (without a value) passes the variable from your shell into the container, so the token never appears in the command line. `EV_REPOS` takes a comma-separated list of `owner/repo`. Without a token, only public repositories work, at a low rate limit.

### Config file

For several repositories, several views, scope filters, priority labels, a GitHub Enterprise Server host or basic auth, use a config file:

```sh
cp config.example.yaml config.yaml
```

Edit `config.yaml` (remove the sources and views you do not need), then mount it at `/app/config.yaml`:

```sh
docker run --rm -p 8080:8080 -v "$PWD/config.yaml:/app/config.yaml:ro" -e GITHUB_TOKEN execution-view
```

Every option is documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Deployment recipes (docker-compose, systemd, reverse proxy, basic auth) are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Before you start: prerequisites

The app can only show what your issues declare. In short:

- [ ] Your dependencies are declared **natively** (GitHub "Relationships", Gitea "Dependencies") and/or as **lines in the issue body**, such as `Depends on #12`. Mid-sentence prose is deliberately ignored.
- [ ] You have a **read-only token** that can read every repository involved, including repositories that are only referenced from another one.
- [ ] Native dependencies are **available** on your platform (a setting that must be enabled on Gitea; possibly missing on older GitHub Enterprise Server versions). If not, use body lines only.
- [ ] You know that only **open** issues are shown, and a **closed** issue never blocks anything.

The full explanation, the accepted and rejected syntax, token permissions, API usage and a verification checklist are in **[docs/PREREQUISITES.md](docs/PREREQUISITES.md)**. Verify your setup at any time with:

```sh
node dist/cli/index.js check
```

## Documentation

| Document                                       | What is in it                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [docs/PREREQUISITES.md](docs/PREREQUISITES.md) | What the app reads, how to declare dependencies, tokens, rate limits, warning codes and a checklist |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every config option and environment variable, with complete examples                                |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)       | Docker, docker-compose, bare Node, systemd, reverse proxy, basic auth, security, upgrading          |
| [docs/DETERMINISM.md](docs/DETERMINISM.md)     | The guarantees, the exact ordering rules, the content hash                                          |
| [docs/API.md](docs/API.md)                     | HTTP endpoints, headers, snapshot schema, curl examples                                             |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | The implementation contract (for contributors)                                                      |

## CLI

The CLI reads the same config as the server (`--config <path>`, then `EV_CONFIG`, then `./config.yaml`, then env-only mode). After `npm run build` it is `node dist/cli/index.js` (also installed as the `execution-view` bin; the Docker image uses it as its entrypoint).

| Command                                                      | What it does                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `serve`                                                      | Start the HTTP server and web UI (the default command of the Docker image)                         |
| `views [--json]`                                             | List the configured views                                                                          |
| `plan <viewId> [-f md\|json\|mermaid\|mmd\|dot] [-o <file>]` | Fetch the view and print the plan (default format `md`, default output stdout)                     |
| `check [viewId...] [--json]`                                 | Validate the config, fetch the views, report cycles and dangling references (all views by default) |

`check` exit codes: `0` everything fine, `1` configuration error, unknown view or fetch failure, `2` cycles or dangling references found. Example against the demo:

```sh
node dist/cli/index.js -c config.demo.yaml check
```

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

The demo has problems on purpose, so this run exits with code `2`.

## Development

```sh
npm ci
```

```sh
npm run typecheck && npm test && npm run format:check
```

`npm run build` compiles the server to `dist/` and the web UI to `dist/web/`.

## License

[MIT](LICENSE)
