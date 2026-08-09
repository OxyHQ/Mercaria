# Discovery analytics and search-success measurement (#77)

The full reference for the analytics domain. `AGENTS.md` carries the rules that
are load-bearing; this document carries the mechanics, the metric definitions'
provenance, the retention policy, the privacy-review checklist and the seams.

Production collection is **OFF** and stays off until the privacy and retention
review in §"The privacy and retention review" is recorded (#77 acceptance 8).

---

## What this domain measures, and what it deliberately cannot

It measures whether Mercaria helps people find and act on useful products. It
cannot measure who those people are: there is no column anywhere in the eight
tables for an email, an email hash, a phone number, a card fingerprint, a
provider customer id, a wallet identity, an IP address, a device fingerprint, a
bearer token, a postal address or an order note, and
`services/analytics/__tests__/contract-gates.test.ts` fails the build if one
appears.

That is the whole design in one sentence: **an allow-list of typed columns,
never a free property bag.** `services/payments/redact.ts` is the precedent and
the reasoning is stronger here — a provider's payload arrives shaped by somebody
else and has to be reduced; an analytics property is composed by our own code,
so an open bag is not a defence against a third party, it is an invitation to
whoever is in a hurry.

---

## The versioned envelope

`AnalyticsEnvelope` in `@mercaria/shared-types` (`src/analytics.ts`), version
`ANALYTICS_ENVELOPE_VERSION`, stored on every row. Every field #77's event
contract lists, and nothing else:

| # | Field | Column | Notes |
|---|---|---|---|
| 1 | event id, type | `id`, `event_type` | uuid v7; type from a closed tuple |
| 2 | event time, receipt time | `occurred_at`, `received_at` | receipt is the SERVER clock, never client-supplied |
| 3 | Oxy user id | `oxy_user_id` | only when signed in **and** consent permits — CHECKed |
| 4 | pseudonymous session id | `pseudonymous_session_id` + `pseudonym_epoch` | rotating one-way hash; see below |
| 5 | checkout/order correlation | `checkout_group_id`, `order_id` | RESTRICTED by CHECK to post-checkout event types |
| 6 | surface, app version, market | `client_surface`, `app_version`, `market` | shape-CHECKed so neither can carry prose |
| 7 | entity ids | ten nullable columns | query event, listing, variant, canonical product/variant, offer, merchant, storefront, category, store |
| 8 | search / ranking policy version | `search_policy_version`, `ranking_policy_version` | #74's seam; NULL today |
| 9 | experiment assignment | `experiment_key`, `_version`, `_variant` | travels whole or not at all (CHECK) |
| 10 | bot/preview/automated class | `traffic_class` | seven values; `unknown` is a real answer |
| 11 | consent + collection mode | `consent_state`, `collection_mode` | `off` is unstorable (CHECK) |
| 12 | buyer origin | `buyer_origin` | only on the funnel events that genuinely compare the two flows |

Plus five typed MEASURES — `position`, `result_count`, `latency_ms`,
`quantity`, `item_count` — and one bounded `reason_code`. A sixth measure is a
schema change with a migration, and that friction is the feature.

### The pseudonymous session id

`sha256(epochSalt || ':' || handle)`, truncated to 32 hex characters.

- The `handle` is a `guest_sessions` row id for a guest, or an opaque
  client-minted surface session id (`X-Mercaria-Analytics-Session`) for an
  anonymous visitor. Never an email, a phone number, a card fingerprint or an
  IP — `isWellFormedSurfaceSessionId` refuses anything that is not an opaque
  token, so a client that sent an address gets its event recorded
  *unidentified* rather than pseudonymised under it.
- The `epochSalt` is 32 CSPRNG bytes in `analytics_pseudonym_salts`, rotated
  every `ANALYTICS_PSEUDONYM_ROTATION_HOURS` (24 by default) and then DELETED by
  the shared expiry sweep 45 days later.

The deletion is the point. After it, nobody — including Mercaria, including a
lawful request — can recompute an old epoch's value from a session handle, so
activity either side of a rotation cannot be joined even in principle. That is
what makes "short-lived pseudonymous session id" true rather than aspirational,
and it is why the salt sits in `PROTECTED_COLUMNS`.

The cost is stated rather than hidden: **experiment and return-rate continuity
for a guest ends at each rotation.** `saved_intent_return_rate`'s attribution
limit says so, and it biases that number DOWN.

---

## The identity and correlation rules, and what enforces each

| # | Rule | Mechanism |
|---|---|---|
| 1 | A pseudonymous session is not an Oxy user | `AnalyticsIdentity` is a union with no common `id`; `analytics_events_identity_exclusivity_check` refuses a row carrying both, an Oxy id on a guest actor, or a pseudonym on an Oxy actor |
| 2 | A guest checkout is not a durable person profile | The pseudonym is derived from a SESSION handle, itself purged on ADR 0003 D11's clock; the domain imports no guest-checkout or guest-session store (gated) |
| 3 | Email hash, phone, card fingerprint, provider customer, wallet, IP, device are never a user id | No function takes one and no column holds one; the forbidden-column scan has a vacuity floor and a mutation self-test |
| 4 | Separate guest checkouts cannot be joined by matching contact or payment | The derivation takes a session handle and nothing else — two checkouts on one card are two unrelated pseudonyms |
| 5 | A completed #109 claim connects only that checkout | `db/analytics/eventRepository.ts` has an insert and two reads and no update; `analytics_events_append_only` refuses an UPDATE from ANY caller, including a migration |
| 6 | Claim decline is a valid outcome | `guest_claim_declined` is its own `commerce_funnel` event, not a `surface_error` |
| 7 | Merchant analytics never expose that a named user began as a guest | `ANALYTICS_BUYER_ORIGINS` has no `claimed` member; `buyer_origin` is CHECK-restricted to funnel events; the merchant summary carries no origin breakdown at all |
| 8 | Financial truth comes from payments, orders, refunds, affiliate reports | Every money metric names a durable `source`; `findFinancialSourceViolations` gates it; no event type asserts a payment |
| 9 | Portal and recovery use bounded ids, never bearer tokens | #108's seam contract; `redact-query.ts` destroys `mgs_`/`mgp_`/`mgx_` on sight |
| 10 | Internal, crawler, preview and scanner traffic classified separately | `classifyTraffic` returns one of seven bounded values; the USER AGENT never becomes a column |

### Acceptance 3 — a client cannot forge a conversion

`POST /analytics/events` refuses every event type outside
`ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES`. That list contains impressions,
clicks, views and errors, and contains **no** event that asserts a payment, a
session being issued, a cart merging, an eligibility verdict or a completed
claim. A client also cannot set `eventId`, `receivedAt`, any identity field,
`trafficClass`, `checkoutGroupId` or `orderId` — none of them is read from the
body.

The endpoint answers **202**, never 201: the events were accepted into a bounded
queue that may drop them, and telling a client they were stored would be the
overstatement `POST /reports` refuses one domain over.

---

## Search query privacy

**Raw query text is never retained.** What reaches Postgres is the string after
`services/analytics/redact-query.ts` has replaced everything matching a
recognised sensitive shape, and only for `ANALYTICS_QUERY_TEXT_RETENTION_DAYS`
(30). At `text_expires_at` the retention sweep NULLs it and the normalized
tokens survive alone; at `expires_at` (180 days) the row goes.

Nine bounded redaction kinds are recorded beside the text —
`email`, `phone`, `postal_address`, `payment_card`, `iban`, `secret_token`,
`long_digit_run`, `url_with_credentials`, `oversized`. Recording WHAT was found
is an operational fact worth aggregating ("people are pasting card numbers into
the search box") and is storable without the thing itself.

Three properties worth stating because each has a fixture:

- **Rule order is load-bearing.** Cards and IBANs match before the generic
  digit-run rule, or a card would be reported as `long_digit_run` and an
  operator watching for `payment_card` would see nothing. URLs-with-credentials
  match before emails, because `https://user:pass@host` contains an at-sign.
- **The patterns are deliberately broader than the strict formats.** A
  redaction that only catches correctly-formatted input catches the cases that
  were never going to be a problem.
- **…except the phone rule, whose separators are MANDATORY.** With them
  optional, `iphone 15 128 256` reads as three digit groups and the most
  valuable queries in the dataset are destroyed while nothing a human would call
  a phone number is caught. That fixture is in the suite.

**The tokens are derived from the REDACTED text**, never from the original —
otherwise nulling the text at 30 days would leave the thing it was redacted for
standing in the column that survives. The `[redacted]` marker is dropped rather
than tokenised, or every query containing anything sensitive would aggregate
into one very popular bucket and top a merchant's list.

### The reporting floor

`readTopQueries` in `db/analytics/searchQueryRepository.ts` is the **only**
query-text reader in the backend. It applies
`ANALYTICS_QUERY_MIN_OCCURRENCES` (25) unconditionally — on the row and again
after the range SUM — and there is deliberately no `includeRare` parameter, no
second exported reader and no raw-text accessor.

An operator and a merchant get the same floor, and that is the decision: a rare
query is a near-identifier whoever is reading it. "the green wedding dress my
sister wore in Girona" occurring twice is a person, and an operator allow-list
is a list of people, not a licence.

**`analytics_search_queries` has no actor column of any kind.** Privacy rule 3
asks for tokens kept separate from identity; a nullable actor column with a rule
about when to populate it would be a rule, and a table with no such column is a
fact.

---

## The metrics

Twenty-two definitions in `ANALYTICS_METRICS` (`@mercaria/shared-types`), each
naming its numerator, denominator, window, source, freshness, human-only flag,
merchant visibility, **attribution limit** and — where its events do not exist
yet — the issue that owes them.

They are DATA, not prose: `analytics_rollups.metric_key` CHECKs against the same
tuple, so a number whose definition is unstated cannot be stored, and
`GET /internal/analytics/metrics/:key` 404s a key with no definition, so it
cannot be served either. Acceptance 6 from both ends.

`GET /internal/analytics/metrics` returns the whole catalogue, so a dashboard
builds itself from the definitions rather than holding a copy of what a metric
means.

### The conversion metrics come from payments, not events

`services/analytics/verified-conversion.ts` is the ONE seam through which this
domain reads financial truth (`order-linkage.ts` is the precedent one domain
over). It returns COUNTS of checkout groups reaching a succeeded payment — no
amounts, no currencies, no buyer identity, because recomputing money here would
create a second answer to a question the ledger already owns.

A **refunded** payment still counts as a conversion. The purchase happened; a
refund is a later, separate fact with its own metric. Excluding it would make
the conversion rate move when a return is processed weeks later, silently
rewriting history in a chart somebody already acted on.

**A successful guest purchase with no Oxy claim is a COMPLETE conversion.**
Claiming is a separate metric and a lower claim rate is never abandonment
(#77's metrics note, acceptance 12).

### The buyer-origin seam

ADR 0003 D6's `orders.buyer_origin` is #106's, and it does not exist yet.
`BUYER_ORIGIN_EXPRESSION` in `verified-conversion.ts` derives origin from the
`ext:` prefix connector imports write into `buyer_oxy_user_id` — the only origin
signal on the table today. Two consequences, stated rather than hidden:

- `'guest'` is not producible today (`buyer_oxy_user_id` is still `NOT NULL`),
  so `guest_checkout_funnel`'s numerator reads zero, correctly.
- When #106 lands, that expression becomes the column. One line, here, and
  nowhere else.

---

## Dashboards and read APIs

`/internal/analytics/*`, behind `ANALYTICS_OPERATOR_OXY_USER_IDS` — a FOURTH
allow-list beside payments, catalog and guest, for the fourth instance of the
reason those three are separate. An empty list does not MOUNT the router (404,
never 401).

| Route | Answers |
|---|---|
| `GET /metrics` | every definition, plus the query reporting floor |
| `GET /metrics/:metricKey` | one series WITH its definition attached |
| `GET /queries` | top aggregate queries above the floor; `?zeroResults=true` narrows it |
| `GET /trace` | one search's derived events in order, or one checkout group's conversion answer |
| `GET /health` | sink counters, retention health, metrics without a rollup, metrics awaiting a seam |
| `GET /experiments` | every version, its guardrails and its exposure counts |
| `POST /experiments` | publish a version, optionally activating it |
| `POST /experiments/:key/stop` | stop a running version with a bounded reason |
| `POST /rollup` | compute the next pending day now |

### What an operator does NOT get

- **Raw guest contact.** No column holds any.
- **Low-frequency behaviour.** The floor is the same one a merchant gets.
- **Cross-checkout identity correlation.** The trace opens from a query event id
  or a checkout group and returns a projection with NEITHER identity column.
  There is no endpoint that takes a pseudonym and none that returns one — "show
  me everything this session did" is not a question this surface can be asked.

That last one is the interesting decision, because a funnel debugger genuinely
wants it. The answer is that the trace already answers the question a debugger
actually has ("what happened to THIS search") and the pseudonym-keyed version
answers a different one ("what has THIS PERSON been doing"), which no
operational need justifies and which the rotating pseudonym makes impossible
anyway.

### Merchant analytics

`GET /admin/stores/:storeId/analytics/summary`, behind `stats:read` — the same
permission the sales reports use, because "how many people saw my products" and
"how much did I sell" are the same class of question about the same store.

The scope comes from `req.store`, which `loadStore` set from a membership check,
so "their OWN offers" is a property of the route rather than a filter the
handler has to get right.

Five counts, the metric definitions behind them, and nothing else. Below
`ANALYTICS_MERCHANT_MIN_COHORT` (10) every figure is reported as ZERO with
`aboveThreshold: false` — suppressed, not rounded and not bucketed: on a store
with one product and one visitor a day, "under 10" plus a timestamp is a person.
The threshold applies to the LARGEST count rather than per field, because
suppressing per field publishes the ones that cleared it and bounds the ones
that did not.

Bots, previews and internal traffic were excluded when the ROLLUP wrote the
bucket, not at read: a filter applied at read leaves the inflated figure in the
stored aggregate for the next reader to forget about.

Guest and authenticated conversion are **not** compared in the merchant
surface. Merchant rule 5 permits it "only when sample size and product purpose
justify it", and neither is established — so there is no buyer-origin breakdown
at all, which is rule 3 and identity rule 7 arriving at the same place from two
directions.

---

## Experimentation

`analytics_experiments` is one immutable VERSION per row (the `fee_schedules`
shape), with a database trigger freezing every field once it leaves `draft` and
a partial unique holding exactly one ACTIVE version per key.

Assignment is a pure function: `sha256(key:salt:unit) mod 10000`. Nothing is
stored about a unit until it is actually EXPOSED, so an experiment a person
never reached leaves no record of them at all.

- **The salt is minted server-side**, never client-supplied: a caller who chose
  it could choose which units land in which arm.
- **A unit outside the allocation gets `undefined`, never `control`** — a
  holdout counted as control makes the two populations one.
- **Editing the salt on a running experiment is refused by the trigger.** It
  would silently re-bucket every unit mid-flight, so the same person is control
  on Monday and treatment on Tuesday and nothing in the data says so.

### Coercive treatments are UNREPRESENTABLE

`ANALYTICS_EXPERIMENT_TREATMENT_KINDS` has five members and none of them could
mean "hide Continue as guest", "auto-create an account", "preselect marketing
consent" or "sell organic rank". `ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS` is
a negative list scanned against the positive one by
`contract-gates.test.ts` — so a plausible-looking future addition
(`guest_option_visibility`) fails the build rather than passing review on a
tired Friday.

Rule 3 is the same shape: `ranking_policy` names a #74 policy VERSION, and a
policy version is organic by construction — the fee and referral domains are
unreachable from every ranking module.

**Flags roll back independently of analytics** (rule 7). Nothing in a rollback
path reads this domain: a feature flag is `config.*`, evaluated with no database
access, so an experiment can be turned off while the sink is down, while the
rollup is stalled, and while `ANALYTICS_ENABLED` is false.

Every version declares its stop conditions in advance, from a closed set, so
nobody has to invent one under pressure — and a stop records WHICH condition
fired, because "somebody turned it off" is what an incident review most needs
and least often has.

---

## Data lifecycle

### Retention by event class

| Class | Events | Retention |
|---|---|---|
| `discovery` | search, impression, click, view, save | 90 days |
| `commerce_funnel` | cart, checkout, eligibility, portal, claim | 180 days |
| `experiment` | exposure | 180 days |
| `operational` | errors and unavailable states | 30 days |

| Table | Retention | Mechanism |
|---|---|---|
| `analytics_events` | per event class (above) | `expiryTargets.ts` |
| `analytics_search_queries` | text 30 d, row 180 d | text: `retention.ts` (a REDACTION, not a delete); row: `expiryTargets.ts` |
| `analytics_query_aggregates` | 365 days | `expiryTargets.ts` |
| `analytics_rollups` | 730 days | `expiryTargets.ts` |
| `analytics_experiment_exposures` | 180 days | `expiryTargets.ts` |
| `analytics_pseudonym_salts` | 45 days from epoch OPEN | `expiryTargets.ts` |

The salt retention is deliberately SHORTER than the events derived under it, so
for the second half of an event's life its actor dimension is already
permanently unlinkable to any session handle. Rotating an identifier and keeping
the key that reproduces it would rotate nothing.

### Aggregate before delete

The rollup writes a day's metric buckets and query aggregates BEFORE that day's
rows reach any retention horizon. So a top-queries report survives the text it
was derived from, and deleting raw events costs a dashboard nothing.

### Export and deletion

- **An Oxy account deletion** reaches this domain as the absence of new events.
  Stored events carrying that `oxy_user_id` are removed by the retention sweep
  on their class's own clock; there is no cascade, because a cascade from an
  identity service Mercaria does not own is not expressible.
- **A guest deletion request** (ADR 0003 D15) needs nothing here: the pseudonym
  is not reversible to a session, so there is no row to find. That is the
  privacy design paying for itself — a domain that could honour a
  per-pseudonym deletion request would be one that could answer "which rows are
  this person's", which is the correlation it exists to prevent.
- **Financial records** (`payments`, `orders`, `refunds`, the ledger) are under
  their own statutory retention and are never touched by any analytics sweep.

### Internal traffic

Declared with `X-Mercaria-Internal-Traffic` against
`ANALYTICS_INTERNAL_TRAFFIC_TOKEN`, compared in constant time. Deliberately NOT
an IP allow-list: an IP is one of the identifiers #77 forbids as a dimension,
and a CIDR list would have needed the address recorded somewhere to be
debuggable. Empty means no traffic can declare itself internal, which is the
safe default — the failure is a smoke test appearing in a metric, not arbitrary
traffic hiding from one.

---

## Analytics never blocks commerce

`services/analytics/sink.ts`. **The signature is the guarantee**:
`recordAnalyticsEvent` and `emitAnalyticsEvent` return `void`, not
`Promise<void>`, so a caller has nothing to await — a caller who tried would get
`Property 'then' does not exist on type 'void'` from `tsc`.

- The in-process queue has a hard cap (`ANALYTICS_QUEUE_MAX_EVENTS`) and drops
  the OLDEST when full. Unbounded would turn a Postgres outage into a memory
  leak and take the API down with it.
- A failed flush logs at `error`, increments a counter and **does not re-queue**
  — an analytics write that failed once will usually fail again, and re-queueing
  turns a transient database problem into a growing buffer that then drops the
  NEW events instead.
- Identity derivation runs on a detached promise, so the one operation that
  might need a database read (and, once per rotation, a write) is off the
  request path too.

**Loss is acceptable, and that is an argued position**: financial truth does not
live here. If a future metric ever needed at-least-once delivery, the answer is
a durable outbox row written in the commerce transaction — the moderation and
payment outbox shape — and NOT making this queue reliable. The two mechanisms
answer different questions and must not be merged.

Pinned by `sink-never-blocks-commerce.test.ts`, which makes the writer throw on
every call and asserts the commerce paths still return, with counters asserted
so a sink that quietly did nothing cannot pass for the wrong reason.

---

## Environment

```
ANALYTICS_COLLECTION_MODE=off        # off | essential | full — DEFAULT off
ANALYTICS_ENABLED=false              # a kill switch that can only turn collection DOWN
ANALYTICS_OPERATOR_OXY_USER_IDS=     # empty ⇒ /internal/analytics is NOT MOUNTED (404)
ANALYTICS_QUEUE_MAX_EVENTS=10000
ANALYTICS_FLUSH_INTERVAL_MS=2000
ANALYTICS_FLUSH_BATCH_SIZE=500
ANALYTICS_PSEUDONYM_ROTATION_HOURS=24
ANALYTICS_INTERNAL_TRAFFIC_TOKEN=    # empty ⇒ nothing can declare itself internal
ANALYTICS_ROLLUP_ENABLED=true        # gates the LOOP only
ANALYTICS_ROLLUP_INTERVAL_MS=900000
ANALYTICS_ROLLUP_MAX_BACKFILL_DAYS=30
```

`enabled` is DERIVED from the mode and can only narrow it:
`ANALYTICS_ENABLED=true` with `ANALYTICS_COLLECTION_MODE=off` collects nothing.
An unrecognised mode falls back to `off` — every other fallback in `config`
defaults to the permissive side; this one defaults to collecting nothing.

---

## The privacy and retention review (#77 acceptance 8)

Production collection stays OFF until this is completed and recorded on #77 (and
coordinated with #111 for the guest-specific gates). What it must cover:

1. **Lawful basis and consent.** Which `AnalyticsConsentState` values the launch
   jurisdiction requires, who sets the header, and what `unknown` means
   operationally. Today `unknown` and `not_required` both permit the Oxy account
   id; only `denied` withholds it. Confirm or narrow that.
2. **The pseudonym rotation interval.** 24 hours is a default, not a finding.
   Confirm it against the funnel windows that need continuity
   (`search_session` is 30 minutes; `saved_intent_return_rate` is 28 days and
   already acknowledges the loss).
3. **The salt retention (45 days).** Confirm it is shorter than every event
   class it covers and long enough for incident forensics.
4. **The reporting floors.** `ANALYTICS_QUERY_MIN_OCCURRENCES` (25) and
   `ANALYTICS_MERCHANT_MIN_COHORT` (10) against expected launch volumes — a
   floor that suppresses everything is a surface nobody uses, and one that
   suppresses nothing is not a floor.
5. **The redacted-text retention (30 days).** Confirm the operational need it
   serves (reproducing a relevance regression against real strings) still
   justifies keeping any text at all.
6. **The redaction pattern set** against a sample of real production queries, in
   both directions: what it missed, and what it destroyed that it should not
   have. The suite covers common shapes; only real data covers the rest.
7. **The four operator allow-lists** and who is on each — specifically that
   analytics is vetted separately from payments, catalog and guest.
8. **The event-class retention windows** against the actual questions the
   product asks, and against any statutory minimum the launch jurisdiction
   imposes on none of these (they are not financial records).
9. **The client-emittable allow-list**, re-read against acceptance 3.
10. **The internal-traffic token's distribution** — who holds it, and how it
    rotates.
11. **The seam contracts in `services/analytics/seams.ts`**, re-read by the
    owner of each of #107–#111 before that issue ships.

---

## Seams — what is defined and NOT emitted

`services/analytics/seams.ts` carries the full contract for each. Sixteen event
types are in the vocabulary, are covered by a CHECK and a retention class, and
are emitted by NOTHING; `contract-gates.test.ts` fails the build if any module
emits one.

| Issue | Capability | Metrics waiting on it |
|---|---|---|
| #107 | Stripe guest checkout — methods, action-required, verified success | `guest_verified_payment_conversion` |
| #108 | Guest order portal and magic-link recovery | `order_portal_delivery_success` |
| #109 | Claiming a guest checkout into an Oxy account | `oxy_claim_funnel` |
| #110 | Guest cancellations, returns, support | `guest_post_purchase_demand` |
| #111 | Guest-commerce rollout gates and retention coordination | — |
| #74 | Ranking policy versions | — (columns exist, NULL today) |
| #37 | Outbound affiliate redirect and network reports | `affiliate_commission` |

A metric reading zero and a metric that cannot yet be measured look identical on
a chart and mean opposite things, which is why the definition carries the issue
number and the dashboard renders "awaiting #108" rather than "0%".

**#106's six are the seam worth reading**, because the gates they describe
ALREADY RUN. #105 landed the P2P exclusion (ADR 0003 D18), the destination
allow-list and the per-seller destination revalidation, and a guest checkout
passes through all three today. What they lack is a BOUNDED refusal: each raises
a generic `conflict()` carrying a sentence, so classifying one into a reason code
would mean matching on message text — a fabricated classification that would
mis-fire the first time somebody improved the wording.

Emitting only the ACCEPTED half was the other option and is worse:
`guest_eligibility_coverage` would read a permanent, confident 100%. So the
metric names the seam and reads as unmeasurable instead. #106 owes each refusal
an error CODE — the `ANALYTICS_REASON_CODES` members are already there
(`p2p_seller_excluded`, `market_not_supported`, `destination_unsupported`,
`seller_not_payment_ready`) — after which both halves emit from the checkout
controller with no further design.

The ONE guest gate that IS emitted today is `guest_feature_gate_blocked`, at
`GUEST_CART_DISABLED` and `GUEST_ISSUANCE_DISABLED`, for exactly the opposite
reason: both are bounded `ErrorCode`s, so the reason code is read off a decision
this code made rather than matched out of a message.

---

## Operations

`GET /internal/analytics/health` returns four things, and two of them must be
ZERO on a healthy deployment:

- `retention.unredactedExpiredQueries` — search records past `text_expires_at`
  that still carry text. Non-zero means the redaction sweep is not running.
- `retention.overdueSalts` — salt epochs past their deletion deadline that still
  exist. Non-zero means a "rotated" pseudonym is still re-identifiable, which is
  the one failure in this domain that is invisible from everywhere else.

Plus `sink` (queued, dropped-for-capacity, dropped-for-failure, flushed, flush
failures) and the metric/seam status. Both retention counters fail SILENTLY:
the system works perfectly while the guarantee they underpin has quietly stopped
being true, which is exactly the class of thing that needs a number somebody
looks at.

Alerting and scraping wiring belongs to `oxy-infra`, as it does for the payment
metrics endpoint.
