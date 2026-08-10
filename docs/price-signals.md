# Trustworthy price signals and merchant competitiveness (#82)

Turning #78's immutable observations and #74's eligible offers into CLAIMS about
a price — "the lowest new price in thirty days", "8% above the recent median",
"good price" — without presenting weak, mixed or manipulated data as certainty.

Code: `services/price-signals/` (11 modules), `db/priceSignals/` (4
repositories), `db/schema/priceSignals.ts` (4 tables), `routes/price-signals.ts`
(public), `routes/merchant-competitiveness.ts` (merchant),
`routes/internal-price-signals.ts` (operator), `@mercaria/shared-types`
`price-signals.ts`, and `@mercaria/ui` `lib/price-signal-labels.ts` (the copy).

Binding dependencies: #44's money and FX, #74's eligibility, #78's price
history. Schema decisions: `db/schema/CONVENTIONS.md` §"Price signals (#82)".

---

## The failure mode that shapes everything here

**A confident label computed off nothing.** Four shapes of it, and every decision
below exists to make one of them unrepresentable:

1. A "historic low" that is one retailer's decimal-point error.
2. A "good price" derived from two observations, presented exactly like one
   derived from two hundred.
3. A "lowest ever" that silently blends the used copy into the new one, or last
   year's euros into today's dollars.
4. A syndicated feed republishing one merchant's offer five times, so a market of
   one reads as a market of five.

---

## Three states, and the middle one is the one people collapse

| State | Carries | Means |
|---|---|---|
| `measured` | a value AND its evidence | the claim holds |
| `not_present` | the sample, no value | the derivation RAN and the condition does not hold |
| `unmeasured` | the sample and a reason, no value | the sample could not support a claim either way |

Only `measured` has a `value` or an `evidence`, so a consumer that wants a number
must switch on the discriminant and one that forgets gets a type error rather
than `undefined` — #74's `RankingSignalOutcome` device.

`not_present` is what a two-state design loses. "There was no material drop" and
"we could not tell" lead a shopper to opposite conclusions; reporting the first as
`unmeasured` tells a merchant their data is too thin when it is fine, and
reporting it as `measured` with a zero tells a shopper there was a drop of
nothing.

---

## The seven signals, which are the issue's eight minus a DIMENSION

