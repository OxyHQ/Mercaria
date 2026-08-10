# Currency-safe offer price history and product-level trends (#78)

What each source actually reported about an offer's terms at an instant, kept
immutably; and the product-level trends derived from those observations without
mixing variants, conditions, markets or currencies.

This closes the seam ADR 0002 D18 named when it assigned a price-history TABLE
to #78 and left #57 holding current state alone. Schema decisions:
`db/schema/CONVENTIONS.md` §"Price history (#78)". Upstream: #44 (money and FX),
#57 (the offer), #68 (freshness, refresh and anomaly quarantine), #90 (the
condition taxonomy, which owns the SEGMENT this domain must not mix).

---

## The failure mode that shapes everything here

**A chart that looks continuous, confident and cheap while being a lie.** Four
shapes of it, and every decision below exists to make one of them
unrepresentable:

1. A line drawn straight through three months in which nobody offered the thing,
   because a missing x value looks exactly like a data point that has not been
   fetched.
2. A "lowest ever" that is the used one, on a page about the new one.
3. A price converted at today's rate onto a point from a year ago, with nothing
   saying so — so the chart moves when the currency moves and the seller never
   changed anything.
4. A "total including delivery" computed by treating an unpublished delivery
   cost as free, which puts the offer that told you least at the top.

---

## An observation and a point are different kinds of fact

An **observation** (`offer_price_snapshots`) is what one source said about one
offer's terms at one instant. It is immutable, it retains the source's own
currency verbatim, and it is the evidence.

A **point** (`offer_price_points`) is a derived answer to one question — "what
was the lowest eligible new-condition price on this product that day" — and it
NAMES the observation it came from. It is rebuilt, never incremented.

The type system keeps them apart: `OfferPriceObservation` has no bucket and no
measure, and `PriceHistoryPoint` has no `payload`, no source record and no
change reason. Nothing converts one into the other except `derivePriceSeries`.

---

## Immutability, and why DELETE is nonetheless permitted

`mercaria_offer_price_snapshot_immutable` raises on UPDATE. A correction is a
SUPERSEDING record naming the one it revises (`supersedes_snapshot_id`), so
there is no path — service, replay or `psql` — on which a stored price is
rewritten to something nobody published.

DELETE is deliberately NOT refused, which **inverts the ledger's posture and
matches `analytics_events`**. Erasure on a schedule is the policy here, not an
attack: a source's own agreement can cap how long its facts may be cached
(`catalog_source_policies.cache_ttl_seconds`), that cap is stamped onto
`retention_expires_at` at write time, and the shared expiry sweep honours it. A
trigger refusing DELETE would make retention fail SILENTLY — the sweep would
raise on every row it was contractually obliged to remove.

`offer_price_points.snapshot_id` CASCADEs, so acceptance 6 — "every aggregate
point can be traced to an immutable offer observation" — is true at EVERY
instant rather than true until a sweep runs. A source whose agreement requires
deletion takes its chart with it, which is what the agreement says.

---

## The write path: only an OBSERVATION writes an observation

`recordOfferPriceObservation` is called after an external upsert
(`recordExternalOffer`) and after a native convergence
(`convergeNativeOffersForListing`), and by nothing else.

- **A RETIREMENT writes nothing.** Whether it comes from a source's explicit
  removal, from a snapshot omission or from the expiry sweep, it produces no
  observation — snapshot policy 5, "a source outage does not create a false
  unavailable or zero-price point". A retirement would put a point on a chart at
  the last known price on a day nobody could buy the thing. What it produces
  instead is a GAP, and a gap is a true statement about what Mercaria knows.
- **An offer with no price produces nothing at all.** `item_price_amount` is NOT
  NULL, so a priceless observation has no row shape to be misread as zero later.
  The refusal is COUNTED, because a source that silently stopped publishing
  prices would otherwise look identical to a source nobody is ingesting.
- **It commits with the offer**, in the caller's transaction, and there is
  deliberately no `try`/`catch` around it. In PostgreSQL one failed statement
  aborts the WHOLE transaction, so catching the rejection in JavaScript would
  leave every later statement failing with `25P02` while the page reported
  success. A failure propagates into the isolation that already exists: #62's
  page loop records a per-record `record_error` and continues.

