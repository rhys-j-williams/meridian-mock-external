# mock-external

Local stand-ins for every system outside the estate that the digital channels talk to. Owned by
Platform Engineering (Plano / Chennai), Jira `PLAT`, Slack `#plat-local-estate`. Nothing in here is
production software and nothing in here should ever be reachable from anything but a developer
laptop or a build agent.

Why this exists: before 2022 every squad had its own WireMock folder for the same handful of
vendors and none of them agreed on what an account looked like. `PLAT-1900` consolidated them here,
on top of `@meridian/domain-fixtures`, so the same customer shows the same balance in retail-web,
business-web, the BFF logs and the Bedrock batch report.

## Quick start

```
cd mock-external
./estate-up.sh          # Verdaccio, internal packages, mocks, platform services, port table
./smoke.sh              # end-to-end checks, non-zero exit on any FAIL
./estate-down.sh
```

Node 18.19.0 (`.nvmrc`). Docker is used when it is there; `ESTATE_NO_DOCKER=1` forces the
in-process path, which is also what the Jenkins agents get because Docker-in-Docker is banned
(`GIS-EX-2022-041`). Both paths are exercised by `smoke.sh` in the nightly.

Other switches in `estate-up.sh`: `ESTATE_SKIP_PUBLISH=1`, `ESTATE_SKIP_SERVICES=1`,
`ESTATE_SERVICES="bff-retail bedrock-adapter"`, `ESTATE_WAIT_SECS`, `ESTATE_REBUILD=1`. Runtime state
(pids, logs, Verdaccio storage, HEC data) lives under `.estate/` and is not committed.

Platform services that are not in the checkout are reported as SKIP by both scripts, with the
directory name, rather than failing. That is deliberate: the services land on their own branches and
the mocks have to be usable before they do.

## Ports

From `PORTS.md` at the repo root. Do not pick new ones; the CORS allowlists in the BFFs and the
Keystone client redirect URIs are all keyed to these.

| service | port | notes |
| --- | --- | --- |
| verdaccio | 4873 | npm registry, stands in for Artifactory `npm-meridian` |
| keystone-idp-mock | 4400 | OIDC issuer `http://localhost:4400` |
| bedrock-core-mock | 4600 | REST facade; the real interface is BEDROCK.REQ/RESP |
| aggregio-mock | 4601 | account aggregation vendor |
| tickerhaus-mock | 4602 | FX and index quotes, SSE on `/stream` |
| triscore-mock | 4603 | credit score, identity verification, KBA |
| paylink-network-mock | 4604 | P2P payments network |
| vault-mock | 4605 | KV v2 subset |
| splunk-hec-mock | 4606 | HEC on `/services/collector`, search on `/search` |
| lantern-collector-mock | 4607 | analytics collector, serves `/lantern.min.js` |
| semaphore-flags-mock | 4608 | feature flags |
| ldap-mock | 4609 | staff directory |
| redpanda | 9092 | Kafka API |
| redis | 6379 | |
| ibm-mq | 1414 / 9443 | only with `--profile ibm-mq`, see below |
| artemis | 61616 / 61613 | default broker |
| platform services | 4500-4520 | see `platform-services/README.md` |

## The mocks

Each directory is an npm workspace member with `src/`, a `Dockerfile`, a compose service and
`npm start` for the in-process path. All of them are built on `lib/mock-kit` (Express, JSON logs
with `correlationId`, `/health`, fixture loading, error envelopes, webhook delivery). Port and
behaviour env vars are listed at the top of each `src/server.ts`.

**keystone-idp-mock.** The one that matters. Discovery document, JWKS (two RSA keys generated at boot, current and
previous, because the real Keystone rotates every ninety days and relying parties must pick by kid), authorization code with PKCE, a login page that accepts any fixture
username with `Passw0rd`, an MFA step that accepts `123456`, refresh, userinfo, end-session, and a
SAML stub at `/saml/sso` that returns an unsigned assertion for the ops console tests. ID tokens
carry `amr` (`["pwd","otp"]`) and `mfa_at`. Discovery and JWKS are complete enough for
`angular-oauth2-oidc` on the front ends and `passport-jwt` / Spring Security resource servers on the
back; if you change a claim, run `keystone-idp-mock/src/pkce-flow.spec.ts` first. Clients are in
`src/clients.ts`; redirect URIs are exact-match, like the real Keystone, so `http://localhost:4200`
and `http://localhost:4200/` are different (`MOL-3310`).

