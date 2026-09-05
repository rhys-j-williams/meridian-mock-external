#!/usr/bin/env bash
# smoke.sh - end to end checks against a running local estate (see estate-up.sh).
#
# Exit status: non-zero if ANY check fails. Checks whose service is not in this checkout, or whose
# port does not answer because the service was not started, are reported as SKIPPED and do not
# fail the run; that is deliberate so the mocks can be smoke tested on their own before the
# platform-services branch is merged. Set SMOKE_STRICT=1 to turn skips into failures (CI does).
#
# Checks, in order:
#   1  keystone      authorization code + PKCE with a fixture user, ID token validates against JWKS
#   2  bff-retail    GET /api/v1/accounts with that token returns Bedrock backed balances
#   3  beacon        three ACCT.EVENTS for one customer -> three console dispatches, in order, <10s
#   4  documents     statement PDF is non-empty and starts with %PDF
#   5  lantern       a track event lands in lantern-collector-mock
#   6  splunk        the accounts request's correlation id shows events from bff-retail AND
#                    bedrock-adapter
#   plus a health sweep across every mock first, because when that fails nothing else matters
#
# The platform service endpoints below are what the brief (section 6.8) and the BFF's README say.
# They are variables so a rename on the other team's branch is a one line change here, not a
# rewrite. PLAT-2244.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SERVICES_ROOT="$REPO_ROOT/platform-services"
STATE="$HERE/.estate"
mkdir -p "$STATE"
MODE="$(cat "$STATE/mode" 2>/dev/null || echo unknown)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/estate-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

KEYSTONE_URL="${KEYSTONE_URL:-http://localhost:4400}"
BFF_RETAIL_URL="${BFF_RETAIL_URL:-http://localhost:4500}"
BFF_ACCOUNTS_PATH="${BFF_ACCOUNTS_PATH:-/api/v1/accounts}"
BEACON_URL="${BEACON_URL:-http://localhost:4510}"
# console channel adapter exposes what it "sent" for exactly this purpose (beacon-notifications
# ConsoleChannelAdapter, /debug/dispatches?customerId=...). Ordering is by sequence number.
BEACON_DISPATCH_PATH="${BEACON_DISPATCH_PATH:-/debug/dispatches}"
# optional HTTP ingest shortcut when no broker is reachable (Beacon local profile)
BEACON_INGEST_PATH="${BEACON_INGEST_PATH:-/debug/ingest}"
DOCUMENTS_URL="${DOCUMENTS_URL:-http://localhost:4518}"
DOCUMENTS_STATEMENT_PATH="${DOCUMENTS_STATEMENT_PATH:-/api/v1/statements}"   # /:accountId/latest.pdf
BEDROCK_URL="${BEDROCK_URL:-http://localhost:4600}"
LANTERN_URL="${LANTERN_URL:-http://localhost:4607}"
LANTERN_WRITE_KEY="${LANTERN_WRITE_KEY:-CHANGEME-lantern-write-key}"
SPLUNK_URL="${SPLUNK_URL:-http://localhost:4606}"
SPLUNK_HEC_TOKEN="${SPLUNK_HEC_TOKEN:-CHANGEME-hec-token}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-meridian-online-web}"
OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI:-http://localhost:4200/index.html}"
BEACON_TIMEOUT_SECS=10

PASSED=(); FAILED=(); SKIPPED=()
pass() { PASSED+=("$1"); printf '  PASS  %s\n' "$1"; }
fail() { FAILED+=("$1: $2"); printf '  FAIL  %s -- %s\n' "$1" "$2"; }
skip() {
  if [ "${SMOKE_STRICT:-0}" = "1" ]; then fail "$1" "SKIPPED but SMOKE_STRICT=1: $2"; return; fi
  SKIPPED+=("$1: $2"); printf '  SKIP  %s -- %s\n' "$1" "$2"
}
hdr() { printf '\n[%s] %s\n' "$1" "$2"; }

