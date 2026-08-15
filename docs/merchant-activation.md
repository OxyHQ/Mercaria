# Merchant activation readiness and native-checkout onboarding (#85)

Guiding a verified merchant from a linked native store to a safely activated
Mercaria checkout — and, separately because they are separate questions, to a
guest checkout it can actually fulfil, support and refund.

Code:

| Path | Role |
|---|---|
| `@mercaria/shared-types` `merchant-activation.ts` | The whole vocabulary: two requirement registries, ten capabilities, fourteen onboarding steps, three policies. |
| `services/merchant-activation/requirements.ts` | The derivation. PURE. |
| `services/merchant-activation/capabilities.ts` | Requirements → capabilities. PURE. |
| `services/merchant-activation/onboarding.ts` | Requirements → the resumable flow. PURE. |
| `services/merchant-activation/facts.ts` | The ONE module that reads. |
| `services/merchant-activation/activation.service.ts` | Composes and projects. |
| `services/merchant-activation/checkout-gate.ts` | The narrow gate on checkout. |
| `services/merchant-activation/guest-activation.ts` | #107's seam, closed. |
| `services/merchant-activation/settings.service.ts` | The writes, each with its audit. |
| `services/merchant-activation/transitions.service.ts` | Observation, the sweep, the trace. |
| `db/merchantActivation/` | Three repositories. |
| `db/schema/merchantActivation.ts` | Three tables. |