### Deduplication and anchors are one interval

Identical terms re-read INSIDE `PRICE_HISTORY_ANCHOR_INTERVAL_SECONDS` are
suppressed; the first identical reading AFTER it is written as an `anchor`. One
interval, because it is the same question asked twice: "is this worth another
row" is no while a recent identical row already proves the price, and yes once
that proof is older than the interval — a chart drawn from change-only records
cannot tell a price that held for ninety days from a feed that stopped
publishing on day one.

**This is NOT the global TTL #68 forbids.** #68's prohibition is on a
deployment-wide FRESHNESS LIFETIME, because that is a property of an agreement
with one source. This is a property of Mercaria's own STORAGE — how often it is
prepared to write a row saying nothing changed — and it can never extend how
long anything is SHOWN. Same class as a poll interval, which #68 explicitly
permits to be deployment-wide.

A suppressed observation leaves NO row, which is why
`offer_price_write_metrics` exists: counting rows answers "how much did we keep"
and never "how much did we suppress". A domain whose dedup interval was
accidentally zero would write ten times the rows and report a perfectly healthy
write volume.

### The three anomalies, and the one that is a CHECK instead

`currency_changed`, `price_scale_shift` (a factor of ten against the SAME
offer's previous observation, the #68 default for #68's reason: a catalogue-wide
half-price sale moves a price by two and a minor/major units error moves it by a
hundred) and `compare_at_below_price`.

An impossible NEGATIVE price is deliberately absent from that vocabulary: the
column refuses it, so there is no row for a flag to sit on. A vocabulary member
for it would describe a state the database cannot hold.

A flagged observation is STORED and excluded from every series — #68's
persist-then-judge order, because provenance is never withheld whatever the
verdict.

---

## The derivation

`derivePriceSeries` is ONE pure function and both readers call it: the
background rebuild, which persists what it returns, and the merchant-filtered
read, which returns it directly. Two derivations of one answer can disagree; one
cannot.

### The inputs, and which are LIVE

Acceptance 5 asks that a rebuild produce identical output for the same policy
and data, which makes every input a decision:

| Input | Live or historical | Why |
|---|---|---|
| Freshness | **Historical** — read off the observation | Re-deriving live would make a rebuild produce a different chart as a source's policy changed, from the same data, with nothing saying so |
| Price-display right | **Live** | A withdrawn right is a decision to stop showing the data; #68 is explicit that extending its life is what must never happen |
| Run quarantine | **Live** | Snapshot policy 6 says "until released", which is a statement about the present |
| FX rate map | **Live, and its quote is STORED with every point** | There is no historical rate archive to use instead, so the compromise currency rules 4 and 5 name is to record exactly which quote was used |

### The eight series, as TWO dimensions

The issue's list mixes a MEASURE with a SEGMENT. `lowest_item_price`,
`lowest_known_total`, `official_store_item_price`, `native_item_price` and
`mercaria_retail_item_price` are the measures; `new`, `open_box`, `refurbished`,
`used` and `for_parts` are #90's `ConditionGroup`s. "Lowest eligible new item
price", "refurbished price" and "used price" are one measure asked three times.

- **`mercaria_retail_item_price` is representable and produces NOTHING.**
  `OfferKind` has no `mercaria_retail` member — ADR 0002 D18 binds it to epic
  #116's own migration — so the derivation's branch for it can never select a
  row. A test pins the emptiness, so the seam cannot be mistaken for a bug and
  closing it is a change to the OFFER vocabulary rather than to this domain.
- **`official_store_item_price` is empty until #55 verifies somebody.** A
  merchant with no verified `merchant_official_channel_for_brand` relationship
  inside its validity window has no relationship row at all, and a domain match
  or a name match cannot create one.
- **The eighth — "selected merchant or storefront when filtered" — is NOT a
  measure.** Materialising every (merchant × product × segment × measure ×
  currency × granularity) combination is a combinatorial explosion for a
  question hardly anybody asks, and it does not need materialising: an
  unfiltered series spans every seller of a popular product and needs the
  cross-currency comparison a database cannot do, while one seller's history on
  one product is a few hundred rows the derivation runs live. The SAME pure
  function answers both.

