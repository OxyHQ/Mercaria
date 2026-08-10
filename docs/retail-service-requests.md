# Retail cancellations, returns, warranties, RMAs and refunds (#127)

What a buyer may ask for once they have bought a `mercaria_retail` item, what
Mercaria owes them, and what Mercaria separately tries to recover from the
supplier who shipped it.

Its companion halves are `docs/purchase-orders.md` (#124, how Mercaria BUYS),
`docs/retail-fulfilment.md` (#126, how the goods get there and where Moovo's
half stops), `docs/payments.md` §"Mercaria-retail on the card rail" (#123, how a
retail order is placed and paid for) and `docs/buyer-requests.md` (#110, the
same story for a MARKETPLACE order).

The binding decisions are ADR 0004 (`docs/adr/0004-mercaria-retail-dropship.md`),
specifically **D2.6** (consumer rights are Mercaria's whatever the supply
agreement says), **D8.5** (a supplier credit is separate from a customer right)
and diagrams 8–11.

---

## The one sentence everything rests on

> **The buyer must not be stranded between Mercaria, Stripe and an undisclosed
> supplier.**

Mercaria is the SELLER of record. A customer's rights are answered by Mercaria
whatever the supplier does, and **no customer-facing path may tell somebody to
contact a supplier they were never told about**. Every design decision below is
that sentence made structural rather than promised.

---

## The wall down the middle

There are two parties on Mercaria's side of a retail sale, and they answer
different questions on different clocks.

| | The CUSTOMER side | The SUPPLIER side |
|---|---|---|
| What it decides | what Mercaria owes the buyer | what Mercaria can recover from the supplier |
| Who decides it | Mercaria, under the order's snapshotted terms and the law of its market | the supplier |
| Its clock | `statutory_deadline_at` / `commercial_deadline_at` | `supplier_response_due_at` |
| Tables | `retail_service_requests` + lines, evidence, events, return case, warranty case | `supplier_return_authorizations`, `supplier_recoveries` |

**There is exactly ONE column joining them**, `supplier_recoveries.service_request_id`,
and it points from the supplier side to the customer side and never back. An
operator reading a request can find its recoveries; no query starting from a
recovery can change what the buyer is owed.

That is ADR 0004 D8.5 as a shape, and it is checked three ways:

- **The import graph.** `retail-service-isolation.test.ts` fails the build if any
  CUSTOMER-half module reaches `supplierRecoveryRepository`, `supplier-rma.port`
  or #124's `purchaseOrderRepository`. Mutation-tested: adding that one import to
  `refund-bridge.ts` turns the gate red and names the file.
- **The types.** `RetailServiceRequestView` has no recovery member and
  `SupplierRecovery` has no customer amount, so a serializer reaching across
  fails `tsc`.
- **The routers.** The customer half is served from `/internal/payments/*` and
  the side-by-side trace from `/internal/procurement/*`, so the disclosure
  boundary is which router answers rather than a filter somebody applies.

---

## The twelve request kinds, and the table that decides what each costs

`RETAIL_SERVICE_REQUEST_KINDS` is #127's own list, verbatim, and
`RETAIL_SERVICE_REQUEST_POLICIES` is a TABLE — the `claim-methods.ts` device from
#83 — so adding a thirteenth means adding a row and deciding every column rather
than finding every branch.

| Kind | Buyer may file | Evidence | Opens a return | Opens a warranty case | Window |
|---|---|---|---|---|---|
| `pre_acceptance_cancellation` | yes | no | no | no | cancellation |
| `pre_dispatch_cancellation` | yes | no | no | no | cancellation |
| `withdrawal_return` | yes | **no** | yes | no | withdrawal |
| `damaged_on_arrival` | yes | yes | yes | no | return |
| `wrong_item` | yes | yes | yes | no | return |
| `missing_item` | yes | yes | **no** | no | return |
| `defective_product` | yes | yes | yes | yes | warranty |
| `delivery_failure` | yes | no | no | no | none |
| `return_to_sender` | **no** | no | yes | no | none |
| `warranty_claim` | yes | yes | yes | yes | warranty |
| `safety_recall` | **no** | no | yes | no | none |
| `chargeback_coordination` | **no** | no | no | no | none |

Three columns are worth reading.

**`evidenceRequired` is FALSE for `withdrawal_return`**, which is #127 policy
rule 6 — *"do not require unnecessary photos or documents for ordinary
withdrawal"* — as a value rather than as a review comment.

**Three kinds are not customer-submittable**, and none of them is an oversight.
`return_to_sender` is reported by a carrier or a supplier; a buyer whose parcel
bounced knows only that it never came, which is `delivery_failure`.
`safety_recall` is Mercaria acting on a #121 suppression, and letting a buyer
declare one would put an unreviewed product-safety assertion into the record
that decides whether OTHER buyers are contacted. `chargeback_coordination` is
opened by a Stripe dispute event: a buyer who "files a chargeback" with Mercaria
has actually filed one with their bank, and recording their claim as the dispute
would make Mercaria's evidence deadline depend on when somebody happened to tell
us.

**`window: 'none'` is a real answer.** #127 policy rule 8 says safety and
defective-product cases stay actionable beyond ordinary withdrawal windows;
giving a recall a window would be the mechanism by which it expires.

---

## Two deadline columns, never one

#127 policy rules 2 and 3 ask that statutory and commercial policy be recorded
SEPARATELY and that a supplier's narrower policy never silently reduce a
statutory right. **A single effective deadline cannot express the second**: by
the time the two are one number the narrower one has already won and nothing
records that it did.

So a request stores both, and `resolveEffectiveServiceDeadline` returns the
LATER of them. `Math.max` on a deadline can only move it outwards, which a
property test drives over 500 randomized pairs rather than asserting in a
comment. `decidingPolicyBasis` then says WHICH won, so a client can render
*"30 days, because Mercaria's policy is longer than the 14 the law requires"*
rather than a bare date.

**Nothing in `policy.ts` reads a supply agreement**, and a scanned gate says so.
An agreement's `returnsResponsibility` describes Mercaria's RECOURSE against a
supplier; reading it as a bound on what a buyer may ask for is the exact
substitution D2.6 forbids, and it is a plausible-looking change — the agreement
is right there and it says "no returns after 14 days".

### The anchor, and the grace it needs

Goods-based rights run from the day the consumer takes physical possession.
Mercaria cannot observe delivery — Moovo owns that (#126) and no adapter reports
one today — so most retail orders have a dispatch instant and no delivery
instant.

Anchoring on dispatch starts the clock EARLIER than the law does, which shortens
the buyer's rights. `RETAIL_UNKNOWN_DELIVERY_GRACE_DAYS` (14) is added when the
anchor is a dispatch, so the buyer gets the benefit of Mercaria's ignorance
rather than paying for it. **It is a code constant and not a setting**: a
deployment able to tune "how much benefit of the doubt does a buyer get" would
tune it to zero, and the number exists because Mercaria cannot observe delivery
rather than because anybody chose a service level.

### Category exceptions are real, reviewed, and can never come from a supplier

EU consumer law genuinely carves categories out of the withdrawal right (sealed
hygiene goods, custom-made items, perishables), so
`retail_service_policy_exceptions` is a real mechanism.

What makes it safe is the SOURCE column.
`RETAIL_POLICY_EXCEPTION_SOURCES` is `statutory_instrument | mercaria_policy` and
`RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES` names six a supplier could supply —
**disjoint, gated by a test and by a CHECK**. A supplier's narrower returns
policy has no value it could be recorded under, so it cannot reduce a customer
right by being written down, whatever a service does.

Beside that: two names by CHECK (`reviewed_by <> requested_by`), a mandatory
legal basis, immutability once published, and one LIVE exception per (market,
category) so two operators converge rather than doubling it.

**The gap, stated:** an order line records the LISTING it was bought from and
not its category, so resolving the goods' category ancestry needs the catalogue,
which this domain deliberately does not import. `retailCategoryIdsOf` therefore
returns an empty set today and no exception matches. **This is the one place in
the domain that fails OPEN**, and the direction is deliberate: an exception
REMOVES a consumer right, so failing closed here would refuse buyers a remedy on
the strength of a lookup nobody has built. The publication surface, the review,
the immutability and the disjoint vocabulary are all real and tested; what is
missing is the join, and it belongs with whoever gives `order_items` a category
snapshot.

---

## Eligibility is derived, three-valued, and every refusal names a next action

`deriveRetailServiceEligibility` is pure, total, takes its clock as a parameter
and has **no member for a supplier state, a supplier credit, a wholesale cost or
a supply agreement** — the `SourcingCandidateFacts` device from #122, applied to
a consumer right.

It is DERIVED and never stored, the `deriveNativeCheckoutEligibility` divergence
from the one-verdict rule, and for #121's reason: the inputs sit on tables this
domain does not own, so a stored copy would go stale in the direction that
ADMITS a request the policy refuses.

`ineligible` beats `evidence_needed` beats `eligible`, and the ORDER of the
refusals is load-bearing — most structural first, so a buyer is never told "your
window closed" about an order that was never a retail order.

Two pairs are deliberately kept apart:

- **`not_yet_delivered` vs `window_closed`.** One says *wait*, the other says
  *too late*. Collapsing them is how a buyer waiting for a parcel is told their
  return window expired.
- **`already_dispatched` vs everything else.** It is in
  `RETAIL_REASONS_OFFERING_RETURN`, so a client can say *"too late to cancel —
  open a return"* from a code rather than by matching a message string in one
  locale.

**Evidence is asked for LAST**, so a buyer past their window is never asked to
photograph goods they are going to be refused anyway.

---

## What Mercaria can actually deliver, and what it says instead

`RETAIL_CUSTOMER_OUTCOMES` has eight members because #127's warranty section
asks the case to be *capable of representing* repair, replacement, price
reduction and refund — and because "the buyer asked for a repair and got a
refund" is a fact the record has to be able to state.

`SUPPORTED_RETAIL_CUSTOMER_OUTCOMES` has five. The three that are missing —
`replacement`, `repair`, `redelivery` — all mean *send the buyer another physical
item*, and each needs a SECOND purchase order against the same customer order and
the same supplier. #124 derives a purchase order's idempotency key as
`po:<orderId>:<supplierId>`, deliberately, because that pair is what makes a
redelivered success, a reclaimed lease and an operator retry converge on ONE
purchase order. **A replacement is therefore a key #124 owns, not a function
missing here.**

The refusal is at DECISION time and names the outcome, so nobody is told "yes, a
replacement" and then "actually a refund" a week later — #110's `replacement`
decision and #83's `role_email` before it.

**#127's own sentence is why this is stated out loud rather than papered over:**
*"Mercaria must not advertise a warranty period it cannot operationally
support."* A refund-shaped remedy is always available and is never worse for the
buyer than the remedy it replaces — and under EU conformity law a consumer
offered neither repair nor replacement within a reasonable time is entitled to
exactly this.

---

## Refunds

`refund-bridge.ts` is the ONE place this domain moves money, and it reimplements
nothing:

| #127 refund rule | Where it already lives |
|---|---|
| 1 — provider-neutral operation | the `payment_refunded` outbox row (#49) |
| 2 — from the immutable order and prior refunds | `allocation.ts`, over `orders` and `sumRefundedShopAmount` |
| 3 — back to the original rail | the adapter has no destination parameter |
| 4 — item, shipping, tax and discount explicit | `RetailRefundAllocation`'s four members |
| 6 — do not wait for supplier reporting | nothing in the customer half can read a recovery |
| 8 — pending, failed, reversed | `refunds.provider_state`, read by the reconciler |

### It does NOT call `refund.service.process`, and that is not a shortcut

That function is store-scoped — `process(storeId, …)`, and every read it makes is
`…InStore`. A `mercaria_retail` order has NO store: `orders.store_id` is NULL on
a `platform` order by CHECK (#123). So the store-scoped path cannot reach a
retail order in any code path, for any actor.

#123 already established the alternative for exactly this reason: its
compensating refund writes the commerce record with `insertRefund` and enqueues
`payment_refunded` in ONE transaction. This is the SAME shape rather than a
second one, because both are the commerce record committing before the rail is
called (ADR 0001 D7) — the rule that makes a slow rail unable to refuse a refund
Mercaria authorised.

### Restock is ALWAYS false, structurally

#127 refund rule 7 is *"restock only when Mercaria owns inventory; supplier
return state does not mutate native inventory"*. A retail line reserved no local
inventory (ADR 0004 D5), so there is nothing to put back — and **no module in the
domain imports an inventory function at all**, which the isolation gate asserts
over every file rather than over a half. `restockedAt` is left absent rather than
stamped: stamping it would tell a merchant surface that units returned to a shelf
that never held them.

### The allocation, and why the split is explicit

A single total cannot say whether DELIVERY came back, and whether delivery comes
back is the difference between a cancellation and a return in every consumer
regime there is. So the four components are separate, `discountMinor` is stored
NEGATIVE so a caller cannot add it by mistake, and
`retailRefundAllocationTotal` is the one place the sum is written.

A WHOLE line is computed as the whole line (three thirds of 1000 is 999); a
PARTIAL line prorates with the item side FLOORED and the discount side CEILED, so
both roundings move the net downwards. **The residue stays with Mercaria, because
over-refunding is the direction that cannot be corrected without asking a buyer
for money back.**

Delivery comes back on a cancellation and on a SELLER-FAULT return
(`RETAIL_DELIVERY_REFUNDING_KINDS`), and not on an ordinary change of mind. A
buyer sent the wrong item did not choose to send a parcel back, and charging them
outbound carriage for Mercaria's mistake is the shape of refund that generates a
chargeback.

### Three layers stop a double refund, and none covers the others

1. **The quantity cap** (`insertRetailServiceRequest`, order items locked
   `FOR UPDATE`) stops two DIFFERENT requests claiming one unit.
2. **The partial unique on `(order_id, kind)` over the open states** converges
   two attempts at one request.
3. **`refunds.idempotency_key`**, derived from the REQUEST, stops one decided
   request paying twice.

Plus the arithmetic ceiling: `grand_total − already_refunded`.

The cap is mutation-tested — removing it turns exactly one realdb case red and
names it.

---

## Return cases

One internal case per request whose kind brings goods back. `retail_return_cases`
holds the coarse lifecycle; the QUANTITIES live in an append-only trail, because
#127 return rule 10 is *"prevent the same quantity from being returned or
refunded twice"* and a mutable `received_quantity` column is the mechanism by
which it is not prevented — two concurrent scans both read three and both write
six.

`RETAIL_RETURN_CONSUMING_DISPOSITIONS` names the ONE disposition that consumes a
unit's returnability — `shipped` — because everything after it describes the same
units arriving, being looked at and being accepted or refused. Capping `received`
against the authorization instead would refuse a supplier reporting receipt of
units a buyer over-declared, which is a real event that has to be recordable.

> **The convergence check runs BEFORE the cap, and the order is load-bearing.** A
> redelivered supplier event carries the same key AND the same quantity, so
> checking the cap first counts the movement the first delivery already recorded
> and refuses the repeat — turning an ordinary at-least-once delivery into an
> error, which is the opposite of what the key exists for. **The real-server
> suite failed on exactly this before the reorder**; nothing mocked would have.

### The label is a SEAM and it fails closed

#127 return rule 6 permits exactly two sources: a supplier RMA label and an
approved carrier. **No registered supplier adapter declares
`return_authorization`** (Printful does not — #119 §4 records that Printful
returns are a claim process rather than an API RMA), and Moovo reverse transport
is #159 and unbuilt. So `label_source` is `unavailable`, `label_reference` is
NULL, and the buyer's view says `labelAvailable: false` rather than showing a
download that 404s.

Mercaria composing an address or a label itself is precisely what rule 6 forbids
and what #126's logistics gate fails the build over.

### The refund fires on the buyer's SHIPMENT, not on the supplier's inspection

#127 return rule 9 permits customer refund timing to be separate from supplier
inspection *"when law or policy requires earlier action"* — and it does. EU
withdrawal requires reimbursement at the latest when the goods come back OR when
the consumer supplies proof of return. So the trigger is a fact about the BUYER,
not the diligence of a warehouse.

#110 made the opposite choice for a marketplace return and was right to: there
the refund also RESTOCKS, so refunding before the goods are back would put units
on a shelf that are still in a parcel. A retail line restocks nothing, so the
reason for waiting does not exist here.

---

## Warranty

`retail_warranty_cases` carries all twelve facts #127 asks it to be capable of
representing. Two are worth naming:

- **`replacement_purchase_order_id` has no writer**, for the reason above. The
  column exists so the case can represent one; placing one is a change #124 owns.
- **`repeat_failure_count` is the only counter in the domain.** It counts across
  CASES on the same goods (EU conformity law escalates on repeated failure of the
  same item), so a case that could only count itself would always read one. It is
  COUNTED at open time rather than incremented — an increment needs a lock and a
  re-read to be correct under two concurrent reports, where a count is exact in
  one indexed statement.

**A safety escalation does not raise a #121 suppression.** Deciding a product
must come off sale is a compliance power on a different allow-list
(`RETAIL_OPERATOR_OXY_USER_IDS`) with four eyes behind it, and a warranty
operator reaching it from here would be that power granted sideways. The
escalation is the SIGNAL; `/internal/retail-eligibility/*` is where somebody acts
on it.

---

## Supplier recoveries

Ten normalized kinds, seven states, and **no ledger account and no ledger
pointer**. ADR 0004 D7 names five retail ledger accounts and four transaction
kinds and assigns them to #128 *together with the code that writes them*, so this
domain CLASSIFIES and #128 BOOKS — the division #123's
`retail_cost_variance_records` already holds, and for the same reason: a domain
that both decides an amount and books it has no independent record to reconcile
against.

`SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS` names the prohibition as VALUES and the
isolation gate scans every file in the domain for a ledger import.

`rejected` is an ordinary terminal state. #127 responsibility rule 4 — *"a
supplier rejecting a credit does not automatically remove a refund or remedy
already owed to the customer"* — is held by that state living on a row no
customer path reads, and by `settleRetailSupplierRecovery` returning nothing a
customer path could use.

**`expectedAmount` is never derived from the customer's refund.** What a supplier
owes Mercaria is the wholesale figure on the purchase order, which an operator
supplies or a credit note states; computing it from what the buyer paid would be
the exact conflation D8.5 forbids.

---

## Chargebacks

`retail_dispute_coordinations` is MERCARIA's decision about what to do while a
card dispute runs — a different fact, with a different writer and a different
reader, from #49's `disputes`, which is what the rail said. Putting a suspension
flag on `disputes` would make the payment domain the authority on a customer
service policy.

While a coordination is `suspended`, `refund-bridge.ts` refuses every refund on
that order and the request records `dispute_suspension` as its completion
failure — visible, retryable, and not a stuck request.

**The word in #127 rule 10 is *unnoticed*.** A refund committed while a dispute
is open is sometimes right: an operator who has read the evidence and decided the
buyer is owed regardless may release the suspension, and the release is
attributable, dated and explained BY CHECK (all three or none). What is forbidden
is the release happening by default, by a sweep, or by nobody.

Rule 2's evidence is not copied here. Fulfilment, tracking, support and return
evidence are all append-only already, in the domains that own them —
`order_status_history`, #126's promise trail, #110's support thread and this
domain's own return case. `evidence_assembled_at` is a boolean instant rather
than a copy of any of it, because a second version of evidence is the one
somebody submits to a card network by mistake.

Rule 3 is held by absence: there is no supplier column and no contact column on
the table, and this domain composes no evidence payload and calls no provider.
Submitting evidence is an operator act in Stripe's own dashboard, which is where
the redaction decisions belong.

**A dispute on a retail order has no transfer to reverse** (ADR 0004 diagram
10): there is no connected seller, so the loss is platform-funded, and a
supplier's fault becomes a B2B recovery that runs separately and never against
the buyer.

---

## Authorization

**The buyer half is #110's, unchanged.** `authorizeBuyerRequest` already composes
#106's `authorizeOrderAccess`, mints an actor nothing outside its own module can
construct (a module-private `unique symbol`), and checks the portal scope and the
step-up freshness. After the credential is resolved there is nothing
retail-shaped about asking for a remedy, so #127 calls it and adds only four
ACTIONS to that module's table.

Two scopes rather than one, mapped per kind by `retailRequestAction`: a
credential granted `cancellations:request` can ask Mercaria to stop a purchase
and cannot open a warranty claim with it, and the reverse.

**The decider half is NOT #110's**, and the difference is real. #110's
`BUYER_REQUEST_DECISIONS` maps each decision to a STORE PERMISSION, because a
marketplace request is decided by the seller who made the sale. A retail order
has no store, so there is no permission to require. Mercaria decides, and there
is a second brand in `services/retail-service-requests/authorization.ts` rather
than a `permission?: never` member on #110's table — a table whose column is
meaningless for half its rows is a table whose next reader gets it wrong.

### No seventh allow-list

| Surface | List | Why that one |
|---|---|---|
| `/internal/payments/retail-service-requests/*` | `PAYMENT_OPERATOR_OXY_USER_IDS` | deciding a remedy moves Mercaria's own money, which is what that list already gates |
| `/internal/procurement/retail-service/*` | `PROCUREMENT_OPERATOR_OXY_USER_IDS` | it is the only surface that discloses a wholesale figure or an RMA reference, and that list exists for "reading what Mercaria pays its suppliers" |

Splitting them is what makes #127's *"side by side without conflating them"* a
property of the ROUTERS rather than of a projection somebody has to remember to
filter. Every write on both drives an existing idempotent path: there is no "set
this request completed", no "override this outcome", no "attach this refund id"
and no delete.

---

## #110 no longer answers a retail order, and that is a clean cut

`resolveCancellationEligibility` and `resolveReturnEligibility` now refuse a
`mercaria_retail` order by name (`retail_order`), checked FIRST.

It is a fix rather than a restriction: #110's decision path runs on
`requireStorePermission` against the order's STORE, and a `platform` order has
none — so a #110 request filed against a retail order would have sat forever with
nobody able to decide it. One home per order, and both directions are refused by
name.

---

## Notifications

Eight new `GuestPortalMessageKind` values for #127's twelve items, and the
arithmetic is deliberate. Four already have a kind: *"evidence or action
required"* is `buyer_action_required`, and the three refund states are
`refund_pending` / `refund_completed` / `refund_failed`. Retail-specific
spellings would be four more templates saying the same sentence and four more
places a copy fix has to land.

**Item 8, "replacement dispatched", has NO kind and that is not an oversight.** A
replacement is not a remedy Mercaria can deliver, so a message announcing one is
one that could never truthfully be sent.

Every function returns `void` — the `emitAnalyticsEvent` device — so a
notification failure cannot roll back a refund a buyer is waiting on, and a
caller who tried to await one would get a `tsc` error. Nothing is sent to an Oxy
buyer: `enqueueGuestMessage` looks the group's `guest_checkouts` row up and
returns `false` when there is none, and an authenticated buyer's transactional
channel is Oxy's own notifications.

**No message names a supplier, and none can** — the templates take only the order
line and the portal URL, so there is no parameter a supplier name could arrive
in.

> **Nothing is DELIVERED today.** #108's transport registry is empty by design
> and Mercaria has no outbound mail. Every message row is created, kept and
> marked `transport_unconfigured`, visibly; the requests themselves work.

---

## Configuration

```
RETAIL_SERVICE_REQUESTS_ENABLED=true    # buyer-facing WRITES; a 503, never a 403
RETAIL_SERVICE_RECONCILER_ENABLED=true  # the settlement sweep LOOP
RETAIL_SERVICE_RECONCILE_INTERVAL_MS=60000
RETAIL_SERVICE_RECONCILE_BATCH_SIZE=50
RETAIL_SERVICE_RECONCILE_GRACE_MS=30000
```

Neither lever gates a durable record. `RETAIL_SERVICE_REQUESTS_ENABLED` is a 503
rather than a 403 on purpose (#110's decision, same reasoning): this deployment
DOES do retail returns, it has temporarily stopped taking new ones, and retrying
later is the client's correct response. Reads, decisions, refunds, return cases,
warranty cases, supplier recoveries and every request already filed are
unaffected.

**Neither is `MERCARIA_RETAIL_ENABLED`, and this domain never reads it.** #127
acceptance 8 is *"existing cases remain operable after new retail checkout or
supplier integration is paused"*, and the isolation gate fails the build if any
module here learns to read `config.retail` or a supplier account's `killed`
state.

---

## Incident runbook

**A request is stuck in `in_progress`.** Read
`GET /internal/payments/retail-service-requests/:requestId` — the timeline shows
whether `refund_committed` fired. If it did, the commerce record is committed and
the rail is what has not answered; `POST …/complete` re-reads and advances, or
leaves it. `completion_failure` names why when it is not the rail:
`dispute_suspension` means an open chargeback is suspending the refund,
`order_state_changed` means the order moved underneath the decision, and
`refund_refused` means #49's own rail failure — which is where the money question
lives.

**A buyer says their refund is suspended.** `GET
/internal/payments/retail-service-requests/:requestId` shows the coordination.
Releasing it is `POST /internal/payments/retail-disputes/:disputeId/release-suspension`
with a reason, and the reason is stored — a refund issued while a dispute runs
must be a decision somebody made.

**A supplier will not authorise a return.** The case sits in
`authorization_unavailable` and the buyer's remedy is unaffected. The recovery is
a `rejected_claim` on `/internal/procurement/retail-service/requests/:id`, which
is Mercaria's loss to absorb — never the buyer's.

**A return parcel was lost.** Record a `lost_in_transit` movement on
`/internal/procurement/retail-service/requests/:id/return-movements`. The trail
then says "shipped four, received none", which is #127 return rule 12's
escalation as two rows rather than as an absence.

---

## Production-readiness checklist

- [ ] `PAYMENT_OPERATOR_OXY_USER_IDS` populated — without it the customer-side
      operator surface is not mounted (404), which means nobody can decide a
      remedy.
- [ ] `PROCUREMENT_OPERATOR_OXY_USER_IDS` populated — same, for the supplier
      half.
- [ ] A transport registered for `guest_portal_messages` (#108's seam). **Until
      then no buyer is told anything.** The requests themselves work.
- [ ] `RETAIL_SERVICE_REQUESTS_ENABLED` reviewed. It defaults ON, because a
      deployment that sells retail owes its buyers a way to cancel and return.
- [ ] The category-exception join (see §"Category exceptions") — until
      `order_items` carries a category, no exception matches and the domain fails
      OPEN there.

---

## Seams left, each a named contract that fails closed

- **#124 — the supplier RMA.** `supplier-rma.port.ts` answers `unavailable` with
  `capability_not_declared` until an adapter declares `return_authorization` and
  a bridge is registered through #124's `provider-call.ts` chokepoint. One
  function closes it.
- **#128 — the ledger.** Every recovery is classified and none is booked. The
  five accounts and four transaction kinds are #128's *together with the code
  that writes them* (ADR 0004 D7). **#127's acceptance 7 — "customer refunds and
  supplier credits reconcile through #128" — is therefore NOT satisfiable here**
  and is not claimed: the inputs exist, the reconciliation does not.
- **#126 / #156–#159 — Moovo.** Reverse transport, labels and delivery
  confirmation. Their absence is why `label_source` is `unavailable` and why the
  possession anchor needs its grace.
- **#129 — the buyer UX.** Every projection, deadline, next-action code and copy
  key it needs exists; nothing renders them.
- **#121 — a suppression.** A safety escalation is a signal and not a
  suppression, for the allow-list reason above.
- **Oxy service credentials.** Declared evidence carries no digest and no scan.
  The same gap `services/moderation/` and #110 both document.
- **A replacement.** `po:<orderId>:<supplierId>` (#124) makes a second purchase
  order under one order and one supplier unrepresentable, so `replacement`,
  `repair` and `redelivery` are representable outcomes that are refused by name
  at decision time.
