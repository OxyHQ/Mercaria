# External ingestion (#62)

The provider-neutral framework through which APIs, affiliate feeds, merchant
feeds and controlled extraction become source observations, canonical matches
and fresh external offers — without letting provider-specific code write into
the commerce graph.

This is the machinery **around** things that already exist. `catalog_sources`
and `source_records` (ADR 0002 D19) stay the registry and the observation store,
#58 stays the matcher, #57 stays the offer. #62 adds what nobody owned: a
source's configuration and lifecycle, its versioned RIGHTS, the health class of
one refresh, and the staged pipeline that carries a record from an adapter to an
offer.

Binding decisions: ADR 0002 D19 (provenance) and D22 (convergence keys). Schema
decisions: `db/schema/CONVENTIONS.md` §"The external ingestion framework".

---

## The failure mode that shapes everything here

**An ingestion that looked fine.** Four shapes of it, and every decision below
exists to make one of them unrepresentable:

1. A refresh that failed authentication and **retired a healthy catalogue** —
   because the set of ids it saw looked exactly like a catalogue that shrank.
2. A re-delivery that **overwrote today's price with last week's** — a retry of
   yesterday's page, a webhook delivered late, a second mirror.
3. A payload bag that quietly carried a provider's **access token** into
   production, in the one table nobody thought to check.
4. An adapter that **minted a canonical product from a title** because it had a
   database handle and a deadline.

---

## The adapter contract

```text
discover/fetch
  → raw source record
  → validate rights + schema
  → persist immutable/source observation
  → normalize
  → deterministic entity match
  → optional review queue
  → canonical product/merchant relationship
  → offer upsert
  → freshness/expiry lifecycle
```

Every stage is in `services/ingestion/ingest.service.ts`. None is in an adapter.

`CatalogSourceAdapter` (`services/ingestion/adapter.ts`) receives an
`AdapterFetchRequest` and returns an `AdapterFetchPage`. It is handed **no
database, no transaction, no repository and no service**, and it returns a
`NormalizedSourceRecord`, which has **no canonical id, no merchant id and no
offer id** to put one in. So the write boundaries are the signature, not a rule
somebody follows: there is no parameter through which a provider module could
create a canonical product or decide what a merchant is selling.

`__tests__/ingestion-isolation.test.ts` holds the other half — no module under
`services/ingestion/adapters/` may import a repository, a database handle, a
canonical write service, the offer domain or the matcher, and the gate reads the
DIRECTORY, so it holds for adapters nobody has written yet.

### Failures are values from a closed set

`CatalogSourceFetchError` carries a `CatalogSourceFetchFailureKind`, and that
set is deliberately NARROWER than the framework's health vocabulary: an adapter
can observe an auth failure, a rate limit, an outage, a drifted schema or an
unparseable response. It cannot observe a rights suspension (Mercaria's
decision), a matching ambiguity (downstream of it) or an anomalous change (a
comparison against what Mercaria already held).

Anything else an adapter throws is classified `source_outage` and retried — the
honest reading of an unrecognised failure from a system Mercaria does not
control. It is never `schema_drift`, which would quarantine a whole feed over a
socket reset.

### `AdapterFetchPage.complete` is the most consequential field an adapter sets

It is what authorises retirement. See §"Health" below.

---

## The source: configuration, rights and lifecycle

`catalog_source_configs` is a **1:1 extension** of `catalog_sources`, not a
fork. The registry is provenance for every fact in the graph, including the ones
an operator typed and the ones #60's backfill minted; those rows have no
cadence, no credential, no rate limit and no health. `UNIQUE(source_id)` means
there is still exactly one source identity and one id.

A registry row with **no config ingests nothing** — `resolveIngestionSource`
returns nothing and the run path refuses before any fetch. Adopting #62 cannot
accidentally start crawling the `operator` source.

### The nine rights are a versioned, reviewed POLICY

`catalog_source_policies`, one row per version:

| Right | Column |
|---|---|
| store | `may_store` |
| cache (and for how long) | `may_cache` + `cache_ttl_seconds` |
| display price | `may_display_price` |
| display images/descriptions | `may_display_media` |
| create outbound links | `may_link_out` |
| add affiliate parameters | `may_append_affiliate_params` |
| index public pages | `may_index` |
| refresh through automated requests | `may_refresh_automatically` |
| extraction, and under what constraints | `extraction_mode` + budget + user agent |

plus `may_display` (the umbrella the price and media rights narrow) and
`attribution_required`.

- **A version is frozen once it leaves `draft`** (a trigger), and one is active
  per source (a partial unique). **Withdrawing a right is a NEW version**, so
  the old one survives with its reviewer, its date and its terms URL intact.
  That is issue acceptance 6 as a shape: there is no UPDATE that could delete
  the history and no DELETE anywhere in this domain.
- **An active version was reviewed by somebody, on a date** — a CHECK.
  "Controlled extraction must have an explicit policy/terms review before
  activation" generalises to every source kind, for the reason it was written: a
  right nobody reviewed is a right nobody granted.
- **Extraction beyond `disallowed` must state a daily request budget and an
  identifying user agent** — a CHECK. A permitted crawl with neither is the
  "controlled extraction" that is not controlled.
- A source **cannot be activated before a policy is published** (a refusal in
  `changeIngestionSourceStatus`, in words rather than a 23514).

### Effective rights are ONE derivation, mirrored by a deferred trigger

`resolveSourceRights(status, policy)` in `services/ingestion/rights.ts`:

| Status | Effect |
|---|---|
| `draft`, `revoked` | every right false |
| `paused` | the policy's rights, EXCEPT refresh and extraction |
| `failed` | the policy's rights in full — a source that answered 500 once must retry without a person re-enabling it |
| `active` | the policy's rights |

`catalog_sources`' three coarse columns (`may_display`, `may_store`,
`attribution_required`) are a PROJECTION of it, and
`mercaria_catalog_source_rights_agree` — a **DEFERRABLE constraint trigger** on
all three tables — refuses any COMMIT in which they disagree. Deferred because a
rights change touches three tables and no statement order makes every
intermediate state consistent; checking at commit has no opinion about the
order, which is what lets it be strict about the outcome.

A registry row with no config is left entirely alone by the trigger, which is
what keeps #60's backfill source and the operator source working unchanged.

### Secrets

`credential_ref` names WHERE a secret lives and never the secret:
`connection:<id>`, `env:<NAME>` or `ssm:<path>`, CHECK-shaped and length-bounded
so a pasted bearer token is refused. It is not in `protectedColumns.ts` — a
locator is not a credential — and what keeps it out of every response is that
the operator projection NAMES its fields, gated statically.

---

## Observations: what is stored, and what is not

The RAW provider payload is **digested and discarded**. What is stored is the
normalized, allow-listed projection.

- `services/ingestion/normalization.ts` bounds every field, drops a URL that is
  not absolute `http(s)`, refuses a non-integer or negative price, and keeps an
  unknown fact ABSENT rather than zero. `NORMALIZATION_VERSION` is a code
  CONSTANT (the `CATALOG_BACKFILL_MAPPING_VERSION` reasoning — a table would let
  somebody publish a version whose rules nobody shipped), and every observation
  stores the version it was read under.
- `services/ingestion/redact.ts` composes the stored payload from
  `CATALOG_SOURCE_PAYLOAD_FIELDS` — an ALLOW-list, `services/payments/redact.ts`'
  precedent. A deny-list is correct only until the provider adds a field, which
  is exactly when a sensitive one appears.
- **The allow-list's key names are the MATCHER's read contract.**
  `services/matching/subject-loader.ts` already reads `title`, `brand`, `gtin`,
  `sku`, `attributes` and the rest off a stored payload; a second vocabulary
  here would leave every ingested record matching on a title and nothing else,
  silently.
- `MAX_STORED_PAYLOAD_BYTES` refuses an oversized projection rather than
  truncating it — truncation would hash differently on every delivery of the
  same content, so the convergence key would stop converging.