### Determinism

The winner of a bucket is the lowest DISPLAY amount, and ties break by
`observedAt` and then by snapshot id — never by array order and never by the
primary key alone. **A uuid v7 key is NOT monotonic within a millisecond**, so
two observations taken in the same tick order arbitrarily, and a rebuild that
tie-broke on the id would produce a different chart on every run for the same
data.

The rebuild is `DELETE` then `INSERT` inside one transaction, never an upsert:
an upsert leaves behind every point the new derivation did NOT produce, so a
bucket that stopped having an eligible observation would keep its old answer
forever and two rebuilds of the same data would not agree.

### Why a stored aggregate at all, when #61 and #68 both refused one

#61 measured a million offers and adopted no materialized view; #68's product
summary derives live for the same reason. Both of those reads are expressible in
SQL. **This one is not**: choosing the lowest price across offers in four
currencies requires an FX rate map that lives in a service and a cache, not in
Postgres, so the comparison cannot be pushed into the query and the alternative
is pulling every observation of every offer of a popular product into the
process on each request.

The exception is therefore about the FX map and not about scale — which is
exactly why a MERCHANT-scoped read, bounded by one seller's own offers, is still
derived live from the same function with no series row at all.

---

## Currency

- **Source snapshots always retain the original money values.**
  `offer_price_snapshots.item_price_currency` carries #57's OPEN shape check —
  an external platform reports whatever currency it trades in, and narrowing it
  here would refuse the OBSERVATION rather than the comparison.
- **A point's `native_currency` carries the presentment tuple's CHECK.** Only a
  convertible currency can become a point, so a value outside the tuple would
  mean the derivation had compared raw minor units across currencies — which
  currency rule 6 forbids and this constraint makes unrepresentable. An
  observation Mercaria cannot convert is recorded faithfully and simply never
  becomes a point, under `currency_not_convertible`.
- **Every conversion carries its quote.** `fx_rate`, `fx_from`, `fx_to`,
  `fx_provider` and `fx_as_of` are present EXACTLY when a conversion happened —
  a biconditional CHECK — so a converted amount with no identifiable rate is
  unrepresentable.
- **`PriceHistoryValue` is a discriminated union on `basis`.** A consumer cannot
  render a figure without seeing whether it is `source_native`,
  `historical_quote` or `current_rate_reinterpretation`, and the last carries
  BOTH quotes. Reinterpretation is OPT-IN: off by default, such a point is
  simply absent, because the honest answer to "I cannot price that in your
  currency" is silence rather than a number with a footnote.
- **Precision is `CURRENCY_PRECISION` and never a hard-coded two.** A
  zero-decimal currency's minor unit IS its major unit; an eight-decimal one is
  six orders of magnitude the other way. The tests exercise both.
- **A known total converts the delivery cost into the ITEM's currency first**,
  so the point has one native amount to record. Converting each half straight to
  the display currency would leave a total whose `native` half does not exist in
  any currency.
- **No module in this domain names a particular currency**, and an isolation
  test scans raw source — COPY included — for the FairCoin and OxyPay spellings.
  `PRICE_HISTORY_SERIES_CURRENCIES` is empty by default for the same reason: a
  default would put one currency into the contract.

---

## The read

`GET /price-history` takes exactly one scope (product XOR variant), one
`currency`, one `segment`, one `measure`, a range and a granularity. The segment
and the currency are REQUIRED: an optional segment would mean answering "all
conditions" for a caller who omitted it, which is precisely the blend acceptance
2 forbids.

The response carries, beside the points:

- **`gaps`** — stretches INSIDE the series' coverage with no eligible
  observation. A real fact about the world.
- **`uncovered`** — stretches the rebuild has not reached. NOT a gap, and the
  distinction is why `offer_price_series` stores a coverage window: "no offer
  existed" and "we have not looked" are identical from a list of points and only
  one of them is a fact about prices.
- **`summary`** — plain sentences, every one naming its segment and its range
  (API rule 5: a "lowest ever" with neither is a number that cannot be wrong
  because it does not say what it is about).
- **`table`** — the same data as rows, each marked `observed | gap |
  not_yet_built`.
