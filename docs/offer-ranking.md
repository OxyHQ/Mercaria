# Offer eligibility, ranking and comparison labels (#74)

How Mercaria chooses which offers a shopper sees for one product, in what order,
and how it explains both — without selling organic rank, hiding unknown costs, or
letting affiliate economics or a currency preference distort the result.

Code: `services/ranking/` (10 modules), `db/ranking/rankingPolicyRepository.ts`,
`db/schema/ranking.ts` (1 table), `routes/offer-comparison.ts` (public),
`routes/internal-ranking.ts` (operator), `@mercaria/shared-types`
`offer-ranking.ts`, and `@mercaria/ui` `lib/offer-labels.ts` (the copy).

Binding dependencies: #44's money and FX, #55's verified relationships, #57's
offer model, #68's freshness, #76's review aggregates, #90's condition taxonomy.

---

## The separation that shapes everything

**Eligibility decides whether an offer may appear. Ranking scores only the set
eligibility admitted.** Two vocabularies, two verdict types, two modules.

The failure this prevents is specific, and the natural single-pass
implementation walks straight into it: "score everything and drop what scores
zero" makes a weight change able to reveal an expired, restricted or suppressed
offer. Here a weight has nowhere to reach — `OfferRankingFacts`, the whole of
what a scorer sees, carries no listing status, no moderation state, no freshness
level and no suppression set.

The composition is enforced in three places:

- `EligibleOffer` is the only shape `rankOffers` accepts, and only
  `selectEligibleOffers` builds one.
- Every `EligibleOffer` carries an `OfferAdmission` naming the rules the
  derivation evaluated, and `rankOffers` **throws** when it does not cover
  `OFFER_ELIGIBILITY_RULES`. This is a RUNTIME guarantee and is stated as one:
  TypeScript is structural, so nothing stops a caller hand-writing the object.
  What it buys is the case that actually happens — a rule added to the tuple and
  not wired into the derivation — and it buys it loudly at the first comparison
  rather than by quietly admitting whatever the rule was meant to exclude.
- `comparison.service.ts` is the one place both meet, and it fetches, builds
  facts, ADMITS, then scores. There is no post-rank filter and no score floor: a
  score is an ORDER, and dropping an offer for scoring badly would be an
  eligibility rule nobody wrote down.

## Unknown is never zero, and the type is what says so

#57's `deriveOfferDelivery` returns a union whose unknown branch has no `cost`
property. #74 extends that shape all the way to the label:

| Value | Unknown branch carries | Consequence |
|---|---|---|
| `OfferComparisonPrice` | a `reason`, no `amount` | no arithmetic can read silence as zero |
| `OfferComparisonTotal` | the `missing` components, no `amount` | `cheapest_known_total` has nothing to be built from |
| `RankingSignalOutcome` | a `reason`, no `normalized` and no `weight` | an unknown cannot enter a weighted sum at all |

**`cheapest_known_total` is unreachable for an offer with unknown shipping, not
guarded against it.** `selectCheapestKnownTotal` takes a `KnownTotalEntry`, whose
`total` is a required `Money`; the only way to build one is to narrow through
`hasKnownTotal`. That is acceptance 2 held by the compiler.

**An unknown signal is left out of the DENOMINATOR** (#58's rule, one domain
over): it contributes to neither half of the weighted mean, so it neither helps
nor hurts. A penalty would be wrong for a reason worth stating — a penalty
asserts something about the OFFER, and the only thing actually known is a gap in
Mercaria's information. What a shopper sees instead is the reason code beside the
offer.

**The one place that reasoning bit back, and how.** `merchant_rating` was
originally normalized against the 0–5 scale. Real ratings live in roughly
[3.5, 5], so 4.5 became 0.9 — and since an unknown is imputed at the offer's own
mean (typically near 1.0), a merchant with a genuine 4.5★ scored BELOW a merchant
with no rating at all. That is a comparison surface rewarding the absence of a
fact, which is the "unknown silently wins" failure in its subtlest form. A
scenario test caught it; the fix was to normalize the rating **set-relative**,
like every other set-relative signal. The cost is stated rather than hidden: two
merchants at 4.4 and 4.5 put the first at 0 — the same property `item_price`
already has for a one-cent difference, bounded by the signal's weight, and a flat
set answers 1 for everybody.