- `may_store` decides whether the PAYLOAD is kept, not whether the observation
  is. A source Mercaria may read but not store keeps its hash and its
  observation time with no payload (D19), and the consequence is stated rather
  than hidden: the matcher's subject loader returns `null` for a payload-less
  record, so such a source produces provenance and freshness and never an offer.

### `catalog_source_objects` — the CURRENT fact

`source_records` is append-only per content hash and answers "what was seen, and
when". A convergence key and a monotonicity guard need a row that answers "what
is true NOW", and there is exactly one per external object.

`UNIQUE(source_id, external_type, external_id)` is the identity — issue
§"SourceRecord persistence" names exactly this — and it is what makes two
concurrent deliveries converge instead of racing.

**An older observation can never overwrite a newer current fact**, twice over:
the upsert's `ON CONFLICT DO UPDATE … WHERE` predicate makes an out-of-order
delivery a silent no-op (the empty `RETURNING` set IS the answer), and
`mercaria_catalog_source_object_monotonic` states the same rule at the row, so
it holds for every OTHER path — including a repair somebody writes in `psql`
during the incident that made them want to.

The ordering key is `source_updated_at` when both sides publish one, and
`observed_at` otherwise: a provider that publishes its own last-modified is
telling you the order of its own facts, while two workers reading two pages
concurrently produce `observed_at` values whose order says nothing.

`state` is the INGESTION pipeline's own progress and is deliberately not a copy
of `match_decisions.outcome`: it spans stages the matcher knows nothing about (an
offer materialized, an object retired, a payload quarantined). The verdict is
reachable through `last_match_decision_id` — a pointer, never a copy.

---

## The write boundaries

1. **Adapters never create canonical products, brands or merchants.** There is
   no code path from the framework into a canonical WRITE service; the matcher
   is called and never mints either. A `create_new` recommendation is RECORDED
   and the object is left `unmatched`; #60 owns minting.
2. **An offer is upserted only after canonical variant AND merchant
   resolution.** The variant comes from an `automatic_match`; the merchant comes
   from the source's own BINDING (`catalog_source_configs.merchant_id`), bound
   once by an operator. A source with no merchant produces no offers — a state
   an operator can see and fix, rather than a merchant nobody authorised.
3. **Ambiguous matches route to review rather than to a guessed link.** Anything
   that is not an `automatic_match` writes no canonical link and no offer; the
   object goes to `review_required` citing the decision #59 reads. A CHECK makes
   that state unwritable without a decision id, so the queue is always reachable
   FROM the object.
4. **Source refresh updates mutable offer facts, not canonical identity.** The
   framework writes `canonical_*_source_links` (attachments) and `offers` rows,
   and imports no canonical write service at all.
5. **Manual corrections override mapping while preserving observations.**
   Corrections are #59's, over `match_decisions`; nothing here deletes an
   observation.
6. **Native listings stay native offers.** Nothing in this domain writes a
   native offer or a `native_listing_links` row — a scanned gate.
7. **An external source can never make an offer checkout-native.** The permitted
   kinds are `Exclude<OfferKind, 'native'>` (a `tsc` error otherwise) and
   `offers_kind_shape_check` forces `product_variant_id` NULL on every one of
   them, so there is no id a cart line could hold whatever the pipeline does.
8. **Supplier-backed `mercaria_retail` eligibility stays with #116/#121.** No
   module here references the retail domain at all — a scanned gate.

### The rights shape the offer, rather than being checked after it

- `display_price` absent ⇒ **no price is persisted onto the offer.** The
  observation keeps it under the `store` right; the offer is the display
  surface, and storing a price nothing may ever show is what a rights withdrawal
  exists to prevent.
- `outbound_link` absent ⇒ the kind is `informational`, and
  `offers_kind_shape_check` refuses a destination on that kind.
- `affiliate_params` absent ⇒ no affiliate routing metadata at all, so #37 has
  nothing to compose a tracked URL from and degrades to the plain link.

### #58's other seam, closed

