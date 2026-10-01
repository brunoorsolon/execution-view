#!/usr/bin/env bash
# Live integration test of the Gitea provider against a real forge container.
#
# Usage: scripts/forge-integration.sh [IMAGE]
#   IMAGE defaults to $FORGE_IMAGE, then to the pinned Gitea image below.
#   Forgejo works the same way: scripts/forge-integration.sh codeberg.org/forgejo/forgejo:11
#
# Needs: docker, curl, node 22, and a built CLI (npm run build -> dist/cli/index.js).
#
# Starts a disposable container (SQLite, no setup wizard), creates an admin user,
# tokens, a repo with six issues (body and native dependencies, a closed issue, a
# dangling reference), then runs `plan` and `check` of the built CLI in env-only mode
# and asserts on the result.
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_IMAGE="gitea/gitea:1.25"
IMAGE="${1:-${FORGE_IMAGE:-$DEFAULT_IMAGE}}"

ADMIN_USER="ev"
ADMIN_PASSWORD="ev-Integration-Pass-1"
ADMIN_EMAIL="ev@example.com"
REPO="demo"
CONTAINER="ev-forge-$$"
TMP_DIR="$(mktemp -d)"
FAILED=1

cleanup() {
  if [ "$FAILED" -ne 0 ] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "---- logs: $CONTAINER ($IMAGE) ----" >&2
    docker logs "$CONTAINER" >&2 || true
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f dist/cli/index.js ] || fail "dist/cli/index.js not found: run 'npm run build' first"
command -v docker >/dev/null || fail "docker is required"
command -v curl >/dev/null || fail "curl is required"

# A free TCP port on 127.0.0.1 (ROOT_URL must know it before the container starts).
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
BASE="http://127.0.0.1:$PORT"

echo "==> starting $IMAGE on $BASE"
# GITEA__section__KEY env vars are read by Gitea and by Forgejo. Newer Forgejo images prefer
# FORGEJO__section__KEY, so both are set (Gitea ignores the FORGEJO__ ones).
docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:3000" \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__server__ROOT_URL="$BASE/" \
  -e GITEA__server__DOMAIN=localhost \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  -e GITEA__log__LEVEL=Warn \
  -e FORGEJO__database__DB_TYPE=sqlite3 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__server__ROOT_URL="$BASE/" \
  -e FORGEJO__server__DOMAIN=localhost \
  -e FORGEJO__service__DISABLE_REGISTRATION=true \
  -e FORGEJO__log__LEVEL=Warn \
  "$IMAGE" >/dev/null

echo "==> waiting for $BASE/api/v1/version"
ready=0
for ((i = 0; i < 120; i++)); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    fail "container exited before the API came up"
  fi
  if curl -fsS "$BASE/api/v1/version" >"$TMP_DIR/version.json" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "$BASE/api/v1/version did not answer within 120s"
echo "ok: API is up: $(cat "$TMP_DIR/version.json")"

# The binary is called gitea in Gitea images and forgejo in Forgejo images.
BIN=""
for candidate in forgejo gitea; do
  if docker exec "$CONTAINER" sh -c "command -v $candidate" >/dev/null 2>&1; then
    BIN="$candidate"
    break
  fi
done
[ -n "$BIN" ] || fail "neither 'forgejo' nor 'gitea' binary found in $IMAGE"
echo "ok: CLI binary: $BIN"

echo "==> creating admin user $ADMIN_USER"
docker exec -u git "$CONTAINER" "$BIN" admin user create --admin \
  --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --email "$ADMIN_EMAIL" \
  --must-change-password=false >/dev/null

