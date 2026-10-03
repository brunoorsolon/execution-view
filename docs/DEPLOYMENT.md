# Deployment

execution-view is a single stateless Node.js process: no database, no disk state. It listens on one port and serves the web UI and the API. Pick one of the setups below.

Contents:

- [Before you deploy](#before-you-deploy)
- [Docker](#docker)
- [docker-compose](#docker-compose)
- [Bare Node.js](#bare-nodejs)
- [systemd](#systemd)
- [Reverse proxy](#reverse-proxy)
- [Basic auth](#basic-auth)
- [Webhooks](#webhooks)
- [Health check](#health-check)
- [Resource needs](#resource-needs)
- [Security notes](#security-notes)
- [Upgrading](#upgrading)
- [Building the image behind an HTTPS-intercepting proxy](#building-the-image-behind-an-https-intercepting-proxy)

## Before you deploy

1. Read [PREREQUISITES.md](PREREQUISITES.md): how dependencies must be declared, and which token you need.
2. Decide between a config file ([CONFIGURATION.md](CONFIGURATION.md)) and env-only mode (one source, one view, from environment variables).
3. Create a **read-only** token and keep it in an environment variable or a secret, not in the config file.
4. Run `execution-view check` against your real repositories before exposing the service.

## Docker

Every release publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to the GitHub Container Registry:

```sh
docker pull ghcr.io/brunoorsolon/execution-view:1
```

Tags: the exact version (`1.0.0`), the minor (`1.0`), the major (`1`, used in these examples: it follows the newest 1.x release) and `latest`. Pin an exact version if you want to upgrade by hand.

To build the image yourself instead (for example to test unreleased changes), run this from the repository root and use `execution-view` as the image name in the commands below:

```sh
docker build -t execution-view .
```

The image is a multi-stage build on `node:22-alpine`: it compiles the server and the web UI, then keeps only production dependencies and the compiled output. It runs as the non-root user `node`, exposes port 8080, has `EV_HOST=0.0.0.0` and `EV_PORT=8080` set, and its entrypoint is the CLI with the default command `serve`. So `docker run ghcr.io/brunoorsolon/execution-view:1 check` runs the check instead of the server.

### The demo (no token, no network)

```sh
docker run --rm -p 8080:8080 -e EV_CONFIG=/app/config.demo.yaml ghcr.io/brunoorsolon/execution-view:1
```

`config.demo.yaml`, `config.example.yaml` and the demo fixture are part of the image.

### Env-only (no config file)

```sh
docker run -d --name execution-view -p 8080:8080 --restart unless-stopped -e EV_PROVIDER=github -e EV_REPOS=owner/repo -e GITHUB_TOKEN ghcr.io/brunoorsolon/execution-view:1
```

For Gitea add `-e EV_BASE_URL=https://gitea.example.com` and use `-e GITEA_TOKEN`. All variables are listed in [CONFIGURATION.md](CONFIGURATION.md#env-only-mode). Put the variables in a file to keep them out of your shell history and process list:

```sh
docker run -d --name execution-view -p 8080:8080 --restart unless-stopped --env-file .env ghcr.io/brunoorsolon/execution-view:1
```

### With a config file

The image does **not** set `EV_CONFIG`. Without it, the default lookup is `<cwd>/config.yaml`, which is `/app/config.yaml` in the image: mount your file there.

```sh
docker run -d --name execution-view -p 8080:8080 --restart unless-stopped -v "$PWD/config.yaml:/app/config.yaml:ro" --env-file .env ghcr.io/brunoorsolon/execution-view:1
```

Notes:

- The container runs as user `node` (uid 1000 in the official Node image): the mounted file must be readable by that user.
- Make sure the file exists on the host before you start the container. If a bind-mount source does not exist, Docker creates a **directory** with that name, and the app then does not see a config file.
- In the config, refer to tokens with `tokenEnv: GITHUB_TOKEN` and pass the variable with `-e GITHUB_TOKEN` or `--env-file`.
- Fixture paths in a mounted config are relative to `/app` (the directory of the config file).

### Verify inside the container

```sh
docker run --rm -v "$PWD/config.yaml:/app/config.yaml:ro" --env-file .env ghcr.io/brunoorsolon/execution-view:1 check
```

The exit code is `0`, `1` or `2` (see [PREREQUISITES.md](PREREQUISITES.md#verify-with-execution-view-check)).

The repository also has `scripts/smoke-test.sh`, which builds the image and tests the demo and env-only modes (it is what CI runs).

## docker-compose

The step-by-step setup is in the README: [Run it on your repo with docker compose](../README.md#run-it-on-your-repo-with-docker-compose). In short, put `docker-compose.yml` (from the repository) in a folder, set your repositories in its `environment:` block, put the token in a `.env` next to it (from `.env.example`), then:

```sh
docker compose run --rm execution-view check
```

```sh
docker compose up -d
```

What the compose file does:

- runs `ghcr.io/brunoorsolon/execution-view` pinned to an exact version, as `container_name: execution-view`, publishes `8080:8080` and restarts `unless-stopped`;
- sets the env-only settings (`EV_PROVIDER`, `EV_REPOS`, and `EV_BASE_URL` for Gitea) in `environment:`, and passes the token as `GITHUB_TOKEN=${GITHUB_TOKEN}` (or `GITEA_TOKEN`). Docker Compose fills in `${...}` from `.env` in the same folder; nothing else from `.env` reaches the container. With a config file, keep only the token lines: `tokenEnv: GITHUB_TOKEN` in the config finds them;
- has a commented-out `volumes:` entry that mounts `./config.yaml` at `/app/config.yaml` for config-file mode. Create the file before you uncomment it, otherwise Docker creates a directory with that name;
- carries `wud.tag.include` / `wud.tag.exclude` labels so [What's Up Docker](https://getwud.github.io/wud/) reports new releases (exact `X.Y.Z` tags only). They do nothing without it.

No data volume is needed: the app has no database, and snapshots are cached in memory (`EV_CACHE_TTL`) and fetched again after a restart.

To build from source instead of pulling, replace the `image:` line with `build: .` and run `docker compose up -d --build` from the repository root. To publish only on localhost (when a reverse proxy runs on the same host), change the port mapping to `'127.0.0.1:8080:8080'`.

## Bare Node.js

Requires **Node.js 22 or newer**.

```sh
npm ci
```

```sh
npm run build
```

`npm run build` compiles the server to `dist/` and the web UI to `dist/web/`. Then start it, with the config chosen by `EV_CONFIG` (or `./config.yaml`, or env-only variables):

```sh
npm start
```

`npm start` runs `node dist/server/index.js`, which reads no command-line flags. To pass a config path as a flag, use the CLI:

```sh
node dist/cli/index.js serve --config /etc/execution-view/config.yaml
```

Both handle `SIGTERM` and `SIGINT` with a graceful shutdown, and log JSON lines (one per request and event) to standard output. The server must be started from a checkout where `dist/web` is next to `dist/server`, otherwise it serves the API only (with a "web UI is not built" page at `/`). `npm run dev` (which watches `src/`) does not build the web UI.

## systemd

An example unit for a bare-Node install in `/opt/execution-view` (build it there with `npm ci && npm run build`). This is an example: adapt users, paths and the Node.js path to your system.

`/etc/systemd/system/execution-view.service`:

```ini
[Unit]
Description=execution-view
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=execution-view
Group=execution-view
WorkingDirectory=/opt/execution-view
EnvironmentFile=/etc/execution-view/env
ExecStart=/usr/bin/node dist/cli/index.js serve --config /etc/execution-view/config.yaml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`/etc/execution-view/env` (readable only by root, mode `0600`; the file is read by systemd, which then hands the variables to the service):

```sh
GITHUB_TOKEN=ghp_your_token_here
EV_HOST=127.0.0.1
EV_BASIC_AUTH=admin:change-me
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now execution-view
```

```sh
journalctl -u execution-view -f
```

## Reverse proxy

The app serves everything at the **root path** (`/`, `/api/...`, `/healthz`) and has **no base-path option**, so it cannot live under a sub-path such as `https://example.com/ev/`. Give it a host name of its own. (The web UI itself uses relative URLs, so a proxy that strips a path prefix, with the UI opened at `/ev/` including the trailing slash, may work; this is untested and not supported.)

nginx:

```nginx
server {
    listen 443 ssl;
    server_name ev.example.com;

    ssl_certificate     /etc/ssl/ev.example.com.pem;
    ssl_certificate_key /etc/ssl/ev.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Caddy (obtains and renews the certificate automatically):

```caddy
ev.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Notes:

- A cold refresh of a large view makes many requests to the tracker and can take a while: allow a generous read timeout (the nginx example uses 120 s).
- Static files are resolved on every request, so after `npm run build` (or replacing `dist/web`) the new UI is served without restarting the app; a `dist/web` created after startup is picked up too. `index.html` is sent with `Cache-Control: no-cache` (also for the deep-link fallback), files under `assets/` (hashed names) with `Cache-Control: public, max-age=31536000, immutable`, other static files with `no-cache`, and `/api/*` with `no-store`. A proxy that caches should keep honouring these headers.
- Bind the app to loopback (`EV_HOST=127.0.0.1`, or publish `127.0.0.1:8080:8080` from Docker) so that only the proxy can reach it.
- The proxy is a good place for authentication and TLS; see the next section.

## Basic auth

The app has optional HTTP basic auth that protects **everything except `/healthz`** (web UI, API and exports). Enable it in the config:

```yaml
server:
  basicAuth:
    username: admin
    passwordEnv: EV_BASIC_AUTH_PASSWORD
```

or with the environment variable `EV_BASIC_AUTH=user:password`, which overrides the config block. Prefer `passwordEnv` (or an env file) over an inline `password`.

Basic auth sends the password with every request in a **reversible encoding, not encrypted**. Only use it over **HTTPS**, i.e. behind a reverse proxy with TLS. For anything beyond a small team, prefer your proxy's own authentication (SSO, VPN, IP allow-list) in front of the app, with or without app-level basic auth. Password comparison is done in constant time.

## Webhooks

By default a view is refetched when its cache entry expires (`cache.ttlSeconds`, 300 s) or when someone presses Refresh. With webhooks, GitHub, Gitea or Forgejo tells the app when an issue changes, and the app drops the cached snapshot of the views that include that repository; the next page load or API call refetches. The app does not refetch by itself.

The UI labels below may vary between versions of GitHub, Gitea and Forgejo.

**1. Choose a secret** and give it to the app. Use a long random string, for example `openssl rand -hex 32`:

```sh
EV_WEBHOOK_SECRET=<the secret>
```

or, in the config file, `webhooks.secretEnv: EV_WEBHOOK_SECRET` (the name of an environment variable; recommended) or an inline `webhooks.secret` (see [CONFIGURATION.md](CONFIGURATION.md#webhooks)). Without a secret, the webhook endpoints do not exist.

**2. Add a webhook to each repository** of your views, pointing at your public URL (the tracker must be able to reach it; see the reverse proxy notes below):

| Tracker          | Payload URL                                  |
| ---------------- | -------------------------------------------- |
| GitHub           | `https://ev.example.com/api/webhooks/github` |
| Gitea or Forgejo | `https://ev.example.com/api/webhooks/gitea`  |

GitHub: repository **Settings → Webhooks → Add webhook**. Set the payload URL, content type `application/json`, and the secret. Under events choose **Let me select individual events** and tick **Issues**, plus **Issue dependencies** and **Sub-issues** when they are offered (they carry dependency and sub-issue changes). Keep the webhook **Active**. GitHub sends a `ping` when you save it; it should show a green tick (`200`).

Gitea or Forgejo: repository **Settings → Webhooks → Add webhook**, then choose **Gitea** (on Forgejo: **Forgejo**). Set the target URL, HTTP method `POST`, content type `application/json`, and the secret. Trigger on issue events (for example **Custom events** with the issue events selected: issue opened, edited, closed, labeled, assigned, milestoned, and so on; a dependency change is an issue edit on the tracker side, so include whatever issue events are offered). Gitea and Forgejo sign deliveries with `X-Gitea-Signature` / `X-Forgejo-Signature` (and `X-Hub-Signature-256`); any of them is accepted. The **Test delivery** button (if your version has one) sends a sample event; any correctly signed delivery is accepted, and it invalidates the views of the repository unless it is a `ping`.

Only JSON is accepted. Organization-level or system-level webhooks also work if they send repository events, since only `repository.full_name` is read.

**3. Check it:** in the tracker's webhook page, look at the recent deliveries (`202` with an `invalidated` list of view ids is the expected answer for an issue event; `401` means the secret does not match; `404` means the app has no secret configured). The app logs each accepted delivery at info level (event, repository, invalidated views), and never logs the secret or the signature.

Reverse proxy notes:

- The proxy must forward the request **body unchanged** (no re-encoding, compression or rewriting). The signature is computed over the exact bytes the tracker sent, so any change makes the delivery fail with `401`. Forward the `X-Hub-Signature-256`, `X-Gitea-Signature`, `X-Forgejo-Signature` and `X-GitHub-Event`/`X-Gitea-Event`/`X-Forgejo-Event` headers (proxies do this by default).
- Webhook requests are **not** subject to the app's basic auth (the signature is their authentication), so the tracker does not need credentials. If your proxy adds its own authentication in front of the app, let `/api/webhooks/*` through it.
- The body limit is 1 MiB (`413` above it); keep any proxy limit at least that large (nginx: `client_max_body_size`, default 1 MB).
- The tracker must reach the app over the network: for a self-hosted app on a private network this means a tracker on the same network, or a publicly reachable URL restricted to the tracker's IP addresses.

The cache TTL still applies as a safety net: a missed or failed delivery only delays an update until the TTL expires (or Refresh is pressed). You can raise `cache.ttlSeconds` once webhooks work reliably, to reduce tracker API usage.

## Health check

`GET /healthz` returns `200` and `{"status":"ok"}`, with no authentication. It only says that the process is up and serving; it does **not** call your tracker. Use `execution-view check` to verify tokens and repositories.

The Docker image already declares a `HEALTHCHECK` (every 30 s, 5 s timeout, 10 s start period, 3 retries) that requests `/healthz` on `EV_PORT`. `docker ps` shows `healthy` when it works.

```sh
curl -fsS http://localhost:8080/healthz
```

## Resource needs

Small. There is no database and no persistent state: the process keeps one snapshot per view in memory, and the cost of a refresh is a burst of HTTP requests to your tracker (see [API usage](PREREQUISITES.md#8-api-usage-and-rate-limits)) plus a graph computation that is fast for hundreds or thousands of issues. A small container or VM is enough (for example 256 MB of memory and a fraction of a CPU). These are rough sizing hints; the project has no published benchmarks.

## Security notes

- **Use read-only tokens** with the minimum scope ([PREREQUISITES.md](PREREQUISITES.md#7-tokens-and-permissions)). The app only sends `GET` requests, but a token can do whatever its scopes allow.
- **The token is never logged.** Error messages that could contain it are redacted, and the request log records the method, path and host but not headers. The HTTP client refuses to send the token to any host other than the configured `baseUrl`. API error responses redact the token too.
- Keep tokens out of the image, the repository and the config file: use `tokenEnv`, `--env-file`, Docker or systemd secrets. `.env` and `config.yaml` are git-ignored, and `.env` is excluded from the Docker build context.
- **What the app exposes:** issue titles, labels, assignees, milestones and URLs of the configured repositories (bodies are not exposed). Anyone who can reach the service can read those, including titles from **private** repositories your token can see. Use basic auth and/or the proxy's authentication, and TLS.
- The process runs as a non-root user in the Docker image and listens on all interfaces by default (`0.0.0.0`): restrict `EV_HOST` or the published port when you do not want that.
- Basic auth over plain HTTP is not confidential (see above).
- **Webhooks** are authenticated only by the HMAC signature (constant-time comparison); use a long random secret and keep it like a token. Anyone who has it can make the app drop its caches (the worst effect is extra tracker requests), nothing more.
- `EV_BASIC_AUTH` and `-e TOKEN=value` are visible to anyone who can run `docker inspect` or read the process environment; prefer files and secrets on shared hosts.

## Upgrading

The app keeps no persistent state, so upgrading means replacing the code and restarting.

Docker with compose:

```sh
docker compose pull && docker compose up -d
```

Plain Docker: `docker pull ghcr.io/brunoorsolon/execution-view:1`, remove the old container (`docker rm -f execution-view`) and run your usual `docker run` command again. With a pinned version, change the tag first. Release notes are on the [releases page](https://github.com/brunoorsolon/execution-view/releases).

From source: `git pull`, then `docker build -t execution-view .` (or `docker compose up -d --build` with `build: .`).

Bare Node.js: `git pull && npm ci && npm run build`, then restart the service (`sudo systemctl restart execution-view`).

After every upgrade, run `execution-view check`. The configuration schema is strict, so a key that was removed or renamed makes the app refuse to start with a clear message; compare your `config.yaml` with `config.example.yaml`. Cached snapshots are in memory only and start empty after a restart.

## Building the image behind an HTTPS-intercepting proxy

The build runs `npm ci` inside the image, which downloads packages over HTTPS. If your network intercepts TLS with its own certificate authority (a corporate proxy), npm inside the build does not trust that CA and the build fails, typically with certificate errors (`SELF_SIGNED_CERT_IN_CHAIN`, `unable to get local issuer certificate`) or with an npm crash. The stock Dockerfile has no option for this. Hints (untested here, adapt to your environment):

- Build on a machine or network without interception, or build the image in CI and pull it.
- Or use a local copy of the Dockerfile that adds your proxy's root CA before each `npm ci`, for example:

```dockerfile
COPY corp-ca.pem /usr/local/share/ca-certificates/corp-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-ca.crt
```

placed after `FROM` in **both** stages (`build` and `runtime`), and `docker build` proxy settings (`--build-arg HTTPS_PROXY=...`) if the proxy itself must be configured.

- Do not disable TLS verification (`strict-ssl=false`) to work around it.

This only concerns building. At run time, the app itself talks to GitHub or Gitea directly; if that traffic is intercepted too, start the container with `-e NODE_EXTRA_CA_CERTS=/path/to/ca.pem` and mount the certificate file.
