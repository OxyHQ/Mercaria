# Supplier-fulfilled Mercaria-retail fulfilment (#126)

One coherent Mercaria customer order while an approved supplier prepares or
dispatches the goods and **Moovo owns the physical logistics** — carrier
booking, labels, tracking, delivery estimates, exceptions and reverse transport.

This document is the reference for what Mercaria owns of that arrangement. Its
companion halves are `docs/purchase-orders.md` (#124, how Mercaria BUYS),
`docs/supplier-preflight.md` (#122, what a supplier says before Mercaria
charges) and `docs/payments.md` §"Mercaria-retail on the card rail" (#123, how a
retail order is placed and paid for).

The binding decisions are ADR 0004 (`docs/adr/0004-mercaria-retail-dropship.md`),
specifically D2.6 (customer rights are Mercaria's whatever the supply agreement
says), D2.7 (the supplier receives fulfilment data only), D2.8 (disclosure),
D9.4/D9.6 (procurement-failure communication, split shipments) and D9.9 (Mercaria
owns the delivery promise).

---

## What is built, and what is blocked

**#126 depends on four issues that are OPEN and unbuilt** — #156 (Mercaria's
canonical Oxy service client for Moovo), #157 (the Moovo-backed fulfilment
aggregate and read projection), #158 (the durable idempotent logistics-event
inbox) and #159 (routing quotes, bookings, labels and return transport through
Moovo) — plus the Moovo platform work they depend on (`OxyHQ/Moovo#20`, #28–#30).

Those four ARE the Moovo half. So this issue shipped everything that does not
need them, and left every Moovo-facing call as a named seam that refuses
unconditionally and says which issue owes it. Nothing here is a stub that
answers plausibly; the whole point of `services/retail-fulfilment/moovo.port.ts`
is that a seam which answers plausibly is indistinguishable from a working one
until a customer is waiting for a parcel.

| #126 acceptance criterion | State |
|---|---|
| 1. A successful supplier PurchaseOrder progresses into a coherent Mercaria order with Moovo-backed logistics | **Mercaria half built** — the order-role snapshot, the fulfilment intent, the allocation and the promise are written in the order's transaction. The Moovo half needs **#157/#159**. |
| 2. Mercaria contains no carrier adapter, tracking poller or carrier-state mapping | **DONE and gated** — `retail-logistics-isolation.test.ts`, seven scanned walls plus a walk of the real tables, with a vacuity floor and a mutation self-test. |
| 3. Split/partial shipments map exact order quantities without duplication or loss | **DONE** — the allocation cap, the replacement exception, the cancellation release and the reconciliation reader, all pinned against a real server. |
| 4. Supplier-controlled shipping becomes one idempotent tracking-only Moovo transport | **Mercaria half built** — the deterministic source reference, the mode, the request composer. The registration needs **#159**. |
| 5. Moovo-controlled shipping books idempotently and supplies label/tracking without exposing credentials | **Mercaria half built** — the contractual grant, the mode choice, the request composer with its disclosure gate. The booking needs **#159**. |
| 6. Authenticated and guest buyers receive equivalent safe order/tracking information | **Blocked on #157/#162** — there is no projection to render. The half that is done: nothing in this domain reads a buyer origin, so there is nothing guest-shaped to diverge. |
| 7. Customer-facing surfaces identify Mercaria as seller and hide procurement economics | **Data half built** — the snapshot names Mercaria and the protected columns withhold the procurement handles. The rendering is **#162/#129**. |
| 8. Duplicate/reordered supplier and Moovo events produce deterministic projections and notifications | **Blocked on #158.** The resolution step is built (`findRetailFulfilmentIntentBySourceReference`). |
| 9. Delay, loss, wrong-item, return-to-sender and reverse-transport cases have operational paths | **Blocked on #157/#159/#127** — nine of the twelve exception cases are questions about Moovo state. |
| 10. Rolling back new checkout preserves procurement, Moovo tracking, notifications and customer access | **DONE by construction** — no module here reads `config.retail`, and `retail-checkout-isolation.test.ts` already fails the build if a post-entry module does. |
| 11. End-to-end tests cover both fulfilment modes, partial shipment, delayed, shipped, delivered, return and exception flows | **Partial** — both modes, partial and split allocation, replacement and cancellation are covered. Shipped/delivered/return/exception need **#157/#158** to have anything to observe. |
| 12. #124/#125 and this issue share ONE supplier-procurement boundary | **DONE** — every fulfilment intent NAMES a #123 procurement intent; this domain has no supplier adapter, no purchase order and no shipment table of its own. |

---

## The shape

```
packages/backend/src/
  db/schema/retailFulfilment.ts          4 tables
  db/retailFulfilment/                   1 repository
  services/retail-fulfilment/
    customer-terms.ts                    the four consumer windows, versioned
    fulfilment-mode.ts                   who books — two pure functions
    order-role.service.ts                what checkout writes, in its transaction
    delivery-promise.service.ts          the append-only promise trail
    state-separation.ts                  the seven axes
    moovo-request.ts                     what Moovo receives, allow-listed
    moovo.port.ts                        every Moovo call — refuses today
```

---

## The immutable order-role snapshot

#126 lists ten facts every retail customer order must snapshot. **Six of them
already have immutable homes and are deliberately not copied**, because a second
immutable record of one fact is exactly the failure the snapshot exists to
prevent — and the copy nobody reconciles is the one a customer finds on a
receipt.

| #126 item | Where it lives |
|---|---|
| 1. Mercaria as customer-facing seller | `retail_order_role_snapshots.seller_of_record` (one-member CHECK) + the legal entity |
| 2. Supplier-fulfilled disclosure (#117) | `supplier_fulfilment_disclosure_key` + `_version` |
| 3. Exact product, variant, quantity, accepted price | `order_items` — append-only, condition columns refusing UPDATE since #90 |
| 4. Tax, shipping charge, accepted delivery promise | `orders.totals` + `retail_delivery_promises` (`accepted_at_checkout`) |
| 5. Agreement, procurement offer, cost quote, policy versions | `retail_procurement_intents` and its append-only lines (#123) |
| 6. PurchaseOrder references hidden from public DTOs | `retail_procurement_intents.purchase_order_id`, plus `PROTECTED_COLUMNS` |
| 7. Fulfilment mode and who controls booking | `retail_fulfilment_intents.permitted_fulfilment_mode` / `fulfilment_mode` |
| 8. Cancellation, withdrawal, return and warranty terms | the four windows plus `customer_terms_version` |
| 9. Guest/authenticated buyer contact path | DERIVED from `orders.buyer_origin` (#106) — see below |
| 10. Moovo quote/reference facts, only after they exist | `moovo_transport_request_id` / `_registered_at`, write-once |

**The buyer contact path is derived, never stored.** `orders.buyer_origin` plus
the presence of a `guest_checkouts` row answers it completely, so a column here
would be a second answer that could disagree with the one an access check uses —
the `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
rule, and the safe direction: the copy that goes stale is the one a notification
would be sent to.

**The four windows are stored as NUMBERS, not only as a version pointer.** A
pointer is only as durable as the code that can still resolve it, and a buyer
asking in two years what their return window was must be answered from the
order. The version travels beside them so the wording can be produced too.

**The terms are code constants, not a table** (`customer-terms.ts`). They are not
policy an operator publishes; they are what Mercaria's shipped customer terms
SAY. A table would let somebody publish a withdrawal window no terms document
contains, and the row would then be snapshotted onto real orders as the terms
those buyers agreed to. Changing one is a code change, a new version string and a
review — which is what changing consumer terms should cost.

---

## Fulfilment modes: permitted is not chosen

```
Mode A  moovo_controlled     Moovo books the fleet/carrier and produces the
                             label; the supplier dispatches against it.
Mode B  supplier_controlled  The supplier books its own carrier; Mercaria
                             registers a TRACKING-ONLY transport with Moovo.
```

**One column names who books.** #126 lists "fulfilment mode and who controls
booking" as one item, and it is one fact — a separate `transportController`
column would be a second spelling of the same answer.

**Two columns for two clocks.** `permitted_fulfilment_mode` is CONTRACTUAL,
knowable at checkout and frozen there. `fulfilment_mode` is OPERATIONAL and
cannot be known until a supplier has accepted and confirmed package readiness
(#126 Mode A step 2). One column would have to either freeze a mode nobody could
yet know or leave the contractual grant rewritable after the sale. Two make the
containment a real intra-row CHECK — the only kind Postgres can enforce — and a
trigger makes the operational one write-once.

**Mode A needs an explicit contractual grant.**
`supplier_agreements.moovo_label_dispatch_permitted` (new, default FALSE) is
separate from `dropship_rights_granted` because they are different permissions:
dropship rights say the supplier may ship to Mercaria's customer under Mercaria's
name, and this says a third party may execute against Mercaria's own carrier
account. A supplier can reasonably hold the first and refuse the second — its
warehouse would have to accept somebody else's collections — so deriving one from
the other puts Mercaria's logistics documents into a warehouse that never agreed
to handle them.

**An undecided mode is never a default.** `chooseFulfilmentMode` returns a union
whose `undecided` branch has no `mode` property, so a caller cannot read "we do
not know yet" as `supplier_controlled` without writing the coercion out loud.
With only Mode A permitted and its preconditions unmet the answer stays
undecided — falling back would grant carriage the agreement withheld, and the
row's CHECK would refuse the write anyway.

**Today Mode A is unreachable and that is stated rather than hidden.** No
supplier adapter reports verified package facts (#124/#125 own that) and no Moovo
port is registered (#156/#159), so `packageFactsVerified` and
`moovoBookingAvailable` are both honestly `false` and every retail order takes
Mode B once its supplier accepts.

---

## Line allocation, and the invariant that matters

`retail_fulfilment_line_allocations` records exactly which units of which
customer line one fulfilment intent covers. #126 fulfilment mapping 1–8 fall out
of that one table plus one rule:

> The sum of ORIGINAL allocations against one order item, over intents that are
> neither cancelled nor superseded, never exceeds that item's quantity.

Cross-row, so no CHECK can hold it. `insertRetailFulfilmentIntents` is the single
writer and refuses before issuing SQL, with the order items locked `FOR UPDATE`
first so two concurrent split dispatches serialize rather than both reading the
same pre-insert sum.

**A REPLACEMENT is outside the cap, in both directions.** It re-ships goods
already allocated, so counting it makes every replacement look like an
over-allocation — and the obvious remedy, raising the cap, makes a genuine
double-ship invisible. Both halves of that exclusion are needed and only the
real-server suite exercises them together; the first implementation had one and
refused every replacement.

**A CANCELLED intent releases its claim**, which is what those statuses MEAN and
what lets a buyer whose first supplier failed be fulfilled by a second.

**The reconciliation reader LEFT-joins**, so a line with NO allocation appears
with zero — the "lost" half of mapping 8. An inner join reports the same tidy
list whether a line is fully allocated or entirely forgotten.

**The pairing between a plan line and an order item is POSITIONAL.**
`buildRetailOrder` maps `plan.lines[i]` to `order_items[i]` in order, so the
allocation composer reads the items back by `position` inside the transaction.
The alternative already in the tree — matching by money amount — pairs two lines
that happen to cost the same, and its own comment says so.

---

## Delivery promises

An append-only trail, not a mutable "current estimate" column. #126 rule 9 is
*never silently rewrite past promises*, and a column that can be overwritten is
precisely the mechanism by which one is; once it has been, there is nothing left
to compare a complaint against.

- **`accepted_at_checkout`** is unique per order, immutable, `guaranteed`, and
  authored only by `mercaria_checkout` — a CHECK, so a supplier cannot author it.
- **A supplier's SLA arrives `advisory`.** #126 rule 5: no code path upgrades a
  promise, so a guarantee cannot arrive by omission. `recordSupplierDeliveryEstimate`
  has no basis parameter.
- **A FAILED refresh is a row.** Rule 6 asks that estimates be marked stale when
  updates fail, and the only way an append-only trail can say "we asked and could
  not find out" is to record the asking.
- **Unknown is absence.** A row whose outcome is not `observed` carries no basis
  and no window — rule 10 held by a CHECK rather than by a display convention.

> **The obvious spelling of that CHECK admits the row it forbids**, and the
> real-server suite caught it: `(outcome = 'observed') = (basis is not null AND a
> window is present)` is SATISFIED by `outcome = 'unknown'` with a window and no
> basis, because both sides evaluate false. It is two biconditionals, not one
> over a conjunction.

**The accepted promise is the SLOWEST line.** An order arrives when its last
parcel does; promising the fastest breaks the promise on every multi-supplier
basket. A line whose supplier stated no window contributes nothing rather than a
zero, so an order none of whose suppliers gave a window records no accepted
promise at all — a real state, not a gap.

---

## State separation

Seven axes, each derived from its own evidence and none from another's
(`state-separation.ts`). `RetailFulfilmentStateInputs` has one member per axis and
no member that feeds two, so no derivation *can* read another axis's evidence.

```
customer_order_payment   supplier_procurement   preparation_fulfilment
transport_projection     return_authorization   return_transport
refund_reconciliation
```

The six examples #126 names are tests, not promises:

1. Supplier accepted does not mean shipped.
2. Label created does not necessarily mean carrier pickup.
3. Carrier delivered does not settle a buyer dispute.
4. Return delivered does not complete a refund.
5. Unknown stays unknown — the `known: false` branch has no `state` property at
   all, so an unknown axis cannot be rendered as a state.
6. Return-to-sender is not cancellation.

**Staleness is derived against the reader's clock**, never stored, so a
projection that stopped being refreshed degrades on its own instead of waiting
for a sweep. An UNPARSEABLE observation time answers `unknown`, not fresh: a
projection of unknown age reading as the freshest thing in the view is the one
answer a surface must never be given.

---

## Privacy and security

| #126 rule | Mechanism |
|---|---|
| 1. The supplier receives only the fulfilment contact/destination the agreement requires | #124's `composeSupplierOrderDraft` reads the purchase order's own redacted snapshot; `SupplierRecipient` has no email member at all |
| 2. Moovo receives only logistics data required for quote/transport | `MoovoTransportRequest`'s TYPE plus `assertMoovoRequestDisclosure`'s runtime walk over an allow-list — two gates that fail differently |
| 3. Guest portal credentials go to neither | no member, no code path; a scanned wall fails the build if this domain reaches `guest_portal_grants` or a `mgp_`/`mgx_` token |
| 4. Mercaria service credentials never reach a supplier or a client | this domain composes no headers and holds no client — #156's client puts the credential in the transport |
| 5. Raw supplier/carrier payloads stay in their owning service | this domain has no payload column of any kind |
| 9. Supplier and Moovo events cannot enumerate unrelated orders | `findRetailFulfilmentIntentBySourceReference` takes a source reference and nothing else, returns one row or none, and has no parameter that could widen it |

`PROTECTED_COLUMNS` gains `retail_delivery_promises.source_ref` (a #122 supplier
quote handle or a Moovo transport id) and both
`retail_fulfilment_intents.moovo_source_reference` / `moovo_transport_request_id`
— a cross-service correlation key for somebody's parcel, which no buyer-facing
DTO may carry. The tracking a buyer legitimately sees comes from Moovo's own safe
presentation (#126 privacy 7, #162), never from either.

---

## Configuration

```
MERCARIA_RETAIL_SELLER_LEGAL_ENTITY=      # the entity named as seller on every retail order
MERCARIA_RETAIL_SELLER_COUNTRY=           # ISO-3166-1 alpha-2 of that entity
```

Both are demanded by `MERCARIA_RETAIL_ENABLED`'s half-configuration rule
(ADR 0004 D13), because a role snapshot is written in the buyer's own transaction
and its CHECK refuses an empty entity name — so a deployment that cannot name its
seller would fail at the moment a buyer paid rather than at boot. Neither is
defaulted: defaulting the country to `ES` would let a deployment that never
configured one print `ES` on every receipt, which is wrong in a way nobody
notices until a consumer authority asks.

**#126 adds no feature flag of its own.** A rollback of new retail checkout must
leave placed orders' fulfilment intact (acceptance 10), and the existing
`retail-checkout-isolation.test.ts` already fails the build if a post-entry
module learns to read `config.retail`.

---

## Seams left to their owners

Each is a named contract that fails closed, never a stub that answers.

- **#156** — the canonical Oxy service client for Moovo. Until it registers a
  port, `moovoLogisticsPort()` is `unregisteredMoovoLogisticsPort` and every
  operation answers `{outcome: 'unavailable', reason: 'client_not_registered'}`.
- **#157** — the fulfilment aggregate and its read projection.
  `MoovoTransportProjection` is the READ contract, published as a TYPE so the
  state derivation and the customer projection can be written, tested and
  reviewed before the aggregate exists. **No table here holds a shipment count,
  a package, an event id, a checkpoint or a projection freshness**: a column
  nothing could populate would be a second source of truth for a fact Mercaria
  does not hold.
- **#158** — the durable idempotent event inbox. What #126 owns of it is the
  RESOLUTION step, which is built. There is deliberately no `applyEvent` method
  on the port: publishing one would invite a caller to apply a projection
  Mercaria does not store.
- **#159** — quotes, bookings, labels and return transport. Four of the port's
  five operations.
- **#127** — cancellations, returns, RMAs and refunds. `requestReturnTransport`
  is defined; whether a return is AUTHORIZED is #127's decision and this domain
  has no column for one.
- **#162 / #129** — the buyer, guest and support tracking experience.
- **#124/#125** — verified package facts (dimensions, weight, origin, readiness),
  which Mode A requires and which no adapter reports today.
- **The transactional notifications** #126 §"Transactional notifications" lists.
  Six of the nine are Moovo milestones (#158's reducer emits the intent). The
  procurement half — pending/confirmed/failed — is reachable through #124's
  `procurement-outcome.port.ts`, which today has ONE registered consumer (#123's
  compensating refund); adding a second needs that port to become a fan-out, and
  Mercaria still has no outbound mail transport (#108's registry is empty by
  design). Building a notification that cannot be delivered would be the stub
  this domain refuses everywhere else.
- **The operator surface** #126 §"Operations and exceptions" asks for. Nine of
  its twelve cases are questions about Moovo state. The three Mercaria-side ones
  — a supplier that accepted and never dispatched, a partial shipment with the
  remainder unavailable, an allocation mismatch — are answerable today from
  `retail_fulfilment_intents_awaiting_transport_idx` and
  `readRetailLineAllocationReconciliation`, and neither has an HTTP reader yet.
  When one is added it belongs on `/internal/procurement/*` behind the existing
  `PROCUREMENT_OPERATOR_OXY_USER_IDS` allow-list — the sixth list, not a seventh:
  the power is the same one #122/#124 already granted.
