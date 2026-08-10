# Merchant plans, entitlements and subscription billing (#89)

What a Mercaria store gets for nothing, what a paid plan could add, and the
machinery that decides which. Ten tables, one resolver, one billing boundary and
a set of prohibitions that are values rather than promises.

The binding constraint the whole design follows from is issue #89's own opening
line: **this must not delay free merchant activation unless a paid feature is
actually required.** Maintaining a catalogue, fulfilling orders and seeing
essential financial information stay free. So what shipped is the entitlement
SYSTEM, and no existing capability moved behind it.

---

## The thing to understand first

**No capability Mercaria ships today has a key an entitlement could name.**

`MERCHANT_ENTITLEMENT_CAPABILITIES` (eight members) and
`MERCHANT_UNGATEABLE_CAPABILITIES` (fourteen) are DISJOINT unions — the
`RetailCostComponentKind` device — and the database CHECK on
`entitlement_definitions.capability_key` reads the first tuple. So
`order_management`, `refund_issuance`, `financial_record_access` and
`data_export` have no row shape: not a rule a service enforces, not a default
somebody could change, but a value that cannot be written down.

The second tuple exists so a refusal can name the prohibition. A bare enum would
answer "invalid value" for `data_export`, which is true and useless; the request
schema checks the prohibition FIRST and says *"`data_export` can never be gated
by a plan"*, which leads somewhere. That message is pinned by a test.

The consequence worth stating plainly: **the free plan's entitlement set is
EMPTY, and that is not a poor free tier.** Everything a free merchant does is
ungateable by construction, so there is nothing for the free plan to grant.

---

## The initial plan design (the product decision #89 asks for)

Issue #89 requires a committed decision before billing is enabled. This is it.

### 1. Free plan capabilities

Everything Mercaria ships today. Concretely: claiming or creating a store,
maintaining a catalogue and its variants, publishing eligible offers, receiving
and managing native orders, fulfilling them, issuing supported refunds,
onboarding to a payment rail, the essential sales/payout/fee reports, reading
the store's own financial records, exporting its own data, answering buyers'
cancellation, return and support requests, responding to moderation decisions,
reading tax records, and every member-management and account-security action.

All fourteen are in `MERCHANT_UNGATEABLE_CAPABILITIES`, so none of them is an
entitlement and none can become one.

Staff seats and locations are **unlimited**, and see §3 below for why.

### 2. Candidate Pro capabilities

Eight, and every one of them is `postponed` because none exists yet:

| Capability | Limit kind | Why it is not the free tier |
|---|---|---|
| `advanced_demand_analytics` | flag | Beyond #77's aggregate store summary, which stays free |
| `competitive_price_analytics` | flag | A merchant's own offers against the rest of the comparison |
| `automation_rules` | total | Nothing automates catalogue or order operations today |
| `replenishment_planning` | flag | No forecasting exists over multi-location inventory |
| `advanced_merchandising_rules` | total | Beyond the manual collections and discounts every store has |
| `expanded_pos_registers` | total | POS has no register concept at all today |
| `scheduled_exports` | per_period | Export on demand is ungateable; the SCHEDULE is what this adds |
| `ai_catalog_assistance` | per_period | Gated on #42 being grounded |

**A plan version naming any of them cannot be activated.**
`activateMerchantPlan` refuses it and names the capabilities, in the same
transaction that would have activated it. That is "do not sell a placeholder
plan whose advertised features are not implemented" as a mechanism rather than a
promise — and it means no paid plan is sellable on any deployment today, whatever
the billing flag says.

### 3. Two candidates EVALUATED and NOT ADOPTED

Issue #89 says "evaluate rather than automatically include", so:

- **Additional staff seats.** Store members are unlimited today. Metering them
  is precisely the move the binding constraint forbids — an existing capability
  moving behind a paywall.
- **Additional locations.** Same: `locations` has no cap, and introducing one
  would change what an existing free store may do.

