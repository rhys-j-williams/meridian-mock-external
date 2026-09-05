#!/usr/bin/env bash
# estate-up.sh - bring the local Meridian estate up in one go.
#
#   1. Verdaccio on 4873 and the internal packages published to it
#   2. the external mocks + infrastructure (compose when Docker works, in-process otherwise)
#   3. the platform services the front ends need, from ../platform-services, in the background
#   4. a table of URLs
#
# Flags / env:
#   ESTATE_NO_DOCKER=1        force the in-process path even when Docker is present (also what the
#                             build agents do, they have no daemon)
#   ESTATE_SKIP_PUBLISH=1     skip step 2 (registry already populated)
#   ESTATE_SKIP_SERVICES=1    mocks only, do not start platform-services
#   ESTATE_SERVICES="bff-retail bedrock-adapter"   subset of platform services to start
#   ESTATE_WAIT_SECS=180      how long to wait for health before giving up on a service (still
#                             continues; the table says which ones did not answer)
#
# Anything under ../platform-services that is not present in this checkout is skipped with a
# warning, on purpose: the services land on their own branches and the mocks must not depend on
# them being merged. Same for canopy-ui and lantern-sdk in the publish step.
#
# State lives in mock-external/.estate (pids, logs). estate-down.sh reads it. PLAT-2244, PLAT-2301.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
STATE="$HERE/.estate"
LOGS="$STATE/logs"
SERVICES_ROOT="$REPO_ROOT/platform-services"
WAIT_SECS="${ESTATE_WAIT_SECS:-180}"
mkdir -p "$LOGS"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
log()   { printf '[estate-up] %s\n' "$*"; }
warn()  { printf '[estate-up] WARN %s\n' "$*" >&2; }
step()  { printf '\n[estate-up] == %s ==\n' "$*"; }

# shellcheck disable=SC1091
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi
use_node() {
  if command -v nvm >/dev/null 2>&1; then
    nvm use "$1" >/dev/null 2>&1 || { warn "node $1 not installed under nvm, using $(node -v 2>/dev/null || echo none)"; }
  fi
}

docker_ok() {
  [ "${ESTATE_NO_DOCKER:-0}" != "1" ] \
    && command -v docker >/dev/null 2>&1 \
    && docker info >/dev/null 2>&1 \
    && docker compose version >/dev/null 2>&1
}

