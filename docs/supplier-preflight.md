# Live supplier preflight (#122)

Immediately before Mercaria creates or confirms a retail payment it asks the
supplier an authoritative, destination-aware question: **can this exact item
still be procured, what does it cost, how can it ship, and for how long is that
answer good?**

A catalogue feed observation is not checkout authority. #118 records what a feed
last claimed about a `procurement_offer`; this domain records what a supplier
ANSWERED to one exact question, and the two are separate tables with separate
vocabularies precisely so the first can never be mistaken for the second.

- **Code:** `services/supplier-preflight/` (14 modules),
  `db/supplierPreflight/` (7 repositories), `db/schema/supplierPreflight.ts`
  (8 tables), `routes/internal-supplier-preflight.ts`,
  `@mercaria/shared-types` `supplier-preflight.ts`.
- **Binding decisions:** ADR 0004 D4 step 1, D5, D8.1, D9.3.
- **Schema decisions:** `db/schema/CONVENTIONS.md` §"The supplier preflight
  domain".
- **Depends on:** #118 (suppliers, accounts, agreements, procurement offers),
  #120 (landed cost), #121 (resale authorization).

---

## The honesty rule, and the four places it is held

> The orchestration must not emulate a reservation by naming a local record
> `reserved` when the supplier has made no commitment.

Generalized: **a capability the adapter did not declare has no representable
success state.** An adapter that did not declare `live_stock_lookup` cannot
produce an `orderable` availability; one that did not declare `price_guarantee`
cannot produce a `guaranteed` price; one that did not declare
`delivery_estimate` cannot produce a delivery window; one that did not declare
`inventory_reservation` cannot produce a hold.

Four independent mechanisms, each sufficient on its own:

1. **The type.** `SupplierReservationOutcome`'s only `reserved` branch carries a
   NON-optional `providerReservationId` and `providerExpiresAt`. There is no
   shape a caller could fill in from nothing, and the `supported: false` branch
   has no id, no expiry and no success to misread.
2. **The boundary.** `applyDeclaredCapabilities` (`adapter.ts`) runs on EVERY
   answer, in the one place answers enter the system, and removes each claim the
   declared set does not cover — REPORTING each removal as a
   `SupplierEmulatedCommitment` rather than dropping it silently, because a seam
   that looks like a real answer is worse than a refusal. A non-empty report
   makes the quote `invalid` with `provider_contract_violation`, which reaches
   an operator.
3. **The writer.** `recordSupplierReservation` takes
   `Extract<SupplierReservationOutcome, { state: 'reserved' }>`, so a caller
   holding an unsupported or refused outcome cannot call it at all — `tsc` says
   so at the call site.
4. **The database.** `supplier_reservations.provider_reservation_id` and
   `provider_expires_at` are NOT NULL, and
   `supplier_reservations_capability_declared_check` requires
   `inventory_reservation` in `declared_capabilities`. There is no `reserved`
   column on `supplier_quotes` at all — a hold is a ROW, and its absence is the
   absence of the commitment.

The direction of every downgrade is a decision, not an implementation detail:
`orderable` becomes `unknown` and NOT `unavailable`; `guaranteed` becomes
`advisory` and not absent; a window becomes absent and not zero. The supplier
may well have the stock — what is missing is Mercaria's right to claim it does —
so each lands on the value that BLOCKS rather than the one that refuses.

`SUPPLIER_EMULATED_COMMITMENTS` (6 members) is DISJOINT from
`SUPPLIER_ADAPTER_CAPABILITIES` (12), pinned by a test. It stores nothing: it
exists so a refusal names the exact emulation attempted.

---

## Unknown is never a quiet yes

`SupplierAvailabilityState` is `orderable | unavailable | restricted |
backordered | unknown`, and a provider TIMEOUT maps to `unknown`. `unknownAnswer()`
is the single function every failed call produces, with no parameter that could
make it answer anything else — a timeout, a transport failure and an
unparseable body all arrive there.

`unknown` is deliberately NOT collapsed into `unavailable`: they route
differently (one to a retry and an operator, one to a refusal the customer can
act on), which is `RetailEligibilityVerdict`'s three-value rule (#121) applied
to supply.