Surfaces: `/admin/stores/:storeId/activation*` (merchant, `store:manage`),
`/seller/activation/policies` (individual seller),
`/internal/commerce-graph/activation/*` (operator, the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#83/#84 use).

---

## The verdict is DERIVED and never stored

The house rule is one stored verdict per fact — `provider_accounts`'
`onboarding_state` is the model, and it is stored because ADR 0001 D9's
conjunction is evaluated over the row being verdicted.

Activation readiness has no such row. Its inputs sit on `merchants`,
`native_store_links`, `merchant_claims`, `connections`, `sync_runs`,
`feed_configurations`, `listings`, `provider_accounts`, `fee_schedules`,
`orders` and this domain's own three tables — eleven tables in eight domains,
none of which this one owns. A stored verdict would be a twelfth
representation, and it would go stale at exactly the moment that matters: the
instant Stripe restricts a seller, a jury restricts a catalogue, or a connector
stops delivering.

So this is `deriveNativeCheckoutEligibility`'s (#57) divergence, taken for the
same reason `getRetailEligibility` (#121) and `deriveChannelReadiness` (#87)
took it. What IS stored is what somebody DECIDED — a policy accepted, a checkout
paused, an operator's hold — plus the append-only record of what the derivation
was OBSERVED to say, which is a recording and never an authority.

## Two registries, because guest is not a stronger native

#85 says it twice ("Readiness must distinguish general native checkout from
guest checkout", "Guest readiness cannot be inferred simply from Stripe account
readiness"). `MERCHANT_ACTIVATION_REQUIREMENTS` (15) and
`GUEST_ACTIVATION_REQUIREMENTS` (15) are DISJOINT, asserted by a test, and the
guest registry's first member is `native_checkout_ready` — so guest is narrower
by CONTAINMENT rather than by an extra threshold on somebody else's verdict.

Every member is answered: `requirements.ts` is a `Record` over the key union, so
a requirement published and never evaluated fails `tsc` rather than reading
exactly like one that always passes (#112's census device).

## Three outcomes, and two of them block

`satisfied | unsatisfied | unevaluable`, the #112 vocabulary.

`unevaluable` means this deployment cannot answer the question at all, and it
NAMES whose gap it is. It routes differently from `unsatisfied`: one is a build
somebody owes, the other is a form the merchant has not filled in. Both withhold.

Today exactly one requirement is `unevaluable` in a normal deployment —
`guest_transactional_contact_operational`, owner `#108`, because Mercaria has no
outbound mail transport and `hasGuestMessageTransport()` answers false. A guest
who cannot be told their order number, cannot recover access and cannot be sent a
return label is a guest whose purchase a store cannot support.

## `enabled | paused | disabled | ineligible`

- `paused` is reserved for the case where the ONLY unmet requirement is the
  merchant's own switch — everything else is ready and one click restores it.
- `disabled` is a requirement the merchant can act on.
- `ineligible` (guest only) is a requirement that is `unevaluable`. Telling a
  merchant to fix that sends them looking for a screen that does not exist.

`ineligible` beats `disabled` beats `paused`, the severity rule
`deriveRetailCompleteness` (#120) and `getRetailEligibility` (#121) both use.

## Capabilities, not one `checkoutEnabled` boolean

Ten, each naming the requirements it depends on. Two carry `null` rather than an
empty list: a STORE is not an individual seller, so `p2p_seller_checkout` and
`guest_p2p_checkout` are `not_applicable` — an empty list would grant them and a
full list would withhold them forever with no remedy.

Two properties fall out of the map rather than out of care:

- **A capability loss preserves existing paid-order operations** (#85
  readiness-change rule 3). `refund_and_return_operations` does not depend on
  the checkout requirements, so a store that lost payment readiness this morning
  can still refund yesterday's order.
- **Disabling guest checkout does not disable authenticated checkout** (rule 9).
  Two intent columns, two dependency lists; a realdb case drives it.

`deriveCapabilities` THROWS on a candidate whose results do not cover its
dependency list — #74's `rankOffers` rule, so a requirement added to a registry
and not wired into the derivation fails the first read instead of quietly
widening what is granted.

## The onboarding flow has no progress record

#85 asks that "every step can be resumed on another client through the Oxy
account". A stored cursor would satisfy the words and fail the thing: it goes out
of date the moment a merchant changes something on another surface, and two
clients would then disagree about where the merchant is.

Progress IS the authoritative state — a step is complete when the requirements it
covers are satisfied — so there is nothing to resume from and nothing to
reconcile. It is also why acceptance 5 ("resumes idempotently and does not create
duplicate stores, connections or provider accounts") needs no idempotency
mechanism here: reading creates nothing, and each of the three creations it names
is already held by an index in the domain that owns it (#84's
`store_linkage_requests_open_key`, #87's connection unique, #46's
`UNIQUE(provider, owner_type, owner_id)`).

A census asserts every requirement is covered by exactly one step, or is named in
`STEPLESS_REQUIREMENTS` **with a reason** — `merge-plan.ts`' `untouched`-with-a-
reason, one domain over. Silence is not a disposition.

## The checkout gate is deliberately NARROW

Three things, and nothing else:

1. an operator has held the store;
2. the merchant has paused its own checkout;
3. the marketplace fee schedule in force has not been accepted (#88's deferred
   gate).

Whether a store has a healthy connector, a publishable listing or a completed
test order is an ONBOARDING question. Refusing a checkout on those would take a
working store off sale because its sync had a bad night.

It runs at step **4f-bis**, immediately after checkout's own fee-schedule
selection, because the acceptance that matters is of the schedule THIS order will
snapshot in the currency it will snapshot it in — selecting again here would be a
second selection that could answer differently. Still before the reservation
loop, which every gate around it shares.

It reads TWO rows per store and calls the SAME pure predicates the full registry
calls (`deriveNoPlatformHold`, `deriveNativeCheckoutNotPaused`,
`deriveFeeScheduleAccepted`). One definition, two callers: the dashboard and the
gate cannot disagree about what "paused" means.

ONE reason code, `seller_not_activated`, for all three — the
`guest_rollout_blocked` decision applied to the authenticated path. A buyer
cannot act on which fired, and a client able to vary one input at a time could
read out whether a particular merchant is under an operator hold, which is a
moderation fact about somebody else's business.

**A deployment that has published no fee schedule is unaffected**: no applicable
schedule is #88's honest zero and the predicate reads it as satisfied.

## #107's `#85` seam is CLOSED

`GuestSellerActivation` gains its third member, `activated`, and
`readGuestSellerActivation` is now a real read in
`services/merchant-activation/guest-activation.ts`. Nothing else in the checkout
path moved: the four kill switches, the refusal shape, the reason code
(`guest_seller_not_activated`) and the position in the gate order are unchanged.

`GUEST_SELLER_ACTIVATION_REQUIRED` still gates whether the question is ASKED, and
still defaults OFF — ADR 0006 G14's decision, not an omission. The early return
is also what keeps the default path free of a database read.

`activated` means the guest CONJUNCTION holds. There is no column a merchant or
an operator could set to `activated` directly and no configuration that produces
one, which is ADR 0006 G14's "a per-merchant guest opt-in list would be a second,
drifting answer to what `onboarding_state` already answers" surviving intact.

An individual seller answers `not_activated` / `p2p_activation_unavailable`,
always — the fail-closed direction on the one path where two gates disagreeing
would matter.

## #112's `policies_accepted` criterion is CLOSED

`POST /seller/activation/policies` is the P2P acceptance surface #88 recorded as
#85's and #112 named as its one `unevaluable` criterion. The row is
`merchant_activation_policy_acceptances` with `owner_type = 'user'` — the
polymorphic owner is what lets a person selling a bicycle accept a policy without
a store and without `store:manage`.

The criterion is now `evaluated` and still BLOCKS a seller who has not accepted.
**Accepting it does not make guest P2P available**: #112's decision is a recorded
no-go and `GuestP2PAuthorization` has no member meaning yes.

## Policies are a CODE CONSTANT

`MERCHANT_ACTIVATION_POLICIES` — three keys, each with a published version. Not a
table, the #126 consumer-rights-terms decision: a version pointer is only as
durable as the code that can still resolve it, and a table would let somebody
publish a responsibilities version no shipped terms document contains, which
would then be snapshotted onto acceptance rows as what those sellers agreed to.

Bumping a `version` schedules a re-acceptance. Withdrawing consent is publishing
a new version, never an UPDATE — the acceptance table is append-only against both
UPDATE and DELETE by trigger.

## The audit trail is an OBSERVATION

Most activation transitions have no actor and no hook: Stripe restricts an
account, a connector stops delivering, a jury restricts a catalogue — and not one
of those domains knows this one exists. Adding a hook to each was rejected for
#57's converger reason: eight callers that must all remember is seven ways to
have an unaudited transition, and the one that forgets is invisible.

So a transition is recorded by comparing the derivation against what was last
seen. Every merchant and operator WRITE observes in the same request (`merchant`
/ `operator`, with the actor named); everything else is the sweep
(`system`, `scheduled_observation`, actor NULL — a biconditional CHECK, so a
sweep's finding can never be attributed to whoever triggered it).

ONE table, `merchant_activation_capability_events`. "What is it now" is the
LATEST row, read with an ordering that tie-breaks on `id` because one observation
writes several rows in one statement and `@oxyhq/db`'s uuid v7 is not monotonic
within a millisecond. A second current-state table would be derivable from this
one and could therefore disagree with it.

Serialization is `FOR UPDATE` on the store's settings row — a row that must exist
for any observation to be recorded — so this domain needs no lease table.

The observation runs AFTER the write commits, not inside it: `observeMerchantActivation`
opens its own transaction and re-derives from eleven tables, so calling it inside
would deadlock against the settings row the write already locked (#59's
merge-runner failure, which presents as a hang with no error). A crash between
the two loses an AUDIT ROW and never a decision — the verdict is derived, so the
next read is already correct and the next observation records the transition as
`scheduled_observation`.

## The operator surface adds no way to change anything

Four routes on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, not a
seventh: the power is the one that gate already carries — #83 verifies the claim,
#84 joins the merchant to a store, and holding that store's checkout is the same
decision one step later, over the same graph, by the same people.

The set is CLOSED. There is deliberately **no "activate this store", no "set this
capability" and no "mark this requirement satisfied"** — every one would be a way
to grant a capability the derivation refuses, which is exactly what acceptance 2
asks to be impossible. The one write that is not a hold DRIVES the existing
idempotent observation.

A trace opens from a STORE ID and nothing else. No function here takes an
account, an order or an email, so "which merchants has this person activated" is
unaskable.

The merchant sees `platformHold: true` and never the REASON: a hold's stated
reason is an operator's note about a moderation or risk finding, and a merchant
surface carrying it would be a way to read one.

## Environment

```
MERCHANT_ACTIVATION_TEST_ORDER_REQUIRED=false   # whether #85 state 12 BLOCKS
MERCHANT_ACTIVATION_OBSERVATION_ENABLED=false   # the sweep LOOP, never a row
MERCHANT_ACTIVATION_OBSERVATION_INTERVAL_MS=900000
MERCHANT_ACTIVATION_OBSERVATION_BATCH_SIZE=100
```

**Neither lever gates a durable record and neither gates a surface**, and a
scanned gate says so. There is deliberately no `MERCHANT_ACTIVATION_ENABLED`:
activation is a derivation over state eight other domains already own, and a flag
switching it off would not stop those facts being true, it would only stop
anybody being told.

`MERCHANT_ACTIVATION_TEST_ORDER_REQUIRED` defaults FALSE as a decision rather
than a timid default: there is no launch plan in this repository requiring a test
order, and making it blocking by default would mean the requirement refuses the
very order that satisfies it. It is always DERIVED and always reported.

## Migration

`0076` (`pre`) — three tables, two append-only trigger pairs, and one WIDENING of
`analytics_events_reason_code_check` (it gains `seller_not_activated` and loses
nothing). Every statement is additive or a superset, so nothing the previous
image writes is broken by it.

## Acceptance criteria: what is met, and what is a named seam

| # | Criterion | State |
|---|---|---|
| 1 | A verified merchant with a real connector and Stripe test account completes the flow and accepts a test native order | **SEAM.** Every derivation, gate, surface and step exists and is tested; there is no Stripe account, no connected store and no Shopify/WooCommerce install in this repository (see #69's own acceptance 7, still open). Nothing here may be read as evidence that one has been exercised. |
| 2 | Skipping a client step cannot enable checkout when an authoritative requirement is missing | **MET.** Every verdict is server-derived; the merchant schema is `.strict()` and declares four fields, none of them a capability, a requirement or a verdict; a scanned gate asserts the patch type carries none either. |
| 3 | External referral offers remain separate before and after native activation | **MET.** Structurally: `offers_kind_shape_check` forces `product_variant_id` NULL on every kind but `native`, so nothing this domain does could turn an external offer into a native one. Nothing here writes `offers`. |
| 4 | Losing payment readiness removes new native checkout without deleting products or existing orders | **MET.** `payment_provider_ready` withholds `authenticated_native_checkout`; `refund_and_return_operations` does not depend on it; this domain issues no DELETE against any catalogue or order table. |
| 5 | The flow resumes idempotently and creates no duplicate stores, connections or provider accounts | **MET.** Reading creates nothing (there is no progress record), and each of the three creations is held by an index in the domain that owns it. |
| 6 | Every readiness failure has an owner-facing explanation and an operator trace | **MET.** A closed reason-code set per requirement, plus the transition trail. |
| 7 | Feature flags support pilot merchants and market-by-market activation | **PARTIAL, and stated.** The per-merchant and per-market levers exist (`GUEST_CHECKOUT_BLOCKED_SELLER_KEYS`, `GUEST_CHECKOUT_BLOCKED_MARKETS`, `CHECKOUT_DESTINATION_COUNTRIES`) and this domain reads them. A POSITIVE cohort model is #111's, and `guest_cohort_enabled` reads the block list rather than claiming a cohort that does not exist. |
| 8 | Guest readiness is separate from general native checkout and cannot be inferred from Stripe readiness alone | **MET.** Two disjoint registries; guest names twelve facts Stripe does not answer. |
| 9 | A signed-out buyer sees guest checkout only for an actually eligible offer and fulfilment path | **MET on the server.** `readGuestSellerActivation` answers the guest conjunction and the gate refuses. The storefront affordance is #111's rollout work. |
| 10 | Merchant staff can fulfil, refund and support guest orders without an Oxy buyer profile or access to guest security data | **MET, and it was #106's.** `MerchantOrder` `Omit`s the buyer fields and `order_status_history.actor_guest_session_id` is in `PROTECTED_COLUMNS`. What #85 adds is `guest_buyer_data_permissions_scoped` — a requirement that SOMEBODY on the store holds the permission, which is a real checkable state (`refunds:write` is not in `staff`'s nine). |
| 11 | Pausing new guest checkout preserves portal, support, refund and fulfilment operations for existing orders | **MET.** The pause is an intent column read only by the derivation; #108's portal router mounts unconditionally and a scanned gate there forbids a read path from reading a guest lever. |
| 12 | P2P guest checkout remains false until #112 passes its independent gate | **MET.** `GuestP2PAuthorization` still has no member meaning yes, and `guest_p2p_checkout` is `not_applicable` for a store. |

## Seams, each failing closed and none a stub that lies

- **#108** — the transactional transport. `guest_transactional_contact_operational`
  is `unevaluable` on every deployment, so guest checkout reads `ineligible`
  rather than `disabled`. One `registerGuestMessageTransport` call closes it and
  nothing here changes.
- **#111** — a positive rollout cohort, the storefront affordance, and the guest
  analytics events. `guest_cohort_enabled` reads the block list ADR 0006 G14
  already decided on rather than claiming a cohort model that does not exist.
- **#93** — pickup. `pickup_checkout` depends on
  `guest_fulfilment_deterministic`, which excludes `pickup` at the source
  because `assertPickupLocationEligible` refuses every pickup; counting it would
  satisfy the requirement with a path that cannot complete a checkout.
- **The ten TEST ORDERS #85 lists** — authenticated card, guest card, an express
  method, shipping, pickup, a payment failure, a refund request, transactional
  email, a guest feature pause and a mixed cart. Not modelled, because eight of
  the ten need an external account or a capability nobody has built (a Stripe
  test account, #93's pickup, #108's mail). What IS derived is
  `test_order_completed` — a completed order on the rail this deployment is
  configured for — which is honest and checkable.
- **Change NOTIFICATIONS on a fee schedule or a policy version** (#88's other
  deferred item). The acceptance state and its `current` flag are derived and
  visible on the dashboard the moment a version is bumped; PUSHING a message
  needs the same absent transport #108 owns.
- **Downloadable fee breakdowns** (#88's fourth deferred item). `/fees/preview`
  already returns the arithmetic; a file is a rendering decision with no server
  work behind it.