wait_http() { # url secs -> 0/1
  local url="$1" secs="${2:-$WAIT_SECS}" i
  for ((i = 0; i < secs; i++)); do
    if curl -fs -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_tcp() { # host port secs
  local host="$1" port="$2" secs="${3:-$WAIT_SECS}" i
  for ((i = 0; i < secs; i++)); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 1
  done
  return 1
}

MODE="in-process"
if docker_ok; then MODE="docker"; fi
if [ "${ESTATE_NO_DOCKER:-0}" = "1" ]; then log "ESTATE_NO_DOCKER=1, not touching Docker"; fi
echo "$MODE" > "$STATE/mode"
log "mode: $MODE   (repo: $REPO_ROOT)"

# ------------------------------------------------------------------------------------------------
step "1/4 registry"
if ! ESTATE_NO_DOCKER="${ESTATE_NO_DOCKER:-0}" bash "$HERE/scripts/verdaccio-up.sh"; then
  warn "Verdaccio did not start; npm installs against @meridian/* will fall back to file: deps"
fi

# ------------------------------------------------------------------------------------------------
step "2/4 internal packages"
if [ "${ESTATE_SKIP_PUBLISH:-0}" = "1" ]; then
  log "ESTATE_SKIP_PUBLISH=1, skipping"
elif curl -fs -o /dev/null http://localhost:4873/-/ping; then
  bash "$HERE/scripts/publish-internal.sh" || warn "some internal packages did not publish (see above); continuing"
else
  warn "registry down, skipping publish"
fi

# ------------------------------------------------------------------------------------------------
step "3/4 external mocks and infrastructure ($MODE)"
MOCK_NAMES=(keystone-idp-mock bedrock-core-mock aggregio-mock tickerhaus-mock triscore-mock paylink-network-mock vault-mock splunk-hec-mock lantern-collector-mock semaphore-flags-mock ldap-mock)
MOCK_PORTS=(4400 4600 4601 4602 4603 4604 4605 4606 4607 4608 4609)
MOCK_HEALTH=(4400 4600 4601 4602 4603 4604 4605 4606 4607 4608 14609)

INFRA_STATUS_REDPANDA="skipped (no Docker; Java services use profile local-inmem-kafka)"
INFRA_STATUS_REDIS="skipped (no Docker; services fall back to in-memory map)"
INFRA_STATUS_MQ="skipped (no Docker; Java services embed Artemis under profile local-artemis)"

if [ "$MODE" = "docker" ]; then
  # PLAT-2705: a leftover in-process mock (previous run, ESTATE_NO_DOCKER, someone debugging) holds
  # a 46xx port and compose fails with "address already in use". Only touch listeners that are
  # clearly ours (node dist/main.js from this directory); anything else is reported and left alone.
  for port in "${MOCK_PORTS[@]}" 14609; do
    for pid in $(ss -ltnp 2>/dev/null | sed -n "s/.*:$port .*pid=\([0-9]*\).*/\1/p" | sort -u); do
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "dist/main.js"; then
        warn "port $port held by a stale in-process mock (pid $pid), stopping it before compose"
        kill "$pid" 2>/dev/null || true
      else
        warn "port $port is in use by pid $pid and it is not one of our mocks; compose will probably fail on it"
      fi
    done
  done
  rm -f "$STATE/pids"
  log "docker compose up -d --build (output in $LOGS/compose-up.log)"
  if ! ( cd "$HERE" && docker compose up -d --build --quiet-pull --remove-orphans >"$LOGS/compose-up.log" 2>&1 ); then
    warn "docker compose up returned non-zero, checking what is up anyway:"; tail -20 "$LOGS/compose-up.log" >&2
  fi
  INFRA_STATUS_REDPANDA="compose"
  INFRA_STATUS_REDIS="compose"
  if docker compose -f "$HERE/docker-compose.yml" ps --status running --services 2>/dev/null | grep -q '^ibm-mq$'; then
    INFRA_STATUS_MQ="compose (ibm-mq profile)"
  else
    INFRA_STATUS_MQ="compose (artemis; ibm-mq profile off, see docker-compose.yml)"
  fi
else
  use_node 18.19.0
  if [ ! -d "$HERE/node_modules/express" ]; then
    log "installing mock-external dependencies (npm ci)"
    ( cd "$HERE" && npm ci --ignore-scripts ) || warn "npm ci failed; the mocks probably will not start"
  fi
  if [ ! -f "$HERE/keystone-idp-mock/dist/main.js" ] || [ "${ESTATE_REBUILD:-0}" = "1" ]; then
    log "building mocks (tsc)"
    ( cd "$HERE" && npm run build ) || warn "mock build failed; see errors above"
  fi
  # ask nicely first if a previous run is still around
  if [ -f "$STATE/pids" ]; then
    log "previous in-process run found, stopping it first"
    bash "$HERE/estate-down.sh" --mocks-only >/dev/null 2>&1 || true
  fi
  ( cd "$HERE" && node scripts/start-all.js --daemon )
fi

MOCK_STATUS=()
for i in "${!MOCK_NAMES[@]}"; do
  if wait_http "http://localhost:${MOCK_HEALTH[$i]}/health" "$WAIT_SECS"; then
    MOCK_STATUS[$i]="up"
  else
    MOCK_STATUS[$i]="NOT ANSWERING"
    warn "${MOCK_NAMES[$i]} did not answer on ${MOCK_HEALTH[$i]} within ${WAIT_SECS}s"
  fi
done

if [ "$MODE" = "docker" ]; then
  wait_tcp 127.0.0.1 9092 "$WAIT_SECS" || INFRA_STATUS_REDPANDA="NOT ANSWERING"
  wait_tcp 127.0.0.1 6379 "$WAIT_SECS" || INFRA_STATUS_REDIS="NOT ANSWERING"
  if [[ "$INFRA_STATUS_MQ" == *artemis* ]]; then
    wait_tcp 127.0.0.1 61616 "$WAIT_SECS" || INFRA_STATUS_MQ="NOT ANSWERING (artemis)"
  else
    wait_tcp 127.0.0.1 1414 "$WAIT_SECS" || INFRA_STATUS_MQ="NOT ANSWERING (ibm-mq)"
  fi
fi

# ------------------------------------------------------------------------------------------------
step "4/4 platform services"
# name:port:kind. kind decides how we start it when there is no Makefile target for it.
# Order matters a little: bedrock-adapter before bff-retail, statements-api before documents.
PLATFORM_SERVICES=(
  "bedrock-adapter:4516:java"
  "beacon-notifications:4510:java"
  "alerts-preferences-service:4511:java"
  "txn-posting-service:4512:java"
  "pii-vault-service:4513:java"
  "audit-trail-service:4514:java"
  "entitlements-service:4515:java17"
  "statements-api:4519:python"
  "exposure-calc:4520:python"
  "bff-retail:4500:node"
  "bff-business:4501:node"
  "iris-orchestrator:4517:node"
  "documents-service:4518:node"
)

SERVICE_ROWS=()
: > "$STATE/service-pids"

# Common environment the services read (mirrors platform-services/.env.local in the brief).
export KEYSTONE_ISSUER="${KEYSTONE_ISSUER:-http://localhost:4400}"
export KEYSTONE_JWKS_URI="${KEYSTONE_JWKS_URI:-http://localhost:4400/.well-known/jwks.json}"
export SPLUNK_HEC_URL="${SPLUNK_HEC_URL:-http://localhost:4606/services/collector/event}"
export SPLUNK_HEC_TOKEN="${SPLUNK_HEC_TOKEN:-CHANGEME-hec-token}"
# No filebeat sidecar outside the cluster: the Node BFFs post to HEC themselves (INC0048817).
export MERIDIAN_HEC_DIRECT="${MERIDIAN_HEC_DIRECT:-true}"
export VAULT_ADDR="${VAULT_ADDR:-http://localhost:4605}"
export VAULT_TOKEN="${VAULT_TOKEN:-CHANGEME-vault-root-token}"
export SEMAPHORE_URL="${SEMAPHORE_URL:-http://localhost:4608}"
export BEDROCK_CORE_URL="${BEDROCK_CORE_URL:-http://localhost:4600}"
# Adapter base includes its servlet path; the BFFs append /customers/... to it (PLAT-2719).
export BEDROCK_ADAPTER_URL="${BEDROCK_ADAPTER_URL:-http://localhost:4516/bedrock/v1}"
export AGGREGIO_URL="${AGGREGIO_URL:-http://localhost:4601}"
export TICKERHAUS_URL="${TICKERHAUS_URL:-http://localhost:4602}"
export TRISCORE_URL="${TRISCORE_URL:-http://localhost:4603}"
export PAYLINK_URL="${PAYLINK_URL:-http://localhost:4604}"
export LANTERN_COLLECTOR_URL="${LANTERN_COLLECTOR_URL:-http://localhost:4607}"
# 127.0.0.1, not localhost: Node 18 resolves localhost to ::1 first and uvicorn only binds v4 (PLAT-2720).
export STATEMENTS_API_URL="${STATEMENTS_API_URL:-http://127.0.0.1:4519}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export KAFKA_BOOTSTRAP_SERVERS="${KAFKA_BOOTSTRAP_SERVERS:-localhost:9092}"
if [ "$MODE" = "docker" ]; then
  export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-local,local-artemis}"
  export ESTATE_MESSAGING="${ESTATE_MESSAGING:-artemis}"