### Completeness: three answers, and only one may be charged against

`deriveSupplierPreflightCompleteness` is PURE — no repository, no clock beyond
what it is handed — so the whole table of cases runs as fixtures AND against a
real server through the identical derivation.

| Status | Meaning | May check out |
|---|---|---|
| `complete` | Every fact checkout needs is present and the item is orderable | Yes |
| `partial` | An honest answer short of something; may be SHOWN | No |
| `invalid` | The answer contradicts itself or the request; carries an exception kind | No |

Severity is `invalid` > `partial` > `complete`, applied by construction: an
exception short-circuits, because an answer that contradicts itself has nothing
to be partially right about.

**Only three facts block a `complete` answer**, which is #122's closing rule
verbatim: unknown availability, a missing required shipping cost, and an
ambiguous SKU identity. A delivery window and a tax treatment block ONLY when
the active sourcing policy requires the capability — a made-to-order supplier
that publishes neither would otherwise be unable to sell anything at all, so
that is a decision an operator publishes rather than one hard-coded.

The same rule is a CHECK on the row (`supplier_quotes_complete_requirements_check`),
plus two biconditionals: `block_reasons` is non-empty EXACTLY when the status is
not `complete`, and `exception_kind` is present EXACTLY when it is `invalid`.

**Ambiguous and mismatched are different.** An `ambiguous` identity is a
provider contradiction an operator must resolve (`invalid`); a `mismatched` one
is a clear answer that the OFFER's mapping is wrong — a catalogue correction
(#59), so it is a `partial` with `identity_mismatched`. Neither can check out.

**A `maxOrderableQuantity` of zero beside a minimum order quantity is NOT a
contradiction.** It is the ordinary way a supplier says "out of stock", and the
minimum is a property of the SKU rather than of today's stock. Reading them as
one would file every out-of-stock line as an exception and bury the real
contradictions among them. (Caught by a test during development.)

---

## Quote and reservation persistence

### `supplier_quotes`

One durable, normalized answer. Carries the request fingerprint and idempotency
key, the supplier account and procurement offer, the checkout correlation, the
whole normalized response, the policy versions, the validity and usage
timestamps, and the failure/retry state.

**A quote stores NO address.** `destination_country` and `destination_region`
are the coarse pair Mercaria may keep; there is no postal-code, city, recipient,
line, phone or email column, so the redaction is the SHAPE — the
`purchase_orders` device taken one step further, because a parcel needs a street
and a QUOTE does not. What ties a quote to the destination it was taken for is
`request_fingerprint`, an HMAC an auditor recomputes from a destination they
already hold.

**A raw provider payload is never stored.** `source_record_ref` is a POINTER
into the restricted-access source store. Every fact kept is an allow-listed,
normalized, closed-set column.

**Usage state is DERIVED, not a column.** `consumed_at`, `released_at`,
`superseded_by_quote_id` and `expires_at` state it completely;
`deriveSupplierQuoteUsage` is the one derivation. #122 lists "usage state" among
the fields a durable quote carries, and this domain satisfies it with a
derivation for the reason every other Oxy domain does — a stored verdict beside
the facts is two representations of one fact, and the place they must not
disagree is a checkout gate.

Protected columns (`db/protectedColumns.ts`): `request_fingerprint`,
`idempotency_key` and `source_record_ref` on quotes; `request_fingerprint` on
sourcing attempts; `provider_reservation_id` on reservations. The fingerprint is
irreversible and still an exact-match ORACLE over destinations — the
`guest_checkouts.email_hash` reasoning.

### `supplier_reservations`

A hold the SUPPLIER actually made. See "The honesty rule" above.

`UNIQUE(quote_id)` gives one hold per quote;
`UNIQUE(supplier_account_id, provider_reservation_id)` stops two Mercaria rows
claiming one supplier hold. Consumption and release are both
`UPDATE … WHERE <target> IS NULL … RETURNING`, and the consumption predicate
carries the SUPPLIER's own expiry — so a lapsed hold cannot be consumed at all,
rather than being consumed and then noticed.

### The idempotency policy, stated

- A quote stored under the key that is **still usable** is RETURNED, and no
  supplier call is made. Two clicks, a retried request and a client that lost
  the response all converge.
- A quote under the key that is **expired, consumed, released or superseded** is
  REFRESHED: the supplier is asked again and a NEW quote is stored under
  `<callerKey>#<supersededQuoteId>`, with the old one pointed at it. The key
  cannot be reused (it is UNIQUE), and reusing the ROW would mutate a record
  another checkout may already have consumed.
- Two tasks refreshing the same expired key concurrently **both call the
  supplier**; the loser's insert loses the unique, its answer is discarded and
  any hold it took is released. Stated rather than hidden: the alternative is a
  lock held across a provider call, which converts a slow supplier into a stuck
  checkout.

**A rotated session cannot duplicate a supplier request** (#122 concurrency 5),
and that is structural rather than tested: `FingerprintedRequest` and
`SupplierPreflightRequest` have no session, guest, actor, Oxy-user, cookie or
device member, so a session cannot reach the fingerprint. The checkout group is
excluded for the same reason — two checkouts asking the same supplier the same
question about the same item to the same address are ONE question.

---

## Selection and failover

`selection.ts` is PURE. `SourcingCandidateFacts` has no member that could hold
an affiliate commission, a referral payout, an organic ranking score, a paid
placement, a sponsored boost, a subscription tier, advertising revenue or a
marketplace fee yield — the eight `SUPPLIER_FORBIDDEN_SOURCING_SIGNALS`, which
are DISJOINT from the eight rankable `SUPPLIER_SOURCING_CRITERIA` by a test. A
policy version's `ranking_criteria` CHECK reads the allowed tuple, so a
commission is not configurable even by hand-written UPDATE.

- **The order is TOTAL**, ending on `procurementOfferId`, so no pair compares
  equal, no sort's stability matters, and re-running a selection a week later
  against the same facts produces the same list. That is #122 acceptance 7.
- **An unknown cost sorts LAST.** Treating it as zero would make the source that
  told us least look cheapest.
- **An absent health measurement is NEUTRAL**, not bad — the
  `SELLER_TRUST_RESTRICTED_TIERS` rule (#92): restricting on absence makes a
  brand-new supplier permanently unselectable and turns a metrics outage into a
  marketplace-wide stop.
- **Refusals are refusals, not penalties.** A suppressed account, an inactive
  one, an ineligible destination, a missing required capability and an
  over-concentration are filtered BEFORE ranking — a refusal that could be
  outweighed by a low price is not a refusal.
- **Attempts are bounded** by the policy, and the candidates never tried are
  recorded as `attempt_limit_reached`. A candidate that would have worked but
  was never tried is a fact an operator investigating a refusal needs.

### Substitution

`assertSubstitutionPermitted` applies two rules at different times:

- **Product identity is checked ALWAYS**, locked terms or not (#122 selection 6
  is unconditional). Where both sides carry a canonical variant, that is the
  comparison; where either does not, the supplier SKU is the only identity
  available and two different SKUs from two suppliers cannot be PROVEN to be the
  same product, so it refuses. That is what makes "do not silently substitute
  another variant or a used condition" a comparison of identities rather than a
  judgement — a refurbished unit is a different supplier SKU and, once matched,
  a different canonical variant.
- **Commercial terms are checked only once LOCKED.** Before the customer has
  been told a price and a date there is nothing to preserve; after, the
  replacement may not cost more, arrive later or return worse. Withdrawing a
  delivery promise counts as slower.

Every attempted source is recorded in `supplier_sourcing_attempts`
(append-only, `UNIQUE(request_fingerprint, sequence)` so a replay converges),
including the ones filtered out — a supplier skipped for a concentration limit
and one skipped because its account was killed are different operational
problems.

---

## Mixed carts

Lines group by **supplier account, fulfilment origin and currency**. The output
order is by KEY, so the same cart decomposes identically however its lines were
added.

**Summing per-item shipping when the supplier priced the basket is
unrepresentable.** `SupplierShippingQuote`'s `basket` branch has ONE cost and no
per-line member; its `per_item` branch has the per-line costs and no single
cost. `groupShippingCostMinor` switches on the basis, and its `unknown` branch
returns `null` — never zero.

**`composeDeliveredTotal`'s incomplete branch has no `total` member at all**, so
"do not claim a complete delivered total when one group remains unquoted" is the
only shape it can return when a group is missing. A mixed-currency group is
reported unquoted rather than converted: this domain does no FX (an isolation
test asserts it).

An external or marketplace line **has no shape here** — `RetailPreflightLine`
carries a `procurementOfferId` and nothing that could name a listing, a seller,
a storefront or an external offer.

---

## Concurrency

| #122 requirement | Mechanism |
|---|---|
| Repeated key returns or refreshes | Explicit policy above; `UNIQUE(idempotency_key)` |
| A single-use reservation cannot be consumed twice | CAS on `consumed_at IS NULL`; realdb race test |
| A quote consumed by one checkout cannot attach to another | CAS + trigger refusing value→value on `consumed_by_checkout_group_id` |
| Expired quotes fail safely | `expires_at` in the CAS predicate; usage derived against the clock |
| Session rotation / guest sign-in do not duplicate | The fingerprint input type has no actor member |
| Provider rate limits use shared leases, bounded retries | `supplier_call_leases`, below |
| Timeout is `unknown`, not `in stock` | `unknownAnswer()`, one function, no parameter |
| An ambiguous response enters an exception state | `exception_kind`, present exactly when `invalid` |
| Reservation release is idempotent | CAS on `released_at IS NULL`; a second call converges |
| Traceable without secrets or full customer data | Coarse destination, redacted messages, protected columns |

### The provider call lease

"How many calls per minute may this supplier account receive across every ECS
task" is not a question an in-process token bucket can answer — the
`merchant_claim_rate_limits` reasoning (#83), applied to an OUTBOUND provider.

One row per `(account, slot)`. CONCURRENCY is exact because a slot is a row and
a claim is a row lock (`FOR UPDATE SKIP LOCKED`). RATE is exact because each
slot carries its own equal share of the account's per-minute allowance and a
single row's counter is serialized by that same lock, so the admitted total can
never exceed `slots × share`.

The trade is stated: an uneven arrival pattern can leave one slot's share unused
while another is exhausted, so the limiter can under-admit. That errs toward NOT
exceeding the provider's published limit — the direction a supplier punishes.

The two refusals are kept apart because they need different fixes:
`rate_limited` means raise the allowance and back off; `all_slots_busy` means
raise the concurrency and retry shortly. The discriminator asks whether EVERY
slot is budget-exhausted, and reports `rate_limited` only then — a plain read
sees the pre-update version of a row another task is claiming, and under that
stale view a busy slot looks un-exhausted, landing on `all_slots_busy`, which is
the safe way round. (The reverse phrasing — "is any slot free" — reports the
alarming answer on exactly the transient case; measured.)

The counter is **not** decremented on release: it measures calls STARTED inside
the window, which is what a provider's own limiter counts.

---

## Operations

### Health and automatic suppression

`supplier_preflight_health` is one row per account holding a ROLLING window
rather than an event log — the question is asked on the checkout path, and an
events table would put a growing scan in front of every sale.

`attempts = successes + failures` is a CHECK, equality and never `<=`. A health
verdict computed from a lossy window is exactly the report that says everything
is fine — the `catalog_backfill_runs` vacuity floor (#60), applied to a provider.

`evaluateSupplierPreflightHealth` may RAISE a `health_degraded` suppression and
may LIFT one it raised. It **cannot** raise a `kill_switch` (a CHECK restricts
`origin = 'automatic_health'` to that one kind and to a NULL raiser), and it
cannot lift an OPERATOR's stop — a provider recovering is evidence about the
provider, not about whatever reason a person had for stopping it.

Every automatic stop carries its own `expires_at`, so a stop raised during an
outage lapses even if the loop never runs again. Below the policy's sample floor
or on a stale window the verdict is "no opinion" and nothing is suppressed.

### Kill switches

`supplier_preflight_suppressions` covers four scopes — `supplier`,
`supplier_account`, `market`, `supplier_account_market` — with the scope
DETERMINING which subject columns are present (a CHECK over all four
combinations). One live stop per subject and kind (a partial unique on a
GENERATED key), so two operators reacting to one incident converge.

Selection reads this table LIVE, so a raise blocks the next sourcing decision
with no sweep having run.

### The operator surface

`/internal/supplier-preflight/*`, behind `PROCUREMENT_OPERATOR_OXY_USER_IDS` —
a SIXTH allow-list, for a power none of the other five holds: it reads what
Mercaria PAYS its suppliers and flips the supplier and market kill switches. A
compliance reviewer vetted to verify a safety certificate is not thereby vetted
to see Mercaria's cost base. Empty = not mounted (404, never 401).

| Route | Purpose |
|---|---|
| `GET /metrics` | Quote latency, failure, expiry, stock discrepancy, per-account health |
| `GET /accounts/:accountId/health` | One account's verdict and live provider quota |
| `GET /quotes/:quoteId` | One quote, destination coarse, hold id redacted to its last four |
| `GET /traces/:checkoutGroupId` | One checkout group's whole sourcing trail |
| `GET|POST /policies`, `POST /policies/:id/{activate,retire}` | Versioned sourcing policy |
| `GET|POST /suppressions`, `POST /suppressions/:id/lift` | Kill switches |
| `POST /sweep` | Run one sweep pass now |

**Read plus two write kinds, and no third.** There is deliberately no "set this
quote complete", no "extend this reservation" and no "override this answer" — a
quote records what a supplier said, and an operator who could edit one could
authorize a sale the supplier never agreed to. A route test asserts those paths
404.

A kill-switch body has no `origin` field, so an operator cannot file a stop that
reads as the system's and lapses on its own. A policy body naming a forbidden
signal is refused BY NAME before the `.strict()` schema sees it — an operator
reaching for `affiliateCommissionWeight` is told what it is and why it can never
decide who fulfils an order.

"Stock discrepancy" is measured as holds Mercaria took and never used past the
supplier's own deadline. The other half — a supplier accepting a quote and then
refusing the purchase order — is learned only when a PO is submitted, which is
#124's path, and is deliberately not guessed at here.

### The sweep

`runSupplierPreflightSweep` releases lapsed holds (calling the supplier where
the adapter can, with a bounded retry), releases lapsed quotes, and evaluates
health. Reservations FIRST, then quotes: releasing the quote first would leave a
live hold whose quote reads as finished.

It needs no lease of its own — every action is an idempotent compare-and-swap,
so N tasks produce the same end state as one and a dead task strands nothing.

`SUPPLIER_PREFLIGHT_SWEEP_ENABLED` stops the LOOP and nothing else: quotes still
expire against their own deadline and holds still lapse on the SUPPLIER's clock,
both read against the clock at every use. What stops is Mercaria RECORDING it.

### Test mode

The fake adapter (`fake-adapter.ts`) injects the four failures #122 operations 8
names — timeout, cost change, stock loss, reservation expiry — plus rate
limiting, provider error and an `undeclared_reservation` probe that exercises
the capability boundary from the other direction.

**Two independent gates, and the second is the load-bearing one:**
`SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` must be on for it to be registrable at
all, AND it refuses a `live` supplier account at call time whatever the flag
says. A flag is exactly the thing that gets copied between environments, and the
consequence here is a customer charged against stock that was never checked.

Injection is process-local, which is why it is NOT on the operator surface: an
operator flipping a scenario in production would affect whichever task served
their request.

---

## Environment

```
SUPPLIER_PREFLIGHT_ENABLED=false          # may an adapter be called at all
SUPPLIER_PREFLIGHT_FINGERPRINT_KEY=       # 64 hex chars; REQUIRED when enabled
SUPPLIER_PREFLIGHT_SWEEP_ENABLED=true     # the release/health loop
SUPPLIER_PREFLIGHT_SWEEP_INTERVAL_MS=30000
SUPPLIER_PREFLIGHT_SWEEP_BATCH_SIZE=50
SUPPLIER_PREFLIGHT_MAX_RELEASE_ATTEMPTS=5
SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED=false
PROCUREMENT_OPERATOR_OXY_USER_IDS=        # empty = surface not mounted (404)
```

`SUPPLIER_PREFLIGHT_ENABLED=true` **requires** the fingerprint key — the
half-configuration rule `GUEST_COMMERCE_ENABLED` established. An unset key would
mean an unkeyed request digest, and a country plus a postal code is a space
small enough to enumerate, so that digest would be an offline oracle over
buyers' addresses sitting in a column.

Staying OFF is SAFE here in a way it would not be for a delivery queue: every
preflight still runs, still records its attempt and still writes a quote —
answering `unknown`, which blocks checkout. Nothing is silently permitted.

The sourcing policy key is a code CONSTANT (`mercaria-retail-sourcing`), not a
variable — the `CROWDSOURCE_APP_ID` reasoning: a variable holding it could only
ever disagree with the rows it names.

---

## Seams left to their owners

Each is a NAMED contract that fails closed, never a stub that lies.

- **#123 (checkout wiring, `orders` widening).**
  `assertPreflightSatisfiesCheckout` is COMPLETE and implemented in full — it is
  pure, and everything it needs is here. #123 calls it; nothing about it waits
  on #123.
- **#124 (provider adapters, PurchaseOrder orchestration).** The registry is
  EMPTY in this repository, and an unregistered provider is not an error but an
  ANSWER: `unknown` with `provider_unconfigured`, which blocks. So a deployment
  that has not integrated a supplier runs this whole domain and refuses every
  sale from it.

  `authorizeSupplierFulfilment` **MOVED**, to
  `services/supplier-orders/fulfilment-authorization.ts` — #124 landed it there
  rather than here, and that is the load-bearing half: #122 states outright ("a
  quote is not a PurchaseOrder and cannot independently authorize supplier
  fulfilment") that this domain must never answer `authorized: true`, so #124
  did not relax `supplier-preflight-isolation.test.ts`'s wall forbidding this
  domain from importing `purchase_orders`. It moved the FUNCTION to where it can
  read the row that does authorize. `services/supplier-preflight/checkout-contract.ts`
  now has no function that could answer `authorized: true` at all — the
  property is structural rather than a refusal somebody could relax.
- **#117 (authorization and capture sequence).** The quote's validity and its
  reservation expiry are what #117's sequence reads;
  `SupplierPreflightCheckoutRefusal` already carries `quote_expired` and
  `reservation_expired`.
- **#128 (variance booking).** This domain records what the supplier quoted and
  what it later charged; BOOKING the difference is #128's ledger work, and a
  second durable record of one fact is what the ledger rules forbid.
- **#93 (pickup), #37 (bulk external ingestion), #74 (ranking).** None of them
  may reach this domain's cost data, and the isolation gate says so.

---

## Production-readiness checklist

1. `PROCUREMENT_OPERATOR_OXY_USER_IDS` populated — without it nobody can publish
   a sourcing policy, read a quote trace or stop a failing supplier.
2. `SUPPLIER_PREFLIGHT_FINGERPRINT_KEY` provisioned (64 hex characters, its own
   key — never shared with the guest PII or email-hash keys).
3. A sourcing policy version published and ACTIVE. Without one every preflight
   answers `sourcing_policy_missing`, which blocks.
4. At least one real adapter registered by #124, and its declared capabilities
   reviewed against what the provider actually does — the boundary downgrades a
   false claim, but a MISSING declaration silently costs a capability.
5. `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` confirmed OFF in production.
6. Alerting on the metrics surface (quote failure rate, expiry rate, lapsed
   unconsumed holds, `provider_contract_violation` count) wired in `oxy-infra` —
   this domain exposes JSON and structured logs and takes no prometheus
   dependency, the `/internal/payments` precedent.
