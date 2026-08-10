# Zero-profit cost reconciliation (`mercaria_retail`)

How every Mercaria-retail order becomes financially explainable from the
customer charge through the supplier invoice, the fulfilment cost, the refunds
and the final cost — while preserving the binding rule that the retail item has
**zero intended profit and zero markup**. Binding decisions: ADR 0004
(`docs/adr/0004-mercaria-retail-dropship.md`), especially D7 (the ledger and its
zero-profit proof) and D8 (cost variance and the customer adjustment rule).
Issue #128.

**This replaces realized-margin reporting with cost reconciliation.** Positive
variance is not item revenue; negative variance is not a reason to recharge the
buyer. There is no account, column, metric or type in this domain in which a
retail margin could accumulate.

Code: `services/retail-reconciliation/` (the pure equation, the evidence
gatherer, the digest, the composer, the adjustment path, the supplier-credit
path, the variance feedback, the projection, the sweep),
`db/retailReconciliation/` (six repositories),
`db/schema/retailReconciliation.ts` (ten tables), plus six posting builders in
`services/payments/ledger-postings.ts`. Operator surface:
`/internal/retail-reconciliation/*`, behind
`PROCUREMENT_OPERATOR_OXY_USER_IDS`. Schema decisions:
`db/schema/CONVENTIONS.md` §"Zero-profit cost reconciliation (#128)".

---

## The equation, and the sign it uses

```text
final attributable cost
  = final supplier item cost
  + final allowed fulfilment/direct costs
  + applicable customer tax/duty components
  + allowed actual provider/FX costs

cost variance
  = customer amount before explicit Mercaria subsidy
  − final attributable cost
```

Verbatim from #128, and `services/retail-reconciliation/equation.ts` is the only
place either line is written. Money in, a verdict out: no database, no clock, no
configuration and no FX service, which is what lets the four interpretations be
table-tested against worked examples and what keeps a live exchange rate out of a
historical answer.

A **POSITIVE** variance means the buyer paid more than the order cost, so the
surplus is theirs. #120's `classifyRetailCostVariance` computes `actual − locked`
and reads a NEGATIVE number the same way; the two are two subtractions of one
pair, and this domain uses the issue's own spelling because this is where the
number is stored and booked. Both `retail_reconciliations.cost_variance_minor`
and #123's `retail_cost_variance_records.delta_amount` mean "customer amount
minus actual", and a CHECK re-computes each from its own operands.

### The four interpretations

| Variance | Outcome | What happens |
|---|---|---|
| exactly `0` | `cost_recovered_exactly` | nothing is owed in either direction |
| `abs ≤ tolerance`, non-zero | `within_rounding_tolerance` | closed as rounding; the delta is still RECORDED |
| `> tolerance` | `customer_adjustment_required` | one durable obligation to the buyer, recognized in the ledger |
| `< −tolerance` | `mercaria_absorbed` | Mercaria's loss; no surcharge path exists and none may be built |

Exactly zero is checked FIRST and separately from the tolerance, because "orders
reconciled exactly to cost" is #128's first metric and a count that included
rounded-off orders would report a precision the reconciliation does not have.

### Which components enter which side

Every stored amount is a non-negative MAGNITUDE, and which side it enters is
`RETAIL_COMPONENT_ROLES` — a property of the component's meaning rather than of
the number somebody recorded. A signed column would let one writer record a
supplier credit as a negative cost and another as a positive recovery, and both
would balance while meaning opposite things.

| Role | Components |
|---|---|
| `customer_inflow` | `customer_charge` |
| `customer_outflow` | `customer_refund`, `dispute_movement` |
| `mercaria_funded` | `mercaria_promotion_subsidy` |
| `attributable_cost` | `supplier_item_cost`, `supplier_handling_cost`, `fulfilment_shipping_cost`, `tax_duty_liability`, `provider_processing_cost` |
| `cost_recovery` | `supplier_credit` |
| `variance_disposition` | `customer_adjustment_payable`, `mercaria_absorbed_variance` |

The two dispositions are OUTPUTS and are excluded from both sides by the same
map — feeding a disposition back in as if it were a cost is the arithmetic that
would recognize one adjustment twice.

**The customer term is the amount BEFORE the subsidy**, so what Mercaria funded
is added back to what the buyer paid. Netting it out would make a promoted order
look like one that cost less to fulfil.

---

## Zero profit is structural, in five independent places

