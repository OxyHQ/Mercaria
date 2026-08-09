# Source-aware offer freshness, refresh and catalogue health (#68)

How long an external offer's price is worth showing, when it is re-read, how
hard Mercaria may knock while re-reading it, and what happens when a feed
publishes something that cannot be true.

This sits between #57 (the offer, which holds current state) and #62 (the
ingestion framework, which produces it) and adds the machinery neither owns.
Schema decisions: `db/schema/CONVENTIONS.md` §"Offer freshness and catalogue
health". Binding upstream decisions: ADR 0002 D18 (`stale_at` is ONE deadline)
and D19 (provenance).

---

## The failure mode that shapes everything here

**A refresh that looked fine and cost a catalogue.** Four shapes of it, and
every decision below exists to make one of them unrepresentable:

1. A source that went down for an hour, and a sweep that retired everything it
   had ever published because the deadline had passed.
2. A feed that started publishing majors where it used to publish minors, and a
   comparison page that showed every price at a hundredth of its value.
3. An offer a source republished after a gap, minted as a SECOND row — its
   observed history split across two ids with nothing to rejoin them.
4. A price alert that fired on a price nobody could buy, because the offer had
   lapsed and the alert read the stored number anyway.

---

## There is no global TTL, and it is structurally impossible to introduce one

"How long is this offer's price still worth showing" is a question about ONE
source. eBay's API License Agreement requires deleting content once a listing is
no longer publicly available; an Amazon-style Operating Agreement caps non-image
caching at 24 hours; an Awin feed is stale the moment its advertiser
re-imports. A deployment-wide `OFFER_TTL_SECONDS` is wrong for every one of
them, and wrong in the direction that breaks a contract rather than a page.

Four independent things make it unrepresentable:

1. **`SourceFreshnessPolicy` carries the id of the source it was resolved for**,
   and `assessOfferFreshness` is handed the offer's own source id beside it. A
   policy naming a different source is REFUSED (`unknown` /
   `policy_source_mismatch`), so one shared object cannot serve two sources —
   the only way to get a second source's deadlines is to resolve a second
   source's row.
2. **Every duration lives on a row keyed to one source.**
   `catalog_source_freshness_policies` has no deployment-scoped row, no
   "default" row and no nullable `source_id` that could mean "all sources".
3. **`services/offer-freshness/policy.ts` imports no configuration at all.**
   That is the shape a global TTL would actually take — not a column, but
   somebody reaching for `config.offerFreshness.defaultTtlSeconds` because a
   source had no policy row.
4. **A scanned gate** (`freshness-isolation.test.ts`) fails the build if the
   resolver learns to read configuration, or if any module in the domain
   declares a module-level constant that is a freshness LIFETIME. A FRACTION or
   a MULTIPLE is deliberately permitted: `SOURCE_WARNING_FRACTION` is two thirds
   of a different number for every source, and `SOURCE_OUTAGE_GRACE_INTERVALS`
   is two of that source's own refresh intervals.

The prohibition is on a lifetime and not on every duration. How often the loop
polls and how many calls a minute Mercaria makes are properties of Mercaria's
own politeness and are legitimately deployment-wide; how long a source's facts
stay trustworthy is a property of that source's contract.

### The four layers, each of which can only SHORTEN

| Layer | Where | Basis |
|---|---|---|
| A published freshness version | `catalog_source_freshness_policies` | `source_policy` |
| The source's own configuration | `catalog_source_configs.fetch_cadence_seconds` / `freshness_ttl_seconds` | `source_configuration` |
| The OFFER's own stored deadline | `offers.stale_at` | `offer_deadline` |
| The rights policy's contractual cache cap | `catalog_source_policies.cache_ttl_seconds` | applied as a `min` |

The second layer exists so that adopting #68 does not withdraw every external
offer from comparison on the deploy that adds it (ADR 0002 D24's rule about a
rollout lever never being introduced in the position that removes a live
surface). It is still per-source: the numbers are that row's.