## Eligibility: the ten rules

`OFFER_ELIGIBILITY_RULES`, in the issue's own order. Every reason names its rule
(`OFFER_EXCLUSION_RULE`, total by construction), and every reason that applies is
returned — not just the first, because a seller asking why their offer is missing
needs the whole list.

1. `offer_active` — the offer row is live.
2. `canonical_variant_match` — it prices the variant this comparison is about.
3. `observation_freshness` — `mayAppearInComparison(offer.freshness)`, #68's
   per-source contract. The SQL `stale_at` predicate only ever narrowed the
   candidate set; this derivation is the authority.
4. `market_and_customer` — the published market and customer class.
5. `availability_supported` — against the requested experience.
6. `condition_filter` — the filter the caller set.
7. `native_listing_valid` — read from #57's `deriveNativeCheckoutEligibility`,
   which computed it at projection time from the LIVE listing, the LIVE variant
   stock and the seller's payment readiness. Nothing here re-derives it: a second
   authority over three tables neither domain owns would be wrong for exactly as
   long as the two spellings disagreed, which is the window in which a jury has
   restricted a listing.
8. `external_destination` — an `external` or `affiliate` offer needs somewhere to
   send a buyer. An `informational` one deliberately does not.
9. `moderation_restriction` — kept SEPARATE from rule 7 though both concern a
   native listing: "not published" and "a jury restricted it" are different facts
   with different remedies, and #57 already distinguishes them.
10. `no_suppression` — merchant, storefront or source. `merged` is deliberately
    NOT a suppression: a merged entity is a tombstone pointing at its winner, and
    excluding its offers would hide live inventory to hide a redirect.

### Two unknowns, two opposite treatments, and the difference is what a filter MEANS

- **Unknown AVAILABILITY is admitted** (rule 5) with the signal unknown. Most
  feeds publish no availability at all; refusing them would empty most
  comparisons, and reading silence as in-stock would be the soft yes. `buy_now`
  refuses only what a source POSITIVELY declared unbuyable.
- **Unknown CONDITION is excluded** when a filter is set (rule 6). A shopper
  asking only for used items cannot be shown one whose condition nobody knows —
  an unknown cannot SATISFY a filter. With no filter it passes.

## Ranking: eleven signals, and what may never be one

`OFFER_RANKING_SIGNALS` are the issue's documented inputs 1–10. Input 11 — a
user-selected preference — is deliberately NOT a signal; see "Intents" below.

`OFFER_FORBIDDEN_RANKING_SIGNALS` names eleven prohibitions as VALUES, DISJOINT
from the allowed set (the `RetailCostComponentKind` device). The enforcement is
in four independent places:

1. **The vocabulary** — disjoint unions, asserted by a test with floors on both
   sides.
2. **The facts type** — `OfferRankingFacts` has no member for any of them, so a
   scorer has nothing to read.
3. **The schema** — `ranking_policy_versions` has ONE weight column per allowed
   signal and no column for anything else, so a forbidden weight cannot be
   published. A jsonb weight bag would have undone all of it in one line, which
   is why there is not one.
4. **The scan** — `offer-ranking-isolation.test.ts` fails the build if any module
   in the domain reaches the fee domain, the referral domain, retail pricing, the
   ledger, a plan or a commission, with a mutation self-test on every detector.

**`native_offer_preference` is the subtle one.** `native_mercaria_checkout` IS a
label, because "you can buy this here" is information a shopper wants. What it
must never be is a term in the SCORE. A test pins it: a native and an external
candidate with otherwise identical facts score identically.

**FAIR gets no advantage because the domain names no currency at all.** Every
comparison names ONE currency, the CALLER supplies it, and every price is
converted into it with the `FxRateSnapshot` captured. A scanned gate fails the
build on any FAIR, FairCoin or OxyPay spelling under `services/ranking/`; the
display default lives in `user-preference.service`, where the policy is stated.

### Missing data, per signal