Both stay possible later — a definition row plus an explicit decision about what
the free baseline is — and neither was taken now.

### 4. Pricing, currencies and markets

**None are set.** `merchant_plan_prices` models a price per (plan version,
provider, mode, cadence, currency) and no row exists, because there is nothing
sellable to price. When there is, the prices are rows an operator publishes on
the draft version before activating it — never an environment variable, and
never a constant shipped to a client.

### 5. Trial and grace policy

Both are columns on the plan VERSION (`trial_days`, `grace_period_days`), so
they are frozen once the version is active and cannot change under somebody
mid-trial. Neither has a value yet, for the reason above.

The grace mechanism is settled even though the number is not: entering
`past_due` computes the deadline ONCE from the plan version in force at that
moment and stores it on the subscription, so a later plan change cannot shorten
a grace already running and a redelivered `invoice.payment_failed` cannot extend
one.

### 6. Upgrade, downgrade, cancellation and refund behaviour

- **Upgrade** — a hosted provider checkout. The subscription row is written from
  a provider snapshot, never from the client coming back.
- **Cancellation** — at the END of the paid period. There is no immediate
  cancellation route on the merchant surface, and no proration.
- **Refunds** — none are issued for a subscription. A merchant who cancels keeps
  what they paid for until the period ends. A credit, if one is ever warranted,
  is an operator decision booked as an `adjustment` through the existing ledger
  mechanism; there is deliberately no `subscription_refund` transaction kind
  nothing would write.
- **Downgrade** — is cancellation. There is no downgrade path between two paid
  plans yet because there is only ever going to be one paid plan before somebody
  designs the second.

### 7. Does any plan select a different marketplace fee schedule?

**No, and no plan can.** There is no field for it on any table, in any request
schema, anywhere in the domain.

#88's schedule scope is `eligible_seller_type` + `eligible_currency` and nothing
else, which is what makes guest and authenticated checkouts fee-equivalent
structurally. A plan scope would have to be added to THAT domain's schedule
table, under its own decision, and it would mean the fee a buyer's order pays
depends on a commercial agreement the buyer cannot see. Issue #89 permits it
("even if a plan can legitimately select another published fee schedule") and
this design declines it.

### 8. Grandfathering

Structural, and it needs no policy: a subscription names an IMMUTABLE plan
VERSION by foreign key. A new version is a new row, and a merchant moves onto it
only by an explicit plan change that re-accepts terms. There is nothing to
grandfather because nothing can retroactively change.

### 9. What is postponed because it does not exist

Everything in §2. The `availability` column carries that as data rather than as
a note in this document, and it is what the activation refusal reads.

---

## The domain

### Ten tables

| Table | What it is |
|---|---|
| `merchant_plans` | One VERSION of one plan. Immutable once active. |
| `merchant_plan_prices` | What a version costs, per provider, mode, cadence and currency. |
| `merchant_plan_acceptances` | An authorized owner agreed to a version's terms. Append-only. |
| `entitlement_definitions` | What a capability IS — key, limit kind, enforcement point, availability. |
| `plan_entitlements` | Which capabilities a version grants, and the limit it sets. |
| `billing_customers` | The platform-side customer a store is charged to. |
| `merchant_subscriptions` | One store's billing relationship with a plan version. |
| `merchant_subscription_events` | The audit trail. Append-only, and the idempotency claim. |
| `entitlement_grants` | Capabilities given outside a plan. Add-only. |
| `entitlement_usage_counters` | How much of a quantified limit has been consumed. |

### The rules that are load-bearing

- **Versioning is #88's mechanism, not a second one.** A version is editable only
  while `draft`; from `active` onward every commercial column is frozen by
  `merchant_plans_immutable_once_active`, its prices and entitlements are frozen
  by `merchant_plan_child_frozen`, and
  `merchant_plans_one_active_per_key` makes "the active version" a single row.
  A policy change is a NEW version.
