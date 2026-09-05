#!/usr/bin/env bash
# Start the local registry on 4873. Compose when Docker works, `npx verdaccio` (Node 18) otherwise.
# Idempotent: if something already answers /-/ping on 4873 we leave it alone.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STATE="$ROOT/.estate"
mkdir -p "$STATE/logs"

REGISTRY_URL="${REGISTRY_URL:-http://localhost:4873}"
VERDACCIO_VERSION=5.29.2

log() { printf '[verdaccio-up] %s\n' "$*"; }

if curl -fs -o /dev/null "$REGISTRY_URL/-/ping"; then
  log "already up at $REGISTRY_URL"
  exit 0
fi

docker_ok() {
  [ "${ESTATE_NO_DOCKER:-0}" != "1" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

if docker_ok; then
  log "starting via docker compose"
  (cd "$ROOT" && docker compose up -d --build verdaccio)
else
  log "Docker unavailable (or ESTATE_NO_DOCKER=1), starting verdaccio@$VERDACCIO_VERSION in process"
  # shellcheck disable=SC1091
  if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 18.19.0 >/dev/null 2>&1 || nvm install 18.19.0 >/dev/null; fi
  mkdir -p "$ROOT/verdaccio/storage"
  # setsid + all three fds redirected: otherwise the wrapper keeps the caller's stdout open and
  # `estate-up.sh | tee` never returns (PLAT-2711).
  (cd "$ROOT/verdaccio" && setsid nohup npx --yes "verdaccio@$VERDACCIO_VERSION" --config ./config.yaml --listen 0.0.0.0:4873 \
      < /dev/null > "$STATE/logs/verdaccio.log" 2>&1 &
   echo $! > "$STATE/verdaccio.pid") < /dev/null > /dev/null 2>&1
fi

for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$REGISTRY_URL/-/ping"; then
    # npx exec's the real process, so the pid we recorded is the wrapper; note the listener too
    if [ -f "$STATE/verdaccio.pid" ] && command -v ss >/dev/null 2>&1; then
      ss -ltnp 2>/dev/null | sed -n 's/.*:4873 .*pid=\([0-9]*\).*/\1/p' | head -1 >> "$STATE/verdaccio.pid"
    fi
    log "up at $REGISTRY_URL"; exit 0
  fi
  sleep 1
done
log "verdaccio did not answer on $REGISTRY_URL within 60s; see $STATE/logs/verdaccio.log or docker logs estate-verdaccio"
exit 1