| Signal | Unknown when | Reason code |
|---|---|---|
| `item_price` | unpriced, or a currency no rate covers | `not_published` / `not_convertible` |
| `delivery_cost` | the source published none | `not_published` |
| `tax_inclusion` | always today — no column exists | `no_provider` |
| `delivery_speed` | no window quoted | `not_published` |
| `condition` | the wording did not map onto the taxonomy | `not_published` |
| `merchant_rating` | no aggregate, or below the policy's review floor | `not_published` / `below_confidence_floor` |
| `return_policy` | no normalized facts | `not_published` |
| `availability_confidence` | the source published none | `not_published` |
| `observation_freshness` | no BOUNDED deadline (every native offer) | `no_comparable_basis` |
| `verified_relationship` | the subject resolves to no brand | `no_comparable_basis` |
| `pickup_proximity` | no viewer location, or no collection point | `viewer_location_absent` / `no_provider` |

One of those is still a NAMED SEAM that fails closed rather than a stub that
lies; the other closed when #93 landed (`services/ranking/seams.ts`):

- **`resolvePickupProximity`** answers a real distance since #93 landed, and is
  no longer a seam. It still distinguishes "you have not shared a location" from
  "we have no collection point", because only one of those is something a
  shopper can fix. `best_nearby_pickup` is nonetheless never awarded, because no
  comparison surface accepts a viewer coordinate to measure from — a SURFACE gap
  rather than a missing capability.
- **`resolveOfferTaxInclusion`** always answers `unknown`. `offers` has no tax
  column and no adapter publishes one. Guessing from the market would be the
  worst available answer: a Spanish feed usually quotes tax-inclusive and a US
  one usually does not, and "usually" is how a 21% error enters a total.

Neither is a registry with a `register…` function, deliberately: a registry is a
place a test-only provider can be installed in production (#62's fixture-adapter
reasoning), and each of these is one function body its owning issue replaces.

**`verified_relationship` scores `none` as a REAL ZERO, not an unknown.** Most
merchants hold no relationship row and that is the normal state (ADR 0002 D10).
Absent means the question could not be ASKED — the subject resolves to no brand —
and that is unknown.

## Intents: a primary sort key, never a re-weighting

`OfferComparisonIntent` is `balanced | cheapest | fastest | official | used`. An
intent selects a documented PRIMARY sort key and leaves the policy score as the
secondary; it never changes a weight and never invents a value. A preference
expressed as a weight would make one buyer's chosen ordering indistinguishable
from a policy change, and the two must be separately explainable.

An offer whose fact is unknown sorts LAST under an intent keyed on that fact
(`Number.POSITIVE_INFINITY`), and can never carry the intent's label.

**`cheapest` is THREE tiers, not one**, and that is the honest reading: an offer
with a known TOTAL is comparable on total, an offer with only a known item price
is comparable on that, and neither may be claimed cheaper than the other.
Collapsing them would either bury a genuinely cheap offer whose seller did not
publish postage, or let it outrank an offer whose full price is known and lower.

## Tie-breaking: a digest, never an id

The chain is: the intent's primary key → the policy score → the known total →
the item price → `sha256(policyVersion + ':' + offerId)` compared as hex.

**The last resort is deliberately NOT an id comparison.** `generatedId()` is a
uuid v7 whose leading bits are a timestamp, so ordering ties by id is ordering by
INGESTION TIME — which policy rule 7 forbids by name, and which hands a permanent
advantage to whichever source crawled a product first. The digest is
deterministic for one policy version, stable across re-reads, and uncorrelated
with when a row was written.

The comparator is TOTAL — the digest never ties — so `Array.prototype.sort`'s
stability cannot leak the input order into the result. A property test shuffles
the input and asserts the output is unchanged.

## Labels

Nine, awarded INDEPENDENTLY, each with its own reason code and its own basis. One
offer may carry several; none is a summary of the others, which is why
"the official store and the cheapest offer can be different and both visible"
(acceptance 5) is not a case anybody handles — it is what independent awards do.

A **comparison** label (`cheapest_*`, `fastest_*`, `best_*`) goes to exactly ONE
offer, taken from the already-tie-broken ranked order, so it is deterministic for
one policy version. A **standing** label (`official_direct_store`,
`authorized_reseller`, `native_mercaria_checkout`) goes to every offer that has
it, because it states a fact about that offer rather than a comparison.