`match.service` writes only the NATIVE attachment and leaves the source-record
one to "the ingestion path that owns the observation". That is this framework:
an `automatic_match` writes `canonical_product_source_links` and
`canonical_variant_source_links` in one transaction with the object's state, both
`ON CONFLICT DO NOTHING` on their active partial unique, so a re-run of an
unchanged object writes nothing at all. The link `method` is
`deterministic_identifier` for an identifier stage and `heuristic` otherwise; a
confidence rides only the heuristic one.

---

## Health: the rule that costs money

**Do not mass-expire healthy offers because one refresh failed.**

Retirement is authorised by TWO independent things that must agree, and neither
is the sweep's own opinion:

1. the ADAPTER said this page completed a full enumeration
   (`AdapterFetchPage.complete`), and
2. the run's OUTCOME is in `CATALOG_SOURCE_RETIRING_OUTCOMES`, which has one
   member (`full_feed_success`).

`catalog_source_runs_retirement_check` then refuses to store a non-zero
retirement count unless both hold — rendered from the same tuple `health.ts`
reads, so the constraint and the service cannot drift, and a hand-written
`UPDATE` is refused with them.

`partial_feed` is outside the retiring set even though the run succeeded in
part: *"the half I read did not mention it" is not evidence about the half I did
not read.*

### The ten classes, worst-first

`classifyRunOutcome` runs worst-first, because a run can be several of these at
once and the one that matters is the most severe (the `deriveRetailCompleteness`
severity rule applied to a health state):

`rights_suspended` → `auth_failure` / `rate_limit` / `source_outage` /
`schema_drift` / `parse_failure` → `schema_drift` (by rejection ratio) →
`matching_ambiguity` (by review ratio) → `full_feed_success` / `partial_feed`.

A withdrawn refresh right is reported BEFORE the provider is blamed: saying
`source_outage` would send somebody to check a service that is answering
perfectly well.

A source becomes `failed` only on a run that could not FETCH. A pass that read
the feed and refused half of it is degraded and stays `active`, because `failed`
is what the backoff reads and backing off from a healthy provider over our own
parse problem fixes nothing. Nothing can move a source out of `paused` or
`revoked` — those are somebody's decision.

A provider-supplied `Retry-After` wins over the computed backoff when it is
LONGER and never when it is shorter, so a provider cannot talk Mercaria into
hammering it.

### Anomalous price changes

A feed that renames its currency field, publishes minor units where it used to
publish major ones, or serves a placeholder produces one shape, and every one of
them would otherwise become a headline price on a comparison page. The object is
QUARANTINED rather than applied. A currency change alone is always anomalous — a
price that changed denomination is not a price that changed. A quarantine is a
decision about CONTENT, so the same content arriving again does not answer it;
an operator releases it explicitly.

---

## Concurrency and idempotency

1. **Unique constraints own source-object identity** —
   `UNIQUE(source_id, external_type, external_id)`.
2. **Concurrent deliveries of the same version converge** — the upsert, plus one
   open run per source (a partial unique).
3. **Older observations cannot overwrite newer current facts** — the predicate
   and the trigger.
4. **The canonical link and the object's state commit together.**
5. **Runs are leased jobs.** The row IS the job (`payment_provider_events`'
   arrangement): `FOR UPDATE SKIP LOCKED` with an owner check on every terminal
   write, capped exponential backoff, a cursor that survives a failure so the
   retry resumes from the page that failed. There is deliberately no
   `dead_letter` status — a run that keeps failing is visible as a climbing
   `attempts` beside a `failed` health state, and a status that took it out of
   the queue would need a person to notice and re-open it.
6. **Backfills and incremental updates share the same write path** — they differ
   only in the `since` watermark, and both are driven page by page through
   `runIngestionPage`.
7. **Parallel adapters cannot race to create duplicate canonical identities** —
   they cannot create canonical identities at all.

### Two leases, and why they are separate

The SOURCE lease says "this task is responsible for feeding this source"; the
RUN lease says "this task is driving this pass". A pass outlives a tick — a feed
with forty pages is forty ticks of one run — so collapsing them would either
hold a source lease for an hour or let a second task claim the source mid-pass
and open a competing run.