# shellcheck disable=SC1091
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 18.19.0 >/dev/null 2>&1 || true; fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node is required for smoke.sh (JSON handling, PKCE)"; exit 2; fi

json() { # json <expr> ; reads stdin, evaluates JS expr against `d`
  "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch(e){process.exit(3)};const r=eval(process.argv[1]);process.stdout.write(r===undefined||r===null?"":String(typeof r==="object"?JSON.stringify(r):r))})' "$1"
}
up() { curl -fs -o /dev/null --max-time 3 "$1"; }
service_present() { [ -d "$SERVICES_ROOT/$1" ]; }
service_reason() { # name port
  if ! service_present "$1"; then echo "platform-services/$1 not in this checkout (other team's branch)"; return; fi
  echo "$1 not answering on $2 (not started, or failed; see .estate/logs/$1.log)"
}

echo "meridian estate smoke, mode=$MODE, $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ------------------------------------------------------------------------------------------------
hdr 0 "mock health sweep"
MOCK_NAMES=(keystone-idp-mock bedrock-core-mock aggregio-mock tickerhaus-mock triscore-mock paylink-network-mock vault-mock splunk-hec-mock lantern-collector-mock semaphore-flags-mock ldap-mock)
MOCK_HEALTH=(4400 4600 4601 4602 4603 4604 4605 4606 4607 4608 14609)
for i in "${!MOCK_NAMES[@]}"; do
  if up "http://localhost:${MOCK_HEALTH[$i]}/health"; then pass "health ${MOCK_NAMES[$i]}"; else fail "health ${MOCK_NAMES[$i]}" "no 200 from :${MOCK_HEALTH[$i]}/health"; fi
done
if up http://localhost:4873/-/ping; then pass "health verdaccio"; else fail "health verdaccio" "registry not answering on 4873"; fi

# ------------------------------------------------------------------------------------------------
hdr 1 "keystone login (authorization code + PKCE, fixture user, MFA 123456)"
TOKEN=""; USER_SUB=""; USERNAME=""
if ! up "$KEYSTONE_URL/.well-known/openid-configuration"; then
  fail "keystone discovery" "no discovery document at $KEYSTONE_URL"
