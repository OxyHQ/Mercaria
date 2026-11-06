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

### 2. What Go, Creator, Plus and Ultra sell (on sale from 5 November 2026)

The owner decided on 2026-11-05 to sell every plan, at economical prices, and
left the remaining choices to engineering. Each capability below was BUILT
(its own PR) and moved to `available` before any version naming it could be
activated; the #89 rule — never sell a placeholder plan — was kept, not relaxed.
The reviewed catalogue is `services/billing/plan-catalogue.ts`.

| Capability | Kind | Go | Creator | Plus | Ultra |
|---|---|---|---|---|---|
| `automation_rules` | total (rules) | 10 | 25 | 50 | 200 |
| `scheduled_exports` | per period (runs) | 60 | 150 | 300 | 1,500 |
| `advanced_demand_analytics` | flag | — | yes | yes | yes |
| `advanced_merchandising_rules` | total (rules) | — | 20 | 20 | 100 |
| `replenishment_planning` | flag | — | — | yes | yes |
| `competitive_price_analytics` | flag | — | — | — | yes |
| `expanded_pos_registers` | total (extra registers) | — | — | — | 20 |
| `ai_catalog_assistance` | per period | not sold | not sold | not sold | not sold |

**Why the limits are these.** A daily scheduled export is about 31 runs a
period, so Go's 60 covers two daily schedules and Ultra's 1,500 is effectively
unmetered for a shop. Rule counts are what a shop of that size plausibly keeps
active; a rule that is deleted gives its slot back (`releaseCapability`), and
reaching a limit never stops anything already created from running.

**Why `ai_catalog_assistance` is not sold.** The design requires that AI usage
"draw from the applicable account allowance" with no extra credit pool. Today a
product backend can only call Kaana on its own workload identity, which bills
the APPLICATION's owner (oxy `docs/inference/attribution.md`: "deliberately no
fallback to the signed-in user's personal account"); drawing on the merchant's
own allowance waits for oxy ADR 0046's cross-product path, and Mercaria has no
reviewed `internal_metered` inference relationship. Selling it now would either
break the design or make Oxy absorb an unbounded cost nobody approved. It comes
back as a NEW plan version of Creator and Ultra once one of those exists
(grandfathering is structural, §8).

**Creator without AI.** Creator was designed as the "drops and product content"
workflow beside Plus. Without AI assistance it is automation, scheduled exports,
demand analytics and scheduled merchandising — the drop toolkit — without
Plus's multi-location replenishment, so it sits BELOW Plus in price rather than
beside it.

Neither Creator nor any other plan buys ads, promotion, reach, a verified badge,
reputation, search position or preferential moderation
(`MERCHANT_PLAN_FORBIDDEN_BENEFITS`). Oxy is 100% ad-free, including Free.
Manufacturing and delivery of merch are not included. Marketplace transaction
fees remain independent of the plan.

Oxy One Business proposes Go → Mercaria Go, Pro/Max → Mercaria Plus, and
Ultra → Mercaria Ultra; every Oxy One Creator level proposes Mercaria Creator.
These mappings are not entitlement grants.

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

| Plan | Monthly | Yearly (10 × monthly) |
|---|---|---|
| Mercaria Go | 4.99 | 49.90 |
| Mercaria Creator | 9.99 | 99.90 |
| Mercaria Plus | 14.99 | 149.90 |
| Mercaria Ultra | 24.99 | 249.90 |

The same figures in **USD and EUR**: Mercaria's dashboard ships Spanish,
Catalan, German, French and Portuguese, and its merchants include EU shops, so
EUR is a first-class billing currency; a store whose default currency is EUR
sees EUR first. Each (plan, cadence, currency) is its own Orbit price —
Peable's prices carry one currency each (it has no `currency_options`) — and
each is a `merchant_plan_prices` row. Yearly is ten months: two months free.

**Prices exclude tax** (`tax_behavior: 'exclusive'` on every Orbit price).

**Why these prices — positioned clearly below the commerce platforms.** A
Mercaria plan adds tools to a store that already sells for free, so the
comparison is the entry commerce tier a merchant would otherwise pay just to
sell (approximate USD list prices as published in 2026; monthly billing unless noted — re-check before quoting them externally):

| Comparable | Entry price | Mercaria |
|---|---|---|
| Shopify Basic / Grow | $39 / $105 a month | Ultra $24.99 includes every tool |
| Wix Core / Business | $29 / $36 a month, billed yearly | Plus $14.99 |
| Squarespace plans that sell online | from about $23 a month, billed yearly | Plus $14.99 |
| eBay Store Starter / Basic | $7.95 / $27.95 a month | Go $4.99 |
| Etsy Plus | $10 a month | Creator $9.99 |