Each is tested on its own, because any one alone would be a rule to route around.

1. **The vocabulary.** `RETAIL_ACCOUNTING_COMPONENTS` has twelve members and
   `RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS` is a *separate* union of the fourteen
   prohibited things. They are disjoint, so a margin is not a value the equation
   can be handed.
2. **The chart of accounts.** ADR 0004 D7 names five retail accounts and none of
   them is a revenue account. A positive variance can only be credited to
   `customer_adjustment`; there is no `retail_margin_revenue` to credit instead.
3. **The schema.** No column in any of the ten tables is named for a margin,
   profit, markup, padding or retention. `absorbed_variance_alert_bps` is the
   domain's only basis-point column and it decides when somebody is TOLD about a
   loss.
4. **The API.** `assertNoForbiddenAccountingOutput` inspects a policy body and
   refuses a forbidden field BY NAME — an operator who sends `marginTargetBps` is
   told it is a `planned_margin`, not that they made a typo. It is mounted before
   the `.strict()` schema, which answers "no" while this answers "why".
5. **The disposition set.** `RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS` is
   `refund_remaining | keep_open`, with **no** member meaning "retain". An
   adjustment Mercaria kept at finality would be exactly the profit bucket D7
   leaves no account for, so the value that would express it has no
   representation.

`retail-reconciliation-isolation.test.ts` scans all of it with a vacuity floor
and a mutation self-test per detector, and walks the REAL drizzle tables for a
margin-shaped column rather than trusting a list.

---

## The twelve components, and where each comes from

| # | Component | Evidence |
|---|---|---|
| 1 | `customer_charge` | the frozen `retail_procurement_intents.buyer_locked_total` |
| 2 | `supplier_item_cost` | the supplier invoice's net total, less the purchase order's own shipping and duty |
| 3 | `supplier_handling_cost` | the #120 quote's `supplier_handling` components |
| 4 | `fulfilment_shipping_cost` | `purchase_orders.shipping_amount` |
| 5 | `tax_duty_liability` | the quote's `tax_duty` components, plus `purchase_orders.duty_amount` |
| 6 | `provider_processing_cost` | the LEDGER's `processor_expense` for the payment, apportioned across the group |
| 7 | `mercaria_promotion_subsidy` | `retail_cost_quotes.subsidy_amount` |
| 8 | `customer_refund` | every `refunds` row on the order |
| 9 | `supplier_credit` | `retail_supplier_credits`, from #124's credit-note documents |
| 10 | `customer_adjustment_payable` | an OUTPUT of the equation |
| 11 | `mercaria_absorbed_variance` | an OUTPUT of the equation |
| 12 | `dispute_movement` | `disputes` with outcome `lost` |

Three of these deserve their reasoning stated.

**The invoice is authoritative on the TOTAL; the purchase order is the only
BREAKDOWN.** #124's `purchase_order_documents` records an invoice total and its
tax and nothing else, while `purchase_orders` carries items/shipping/tax/duty. So
shipping and duty are attributed as the purchase order named them and the
difference between the invoice's net total and the purchase order's own lands on
the ITEM cost as the residual — which is where a supplier's re-priced goods, an
extra handling fee and a corrected quantity actually show up.

**The provider fee comes off the LEDGER, not off `payments`.** `payments` has no
fee column by design: the fee goes straight to `processor_expense` when the
charge is booked (ADR 0001 D5), so the book is where the ACTUAL lives and reading
it back is what trues the estimate (ADR 0004 D8.7 case a). It is apportioned
across every order in the checkout group with `settlement-shares.apportion`, the
house largest-remainder rule, because the fee is charged once per PaymentIntent
and a retail order in a three-order cart must not carry all of it.

**The B2B tax on the supply TO Mercaria is excluded.** Reverse-charge VAT is
input-deductible (ADR 0004 D2.4) and is not a cost of the sale; including it
would overstate the attributable cost and manufacture an absorbed variance on
every cross-border order. The CUSTOMER's tax is a different number and is
component 5.

---

## A missing cost is never a zero cost

`completeness` is two-valued and `outcome` is present EXACTLY when it is
`complete` — a biconditional CHECK — so a reconciliation that could not find the
supplier invoice has no verdict at all rather than a confident one built on an
assumed zero. #128 acceptance 7.