else
  USERS_JSON=$(curl -fs "$KEYSTONE_URL/debug/users")
  USERNAME=$(printf '%s' "$USERS_JSON" | json 'd[3].username')
  USER_SUB=$(printf '%s' "$USERS_JSON" | json 'd[3].sub')
  VERIFIER=$("$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
  CHALLENGE=$("$NODE" -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("base64url"))' "$VERIFIER")
  STATE_P="smoke-$RANDOM"; NONCE="n-$RANDOM"
  # PLAT-2702: the first authorize after a cold start has come back without the login page once in
  # a few runs; retry a couple of times and keep the status + body head for the failure message.
  TXN=""; AUTHZ_HTTP=""; AUTHZ_ATTEMPT=0
  while [ -z "$TXN" ] && [ "$AUTHZ_ATTEMPT" -lt 3 ]; do
    AUTHZ_ATTEMPT=$((AUTHZ_ATTEMPT+1))
    [ "$AUTHZ_ATTEMPT" -gt 1 ] && sleep 1
    AUTHZ_HTTP=$(curl -s -o "$TMP/authorize.html" -w '%{http_code}' -G "$KEYSTONE_URL/oauth2/v1/authorize" \
      --data-urlencode "client_id=$OIDC_CLIENT_ID" --data-urlencode "redirect_uri=$OIDC_REDIRECT_URI" \
      --data-urlencode "response_type=code" --data-urlencode "scope=openid profile email offline_access accounts.read" \
      --data-urlencode "state=$STATE_P" --data-urlencode "nonce=$NONCE" \
      --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" || echo "curl-$?")
    TXN=$(tr -d '\n' <"$TMP/authorize.html" | sed -n 's/.*name="txn" value="\([^"]*\)".*/\1/p' | head -1)
  done
  if [ -z "$TXN" ]; then
    fail "keystone authorize" "login page did not carry a txn field after $AUTHZ_ATTEMPT attempts (HTTP $AUTHZ_HTTP): $(head -c 160 "$TMP/authorize.html" | tr -d '\n')"
  else
    LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$KEYSTONE_URL/login" --data-urlencode "txn=$TXN" --data-urlencode "username=$USERNAME" --data-urlencode "password=Passw0rd")
    MFA_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$KEYSTONE_URL/mfa" --data-urlencode "txn=$TXN" --data-urlencode "code=123456")
    CODE=$(printf '%s' "$MFA_LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
    if [ "$LOGIN_CODE" != "303" ] || [ -z "$CODE" ]; then
      fail "keystone login+mfa" "login status $LOGIN_CODE, redirect '$MFA_LOC'"
    else
      TOKENS=$(curl -s -X POST "$KEYSTONE_URL/oauth2/v1/token" --data-urlencode "grant_type=authorization_code" \
        --data-urlencode "client_id=$OIDC_CLIENT_ID" --data-urlencode "code=$CODE" \
        --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "redirect_uri=$OIDC_REDIRECT_URI")
      TOKEN=$(printf '%s' "$TOKENS" | json 'd.access_token')
      ID_TOKEN=$(printf '%s' "$TOKENS" | json 'd.id_token')
      if [ -z "$TOKEN" ] || [ -z "$ID_TOKEN" ]; then
        fail "keystone token" "token endpoint said: $(printf '%s' "$TOKENS" | head -c 200)"
      else
        # verify the ID token signature against the JWKS the way bff-retail does (jose is in node_modules)
        VERIFY=$(cd "$HERE" && "$NODE" -e '
          const { createRemoteJWKSet, jwtVerify } = require("jose");
          const [issuer, jwks, tok, nonce] = process.argv.slice(1);
          jwtVerify(tok, createRemoteJWKSet(new URL(jwks)), { issuer })
            .then(({ payload }) => { if (payload.nonce !== nonce) throw new Error("nonce mismatch"); if (!Array.isArray(payload.amr) || !payload.mfa_at) throw new Error("amr/mfa_at missing"); process.stdout.write("ok " + payload.sub + " amr=" + payload.amr.join(",")); })
            .catch((e) => { process.stdout.write("bad " + e.message); process.exit(1); });' \
          "$KEYSTONE_URL" "$KEYSTONE_URL/.well-known/jwks.json" "$ID_TOKEN" "$NONCE" 2>&1)
        if [[ "$VERIFY" == ok* ]]; then pass "keystone PKCE login as $USERNAME, ID token verified via JWKS ($VERIFY)"; else fail "keystone JWKS verify" "$VERIFY"; fi
      fi
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------
hdr 2 "bff-retail accounts with Bedrock backed balances"
ACCOUNTS_CORR="smoke-$(date +%s)-$RANDOM"
ACCOUNT_ID=""
if ! up "$BFF_RETAIL_URL/health" && ! up "$BFF_RETAIL_URL$BFF_ACCOUNTS_PATH"; then
  skip "bff-retail accounts" "$(service_reason bff-retail 4500)"
elif [ -z "$TOKEN" ]; then
  skip "bff-retail accounts" "no token from step 1"
else
  RESP=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" -H "X-Correlation-Id: $ACCOUNTS_CORR" "$BFF_RETAIL_URL$BFF_ACCOUNTS_PATH")
  HTTP=$(printf '%s' "$RESP" | tail -1); BODY=$(printf '%s' "$RESP" | sed '$d')
  COUNT=$(printf '%s' "$BODY" | json '(Array.isArray(d)?d:(d.accounts||d.items||d.data||[])).length' 2>/dev/null || echo 0)
  ACCOUNT_ID=$(printf '%s' "$BODY" | json 'const a=(Array.isArray(d)?d:(d.accounts||d.items||d.data||[]))[0]||{}; a.accountId||a.id||""' 2>/dev/null || true)
  if [ "$HTTP" != "200" ] || [ "${COUNT:-0}" -lt 1 ]; then
    fail "bff-retail accounts" "HTTP $HTTP, $COUNT accounts: $(printf '%s' "$BODY" | head -c 200)"
  else
    # cross-check against the ledger: the first account's balance must match what Bedrock holds
    BFF_BAL=$(printf '%s' "$BODY" | json 'const a=(Array.isArray(d)?d:(d.accounts||d.items||d.data||[]))[0]; a.currentBalanceMinor ?? a.balanceMinor ?? Math.round(Number(a.currentBalance ?? a.balance ?? 0)*100)')
    LEDGER_BAL=$(curl -s "$BEDROCK_URL/debug/accounts/$ACCOUNT_ID" | json 'd.currentBalanceMinor' 2>/dev/null || true)
    if [ -n "$LEDGER_BAL" ] && [ "$BFF_BAL" = "$LEDGER_BAL" ]; then
      pass "bff-retail returned $COUNT accounts, balance of $ACCOUNT_ID matches Bedrock ($LEDGER_BAL minor)"
    elif [ -n "$LEDGER_BAL" ]; then
      fail "bff-retail balances" "account $ACCOUNT_ID: bff says $BFF_BAL, bedrock-core-mock says $LEDGER_BAL"
    else
      fail "bff-retail balances" "account $ACCOUNT_ID from the BFF is unknown to bedrock-core-mock (not Bedrock backed?)"
    fi
  fi
fi
# fall back to the ledger directly for later steps that just need an account for this customer
if [ -z "$ACCOUNT_ID" ] && [ -n "$USER_SUB" ]; then
  ACCOUNT_ID=$(curl -s "$BEDROCK_URL/debug/accounts?customerId=$USER_SUB" | json 'd[0]?.accountId' 2>/dev/null || true)
fi

# ------------------------------------------------------------------------------------------------
hdr 3 "beacon: three ACCT.EVENTS for $USER_SUB -> console channel adapter, ordered, within ${BEACON_TIMEOUT_SECS}s"
if ! up "$BEACON_URL/actuator/health" && ! up "$BEACON_URL/health"; then
  skip "beacon ordered dispatch" "$(service_reason beacon-notifications 4510)"
elif [ -z "$USER_SUB" ]; then
  skip "beacon ordered dispatch" "no customer from step 1"
else
  RUN_ID="smoke-$(date +%s%N)"
  EVENT_IDS=()
  publish_ok=1
  for seq in 1 2 3; do
    EVENT_ID="$RUN_ID-$seq"; EVENT_IDS+=("$EVENT_ID")
    AMOUNT=$((seq * 1250))
    PAYLOAD=$(printf '{"eventId":"%s","eventType":"TRANSACTION_POSTED","customerId":"%s","accountId":"%s","sequence":%d,"amountMinor":%d,"currency":"USD","description":"smoke posting %d","occurredAt":"%s","correlationId":"%s"}' \
      "$EVENT_ID" "$USER_SUB" "${ACCOUNT_ID:-unknown}" "$seq" "$AMOUNT" "$seq" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID")
    if up "$BEACON_URL$BEACON_INGEST_PATH" 2>/dev/null || curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BEACON_URL$BEACON_INGEST_PATH" | grep -qE '^(200|204|405)$'; then
      curl -fs -o /dev/null -X POST -H 'content-type: application/json' -d "$PAYLOAD" "$BEACON_URL$BEACON_INGEST_PATH" || publish_ok=0
    elif [ "$MODE" = "docker" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^estate-redpanda$'; then
      printf '%s\n' "$PAYLOAD" | docker exec -i estate-redpanda rpk topic produce ACCT.EVENTS -k "$USER_SUB" >/dev/null 2>&1 || publish_ok=0
    elif (exec 3<>/dev/tcp/127.0.0.1/61613) 2>/dev/null; then
      printf '%s' "$PAYLOAD" | (cd "$HERE" && "$NODE" scripts/mq-publish.js ACCT.EVENTS --header "JMSXGroupID=$USER_SUB" --header "correlationId=$RUN_ID") || publish_ok=0
    else
      publish_ok=0
    fi
  done
  if [ $publish_ok = 0 ]; then
    fail "beacon publish" "could not put events on ACCT.EVENTS (no ingest endpoint, no redpanda, no STOMP on 61613)"
  else
    deadline=$((SECONDS + BEACON_TIMEOUT_SECS)); result=""
    while [ $SECONDS -lt $deadline ]; do
      DISPATCHES=$(curl -s "$BEACON_URL$BEACON_DISPATCH_PATH?customerId=$USER_SUB&channel=console&limit=50")
      result=$(printf '%s' "$DISPATCHES" | json "const list=(Array.isArray(d)?d:(d.dispatches||d.items||d.content||[])); const want=${RUN_ID@Q}; const seen=list.filter(x=>String(x.eventId||x.sourceEventId||(x.event&&x.event.eventId)||'').startsWith(want)).map(x=>String(x.eventId||x.sourceEventId||x.event.eventId)); seen.length>=3?seen.join(','):''" 2>/dev/null || true)
      [ -n "$result" ] && break
      sleep 1
    done
    EXPECTED="${EVENT_IDS[0]},${EVENT_IDS[1]},${EVENT_IDS[2]}"
    if [ -z "$result" ]; then
      fail "beacon ordered dispatch" "fewer than 3 console dispatches for $USER_SUB within ${BEACON_TIMEOUT_SECS}s"
    elif [ "$result" = "$EXPECTED" ]; then
      pass "beacon dispatched 3 console alerts for $USER_SUB in sequence order"
    else
      fail "beacon ordering" "got $result, expected $EXPECTED (T44 territory)"
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------
hdr 4 "documents-service statement PDF"
if ! up "$DOCUMENTS_URL/health"; then
  skip "documents statement pdf" "$(service_reason documents-service 4518)"
elif [ -z "$ACCOUNT_ID" ]; then
  skip "documents statement pdf" "no account id to ask for"
else
  PDF="$STATE/smoke-statement.pdf"
  HTTP=$(curl -s -o "$PDF" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$DOCUMENTS_URL$DOCUMENTS_STATEMENT_PATH/$ACCOUNT_ID/latest.pdf")
  SIZE=$(stat -c %s "$PDF" 2>/dev/null || echo 0)
  MAGIC=$(head -c 4 "$PDF" 2>/dev/null || true)
  if [ "$HTTP" = "200" ] && [ "$SIZE" -gt 512 ] && [ "$MAGIC" = "%PDF" ]; then
    pass "documents-service returned a ${SIZE} byte PDF for $ACCOUNT_ID"
  else
    fail "documents statement pdf" "HTTP $HTTP, $SIZE bytes, magic '$MAGIC'"
  fi
  rm -f "$PDF"
fi

# ------------------------------------------------------------------------------------------------
hdr 5 "lantern event lands in the collector"
if ! up "$LANTERN_URL/health"; then
  fail "lantern collector" "not answering on $LANTERN_URL"
else
  MSG_ID="smoke-$(date +%s%N)"
  SEND=$(curl -s -X POST -H 'content-type: application/json' -H "X-Lantern-Write-Key: $LANTERN_WRITE_KEY" \
    -d "{\"messageId\":\"$MSG_ID\",\"event\":\"smoke.check\",\"userId\":\"${USER_SUB:-anonymous}\",\"sessionId\":\"$MSG_ID\",\"properties\":{\"source\":\"smoke.sh\"},\"context\":{\"library\":{\"name\":\"lantern-sdk\",\"version\":\"2.4.1\"}}}" \
    "$LANTERN_URL/v1/track")
  FOUND=$(curl -s "$LANTERN_URL/v1/events?event=smoke.check&sessionId=$MSG_ID" | json 'd.count' 2>/dev/null || echo 0)
  if [ "${FOUND:-0}" -ge 1 ]; then pass "lantern track event $MSG_ID stored (collector count=$FOUND)"; else fail "lantern event" "sent: $(printf '%s' "$SEND" | head -c 120); found: $FOUND"; fi
  # the vendor script the SDK loads must be served too
  SCRIPT_FILE="$TMP/lantern.min.js"
  SCRIPT_HTTP=$(curl -s -o "$SCRIPT_FILE" -w '%{http_code}' "$LANTERN_URL/lantern.min.js" || echo "curl-$?")
  SCRIPT_HITS=$(grep -c 'window.Lantern' "$SCRIPT_FILE" 2>/dev/null || echo 0)
  if [ "$SCRIPT_HTTP" = "200" ] && [ "$SCRIPT_HITS" -ge 1 ]; then pass "lantern.min.js served ($(wc -c <"$SCRIPT_FILE") bytes)"; else fail "lantern.min.js" "HTTP $SCRIPT_HTTP, window.Lantern hits=$SCRIPT_HITS"; fi
fi

# ------------------------------------------------------------------------------------------------
hdr 6 "splunk correlation search for the accounts request ($ACCOUNTS_CORR)"
if ! up "$SPLUNK_URL/health"; then
  fail "splunk search" "splunk-hec-mock not answering"
else
  # the HEC path itself always gets exercised, even when bff-retail is not around to log
  HEC=$(curl -s -X POST -H "Authorization: Splunk $SPLUNK_HEC_TOKEN" -d "{\"event\":{\"message\":\"smoke hec probe\",\"correlationId\":\"$ACCOUNTS_CORR-probe\"},\"source\":\"smoke.sh\",\"sourcetype\":\"_json\",\"fields\":{\"service\":\"smoke\"}}" "$SPLUNK_URL/services/collector/event" | json 'd.code' 2>/dev/null || true)
  if [ "$HEC" = "0" ]; then pass "splunk HEC accepts a token-authenticated event"; else fail "splunk HEC" "HEC code '$HEC'"; fi
  if ! up "$BFF_RETAIL_URL/health" && ! up "$BFF_RETAIL_URL$BFF_ACCOUNTS_PATH"; then
    skip "splunk bff-retail+bedrock-adapter trace" "$(service_reason bff-retail 4500); nothing logged the accounts request"
  else
    SERVICES=""
    for _ in 1 2 3 4 5 6; do
      SERVICES=$(curl -s "$SPLUNK_URL/search?correlationId=$ACCOUNTS_CORR" | json 'd.services.join(",")' 2>/dev/null || true)
      case ",$SERVICES," in *,bff-retail,*) case ",$SERVICES," in *,bedrock-adapter,*) break;; esac;; esac
      sleep 1
    done
    case ",$SERVICES," in
      *,bff-retail,*)
        case ",$SERVICES," in
          *,bedrock-adapter,*) pass "splunk trace $ACCOUNTS_CORR spans [$SERVICES]";;
          *) fail "splunk trace" "bff-retail logged $ACCOUNTS_CORR but bedrock-adapter did not (services: $SERVICES)";;
        esac;;
      *) fail "splunk trace" "no bff-retail events for $ACCOUNTS_CORR (services: '${SERVICES:-none}')";;
    esac
  fi
fi

# ------------------------------------------------------------------------------------------------
echo
printf 'smoke summary: %d passed, %d failed, %d skipped\n' "${#PASSED[@]}" "${#FAILED[@]}" "${#SKIPPED[@]}"
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "skipped (not failures; services absent from this checkout or not started):"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "failed:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