Every Mercaria plan is below the cheapest tier it resembles, and the most
expensive Mercaria plan is below the cheapest Shopify plan that sells at all.
Marketplace fees are separate and unchanged by any plan (§7).

### 5. Trial and grace policy

- **No trial on version 1.** A native subscription Checkout Session cannot
  start one, and a version with `trial_days > 0` is refused by name
  (`trial_not_supported`) rather than sold without the trial its terms promise.
- **Grace: 16 days** (`grace_period_days = 16`). Peable's default dunning
  (`retry_schedule_days` `{1,3,5,7}`, each delay counted from the previous
  attempt, then `final_action: cancel`) makes its last retry 16 days after the
  first failure. The tools keep working for exactly as long as the rail is still
  trying, so a card that succeeds on the last retry never cost the merchant a
  day; after it the rail cancels and the subscription ends.

The grace mechanism: entering `past_due` computes the deadline ONCE from the
plan version in force at that moment and stores it on the subscription, so a
later plan change cannot shorten a grace already running and a redelivered
`invoice.payment_failed` cannot extend one.

### 6. Upgrade, downgrade, cancellation and refund behaviour

- **First plan** — an embedded Peable Checkout Session (`ui_mode: 'embedded'`),
  paid IN the dashboard in Peable's payment sheet (`PeableSheetCheckout` from
  `@peable.to/sdk/checkout/ui`, the same sheet Mention uses on /plus): card or
  FairCoin, never a redirect and never a shipping address. `POST /plan/checkout`
  answers `MerchantPlanCheckoutView` — the session's payer `clientSecret` and
  the price it was created for, refused (409) if the rail priced it otherwise —
  and the sheet refuses a session that is not that price. The subscription row
  is written from a provider snapshot, never from the sheet: the sheet shows
  success only once `GET /plan` says the store pays (`active`/`trialing`).
- **One subscription per store.** A checkout is REFUSED while the store has a
  live subscription (anything but `expired`): `merchant_subscriptions_store_key`
  holds one row per store, so a second rail subscription could only be recorded
  by overwriting the first — which would keep billing with nothing in Mercaria
  pointing at it.
- **Changing plan or cadence** — `POST /plan/change` (`changeMerchantPlan`):
  the new version's terms are accepted first, then the ONE rail subscription's
  price is swapped with `proration_behavior: 'always_invoice'` — the unused time
  is credited and the new plan's remaining time charged on one invoice NOW, so an
  upgrade is paid when it is taken and a downgrade leaves a credit the next
  invoices draw down (never cash). A pending cancellation is withdrawn. The
  currency stays the subscription's. Refused while `past_due` or `paused`.
- **Cancellation** — at the END of the paid period. There is no immediate
  cancellation route on the merchant surface.
- **Refunds** — none are issued for a subscription. A credit, if one is ever
  warranted, is an operator decision booked as an `adjustment` through the
  existing ledger mechanism.

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

`ai_catalog_assistance` (§2). Its definition stays `postponed`, so a version
naming it still cannot be activated.

### 10. Terms

The Mercaria Merchant Plan Terms, version `merchant-plans-2026-11-05`
(`services/billing/terms/merchant-plan-terms.ts`, served at
`GET /legal/merchant-plan-terms/:version` and linked from the plan screen).
Each version's text is hash-pinned by a test: a change is a new version, named
by a new plan version and accepted afresh. **Drafted by engineering and pending
the owner's and legal's review.** The owner confirmed Oxy Platforms, Inc. as the
contracting entity and seller of record; its registered address and the
governing law are explicit `[… TO BE COMPLETED BY THE OWNER]` placeholders,
because no authoritative source in the repositories states them (oxy
`docs/products/oxy-one-launch-readiness.md` records the incorporation as in
progress). The publish script prints any placeholder the current version still
carries.

### 11. Tax

Version 1 sells **without automatic tax**: Mercaria's plan checkout sends no
`automatic_tax`, Oxy Platforms' Peable Tax settings are not approved
(owner-only, in Orbit), and enabling it before approval would fail closed
(`tax_settings_not_active`) and block every sale. Prices are stated
tax-exclusive and invoices carry no tax. The switch, once the owner approves
tax in Orbit, is in `runbooks/merchant-plans-live.md` §2 item 6.

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
   or `createStripeConnectedAccount`. The permitted imports from the payment
   domain are the shared Peable CLIENT (one transport, one workload identity),
   the Peable event router's types, the ledger repository and the provider
   error class.
