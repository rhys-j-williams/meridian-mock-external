#!/usr/bin/env bash
# Publish the internal @meridian packages to the local Verdaccio (4873). Order matters:
# domain-fixtures first because everything depends on it. Packages whose directory is not in the
# checkout are skipped with a warning, because the other teams land them on their own branches.
# A 409 / EPUBLISHCONFLICT means the version is already there and is treated as success.
#
# Usage: scripts/publish-internal.sh [--only domain-fixtures,lantern-sdk]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$MOCK_ROOT/.." && pwd)"
REGISTRY_URL="${REGISTRY_URL:-http://localhost:4873}"
PUBLISHER_USER="${VERDACCIO_PUBLISHER_USER:-meridian-publisher}"
PUBLISHER_PASSWORD="${VERDACCIO_PUBLISHER_PASSWORD:-CHANGEME-verdaccio-publisher}"
NPMRC="$MOCK_ROOT/.estate/publish.npmrc"

ONLY=""
if [ "${1:-}" = "--only" ]; then ONLY="${2:-}"; fi

log()  { printf '[publish-internal] %s\n' "$*"; }
warn() { printf '[publish-internal] WARN %s\n' "$*" >&2; }

# shellcheck disable=SC1091
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi
use_node() { if command -v nvm >/dev/null 2>&1; then nvm use "$1" >/dev/null 2>&1 || { warn "node $1 not installed, using $(node -v)"; }; fi; }

if ! curl -fsS -o /dev/null "$REGISTRY_URL/-/ping"; then
  echo "[publish-internal] registry not reachable at $REGISTRY_URL; run scripts/verdaccio-up.sh first" >&2
  exit 1
fi

mkdir -p "$(dirname "$NPMRC")"
# Verdaccio legacy auth: PUT /-/user/org.couchdb.user:<name> with basic auth for an *existing*
# htpasswd user returns a token (without the basic auth header it is treated as a registration).
TOKEN=$(curl -fsS -X PUT -H 'content-type: application/json' -u "$PUBLISHER_USER:$PUBLISHER_PASSWORD" \
  -d "{\"name\":\"$PUBLISHER_USER\",\"password\":\"$PUBLISHER_PASSWORD\"}" \
  "$REGISTRY_URL/-/user/org.couchdb.user:$PUBLISHER_USER" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).token||"")}catch(e){}})')
if [ -z "$TOKEN" ]; then
  echo "[publish-internal] could not log in as $PUBLISHER_USER; check verdaccio/htpasswd" >&2
  exit 1
fi
HOSTPATH="${REGISTRY_URL#http://}"; HOSTPATH="${HOSTPATH#https://}"
cat > "$NPMRC" <<NPMRC
registry=$REGISTRY_URL
//$HOSTPATH/:_authToken=$TOKEN
always-auth=true
fund=false
audit=false
NPMRC
trap 'rm -f "$NPMRC"' EXIT

PUBLISHED=0; SKIPPED=0; FAILED=0

publish_dir() { # name dir node-version [build-cmd]
  local name="$1" dir="$2" nodev="$3" build="${4:-npm run build}"
  if [ -n "$ONLY" ] && ! printf '%s' ",$ONLY," | grep -q ",$name,"; then return; fi
  if [ ! -f "$dir/package.json" ]; then
    warn "$name: $dir not present in this checkout, skipping (another team's branch)"
    SKIPPED=$((SKIPPED+1)); return
  fi
  local version
  version=$(node -p "require('$dir/package.json').version")
  if curl -fsS "$REGISTRY_URL/@meridian%2f$name/$version" -o /dev/null 2>/dev/null; then
    log "$name@$version already on the registry"
    PUBLISHED=$((PUBLISHED+1)); return
  fi
  log "$name@$version: building with node $nodev"
  ( cd "$dir" && use_node "$nodev" \
      && { [ -d node_modules ] || [ ! -f package-lock.json ] || npm ci --ignore-scripts >/dev/null 2>&1; } \
      && sh -c "$build" ) || { warn "$name: build failed"; FAILED=$((FAILED+1)); return; }
  local out
  if out=$(cd "$dir" && npm publish --userconfig "$NPMRC" --registry "$REGISTRY_URL" --ignore-scripts --loglevel error 2>&1); then
    log "$name@$version published"; PUBLISHED=$((PUBLISHED+1))
  elif printf '%s' "$out" | grep -qiE 'EPUBLISHCONFLICT|409|over existing'; then
    log "$name@$version already published (409)"; PUBLISHED=$((PUBLISHED+1))
  else
    warn "$name: publish failed"; printf '%s\n' "$out" | tail -5 >&2; FAILED=$((FAILED+1))
  fi
}

publish_dir domain-fixtures  "$REPO_ROOT/platform-services/libs/ts/domain-fixtures" 18.19.0
# semaphore-client is an npm workspace of mock-external: install/build from the root, never from
# inside the member directory (npm scopes an install run there to that workspace and prunes the rest)
[ -x "$MOCK_ROOT/node_modules/.bin/tsc" ] || (cd "$MOCK_ROOT" && use_node 18.19.0 && npm ci --ignore-scripts >/dev/null)
publish_dir semaphore-client "$MOCK_ROOT/lib/semaphore-client"                        18.19.0 "$MOCK_ROOT/node_modules/.bin/tsc -p tsconfig.json"
# lantern-sdk: ng-packagr output lives in dist/lantern-sdk; the package.json we publish is in there
if [ -n "$ONLY" ] && ! printf '%s' ",$ONLY," | grep -q ",lantern-sdk,"; then :; elif [ -f "$REPO_ROOT/lantern-sdk/package.json" ]; then
  if ( cd "$REPO_ROOT/lantern-sdk" && use_node 14.21.3 && { [ -d node_modules ] || npm ci --ignore-scripts >/dev/null 2>&1; } && npm run build >/dev/null ); then
    publish_dir lantern-sdk "$REPO_ROOT/lantern-sdk/dist/lantern-sdk" 14.21.3 "true"
  else
    warn "lantern-sdk: build failed (needs node 14.21.3 and @angular/cli@12.2.18 global, see lantern-sdk/README.md)"; FAILED=$((FAILED+1))
  fi
else
  warn "lantern-sdk: not present, skipping"; SKIPPED=$((SKIPPED+1))
fi
# canopy-ui has its own publish script that handles the two versions (3.5.0 from tag, 3.7.2 head)
if [ -n "$ONLY" ] && ! printf '%s' ",$ONLY," | grep -q ",canopy-ui,"; then :; elif [ -x "$REPO_ROOT/canopy-ui/scripts/publish.sh" ]; then
  log "canopy-ui: delegating to canopy-ui/scripts/publish.sh"
  if ( cd "$REPO_ROOT/canopy-ui" && use_node 16.20.2 && REGISTRY_URL="$REGISTRY_URL" NPM_CONFIG_USERCONFIG="$NPMRC" ./scripts/publish.sh ); then
    PUBLISHED=$((PUBLISHED+1))
  else
    warn "canopy-ui: publish script failed"; FAILED=$((FAILED+1))
  fi
else
  warn "canopy-ui: scripts/publish.sh not present, skipping"; SKIPPED=$((SKIPPED+1))
fi

log "done: $PUBLISHED published/present, $SKIPPED skipped, $FAILED failed"
[ "$FAILED" -eq 0 ]
