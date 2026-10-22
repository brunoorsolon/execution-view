#!/usr/bin/env bash
# Build the image and smoke-test it: demo config, then env-only mode.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-execution-view:smoke}"
SUFFIX="$$"
DEMO_NAME="ev-smoke-demo-$SUFFIX"
ENV_NAME="ev-smoke-env-$SUFFIX"
REL_NAME="ev-smoke-release-$SUFFIX"
CONTAINERS=("$DEMO_NAME" "$ENV_NAME" "$REL_NAME")
TMP_DIR="$(mktemp -d)"
FAILED=1

cleanup() {
  local name
  if [ "$FAILED" -ne 0 ]; then
    for name in "${CONTAINERS[@]}"; do
      if docker inspect "$name" >/dev/null 2>&1; then
        echo "---- logs: $name ----" >&2
        docker logs "$name" >&2 || true
      fi
    done
  fi
  for name in "${CONTAINERS[@]}"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Host port that the container's 8080 is published on (docker picks a free one).
host_port() {
  docker port "$1" 8080/tcp | head -n1 | sed 's/.*://'
}

wait_healthy() {
  local url="$1" i
  for ((i = 0; i < 30; i++)); do
    if curl -fsS "$url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "$url/healthz did not become healthy within 30s"
}

# json_eval '<js expression on d>': the JSON document is read from stdin.
json_eval() {
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);process.stdout.write(String($1))})"
}

echo "==> building $IMAGE"
docker build -t "$IMAGE" .

# The release path runs real Git, OpenSSH and flock(2) in the final image as the runtime user.
echo "==> runtime capabilities of the final image"
runtime="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u; command -v git; command -v ssh; command -v flock')"
runtime_uid="$(printf '%s\n' "$runtime" | sed -n 1p)"
git_path="$(printf '%s\n' "$runtime" | sed -n 2p)"
ssh_path="$(printf '%s\n' "$runtime" | sed -n 3p)"
flock_path="$(printf '%s\n' "$runtime" | sed -n 4p)"
[ "$runtime_uid" != "0" ] || fail "the final image defaults to root"
[ -n "$git_path" ] || fail "git is missing from the final image"
[ -n "$ssh_path" ] || fail "ssh is missing from the final image"
[ -n "$flock_path" ] || fail "flock is missing from the final image"
# A release-ready process asks the helper for a lock through the `flock <file> <command>` form.
docker run --rm --entrypoint sh "$IMAGE" -c 'f="$(mktemp)"; flock "$f" true' \
  || fail "flock cannot take a lock as the runtime user"
echo "ok: uid $runtime_uid, $git_path, $ssh_path, $flock_path"

echo "==> demo config"
docker run -d --name "$DEMO_NAME" -p 127.0.0.1::8080 \
  -e EV_CONFIG=/app/config.demo.yaml "$IMAGE" >/dev/null
BASE="http://127.0.0.1:$(host_port "$DEMO_NAME")"
wait_healthy "$BASE"
echo "ok: /healthz"

views="$(curl -fsS "$BASE/api/views")"
case "$views" in
  *'"demo"'*) echo "ok: /api/views lists demo" ;;
  *) fail "/api/views does not contain \"demo\": $views" ;;
esac

total="$(curl -fsS "$BASE/api/views/demo/snapshot" | json_eval 'd.plan.stats.total')"
[ "$total" = "23" ] || fail "snapshot plan.stats.total is '$total', expected 23"
echo "ok: snapshot plan.stats.total == 23"

md="$(curl -fsS "$BASE/api/views/demo/export.md")"
case "$md" in
  '# '*) echo "ok: export.md starts with '# '" ;;
  *) fail "export.md does not start with '# ': ${md:0:80}" ;;
esac