- **`semantics`** — what the numbers MEAN, including what the measure did with a
  delivery cost nobody published. The analytics domain's rule that a metric
  whose definition is unstated cannot be served, applied to a chart.
- **`notice`** — the standing statement that a converted figure is display-only
  and names no checkout rail. A constant on every response rather than a note in
  a document, because the claim a display conversion makes by accident is that
  the currency is spendable.
- **`currentOffer`** — present ONLY when the newest point's offer is still
  eligible right now, RE-DERIVED rather than carried over from the rebuild. #68's
  whole point is that an offer that was current when a chart was built is
  exactly the one that is not current when somebody clicks it.

---

## Merges

Issue operations 4 asks that history survive offer, product and merchant merge
workflows, and it does so with **no write and no rehoming**: an observation
carries no canonical id at all. The offer names the variant, the merchant and
the storefront; #59's `offers` phase repoints the offer; and one rebuild picks
up the loser's whole history under the winner.

`merge-plan.ts` therefore retains `offer_price_series` with the TOMBSTONE — it
is a projection, and the `review_aggregates` disposition for its reason plus one
of its own: two series cannot be concatenated, because each of their points
names the ONE cheapest eligible observation in its bucket and the cheapest
across both is neither list. `rebuildEntityAggregates` re-arms both sides, and a
rebuild of the tombstone's own series yields zero points, so it self-clears
rather than sitting as a stale answer forever.

---

## The referral boundary

`price-history-isolation.test.ts` fails the build if any module in the domain
reaches `services/referrals/`, and `PRICE_HISTORY_FORBIDDEN_DTO_FIELDS` names
the prohibition as a VALUE that a realdb case walks a REAL emitted response
against. Two gates, because the static one catches a declared field and the
runtime one catches a field a serializer spread in.

The same file holds four more walls: no FairCoin or OxyPay spelling (raw source,
copy included), no price alert or subscription (#79's, and #80's
`ProductSavePriceAlert` seam stays unsupported), no ranking module (#74's, and
the reverse direction too — a discovery module may not reach price history), and
no payment rail (a display conversion is not a way to pay).

---

## Operations

`GET /internal/price-history/metrics` answers issue operations 1: write volume,
deduplication rate, refusals, anomalies, series counts and the AGGREGATION LAG —
the age of the oldest outstanding rebuild, ABSENT rather than zero when nothing
is outstanding, because reporting zero would make a stalled dispatcher
indistinguishable from an idle one.

`GET /internal/price-history/offers/:offerId` is the observation trail. It opens
from an OFFER id and nothing else: a price history is a record of what sellers
published, and a surface that could be asked "show me everything this person
saw" is a different thing entirely.

`POST /internal/price-history/series/rebuild` DRIVES the existing idempotent
path. There is deliberately **no "set this point", no "hide this observation",
no "correct this price" and no delete** — every one of those would be a way to
make a price history say something nobody observed, which is the single property
that makes it worth keeping.

All three are behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
#54/#56/#57/#58/#60/#62/#68 use, and the router stays mounted while
`PRICE_HISTORY_ENABLED` is off — the evidence has to be readable during the
incident that turned the loop off.

### Shard and archival strategy — recorded, not adopted

Issue operations 5 asks for one "before data volume becomes operationally
expensive". The decision, with its reasoning rather than a number nobody
measured:

- `offer_price_snapshots` is the only table in the domain whose size is a
  function of TRAFFIC rather than of the catalogue. Its growth is bounded by
  (offers × observations that changed something) plus one anchor per offer per
  `PRICE_HISTORY_ANCHOR_INTERVAL_SECONDS`, so the anchor interval is the knob
  that decides the floor.
- **Nothing is partitioned today, and that is deliberate.** drizzle-kit models
  no partitioning, so a declarative partition would be hand-written DDL the
  schema snapshot does not know about — the exact shape that breaks the next
  person's `db:generate`. The prerequisite is a measurement in
  `docs/performance/` on the shape #61 established, not a guess.
- When it is adopted, the natural key is `observed_at` by month: every read in
  the domain is bounded by a time range (`listPriceObservationsForScope` takes
  `from`/`to`), the retention sweep is a range delete, and the rollup granularity
  is already a time bucket. The rebuild's own `PRICE_HISTORY_REBUILD_OBSERVATION_LIMIT`
  is the interim bound.

