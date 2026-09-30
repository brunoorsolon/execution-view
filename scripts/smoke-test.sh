#!/usr/bin/env bash
# Build the image and smoke-test it: demo config, then env-only mode.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-execution-view:smoke}"
SUFFIX="$$"
DEMO_NAME="ev-smoke-demo-$SUFFIX"
ENV_NAME="ev-smoke-env-$SUFFIX"
CONTAINERS=("$DEMO_NAME" "$ENV_NAME")
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
grep -q 'execution-view' "$TMP_DIR/root.body" || fail "GET / HTML does not contain 'execution-view'"
asset="$(grep -o '<script[^>]*src="[^"]*assets/[^"]*"' "$TMP_DIR/root.body" | head -n1 | sed 's/.*src="\([^"]*\)".*/\1/')"
[ -n "$asset" ] || fail "GET / HTML has no <script> referencing a built asset"
asset="/${asset#./}"
curl -fsS -o /dev/null "$BASE$asset" || fail "built asset $asset is not served"
echo "ok: GET / serves the web UI (execution-view, script $asset)"

echo "==> env-only mode (no config file)"
docker run -d --name "$ENV_NAME" -p 127.0.0.1::8080 \
  -e EV_PROVIDER=github -e EV_REPOS=octocat/hello-world "$IMAGE" >/dev/null
ENV_BASE="http://127.0.0.1:$(host_port "$ENV_NAME")"
wait_healthy "$ENV_BASE"
echo "ok: env-only /healthz"

FAILED=0
echo "smoke test passed"