# api METHOD PATH [JSON_BODY]: authenticated as the admin (basic auth or $AUTH_TOKEN).
# Prints the response body; fails (with the body) on an HTTP error status.
AUTH_TOKEN=""
api() {
  local method="$1" path="$2" body="${3:-}"
  local -a auth=(-u "$ADMIN_USER:$ADMIN_PASSWORD")
  if [ -n "$AUTH_TOKEN" ]; then auth=(-H "Authorization: token $AUTH_TOKEN"); fi
  local -a data=()
  if [ -n "$body" ]; then data=(-H 'Content-Type: application/json' --data "$body"); fi
  if ! curl -sS --fail-with-body -X "$method" "${auth[@]}" "${data[@]}" \
    -o "$TMP_DIR/api.out" "$BASE/api/v1$path" 2>"$TMP_DIR/api.err"; then
    echo "API call failed: $method $path: $(cat "$TMP_DIR/api.err") $(cat "$TMP_DIR/api.out" 2>/dev/null)" >&2
    return 1
  fi
  cat "$TMP_DIR/api.out"
}

json_eval() {
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);process.stdout.write(String($1))})"
}

# make_token NAME SCOPES_JSON_ARRAY SCOPES_CSV: prints the token. Tries the API with basic
# auth, then falls back to the CLI (older versions, or scope names that the API rejects).
make_token() {
  local name="$1" scopes_json="$2" scopes_csv="$3" out token
  if out="$(api POST "/users/$ADMIN_USER/tokens" "{\"name\":\"$name\",\"scopes\":$scopes_json}" 2>"$TMP_DIR/token.err")"; then
    token="$(printf '%s' "$out" | json_eval 'd.sha1 || d.token || ""')"
    if [ -n "$token" ]; then
      printf '%s' "$token"
      return 0
    fi
  fi
  echo "note: API token creation for '$name' failed ($(head -c 300 "$TMP_DIR/token.err" 2>/dev/null)); using the CLI" >&2
  docker exec -u git "$CONTAINER" "$BIN" admin user generate-access-token \
    --username "$ADMIN_USER" --token-name "$name-cli" --scopes "$scopes_csv" --raw
}

echo "==> creating tokens"
WRITE_TOKEN="$(make_token ci-write '["write:repository","write:issue","write:user"]' 'write:repository,write:issue,write:user' | tr -d '[:space:]')"
[ -n "$WRITE_TOKEN" ] || fail "could not create the write token"
# Read-only token for the app, as docs/PREREQUISITES.md recommends.
READ_TOKEN="$(make_token ci-read '["read:issue","read:repository"]' 'read:issue,read:repository' | tr -d '[:space:]')"
[ -n "$READ_TOKEN" ] || fail "could not create the read token"
AUTH_TOKEN="$WRITE_TOKEN"
echo "ok: tokens created"

echo "==> creating $ADMIN_USER/$REPO and issues"
api POST /user/repos "{\"name\":\"$REPO\",\"auto_init\":true,\"private\":false}" >/dev/null

# create_issue EXPECTED_NUMBER TITLE [BODY]
create_issue() {
  local expected="$1" title="$2" body="${3:-}" payload got
  payload="$(node -e 'process.stdout.write(JSON.stringify({title:process.argv[1],body:process.argv[2]}))' "$title" "$body")"
  got="$(api POST "/repos/$ADMIN_USER/$REPO/issues" "$payload" | json_eval 'd.number')"
  [ "$got" = "$expected" ] || fail "issue '$title' got number $got, expected $expected"
}
create_issue 1 "Schema"
create_issue 2 "API" "Depends on #1"
create_issue 3 "UI" "- Blocked by: #2"
create_issue 4 "Docs"
create_issue 5 "Standalone"
create_issue 6 "Dangling" "Depends on #99"

# Native dependency: issue 4 depends on issue 3 (the body is an IssueMeta of the blocker).
api POST "/repos/$ADMIN_USER/$REPO/issues/4/dependencies" \
  "{\"owner\":\"$ADMIN_USER\",\"repo\":\"$REPO\",\"index\":3}" >/dev/null