---

## Observability

`GET /internal/ingestion/sources/:sourceId/metrics` answers all ten:

fetch count and latency · records fetched/changed/rejected · match rate · review
backlog · offer freshness · error class and rate · rate-limit pressure ·
current/expired offers · payload/schema version drift · rights/policy status.

**Counted from the EVIDENCE beside the counter** (#60's `scannedFromRecords`
device): rejections are reported both from the runs' own counter and from
`catalog_source_rejections`, with `countsAgree` beside them. A page that
swallowed a record leaves the two disagreeing, where either number alone reads
as a clean run. The comparison is `>=` rather than `===` because the rejection
table is swept at thirty days and the runs are not — the direction it catches is
MORE evidence than the counter admits.

`catalog_source_rejections` is the RESIDUAL, and it is a table rather than a
counter for the reason `~/Oxy/AGENTS.md` states: a `rejected` counter says a
page dropped eleven records; only these rows say all eleven were the same field
a provider renamed, which is what tells schema drift from one bad page. It is
the ONLY table in this domain with a retention deadline, because it is the only
one bounded by traffic rather than by the catalogue.

The trace opens from an EXTERNAL OBJECT and nothing else. `payloadStored` is a
boolean rather than the payload: an operator needs to know whether the `store`
right was in force, and serving the stored content back through a debugging
surface is a second distribution channel for data whose retention this domain
deliberately bounds.

---

## The operator surface

`/internal/ingestion/*`, behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
allow-list #54/#56/#57/#58/#60 use — who may reshape the canonical catalogue,
who may migrate the native one into it and who may decide what an external
source may do are the same power over the same graph. Empty list = not mounted
(404, never a 401 that would advertise the surface).

It stays mounted while `CATALOG_INGESTION_ENABLED` is off, deliberately:
configuring a source, reviewing its terms and draining it by hand is how a feed
is brought up before the loop is switched on, and the evidence has to be
readable during the incident that turned the loop off.

| Route | What it does |
|---|---|
| `GET /sources` | every configured source, its health, which providers ship adapters |
| `POST /sources` | register or reconfigure. It permits nothing until reviewed |
| `GET /sources/:id` | one source with its effective rights |
| `GET /sources/:id/policies` | every rights version this source has ever had |
| `POST /sources/:id/policies` | publish and activate a version, superseding the last |
| `POST /sources/:id/status` | move the lifecycle. A reason is mandatory |
| `GET /sources/:id/metrics` | the ten measurements plus the evidence cross-check |
| `GET /sources/:id/runs` | this source's passes, newest first |
| `POST /sources/:id/runs` | open a MANUAL pass |
| `GET /sources/:id/objects/trace` | one external object's whole history |
| `GET /sources/:id/rejections` | the residual |
| `POST /objects/:id/release` | let a quarantined object back into the pipeline |
| `POST /drain` | drive one dispatcher tick now |

**Deliberately absent:** any delete (of a source, a policy, an object or a run);
"set this object's canonical match" (#59's, with its own four eyes and
timeline); "create an offer" (the write boundary the issue exists to establish);
any credential read or write; any flag write.

---

## Environment

```
CATALOG_INGESTION_ENABLED=false          # gates the LOOP, never the durable record
CATALOG_INGESTION_BATCH_SIZE=5
CATALOG_INGESTION_POLL_INTERVAL_MS=30000
CATALOG_INGESTION_LEASE_MS=120000
CATALOG_INGESTION_MAX_BACKOFF_MS=21600000
CATALOG_INGESTION_RETIREMENT_BATCH_SIZE=500
CATALOG_INGESTION_ANOMALY_PRICE_FACTOR=20
```

There is deliberately no flag over the rights, the tables or the operator
surface. Rights are per-source and versioned, which is a finer instrument than a
global switch and the one an incident actually needs.

---

## Tests