Issue §"User-facing signals" item 7 — "used or refurbished value signals kept
separate from new" — is not a seventh kind of claim. It is
`PriceSignalSubject.segment` being part of every signal's identity, and #78 read
its own list the same way for the same reason: a value would leave `open_box`
(which #90 has and the prose does not) unrepresentable without a vocabulary
change.

- `lowest_observed_item_price` / `lowest_observed_known_total` — the low in a
  NAMED range. The known-total one is legitimately sparser: an offer whose
  delivery nobody published is excluded rather than treated as free.
- `current_vs_recent_median` — TEMPORAL. Today's price against the middle of the
  recent history.
- `material_price_drop` — against a prior VALID observation.
- `typical_recent_range` — the inter-quartile range, at nearest rank.
- `official_store_position` — the `new` segment only, and against OTHER offers.
- `price_quality_label` — CROSS-SECTIONAL, with a confidence.

**`current_vs_recent_median` and `position_vs_eligible_median` are deliberately
different signals with different names.** "Cheap for this product lately" and
"cheap compared with other sellers today" are different claims, and a shopper
shown one number could not tell which they were being told.

---

## The statistics, and where each obvious implementation is wrong

### Deduplication comes FIRST, and it is keyed on the SELLER

A syndicator republishing one retailer's offer produces two `offers` rows, and a
naive count reports a market of two. The unit is the seller: a canonical merchant
id where there is one, a native listing id otherwise, and **nothing** where
neither is known — such an offer is EXCLUDED rather than given a key of its own,
because a per-offer fallback inflates the distinct-seller count in the one
direction that makes a weak sample look strong.

The ORDER is load-bearing. Reversed, five syndicated copies of one wrong price
form their own cluster, pull the median toward themselves and make the CORRECT
prices look like the outliers — the failure deduplication exists to prevent,
arriving through the door marked "robust statistics".

`distinctOffers` counts BEFORE the fold, so the policy's two floors stay
independent: three merchants reached through nine feeds clears both honestly.

### The outlier rule is a CONJUNCTION, and each half alone is wrong

Iglewicz–Hoaglin modified z-score, `0.6745 × (x − median) / MAD`, **and** a
relative floor in basis points. Both, because:

- **The z-score alone deletes every real discount on a tight market.** Measured:
  twelve retailers within 2% of each other give a MAD of ten minor units, and a
  genuine half-price sale scores a modified z of 33 — so "recent low", the signal
  that exists to report a sale, would report everything except the sale.
- **The relative floor alone deletes a legitimate low on a volatile market**,
  where a 90% spread between sellers is ordinary and says nothing about any one of
  them.

Together they mean "far from the rest of this sample AND far enough that it cannot
be a promotion", which is statistical policy 6's distinction between a sale price
and a scale error. #78 reached the same place from the other side with
`PRICE_SCALE_SHIFT_FACTOR`.

**When MAD is zero, nothing is an outlier.** More than half the sample carrying
one identical value makes every other value infinitely deviant, and the naive
implementation excludes every price that is not the mode — which fires exactly
where a catalogue is healthiest. Stated in `partitionOutliers` rather than left to
a `Number.isFinite` check downstream, because the downstream version would
silently produce an empty sample and read as insufficient data.

An outlier is **named, never deleted**: `evidence.excludedOutlierObservationIds`
carries it on every measured signal, and the observation stays in
`offer_price_snapshots` untouched. That is what makes "handle outliers with a
documented robust method rather than deleting inconvenient data" checkable.

### Every published figure names an observation

Nothing interpolates. The median of an even-sized sample is the LOWER middle
value and a quartile is taken at NEAREST RANK, so every figure a signal publishes
is a price somebody actually charged and traceable to one immutable row. An
interpolated median is a number no seller ever asked for, and a chart that cites
it can cite nothing.

The cost is stated: on an even-sized sample the median sits one position low. The
seller floor is what stops that mattering.

---

## The policy is a VERSION, and there is deliberately no built-in one

`price_signal_policy_versions` — the `fee_schedules` / `ranking_policy_versions`
device: immutable once it leaves `draft` (trigger), one active per key (partial
unique), archived rather than deleted.

**No active version ⇒ every signal is `unmeasured`/`no_active_policy`.** That is
the deliberate divergence from #74's `BUILTIN_RANKING_POLICY`, and the asymmetry
is the reason: a ranking must produce SOME order or the comparison surface has
none, while a claim about a price need not be made at all. "Nobody has decided
what 'good price' means here" is the purest insufficient sample there is, and its
honest rendering is a product page with no badge.

**There is no `canary` status and no share column.** A ranking canary shows two
shoppers two ORDERS of the same offers; a signal canary would show them two
contradictory CLAIMS about one price, with nothing on either page saying a
rollout is in progress. Version comparison is a `candidate_comparison` RUN
instead — every number, no shopper (monitoring 6).

**`PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR` is a CHECK, and the reason is not
disclosure.** Every offer this domain reads is one a shopper already sees on
`/offer-comparison`, so a median over them discloses nothing that is not already
published. The floor exists because the WORD has to mean something: a "market
median" over two sellers is one rival's price wearing a statistical name.

**`goodPriceBelowMedianBps >= typicalBandBps` is a CHECK too.** Without it the two
verdicts overlap, one price satisfies both, and which one a shopper sees is
decided by the order of the comparisons in the code rather than by the row.

---

## Merchant competitiveness

`GET /merchant-competitiveness/:merchantId`, gated by **#83's verified claim** —
`merchants.claim_state = 'claimed'` plus `claimed_by_oxy_user_id` — and by nothing
else. An unclaimed merchant, a pending claim, a revoked one and a caller who is
somebody else all answer the SAME 404: a distinguishable 403 would let anybody
enumerate which merchants have been claimed. It is not a seventh operator
allow-list, and revocation removes the surface with no sweep, because it reads the
verdict #83 writes.

### What the shape does NOT have is the security property

`MerchantCompetitivenessRow` has no competitor id, no competitor name and no
competitor price. Every reference figure is an AGGREGATE over a sample the seller
floor guarantees is a market. `MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS` states
the prohibition as a VALUE, gated statically AND by a realdb walk of a REAL
emitted response — #92's two-gate rule, because a static scan catches a declared
field and only a runtime walk catches one a serializer spread in.

**This domain reads no buyer-side data at all** — no order, no session, no
conversion, no click, a scanned gate — which is why #77's suppress-below-ten
posture has nothing here to apply to, and why the demand insight is a refused
seam rather than a number.

### The seven insights

Items 7 and 8 of the issue's list are not insights: "market and condition scope
for every comparison" is `subject` on every row, and "coverage and confidence" is
`sample` on every row. Both are properties the shape carries.

`losing_eligibility` narrows #74's exclusion vocabulary to what a merchant can
ACT on. `merchant_suppressed`, `listing_restricted` and `source_display_withheld`
are moderation and rights decisions with their own notification paths, and
repeating them on a dashboard would be a second channel for a decision that has
one — and a worse one, because a dashboard row cannot carry an appeal.

`cheapest_item_price` compares against the cheapest OTHER seller, not the cheapest
overall: comparing a price against a minimum it is itself in answers "am I me".

### The export

`?format=csv` renders exactly the rows the JSON carries — a second query with its
own idea of what a merchant may see is how an export ends up with a column the API
withholds. Every cell is quoted and a leading `=`, `+`, `-` or `@` is prefixed
with an apostrophe: a spreadsheet reads those as a FORMULA, and every value here
comes from a catalogue somebody else writes.

---

## Recommendations are DERIVED from rows that already exist

That order is the safety property. A recommendation cannot assert anything the
competitiveness rows do not, cannot reach a sample the rows refused, and cannot
exist for a subject whose row is `unmeasured` — so acceptance 3 holds for free
rather than being re-implemented and got subtly wrong.

`PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS` names automatic repricing, a guaranteed
sales outcome, a guaranteed ranking position and purchased placement as VALUES
disjoint from the allowed set. No function returns a price, no module imports a
catalogue write, and the COPY lives in `@mercaria/ui` — so a sentence that
promised something would be a change to a file this domain does not own and a
test does scan.

`would_be_cheapest_item_price` is conditional on purpose: it is emitted for a
merchant whose price beats every other seller's while their own offer is not
currently eligible. "Is the cheapest" would be false, and saying nothing would
withhold the one fact that makes fixing the eligibility worth their time.

---

## Monitoring: a measurement, never a cache

`price_signal_evaluations` is a RECORDING — the `payment_discrepancies` and
`retail_eligibility_decisions` relationship — and `price-signal-isolation.test.ts`
fails the build if a read path selects from it. Nothing serves a shopper or a
merchant from it: the inputs live on tables in four other domains, and a cached
"good price" survives the moderation restriction, the rights withdrawal and the
retirement that should have withdrawn it.

What it exists for is the four things a live derivation cannot answer: coverage
over time, the insufficient-data rate, the distribution of labels, and whether a
policy or feed change moved a great many signals at once.

- **The vacuity floor is a CHECK.** `price_signal_runs_subject_counters_check`
  forces the three subject outcomes to SUM to `subjects_scanned` by EQUALITY, and
  the signal counters likewise, so a page that swallowed a subject cannot write a
  row. `signalsFromRecords` counts the evidence beside the run's own counter and
  reports `countsAgree` — #60's device.
- **The mass-change diff compares the INTERSECTION of two runs' subjects.** A
  subject present in one and absent from the other has not changed its label, it
  has entered or left the cohort, and counting that as a change would make every
  catalogue growth look like an incident.
- **It reports and repairs nothing.** The interesting fact is the COINCIDENCE
  with a policy or feed change, which is why `policyVersionChanged` travels
  beside the rate; a domain that reacted to its own instability would be
  suppressing the evidence of it.
- **The label distribution obeys #80's disclosure floor**, withheld as a STATE
  rather than rounded: a breakdown over a market carrying four products is that
  market's catalogue with a percentage sign on it.
- **Correction reports are a MEASURE**, which is why the reason is a closed set
  and why `resolved` and `rejected` are kept apart — the correction rate is the
  ratio between them, and one `closed` state would make it unreadable.

---

## Surfaces

**Public:** `GET /price-signals` — no auth, the `listings` rate-limit budget,
behind `PRICE_SIGNALS_PUBLIC_READS_ENABLED`. The response carries the signals, the
`semantics` (what the numbers mean, which the analytics domain's rule requires)
and plain `explanation` sentences. The explanation is part of the PAYLOAD for
#78's reason: a summary composed on three clients is three summaries, and the one
that forgets to say which segment it used is the one nobody is looking at.

**Merchant:** `/merchant-competitiveness/*`, above. Its own rate-limit bucket
because one request costs a comparison read per subject examined.

**Operator:** `/internal/price-signals/*` on the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` allow-list every other catalogue surface uses —
deciding what "good price" MEANS is the same power over the same graph as deciding
which offers exist and in what order they appear. Mounted while the sweep is off
and while nothing is published, because a deployment with no active version is
exactly when somebody needs to publish one.

**The route set is CLOSED and four absences are the point:** no "set this label",
no "hide this observation", no "pin this price", no "suppress this signal". Every
one would be a way to make a price signal say something nobody measured, which is
the single property that makes it worth publishing.

---

## Environment

```
PRICE_SIGNALS_ENABLED=false                 # the measurement LOOP, never a record
PRICE_SIGNALS_PUBLIC_READS_ENABLED=false    # the /price-signals MOUNT
PRICE_SIGNAL_OFFER_SAMPLE_LIMIT=200
PRICE_SIGNAL_SWEEP_BATCH_SIZE=25
PRICE_SIGNAL_SWEEP_POLL_INTERVAL_MS=60000
PRICE_SIGNAL_SWEEP_LEASE_MS=300000
PRICE_SIGNAL_MERCHANT_SUBJECT_LIMIT=200
PRICE_SIGNAL_MASS_CHANGE_SAMPLE_LIMIT=5000
PRICE_SIGNAL_TRACE_LIMIT=200
```

**Not one threshold, floor or window that decides what a signal MEANS is here.**
Every one lives on a `price_signal_policy_versions` row, versioned, frozen once it
serves and cited by every evaluation — because acceptance 4 asks that a signal be
reproducible from immutable observations and a POLICY VERSION, and a number read
out of the environment is reproducible from neither. There is also no
`PRICE_SIGNAL_POLICY_KEY`: the key is a code constant, per the house rule every
other versioned policy follows.

With every default in place a deployment publishes no policy, builds no signal,
serves no public route and runs no sweep — and a merchant's competitiveness read
answers honestly that nothing has been defined yet.

---

## Tests

- **`services/price-signals/__tests__/price-signal-rules.test.ts`** — the pure
  rules. The fixtures are chosen to exercise the distinctions: a syndicated
  duplicate at a DIFFERENT price, a MAD of exactly zero, a legitimate half-price
  sale beside a units error, an EVEN-sized sample, and a sample one short of each
  floor in turn.
- **`services/price-signals/__tests__/price-signal-isolation.test.ts`** — seven
  scanned walls with a vacuity floor and a mutation self-test each, including the
  REVERSE direction: no module under `services/ranking/` may reference this
  domain (acceptance 6).
- **`services/__tests__/price-signals.realdb.test.ts`** — the CHECKs, the two
  triggers, the composite foreign key, the two partial uniques and the runtime DTO
  walk, against a real server. The `cardinality` case is the one to read:
  `array_length('{}', 1)` is NULL, a CHECK rejects only FALSE, and the obvious
  spelling ADMITS exactly the empty guardrail list it exists to refuse.

**One real bug the realdb suite caught on its first run**, and it is the kind
only a real server finds: `activatePriceSignalPolicyVersion` superseded the
incumbent of whatever `PRICE_SIGNAL_POLICY_KEY` names rather than of the target
row's OWN key. The partial unique is per key, so the supersede left the real
incumbent standing and the activation failed on the index. Today the two
spellings agree; the column exists because a second comparison surface with its
own policy is foreseeable, and this is the function that would have been silently
wrong on the day it arrived.

---

## What is deferred, and to whom

Each is a NAMED contract that fails closed, never a stub that lies.

- **Product-level DEMAND (competitiveness item 4) — the one thing #82 asks for
  that Mercaria does not measure.** `resolveProductDemand` answers "no data" and
  the insight is `unmeasured`/`demand_measurement_unavailable`. #77 defines no
  product-level demand metric: its twenty-two definitions are search, funnel,
  conversion and coverage rates, none is keyed on a canonical product, and
  `analytics_rollups` has no product dimension to add one to. The two substitutes
  a later reader will reach for are both wrong — `product_save_aggregates` (#80)
  counts an intent to return rather than demand and carries its own disclosure
  floor and ranking wall, and `analytics_search_queries` (#77) is a phrase rather
  than a product and has a hard floor of twenty-five. Closing it needs a #77
  metric definition keyed on a canonical product plus a rollup carrying that
  dimension.
- **#71 — the canonical product page**, which is the surface that renders these
  signals. The API, the copy and the accessible summary are complete; nothing in
  the storefront consumes them yet.
- **#40 — the merchant dashboard screens.** Every endpoint they need exists,
  including the CSV export, the filters (segment, currency, market) and the keyset
  paging.
- **`source` and `category` label distributions** (monitoring 2). The MARKET
  dimension is stored and served; the other two are properties of the OFFERS
  behind a signal rather than of the signal, and copying them onto every
  evaluation row would be a denormalized second representation a merge or a
  re-categorisation puts out of step.
- **`taxInclusion`** is modelled and is `unknown` for every row: `offers` records
  no tax-inclusion fact, so there is nothing to read one from. Closing it is an
  offer-side column and belongs to #57 — #74's `resolveOfferTaxInclusion` waits on
  the same one.
- **#79 — price alerts.** Nothing here reads or writes one. A signal is an answer
  to a question somebody asked, not a subscription.

---

## Production-readiness checklist

1. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or the operator surface is not
   mounted and nobody can publish a policy version — which means every signal is
   `unmeasured` forever.
2. Publish and ACTIVATE a policy version. Empty is a working configuration and
   means no claim is ever made, which is correct and unhelpful.
3. `PRICE_SIGNALS_PUBLIC_READS_ENABLED=true` last, and only once a policy is
   active: until then every read is honest and badge-less.
4. `PRICE_SIGNALS_ENABLED=true` when somebody is going to read the monitoring.
   The sweep costs a comparison read per subject and answers questions nobody has
   asked until a policy has been serving for a while.
5. Alerting on a climbing `insufficientDataRate`, on `countsAgree` going false —
   which is what a swallowed page looks like from outside — and on a mass-change
   `changeRate` that coincides with `policyVersionChanged: false`, which is a feed
   moving rather than a policy.