The verdict type says the same thing: the incomplete branch of
`ReconciliationVerdict` has no `outcome`, no `costVarianceMinor` and no
`finalAttributableCost` PROPERTY, so a caller cannot read a confident number off
an incomplete answer. That is `deriveOfferDelivery`'s device applied to money,
and the number it prevents is large: an unevidenced supplier cost summed as zero
produces the whole customer amount as a surplus and a refund the buyer was never
owed.

Seven of the twelve exception kinds BLOCK a verdict
(`RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS`). The other two —
`absorbed_variance_over_threshold` and `recurring_quote_inaccuracy` — are raised
ABOUT a completed reconciliation and must not make it incomplete.

A blocking condition is also passed IN rather than inferred from a missing
component, because "the supplier charged no handling fee" and "the supplier
invoice has not arrived" produce exactly the same absence and mean opposite
things. Only the gatherer, which knows which documents it looked for, can tell
them apart.

---

## Historical truth is never revalued

- **Every amount is stored in the currency the SOURCE stated it in**, beside its
  conversion into the accounting currency and the five-column `FxRateSnapshot`
  that produced it — present EXACTLY when the currencies differ, a
  biconditional, and naming the pair it converted.
- **The accounting currency is the buyer's PRESENTMENT currency.** Every other
  candidate needs a conversion this domain is not allowed to make: the customer
  amount was frozen in presentment at checkout and may never change, so
  expressing the equation in anything else would make the one immutable number in
  it depend on a rate. The quote's components already carry a presentment amount
  beside their source amount with the rate between them, so the rates needed to
  bring a supplier's figures in are the ones the sale was priced at.
- **Every conversion reuses a STORED rate.** The rate table is built from the
  quote's own component snapshots and from the payment's captured
  presentment→platform rate. A pair nothing recorded is
  `currency_unconvertible`, an operator exception — never a call to `fx.service`,
  which a scanned gate keeps unimportable here.
- **A conversion read backwards restates its own direction.** An inverse rate is
  emitted as a snapshot naming the pair it was APPLIED to, because
  `retail_reconciliation_components_fx_pair_check` refuses one naming the
  opposite.

---

## The tolerance is tiny, currency-aware and versioned

`retail_reconciliation_tolerances` carries one row per currency of one policy
version: a `tolerance_minor` and an `automation_floor_minor`.

A single bare integer would mean five hundredths of a euro and five
hundred-millionths of a FAIR — the same value describing two unrelated
quantities, with the FAIR reading so small that every conversion residue would be
reported as material variance, and the EUR reading so large in JPY (which has no
minor unit at all) that five yen of real difference would vanish.

`RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR` is derived from `CURRENCY_PRECISION`
as five hundredths of a major unit per currency, and the ceiling is a CHECK
rendered from it as a `CASE`. **`else -1` is not decoration**: a CASE with no
matching branch yields NULL, a comparison against NULL is NULL, and a CHECK
rejects only FALSE — so the obvious spelling would SATISFY the constraint for
exactly the currency it failed to cover. That is the `array_length` trap wearing
different clothes.

Widening the tolerance is therefore a schema change under review, not a
configuration. **It cannot become a profit bucket**: the delta is RECORDED
whatever the tolerance says, and there is no disposition in which retained
residue could sit.