`best_overall` is withheld when the leader scored zero: a comparison in which
nothing at all is known would otherwise present a digest tie-break as a
judgement.

The copy lives in `@mercaria/ui` `lib/offer-labels.ts`, keyed on the REASON code
rather than the label, so two surfaces rendering the same explanation cannot
drift and a copy change is not a contract change.

## Policy versions

`ranking_policy_versions` — one row per version, `(policy_key, version)` unique
forever. The `fee_schedules` / `match_policy_versions` device:

- **Immutable once it has served traffic** — from `canary` onward every column
  that decides an order is frozen by
  `mercaria_ranking_policy_version_immutable`. That is what makes acceptance 1
  ("the same eligible input produces the same order for one policy version") a
  property of the data rather than a promise.
- **`canary_share_bps` is the ONE exception**, named in the trigger. A ramp is a
  rollout control, not a policy term: the share decides WHICH subjects are routed
  and never what order any of them gets, and because the bucket is a hash of the
  subject compared against the share, raising it only ADDS subjects. Freezing it
  would make every ramp step a new version, and a version per ramp step makes the
  impression log unreadable.
- **Two partial uniques** — at most one `active` and at most one `canary` per
  key. Activation must therefore supersede.
- **`description` is frozen too**, though it is not economic: it is what an
  operator reads when deciding whether to roll back, and editing it rewrites the
  record of why the version was published.

### The built-in policy, and a deliberate divergence

`BUILTIN_RANKING_POLICY` is a real, named, versioned value in code, used when no
row is serving. #58 and #121 answer `unknown` when no policy version is active;
this domain does the opposite **on purpose**, and the asymmetry is the reason: a
missing compliance policy means Mercaria has not established that it may sell
something, while a missing ranking policy means only that nobody has published
weights. Refusing there withholds a sale; refusing here would withhold the
comparison surface itself on every fresh deployment, including the one that ships
it.

Every ranked result names its policy, so an impression logged under
`builtin-2026-08-v1` is exactly as traceable as one under a published version.
Changing the built-in weights means a NEW version string in the same change.

### The canary is keyed on the SUBJECT, not on a person

`resolveRankingArm` hashes `policyKey + ':' + canonicalProductOrVariantId`. That
is deterministic (one product always gets one arm, so a shopper does not watch
the order flip between refreshes), reproducible from the operator surface with no
session in hand, and carries **no identity at all** — there is no actor, session
or device in the preimage. #77 owns experiments on people; this owns a rollout
over the catalogue, and the two must not be confused.

### Rollback

Activating an earlier version. `activateRankingPolicyVersion` supersedes the
incumbent and claims the arm in ONE transaction, and the supersede runs FIRST
because the partial unique refuses two active rows. Nothing is re-ingested, and
nothing could be: a ranking is derived at read time from offers this domain never
writes. That is acceptance 7 in one call.

### The evaluation plan is DATA

`objective_metric_keys` and `guardrail_metric_keys` are #77 metric keys, CHECKed
against the same tuple `analytics_rollups.metric_key` reads — so a policy cannot
name a number nobody has defined. **The guardrail list may not be empty**:
"evaluate click and conversion outcomes ALONGSIDE trust guardrails, not as the
only objective" is `cardinality(...) >= 1` on the row rather than a sentence in a
runbook.

The CHECK is spelled `cardinality`, never `array_length`: the latter is NULL on an
empty array and a CHECK reads NULL as satisfied, so the obvious spelling would
ADMIT exactly the row it exists to refuse. A realdb case pins it.

Naming a metric is ALL this domain does with one. It reads no measurement —
`analytics-ranking-isolation.test.ts` enforces that in both directions, because
measured popularity is one join from "merchants who pay rank higher".

## Dominance and regression

`detectRankingDominance` reports which source, merchant or affiliate network
holds more of the top `dominanceWindow` positions than the policy permits. It
**repairs nothing**, and nothing may be added that does: a shuffle applied to make
a report look better would be an undocumented ranking input, which is the one
thing this whole issue is about.

A comparison shorter than the window produces NO findings — two offers on a
product, both from one retailer, is 100% of a two-position list and an entirely
ordinary state.