The THIRD is the last resort, for an offer whose source is a bare provenance
registry entry with no ingestion configuration at all — #60's backfill source,
the operator one. Those sources ingest nothing (#62) and so have no contract to
resolve, but the offers written against them carry a `stale_at` somebody chose.
It is per-OFFER and therefore not the global TTL this domain forbids. An offer
that names NO source is still `unknown`, which never appears in comparison.

`effectiveOfferLifetimeSeconds` is a `min` and there is no parameter through
which the cap could lengthen a lifetime — a cap a per-source policy could
override would not be a cap.

---

## The clock is the last CHECK, not the last CHANGE

`observedAt` is when the current terms were read, i.e. when the price last
CHANGED. `lastSeenAt` is when the source last confirmed the offer exists at all.

Running the deadlines from `observedAt` expires every stable price on a feed
that publishes the same number every day, which is most of a catalogue. Running
them from `lastSeenAt` asks the question the contracts actually ask — "when did
we last check". Both are still reported: a buyer comparing offers wants the
second, a merchant debugging a feed wants the first.

---

## The five levels, and what each branch withholds

`current | warning | expired | unavailable | unknown`.
`mayAppearInComparison` is an exhaustive `switch`, so a sixth level fails `tsc`
there rather than defaulting into the buyer-visible set.

- **`warning` is the ONLY branch that carries `lastCheckedAt`.** #68 public
  behaviour 2 grants a last-checked time to that state and no other; an offer
  that has left comparison must not be rendered with a reassurance beside it.
  `expired` and `unavailable` have no such property, so a surface that renders
  it cannot compile for them.
- **`unknown` carries no `expiry` at all**, so nothing can compute a countdown
  for an offer whose contract could not be resolved. It is never a soft yes: it
  does not appear in comparison.
- **A NATIVE offer is `current` and UNBOUNDED.** `bounded: false` has no
  `expiresAt` property, so a sweep cannot read a deadline off a native offer
  even by mistake — its `stale_at` measures how long ago the convergence
  dispatcher ran, and expiring it on that clock would delist a healthy catalogue
  during a dispatcher outage.

The decision procedure is worst-first: an explicit unavailability beats the
clock, an unresolvable policy beats a deadline, expiry beats warning.

---

## `stale_at` is a PRE-FILTER; the derivation is the AUTHORITY

The comparison read has to narrow a million rows before it can project any of
them, and the only thing indexable at that point is a stored deadline
(`offers_freshness_idx`). So the SQL keeps filtering on `stale_at` — stamped by
the ingest path from the resolved policy — and the PROJECTION then re-derives
the verdict live and drops anything it refuses.

That ordering is what keeps this from being "two representations of one fact" in
the sense #57 forbids. The two can only disagree after a policy change, and the
intersection is a SUBSET of what the derivation admits — so the disagreement can
hide an offer and can never show one the live policy calls expired. A cache cap
that shortens a lifetime therefore bites at the next read, with no sweep having
run.

The cost is stated rather than hidden: a page may return fewer than `limit`
offers, and the caller follows `nextCursor` exactly as before, because the
cursor is a keyset over the SQL order which the drop does not touch.

---

## Grace delays the RETIREMENT, never the display

An offer past its deadline stops being SHOWN immediately, derived, with no sweep
involved. The durable RETIREMENT waits an extra window while the source is in a
FETCH failure, so a transient outage does not cost the catalogue — the offers
come back to `current` when the feed does, with their ids, their `first_seen_at`
and their whole observation chain intact.

`sourceHealthGrantsGrace` admits `auth_failure`, `rate_limit` and
`source_outage` and nothing else:

- A `schema_drift` or a `parse_failure` means Mercaria read the feed perfectly
  well and did not like what was in it. Granting grace there keeps serving
  prices the source has had every chance to correct.
- **`rights_suspended` earns none**, and that exclusion is the important one: a
  withdrawn right is a decision to STOP showing the data, so extending its life
  is precisely what the grace must never do.

---

## Absence versus a statement: the acceptance 2/3 distinction

Three different retirement paths, and `catalog_source_objects.retirement_kind`
records which one:

| Kind | Evidence | Licensed by |
|---|---|---|
| `explicit_removal` | the source SAID the object is gone | ANY run, complete or not |
| `snapshot_omission` | a COMPLETE enumeration did not mention it | `full_snapshot` + `full_feed_success` only |
| `ttl_expiry` | nobody said anything for longer than the policy permits | the expiry sweep |

The adapter contract makes the first two structurally different:
`AdapterFetchPage.removals` carries positive statements, and an OMISSION is not
expressible there at all — an adapter reports what it SAW, and what it did not
see is the framework's to interpret against `complete`.

`catalog_source_runs.refresh_mode` is the third leg beside `enumeration_complete`
and the run's outcome: `catalog_source_runs_complete_mode_check` refuses a
complete enumeration from any mode but `full_snapshot`, so an incremental pass
cannot satisfy the other two while having asked the source for a fraction of its
catalogue.

Offers retired by an explicit removal are counted in `offers_removed` and NOT in
`offers_retired`. `catalog_source_runs_retirement_check` guards the second alone,
and routing removals through it would either refuse a legitimate deletion notice
from an incremental feed or make the CHECK meaningless.

---

## A returning offer revives the SAME identity

`offers_active_source_key` was partial on `status = 'active'`, so a retired
offer whose source published the object again did not conflict — and the upsert
inserted a SECOND row for the same external object, splitting the observed
history across two ids.

`offers_source_identity_key` drops the status from the predicate: an external
offer is ONE row for its whole life, and a return is an UPDATE that clears the
status, the retirement reason, the retirement date and any previous declaration
of unavailability. `first_seen_at` never moves.

`superseded` is excluded from the predicate, which is what makes the migration
safe: any duplicate that accumulated under the old index is retired with that
reason — #57's own vocabulary for "a newer offer took this one's active source
mapping" — rather than deleted or blanked.

---

## The refresh queue

`offer_refresh_tasks` is a CONVERGENCE queue (`offer_outboxes`' shape, not the
moderation outbox's): `UNIQUE(source_id, mode, subject_key)`, and five requests
to re-read one object owe ONE re-read. Against eBay's 5,000-calls-a-day default,
the difference between one and five is the difference between a working
integration and a suspended keyset.

- **The priority only ever goes UP.** The conflict branch takes `least(...)` on
  the RANK — a lower rank is more urgent — so an alert that arrives while a
  scheduled refresh is queued is not demoted by the next scheduled tick. The
  class is recomputed from the winning rank in the same statement.
- **`priority_rank` is a STORED GENERATED `case` over `priority_class`**,
  rendered from the same tuple the scheduler reads, and `priority_class` must be
  a member of `priority_reasons` (a CHECK). So the ordering key is a function of
  the row rather than a number a service computed.
- **A `processing` row is never written back to `pending`** by an enqueue —
  #57's measured bug: a flat `status = 'pending'` in the conflict branch
  releases a live lease from outside the worker. The
  `requested_revision`/`claimed_revision` pair carries the new request instead.
- **Capability first.** `chooseRefreshMode` reads the ADAPTER's declared modes,
  narrowed by the source's policy. A policy listing `full_snapshot` for an
  adapter that cannot enumerate does not make it able to — and an eBay-style
  Browse adapter must never be scheduled for the one mode that authorises
  retiring what it did not see.
- **A refusal is recorded, never silently downgraded.** `unsupported_mode` and
  `adapter_missing` dead-letter; `rate_limited` and `all_slots_busy` go back to
  `pending` with a capped backoff. A targeted refresh quietly served as a full
  snapshot is a quota bill nobody asked for.

### The budget binds the FLEET

`catalog_source_refresh_leases` is `supplier_call_leases` (#122) pointed at an
inbound source. **"How many calls per minute may this source receive across
every ECS task" is not a question an in-process token bucket can answer** —
every task answers it separately and their sum is whatever the task count
happens to be.

A slot is a ROW, so concurrency is exact; the per-minute allowance rides the
same row, so the rate bound is serialized by the same lock. The trade is stated:
an uneven arrival pattern can leave one slot's share unused while another is
spent, so the limiter can UNDER-admit — which errs toward not exceeding the
provider's published limit.

This does NOT replace #62's source lease, which is about ownership. A source
with a concurrency of four wants four holders of this and exactly one owner of
that.

---

## Anomaly protection: the page is judged BEFORE any of it is published

#62's page loop was persist-then-advance per record. #68 splits it, because
"never overwrite prior current offers with unvalidated anomalous records" is not
something a per-record check can promise: by the time the last row of a page has
shown the distribution to be wrong, the first ninety-nine have already replaced
ninety-nine live prices.

So: every record is PERSISTED (provenance is never withheld, whatever the
verdict), the page's distribution is compared against the source's stored
baseline, and only then is the page ADVANCED. A quarantined page advances
nothing — `advanceObject` is unreachable, which makes the guarantee a property
of the call graph.

### The four detectors, and the fixture that makes them mean something

| Kind | Statistic | Fires when |
|---|---|---|
| `feed_wide_zero_price` | zero-priced / priced | above the source's share threshold; needs NO baseline |
| `currency_change` | the dominant currency | it differs from the baseline's |
| `price_scale_shift` | median ratio | beyond the source's factor, either way |
| `mass_disappearance` | unseen / known objects | above the share threshold, snapshot only |

**A legitimate sale does not trip the scale detector** and there is a test that
says so: a catalogue-wide half-price sale moves the median by 2×, well inside a
default factor of 10, while publishing majors where minors were moves it by
exactly 100×. The thresholds are per source precisely so a feed with a genuinely
volatile median can raise its own rather than everybody lowering theirs.

Three things stop the detectors firing on nothing:

- **A minimum sample size**, so a distribution over nine rows is not treated as
  evidence about a catalogue.
- **The median is taken WITHIN the dominant currency**, so a change in a feed's
  currency MIX does not read as a change in its prices.
- **`mass_disappearance` is measured FIRST and is NOT gated by the price-sample
  floor.** That ordering is load-bearing and was got wrong once: the pass that
  fails to mention everything is the one that returns zero records, so gating it
  on the sample size made the worst case the one case the detector was silent
  about — silent in the direction that retires a whole catalogue. It has its own
  floor, on the prior object count.

`mass_disappearance` gates RETIREMENT rather than publication: it is the one
finding a page cannot make, and its consequence is destructive.

### Clearing a quarantine

Two ways, recorded differently and deliberately:

- **`released`** — an operator publishes the output after all. The actor is
  MANDATORY (`catalog_source_run_quarantines_actor_shape_check`).
- **`corrected`** — a later run published a distribution the detectors accept.
  It names no actor, and the same CHECK makes that structural: a correction
  attributed to a person would be indistinguishable from a release afterwards.

A correction is scoped to ONE kind: a feed whose currency came back has not
thereby answered a mass-disappearance finding.

The BASELINE is only ever written by a run that was NOT quarantined
(`recordSourceDistribution` takes the verdict as an argument and refuses
otherwise), because accepting one from a run nobody believed would let a broken
feed re-base its own normal in two passes and then look healthy for good.

The baseline is captured from the run's CLOSING page rather than from the whole
run. That approximation is stated rather than hidden: a running median needs
every price of a million-row feed in memory or a t-digest, and neither is worth
building for a comparison whose job is to notice a change of SHAPE. A page is a
representative sample of a paginated feed, and the minimum-sample floor is what
keeps a short final page from becoming the baseline.

---

## The health surface

`GET /internal/offer-freshness/sources/:sourceId/health` answers everything #68
§"Source health" lists: last success and failure, consecutive failures, the
error classification counted from the RUNS (with their denominator, so three
`auth_failure`s out of four reads differently from three out of four hundred),
the offer counts by freshness level, the oldest current observation, the queue
depth and lag, the retry backlog, the anomaly counts and the per-market and
per-advertiser breakdowns.

The offer counts are DERIVED from the same `assessOfferFreshness` the comparison
read uses, so "the board says 40 current" and "the page shows 40" are the same
number by construction. There is no stored `warning_offers` column and there
must not be.

The read is bounded (`HEALTH_OFFER_SCAN_LIMIT`, newest-seen first) and the
counts are "of the offers examined". The decisions this board drives are "is
this feed degraded" and "which market is broken", and both are answered by a
bounded sample of the rows a refresh has touched most recently.

**Per-market and per-advertiser, because "unhealthy" is rarely global.** An Awin
feed whose Spanish advertiser left the network looks perfectly healthy in
aggregate; the only thing that says otherwise is one `country` or one
`affiliate_program_ref` going to zero current offers.

---

## The product summary, and why there is nothing to rebuild

#68 asks for "a rebuild of derived product availability and price summaries
after eligible-offer changes". #61 measured the alternative at one million
offers — every read an indexed single-digit-millisecond query — and adopted NO
materialized view or denormalized read model;
`docs/performance/canonical-graph-benchmarks.md` carries the numbers and the
explicit list of reads that stay normalized.

So `readProductOfferSummary` computes it LIVE from the offers a comparison would
show, and "rebuild after an eligible-offer change" is satisfied by construction:
a retirement, a revival or a price move changes the next read's answer with
nothing in between to fall out of date. That is a stronger guarantee than a
rebuilt projection, not a weaker one — a projection's correctness depends on
every writer remembering to enqueue it.

It goes through `listOffersForComparison` plus `projectOffer`, the SAME two calls
the public read uses, so the summary and the list can never disagree about which
offers are current.

`rollUpOfferAvailability` never answers `in_stock` from silence, and a product
whose every offer has expired reports `unknown` with a zero count rather than
`out_of_stock` — that is a statement about Mercaria's information, not about the
retailer's shelves. **A product page renders from this summary instead of
failing when every current offer expires** (#68 public behaviour 7).

---

## The outbound gate (#37's seam)

`assertOfferOutboundEligible` decides whether a click may be followed and
composes nothing. Splitting it that way means #37's redirect cannot be built
WITHOUT consulting the gate — it has nothing else that answers "is this offer
still real" — and this domain never learns how to send a browser somewhere.

The freshness verdict is RE-DERIVED at redirect time rather than trusted from
whatever the page that rendered the link believed. A buyer can leave a product
page open for an hour, and an offer that was current when the page rendered is
exactly the one that is not current when they finally click.

The refusal is a REASON and not a boolean: expired, retired, no destination, and
"the source withdrew its outbound-link right" are four different things to tell
a buyer and four different things to alert on.

---

## Discriminated unions use STRING discriminants here

`SourceRefreshLeaseClaim` and `OutboundEligibility` discriminate on
`outcome: 'granted' | 'refused'` rather than on a boolean, and that is a
compiler constraint rather than a style preference. **This package compiles with
`strict: false`, and without `strictNullChecks` TypeScript does not narrow a
union on the TRUTHINESS of a boolean-literal discriminant** — `if (!claim.granted)`
leaves the caller holding the whole union, so reading the refusal reason does not
compile. #122's `SupplierCallLeaseClaim` sidestepped it by hardcoding one reason
at the call site and throwing the other away; here the caller must act on the
difference, so the discriminant is a string.

---

## Environment

```
OFFER_REFRESH_ENABLED=false            # gates the LOOP, never the durable record
OFFER_REFRESH_BATCH_SIZE=25
OFFER_REFRESH_POLL_INTERVAL_MS=15000
OFFER_REFRESH_LEASE_MS=120000
OFFER_REFRESH_MAX_BACKOFF_MS=21600000
OFFER_REFRESH_DEFAULT_CONCURRENCY=2
OFFER_REFRESH_DEFAULT_CALLS_PER_MINUTE=60
OFFER_EXPIRY_SWEEP_ENABLED=false       # gates the LOOP; display needs no sweep
OFFER_EXPIRY_SWEEP_BATCH_SIZE=500
OFFER_EXPIRY_SWEEP_INTERVAL_MS=60000
```

**There is no default TTL, no default warning threshold and no default expiry**,
and there must never be one — see the top of this document. What lives here is
the LOOP's shape and how hard Mercaria knocks when a source states no limits of
its own.

Turning the expiry sweep off cannot make a stale offer visible: the freshness
verdict is derived at read time against the live policy, so the sweep only
decides when the durable retirement is written down.

---

## The operator surface

`/internal/offer-freshness/*`, behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
allow-list #54/#56/#57/#58/#60/#62 use — who may decide what an external source
is permitted to do and who may decide how long its facts are worth showing are
the same power over the same graph. Empty list = not mounted (404, never a 401
that would advertise the surface). It stays mounted while
`OFFER_REFRESH_ENABLED` is off.

| Route | What it does |
|---|---|
| `GET /sources/:id/health` | everything §"Source health" lists, plus the live quota |
| `GET /sources/:id/policies` | every freshness version this source has ever had |
| `POST /sources/:id/policies` | publish and activate a version, superseding the last |
| `GET /sources/:id/tasks` | this source's refresh queue, most urgent first |
| `POST /sources/:id/refresh` | a whole-source pass, or a targeted re-read of one object |
| `GET /sources/:id/quarantines` | the OPEN findings |
| `POST /quarantines/:id/release` | publish a quarantined run's output, on the record |
| `POST /drain` | one refresh tick and one expiry sweep now |

**Deliberately absent:** "set this offer's freshness" (the verdict is derived,
and a stored one would be the second representation the domain exists to
avoid — reached for during an incident, on an offer a customer complained
about); "retire this offer" (#57's surface owns retirement); "clear this
source's baseline" (a button that makes a broken feed look normal); any delete;
any flag write.

---

## Two teardown hazards this domain surfaced, both cross-file

Neither is about #68's behaviour; both are about a shared test server, and both
are recorded because the next domain to add a realdb file will meet them.

1. **`alter table … disable trigger` is DATABASE-WIDE.** Three realdb files
   disable a policy trigger to delete a frozen version in teardown, and two of
   them inside that window at once leaves one deleting against a trigger the
   other has just re-enabled. The whole window is now taken under a session
   ADVISORY LOCK on one shared key; the key's value means nothing and its
   sameness is the mechanism.
2. **A bare array in a `sql` template renders as a ROW CONSTRUCTOR.**
   `source_id = any(${ids}::text[])` emits `($1, $2, …)::text[]`, which Postgres
   refuses outright — the trap `~/Oxy/AGENTS.md` §"Drizzle `sql` templates"
   names, and one `tsc` cannot see. `sql.param([...])` binds the whole array as
   one parameter.

## Tests

- **`services/__tests__/offer-freshness.realdb.test.ts`** — the seven acceptance
  criteria, each against a real PostgreSQL server. Every constraint assertion
  walks the error's CAUSE chain, because drizzle's outer message never carries
  the constraint name and a test matching only it would pass against any refusal.
- **`services/offer-freshness/__tests__/offer-freshness-rules.test.ts`** — the
  pure rules, with an instant exactly ON each threshold, a policy that differs
  from a valid one ONLY in its `sourceId`, and a legitimate sale beside a
  minor/major units error.
- **`services/offer-freshness/__tests__/freshness-isolation.test.ts`** — the
  four scanned walls, with a vacuity floor per file, an enumeration floor read
  off the real directories, and a mutation self-test on every detector.

Two constraints were caught by these tests and are worth restating, because both
are silent in the permissive direction:

1. **`array_length` of an EMPTY array is NULL, and a CHECK rejects only FALSE.**
   `array_length(target_external_ids, 1) >= 1` ADMITTED a targeted run with no
   ids. Both such constraints now read `coalesce(array_length(…), 0)`.
2. **A page of UNCHANGED records never reaches the publication gate**, so an
   anomaly test that seeded its baseline after a first ingest and then re-ran
   the same feed asserted through a path it was not about. The baseline is
   seeded BEFORE the single run it judges.

---

## What is deferred, and to whom

Each is a NAMED contract that fails closed, never a stub that lies.

- **#37 — the outbound redirect.** This domain supplies
  `assertOfferOutboundEligible` and composes no tracked URL; a scanned gate
  fails the build if it starts to.
- **#78 / #79 — the price-history table and price alerts.** `alerted` is a
  member of the priority vocabulary and `requestPriorityRefresh` is the entry
  point they call; nothing here reads or writes an alert, and no module may
  import one. The rule #68 asks for — "an old price cannot trigger a new price
  alert after the offer becomes stale" — is already true of anything that goes
  through `mayAppearInComparison`, which is the only way a current offer is
  obtained.
- **#77 — popularity.** `popular` and `clicked` are entry points, not signals
  this domain computes.
- **#74 — ranking.** Freshness is not a ranking input, and a scanned gate says
  so in both directions.
- **#63 / #65 / #66 — the adapters.** None is registered, so every refresh task
  dead-letters with `adapter_missing` and says why. `refreshModes` is REQUIRED
  on the adapter interface precisely so a new adapter must state what it can do
  rather than claim everything by silence.
- **#86 — dashboards.** `readSourceCatalogHealth` is the projection they read;
  scraping and alerting wiring belongs to `oxy-infra`.

---

## Production-readiness checklist

1. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or the surface is not mounted and
   nobody can publish a freshness policy or release a quarantine.
2. For each source: a freshness version published, reviewed, and its thresholds
   set against that provider's own contract — the `source_configuration`
   fallback is a safe default, not a reviewed decision.
3. `OFFER_REFRESH_ENABLED=true` only after a source has been drained by hand
   from `/internal/offer-freshness/drain` and its health read.
4. `OFFER_EXPIRY_SWEEP_ENABLED=true` once at least one source has a published
   grace window; until then lapsed offers are already invisible and simply are
   not retired.
5. Alerting on a non-empty quarantine board, on a climbing `deadLettered` count,
   and on any market or advertiser whose current-offer count falls to zero.