---

## Environment

```
PRICE_HISTORY_ENABLED=false                 # gates the rebuild LOOP, never the record
PRICE_HISTORY_PUBLIC_READS_ENABLED=false    # gates the /price-history MOUNT
PRICE_HISTORY_SERIES_CURRENCIES=            # EMPTY by default — no series are built
PRICE_HISTORY_ANCHOR_INTERVAL_SECONDS=86400
PRICE_HISTORY_RETENTION_WINDOW_DAYS=400
PRICE_HISTORY_MAX_QUERY_SPAN_DAYS=400
PRICE_HISTORY_REBUILD_OBSERVATION_LIMIT=50000
PRICE_HISTORY_REBUILD_BATCH_SIZE=10
PRICE_HISTORY_REBUILD_POLL_INTERVAL_MS=30000
PRICE_HISTORY_REBUILD_LEASE_MS=120000
PRICE_HISTORY_REBUILD_MAX_BACKOFF_MS=21600000
PRICE_HISTORY_TRACE_LIMIT=500
```

With every default in place a deployment records observations on every offer
write, enqueues NO series, builds NO charts and serves no public route. The
durable record is never gated; the derived answer is.

---

## Tests

- **`services/price-history/__tests__/price-history-rules.test.ts`** — the pure
  rules. The fixtures are chosen to exercise the distinctions: an interval
  exactly ON the anchor boundary and one millisecond either side, a legitimate
  half-price sale beside a units error, a zero-decimal currency beside an
  eight-decimal one, a rate map whose base is neither, and two observations in
  the same millisecond whose winner must not depend on array order.
- **`services/price-history/__tests__/price-history-isolation.test.ts`** — the
  five scanned walls plus the DTO gates, each with a vacuity floor and a
  mutation self-test.
- **`services/__tests__/price-history.realdb.test.ts`** — the constraints and
  the acceptance criteria, against a real server. The `cardinality` case is the
  one to read: `array_length('{}', 1)` is NULL, a CHECK rejects only FALSE, and
  the obvious spelling ADMITS exactly the row it exists to refuse.

---

## What is deferred, and to whom

Each is a NAMED contract, never a stub that lies.

- **#79 — price alerts.** Nothing here reads or writes an alert, no module may
  import one, and #80's `ProductSavePriceAlert` seam still has ONE branch and it
  is the unsupported one. The rule #68 records — an old price cannot fire a new
  alert after the offer becomes stale — is already true of anything obtained
  through `mayAppearInComparison`.
- **#116 — the `mercaria_retail` offer kind.** The measure exists and is
  provably empty; closing the seam is adding a member to `OfferKind`.
- **#74 — ranking.** A scanned gate, both ways.
- **#59 — corrections.** A superseding observation is the shape a correction
  takes and the column exists; the operator WORKFLOW that decides one is #59's.
- **#71 — the canonical product page**, which is the surface that renders these
  charts. The API and the accessible summary are complete; nothing in the
  storefront consumes them yet.
- **`taxInclusion`** is modelled and is `unknown` for every row today: `offers`
  records no tax-inclusion fact, so there is nothing to read one from. Closing it
  is an offer-side column, which belongs to #57.

---

## Production-readiness checklist

1. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or the operator surface is not
   mounted and nobody can read the metrics or trace an offer.
2. Decide `PRICE_HISTORY_SERIES_CURRENCIES`. Empty is a working configuration
   and means no chart is ever built; every code listed multiplies the series
   count by one.
3. `PRICE_HISTORY_ENABLED=true` only after the series set is decided — the
   dispatcher's work is a function of it.
4. `PRICE_HISTORY_PUBLIC_READS_ENABLED=true` last, and only once at least one
   series has a non-empty coverage window: until then every read is honest and
   empty, which is correct and unhelpful.
5. Alerting on a climbing `seriesDeadLettered`, on `oldestPendingRebuildAgeSeconds`
   exceeding a rebuild interval, and on a `deduplicationRate` that falls to zero
   — the last is what a broken dedup looks like from outside.