**bedrock-core-mock.** The mainframe. Reads 200-byte fixed-width requests off `BEDROCK.REQ` (STOMP
to Artemis, or the in-memory pair when no broker), parses them per
`platform-services/copybooks/`, answers on `BEDROCK.RESP`. Functions `ACCTINQ`, `CUSTACCT`,
`TRANPOST`, `TRANLIST`, `PING`. Amounts are zoned decimal with overpunch sign in the last byte;
return codes `0000 / 0004 / 0008 / 0012`, abend codes `ASRA` (malformed numeric) and `AEY9`
(unknown function). Balances seeded from fixtures, postings kept in memory, end-of-day batch every
`BEDROCK_BATCH_INTERVAL_MINUTES` writing a report under `data/batch/`. REST facade on 4600 mirrors
each function for debugging and for the in-process path. Tests in `src/*.spec.ts` round-trip the
copybooks; `messages.spec.ts` has the overpunch table if you ever need to read a `}` again.

**aggregio-mock.** `/v2/institutions/search`, link flow (`/v2/link/token`, select, exchange), accounts and
balances, and `POST /v2/sandbox/items/:itemId/fire-webhook` to push a balance-update webhook at the
registered URL. Deliveries are visible at `/debug/webhooks`.

**tickerhaus-mock.** FX rates, index quotes, an SSE stream that ticks every second, and
`/v1/quotes/slow` which takes two to six seconds (or `?delayMs=`) because the treasury dashboard
timeout bug (`LDG-2140`) needs somewhere to reproduce.

**triscore-mock.** Score derived deterministically from the fixture customer id (same customer,
same score, every run), identity verification, and three KBA questions with fixture answers.

**paylink-network-mock.** Contact lookup by email or phone, send with `Idempotency-Key` (replays
return the original response, a changed body with the same key is a 422), request money, and a
settlement webhook a few seconds after send.

**vault-mock.** KV v2 read and write under `secret/`, token auth (`X-Vault-Token`, root token
`CHANGEME-vault-root`), `sys/policies/acl` listing, seeded with the placeholder secrets every
service's `application.yml` references. Placeholders are `CHANGEME-*`, nothing real, see R9.

**splunk-hec-mock.** `/services/collector` and `/services/collector/event`, validates
`Authorization: Splunk <token>` against `HEC_TOKENS`, accepts the concatenated-JSON body format the
Splunk logback appender sends, writes NDJSON to `data/hec-<date>.ndjson`, and `/search?correlationId=`
returns every event for one request across services. This is how the demo shows one accounts call
walking from `bff-retail` to `bedrock-adapter`.

**lantern-collector-mock.** `/v1/batch` and `/v1/track|page|identify`, `/v1/summary`, `/v1/events`, and
`/lantern.min.js`, a stand-in for the vendor script that exposes `window.Lantern` with
`track`, `page`, `identify`, a queue it drains on load, and posts here. `@meridian/lantern-sdk`
points at it through `collectorUrl` in the local environments.

**semaphore-flags-mock.** Flags by environment and segment: `paylink_request_money`,
`new_dashboard_v2`, `iris_widget_enabled`, `transfer_limit_uplift`. `lib/semaphore-client` is the
tiny TS client the Node services use; it is published to Verdaccio too.

**ldap-mock.** In-process directory: `ou=staff`, groups `beacon-admins` and `gis-reviewers`, bind
with any staff DN and `Passw0rd`. LDAP over TCP on 4609, plus a REST peek at `/directory` for
debugging.

**verdaccio.** Config in `verdaccio/config.yaml`: anonymous read, one publisher
(`meridian-publisher`, password placeholder in `htpasswd`), uplink to public npm for everything
except `@meridian/*`, which never leaves the building. `scripts/verdaccio-up.sh` starts it (Docker
or `npx verdaccio`), `scripts/publish-internal.sh` builds and publishes `@meridian/domain-fixtures`,
`@meridian/semaphore-client` and `@meridian/lantern-sdk` in that order, skipping any whose directory
is not in the checkout. Storage is `/verdaccio/storage` in the image, `.estate/verdaccio` locally.

## Infrastructure

`docker-compose.yml` brings up Redpanda (Kafka API, 9092), Redis 7 (6379) and Artemis 2.31
(61616 core, 61613 STOMP). IBM MQ is behind `--profile ibm-mq`: the developer image cannot be
pulled from the build agents (`PLAT-2301`) and half the laptops, so it is opt-in and everything
works without it. Queues `ACCT.EVENTS`, `BEACON.OUT`, `BEACON.DLQ`, `BEDROCK.REQ`, `BEDROCK.RESP`
are created at broker start in both cases.

Spring profiles the Java services use against this, documented properly in
`platform-services/libs/java/meridian-messaging`:

- `local-artemis` - JMS over Artemis instead of MQ. Same abstraction, different ConnectionFactory.
  Differences that have bitten us are in `infra/artemis/README.md` (expiry units, auto-create).
