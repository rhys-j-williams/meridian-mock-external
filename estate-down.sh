#!/usr/bin/env bash
# estate-down.sh - stop whatever estate-up.sh started. Safe to run twice.
#
#   --mocks-only     only the in-process mocks; platform services and the registry are left alone
#                    (estate-up uses this before a restart, after it has just brought Verdaccio up)
#   --volumes        also drop the compose volumes (verdaccio storage, HEC data, bedrock reports)
#   --keep-registry  leave Verdaccio running (handy when iterating on a single mock)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HERE/.estate"
MOCKS_ONLY=0; VOLUMES=""; KEEP_REGISTRY=0
for a in "$@"; do
  case "$a" in
    --mocks-only) MOCKS_ONLY=1; KEEP_REGISTRY=1;;
    --volumes) VOLUMES="-v";;
    --keep-registry) KEEP_REGISTRY=1;;
    *) echo "unknown flag $a"; exit 2;;
  esac
done
log() { printf '[estate-down] %s\n' "$*"; }

kill_pid() { # pid label
  local pid="$1" label="$2"
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    # give it a moment, then be firm; process groups for the nohup'd bash -c wrappers
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    pkill -TERM -P "$pid" 2>/dev/null || true
    log "stopped $label ($pid)"
  fi
}

# platform services (nohup bash -c ... ; children too)
if [ $MOCKS_ONLY = 0 ] && [ -f "$STATE/service-pids" ]; then
  while read -r name pid; do
    [ -n "${pid:-}" ] || continue
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill_pid "$pid" "$name"
  done < "$STATE/service-pids"
  rm -f "$STATE/service-pids"
fi

# in-process mocks
if [ -f "$STATE/pids" ]; then
  node -e 'const p=require(process.argv[1]);for(const [n,pid] of Object.entries(p))console.log(n,pid)' "$STATE/pids" 2>/dev/null \
    | while read -r name pid; do kill_pid "$pid" "$name"; done
  rm -f "$STATE/pids"
fi
# and anything that escaped the pid file but is clearly ours
for port in 4400 4600 4601 4602 4603 4604 4605 4606 4607 4608 4609 14609; do
  if command -v ss >/dev/null 2>&1; then
    for pid in $(ss -ltnp 2>/dev/null | sed -n "s/.*:$port .*pid=\([0-9]*\).*/\1/p" | sort -u); do
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'dist/main.js'; then kill_pid "$pid" "port $port"; fi
    done
  fi
done

# compose (mocks + infra + verdaccio container)
if [ "${ESTATE_NO_DOCKER:-0}" != "1" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ $KEEP_REGISTRY = 1 ]; then
    # stop everything except verdaccio
    services=$(cd "$HERE" && docker compose ps --services 2>/dev/null | grep -v '^verdaccio$' || true)
    # shellcheck disable=SC2086
    [ -n "$services" ] && (cd "$HERE" && docker compose stop $services >/dev/null 2>&1 && docker compose rm -f $services >/dev/null 2>&1)
    log "compose services stopped (verdaccio kept)"
  else
    (cd "$HERE" && docker compose --profile ibm-mq down --remove-orphans $VOLUMES 2>&1 | sed 's/^/[estate-down] /')
  fi
fi

# in-process verdaccio
if [ $KEEP_REGISTRY = 0 ] && [ -f "$STATE/verdaccio.pid" ]; then
  while read -r pid; do kill_pid "$pid" "verdaccio"; done < "$STATE/verdaccio.pid"
  rm -f "$STATE/verdaccio.pid"
fi

rm -f "$STATE/mode"
log "done. logs kept in $STATE/logs"