- **`merchant_plans_one_active_free_plan` is a SECOND partial unique the fee
  domain has no counterpart for** — at most one active `free` version in the
  whole database. A store with no subscription resolves against "the active free
  plan", and with two of them that phrase names nothing.
- **The subscription's `plan_id` IS the entitlement snapshot.** Nothing is
  copied, so nothing can disagree. The only things separately snapshotted are
  what a version cannot express: the grace DEADLINE (a clock) and the accepted
  terms version.
- **`limit_kind` is denormalized onto `plan_entitlements` and
  `entitlement_grants`, and a COMPOSITE foreign key is what makes that safe** —
  the `match_category_gates` device. Without the copy, "a `flag` carries no
  number" would be a cross-table condition no CHECK can express; with it, the
  rule is intra-row and real, and the copy is provably the definition's own. The
  CHECK is one-directional on purpose: NULL stays legal for every kind, because
  UNLIMITED has to remain representable.
- **A subscription with no acceptance on file is NOT recorded.** An operator
  creating one straight in the provider's dashboard produces a named refusal, not
  a row. Mercaria does not write down a paid plan nobody agreed to.
- **A grant only ADDS.** There is no negative grant and none may be added: the
  capabilities a free merchant relies on are ungateable, so the only thing a
  removing grant could take is something somebody is paying for — and the honest
  way to do that is to change the plan, which is audited on both sides. Several
  live grants on one capability are legitimate (a trial then a partnership) and
  the resolver takes the MOST GENEROUS, because the alternative would make giving
  a merchant something able to take away what they had.
- **The usage consume is ONE statement and its empty result IS the refusal** —
  a conditional upsert whose conflict branch refuses to take the total past the
  limit. A read-then-write leaves a window two concurrent callers both fit
  through, and a sequential test cannot tell the two implementations apart, which
  is why the realdb suite issues six of them at once.
- **The limit is NOT stored on the counter.** It lives on the immutable plan
  version or on the grant; a copy here would be a second representation of one
  fact, and it would be the stale one every time a merchant changed plan.
- **There is ONE enforcement point and it is `create_or_extend`.** A one-member
  union, so a capability that gated READING or EXPORTING what a merchant already
  has cannot be DEFINED — which is #89 entitlement rule 7 as a shape rather than
  a promise. `data_export` and `financial_record_access` in the ungateable tuple
  are the second, independent layer over the same rule.

### Resolution, and the cache's real bound

`resolveMerchantEntitlements(storeId, { at })` is the ONE resolution, from the
plan version, the subscription and the live grants in that order of authority.

- A store with no subscription resolves against the ACTIVE FREE plan, and a
  deployment with none published resolves to the empty set. There is deliberately
  no "no active version, refuse" branch here, unlike #58's matcher and #121's
  eligibility: refusing there withholds a sale, and refusing here would withhold
  a paid extra nobody has.
- `past_due` STILL entitles, and the stored deadline is what ends it. The sweep
  that appends `grace_expired` changes nothing — the resolver compares a
  timestamp against the clock, so a deployment that never runs the loop still
  downgrades on time.
- Results are cached in-process for **60 seconds** and invalidated explicitly by
  every writer. Mercaria runs several ECS tasks, so an invalidation reaches ONE
  of them and the TTL is the real bound on how long another can serve a stale
  answer. That is acceptable HERE and would not be elsewhere: nothing a merchant
  needs in order to trade is resolved through this function, so the worst a stale
  entry can do is let a paid extra work for up to a minute after a downgrade.

### Billing, and what keeps it apart from Connect

Acceptance 2 — "Connect account and subscription billing customer cannot be
confused or cross-linked accidentally" — is held four ways:

1. **Different tables with no relation.** `billing_customers` has no foreign key
   to `provider_accounts`, no column that could hold a connected-account id, and
   no shared key space. A test walks the real drizzle columns and fails on a name
   that could hold one.