`compareRankings` diffs two orderings of the SAME eligible set. `newDominance` is
what the CANDIDATE introduced; existing concentration is a fact about the
catalogue and not this diff's news.

## Surfaces

**Public:** `GET /offer-comparison` — `optionalAuth`, the `listings` rate-limit
bucket, behind the same `requireCanonicalReads` lever `/offers` uses. It is a
SEPARATE router from `/offers` because the two answer different questions:
`/offers` is a keyset-paginated cheapest-first list #57 owns, this is one ranked
page under a named policy. There is deliberately no write route.

A signed-in buyer's STORED currency preference is authoritative and `?currency=`
is ignored for them (`cart.service`'s rule): a preference they set is a decision,
a link somebody sent them is not.

Viewer coordinates are accepted at ONE decimal place and no more — roughly 11 km.
A pickup-distance ranking needs a neighbourhood; a comparison surface has no
business holding a position accurate enough to identify a home. They are used and
discarded: no column in the domain could store one.

**Operator:** `/internal/ranking/*` on the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
allow-list every other catalogue surface uses — deciding what order a product's
offers appear in is the same power over the same graph as deciding which offers
exist. Mounted while nothing is published, because a deployment ranking under the
built-in policy is exactly when somebody needs to read what that policy is.

Eight routes and the set is CLOSED: trace, compare, list, create draft, canary,
stop canary, activate (which is also rollback), archive. **There is no boost, no
pin, no hide and no set-rank** — those are the four shapes a sponsored-placement
surface takes, and #74 states that sponsored placement, if introduced, is a
separate surface that cannot alter this score. A gate enumerates the registered
routes exactly and fails the build on any of the four.

`GET /internal/ranking/trace` sets `diagnostic`, so an offer a freshness contract
already retired appears in `excluded` with its reason. The public surface
deliberately does not: a shopper's page budget must not be spent on rows nothing
will show.

## Environment

```
RANKING_CANARY_ENABLED=true      # may a canary version serve anybody
```

ONE lever, and it gates neither a durable record nor the comparison surface.
Rollback is a row (activate an earlier version); what an incident needs is a way
to stop routing anybody to a canary WITHOUT editing the row, so the ramp somebody
set survives and the canary can be resumed. It defaults to TRUE because a canary
exists only because an operator created one, and requiring a second switch to
make their own creation take effect is the half-configuration trap this codebase
refuses elsewhere.

There is deliberately no `RANKING_ENABLED` and no `RANKING_POLICY_KEY` — the key
is a code constant, per the house rule every other versioned policy follows.

## Analytics

Every `offer_impression` from `/offer-comparison` carries
`rankingPolicyVersion`, which closes the impression half of #77's `#74` seam.
`/offers` (#57) deliberately still passes none: it serves a plain cheapest-first
SQL order under no policy at all, and stamping a version on it would attribute
that ordering to weights it never consulted.

The emitter is the ONLY analytics module the comparison surface may import.

## Seams left to their owners

Each is a named contract that fails closed, not a stub:

- **#93 — CLOSED.** `resolvePickupProximity` answers real distances.
  `best_nearby_pickup` is still never awarded, now because no comparison surface
  accepts a viewer coordinate to measure from.
- **#70** — canonical search does NOT consume `rankOfferComparison` today, and
  `registerSearchOfferSelector` has no production call site (#230). The two
  cannot be composed as they stand: a search selector is synchronous and is
  handed its offers, while `rankOfferComparison` is `async`, fetches the offers
  it ranks, and resolves its policy by a read keyed on each comparison subject.
  Filling the seam is a change to #70's port shape plus a product decision about
  which intent a query ranks under; `selected-offer.port.ts` carries the detail.
  Nothing in this domain reaches into search in either case.
- **#84** — a NATIVE offer names no merchant, so its seller rating is unknown to
  this domain until native stores are linked to merchants. Unknown is neutral,
  which is what prevents both a hidden native preference and a hidden native
  penalty.
- **#111** — `analytics_experiments.ranking_policy_version`, the arm of a ranking
  EXPERIMENT over people. #74's rollout is over comparison subjects and carries
  no identity, so it is not one.
- **A tax-inclusion column** — `resolveOfferTaxInclusion` is one function body,
  and whoever adds the column replaces it.