# "/" must be the built web UI: HTML naming the app and loading a built asset.
curl -sS -D "$TMP_DIR/root.headers" -o "$TMP_DIR/root.body" "$BASE/" || fail "GET / failed"
grep -qi '^content-type: *text/html' "$TMP_DIR/root.headers" || fail "GET / is not text/html: $(cat "$TMP_DIR/root.headers")"
grep -q 'Forge Desk' "$TMP_DIR/root.body" || fail "GET / HTML does not contain 'Forge Desk'"
asset="$(grep -o '<script[^>]*src="[^"]*assets/[^"]*"' "$TMP_DIR/root.body" | head -n1 | sed 's/.*src="\([^"]*\)".*/\1/')"
[ -n "$asset" ] || fail "GET / HTML has no <script> referencing a built asset"
asset="/${asset#./}"
curl -fsS -o /dev/null "$BASE$asset" || fail "built asset $asset is not served"
echo "ok: GET / serves the web UI (Forge Desk, script $asset)"

echo "==> env-only mode (no config file)"
docker run -d --name "$ENV_NAME" -p 127.0.0.1::8080 \
  -e EV_PROVIDER=github -e EV_REPOS=octocat/hello-world "$IMAGE" >/dev/null
ENV_BASE="http://127.0.0.1:$(host_port "$ENV_NAME")"
wait_healthy "$ENV_BASE"
echo "ok: env-only /healthz"

# Release-enabled startup uses a private state volume and read-only credential files. No forge is
# contacted at startup, so this proves the deployment shape and the one-writer lock without a
# live server; publication itself needs the live Gitea evidence recorded in the pull request.
echo "==> release-enabled startup (private volume, read-only secrets)"
command -v ssh-keygen >/dev/null || fail "ssh-keygen is required to create the smoke credentials"
mkdir -p "$TMP_DIR/secrets" "$TMP_DIR/state"
chmod 700 "$TMP_DIR/secrets" "$TMP_DIR/state"
printf 'smoke-release-token\n' >"$TMP_DIR/secrets/forge_desk_release_token"
ssh-keygen -q -t ed25519 -N '' -f "$TMP_DIR/secrets/forge_desk_release_key"
: >"$TMP_DIR/secrets/forge_desk_known_hosts"
chmod 600 "$TMP_DIR/secrets/forge_desk_release_token" \
  "$TMP_DIR/secrets/forge_desk_release_key"
chmod 644 "$TMP_DIR/secrets/forge_desk_known_hosts"

cat >"$TMP_DIR/config.yaml" <<'YAML'
server:
  host: 0.0.0.0
  port: 8080
  basicAuth:
    username: operator
    passwordEnv: EV_BASIC_AUTH_PASSWORD
sources:
  - id: gt
    kind: gitea
    baseUrl: https://gitea.invalid
    tokenEnv: GITEA_TOKEN
views:
  - id: app
    source: gt
    repos:
      - acme/app
releases:
  enabled: true
  publicOrigin: http://localhost
  stateDir: /var/lib/forge-desk
  repositories:
    - id: app
      source: gt
      repo: acme/app
      origin: ssh://git@gitea.invalid:2222/acme/app.git
      apiTokenFile: /run/secrets/forge_desk_release_token
      expectedApiUser: release-bot
      ci:
        workflowPath: .gitea/workflows/validate.yml
      ssh:
        privateKeyFile: /run/secrets/forge_desk_release_key
        knownHostsFile: /run/secrets/forge_desk_known_hosts
      tagger:
        name: Forge Desk Smoke
        email: smoke@example.invalid
YAML

release_args=(
  --user "$(id -u):$(id -g)"
  -e HOME=/tmp
  -e EV_CONFIG=/app/config.yaml
  -e GITEA_TOKEN=planning-smoke-token
  -e EV_BASIC_AUTH_PASSWORD=smoke-pass
  -v "$TMP_DIR/config.yaml:/app/config.yaml:ro"
  -v "$TMP_DIR/secrets:/run/secrets:ro"
  -v "$TMP_DIR/state:/var/lib/forge-desk"
)
docker run -d --name "$REL_NAME" -p 127.0.0.1::8080 "${release_args[@]}" "$IMAGE" >/dev/null
REL_BASE="http://127.0.0.1:$(host_port "$REL_NAME")"
wait_healthy "$REL_BASE"
echo "ok: release-enabled /healthz (planning stays up)"

lock_mode="$(docker exec "$REL_NAME" stat -c '%a' /var/lib/forge-desk/owner.lock)"
[ "$lock_mode" = "600" ] || fail "owner.lock mode is $lock_mode, expected 600"
echo "ok: owner.lock is 0600"

# Release readiness is reported per repository, sanitized, and separate from process liveness.
capability="$(curl -fsS -u operator:smoke-pass "$REL_BASE/api/releases/repositories")"
case "$capability" in
  *'"capability":"blocked"'*) echo "ok: release capability is blocked and sanitized, /healthz stays 200" ;;
  *) fail "unexpected release capability: $capability" ;;
esac

set +e
second_owner="$(docker run --rm "${release_args[@]}" "$IMAGE" 2>&1)"
second_status=$?
set -e
[ "$second_status" -ne 0 ] || fail "a second process claimed the same release state directory"
case "$second_owner" in
  *'owns release state directory'*) echo "ok: a second owner is refused (one writer)" ;;
  *) fail "second owner did not report the ownership conflict: ${second_owner:0:400}" ;;
esac

docker restart "$REL_NAME" >/dev/null
wait_healthy "$REL_BASE"
capability="$(curl -fsS -u operator:smoke-pass "$REL_BASE/api/releases/repositories")"
case "$capability" in
  *'"capability":"blocked"'*) echo "ok: restart reacquires the state directory" ;;
  *) fail "release capability after restart: $capability" ;;
esac

FAILED=0
echo "smoke test passed"