- `local-inmem-kafka` - no broker at all, an in-memory topic map. Used when Docker is absent.
  Ordering is preserved per key, nothing else is.
- Redis: with Docker, the real thing. Without, `meridian-cache` falls back to an in-memory map with
  the same TTL semantics and no eviction. Do not load test against it.

### Oracle and DB2 are not here

Ledgerline (Oracle 19c) and the customer master (DB2 z/OS) are not containers. Licences, image size,
and the DB2 image needs more memory than the laptops have. The Java services run **H2 in the matching
compatibility mode** locally: `MODE=Oracle` for the Ledgerline schema, `MODE=DB2` for customer
master. The Flyway migrations are written to the subset both accept, which is why some of them look
odd (`PLAT-2410` for the `NUMBER(19,4)` vs `DECIMAL` dance).

The real datasource blocks stay in the `application.yml` files, commented out, so nobody has to go
looking for the JDBC URL shape when they need it:

```yaml
# spring:
#   datasource:
#     url: jdbc:oracle:thin:@//ledgerline-uat.db.meridian.internal:1521/LDGUAT
#     username: ${vault:secret/ledgerline/uat#username}
#     password: ${vault:secret/ledgerline/uat#password}
#     driver-class-name: oracle.jdbc.OracleDriver
spring:
  datasource:
    url: jdbc:h2:mem:ledgerline;MODE=Oracle;DEFAULT_NULL_ORDERING=HIGH
```

```yaml
# spring:
#   datasource:
#     url: jdbc:db2://custmaster-uat.db.meridian.internal:50000/CUSTM
#     driver-class-name: com.ibm.db2.jcc.DB2Driver
spring:
  datasource:
    url: jdbc:h2:mem:custmaster;MODE=DB2
```

If something works on H2 and fails in UAT it is almost always a `MODE` gap. Check the H2 compat docs
before opening a ticket against the DBAs, they will send it back.

## smoke.sh

Prints `PASS`, `FAIL` or `SKIP` per check and a summary, exit 1 on any FAIL. Checks, in order:

1. Keystone: discovery, authorization code + PKCE with a fixture user and `123456` MFA, ID token
   signature verified against JWKS, `amr` and `mfa_at` present.
2. `bff-retail` `/api/v1/accounts` with that token; balances match `bedrock-core-mock`'s ledger.
3. Three `ACCT.EVENTS` for one customer; Beacon dispatches three alerts to the console adapter,
   in order, within ten seconds.
4. `documents-service` statement PDF, non-empty, starts with `%PDF`.
5. A Lantern event lands in the collector; `lantern.min.js` is served.
6. Splunk search by the accounts request's correlation id finds `bff-retail` and `bedrock-adapter`.

Checks 2, 3, 4 and 6 SKIP when the platform service directory is not in the checkout and say
which one. Override the URLs with `KEYSTONE_URL`, `BFF_RETAIL_URL`, `BEACON_URL`, `DOCUMENTS_URL`,
`BEDROCK_URL`, `LANTERN_URL`, `SPLUNK_URL` when the service is somewhere else.

## Development

```
nvm use
npm ci
npm run lint     # eslint, typescript-eslint
npm run build    # tsc per workspace
npm test         # jest, --runInBand because bedrock and keystone bind ports
```

`@meridian/domain-fixtures` is a `file:` dependency here so the mocks can be built before Verdaccio
is up (chicken and egg, `PLAT-2244`). Everyone else installs it from the registry.

Adding a mock: copy `semaphore-flags-mock`, register it in `package.json` workspaces, `scripts/
start-all.js`, `docker-compose.yml` and the port table in `estate-up.sh`. Ask for a port in
`PORTS.md` first; do not squat on one.

## Known issues

- `PLAT-2702` (closed) keystone login page "occasionally" came back without the `txn` field. It was
  never keystone: `smoke.sh` passed the PKCE verifier to `node -e` as argv, and when the base64url
  verifier began with `-` node rejected it as a bad option, the challenge was empty and keystone
  correctly answered 400 `PKCE required`. The verifier now goes in through the environment. The
  "cold start" and "one in five" observations were coincidence; the retry loop stays for slow
  starts only.
- `PLAT-2705` `estate-up.sh` with Docker does not kill a leftover in-process mock holding one of
  the 46xx ports, so compose fails with `address already in use`. Run `estate-down.sh` first, or
  `lsof -i :4607` and kill it by hand.
- Artemis auto-creates queues that MQ would reject with 2085. Works here, fails in UAT.
- The bedrock batch report is regenerated from scratch each cycle; there is no history, on purpose.
- ldap-mock does not do StartTLS. Beacon's LDAP config has `ldap.starttls=false` for local only.