The **automation floor** is a different number and is deliberately bounded much
more loosely: it decides when Mercaria refunds a surplus WITHOUT being asked (ADR
0004 D8.2's 1.00 EUR equivalent), and a sub-floor surplus is still recorded, still
owed and still refundable on request. It bounds automation, never classification.

---

## The customer adjustment path

1. **One durable record per order + reconciliation revision.**
   `UNIQUE(reconciliation_id)` is #128 acceptance 3's "exactly one obligation"
   held by the database: a retry converges on the row that exists, and only a
   LATER revision finding a DIFFERENT surplus creates another, chained through
   `superseded_by_id`.
2. **The refundable difference is net of PRIOR adjustments** — a later revision
   that finds the same surplus an earlier one already paid must not pay it twice.
3. **A partial Stripe refund where supported**, through #49's existing domain:
   the commerce record and its `payment_refunded` outbox row commit in ONE
   transaction and the rail is called from that row's handler, unchanged.
4. **`payable_recorded` when the rail cannot serve it**, with a bounded
   operator-visible reason and a retry that drives the same idempotent path.
   `refund_failed` is terminal for the ATTEMPT and not for the obligation.
5. **The buyer is notified without needing an account** — `cost_adjustment_issued`
   through #108's portal queue, deduped on the adjustment id. Its own kind rather
   than `refund_pending`, because a recipient who reads "your refund is on its
   way" for something they never requested has been told the wrong thing about
   their own order.
6. **Nothing is restocked.** No quantity, line or variant column exists in the
   table, the refund is written with no line items, and a scanned gate keeps the
   inventory writers unimportable.
7. **No duplicate refund**, in three independent places: the obligation's unique
   index, `attachAdjustmentRefund`'s compare-and-swap, and the refund's DERIVED
   idempotency key (`retail-adjustment:<adjustmentId>`).
8. **The original order amount and quote are untouched.** This domain writes no
   order column and no quote row.
9. **Non-refundable provider cost is recorded explicitly** on the adjustment (ADR
   0004 D8.7 case c), so an operator sees the shortfall rather than inferring it.

**Guest and authenticated buyers have the same rights.** Nothing in
`adjustment.service.ts` reads a buyer origin, a guest session or an Oxy account;
the obligation is keyed on the ORDER and the refund goes back down the original
rail. What differs is the notification CHANNEL, which is #108's decision.

---

## Negative variance

Mercaria absorbs it. There is no surcharge path, and ADR 0004 D8.4 forbids
building one — `retail_cost_variance_records` and `retail_reconciliations` both
make a negative amount owed to a buyer unrepresentable by CHECK.

**It books nothing**, and the absence is the decision: the costs were booked as
`procurement_expense` when they were incurred, and the absorption is visible as
D7 proof 2's strict inequality between recovery and cost. A posting for it would
be an entry against itself.

**Alerting** is an `absorbed_variance_over_threshold` exception rather than a log
line, raised when the shortfall exceeds the GREATER of the policy's basis-point
share and its floor — a percentage alone is silent on a small order and a fixed
amount alone is silent on a large one. An exception has a queue, a resolution and
a person who can say they have looked at it; a log line has none of those.

**Pausing affected offers is #125's mechanism, reached rather than
reimplemented.** `retail_pilot_stops` already raises from a published threshold,
converges on a live-unique per (cohort, metric, scope, subject) and is lifted
attributably. Two of its thirteen metrics — `negative_realized_margin` and
`supplier_credit_mismatch` — were left with no producer precisely so #128 could
supply one. `variance-feedback.ts` produces MEASUREMENTS and never a stop, and it
emits a measurement only when it genuinely counted something: a zero would turn
"we have not looked" into "we looked and it is fine", which is the vacuous
monitor the pilot's `unmeasured` outcome exists to expose.

---

## Supplier credits

`retail_supplier_credits` links every credit to its purchase order, the supplier
invoice it reverses and the affected customer order.

- **`return_linked`** accompanies a customer return. It reconciles against the
  return lifecycle and does NOT reduce an already-promised refund — which falls
  out of both movements being represented: the refund lowers the customer side
  and the credit lowers the cost side by the same amount, so the variance is
  unchanged. A `return_linked` credit whose customer refund has not been recorded
  BLOCKS with `missing_customer_refund_record`, because counting it alone would
  create a second refund for money that has already gone back.
- **`cost_reduction`** is unrelated to a return and lowers the final attributable
  cost on its own, which under the zero-profit policy is exactly what may create
  a customer adjustment.
- **`unattributable`** is RECORDED with an open `unlinked_supplier_credit`
  exception. Guessing would either invent an adjustment on the wrong order or
  hide one that is owed; losing it would lose money Mercaria is owed.
- **Duplicates are idempotent** on `claim_key` =
  `<purchaseOrderId>:<providerDocumentId>`, composed from what the credit IS
  about and never from when it was seen.
- **A credit cannot be classified as revenue**: the only posting it can produce
  debits `supplier_prepaid` and credits `procurement_expense`, and no revenue
  account is reachable from `supplierCreditReceived`.

Recording and booking happen in ONE transaction, which is why
`retail_supplier_credits` can be strictly append-only: the row is inserted with
its `ledger_transaction_id` already set, so there is no later UPDATE for the
trigger to refuse.

---

## The ledger

ADR 0004 D7's four remaining accounts land here with the code that writes them:
`supplier_prepaid`, `platform_funds`, `procurement_expense` and
`customer_adjustment` (#123 landed `retail_cost_recovery`). Four transaction
kinds join them: `prefund_top_up`, `procurement_settled`, `retail_variance` and
`supplier_credit`.

| Event | Debit | Credit |
|---|---|---|
| Prefund top-up (T) | `supplier_prepaid` (T) | `platform_funds` (T) |
| Purchase-order draw (S) | `procurement_expense` (S) | `supplier_prepaid` (S) |
| Direct fulfilment cost (L) | `procurement_expense` (L) | `platform_funds` (L) |
| Positive variance recognized (V⁺) | `retail_cost_recovery` (V⁺) | `customer_adjustment` (V⁺) |
| Customer adjustment refunded | `customer_adjustment` (V⁺) | `provider_clearing` (V⁺) |
| Supplier credit (K) | `supplier_prepaid` (K) | `procurement_expense` (K) |

`supplier_prepaid` is carried per OWNER under a THIRD owner type, `supplier`: a
supplier is Mercaria's B2B counterparty with no storefront, no connected account
and no order on this marketplace, so filing its deposit under a seller kind would
put a wholesale balance into the key space every payable query reads. The
compiler caught the one place that assumed the ledger's owner vocabulary and the
connected-account one coincide (`settlement.service.ownerTypeOf`), which is now
typed with the narrower of the two.

`customer_adjustment` is carried per ORDER and NOT per buyer. A guest credential
is purged on its own retention clock while these entries are retained, and a
per-buyer handle in a permanent financial record is a correlation key wearing an
owner id (#106 identity rule 11).

**Recognition and refund are two transactions of ONE kind**, so an order whose
`customer_adjustment` nets to zero has been made whole — reading that off one
kind is what makes D7 proof 2 a query rather than a join across two
vocabularies. The refund leg is deliberately NOT the `refunds` account:
`refunds` is money returned because goods came back, and an adjustment is money
returned because Mercaria over-charged. Merging them would make the refund rate
of a zero-margin channel unreadable.

### Every posting is CLAIMED before it is booked

`ledger_transactions` has no natural key a second booking would collide with, and
the append-only trigger means a duplicate can never be cleaned up — the only
correction available is a reversing transaction, which is the right mechanism for
a WRONG posting and the wrong one for a posting that simply happened twice.

`retail_ledger_recognitions` is the claim. Three steps, and the ORDER is the
safety property:

1. **Read the claim.** Already held ⇒ nothing is written at all.
2. **Write the entries.** They must exist before the claim can name them.
3. **Insert the claim, and THROW if it was taken in between.** The throw rolls the
   whole transaction back, including those entries.

Step 3 is why an empty `ON CONFLICT DO NOTHING` result must be an ERROR here and
not a shrug: it does not abort a transaction, so treating it as "already booked"
would COMMIT the duplicate entries. `ConcurrentLedgerRecognitionError` is caught
at the reconciliation boundary and reported as a run that created nothing,
because the racer that won did the work.

---

## Revisions, and why a re-run writes nothing

Evidence arrives over weeks and the sweep re-reads an order many times, so every
pass asks "has anything I depend on changed". `retail_reconciliations.evidence_digest`
is that answer: a sha-256 over a canonical serialization of exactly the evidence
the equation consumed, plus the policy version and the tolerance — which are not
evidence but do change the ANSWER, so a revision whose verdict differed from its
predecessor's while its digest matched would be a verdict nobody could reproduce.

**The clock is never in the preimage.** A digest that included the computation
time would differ on every pass, so every tick would write a revision, every
order would accumulate one per minute, and "exactly one customer adjustment
obligation" would become one per tick with every earlier one superseded.
`observedAt` IS included, because it is a fact about the RECORD: a supplier
reissuing an invoice with a later date is genuinely different evidence.

A revision is append-only by trigger. A correction is a NEW revision, exactly as
a ledger correction is a new reversing transaction.

---

## Finality is derived and has no column

ADR 0004 D8.6 defines it as the LATEST of three live conditions — the supplier
invoice reconciled, the customer side settled, and any open dispute closed —
bounded at 180 days after DELIVERY. `projection.deriveFinality` reads all three
at projection time.

A stored `finalised_at` beside them would be the second representation of one
fact that `deriveNativeCheckoutEligibility` is the precedent against, and the
place they must not disagree is the decision to stop owing a buyer money. An
order that has not been delivered has no clock to measure from and is therefore
never final, which is right: the return window has not started. `undefined` means
"not final yet" and is deliberately not a date in the future — a projected
finality would be read as a promise.

---

## The operator surface

`/internal/retail-reconciliation/*`, behind
`PROCUREMENT_OPERATOR_OXY_USER_IDS` — the SIXTH allow-list, the one
`procurement-operator-authz.ts` says exists for "reading what Mercaria PAYS its
suppliers", and the one #122, #124 and #125 use.

Deliberately **not** `RETAIL_OPERATOR_OXY_USER_IDS`, which is the fifth,
COMPLIANCE list (#121: recalls, eligibility policy versions, document
verification). This surface shows the supplier invoice by component and the final
supplier item cost, and the sixth list's own docblock is explicit that "a
compliance reviewer vetted to verify a product-safety certificate is not thereby
vetted to see Mercaria's cost base".

EMPTY means the router is NOT MOUNTED — 404, never a 401 that would advertise the
surface. It stays mounted while `RETAIL_RECONCILIATION_ENABLED` is off: the
evidence has to be readable during the incident that turned the sweep off.

**READ, plus a CLOSED set of three writes**, each driving a path the sweep
already runs on its own:

| Route | What it drives |
|---|---|
| `GET /orders/:orderId` | #128's twelve view items |
| `GET /exceptions` | the open queue |
| `GET /adjustments` | what is still owed |
| `GET /metrics` | the ten, each with its definition |
| `POST /orders/:orderId/reconcile` | `reconcileRetailOrder`, the sweep's own function |
| `POST /adjustments/:id/retry-refund` | the same idempotent refund the sweep drives |
| `POST /exceptions/:id/resolve` | closing a recording, attributably |

There is no "set this variance", no "waive this adjustment", no "override this
cost", no "mark this reconciled" and no delete. The isolation test enumerates the
registered routes EXACTLY, so one cannot be added quietly.

**Every attempt is audited, refusals included.** `withAudit` wraps every write, so
an attempt the surface DECLINED is recorded with the same weight as one it
performed — a table of successes would make a refused action indistinguishable
from one nobody tried. The audit write is not best-effort: an action whose audit
failed must fail.

---

## Metrics

The ten #128 names, each carrying the DEFINITION that makes its number readable
(#77's rule that a metric whose definition is unstated cannot be stored, applied
to one that is served).

Read the ABSENCES: there is no gross margin, no profit, no take rate and no
contribution. `RETAIL_RECONCILIATION_METRIC_KEYS` is the complete set the surface
serves and a key outside it 404s, so a margin figure has no key to be served
under.

`quote_to_invoice_variance` and `cost_quote_accuracy_percentile` are basis points
of the customer amount rather than absolutes, because "€3 out on a €5 order" and
"€3 out on a €900 one" are different facts about a cost model and an absolute
figure cannot tell them apart.

---

## The sweep

Leased, bounded, resumable — one PAGE per tick on its own
`reconciliation_cursors` row.

It reuses the payment domain's cursor table and lease, which are already right,
but NOT its runner: this reads purchase orders and supplier invoices, and
`role-separation.test.ts` (#118) forbids anything under `services/payments/` from
importing the procurement domain. `PAYMENT_RECONCILIATION_JOBS` is the subset
that runner dispatches, and it now REFUSES any other job by name — replacing a
fall-through that would have run the account-readiness sweep for every
unrecognised job, with a clean log line and no error.

The cursor advances only after a page is fully handled, so a task that dies
mid-page leaves it where it was and the next run replays it — and a replayed page
re-derives the same digest and writes nothing. Resumability and idempotency are
the same property approached from two sides.

**The LOOP is gated; the records never are.** `RETAIL_RECONCILIATION_ENABLED=false`
stops the timer and nothing else, and a scanned gate fails the build if any module
but the runner reads the flag.

---

## Environment

```
RETAIL_RECONCILIATION_ENABLED=false          # the sweep timer only
RETAIL_RECONCILIATION_BATCH_SIZE=25
RETAIL_RECONCILIATION_POLL_INTERVAL_MS=60000
```

There is deliberately no separate "recognition enabled" lever. Recognizing a
positive variance is what makes D7 proof 2 true, so a deployment that reconciled
without recognizing would be one whose books report margin on a zero-margin
channel. The policy KEY is a code constant
(`RETAIL_RECONCILIATION_POLICY_KEY`), for the reason #120's and #122's are: a
deployment able to name a different key could publish under one name and
reconcile against another, and every order would simply reconcile under no active
policy and record nothing.

**No active policy version means nothing is reconciled**, loudly, with a log
line. The refusal is not defaulted for the reason #58 and #121 refuse without an
active version: a verdict made under a policy nobody published cannot be
reproduced or reviewed.

---

## Testing

- `services/retail-reconciliation/__tests__/equation.test.ts` — the four
  interpretations, the sign convention, the subsidy term, the refund/credit pair,
  the compensating-refund fee case, and every input the equation refuses.
- `evidence-digest.test.ts` — convergence on unchanged evidence, movement when
  the answer would move, and the assertion that no clock is in the preimage.
- `retail-reconciliation-isolation.test.ts` — six scanned walls with a vacuity
  floor and a mutation self-test each, the flag reader census, a WALK of the real
  drizzle tables for a margin-shaped column, and the EXACT route enumeration.
- `retail-reconciliation.realdb.test.ts` — against a REAL Postgres server,
  because the CHECKs, the triggers, the partial uniques, `ON CONFLICT` semantics
  and the ledger's balance rule have no mocked counterpart. **Do not convert it
  to mocks.**

---

## Seams left, each failing closed

- **#127 (retail returns and supplier RMAs) — LANDED, and wired.** Its
  `supplier_recoveries` table is still Mercaria's record of what it expects back
  from a supplier and still books nothing, by its own design; #128 reconciles
  against the DOCUMENTS a supplier issued (`purchase_order_documents`). Four
  places consume it, and each replaced an approximation rather than adding a
  feature:
  1. **The dispute suspension.** `refundBlockReason` calls #127's own
     `findRetailRefundSuspension` and produces `dispute_open`, which until now
     was a block reason with no producer. It is consulted BEFORE the automation
     floor, because `settleRetailCustomerAdjustmentOnRequest` clears the floor
     and re-derives — checked second, an operator clearing it would clear the
     last thing between a held order and a second payment.
  2. **The credit classification.** `return_linked` now means a `supplier_recoveries`
     row on the same PURCHASE ORDER names a service request that HAS a return
     case, not "does this order have any refund". A failed procurement refunds
     the buyer and draws a supplier credit too, and reading that refund as a
     return classified a pure `cost_reduction` as `return_linked` — suppressing
     exactly the customer adjustment the zero-profit policy owes. It is the
     return CASE and deliberately not the recovery's KIND: a kind is #127's word
     for what Mercaria is claiming from a supplier, and only the case says goods
     came back from a buyer. ADR 0004 D8.5 stands — no recovery AMOUNT is read
     and no customer figure is derived from one.
  3. **`retail_supplier_credits.supplier_recovery_id`**, nullable, on this
     domain's own (unreleased) migration rather than a second one. A CHECK makes
     it required for `return_linked` as an IMPLICATION, never a biconditional: a
     `cost_reduction` credit beside a cancelled-procurement recovery legitimately
     names one, and an `=` would refuse that row.
  4. **`missing_customer_refund_record`** asks whether the RETURN CASE's own
     refund exists, matched on the idempotency key `commitRetailServiceRefund`
     derives (`retailRefundIdempotencyKey`, reused rather than re-spelled). An
     order can carry a refund for something else entirely, and reading one of
     those as the return's refund lets a return-linked credit through with its
     customer side genuinely missing.
- **A supplier-invoice LINE breakdown.** #124 records a document total and its
  tax; until an adapter reports lines, the item cost carries the residual and
  says so. Closing it is a #124 column plus a change to one branch in
  `evidence.ts`.
- **A tax-liability ACCOUNT.** The component is represented; where destination
  VAT sits in Mercaria's chart of accounts is an OSS-reporting decision with its
  own owner, and inventing an account here would put a number nobody has agreed
  into the books.
- **Prefund top-ups are DERIVED and not yet driven.** `prefundTopUp` exists and
  is tested; the sweep does not yet compute the observation-to-observation delta,
  because #125's `supplier_funding_observations` records a BALANCE and the top-up
  is `(balance_now − balance_prev) + draws_between`. The reader for the draws
  (`sumProcurementDrawsSince`) is built; wiring it is a change to one page of the
  sweep.
- **`recurring_quote_inaccuracy` is defined and unraised.** The measurement it
  would rest on is the same one `negative_realized_margin` uses, and raising two
  alerts for one condition would double-page.
- **#129 (the buyer-facing UX).** No buyer surface reads this domain, and the
  view type carries wholesale cost so none may.