else
  export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-local,local-artemis,local-inmem-kafka,local-inmem-redis}"
  export ESTATE_MESSAGING="${ESTATE_MESSAGING:-embedded}"
  export REDIS_DISABLED=1
fi

start_service() { # name port kind
  local name="$1" port="$2" kind="$3" dir="$SERVICES_ROOT/$1" cmd=""
  if [ ! -d "$dir" ]; then
    warn "$name: $dir not present in this checkout, SKIPPED (platform-services branch not merged yet)"
    SERVICE_ROWS+=("$name|$port|skipped: directory absent")
    return
  fi
  # prefer whatever the service's own tooling says
  if [ -f "$dir/Makefile" ] && grep -qE '^run:' "$dir/Makefile"; then
    cmd="make -C '$dir' run"
  elif [ -f "$SERVICES_ROOT/Makefile" ] && grep -qE "^run-$name:" "$SERVICES_ROOT/Makefile"; then
    cmd="make -C '$SERVICES_ROOT' run-$name"
  else
    case "$kind" in
      node)
        if [ -f "$dir/package.json" ]; then
          if [ ! -d "$dir/node_modules" ]; then
            log "$name: npm ci"
            ( cd "$dir" && use_node 18.19.0 && npm ci --ignore-scripts >>"$LOGS/$name.log" 2>&1 ) || warn "$name: npm ci failed, trying to start anyway"
          fi
          if node -e "process.exit(require('$dir/package.json').scripts?.['start:local'] ? 0 : 1)" 2>/dev/null; then
            cmd="cd '$dir' && npm run start:local"
          else
            cmd="cd '$dir' && npm start"
          fi
        fi ;;
      java|java17)
        if [ -f "$dir/pom.xml" ]; then
          if ! command -v mvn >/dev/null 2>&1 && [ ! -x "$dir/mvnw" ]; then
            warn "$name: no mvn on PATH and no mvnw, SKIPPED"; SERVICE_ROWS+=("$name|$port|skipped: no maven"); return
          fi
          local mvn="mvn"; [ -x "$dir/mvnw" ] && mvn="./mvnw"
          local jar
          jar=$(ls "$dir"/target/*.jar 2>/dev/null | grep -v -E 'sources|javadoc|original' | head -1 || true)
          if [ -n "$jar" ]; then
            cmd="cd '$dir' && java -jar '$jar' --server.port=$port"
          else
            cmd="cd '$dir' && $mvn -q -o spring-boot:run -Dspring-boot.run.arguments=--server.port=$port 2>/dev/null || $mvn -q spring-boot:run -Dspring-boot.run.arguments=--server.port=$port"
          fi
        fi ;;
      python)
        if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/requirements.txt" ]; then
          local py="python3"; [ -x "$dir/.venv/bin/python" ] && py="$dir/.venv/bin/python"
          local module="app.main:app"; [ -f "$dir/main.py" ] && module="main:app"
          cmd="cd '$dir' && $py -m uvicorn $module --port $port"
        fi ;;
    esac
  fi
  if [ -z "$cmd" ]; then
    warn "$name: directory exists but no recognised entry point, SKIPPED"
    SERVICE_ROWS+=("$name|$port|skipped: no entry point")
    return
  fi
  use_node 18.19.0
  log "$name: starting on $port  ($cmd)"
  nohup bash -c "$cmd" >>"$LOGS/$name.log" 2>&1 &
  echo "$name $!" >> "$STATE/service-pids"
  SERVICE_ROWS+=("$name|$port|starting")
}

health_wait() { # /health, /actuator/health, /healthz, whichever answers; the clock runs once, not per service
  local deadline=$((SECONDS + WAIT_SECS))
  for i in "${!SERVICE_ROWS[@]}"; do
    IFS='|' read -r name port status <<<"${SERVICE_ROWS[$i]}"
    [ "$status" = "starting" ] || continue
    ok=0
    while :; do
      for path in /health /actuator/health /healthz /api/v1/health; do
        if curl -fs -o /dev/null --max-time 2 "http://localhost:$port$path"; then ok=1; break 2; fi
      done
      [ $SECONDS -lt $deadline ] || break
      sleep 1
    done
    if [ $ok = 1 ]; then SERVICE_ROWS[$i]="$name|$port|up"; else SERVICE_ROWS[$i]="$name|$port|NOT ANSWERING (see logs)"; fi
  done
}

if [ "${ESTATE_SKIP_SERVICES:-0}" = "1" ]; then
  log "ESTATE_SKIP_SERVICES=1, not starting platform services"
elif [ ! -d "$SERVICES_ROOT" ]; then
  warn "$SERVICES_ROOT does not exist; no platform services started. Front ends will get 502s from the BFF ports."
elif [ -x "$SERVICES_ROOT/scripts/run-local.sh" ]; then
  # PLAT-2706: platform-services owns its own process supervisor; it knows jars vs dist vs venvs
  # and the start order. We only hand it the mock URLs above and read its pids back for estate-down.
  log "platform-services: scripts/run-local.sh start ${ESTATE_SERVICES:-}"
  # shellcheck disable=SC2086
  if ! "$SERVICES_ROOT/scripts/run-local.sh" start ${ESTATE_SERVICES:-} >>"$LOGS/platform-services.log" 2>&1; then
    warn "platform-services: run-local.sh reported a problem (jars/dist missing? run 'make -C platform-services install build'); see $LOGS/platform-services.log"
  fi
  for entry in "${PLATFORM_SERVICES[@]}"; do
    IFS=: read -r name port kind <<<"$entry"
    if [ -n "${ESTATE_SERVICES:-}" ] && ! printf ' %s ' "$ESTATE_SERVICES" | grep -q " $name "; then continue; fi
    if [ -f "$SERVICES_ROOT/var/$name.pid" ]; then
      echo "$name $(cat "$SERVICES_ROOT/var/$name.pid")" >> "$STATE/service-pids"
      SERVICE_ROWS+=("$name|$port|starting")
    else
      SERVICE_ROWS+=("$name|$port|NOT STARTED (see $LOGS/platform-services.log)")
    fi
  done
  health_wait
else
  for entry in "${PLATFORM_SERVICES[@]}"; do
    IFS=: read -r name port kind <<<"$entry"
    if [ -n "${ESTATE_SERVICES:-}" ] && ! printf ' %s ' "$ESTATE_SERVICES" | grep -q " $name "; then continue; fi
    start_service "$name" "$port" "$kind"
  done
  health_wait
fi

# ------------------------------------------------------------------------------------------------
echo
bold "Meridian Trust Bank - local estate ($MODE)"
printf '%-28s %-7s %-32s %s\n' "component" "port" "url" "status"
printf '%-28s %-7s %-32s %s\n' "---------" "----" "---" "------"
printf '%-28s %-7s %-32s %s\n' "verdaccio (registry)" 4873 "http://localhost:4873" "$(curl -fs -o /dev/null http://localhost:4873/-/ping && echo up || echo 'NOT ANSWERING')"
for i in "${!MOCK_NAMES[@]}"; do
  printf '%-28s %-7s %-32s %s\n' "${MOCK_NAMES[$i]}" "${MOCK_PORTS[$i]}" "http://localhost:${MOCK_PORTS[$i]}" "${MOCK_STATUS[$i]}"
done
printf '%-28s %-7s %-32s %s\n' "redpanda (kafka)" 9092 "localhost:9092" "$INFRA_STATUS_REDPANDA"
printf '%-28s %-7s %-32s %s\n' "redis" 6379 "redis://localhost:6379" "$INFRA_STATUS_REDIS"
printf '%-28s %-7s %-32s %s\n' "mq (ibm-mq | artemis)" "1414/61616" "http://localhost:8161 (artemis console)" "$INFRA_STATUS_MQ"
for row in "${SERVICE_ROWS[@]}"; do
  IFS='|' read -r name port status <<<"$row"
  printf '%-28s %-7s %-32s %s\n' "$name" "$port" "http://localhost:$port" "$status"
done
echo
echo "front ends (start them yourself, ng serve in each app): retail-web 4200, business-web 4201, keystone-web 4202, ledgerline-web 4203, canopy-showcase 4204, iris-widget 4205"
echo "login: any fixture user (see http://localhost:4400/debug/users), password Passw0rd, MFA code 123456"
echo "logs: $LOGS     stop: $HERE/estate-down.sh     check: $HERE/smoke.sh"