- **`services/ingestion/__tests__/adapter-contract-suite.ts`** — the REUSABLE
  suite, all thirteen cases the issue lists. #63 and #66 each call
  `describeCatalogSourceAdapterContract` with a harness that materialises a
  SCENARIO in their own transport and get every case for free. The scenario is
  stated in framework terms rather than HTTP fixtures, so it fits an adapter
  that speaks anything.

  **#65 deliberately does NOT**, and that is a property of eBay rather than a
  shortcut — closing the gap is the one repair this section forbids. The shared
  suite assumes one framework page is one provider call (cases 2 and 3 assert
  exact `fetch_count`/`fetched`/`unchanged` counters, but an eBay pass is
  DISCOVERY then VERIFICATION and makes more framework pages than it has
  scenario pages, by design), and case 4 asserts a provider-published
  `sourceUpdatedAt`, which the Browse API does not publish for an item —
  satisfying it would mean INVENTING a provider timestamp. #65's own
  `ebay-ingestion.realdb.test.ts` covers all thirteen concerns case by case
  instead, against the same tables, through the real adapter over a fake
  transport.

  **The suite's own docblock said otherwise until #367 line 632.** It claimed all
  three called it and labelled all three with the wrong source kind, rotated one
  place — and it was **wrong when written rather than overtaken**: #64's
  selection document, which names eBay the marketplace and Awin the affiliate
  network, was already in the tree twenty hours earlier
  (`git merge-base --is-ancestor 22716148 f05d221e` → true). This page and
  `ebay-ingestion.realdb.test.ts` both had it right the whole time, which is what
  made the disagreement findable at all.

### Contract coverage by SOURCE KIND (#367 line 632)

Line 632 asks for contract tests over *"representative Amazon/eBay/brand/feed-like
fixtures"*. Those four words name KINDS rather than a required fixture list, and
the reason is `docs/catalog-sources/2026-08-09-launch-sources.md:22` — **"Amazon
is not selected, and honestly cannot be today"**, with the Associates-enrollment
reason in its §4. A fixture for a source the epic's own dated decision rejected as
unbuildable is not a requirement.

Mapped onto `CatalogSourceKind`:

| kind | contract coverage |
| --- | --- |
| `connector` | `connectors/__tests__/connector-contract-suite.ts` via `shopify-contract.test.ts` and `woocommerce-contract.test.ts` |
| `feed` | `adapters/__tests__/product-feed-contract.test.ts` (#63) |
| `affiliate_network` | `adapters/__tests__/awin-feed-contract.test.ts` (#66) |
| `marketplace_api` | `services/ebay/__tests__/ebay-ingestion.realdb.test.ts` — the same thirteen concerns, differently shaped, for the reasons above |
| `operator`, `backfill` | **none, and line 632 does not ask for one** — neither is a provider integration with a transport to contract-test |

**Whichever kind `brand` denotes, it is covered**: a brand running its own store is
a `connector`, a brand publishing a product file is a `feed`, a brand reaching
buyers through a network is `affiliate_network`. Nothing here rests on picking
one — no file in the repository maps that word, and the verdict does not need it
to.

The second clause — *"without coupling the core domain to any one provider"* — is
structural and measured: **zero** of the eleven framework-core modules under
`services/ingestion/` import from `adapters/` or a provider service, against a
control of 26 imports in `ingest.service.ts` alone, and wall 1 of
`ingestion-isolation.test.ts` scans the DIRECTORY, so it holds for adapters
nobody has written.

  #63's runner added two harness fields, and both are the scenario staying in
  FRAMEWORK terms rather than quietly meaning "HTTP". `pageSize` exists because a
  FILE has no page tokens — #63 reads the whole feed once and pages a local stage
  by record count, so "three pages" can only mean "three records at one per
  page". `isolatesInvalidRecordsUpstream` exists because a file importer
  validates BEFORE normalization (it is the only layer that knows which COLUMN a
  value came from), so an invalid row never becomes an `AdapterRecord` and the
  framework legitimately has nothing to reject; case 5's PROPERTY — one bad
  record does not take the page with it — is asserted either way, and what
  differs is where the refusal is written.
- **`adapter-contract.test.ts`** — runs it against the fixture provider, which
  is a real adapter over an in-memory feed. Acceptance 1 end to end: records in,
  PostgreSQL observations and matched external offers out.
- **`services/__tests__/ingestion-writes.realdb.test.ts`** — the CHECKs, the
  triggers and the partial uniques, against a real server. Includes the (status
  × policy) matrix driven through BOTH the TypeScript derivation and the
  plpgsql trigger, because two spellings of one rule can disagree.
- **`ingestion-isolation.test.ts`** — the six scanned walls, with a vacuity
  floor, an enumeration floor read off the real directories, and a mutation
  self-test on every detector.
- **`ingestion-rules.test.ts`** — the pure rules.

---

## What is deferred, and to whom

Each is a NAMED contract that fails closed, never a stub that lies.

- **#63 — LANDED.** The universal product-feed importer registers the
  `product_feed` adapter (gated by `FEED_IMPORT_ENABLED`, which gates the LOOP
  and never the record) and runs this whole contract suite against it over a real
  CSV — see `docs/feed-importer.md`. It surfaced two bugs in THIS framework that
  the fixture adapter could not show, both because its records carry a fixed date
  in the past: `ingestOneRecord` stamped "seen at" from the dispatcher tick while
  `observedAt` comes from the adapter's own read, so every real adapter failed
  `catalog_source_objects_seen_order_check` on the first observation of every
  object — silently, as a per-record `parse_failure`, meaning a feed would ingest
  NOTHING and report a clean run; and `match_policy_versions_active_key`'s
  contention became fatal the moment a SECOND contract runner existed, because
  the suite's wait for the slot outlives vitest's own per-test timeout.
- **#65 / #66 — LANDED.** eBay Browse and the Awin retailer-network source are
  both registered adapters now (`EBAY_ENABLED`, `AWIN_ENABLED`) — see
  `docs/catalog-sources/ebay-browse.md` and `docs/catalog-sources/awin.md`. A
  deployment that leaves either flag off still configures the source, reviews
  its policy and sees every run refuse for want of an adapter — the seam that
  fails closed and reports why is exercised by an off flag rather than by
  "no adapter exists" now. `catalog_source_configs.provider` still carries a
  SHAPE check and not a value check for the general case
  (`offers.provider`'s decision): gating the durable configuration on Mercaria
  having shipped an adapter would invert "gate the loop, never the record", and
  a deployment can still configure a source for a provider with NO adapter at
  all.
- **#37 — the outbound/affiliate redirect.** The routing metadata is modelled
  and `destination_url` stays the ORIGINAL; nothing here composes a tracked URL.
- **#59 — the review UI and corrections.** This framework routes to the queue
  and never resolves anything in it.
- **#60 — minting a canonical product** a `create_new` recommends.
- **#74 — ranking**, and #61 — indexes and projections with numbers attached.
- **#116 / #121 — supplier-backed `mercaria_retail` eligibility.** This
  framework does not grant it and cannot reach the domain that does.
- **Re-normalization.** Bumping `NORMALIZATION_VERSION` schedules one rather
  than reinterpreting stored facts; the consumer that drains it is not built.
  Every observation already records the version it was read under, which is what
  makes the sweep expressible when somebody needs it.

---

## Production-readiness checklist

1. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or the surface is not mounted and
   nobody can configure a source or review a policy.
2. At least one adapter registered. #63's `product_feed` is registered by
   `FEED_IMPORT_ENABLED=true` (which additionally requires
   `FEED_IMPORT_AUTH_ENCRYPTION_KEY`); #65 and #66 ship none yet, and until an
   adapter exists for a source's provider every run refuses.
3. For each source: a merchant BOUND (no merchant, no offers), a policy version
   published and reviewed, and the status moved to `active`.
4. `CATALOG_INGESTION_ENABLED=true` only after a source has been drained by hand
   from `/internal/ingestion/drain` and its metrics read.
5. Alerting on `healthState` other than `full_feed_success`, on a climbing
   `consecutiveFailures`, and on `countsAgree` reading false. Scraping belongs to
   `oxy-infra`.