3. **A shape check at the adapter.** Every id the Peable adapter sends or reads
   must match its own prefix (`cus_`, `sub_`, `price_`, `in_`), so a connected
   account's id is refused before any call, with a sentence rather than a
   gateway 404 three frames later.
4. **A separate provider interface.** `BillingProvider` is not a widened
   `PaymentProvider`. One moves a buyer's money to a seller; the other charges a
   merchant on Mercaria's own account. A single interface would eventually make
   the two objects interchangeable in some caller's mind.

The rail is **Peable's native billing engine** (Peable ADR 0018): an embedded
Peable Checkout Session in `mode: 'subscription'` over the plan's Orbit price to
start (paid in the dashboard's Peable sheet), Peable's hosted customer portal to
manage, and
`cancel_at_period_end` on the native subscription to cancel
(`services/billing/peable/native-billing.ts`). Mercaria reaches the gateway as
its own Oxy workload identity and holds **no provider credential** for billing.
**No method anywhere in the boundary takes a card, a token or a payment-method
id**, so "Mercaria does not collect card details" is a property of the
interface. A native subscription checkout cannot start a trial, so a plan
version with `trial_days > 0` is refused by name (`trial_not_supported`) rather
than sold without the trial its terms promise.

The ids are Peable's (`cus_…`, `sub_…`, `price_…`, `in_…`) and
`BILLING_PROVIDER_IDS` is `['peable']`. Until 2026-11-04 the rail was Stripe
Billing on Mercaria's own Stripe account, briefly fronted by an I08 "cohort"
through Peable's Stripe-Billing proxy; neither ever carried a subscription, and
both are deleted (migration 0182 narrows the three `provider` CHECKs).

### The events

`customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid`
and `invoice.payment_failed` arrive on `/webhooks/peable` and ride the Peable
event infrastructure — the same signature check, the same
`payment_provider_events` dedupe key, lease, backoff and operator replay — which
is mounted and drained whenever `PEABLE_WEBHOOK_SECRET` is set, independently of
the Peable payment rail (`PEABLE_ENABLED`). What they do NOT share is
`payments`: a subscription invoice has no checkout group, orders, seller or
transfer, so `payment_provider_events.payment_id` stays NULL and the correlation
lives on `merchant_subscription_events`. The handlers are
`services/billing/peable/events.ts`.

- No handler applies a PAYLOAD — #46's rule. Deliveries are unordered, so every
  handler re-reads the subscription or invoice through the registered billing
  provider, and a subscription read for another customer than the event named
  is refused.
- **Idempotency has two layers and they answer different questions.**
  `payment_provider_events` dedupes RECEIPT (a redelivery); the partial unique on
  `merchant_subscription_events.provider_event_id` dedupes APPLICATION (an
  operator REPLAY of an already-processed event).
- **Booking an invoice locks its subscription and checks the prior invoice
  claim before posting.** The current provider/mode/subscription/customer binding
  must match under that lock. Different event IDs for the same invoice converge
  on one posting. The append-only event claim follows the ledger insert in the
  same transaction; a duplicate event ID still rolls both back.
- **The amount is what the invoice says was paid** (`amount_paid`, in the
  invoice's currency), read live. The gateway's invoice carries no settlement
  detail, so **no processor-fee leg is booked** — the same stated gap the
  Peable payment rail has (`payments/peable/event-router.ts`), recorded on every
  such event row. A currency Mercaria does not model is REFUSED by name.

### The ledger

`subscription_revenue` is #89's one new account and `subscription_invoice_paid`
its one new transaction kind. A settled invoice books:

```
provider_clearing     +net    (debit — funds arrived on the platform balance)
processor_expense     +fee    (debit — omitted when there is no fee; on Peable, always, until the fee decision)
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
`POST /checkout`, `POST /change`, `POST /portal`, `POST /cancel` — all behind
`store:manage` — and `GET /capabilities` (which paid tools the store holds, for
any member; no billing state). The billing routes are `store:manage`
which is the fee surface's reasoning verbatim: the comparison, the upgrade, the
portal and the cancellation are one conversation and it is the owner's.

**The router is NOT flag-gated.** `MERCHANT_BILLING_ENABLED` gates checkout, Portal and cancellation inside the service. Gating the MOUNT
would take the plan screen away from a merchant who already has a subscription
the moment somebody pulled the incident lever.

The dashboard screen (`settings/plan.tsx`) opens with what is included for
nothing, deliberately: a plan screen that opens with what a merchant might be
missing reads as pressure. Past-due copy says exactly what stops and when, and it
cannot threaten order access — there is no capability key for it.

### Operator — `/internal/payments/*`

Behind the EXISTING `payments.operate` key, NOT a seventh:
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
MERCHANT_BILLING_ENABLED=false                        # actions; requires PEABLE_WEBHOOK_SECRET (the rail's events)
MERCHANT_BILLING_RETURN_URL=                          # where the hosted billing portal returns to
MERCHANT_SUBSCRIPTION_RECONCILIATION_ENABLED=true     # the LOOP only
MERCHANT_SUBSCRIPTION_RECONCILIATION_INTERVAL_MS=21600000
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

The billing transport is Peable's native engine. A new paid offer still
requires the following commercial readiness checks; transport registration
alone does not prove an offer exists.

State on 2026-11-05: **every step is done and the plans are on sale** — the
evidence (PRs, Orbit ids, the publish and probe runs) is in
[`runbooks/merchant-plans-live.md`](runbooks/merchant-plans-live.md) §1.

1. A paid capability is actually implemented, and its
   `MERCHANT_CAPABILITY_CATALOG` entry moves to `available` in the same change.
2. `POST /internal/payments/merchant-plans/definitions/sync` is run, so the
   database's `entitlement_definitions` reflect the code.
3. A free plan version is drafted and activated (its entitlement set is empty,
   which is correct).
4. The paid plan's product and recurring prices exist in Orbit on Mercaria's
   Peable merchant, in both modes for every market it is sold in; the version is
   drafted, its prices published with those `price_…` ids, and activated — which
   will now succeed, because its capability is no longer postponed. Who receives
   the money (Peable ADR 0015's charge routing for Mercaria's merchant) is
   confirmed before this step.
5. `PEABLE_WEBHOOK_SECRET` and `MERCHANT_BILLING_RETURN_URL` are set, and a
   Peable webhook endpoint for Mercaria's merchant points at
   `/webhooks/peable` with the seven billing event types above.
6. A terms document exists at the version the plan names.
7. `MERCHANT_BILLING_ENABLED` is turned on.

---

## Building a paid tool

Every paid tool is built the same way, so a plan can never sell a screen that
does nothing and a merchant who stops paying never loses what they made:

- **Backend.** The tool's create/extend path calls
  `consumeCapabilityOrThrow(tx, { storeId, capability })` in the SAME
  transaction as the row it counts, and its delete calls `releaseCapability` (a
  `total` allowance only). A `flag` tool's route, and a background run of
  something already created, call `requireCapability`
  (`services/entitlements/enforce.ts`). A refusal is a `PlanCapabilityRefusal`:
  403 `PLAN_CAPABILITY_REQUIRED` (the plan lacks the tool) or 403
  `PLAN_LIMIT_REACHED` (the allowance is spent). At the ceiling a store still
  RUNS what it created; only creating more is refused.
- **What a refusal never touches.** Rows a tool created stay readable and
  exportable for free (`data_export` is ungateable). What stops when a plan
  ends is the tool's NEW work: new rules, new runs, new reports.
- **Dashboard.** The tool's screen lives under `app/(app)/tools/`, has one
  entry in `lib/plan-tools.ts`, and wraps its body in `PlanToolGate`, which
  reads `GET /admin/stores/:storeId/plan/capabilities` (any member; no billing
  state) and explains, without urgency, which plans on sale include the tool.
  A write the server refuses is recognised with `planRefusalOf(error)`.
- **Tests.** `services/entitlements/__tests__/entitle-store.ts` entitles a store
  through a grant, so a realdb suite needs no plan version or subscription.
- **Availability.** The capability's `MERCHANT_CAPABILITY_CATALOG` entry moves
  to `available` in the same change as the tool.

## Seams left, each failing closed

- **A capability's own enforcement** is each tool's: every built tool calls
  `services/entitlements/enforce.ts` (see "Building a paid tool"). A capability
  that is still `postponed` (`ai_catalog_assistance`) has no caller and no
  plan can name it.
- **Another financial rail.** `BillingProvider` remains the boundary, with one
  implementation (Peable). A deployment without `PEABLE_WEBHOOK_SECRET`
  registers no provider.
- **Changing between paid plans** is built (§6); a plan version that is
  RETIRED while merchants are on it keeps billing them at its frozen price until
  they choose another version — moving them is a decision with notice (terms §10).
- **Plan-selected fee schedules.** Declined — see §7 above. The mechanism by
  which one could ever arrive is a new scope column on `fee_schedules`, which is
  #88's schema and #88's decision.