2. **A scanned isolation gate.** No module under `services/entitlements/`,
   `services/billing/` or `db/merchantPlans/` may reach
   `provider-account.service`, `providerAccountRepository`, `provider_accounts`
   or `createStripeConnectedAccount`. The ONE permitted import from the payment
   domain is the shared Stripe CLIENT — one configured SDK instance, one pinned
   API version, one retry policy.
3. **A shape check at the adapter.** `assertBillingObjectId` refuses an `acct_`
   id BY NAME on every billing call, so a mis-wired caller gets a sentence rather
   than a provider 404 three frames later.
4. **A separate provider interface.** `BillingProvider` is not a widened
   `PaymentProvider`. One moves a buyer's money to a seller; the other charges a
   merchant on Mercaria's own account. A single interface would eventually make
   the two objects interchangeable in some caller's mind.

The rail is Stripe Billing, hosted throughout: a Checkout Session to start and
the Billing Portal to manage. **No method anywhere in the boundary takes a card,
a token or a payment-method id**, so "Mercaria does not collect card details" is
a property of the interface.

### The events

The four subscription and invoice types ride the EXISTING payment-event
infrastructure — the same signature check, the same `payment_provider_events`
dedupe key, the same lease, the same backoff, the same operator replay. What they
do NOT share is `payments`: a subscription invoice has no checkout group, no
orders, no seller and no transfer, so `payment_provider_events.payment_id` stays
NULL for every one and the correlation lives on `merchant_subscription_events`.

`STRIPE_BILLING_EVENT_TYPES` is a SEPARATE tuple from
`STRIPE_PLATFORM_EVENT_TYPES`, which is ADR 0001's own list reproduced verbatim
and is worth keeping auditable against the ADR. `platformScopeEventTypes()` is
the union both the scope check and the dashboard configuration read.

- No handler applies a PAYLOAD — #46's rule. Deliveries are unordered, so every
  handler re-reads from Stripe and applies THAT.
- **Idempotency has two layers and they answer different questions.**
  `payment_provider_events` dedupes RECEIPT (a redelivery); the partial unique on
  `merchant_subscription_events.provider_event_id` dedupes APPLICATION (an
  operator REPLAY of an already-processed event).
- **Booking an invoice puts the POSTING first and lets the claim roll it back.**
  The audit table is append-only by trigger, so the row cannot be written and
  then stamped with the ledger transaction it booked. The order is therefore
  posting → claim, and a claim that finds the event already applied THROWS,
  which rolls the posting back inside the same transaction. That is the only
  ordering under which a redelivered `invoice.paid` cannot double-book.
- **The amount comes from the CHARGE's balance transaction**, not from the
  invoice: #47's rule that a charge is booked in the currency the money LANDED in
  applies unchanged. An unavailable balance transaction is RETRYABLE and never
  guessed. A settlement currency Mercaria does not model is REFUSED by name.

### The ledger

`subscription_revenue` is #89's one new account and `subscription_invoice_paid`
its one new transaction kind. A settled invoice books:

```
provider_clearing     +net    (debit — funds arrived on the platform balance)
processor_expense     +fee    (debit — omitted entirely when there is no fee)
subscription_revenue  −gross  (credit — revenue recognised)
```

Balanced by construction, since `gross = net + fee`. It is written through the
same single writer every other posting uses, subject to the same balance refusal
and the same append-only trigger.

**Acceptance 6 is that account existing.** Marketplace commission is ADR 0001
D3's residual and exists nowhere but `commission_revenue`; booking a subscription
into it would make the one figure that already exists nowhere else stop meaning
what it means, with no way to separate them afterwards. A property test over
randomized mixed currencies pins the balance; another pins that
`commission_revenue` and `merchant_payable` are never touched.

---

## Surfaces

### Merchant — `/admin/stores/:storeId/plan/*`

