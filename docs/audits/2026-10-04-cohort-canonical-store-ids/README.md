# Canonical store IDs in the approved Mercaria cohort

The cohort configuration previously accepted only UUIDs, while both approved
existing stores have permanent 24-character historical IDs. The configuration
boundary now calls `isLiveEntityId` from `@oxy.so/db`, the same predicate used by
Mercaria's entity-ID boundary: historical ObjectIds and generated UUIDv7 IDs.
It preserves identifiers verbatim, rejects malformed IDs and UUIDv4, and does
not assert that a configured row exists. Existing SQL ownership checks still
establish the store/customer/subscription relation. No DDL or dependency change.

The source starts from merged main `fc577db26f81aaaff57909e48872edfed79346d4`.
Its complete tree equals the preceding accepted `82c92e479` head. The previous
independent-cohort/general-Stripe-off change remains intact.

`cohort.production.json` contains exactly the public handles approved by root's
merchant, Stripe-account and two-store readbacks. It adds no store, merchant,
plan, price, consent or customer. Root must revalidate these live handles before
rolling deployment. The registration test exercises that complete configuration
with explicit synthetic account/merchant authority responses and an explicit
synthetic application credential pair. It also rejects changed merchant,
application, environment, platform account and mode before installation.

Runtime deployment configuration (root operates; no changes performed here):

- `MERCHANT_BILLING_PEABLE_COHORT`: the exact JSON file in this directory.
- `PEABLE_APP_PUBLIC_KEY`: alias of existing `/oxy/mercaria/OXY_APPLICATION_KEY`.
- `PEABLE_APP_SECRET`: alias of existing `/oxy/mercaria/OXY_APPLICATION_SECRET`.
- Existing Stripe live key and existing endpoint configuration stay bound.
- `STRIPE_ENABLED=false` and `MERCHANT_BILLING_ENABLED=false` remain unchanged.
- Existing Peable-side live merchant/Portal configuration has independent root
  readbacks; this Mercaria configuration neither creates nor changes it.

The same final fixtures produce RED against main's original `adapter.ts`
(24 failed / 20 passed) and GREEN against the corrected adapter. The real
SQL/HTTP/SDK suite uses an owned synthetic 24-hex store and a generated UUIDv7
noncohort store; all 16 scenarios retain their previous ownership, no-fallback,
replay, disabled-action, cancellation and balanced-ledger assertions. GREEN
covers six suites / 80 tests, including signed Peable webhook delivery and the
real published Stripe SDK's bounded read-only transport fixtures. These remote
authority/Stripe responses are synthetic; no provider or production requests.

A follow-up adds positive serving-task evidence immediately AFTER verified
namespace checks and provider installation. Only the SHA256 of the parsed
cohort, mode, environment and store count are logged; no credential or raw
configuration is logged. `expected-serving-registration.json` pins the exact
expected line. Registration tests prove reordered raw object keys have the
same parsed hash, and all five namespace mismatches emit no positive line.
The final attestation source passes six suites / 81 tests; the preceding
80-test RED/GREEN checkpoint remains independently recorded, not relabeled.
Operational acceptance must collect every actual new task's own fresh log
stream, require this exact positive line, reject the existing registration
failure message and verify serving TD/image/config. Health/readiness alone
cannot demonstrate asynchronous provider installation. No new endpoint or
human purchase criterion is introduced.

Backend TypeScript, scoped ESLint with zero warnings, and canonical backend
build pass. `run-compiled-config-smoke.mjs` compiles a separate fixture entry
with the backend's external-dependency policy and runs Node 24 with
`NODE_ENV=production`, a minimal environment, synthetic credential pair and an
unreachable local DB URL. It proves that actual config parsing and the actual
canonical schema accept the complete deployment cohort, both mutable rails
stay off and the direct legacy Stripe client remains unavailable. It issues no
fetch requests, opens no SQL connection and starts no server. This fixture
bundle is not a shipping entry point or a production bootstrap claim. The first
smoke attempts incorrectly assumed leaf dist modules, used a wrong relative
path, then omitted the required DB URL; those setup failures are preserved and
excluded from GREEN evidence.

One verified owned PostgreSQL 17 process on port 5626 served RED/GREEN; its PID
895765 was stopped and observed absent. The normal test harness created and
migrated only throwaway databases with PostGIS. The harness scrubbed credentials
and disabled Bun dotenv auto-loading, including descendants. No live DB,
financial/provider effect, AWS write, image publication or deployment occurred.
Mercaria's existing AWS deployment workflow stays HELD; publisher/rollout wait
for independent source/proof review and the corrected main/image.