api PATCH "/repos/$ADMIN_USER/$REPO/issues/1" '{"state":"closed"}' >/dev/null
echo "ok: 6 issues created, #4 depends on #3 natively, #1 closed"

echo "==> running the CLI (env-only mode)"
run_cli() {
  EV_PROVIDER=gitea EV_BASE_URL="$BASE" EV_TOKEN="$READ_TOKEN" EV_REPOS="$ADMIN_USER/$REPO" \
    node dist/cli/index.js "$@"
}
set +e
run_cli plan default -f json >"$TMP_DIR/plan.json" 2>"$TMP_DIR/plan.err"
PLAN_EXIT=$?
set -e
if [ "$PLAN_EXIT" -ne 0 ]; then
  cat "$TMP_DIR/plan.err" >&2
  fail "'plan default -f json' exited with $PLAN_EXIT"
fi

set +e
run_cli check default >"$TMP_DIR/check.out" 2>&1
CHECK_EXIT=$?
set -e
echo "---- check output (exit $CHECK_EXIT) ----"
cat "$TMP_DIR/check.out"
echo "------------------------------------------"

ASSERT_JS='
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plan;
const checkExit = Number(process.argv[2]);
const K = (n) => "ev/demo#" + n;
let failures = 0;
const assert = (name, cond, detail) => {
  if (cond) console.log("PASS: " + name);
  else { failures++; console.log("FAIL: " + name + (detail ? " (got " + detail + ")" : "")); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const nodes = plan.nodes.map((n) => n.key).sort();
assert("nodes are #2,#3,#4,#5,#6 (closed #1 is absent)", same(nodes, [2,3,4,5,6].map(K)), JSON.stringify(nodes));

const edges = plan.edges.map((e) => e.from + "->" + e.to + ":" + e.sources.join("+")).sort();
assert("edge #2->#3 from the issue body", edges.includes(K(2) + "->" + K(3) + ":body"), JSON.stringify(edges));
assert("edge #3->#4 from the native dependency", edges.includes(K(3) + "->" + K(4) + ":native"), JSON.stringify(edges));
assert("exactly two edges", edges.length === 2, JSON.stringify(edges));

// ARCHITECTURE section 8: wave = 0 without predecessors, else 1 + max(wave(predecessors)).
// Within a wave, keys follow the execution order: Kahn, min by (priority, remainingDepth desc, key).
// Available at the start: #2 (depth 3), #5 (1), #6 (1) -> #2; then #3 (2) beats #5, #6 -> #3;
// then #4, #5, #6 (all depth 1) by key. Order: #2,#3,#4,#5,#6.
assert("waves are [[#2,#5,#6],[#3],[#4]]", same(plan.waves, [[2,5,6].map(K), [3].map(K), [4].map(K)]), JSON.stringify(plan.waves));
assert("order is #2,#3,#4,#5,#6", same(plan.order, [2,3,4,5,6].map(K)), JSON.stringify(plan.order));

const dangling = plan.warnings.filter((w) => w.code === "dangling-reference");
assert("exactly one dangling-reference warning", dangling.length === 1, JSON.stringify(plan.warnings));
assert("the dangling warning is about #6", dangling.length === 1 && same(dangling[0].issues, [K(6)]), JSON.stringify(dangling));
assert("no native-unsupported warning", !plan.warnings.some((w) => w.code === "native-unsupported"), JSON.stringify(plan.warnings));
assert("no cycles", plan.cycles.length === 0, JSON.stringify(plan.cycles));
assert("`check` exits with 2 (dangling reference)", checkExit === 2, String(checkExit));

if (failures > 0) { console.log(failures + " assertion(s) failed"); process.exit(1); }
console.log("all assertions passed");
'
node -e "$ASSERT_JS" "$TMP_DIR/plan.json" "$CHECK_EXIT" || fail "assertions failed; plan JSON follows:
$(cat "$TMP_DIR/plan.json")"

FAILED=0
echo "forge integration test passed ($IMAGE)"