`GET /` (status, entitlements, usage), `GET /catalog` (the comparison),
`POST /checkout`, `POST /portal`, `POST /cancel`. All five behind `store:manage`,
which is the fee surface's reasoning verbatim: the comparison, the upgrade, the
portal and the cancellation are one conversation and it is the owner's.

**The router is NOT flag-gated.** `MERCHANT_BILLING_ENABLED` gates the two
routes that would open a hosted session, inside the service. Gating the MOUNT
would take the plan screen away from a merchant who already has a subscription
the moment somebody pulled the incident lever.

The dashboard screen (`settings/plan.tsx`) opens with what is included for
nothing, deliberately: a plan screen that opens with what a merchant might be
missing reads as pressure. Past-due copy says exactly what stops and when, and it
cannot threaten order access — there is no capability key for it.

### Operator — `/internal/payments/*`

Behind the EXISTING `PAYMENT_OPERATOR_OXY_USER_IDS` allow-list, NOT a seventh:
publishing a plan is the same kind of act as publishing a fee schedule.

Plan drafting, prices, entitlements, activation and retirement; the capability
definition list and its sync; one store's entitlement trace; grants and
revocations; one reconciliation page by hand.

The trace opens from a STORE id and nothing else. There is no lookup by
capability, by plan or by subscription state, because "which merchants hold this
capability" is a question about a commercial cohort this surface has no reason to
be able to ask.

---

## Environment

```
MERCHANT_BILLING_ENABLED=false                        # the merchant's ACTIONS; requires STRIPE_ENABLED
MERCHANT_BILLING_RETURN_URL=                          # where a hosted session returns to
MERCHANT_SUBSCRIPTION_RECONCILIATION_ENABLED=true     # the LOOP only
MERCHANT_SUBSCRIPTION_RECONCILIATION_INTERVAL_MS=360000
MERCHANT_SUBSCRIPTION_RECONCILIATION_BATCH_SIZE=50
```

**Neither lever gates a durable record.** Entitlements resolve, subscriptions
apply provider events, invoices book to the ledger and grace deadlines bite
whatever both say. The isolation gate fails the build if the resolver starts
reading configuration at all — feature flags and entitlements solve different
problems, and collapsing them would let a flag flip grant or remove a paid
capability for every merchant at once with nothing in any audit trail saying so.

---

## Production-readiness checklist

Nothing below is done, and none of it can be until there is something to sell.

1. A paid capability is actually implemented, and its
   `MERCHANT_CAPABILITY_CATALOG` entry moves to `available` in the same change.
2. `POST /internal/payments/merchant-plans/definitions/sync` is run, so the
   database's `entitlement_definitions` reflect the code.
3. A free plan version is drafted and activated (its entitlement set is empty,
   which is correct).
4. A paid plan version is drafted, priced in both modes for every market it is
   sold in, and activated — which will now succeed, because its capability is no
   longer postponed.
5. `MERCHANT_BILLING_RETURN_URL` is set and `STRIPE_ENABLED` is on.
6. The Stripe platform webhook endpoint is subscribed to the four
   `STRIPE_BILLING_EVENT_TYPES` in addition to ADR 0001's list.
7. A terms document exists at the version the plan names.
8. `MERCHANT_BILLING_ENABLED` is turned on.

---

## Seams left, each failing closed

- **A capability's own enforcement.** `checkCapability` and `consumeCapability`
  are complete, tested against a real server, and called by NOTHING — because
  nothing is gated. The day a paid feature ships, the only new code is the
  feature itself.
- **A second billing provider.** `BillingProvider` is the boundary #89 asks for;
  the registry is empty by default and a deployment with no rail answers "no
  provider" rather than throwing halfway through a merchant's upgrade.
- **A downgrade between two paid plans.** Not built, because there is no second
  paid plan to downgrade to, and designing the proration for one that does not
  exist would be designing it twice.
- **Plan-selected fee schedules.** Declined — see §7 above. The mechanism by
  which one could ever arrive is a new scope column on `fee_schedules`, which is
  #88's schema and #88's decision.
