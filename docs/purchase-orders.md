# Supplier adapters and PurchaseOrder orchestration (#124)

The provider-neutral boundary through which Mercaria buys from a supplier, and
the machinery that makes buying twice impossible rather than unlikely.

Binding decisions: **ADR 0004** (`docs/adr/0004-mercaria-retail-dropship.md`),
particularly D4 steps 4–5 (procurement after funding, compensating refund on
failure), D6.6 (the purchase-order id is the external reference every draw
carries), D9.2 (the state machine), D9.5 (a substitution is never a success),
D10 (the security and privacy boundaries) and D11 (no OxyPay, no FairCoin).
Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md` §"The supplier
order orchestration". Neighbours: **#118** (`suppliers`, agreements, offers,
purchase orders), **#122** (`docs/supplier-preflight.md` — what a supplier says
BEFORE Mercaria charges anybody).

---

## The failure mode that shapes everything

A supplier order placed **twice** for one customer order, because an HTTP
response was lost.

It costs real money. It is invisible until a supplier's statement is reconciled
weeks later. And every naive recovery makes it more likely: a retry, a
redelivered webhook, an operator clicking "submit again", two ECS tasks draining
one queue. Read the rest of this document as a set of answers to that one
question.

---

## The contract

`SupplierOrderAdapter` (`services/supplier-orders/adapter.ts`) **extends**
#122's `SupplierPreflightAdapter`. One provider integration is one object with
one `provider` slug, one declared capability array and one registry entry.

Two capability tuples, one union:

| tuple | members | enforced by |
|---|---|---|
| `SUPPLIER_PREFLIGHT_CAPABILITIES` | 12 (#122) | `applyDeclaredCapabilities` |
| `SUPPLIER_ORDER_CAPABILITIES` | 12 (#124) | `applyDeclaredOrderCapabilities` |
| `SUPPLIER_ADAPTER_CAPABILITIES` | the concatenation | every `declared_capabilities` CHECK |

The order-side twelve: `order_draft_submission`, `order_state_read`,
`order_reference_lookup`, `order_cancellation`, `order_partial_acceptance`,
`shipment_read`, `tracking_events`, `invoice_retrieval`,
`credit_note_retrieval`, `return_authorization`, `order_webhooks`,
`order_polling`.

Ten of them name a METHOD, and `registerSupplierAdapter` refuses an adapter that
declares one without implementing it. `order_partial_acceptance` and
`tracking_events` name CONTENT other methods return, and the capability boundary
is where an undeclared one is removed.

### An undeclared claim has no representable success

`applyDeclaredOrderCapabilities` runs on every answer, in the one place answers
enter the system, and every downgrade lands on the value that **blocks** rather
than the one that commits:

| claim | without the capability | emulation it would have been |
|---|---|---|
| `partially_accepted` | `unknown` | `assumed_partial_acceptance` |
| line outcomes | removed | `assumed_partial_acceptance` |
| `delivered` / `shipped` | `unknown` | `assumed_delivery` / `synthetic_shipment` |
| `duplicateOfExistingOrder: true` | `false` | `emulated_provider_idempotency` |
| shipments | `[]` | `synthetic_shipment` |
| carrier scans | `[]` | `synthetic_shipment` |
| `cancellable: true` | `false` | `assumed_cancellation_accepted` |

Each removal is REPORTED, not applied silently: a non-empty report becomes a
`capability_not_declared` exception an operator sees. Quietly accepting the
claim would make the declaration decorative; quietly discarding it would make
the adapter's bug invisible.

`SUPPLIER_ORDER_EMULATED_COMMITMENTS` (7) joins #122's six into one union that
is DISJOINT from the capability union — a scanned gate with a mutation
self-test.

---

## Idempotency: the four mechanisms

None of them is a convention.

1. **`purchase_orders.idempotency_key`** — `po:<orderId>:<supplierId>`, UNIQUE
   (#118). One purchase order per supplier per customer order, whoever asks and
   however often.
2. **The outbox row's id** — derived from the purchase order, so an operator
   retry, a redelivered payment consequence and a reconciliation sweep all
   UPSERT the same row instead of queueing a second submission. That is #124
   idempotency item 6 held by a primary key rather than by a check somebody
   could forget.
3. **The attempt row**, committed `in_flight` **before** the provider is called.
   A task that dies mid-request leaves durable evidence that a request may have
   reached the supplier — indistinguishable from one that definitely did, which
   is exactly why the recovery is a LOOKUP.
4. **`purchase_orders.supplier_external_order_id`** — UNIQUE per account (#118).
   Two purchase orders can never claim one supplier order; the database refuses
   it and the refusal becomes a `duplicate_external_order` exception, which
   HALTS fulfilment.

### `afterWrite` is what makes an outcome ambiguous

A connection refused sent nothing, so a retry is free. A request whose bytes
went out and whose response never came back MAY have created an order. Only the
code holding the socket knows which side of the write the failure fell on, so
the ADAPTER states it (`SupplierProviderError.afterWrite`) and the chokepoint
records it.

The default is the safe one: an error that is not a `SupplierProviderError` at
all reads as `afterWrite: 'unknown'`, which is treated exactly as `yes`. Reading
an unclassified failure as "definitely nothing was written" is the assumption
that costs money.

The error CLASS is deliberately NOT part of the answer. A `validation` failure
after the write is still ambiguous — some providers validate asynchronously and
answer 400 on an order they have already created.

`supplier_order_attempts_ambiguity_shape_check` makes `ambiguous` unreachable
without `provider_error_after_write = 'yes'`, so it is not a value a service
could choose.

### Retry guidance is a table

`SUPPLIER_PROVIDER_ERROR_RETRYABLE` in shared-types, not a switch:

| class | retryable | why |
|---|---|---|
| `retryable` | yes | transport, 5xx, lock contention |
| `quota` | yes | later, per the provider's own window |
| `unknown` | yes | far more often a transport fault than a refusal, and a paid order must not be abandoned because an adapter did not recognise a status code |
| `auth` | **no** | a rejected credential retried on a backoff burns the rate budget and on some providers locks the account; rotation is an operator act |
| `validation` | no | the request was refused and will be again |
| `terminal` | no | — |

---

## Submission orchestration

`submitPurchaseOrderToSupplier` (`services/supplier-orders/submission.service.ts`):

1. Load the immutable intent — the purchase order and its frozen lines (#118).
   Nothing is recomputed.
2. Revalidate the payment authorization through the #123 port. **Every time**: a
   refund, a cancellation or a moderation hold can land between the job being
   enqueued and the job running.
3. Refuse a HALTED order.
4. **Converge an unresolved earlier attempt before anything else.** If the last
   submission attempt is `ambiguous` or still `in_flight`, the provider is ASKED
   whether it has an order under Mercaria's client reference. A second
   submission is reachable only after that question has been answered "no".
5. Refuse a CHANGED request — a resubmission whose canonical digest differs from
   one that may already have been applied is not a retry.
6. Submit through the chokepoint.
7. Apply the answer and announce it.

There is deliberately **no plain retry path in this module at all**.

### When an ambiguity cannot be converged

A provider that did not declare `order_reference_lookup` cannot be asked. That
is where an ambiguity becomes an operator's row rather than another attempt:
`unconverged_submission`, with the purchase order flagged for intervention.
Retrying blind would place the second order; refusing forever would strand a
paid customer; the honest third answer is to stop and say so.

---

## The chokepoint

`callSupplierProvider` (`services/supplier-orders/provider-call.ts`) is the ONE
module that reaches the adapter registry — a scanned gate. Every provider call
in the domain goes through it, so a new operation gets everything by
construction:

1. **The account** — state, credential status, kill switch (#118). Read FIRST so
   a killed account does not consume a lease slot a healthy one is waiting for.
2. **The suppression** — #122's operator stop, reused rather than duplicated, so
   one act stops a supplier for quoting AND ordering.
3. **The capability** — an operation whose capability the adapter did not
   declare is REFUSED and recorded, never simulated.
4. **The fetch lever** — read-only operations only. A submission and a
   cancellation are consequences of money that has already moved, so pausing
   them silently would strand a paid order.
5. **The credential** — resolved per call from the approved secret system
   through `credential.port.ts`, whose default REFUSES. Passed to the adapter
   rather than read by it, so an adapter holds no secret between calls, cannot
   cache one across a rotation, and has nothing to log.
6. **The provider lease** — #122's `supplier_call_leases`, so the outbound rate
   this domain adds is counted in the same budget the preflight spends from.
7. **The attempt row**, `in_flight`, committed.
8. **The call**, with its deadline.
9. **The attempt row's terminal outcome**, and the lease released.

**A refusal is an OUTCOME, not a skipped call.** Every gate writes an attempt
row with `outcome: 'refused'` and a named reason: "we never asked" and "we asked
and it failed" lead an operator to opposite conclusions.

---

## The state machine, and the issue's sixteen states

ADR 0004 D9.2 SELECTED nine statuses and #118 landed them. #124's longer list is
not an omission — every state has a representation, and adding a status for one
would give the machine two ways to say one thing:

| #124 state | representation |
|---|---|
| Draft | `status = 'draft'` |
| Ready for submission | `draft` + an enqueued `purchase_order_submission` row |
| Submitting | an `in_flight` row in `supplier_order_attempts` |
| Submitted | `status = 'submitted'` |
| Accepted | `status = 'accepted'` |
| Partially accepted | `accepted` + `purchase_order_line_outcomes` |
| Allocating / processing | `allocated_at` — a supplier fact that moves nothing |
| Partially shipped | `status = 'shipped'` + per-line `shipped` outcomes |
| Shipped | `status = 'shipped'` |
| Delivered | `status = 'delivered'` |
| Cancellation requested | `status = 'cancel_requested'` |
| Cancelled | `status = 'cancelled'` |
| Return / RMA | #127's flows; #124 ships the adapter contract only |
| Credited | `purchase_order_documents` of kind `credit_note` |
| Rejected | `status = 'rejected'` |
| Exception / manual review | `operator_intervention_required` + `procurement_exceptions` |

### The mapping is a PROCEDURE, versioned, never a table

The adapter ships `mapProviderState` and a `stateMappingVersion`, and every row
read under it records the number. A table would let somebody publish a mapping
version whose rules nobody shipped — `CATALOG_BACKFILL_MAPPING_VERSION`'s
reasoning (#60), applied to a provider vocabulary.

An unrecognized provider status MUST answer `unknown`. The orchestration then
records `unmapped_provider_state` and moves nothing, which is how a provider
adding a status is discovered rather than mis-read as the nearest-looking one.

### One observation path, four callers

`applyProviderObservation` is the single body a webhook, a poll, a submission
answer and a convergence lookup all take. `decideProviderObservation` is its
pure decision, and the ORDER of its checks is load-bearing:

1. **Staleness first** — an old delivery arriving late is not a regression, and
   reporting it as one would fill the operator queue with the ordinary
   behaviour of an at-least-once webhook. The ordering key is the PROVIDER's own
   `observed_at`; two deliveries racing produce receipt times whose order says
   nothing about the world.
2. **`unknown`** — an unmapped state has no status to compare against.
3. **A TERMINAL order receiving any further state change** — before the rank
   check, because a shipment on a cancelled order outranks nothing and would
   otherwise be buried in the generic regression bucket. It has to reach the
   caller as an illegal transition so it can be classified
   `shipment_after_cancellation` (halting).
4. **The rank regression** — now unambiguously a LIVE order whose provider
   corrected itself or is confused. Recorded, never forced.

Nothing overwrites history: `purchase_order_transitions` is append-only (#118),
and the current state only ever moves forward.

---

## Webhooks and polling

`POST /webhooks/suppliers/:supplierAccountId` — the **fourth** raw-body mount,
after `/channels/webhooks`, `/webhooks/crowdsource` and `/webhooks/stripe`, and
it must stay before `express.json()`.

- **The account is in the PATH.** Nothing in the body says which account a
  delivery belongs to — that would let one supplier's credential verify
  another's events.
- **An unverifiable delivery is REFUSED, never stored.**
  `SupplierEventVerification` has no `unverified` member, so such an event has
  no row shape at all. Refusals are COUNTED so a spray of forged callbacks is
  visible on the metrics, and the log line carries the account and the reason
  and no part of the body.
- **An unknown account gets the SAME 401** as an unverifiable delivery: a
  distinguishable response would let a caller enumerate account ids.
- **A 200 means stored, never processed.**
- **The mount is NOT flag-gated**, unlike Stripe's, and the difference is real:
  what makes a delivery verifiable here is the account in the path and its
  credential, so an unconfigured deployment already answers 401 through the
  handler's own gates. A flag would be a coarser second way to say the same
  thing, and one that could strand a supplier's events during an incident where
  their configuration is what somebody is fixing.

### Dedupe has two keys

A webhook carries the provider's own event id. A POLL does not — it is a
snapshot Mercaria asked for — so its identity is its CONTENT. Two partial unique
indexes, not one `NULLS NOT DISTINCT` constraint: that makes NULLs COLLIDE,
which is right for `payment_provider_events`' optional account scope and would
collapse every polled event for an account into one row here.

### Polling

One outbox row per purchase order for its whole life, which RESCHEDULES itself
rather than enqueueing another. The reschedule resets the attempt counter,
because a poll that answered is a success and counting it as a failure would
dead-letter a healthy order after twenty-five passes.

A terminal order is still polled for `PROCUREMENT_POLL_TERMINAL_GRACE_MS` — a
late correction arrives after the state that looks final — and then polling
STOPS. The window is measured from the order's own terminal timestamp, not the
loop's clock, so a task that was down for a day does not restart it.

**Webhook/poll disagreement is recorded, never averaged.** Both go through
`applyProviderObservation`; a poll reporting a state behind what was applied
raises `webhook_poll_disagreement` rather than either source winning by rule.

---

## Cancellation

Four answers, kept apart because they route in genuinely different directions:

- **Requested** — `status = 'cancel_requested'`, durable before the provider is
  called, so a crash mid-call leaves an order that visibly owes an answer.
- **Accepted** — `cancelled`.
- **Rejected** — too late; the order returns to `accepted` and the recovery is
  #127's return-to-supplier RMA. Calling it a cancellation would tell a customer
  their money is coming back while a parcel is on its way to them.
- **Ambiguous** — the order STAYS `cancel_requested`, which is exactly what that
  state means, and an exception routes it to a person.

**Nothing here refunds, restocks or deletes.** The customer's refund is the
commerce decision #127 and the refund domain own, on Mercaria's own timeline; a
cancellation request is not evidence that a refund is due, and a supplier's
acceptance is not permission to issue one. A late shipment after a cancellation
arrives through the observation path as `shipment_after_cancellation`, a HALTING
condition.

---

## Exceptions: the conditions only a person can close

`procurement_exceptions` is a RECORDING (the `payment_discrepancies`
relationship). Detection and repair are separate acts, and nothing in this
domain deletes or rewrites a procurement record to make a mismatch go away.

Fifteen kinds. Four of them HALT fulfilment and payment escalation
(`PROCUREMENT_HALTING_EXCEPTION_KINDS`) because continuing is actively harmful:

- `duplicate_external_order` — Mercaria is billed twice for goods ordered once.
- `substitution_detected` — a supplier shipped something the customer did not
  choose (ADR 0004 D9.5: never a success).
- `late_acceptance_after_cancellation`
- `shipment_after_cancellation`

Raising a halting kind also sets `operator_intervention_required`, in ONE place,
so the flag and an open case can never disagree.

One OPEN case per condition, by partial unique index — two detections converge,
and a RESOLVED case is re-raisable when the condition genuinely recurs.

---

## Privacy

Three mechanisms, in decreasing order of how much they are relied on:

1. **Absence.** No table in this domain has an address, recipient, phone or
   email column. The destination exists once, on `purchase_orders`, redacted by
   shape (#118).
2. **The ALLOW-LIST.** `SUPPLIER_EVENT_PAYLOAD_FIELDS` — never a deny-list,
   which is correct only until the provider adds a field, and a fulfilment
   API's next field is very often the recipient's name. Nested objects are NOT
   walked: a nested object is where a provider puts the shipping address, and
   descending into one would mean allow-listing every PATH.
3. **The scrub.** `redactSupplierOrderMessage` removes emails, street-shaped
   fragments, digit runs of five or more and mixed alphanumeric postal tokens.
   Five and not six, unlike the preflight's: five digits is the most common
   postal length there is, and this domain's requests carry a full street
   address where the preflight's do not. The cost is stated — a purely numeric
   five-digit SKU loses its digits in a provider message.

   The street rule matches a house number followed by a word run that is **not
   lowercase** (#832). "Capitalised word" is a bicameral proxy for "proper
   noun", so the class is `\p{Lu}\p{Lt}\p{Lo}` — capitalised, **or caseless**,
   because Devanagari, Bengali, Han, Kana, Hangul, Arabic, Hebrew and Thai have
   no case for `\p{Lu}` to match. `\p{Ll}` stays out, so the filter that spares
   `12 items shipped` still spares `12 товаров отправлено`. The continuation
   admits `\p{M}` and U+200C/U+200D, without which a decomposed `Nguyễn` or a
   Hindi conjunct redacts to a PARTIAL — worse than none, because it looks
   redacted. Every class here is disjoint from ASCII, which is what keeps the
   SKU and carrier-code promise above true by construction.

   **Two limits, both deliberate.** In a caseless script there is no case
   filter, so a caseless run of two or more after a house number is redacted
   whether it is an address or prose. And an address in native CJK order
   (`東京都新宿区西新宿2-8-1`) puts the number last with no separator, so the
   shape never engages and no character class would change that — closing it
   needs an administrative-suffix lexicon. Mechanisms 1 and 2 are what stand in
   front of that case; a test pins it so the gap stays discoverable.

`supplier_order_attempts.request_hash` and both
`supplier_provider_events` handles are PROTECTED (`db/protectedColumns.ts`): a
digest over a request containing a street address is an exact-match ORACLE, the
`guest_checkouts.email_hash` reasoning.

Credentials: Mercaria stores a PATH, never a secret. `credential.port.ts`'s
default answers `null`, which the chokepoint turns into `credential_not_valid` —
so a deployment with no secret reader places no supplier orders and says why.
Rotation does not orphan existing orders, because the reference is stable and
only the value behind it changes.

---

## Flags

| variable | default | gates |
|---|---|---|
| `PROCUREMENT_ORCHESTRATION_ENABLED` | `false` | the submit/cancel dispatcher LOOP |
| `PROCUREMENT_PROVIDER_FETCH_ENABLED` | `true` | outbound status reads and polling |
| `PROCUREMENT_EVENT_PROCESSING_ENABLED` | `true` | APPLYING stored provider events |
| `PROCUREMENT_FAKE_ADAPTER_ENABLED` | `false` | whether the rehearsal adapter is registrable |
| `PROCUREMENT_OUTBOX_BATCH_SIZE` / `_POLL_INTERVAL_MS` / `_LEASE_MS` | 25 / 5 000 / 60 000 | the orchestration loop |
| `PROCUREMENT_EVENT_BATCH_SIZE` / `_POLL_INTERVAL_MS` / `_LEASE_MS` | 50 / 5 000 / 60 000 | the event loop |
| `PROCUREMENT_POLL_MIN_INTERVAL_MS` | 300 000 | never poll one order more often |
| `PROCUREMENT_POLL_TERMINAL_GRACE_MS` | 86 400 000 | bounded post-terminal confirmation |
| `PROCUREMENT_EVENT_LAG_SLA_MS` | 3 600 000 | when silence becomes an alert |
| `PROCUREMENT_CALL_TIMEOUT_MS` | 20 000 | every provider call's deadline |
| `PROCUREMENT_CONVERGENCE_GRACE_MS` | 60 000 | how old an unresolved attempt must be |
| `PROCUREMENT_OPERATOR_OXY_USER_IDS` | empty | `/internal/procurement/*` — empty = NOT MOUNTED (404) |

The first three are genuinely independent levers (#124 polling and webhooks 10),
and **none of them gates a durable record** — a scanned gate fails the build if
the ingress, the repositories or the exception path learn to read one.

The **per-supplier kill switch** is a different mechanism:
`supplier_accounts.state = 'killed'` (#118) stops NEW submissions while status,
cancellation, return and reconciliation keep working, which is acceptance 5.

---

## The operator surface

`/internal/procurement/*`, behind the SAME sixth allow-list
`/internal/supplier-preflight` uses and deliberately not a seventh.

- `GET /metrics` — attempts by operation and outcome with p95 latency, the
  outbox by type and status, events by delivery and status, per-account lag with
  its SLA verdict, exceptions by kind, and the process-local count of refused
  unverifiable callbacks.
- `GET /queues` — open conditions and dead-lettered jobs, read from where they
  already live rather than copied into a third table.
- `GET /purchase-orders/:id` — the whole trace, opened from a purchase-order id
  and nothing else. The supplier's own order id is shown as its last four
  characters.
- `POST /purchase-orders/:id/submit` — enqueues the DETERMINISTIC row. A second
  click claims the same row.
- `POST /purchase-orders/:id/cancel` — opens the durable request a buyer's own
  cancellation would.
- `POST /exceptions/:id/resolve` — the one mutation of a stored fact, and it is
  a decision about Mercaria's own queue. Attributable, dated, explained; a
  second close answers 409.

There is deliberately **no** "set this purchase order accepted", no "attach this
external order id", no "clear this attempt" and no "delete this event".

---

## Testing

`services/supplier-orders/__tests__/adapter-conformance-suite.ts` is a reusable
SUITE, not a fixture dump. #125 passes a harness — a provider slug, an adapter,
a credential, a way to inject each scenario, a way to reset, and an oracle for
"does the transport hold an order under this reference" — and gets all fourteen
cases against a REAL Postgres server, through the REAL orchestration.

The suite builds the supplier, the account, the agreement, the customer order,
the purchase order and the payment authorization itself, so two adapters are
measured against the same commercial setup rather than against whatever fixtures
each author happened to write.

The one case that is NOT here: "successful quote" is #122's suite. Quoting and
ordering are different adapter halves with different failure modes.

Beside it:

- `supplier-order-isolation.test.ts` — six scanned walls, each mutation-tested,
  with a vacuity floor.
- `structural-guarantees.realdb.test.ts` — the four triggers, the CHECKs and the
  dedupe indexes, against a real server, because a mocked `insert` accepts every
  statement a real one rejects.
- `observation-rules.test.ts` and `redaction-and-references.test.ts` — the pure
  rules, exhaustively.
- `routes/__tests__/supplier-webhook.integration.test.ts` — the raw-body
  invariant against the REAL chain, with the json-parsed vacuity guard.

---

## Seams

Each is a NAMED contract that fails closed, never a stub that lies.

- **#123** — `services/supplier-orders/payment-authorization.port.ts`.
  #123 calls `registerProcurementPaymentAuthorizationReader(reader)` with one
  function, `(orderId) => Promise<ProcurementSubmissionAuthorization>`. Until it
  does, the default answers
  `{ authorized: false, reason: 'authorization_reader_not_registered' }` for
  every order, so a deployment without retail checkout places no supplier orders
  and says why. `authorization_reader_not_registered` is its own reason and not
  one of the substantive ones, so an operator can tell "this deployment has no
  retail checkout" from "this order was never paid".
- **#125** — the first real adapter. NONE is registered here; the fake one is
  double-gated (a flag to be registrable, and a refusal of any `live` account at
  call time whatever the flag says).
- **#126** — customer communication. `purchase_order_accepted` and
  `purchase_order_rejected` are announced as outbox rows and consumed by
  nothing.
- **#127** — cancellations, returns and RMAs. The adapter contract
  (`createReturn`, `readReturn`) and the capability exist; there is no RMA table
  here, because #118 already assigned returns to #127.
- **#128** — the procurement ledger and invoice reconciliation.
  `purchase_order_documents` records what a supplier billed; nothing here books
  anything.
- The buyer's **relay email** (ADR 0004 D2.7's escape hatch) needs an outbound
  mail transport Mercaria does not have — the `role_email` situation (#83) — so
  `SupplierRecipient` has no email member at all.
