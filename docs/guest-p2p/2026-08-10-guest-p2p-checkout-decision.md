# Guest checkout for P2P orders — decision, 2026-08-10

- **Issue:** [#112](https://github.com/OxyHQ/Mercaria/issues/112), part of
  [#101](https://github.com/OxyHQ/Mercaria/issues/101) and
  [#41](https://github.com/OxyHQ/Mercaria/issues/41)
- **Binds:** ADR 0003 D18 and ADR 0006 G18, which excluded P2P from guest
  checkout at launch and assigned this decision to #112
- **Outcome:** **NO-GO.** Guest checkout from an individual seller stays
  refused, server-side, by seller type. No bounded pilot is authorized.
- **Next review:** triggered by the conditions in
  [§What would change this](#what-would-change-this), not by a date.

## The decision

A guest — somebody with no Oxy session — may not buy from an individual seller.
The gate is `services/guest-p2p/gate.ts`, it refuses at checkout-group
construction and again immediately before the payment is created, and it is
decided from `listings.owner_type` on the server. Guest checkout from a STORE
is unaffected, and an authenticated Oxy buyer's P2P checkout is unaffected.

There is no feature flag that turns this on. `GuestP2PAuthorization`
(`services/guest-p2p/authorization.ts`) has no member meaning "authorized", so
no configuration, no operator action and no service bug can enable it. ADR 0003
D18 anticipated "a config flag whose flip is a decision recorded on #112"; this
document is that record, its answer is no, and a switch whose flip would enable
a scope nobody approved is exactly the dormant switch #105 declined to ship. The
flag arrives with the approval it implements, in the change that adds the second
member to that union.

## Why, in one paragraph

The decision does not rest on the risk argument in ADR 0003 D18 — that argument
is a prior, and #112 exists to test it against evidence. It rests on two things
this repository can state as facts rather than estimates. First, **every
measurement #112 requires is unavailable**: guest commerce has never been
enabled in a production deployment, so the guest cohort that a P2P decision must
be compared against does not exist, and #111 (which produces it) has not landed.
Second, **two capabilities a P2P buyer would need do not exist in this codebase
at all**: a P2P order has no refund path for any actor, and a P2P seller has no
surface on which to answer a cancellation, a return or a support thread. A guest
who bought from a person could pay, receive nothing, and have no route to their
money and no route to the seller. That is not a risk to be priced; it is a
missing product.

## Required research and measurement

#112 lists sixteen items to evaluate before a go decision. Each is recorded
below with the window it would be measured over, what is available on
2026-08-10, and what would produce it. **No number in this table is a
measurement, because none was available to take.** Where an item is answered
from code, the file is cited and the item is marked `code-verified` — that is a
fact about this repository, not a fact about production behaviour.

The provenance of the availability column is stated once here so no row has to
repeat it: **nothing below was read from a production database.** The two
queries that would settle the volume questions are named in
[§The queries not run](#the-queries-not-run), and they were deliberately not
run — a decision that must be reproducible from a document cannot rest on a
number nobody else can re-derive.

| # | Item | Data window | Available on 2026-08-10 | Limitation | What would produce it |
|---|---|---|---|---|---|
| 1 | Fraud and dispute rate from authenticated P2P orders | Trailing 90 days of `payments` + `payment_disputes` joined to `orders.seller_type = 'user'` | **No.** Unknown volume; see §The queries not run | The dispute domain (#49) shipped weeks ago and its runbook records no production incident, so any rate would sit on a denominator nobody has counted. A rate over a small denominator is not a rate | A named query over a period with a stated denominator, plus a minimum sample the decision states in advance |
| 2 | Item-not-as-described rate | Trailing 90 days of `buyer_requests` with a return reason, over P2P orders | **No.** #110 shipped 2026-08-10 (PR #229); there is no history | The domain is days old, and its P2P half is unreachable (item 10 below) | Buyer requests filed against P2P orders after the P2P refund path exists |
| 3 | Counterfeit and prohibited-item reports | Trailing 90 days of `abuse_reports` + CrowdSource decisions, scoped to `listings.owner_type = 'user'` | **No.** `CROWDSOURCE_ENFORCEMENT_MODE` defaults to `observe`, which records a plan and changes nothing | Reports may exist; DECISIONS with enforcement are what a counterfeit rate needs, and observe mode produces none | CrowdSource in `manual` or `automatic`, plus a jury history over P2P subjects |
| 4 | Cancellation and refund rate | Trailing 90 days, P2P orders | **No**, and structurally so: `orderHasRefundPath` returns false for every P2P order (`services/buyer-requests/refund-bridge.ts`) — `code-verified` | The rate is not merely unmeasured; the event it measures cannot occur | The P2P refund path (item 10) |
| 5 | Seller response time | Trailing 90 days of `support_messages` on P2P orders | **No**, and structurally so: the merchant side of #110 is store-scoped (`requireStorePermission`) — `code-verified` | A P2P seller has no surface to respond on, so a response time would measure nothing | A P2P seller order surface |
| 6 | Buyer–seller support and messaging volume | Trailing 90 days | **No**, same cause as item 5 | — | Same as item 5 |
| 7 | Pickup and meetup safety incidents | Any | **No**, and structurally so: pickup fails closed at checkout (`assertPickupLocationEligible`) and #93 has no implementation — `code-verified` | There have been no meetups because there can be none | #93 |
| 8 | Payment dispute and chargeback liability under #43 | n/a — a decision, not a measurement | **Half.** #43 is CLOSED: it is ADR 0001, and the general model is decided | ADR 0001 D1 makes Mercaria merchant of record, D7 debits the platform balance and reverses the seller's transfer, and separate charges and transfers makes Mercaria responsible for a connected account's negative balance (ADR 0001 fact 2). So the loss on an individual payee already lands on Mercaria — and nothing models a reserve, a delayed payout or an exposure limit for one. That is the decision's OUTPUT, not its absence | A P2P-specific amendment: reserves or payout delay for individual payees, and an accepted exposure limit |
| 9 | Seller onboarding and payment-readiness coverage | Point-in-time count of `provider_accounts` where `owner_type='user'` and `onboarding_state='ready'`, over sellers with active listings | **No.** See §The queries not run | The verdict itself is available per seller (`readSellerPaymentReadiness`) and is a criterion in the policy; what is missing is the COVERAGE figure a cohort would be drawn from | The named query, run against production |
| 10 | Condition-evidence quality from #90 and #91 | Point-in-time distribution of `listings.condition_assertion` and evidential photo counts over P2P listings | **Partly.** #90 landed and the inputs exist per listing (`condition_assertion`, `listing_condition_details`, `listing_condition_photos`); #91 (seller-facing refinement) is **not merged** — open PR #236 | Without #91 a seller has no UI to refine a `migrated_binary` condition or attach actual-item photos, so a distribution measured today reports the absence of a feature rather than the quality of sellers' disclosures | #91, then a distribution over a period in which sellers could actually act |
| 11 | Oxy identity, Trust and blocking dependencies | Point-in-time | **Partly**, and it is the healthiest item here. `readSellerTrust` and `deriveSellerVisibility` (#92) are live and are criteria in the policy | Oxy Trust tiers are read, never computed; an absent tier is `unknown` and blocks (see the asymmetry note in `services/guest-p2p/eligibility.ts`). Blocking is Oxy's graph and is viewer-scoped, which a guest has no credential for | Nothing further for the seller side. The BUYER side (a guest cannot be blocked, because they are nobody) is a design consequence, recorded in §Identity |
| 12 | Whether guest email verification is enough recovery without a public buyer identity | n/a — a design question with a shipped answer | **Yes**, and it is favourable. #108's portal grants scope to ONE checkout group, verification is inbox possession, and #109's claim requires a two-sided proof | It is enough for RECOVERY. It says nothing about whether a person can be reached for a dispute on day 30, which is item 15 | — |
| 13 | Legal or regulatory distinctions in launch markets | n/a | **No.** Not assessed | A consumer buying from a private individual in the EU has no statutory withdrawal right against them, while Mercaria is merchant of record (ADR 0001 D1) — the two do not obviously compose, and this needs counsel, not engineering | A legal review of the Spain launch market, recorded |
| 14 | Merchant-of-record and consumer-rights implications for P2P | n/a | **No.** Not assessed; same review as item 13 | ADR 0001 D1 makes Mercaria merchant of record in every native flow, including a sale between two private people. What Mercaria then owes the buyer is a legal question | Same as item 13 |
| 15 | Operational ability to investigate a dispute without an Oxy buyer account | n/a — assessable from what exists | **Partly.** An operator can trace a payment from five handles (#50) and a guest checkout group (#108), and the audit trail records `actor_kind` | The buyer is reachable only through an inbox that may be stale, and there is no P2P seller surface to put a question to (item 5). Investigation is one-sided | Items 5 and 10 |
| 16 | Support staffing and evidence retention | n/a | **Retention: yes.** ADR 0003 D11's five classes are implemented and #110's evidence is a bare Oxy `file_id`. **Staffing: no** — not assessed, and not an engineering answer | Evidence retention is settled; who answers a P2P dispute at 9pm is not | An operations decision, recorded |

### The queries not run

Two counts would settle items 1 and 9, and both need a production database this
work does not touch. They are written down so the next review runs the same
ones rather than inventing its own:

```sql
-- Item 1's denominator: authenticated P2P orders that were actually paid.
select count(*) as p2p_paid_orders
from orders
where seller_type = 'user'
  and payment_status = 'paid'
  and created_at >= now() - interval '90 days';

-- Item 9: individual sellers who could be paid at all.
select count(*) as ready_individual_sellers
from provider_accounts
where provider = 'stripe' and owner_type = 'user' and onboarding_state = 'ready';
```

A third question — how many guest orders exist — needs no query. Guest commerce
is gated by `GUEST_COMMERCE_ENABLED`, which defaults to false and refuses to
enable without both PII keys (`config/index.ts`), and ADR 0003 M8 plus its
acceptance criterion 8 make enabling it in any non-test environment conditional
on a security and privacy review recorded on #111, which is not merged. **This
is an inference from code and issue state, not a query result**, and it is
recorded as such: the conclusion is that the guest cohort #112 would compare
against does not exist yet, which is the same conclusion either way.

## What is a fact rather than a measurement

Four findings below are read off this repository's own source. They are the
reason the outcome is a no-go rather than "insufficient data": even if every
measurement in the table came back favourable, these would still block.

1. **A P2P order cannot be refunded, by anyone.** `refund.service.process` is
   scoped to a store and `/admin/stores/:storeId/orders/:id/refunds` is its only
   route, so `orderHasRefundPath` answers false for every P2P order
   (`services/buyer-requests/refund-bridge.ts`). #110 names this as a
   pre-existing gap and records `refund_path_unavailable` rather than papering
   over it. It is currently unreachable for a guest precisely because guest P2P
   checkout is refused — enabling guest P2P is what would make it reachable, for
   the buyers least able to chase it.
2. **A P2P seller has no surface to answer on.** Every merchant route for buyer
   requests is behind `requireStorePermission`, so a person selling a bicycle
   cannot see, accept or reject a cancellation, a return or a support thread on
   their own sale. #112 seller eligibility 9 ("messaging availability") is
   therefore not unknown; it is false.
3. **Pickup is unavailable and unmodelled.** `assertPickupLocationEligible`
   refuses every collection because there is no publication state, no
   pickup-specific inventory view and no per-location hours in this schema. All
   ten of #112's "Pickup and meetup safety" requirements are #93's, and #93 has
   no implementation and no open pull request.
4. **A mixed cart shares one charge, and the liability model already assigns
   the loss to Mercaria.** A Mercaria checkout opens ONE PaymentIntent per
   checkout group covering every seller order in it (ADR 0001 D3/D4). #112
   listing eligibility 10 forbids mixed store-and-P2P payment "unless #43
   supports the liability model clearly". #43 is closed and it IS clear — ADR
   0001 fact 2 records that separate charges and transfers is recommended "only
   when you're responsible for negative balances of your connected accounts",
   and D7 leaves Mercaria to eat a reversal an individual's balance cannot
   cover. Clear, and clearly unfavourable: recovery against a private
   individual with no balance and no future transfers is the weakest link in
   that model, and no reserve is modelled anywhere. The only compliant shape
   today is therefore to refuse or separate the P2P group before the payment
   exists, which is what the gate does.

## What was built anyway, and why

A no-go decision that leaves nothing behind gets re-litigated from scratch. What
this issue ships is the part that is true whatever the outcome:

- **The gate**, server-authoritative by seller type, refusing at group
  construction and again immediately before payment creation
  (`services/guest-p2p/gate.ts`). The second call is #112 checkout behaviour 2,
  and it is what makes acceptance 6 a property of the CHARGE rather than of the
  plan. It sits inside `openGatedCheckoutPayment`, the ONE line in
  `checkout.service` that reaches the rail — the fresh path, the Redis
  idempotency fast-path and the unique-violation converge all go through it,
  and `checkout-payment-gate.test.ts` fails the build if a second route to
  `openCheckoutPayment` appears.
- **The policy**, as a closed vocabulary of twenty criteria with the sentence
  each implements and where its answer comes from
  (`@mercaria/shared-types/guest-p2p.ts`, `services/guest-p2p/policy.ts`). A
  census test fails the build if a criterion is published and never evaluated,
  or evaluated and never published.
- **The derivation**, pure and three-valued
  (`services/guest-p2p/eligibility.ts`): `satisfied`, `refused`, `unevaluable`.
  Two of the three block. `unevaluable` names who would supply the input, so
  "we do not know" is never a soft yes and never an imputed value.
- **The prohibitions as values.** `GUEST_P2P_FORBIDDEN_CRITERIA` is disjoint
  from the criterion vocabulary by a test: a public buyer identity, a reusable
  handle, a Trust score Mercaria computed about a guest, a card fingerprint, an
  auto-created Oxy account, paid placement and a ranking penalty for guest
  status can never become inputs.
- **Visibility before checkout.** A guest's cart marks each group it cannot
  check out (`CartGroup.guestCheckout`), with one reason code and the sign-in
  remedy, and the storefront renders it in place of the checkout button. The
  whole-cart button then places only the groups the caller may actually place.
- **An operator surface**, read-only, on the existing
  `GUEST_OPERATOR_OXY_USER_IDS` allow-list: the published policy, and a trace
  from a LISTING id showing every criterion's outcome. There is no route that
  could authorize a seller, waive a criterion or enable the pilot.

## Identity and communication design

#112's ten identity rules, with what enforces each today. Nine are enforceable
now and are enforced; the tenth is the one a pilot would have to build.

| # | Rule | Status |
|---|---|---|
| 1 | Seller sees a private order participant, not a public Oxy profile | **Enforced.** `MerchantOrder` `Omit`s the buyer fields (#106) — a serializer reaching for one fails `tsc` |
| 2 | Guest contact stays behind Mercaria's relay | **Enforced.** The contact lives on `guest_checkouts`, encrypted, and the seller projection has no field for it (ADR 0003 D13) |
| 3 | Guest cannot be followed, reviewed or given Oxy Trust reputation | **Enforced.** `guest_trust_score` is a forbidden criterion; reviews require Oxy auth; there is no buyer entity to follow |
| 4 | Seller cannot open off-platform contact from the buyer's email | **Enforced.** The seller never receives an address in any form; `seller_direct_contact_exchange` is a forbidden criterion |
| 5 | Messaging is scoped to one order and moderated | **Buyer side only.** #110's support threads are order-scoped; the SELLER side does not exist for P2P (finding 2) |
| 6 | Blocking and safety controls work without exposing identity | **Partly.** Oxy owns the block graph and it is viewer-scoped; a guest holds no viewer credential, so a guest can neither block nor be blocked. Stated as a limitation of any future pilot, not solved here |
| 7 | Claimed orders move future communication to the Oxy account through #109 | **Enforced.** #109 shipped; a claim revokes emailed access |
| 8 | Guest purchase creates no reusable buyer handle | **Enforced.** `reusable_buyer_handle` is a forbidden criterion; the merchant label is the literal `Guest`, never per-guest (#106) |
| 9 | Public seller identity stays `oxy.user` under #92 | **Enforced.** `seller-identity-isolation.test.ts` fails the build on a `mercaria.*` follow kind |
| 10 | The guest can report the seller, listing or transaction | **Enforced.** `POST /reports`; `seller` and `store` reports are stored locally with no subject provider, which the UI does not promise otherwise |

## Seller and listing eligibility, as implemented policy

All twenty criteria are in `services/guest-p2p/policy.ts` with their
availability. The summary that matters for this decision:

- **Twelve are answerable today** from records that exist — payout readiness,
  Oxy identity state, Trust or transaction history, moderation restriction,
  market/currency/fulfilment, both category questions, condition evidence and
  normalization, actual-item photos, value cap, quantity, domestic-only, and the
  mixed-payment question.
- **One is unevaluable and names #85**: return, cancellation and dispute policy
  acceptance. #88 shipped fee acceptance for STORES behind `store:manage`; a
  private individual has no store and no permission to hold, and the P2P
  acceptance surface is recorded as #85's.
- **Two are refused because the capability does not exist**: messaging
  availability and "no required buyer capability that exists only for
  authenticated Oxy users" (findings 1 and 2).
- **One is vacuous and says so**: no negotiation or offer messaging — Mercaria
  implements none, and `checkoutSchema` is `.strict()` and refuses every money
  field, so there is nothing to restrict.
- **One lands on `unevaluable` for a pickup destination and names #93**: the
  fulfilment-method criterion. This is the not-applicable branch #112 asks be
  explicit rather than a silent pass, and it BLOCKS.

The bounded scope those criteria are evaluated against
(`GUEST_P2P_BOUNDED_SCOPE`) is a code constant, not a table and not an
environment variable: it is a published policy somebody would sign, and
widening it is a commit with an author and a date. Its category allow-list is
**empty**, which under this domain's grant semantics permits nothing — the
correct state for a cohort nobody has chosen.

## Pickup and meetup safety

Deferred in full to #93, and nothing here approximates it. #93 owns
location-aware inventory, nearby discovery and pickup; it has no implementation
and no open pull request, so there is no publication state, no collectable
inventory view, no per-location hours and no meetup concept to validate
against. Every one of #112's ten pickup requirements — coarse public location, a
home address that is never public, precise information shared only through the
authorized flow, supported safe pickup methods, audited location changes, safety
guidance without a guarantee, emergency and harassment reporting, no background
location, bounded retention of precise coordinates, and whether guest pickup is
excluded from a first pilot — is a decision that needs #93's data model to
exist first.

What this issue does instead of inventing one: the fulfilment criterion answers
`unevaluable` with owner `#93` for a pickup destination, and blocks. A guest
P2P pilot could not include pickup even if it were authorized.

## Disputes, returns and evidence

- Reuse of #110's request domains and #49's provider refunds is the intended
  shape and is **blocked by finding 1**: there is no P2P refund path to reuse.
- P2P-specific evidence requirements for condition, shipment and delivery would
  build on #90's evidence (which exists) and Moovo's transport facts (which do
  not — #156–#159 are unbuilt).
- Payment disputes stay separate from CrowdSource moderation; the two domains do
  not import each other and that is a scanned gate today.
- Who bears chargeback and negative-balance risk for an individual payee is
  decided and it is Mercaria (ADR 0001 D7 and fact 2) — what is missing is any
  bound on that exposure (item 8).
- Whether payouts are delayed or reserved for eligible guest P2P transactions is
  an amendment nobody has made; Mercaria models no reserve today.
- Duplicate refund and restock outcomes are already prevented by #110's
  idempotency and #49's restock-once rule.
- Guest portal access through dispute completion already works: grants are
  re-mintable by magic link for as long as the order is retained.
- Private evidence retention is ADR 0003 D11's, implemented.
- Seller access without exposing unrelated buyer information is #106's
  `MerchantOrder`, implemented — but there is no P2P seller surface to serve it
  through.
- Operator runbooks and escalation ownership: **not written**, and they should
  be written against a flow that exists.

## What a bounded pilot would look like

Recorded so that the next review can evaluate a concrete proposal instead of
re-deriving one. This is NOT authorized.

- Internal or staff transactions first, then a small allow-listed cohort of
  individual sellers.
- One market (ES), one currency (EUR), shipping only, quantity one, a €50 line
  ceiling, an allow-list of low-risk categories on top of the standing exclusion
  list — the values in `GUEST_P2P_BOUNDED_SCOPE`.
- Card only, within the payment surfaces the server already offers.
- An independent kill switch that stops ENTRY and never touches a placed order,
  the shape `MERCARIA_RETAIL_ENABLED` and #125's pilot gate already use.
- Stop thresholds for fraud, disputes, safety, support load and payment loss,
  each with a named producer. **A threshold nobody measures is a vacuous
  monitor** (#125's `unmeasured` rule): a pilot may not declare a threshold
  whose measurement does not exist, so the producers land before the pilot does.
- Expansion by a new recorded review, never by a percentage ramp.

## Go / no-go criteria, answered

| # | Criterion | Status |
|---|---|---|
| 1 | Payment liability and payout behaviour decided in #43 | **Half met** — #43 is closed and the general model is decided (ADR 0001 D1/D7); the P2P-specific half (reserves, payout delay, an accepted exposure limit for an individual payee) is not |
| 2 | Guest store checkout stable under #111 metrics | **Not met** — #111 not merged; guest commerce never enabled in production |
| 3 | Condition and actual-item evidence reliable under #90 and #91 | **Not met** — #90 landed, #91 not merged |
| 4 | Secure transactional messaging and portal operational | **Half met** — the portal is operational; there is no outbound mail transport, and no P2P seller messaging surface |
| 5 | Cancellation, return, refund and support paths operational | **Not met** — none of them reaches a P2P order (finding 1) |
| 6 | Seller and listing eligibility implemented server-side | **Met** — this issue |
| 7 | Privacy and safety review | **Not met** — ADR 0003 M8's review is recorded on #111 and is not complete |
| 8 | Category restrictions and prohibited-item enforcement | **Half met** — the exclusion list is policy and is enforced by the criteria; there is no category-level prohibition flag in the catalogue itself, so the list is slug-based |
| 9 | Support and dispute runbooks staffed | **Not met** — not written |
| 10 | Feature flag and rollback tested | **Not applicable** — no flag exists, by decision |
| 11 | No critical or high unresolved security finding | **Not assessed for this scope** |
| 12 | Measured pilot thresholds approved | **Not met** — no measurement exists to threshold |

Two of twelve are met. The decision is not close.

## Acceptance criteria of #112, answered

1. **P2P guest checkout remains disabled until a dated decision approves a
   bounded scope.** This document, and a union with no `authorized` member.
2. **The decision uses real evidence rather than assumption.** Where evidence
   exists it is cited to a file; where it does not, the row says so and names
   what would produce it. No number in this document is invented.
3. **A guest is never turned into a fake Oxy buyer.** `auto_created_oxy_account`
   is a forbidden criterion and the isolation gate fails the build on any
   account-creation call in the domain.
4. **Seller and listing eligibility is server-authoritative and explainable.**
   Twenty published criteria, a pure derivation, and an operator trace.
5. **Buyer and seller personal contact is not exposed by default.** Unchanged
   from #106/#108; the new domain reads no buyer value at all, by scan.
6. **Mixed carts cannot accidentally charge an ineligible P2P group.** The gate
   runs again immediately before the rail is opened, over the created orders; a
   real-server case drives a mixed cart end to end and asserts the PaymentIntent
   covers the store order alone.
7. **Any pilot has independent flags, value and category limits, monitoring and
   stop thresholds.** Recorded above; not authorized, so not built.
8. **Dispute, payout, return and pickup responsibilities are explicit before
   launch.** Recorded above as explicitly UNRESOLVED, with the owner of each.
9. **A no-go decision leaves store guest checkout unaffected.** The gate is a
   no-op for a store group and for every non-guest actor; the guest store
   checkout suite is unchanged and green.
10. **Expansion beyond the pilot requires a new review.** The bounded scope is a
    code constant; widening it is a commit.

## What would change this

A future review should re-run this document's table rather than start over. The
outcome changes when, at minimum:

1. an amendment to ADR 0001 (#43) records a reserve, a payout delay or an
   accepted exposure limit for an INDIVIDUAL payee — the general model already
   assigns the loss to Mercaria, and today nothing bounds it;
2. a P2P order has a refund path, and a P2P seller has a surface on which to
   answer a cancellation, a return and a support thread (finding 1 and 2);
3. #111 has landed and a guest STORE cohort has run long enough to produce
   dispute, chargeback and support-load figures with a stated denominator;
4. #91 has landed, so condition evidence measures sellers rather than the
   absence of a feature;
5. items 13 and 14 have a recorded legal review for the launch market.

#93 is NOT on that list, because a first pilot would exclude pickup — but it is
on the list for any pilot that includes collection, and all ten of #112's pickup
requirements come with it.
