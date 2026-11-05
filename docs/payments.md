# Payments and the internal ledger

The provider-neutral payment domain: what the models are, what holds each
invariant, what is retained and for how long, and where the boundaries between
this domain and the rest of Mercaria fall.

Binding context lives in [ADR 0001](./adr/0001-stripe-connect-architecture.md) —
separate charges and transfers, Mercaria as merchant of record, one charge per
checkout group — and in [ADR 0009](./adr/0009-peable-payment-rail.md), which
moved the rail behind Peable and keeps ADR 0001's D1 and D3–D12. This document
describes what was BUILT; the ADRs describe why, and where they disagree with
this file the ADRs win and this file is wrong.

**Peable is the only card rail.** Mercaria's card payments go through the Oxy
gateway (`services/payments/peable/`), which holds the acquirer; Mercaria holds
no acquirer SDK and no acquirer credential. The direct Stripe marketplace rail
was deleted on 2026-11-05 (ADR 0009 D13 "As built"); it had never carried
money. FairCoin is not a payment method in this roadmap.

What is built: the domain and the ledger (#45), checkout and the per-seller
settlement (#47), the money coming back — refunds, transfer reversals, disputes,
payouts (#49) — reconciliation and operator recovery (#50), and the Peable
adapter and event ingress (ADR 0009).

### What the Peable rail does not do yet

None of these is papered over below; each is a gap before `PEABLE_ENABLED` can
take a buyer's money (ADR 0009 D13):

- **No native card form, and the web payer UI is unverified end to end.** The
  web checkout pays with Peable's Elements; iOS and Android open Peable's hosted
  pay page in the system browser, because Peable's payer SDK has no native card
  path (see "The storefront's card step"). Neither has confirmed a real
  payment (ADR 0009 D18).
- **No dispute events.** The Peable router applies `payment_intent.*`,
  `charge.refunded`, `refund.*`, `payout.*` and `connected_account.updated`, so
  `disputes` has no writer and `payment_disputed` no producer.
- **No processor fee and no settlement figure.** A Peable success books no
  `processor_expense`, and the adapter's refund result carries no platform
  figure, so a refund's money leg retries `refund_settlement_unavailable` until
  its outbox row dead-letters (see "Refunds, disputes and payouts").
- **No reconciliation of the gateway's settled movements.** The deleted
  `provider_objects` sweep had nothing on Peable to read.
- **No referral payout rail.** The payout-rail port is empty and batches fail
  `rail_not_configured`, retryably (`docs/referral-earnings.md`).
- **ADR 0009 D18's three real-world checks** have not been run.

---

## Why the ledger is load-bearing on day one

ADR 0001 D3 chooses separate charges and transfers, which means Mercaria's
commission is **not** an `application_fee_amount` — that mechanism does not exist
for this charge model. The commission is the difference between what the buyer
paid and the sum of what the sellers were paid, and that quantity exists in
exactly one place: `ledger_transactions` and `ledger_entries` in this database.
The acquirer's fee reporting is deliberately given up.

So the ledger is not accounting hygiene to be added once revenue matters. It is
the only record of revenue there will ever be, which is why it landed before a
single real charge could be created.

---

## Models

Thirteen tables, all Postgres-native.

| Table | What it is |
|---|---|
| `provider_accounts` | One seller's standing with one rail: their Peable connected account, its capabilities, and the single readiness verdict checkout gates on. Written by Peable onboarding (`services/payments/peable/accounts.ts`). |
| `payments` | The durable payment aggregate. One per funded checkout group for native rails; one per imported order for `external`. |
| `disputes` | A card network reversing a charge: its deadline, its evidence, its outcome and its ledger life (#49). **No writer today.** |
| `payment_attempts` | One row per provider authorization or confirmation Mercaria asked for. Append-mostly evidence. |
| `payment_provider_events` | The immutable envelope of everything a provider has told Mercaria. Receipt is separate from processing. |
| `transfers` | Mercaria paying ONE seller order out of a settled charge (ADR D3). |
| `payouts` | The provider moving a seller's own balance to their bank. Recorded for health and support; books nothing. **No writer today.** |
| `payment_outboxes` | The durable promise that a payment's consequences will happen. |
| `ledger_transactions` | One balanced set of entries, and what caused it. |
| `ledger_entries` | One signed movement against one account in one currency. |
| `payment_discrepancies` | One disagreement reconciliation has noticed between Mercaria and the rail, or within the ledger (#50). |
| `payment_repairs` | Every operator action against the payment domain, applied or refused. Append-only (#50). |
| `reconciliation_cursors` | Where each sweep had got to, and which task is running it (#50). |

No table was dropped with the direct rail: each is the domain ADR 0009 D14
keeps, and the Peable rail writes or will write each of them.

They replace the four `orders.payment_*` fields, which had to be a state machine,
an audit trail, an idempotency key and a provider reference at once, and the four
`settlement_*` columns retired with them (a shop→FAIR snapshot from the model in
which FAIR was the mandatory settlement currency).

The order keeps only a POINTER and the coarse state:
`{status, provider?, paidAt?, reference?, paymentId?}`. Nothing mutable is copied
onto it, so a payment moving through its lifecycle can never leave an order
holding a stale figure.

### The chart of accounts

Nine accounts. `LedgerAccount` in `@mercaria/shared-types` carries the same
table with the per-account meaning of a positive entry.

| Account | Normal balance | What it holds |
|---|---|---|
| `provider_clearing` | debit | Funds on the platform balance |
| `merchant_payable` | credit | What Mercaria owes a seller, per order |
| `commission_revenue` | credit | Mercaria's commission — the charge minus the sellers' nets |
| `processor_expense` | debit | Provider fees, borne by Mercaria (ADR D5) |
| `refunds` | debit | Money returned to buyers |
| `disputes` | debit | Disputed principal, held until the outcome is known |
| `reserves` | debit | Funds withheld from a seller |
| `retail_cost_recovery` | credit | A buyer paying Mercaria's own costs back on a `mercaria_retail` order (#123) |
| `subscription_revenue` | credit | Merchant subscription revenue (#89) |

`subscription_revenue` is its own account rather than a use of
`commission_revenue`, and that is #89 acceptance 6. Marketplace commission is
ADR 0001 D3's residual and exists nowhere else at all; booking a merchant's
monthly subscription into it would make the one figure that already exists
nowhere else stop meaning what it means, with no way to separate the two
afterwards. A subscription is also not a `payments` row — that table is the
marketplace charge aggregate, one per checkout group, correlated to orders — so
its transaction names no payment and `merchant_subscription_events` is what
points back at the posting. Full reference: `docs/merchant-plans.md`.

There is deliberately no buyer-funds account: Mercaria is the merchant of record
(D1) and never holds a buyer balance. Money arrives already captured, which
`provider_clearing` is the name for.

`merchant_payable` is the only account carried per owner (`ownerType` +
`ownerId`, plus the order). The rest are platform-wide.

### The sign convention

`ledger_entries.amount_minor` is **SIGNED**: positive is a DEBIT, negative is a
CREDIT, and the entries of one transaction sum to exactly **zero per currency**.

There is no `direction` column beside it. Two representations of one fact can
disagree — `direction: 'credit'` next to a positive amount is a row nobody can
interpret — and nothing in a schema can stop it being written.

Per CURRENCY, not overall: a cross-currency movement books both legs in their own
currencies at a captured rate (ADR D8), and adding a EUR amount to a USD one to
reach zero would be arithmetic on two different things.

### The one deviation from the money convention

`CONVENTIONS.md` makes every money column `bigint({ mode: 'number' })`, so it maps
to the `number` that `Money.amount` already is. `ledger_entries.amount_minor` is
`bigint({ mode: 'bigint' })` instead. A ledger entry is not a `Money`: it never
ships to a client, it is never rendered, and it is summed across arbitrarily many
rows by the one part of the system whose job is to be exactly right. The bound
that applies is the column's own int8 range, asserted by `assertSafeLedgerAmount`
at every posting builder.

---

## Invariants, and what holds each one

### Balance — three layers, none of which is a convention

1. **The repository.** `db/payments/ledgerRepository.ts` exports exactly ONE
   write, `insertLedgerTransaction(tx, entries)`, which takes a whole transaction
   with all of its legs and refuses it before issuing any SQL if it has fewer
   than two entries, carries a zero or an out-of-range amount, or does not sum to
   zero per currency. An API that let a caller insert a single entry would make
   "unbalanced" a reachable state for as long as the caller took to add the next
   one.
2. **The database.** A `BEFORE UPDATE OR DELETE` trigger on both tables raises
   `check_violation` with a message naming the reversal that should have been
   used instead. It is a trigger and not a convention because a backfill script,
   an operator at a `psql` prompt and a future service all reach these tables
   without passing that function.
3. **Randomized property tests.** `db/payments/__tests__/ledger.realdb.test.ts`
   generates balanced and unbalanced entry sets across mixed currencies from a
   seeded PRNG (the seed is printed on every run; replay with
   `LEDGER_TEST_SEED=…`). Balanced sets insert, unbalanced ones are refused,
   UPDATE and DELETE are refused against both tables, and a correction is
   asserted to be a reversing transaction that leaves BOTH rows in the book.

The trigger assertions were mutation-tested: with the two `CREATE TRIGGER`
statements removed from the migration, five of those tests go red naming the
missing trigger; with them restored, the file is green. (A total is deliberately
not quoted here — it drifts with every case added to the file, and a count that
any addition falsifies is not an invariant.)

### Read order — STABLE, and deliberately not chronological

`LEDGER_TRANSACTION_ORDER` and `LEDGER_ENTRY_ORDER` in
`db/payments/ledgerRepository.ts` are the published read order and the only
spelling of it. Both are `(created_at, id)`, and the tiebreak is load-bearing
rather than defensive: `insertLedgerTransaction` writes every leg of a
transaction in ONE `insert ... values` statement, and `createdAt()` defaults to
`date_trunc('milliseconds', now())` — `now()` being `transaction_timestamp()`,
constant for a whole database transaction. So all the legs of a transaction, and
all the transactions booked together, carry one instant to the microsecond. A
tied `ORDER BY` is UNSPECIFIED in PostgreSQL, which is issue #466: an assertion
over that order failed CI once and passed on the re-run with no change.

The property the key provides is **stability** — one valid answer, so no planner
can decide the sequence. It is **not** chronology, and nothing below a
millisecond recovers it: the timestamp is truncated at the source (so
`created_at` keysets stay correct) and `@oxy.so/db`'s uuid v7 is not monotonic
within a millisecond — measured, 96% of same-millisecond id groups come back in
an order that is not the order they were minted in. **No reader may infer write
order from this sequence**, and none does.

Nor is there anything more meaningful to order the legs by. They are simultaneous
by construction — the sign convention is the whole of their relationship — so
"which leg came first" is a question with no answer, and an order by `account`
would be a canonical sequence that reads as meaning something and does not.
Storing a leg index was considered and refused for the same reason: it would
record the order a JS array happened to be built in, as though the accounting had
one. Assertions over the legs of one transaction are therefore multisets.

Two gates hold it: `ledger.realdb.test.ts` asserts the key is TOTAL over rows
that tie on the timestamp (remove the `id` and it goes red naming the duplicate),
and `db/__tests__/ledger-order-chokepoint.test.ts` fails the build on any reader,
test fixtures included, that orders these tables by a spelling of its own without
a named disposition. There are exactly two such dispositions:
`findOpenMerchantPayables`, which orders by its own `GROUP BY` key, and
`commissionBaseRepository`, which is the DESC reading of the same key.

### Corrections

A mistake becomes a NEW transaction whose entries are the negatives of the wrong
ones. There is no other mechanism, and deliberately no `reverseTransaction(id)`
helper: it would have to READ the ledger to build its entries, making a
correction a function of what is stored rather than of what an operator decided,
and it would quietly become the way history gets rewritten one approved reversal
at a time.

### Idempotency

| Layer | Mechanism |
|---|---|
| Payment per checkout group | Partial unique index on `checkout_group_id WHERE provider <> 'external'` |
| Payment per imported order | Partial unique index on `order_id WHERE provider = 'external'` |
| Provider events | `UNIQUE(provider, provider_account_id, provider_event_id) NULLS NOT DISTINCT` |
| Status transitions | A compare-and-swap from an allowed source status |
| Transfers | `UNIQUE(payment_id, order_id)` |
| Payouts | `UNIQUE(provider, provider_object_id)` |
| Outbox rows | A deterministic primary key, inserted `on conflict do nothing` |

Two of those need their reasons stated, because the obvious version is wrong:

**`NULLS NOT DISTINCT` on the event key.** `provider_account_id` is NULL for
platform-scope events — and every Peable delivery is one: the gateway signs
everything with one secret and the ingress records no account. Postgres treats
NULLs as DISTINCT by default, so the plain constraint would silently accept every
redelivery. Coalescing to `''` would also work and is worse: an empty string is a
VALUE, so it collides for real the day a provider reports an empty account.

**External payments are unique per ORDER, not per group.** A connector's
checkout group is a synthetic `ext:<provider>:<externalId>`, and two connected
shops can legitimately import orders carrying the same external id — so their
group ids collide. Uniqueness on the group would make the second shop's import
fail.

### Provider ids are never primary keys

Every `provider_object_id` is a plain, indexed, nullable column. A provider's key
space is not Mercaria's: it changes between test and live mode, it is absent
until the provider has answered, and two providers may mint the same string.

### Payment success cannot be asserted by a client

A payment reaches `succeeded` only through `applyPaymentStatus`, reached either
from a verified provider EVENT (whose envelope came from an adapter's
`verifyEvent`) or from a live read of the rail over an authenticated
server-to-server channel (`open_payments`, `refetch`). A client callback is UX; a
`return_url` proves nothing.

---

## Service boundaries

```
checkout.service.ts ─────────────┐        routes / Peable webhook ingress
   (no adapter import, ever)     │               │  verified envelope
                                 ▼               ▼
services/payments/checkout-payment.service.ts   payment.service.ts
   rail choice, currency gate, handoff       ← the ONLY status transitions
                                 │               │
                                 │               ├── ledger-postings.ts   ← pure; ADR's table
                                 │               ├── settlement-shares.ts ← pure; ONE split
                                 │               ├── payment-outbox.service.ts
                                 │               │      └── outbox-handlers.ts
                                 │               │             └── settlement.service.ts
                                 │               └── order-linkage.ts     ← the ONE seam onto orders
                                 ▼               ▼
                          registry.ts → provider.ts  ← the seam every rail plugs into
                                          ├── synthetic-provider.ts   (id: `mock`)
                                          └── peable/peable-provider.ts (id: `peable`)
```

- **`provider.ts`** names no provider's vocabulary. No `PaymentIntent`, no
  `transfer_group`. The day one appears, the seam has failed.
- **Three modules talk to an adapter for money, and no others.**
  `payment.service` (status transitions and the sweep's cancellation),
  `checkout-payment.service` (opening the payment a checkout funds) and
  `settlement.service` (the transfers), plus the refund executor and the
  reconciliation reads. Each reaches its rail through `registry.ts`, so "which
  adapter serves which rail" is answered in one place and a rail that is not
  configured resolves to `undefined` rather than throwing inside a request.
- **`native-rail.ts`** is the single answer to "does this deployment have a
  native rail, and which" (ADR 0009 D19): `NATIVE_RAIL` is pinned to `'peable'`
  in the type, and `PEABLE_ENABLED=false` is the whole of "no card rail".
- **`payment.service.ts`** owns the state machine, the ledger postings and the
  outbox writes, in ONE Postgres transaction per status change. If the
  compare-and-swap matches nothing — a duplicate `succeeded`, an out-of-order
  `processing` after it — nothing downstream runs. That single fact is what makes
  duplicate and out-of-order events converge.
- **`order-linkage.ts`** is the only module that touches orders, reading them
  through a projection it owns rather than reaching into the order repository from
  five places. The payment and the order transition still do not commit together —
  the transition runs from the outbox handler, a separate transaction — so the
  outbox remains the reconciliation path.
- **`tracePayment`** is exposed at `GET /internal/payments/trace`, behind
  `payments.operate` — everything it returns is merchant and operator financial
  detail.
- **`services/payments/reconciliation/`** is the only module that WRITES a
  discrepancy or runs a repair, and it reaches the domain through the same public
  functions everything else does: `applyPaymentStatus` for a convergence,
  `settlePaymentTransfers` for a withheld transfer, `executeRefundAtProvider` for
  a refund, `insertLedgerTransaction` for a correction. It adds no second write
  path, which is what makes an operator surface safe to expose at all.

### Payment state and order state may differ, briefly

A payment reaching `succeeded` commits in Postgres with its ledger postings and
its outbox row. The orders it funds move to `paid` afterwards, from the outbox
handler. The window is normally milliseconds — `applyPaymentStatus` drains the
row it just wrote, inline, claiming the same lease the poller would — but it is
real, and a task dying mid-window changes only how long it lasts.

Collapsing the two into one transaction is not simply a matter of both living in
Postgres now: the same handler is run by `applyPaymentStatus`'s inline drain AND
by the poller, and the poller has no payment transaction to join. Leaving the
window explicit is what keeps the reconciliation path real.

---

## The outbox

The moderation outbox's semantics, ported to Postgres, deliberately down to the
column names so the two claim queries are the same query.

- **Deterministic ids.** `payment:payment_succeeded:<paymentId>`,
  `payment:payment_failed:<paymentId>:<providerEventId>`,
  `payment:payment_refunded:<refundId>`, and so on. Where a fact can legitimately
  happen more than once — a payment failing, being retried and failing again —
  the id carries what distinguishes the occurrences.
- **The row IS the job.** No queue, no detached promise. Both evaporate on a
  restart, and payment consequences that evaporate do so silently.
- **The enqueue is a genuine no-op on a repeat.** `on conflict (id) do nothing`.
  A `do update` would be a write nobody needed, contending with the
  dispatcher's live lease on the same row.
- **Claims are leases with an owner check.** `FOR UPDATE SKIP LOCKED`, so N tasks
  drain concurrently without contending, and a dead task's lease is reclaimed
  rather than stranding the row.
- **Backoff is exponential, capped at six hours**, and after 25 attempts (or on a
  non-retryable failure) the row becomes a VISIBLE `dead_letter` rather than
  accumulating attempts nobody reads.
- **The LOOP is gated, never the record.** Rows are written whatever
  `PAYMENT_OUTBOX_ENABLED` says, so switching the dispatcher off during an
  incident parks work and switching it on delivers the backlog.

An event type this version does not handle THROWS rather than completing as if
handled, so during a rolling deploy the task running the newer code claims it.
Every declared type has a handler, so that branch is reachable only by a row a
NEWER image wrote — which is exactly the case it exists for. Two declared types
have a handler and no producer on the current rail: `payment_disputed` (until the
router handles `charge.dispute.*`) and `transfer_changed`, whose producer was the
deleted Stripe router's `transfer.*` handler — Peable sends no transfer events,
because a transfer and its reversals are Mercaria's own calls, recorded from
their answers.

---

## The Peable event ingress

One endpoint, `POST /webhooks/peable` (`routes/peable-webhook.ts` →
`services/payments/peable/ingress.ts`), mounted in `app.ts` BEFORE
`express.json()` beside the other raw-body webhooks, because the gateway signs
the exact bytes it sent (`Peable-Signature`). One path where the direct rail
needed two: the gateway signs everything with one secret, so there is no scope
to check and no wrong endpoint to arrive at. Merchant billing's subscription and
invoice events (#89) arrive on the same path.

**The MOUNT is gated on `PEABLE_WEBHOOK_SECRET`** — the webhook-mount rule: an
unconfigured deployment answers 404, because without a secret nothing could be
verified, so there is nothing to park. `peable-webhook.integration.test.ts`
asserts the raw-body mount against the REAL middleware chain, including a
vacuity guard that mounts the same router behind `express.json()` and requires
it to fail.

### The order of the ingress, and what each step may leave behind

1. **Verify** over the raw bytes, trying the current secret then the previous one
   (the rotation window). The body must decode as UTF-8 losslessly first, so
   altered bytes cannot authenticate as the same replacement character. Failure →
   **400, nothing persisted**. Storing an unverified body would put an attacker's
   chosen `(provider, account, event id)` into the dedupe key, after which the
   real event carrying that id is silently swallowed as a duplicate.
2. **Filter on `livemode`.** The gateway serves test and live side by side and
   every event names its mode; this deployment's mode is DERIVED from
   `NODE_ENV === 'production'`, never configured. Mismatch → **200
   `livemode_mismatch`, nothing persisted**; 200 because the gateway must stop
   retrying something that will never be accepted.
3. **Store the envelope**, redacted through `redactProviderPayload`, with the
   object ids (`payment_intent`, …) in their own UNREDACTED column so correlation
   never depends on the redacted summary. The insert IS the dedupe claim; a
   redelivery loses to the unique index, answers 200 and has no side effects.
4. **Process**, inline, through the same durable claim the poller uses.

**A 200 means STORED, never PROCESSED.** Processing failing never changes the
answer: the row is durable, so it is retried with backoff and eventually
dead-lettered, whereas a 500 would ask the gateway to redeliver an event Mercaria
already has.

### The event row is the job — there is no second queue

`payment_provider_events` carries `next_attempt_at`, `lease_owner`,
`lease_until` and `processing_note`, so claiming one is the same
`FOR UPDATE SKIP LOCKED` claim `payment_outboxes` uses (`event-processor.ts`,
`drainPeableEvents`; the poller is `event-dispatcher.ts`, started on every task
whenever the webhook secret is set, and it claims only `peable` rows). Writing an
outbox row that says "please interpret the event row I just wrote" was rejected:
it makes one delivery into two durable records that can disagree, and the
retentions differ on purpose — outbox rows are swept at 14 days, events at 90.

`PEABLE_EVENT_MAX_ATTEMPTS` is 8 against the outbox's 25, on purpose: an outbox
row is Mercaria's own consequence and the only way it will ever happen, while an
event Mercaria cannot interpret is one the gateway is also retrying and whose
object can be re-read.

`replayPeableEvent(eventId)` reopens a `failed` or `dead_letter` row and runs it
again. It resets only WHEN the row may be claimed — never `attempts`, never the
envelope — so the trace still shows how often it had been tried. It is exposed at
`POST /internal/payments/events/:id/replay`; `peableWebhookStats()` is on
`GET /health` under `payments.webhooks` (when `PEABLE_ENABLED`) and again on
`GET /internal/payments/metrics`.

### What the router does with each type

`event-router.ts`. The handler map is DERIVED from `PAYMENT_STATUS_FOR_EVENT` in
`verify.ts`, so the map the verifier annotates an envelope with and the map the
router acts on cannot disagree.

| Event | Applied as |
|---|---|
| `payment_intent.requires_action` / `.processing` / `.succeeded` | that status, through `applyPaymentStatus` |
| `payment_intent.payment_failed` | `failed` (a card returns to `requires_payment_method` at the gateway and the buyer may retry) |
| `payment_intent.canceled` | `canceled` |
| `charge.refunded` | RE-READ through the rail's `getStatus`: refunds are not intent statuses, so whether the payment is `refunded` or `partially_refunded` is the gateway's cumulative answer, never the redacted payload |
| merchant billing types | `billing/peable/events.ts` (`docs/merchant-plans.md`) |
| anything else | stored as evidence, no handler |

A `payment_intent.*` event is not re-read: the event type IS the assertion, and
`applyPaymentStatus`'s compare-and-swap discards a late duplicate. Correlation is
`objectIds.payment_intent` → the payment row; an event whose payment row is not
visible yet throws RETRYABLY (the gateway can deliver before the transaction that
wrote the row is visible to this task), and an envelope with no intent id is
`ignored`, not retried.

A status the payment cannot legally reach is **`deferred`, logged at `error`,
and not retried** — neither side moves on its own, so a retry would never
resolve it. The case that matters is the gateway reporting `succeeded` for a
payment Mercaria already `canceled` (a capture for a reservation that timed out
and whose orders were released). Nothing is committed, booked or fulfilled
(re-committing stock would oversell it; booking with no orders left would credit
`commission_revenue` with the whole gross). The direct rail's router also raised
a `payment_succeeded_after_release` outbox row for it through
`flagSucceededAfterRelease`; the Peable router does not, so on this rail the
condition is visible as the deferred event row and its log line (and as a
`payment_provider_paid_local_unpaid` discrepancy if an operator refetches the
payment). There is deliberately no repair action for it — see "A stuck
reservation, and money that arrived after it".

**The fee gap.** A Peable success books its charge with no processor-fee expense
and no platform conversion: the gateway's events carry neither, so
`applyPaymentStatus` gets no `feeMinor` and no `platform`, and the charge books
in the presentment currency. That is a silent understatement of a Mercaria
EXPENSE (ADR 0001 D5), not a wrong commission — the commission is
`gross − Σnets` and does not involve the fee — and the book still balances
because the fee line is absent rather than unbalanced. Every Peable success says
so in its event row's outcome note, where reconciliation can find it.

### Seams are visible in the trace, never fake handling

Every handler reports `applied`, `deferred` or `ignored` with a note in
`processing_note`. A deferral that said nothing would be indistinguishable from
real handling, and the first person to notice would be a seller asking why their
money never moved.

### No rate limiter, deliberately

The webhook path is mounted before the global limiter and adds none of its own.
`makeRateLimiter` keys anonymous callers by IP, and every gateway delivery
arrives from a small pool of addresses — so a per-IP bucket is ONE bucket for the
whole provider, and the first burst after an incident would be throttled into
redelivery. What bounds the work instead is real: `express.raw`'s 1 MB limit,
refusal before any database access, and a duplicate costing one conflicting
indexed insert.

---

## Seller payment readiness (#46)

`provider_accounts` is the record ADR 0001 D9 calls for: one row per seller per
rail, carrying the connected account and the verdict that decides whether their
listings can be bought. ADR 0009 D14 keeps it in Mercaria because readiness gates
**checkout group construction**, a Mercaria decision made before any rail is
called.

### Onboarding on Peable

A seller is a Peable CONNECTED ACCOUNT of Mercaria's merchant (Peable ADR 0012),
card half only. `services/payments/peable/accounts.ts` is the only module that
knows its shape:

- **Routes.** `GET /admin/stores/:storeId/payments/account`,
  `POST …/account/onboarding-link` and `POST …/account/refresh` (behind
  `store:manage`), and the same three under `/seller/payments/*` for a P2P
  seller, where the caller IS the owner. The owner comes from the route, never
  the body; the body carries only an optional two-letter `country` (strict —
  anything else is a 400), needed once, before the account exists. Which
  countries can be onboarded is Peable's answer, not a list here.
- **Opening.** `connectedAccounts.create` with `external_ref` = the seller key
  (`store:<id>` / `user:<id>`), `business_type` from the owner kind. Peable
  converges a repeated create on `external_ref`, which is what makes two racing
  clicks one account; the owner index is the second line. The FairCoin half is
  never requested: a seller's key comes only from the seller (Peable ADR 0012)
  and Mercaria's checkout has no FairCoin rail.
- **When.** Onboarding needs only the gateway's account events to be heard
  (`PEABLE_WEBHOOK_SECRET`, which mounts `/webhooks/peable`), NOT
  `PEABLE_ENABLED`: sellers onboard and reach `ready` first, and only then does
  `PEABLE_ENABLED` let a buyer pay them.
- **The link.** `connectedAccounts.createAccountLink(…, { rail: 'card' })`,
  minted per request and never stored, with `refresh_url` = `return_url` = the
  seller's own settings screen (`DASHBOARD_URL/settings/payments` for a store,
  `WEB_URL/settings/payments` for a P2P seller), composed from configuration.
  Arriving there proves nothing.
- **Readiness from a READ.** `connected_account.updated` on `/webhooks/peable`
  (`peable/seller-events.ts`), the create's own answer and the seller's refresh
  (`connectedAccounts.refresh`, the gateway re-reading the acquirer) all apply an
  account read from Peable — never a payload — through the repository's
  compare-and-swap on the observation time.
- **The D9 verdict** is `services/payments/account-readiness.ts`: payouts
  enabled, `transfers` active, Peable calling the account `payable`, nothing
  currently or past due, no disabling reason. `payable` is a conjunct because
  Peable refuses a transfer to an account it does not consider payable.

The dashboard's **Payments & payouts** screen (`settings/payments.tsx`) asks the
owner for the country once, opens the link in the system browser and calls
`refresh` when it closes. The storefront has no P2P payments page yet (P2P
selling has no storefront entry — `/sell` is awaiting a product decision); the
P2P routes are live for it.

### One account per owner, and the index that enforces it

`UNIQUE(provider, owner_type, owner_id)`. That constraint is the whole reason the
owner is ONE polymorphic column rather than the mutually-exclusive pair `orders`
uses — the pair cannot express this uniqueness in a single index at all, and this
is the constraint that stops a seller attaching a second connected account, or
somebody else's. Whatever writes the Peable rows must also derive its provider
idempotency key from the OWNER, not a freshly-minted row id: a Mercaria row can
be deduplicated after the fact, and a provider account cannot be un-created.

### Readiness is ONE stored verdict

The D9 conjunction is collapsed into `onboarding_state`
(`not_connected | action_required | under_review | ready | restricted |
disabled`). There is deliberately no `ready` boolean beside it: two
representations of one fact can disagree, and the one place that must not happen
is a checkout gate admitting a seller because a flag was stale. `restricted` and
`disabled` are distinct because one is recoverable by the seller and one is not.

Requirements are stored as COUNTS, a deadline and filtered reason codes — real
columns, not a summary object, so an integer column cannot hold
`individual.verification.document`. The deleted Stripe sync also shape-checked
reason codes (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, else `other`); the database
refuses only an empty code, so `safeReasonCodes` filters Peable's the same way.

### The checkout gate

`assertSellerGroupsPaymentReady` runs in `checkout.service` after the seller
groups are built and BEFORE any inventory is reserved (ADR 0001 D4). Refusing
after a reservation would hold somebody else's stock for the length of a rollback
on a question that needed no stock to answer. The refusal (`seller_not_payment_ready`)
names the seller keys, so a buyer can deselect that group through the existing
partial-checkout mechanism without a second round trip.

It lives in `services/payments/provider-account.service.ts`, which knows what a
seller key is and what `ready` means and NOTHING about an adapter — because
`checkout.service` importing one would make the card rail structural to placing
an order.

**When no native rail is configured the gate returns before touching Postgres**,
so a deployment without `PEABLE_ENABLED` places orders exactly as it did before
#46. With it on, the gate admits exactly the sellers whose Peable account has
reached `ready`. Both branches are pinned: the off branch in `checkout.service.test.ts`
(`expect(findProviderAccountByOwner).not.toHaveBeenCalled()`), the on branch in
`checkout.payment-gate.test.ts`, which also asserts `reserve` was never called.

`findSellerAccount` is NOT gated on the rail being configured (ADR 0009 D19):
which account a seller is connected to is a different question from whether this
deployment can charge on it today, and turning a rail off during an incident must
not make Mercaria forget the account.

### The audit trail

A seller account's creation and every change of its verdict write a
`provider_account_changed` outbox row (`peable/accounts.ts`) — the same durable
at-least-once delivery every other payment consequence gets, carrying ids and the
two states, never provider detail. Only the observation that the compare-and-swap
applied announces, so a slower concurrent read never announces a stale move.

---

## Checkout and the card rail (#47)

The path from a full cart to a paid order and a settled seller. Everything below
is ADR 0001 D3/D4/D8/D11 in code; the ADRs are the decision, this is where it
lives. The sequence is the designed one; on today's rail it stops at the gate
(no ready sellers).

```mermaid
sequenceDiagram
    participant B as Buyer (Expo app)
    participant API as Mercaria API
    participant P as Peable
    B->>API: POST /checkout (Idempotency-Key, paymentMethod?)
    API->>API: reprice cart · refuse unready sellers · refuse ineligible currency
    API->>API: reserve ALL groups (all-or-nothing) · one order per seller
    API->>API: Payment record (UNIQUE checkout_group_id)
    API->>P: paymentIntents.create (pi:<paymentId>, rail card, metadata)
    P-->>API: pi_… + its client_secret
    API->>API: empty the cart (AFTER the payment, so a retry can work)
    API-->>B: orders + {paymentId, provider, providerPaymentId, clientSecret, amount, methods}
    B->>P: Peable Elements: client_action, then confirm (web; hosted page on native)
    B->>API: GET /checkout/:groupId/payment-status (poll)
    P->>API: webhook payment_intent.succeeded (signed)
    API->>API: CAS to succeeded · ledger charge_succeeded · outbox
    API->>API: orders → paid · inventory committed
    loop per seller order
        API->>P: transfers.create (tr:<paymentId>:<orderId>, amount Mercaria computed)
        API->>API: transfers row + ledger transfer_created
    end
    API-->>B: payment-status now `succeeded`
```

`resolveCheckoutRail` (`checkout-payment.service.ts`) answers `card | none`. A
request naming no method gets `card` when a native rail is configured and `none`
otherwise; naming `card` on a deployment without one is a 409, never a silent
downgrade; `mock` (dev only, `MOCK_PAY_ENABLED`, hard-off in production) answers
`none` because `POST /orders/:id/mock-pay` funds the group afterwards.
`CheckoutPaymentMethod` is `card | mock` — the `stripe` synonym is gone.

### The two currencies, and why the ledger can change currency at success

The buyer is charged in their PRESENTMENT currency (EUR or USD at launch,
`PEABLE_PRESENTMENT_CURRENCIES`), refused before anything is reserved by
`assertCheckoutCurrencyEligible`, whose message names the eligible set. That list
is what Mercaria BELIEVES the gateway can charge; the gateway's own configuration
is the authority, and a disagreement surfaces as a refusal from Peable rather
than a silently wrong checkout.

When the rail reports a conversion — `payment.platform_*` and its rate snapshot,
written inside the same compare-and-swap that books the charge — the whole charge
books in the PLATFORM currency, because that is where the money is and it is what
lets the transfers close the payable. Booking the payable in USD and paying it in
EUR would leave `merchant_payable` holding a debt that says it was both owed and
paid and never nets to zero. Without a conversion the charge books in the
presentment currency, and so do its transfers. **Peable reports no conversion
today**, so every Peable charge takes the second branch (see "The fee gap").

A rate is never assumed: guessing a 1:1 conversion would book dollars as euros,
and defaulting a fee to zero understates `processor_expense` permanently — which
is exactly the gap the Peable success path records out loud.

### One net, three readers

`seller-net-shares.ts` is the ONLY definition of what a seller is owed: the
exact gross split (`settlement-shares.ts`, largest remainder, weighted by the
orders' own totals) MINUS each order's immutable marketplace-fee snapshot
(#88, below). The ledger credits each order a payable when the charge succeeds,
the settlement step transfers that same figure, and the refund execution
prorates the seller's liability off it; computed a fourth way they would
eventually disagree, and the symptom would be an account that never returns to
zero for an order somebody is looking at.

Converting each order independently is the tempting alternative and leaks: ADR
0001 D3 defines the commission as gross minus the sum of the nets, so any
rounding residue would be reported as commission revenue from nowhere. With the
fee snapshots in, that residual is EXACTLY the sum of the per-order fees —
`Σnets + Σfees = gross`, pinned by a randomized reconciliation test — so
`commission_revenue` receives what the schedule charged and not one unit more.
There is still no commission arithmetic in `settlement-shares.ts` itself, and
no rate anywhere in the settlement path: the fee is read off the snapshot, and
the snapshot alone. **Peable is never asked to split anything** (ADR 0009 D14):
it is told an amount per destination.

### Idempotency: five layers, one charge

| Layer | Mechanism | What a replay does |
|---|---|---|
| Checkout | `Idempotency-Key` → Redis claim (best effort) | returns the original group |
| Orders | `orders_idempotency_key_key` per `<key>:<sellerKey>` | loser rolls back its reservations, converges on the winner's group |
| Payment | `UNIQUE(payments.checkout_group_id)` | one payment record per group |
| Gateway intent | key `pi:<paymentId>` | the gateway returns the intent it already made |
| Transfer | `UNIQUE(transfers.payment_id, order_id)` + `tr:<paymentId>:<orderId>` | one movement per seller order |

The chain only holds because each key is derived from the one above it: the
payment id comes from a unique index, the gateway key comes from the payment id.
A key invented per request would make a retry a second charge.

**Once Mercaria has recorded the intent's id, that intent is READ rather than
re-created** (`resumePayment`, a `ResumablePaymentProvider` capability).
Idempotency keys expire after 24 hours, so a buyer returning to an unpaid
checkout the next day would otherwise be handed a second charge object for
orders the first one can still fund.

**The cart is emptied AFTER the payment is opened.** If opening it fails, the
orders exist and the cart still holds its lines, so re-submitting the same
`Idempotency-Key` reprices, loses to the order unique index, releases the
reservations that second attempt took and converges on the group already created
— which re-opens the same payment. Emptying the cart first would answer that
retry with "Cart is empty" and the error message would be telling the buyer to do
something that cannot work.

### Reservation TTL vs checkout idempotency TTL

Two independent clocks: `RESERVATION_TTL_MS` (15 minutes) is how long stock is
held for an unpaid order; `CHECKOUT_IDEMPOTENCY_TTL_MS` (10 minutes) is how long
Redis remembers a checkout key. Neither derives from the other.

- A `pending_payment` order with an open intent is released by the existing sweep
  when its TTL expires. The sweep cancels the ORDERS first (stock back), then
  cancels the intent through the rail (`cancel:<paymentId>`) — stock never waits
  on a network call to a third party.
- **Payment retries do not extend the reservation.** The clock is the ORDER's
  creation time, which nothing in the payment path writes.
- A declined attempt leaves the intent reusable, so the buyer retries on the
  SAME intent: one charge object, more than one attempt. A CANCELLED intent
  cannot be reused, and the sweep that cancels one has already cancelled the
  orders it funded, so the buyer starts a new checkout.
- The sweep's cancellation is best effort and its FAILURE is information: the
  rail refusing to cancel an intent it already captured means the money beat the
  sweep. Mercaria marks the payment `canceled` locally anyway (it is true — the
  goods were released), and the succeeded event that follows finds a status it
  cannot legally reach (see the ingress's "deferred" case). Nothing is
  re-committed and nothing is refunded without a person.

### The withheld transfer

A seller can lose payment readiness between the buyer paying and the transfer
executing. ADR 0001 D4 calls this Mercaria's controlled analog of a skipped
transfer on a destination charge, and it is the one place the settlement loop
deliberately continues past a failure:

- the buyer's order stays `paid` — the goods are theirs, and un-paying it because
  its seller cannot be paid would punish the wrong person;
- the sibling orders settle normally;
- the transfer row stays `pending` (Mercaria still intends to make it) and a
  `transfer_withheld` outbox row records the reason, per ORDER, because that is
  the grain a resolution acts on;
- the seller's payable stays OPEN in the ledger, which is exactly what "Mercaria
  owes them" means in accounts.

A retryable rail failure is different: it is rethrown, the outbox retries the
whole settlement with backoff, and the orders already settled are skipped.

### The DELIBERATE hold on a high-value transfer

The same withheld shape, reached for the opposite reason: nothing has gone
wrong, and Mercaria is choosing to wait. `services/payments/high-value-hold.ts`
holds a seller's share whose amount reaches `HIGH_VALUE_HOLD_THRESHOLDS` for that
currency (minor units, `EUR:100000,USD:110000`), for `HIGH_VALUE_HOLD_WINDOW_MS`
(72 h by default) from the moment the money became settleable.

It is a REVIEW hold and not a dispute-window hold, and calling it the latter
would be false. A card chargeback can arrive 120 days later and no marketplace
holds a payout that long. What the window buys is the period in which most card
fraud actually surfaces, during which the transfer has not left and Mercaria
loses the goods rather than the goods AND the cash. ADR 0001 D2 puts those
losses on Mercaria, which is why the hold exists at all.

- **The default is NO hold.** A currency with no threshold settles; a protective
  default that froze every payout on an unconfigured deployment would be an
  outage that reads as caution.
- **The decision is made ONCE**, by whichever caller's `createOrGetTransfer`
  insert won, and recorded in `transfers.held_until`. Settlement re-entered by
  an outbox retry reads the column instead of re-deciding. Without that, a
  reviewer's release would be silently re-imposed by the very settlement they
  ran to apply it, and a threshold changed later would move a hold already in
  force.
- **A hold with no releaser is a payout that never arrives**, so the two ship
  together. Two things end one: the `withheld_transfers` sweep once the window
  passes, and `retry_withheld_transfer`, which IS the review and releases early.
  Readiness still applies either way.

`transfers.held_until` is cleared when the hold is spent, whatever settlement
then decided. That is what makes the sweep terminate: a release that runs into a
permanent failure leaves an ordinary withheld transfer with an open exception,
which the sweep never selects again.

### Client integration

**The storefront's card step** is `components/payment/CardPaymentStep{,.native}.tsx`
behind one contract (`types.ts`), used by the checkout and the supervised-shopping
checkout alike, for guests and account buyers alike (ADR 0006 G1/G2). On the WEB
it mounts Peable's Elements from `@peable.to/sdk/checkout` (the browser entry
only): the Express Checkout element, narrowed to the wallets the handoff's
`methods` permit, above the Payment Element, styled from the Bloom theme, and
`confirmPayment` with a redirect only when the bank insists — back to
`/checkout/return`, which strips the acquirer's return parameters and only polls.
The SDK exchanges the handoff's PaymentIntent and secret for the acquirer's
credential and publishable key at the gateway itself; nothing of the acquirer's
passes through Mercaria. On iOS and Android there is no native card path in
Peable's SDK (its Elements and `checkout/ui`'s `PeableProviderFields` are DOM
fields; the latter renders "unavailable" without a `document`), so the step opens
Peable's hosted page, `checkout.peable.to/i/:pi#client_secret=…`, in the system
browser and never reads the browser closing as an outcome. Either way the screen
polls `GET /checkout/:groupId/payment-status`, which answers from the payment
aggregate — a value only a verified webhook (or a live rail read) moves. The
states it renders are the honest ones: confirming (`requires_action` and
`processing` as one sentence, because from the buyer's side both mean the bank
has not finished), succeeded, cancelled and failed (a decline, recoverable with
another card). The intent is created with `payment_method_types: ['card']`, so
the Payment Element offers no asynchronous method ADR 0001 D3 excludes.
`PeableElement.on` does not type the Express Checkout `confirm` event, so the
step widens that one listener (ADR 0009 D13 "As built"). Apple Pay on the web
shows only once `mercaria.co` is a registered Peable wallet domain (`pmd_…`),
which nothing in this repository does.

The handoff is `CheckoutPaymentHandoff` = `{paymentId, provider,
providerPaymentId, clientSecret, amount, methods}`: `providerPaymentId` is the
gateway PaymentIntent (`pi_…`) and `clientSecret` ITS `client_secret` — exactly
the `{ id, client_secret }` the payer SDK mounts on — never the acquirer's
confirmation secret in the intent's `client_action`. A resumed payment hands back
the same pair. There is no `publishableKey` (a server credential must never
reach a buyer's browser, and Mercaria reaches Peable with its Oxy workload
identity and holds no Peable key at all) and no `returnUrl`. The checkout
request schema is `.strict()`, so a client that sent a card field would be
refused rather than silently stripped.

### Feature flags, honestly

- **Environment** — `PEABLE_ENABLED`. Off (or half-configured) means no card
  rail: checkouts answer `none` and place orders as before. Merchant billing (#89)
  needs only `PEABLE_WEBHOOK_SECRET` (`docs/merchant-plans.md`).
- **Country and cohort** — the seller-side readiness gate IS the cohort. Which
  countries a seller may onboard in is the gateway's constraint, deliberately not
  restated here (there is no seller-country list in `config/index.ts`).
  Buyer-side, `PEABLE_PRESENTMENT_CURRENCIES` bounds which carts are chargeable.

A separate cohort system would be a second, drifting answer to a question those
two already answer.

---

## Guest checkout on the card rail (#107, ADR 0006)

What changes when the buyer has no Oxy account: **almost nothing, and the
"almost" is the whole section.** ADR 0006's rail-neutral decisions bind the
Peable rail. After `middleware/commerce-actor.ts` resolves the actor, a guest
payment is byte-for-byte the payment ADR 0001 defined — the same intent per
checkout group, the same immediate capture, the same `seller-net-shares.ts`
split, the same transfers, the same ledger, the same refund and dispute paths.
`openCheckoutPayment` derives its amount from the group's ORDERS and its
idempotency key from the payment row; neither input mentions a buyer, and the
adapter's `CreatePaymentRequest` has no buyer parameter to widen. A
`guest-*.service.ts` under `services/payments/` would be wrong by construction
(ADR 0006 G1).

Code: `services/payments/guest-correlation.ts` (the one seam onto
`guest_checkouts`), `services/checkout/guest-rollout.ts` (the kill switches and
the #85 seam), the `guestCheckoutId` metadata key and the payment-surface set in
`services/payments/checkout-payment.service.ts`, and the
`guest_portal_initialization` outbox type. There is no guest-specific client
payment surface: the card step above is one component for both.

### The four things that ARE guest-specific

**1. One metadata key.** The intent carries `guestCheckoutId` — the
`guest_checkouts` row id — on a guest-origin group and nothing else new (ADR
0006 G7). It is the correct value to carry precisely because it is inert: it
authorizes nothing, it OUTLIVES the guest session (which is purgeable), and it
is deterministic on replay because the row is `UNIQUE` per checkout group. That
last property is load-bearing — a converging retry must compose a byte-identical
request under the reused `pi:<paymentId>` key, and this is the one key whose
value comes from a second table. It is therefore READ from the group inside
`openCheckoutPayment` rather than passed in: the converge path reaches that
function with a group it did not create and no contact record in hand.

`buildPaymentMetadata` runs its output through TWO independent gates, which
fail differently. The `PAYMENT_METADATA_KEYS` allow-list catches a key nobody
thought about (a spread, a widened input type); the
`FORBIDDEN_PAYMENT_METADATA_SUBSTRINGS` scan catches one somebody added on
purpose under a plausible name (`buyerEmail`, `guestSessionId`, `portalToken`).
Both THROW rather than filtering: a key that should not exist is a defect in the
composition, and dropping it silently would let the defect ship.

**2. A presentment currency that rides the QUERY STRING.** A guest has no
preferences row, so without a way to say what they were shown their cart prices
in the marketplace default (FAIR), which ADR 0001 D8 makes unroutable through
the rail. The carriage is `POST /checkout?currency=EUR`, the same one `/cart`
has used since #104, and deliberately NOT a body field: `checkoutSchema` refuses
`amount`, `paid`, `paymentStatus` and `currency` alike, because a body able to
carry any of them is the surface on which one would eventually be trusted. What
the parameter selects is a currency the SERVER already permits —
`assertCheckoutCurrencyEligible` refuses anything outside
`PEABLE_PRESENTMENT_CURRENCIES` before a unit is reserved — and every figure is
still computed by the pricing engine from native catalogue prices at server-held
rates. It is IGNORED for an Oxy buyer, whose stored preference stays the one
authority.

**3. A durable handoff to #108 on verified success.** The `payment_succeeded`
handler enqueues ONE `guest_portal_initialization` outbox row per guest-origin
checkout group, keyed `payment:guest_portal_initialization:<checkoutGroupId>`,
carrying the group id, the guest checkout id and the order ids — and creates NO
access credential. A grant token minted inside payment processing would exist
while the intent's metadata is being composed, and ADR 0006 B4 says no token may
ever be in a position to reach it. Minting strictly after a verified event, from
a consumer of this row, makes "it cannot be in metadata" a fact about the call
graph. It is enqueued BEFORE settlement, deliberately: a rail refusing transfers
must not also be the reason a buyer cannot find their purchase. Keyed on the
GROUP because one portal grant covers every sibling of a multi-seller cart.

**4. Payment surfaces the SERVER names.** The handoff carries
`methods: CheckoutPaymentSurfaceMethod[]` — `card | apple_pay | google_pay |
link` — from `CHECKOUT_PAYMENT_SURFACE_METHODS`. The server names an upper bound
and the DEVICE narrows it: only the client knows whether a wallet sheet exists on
this machine, and only the server knows whether an operator switched a wallet off
mid-incident. A client cannot ADD a surface the server withheld, and the server
cannot force one the device cannot show. `checkoutPaymentSurfaces()` takes NO
arguments, which is the version of "buyer origin cannot change it" (B11) a
reviewer can check. The setting is read on every rail: which surfaces a client
may render is a checkout fact, not an acquirer one.

**No saved payment methods (G4/G5).** No provider customer is created and no
future-usage setup is requested, so saving is absent by construction rather than
hidden behind an option. Saving requires an account context in which the same
person can later see, use and delete the stored method, and a `GuestSession` is
a purgeable device credential.

### The rollout kill switches, and what they may not reach

Five independent levers (#107 acceptance 13), four of them in
`services/checkout/guest-rollout.ts` and every one a BLOCK list that is EMPTY by
default, so the module is a no-op on a deployment that has configured nothing:

| Lever | Dimension | Notes |
|---|---|---|
| `GUEST_CHECKOUT_BLOCKED_PLATFORMS` | platform | `web` / `native`, derived from the credential's CARRIAGE (cookie vs header), not from a name a client chose |
| `GUEST_CHECKOUT_BLOCKED_MARKETS` | market | ISO-3166 alpha-2; composes with `CHECKOUT_DESTINATION_COUNTRIES` rather than replacing it |
| `GUEST_CHECKOUT_BLOCKED_SELLER_KEYS` | merchant | `store:<id>` / `user:<id>`, matched byte for byte — a key embeds a uuid |
| `GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS` | fulfilment | `standard` / `express` / `pickup` |
| `CHECKOUT_PAYMENT_SURFACE_METHODS` | payment method | deployment-wide, not guest-scoped, and `card` cannot be removed |

Block lists rather than the allow-lists the rest of the checkout path uses,
because these are incident levers: turning one market off at 3am must be adding
one value, not enumerating the thirty that stay on, and an allow-list with a typo
silently switches everything else off. The payment-method dimension is
deployment-wide because ADR 0006 G2 puts both actor kinds on one client surface:
a wallet that is broken is broken for everybody, and a guest-only lever would be
a second answer drifting from the first.

**A refusal names no lever.** All four dimensions raise the same sentence under
one reason code (`guest_rollout_blocked`), because a refusal that named the
dimension would let a client map the switchboard by varying one input per
request. WHICH lever fired is logged, beside the operator who set it.

**None of them gates anything durable** (ADR 0006 G17). Every lever is read at
the checkout REQUEST and by nothing in the webhook ingress, the outbox,
settlement, refunds or reconciliation, so a guest checkout switched off while an
intent is open drains to a terminal state exactly as it would have.
`guest-card-checkout-isolation.test.ts` fails the build if a module in those
paths learns to read `config.guest`. **`PEABLE_ENABLED=false` is NOT a guest
rollback lever**: it disables the whole card rail for every buyer.

### The #85 gate, CLOSED

`readGuestSellerActivation` is the ONE function that decides whether a seller
may sell to a guest beyond what payment readiness already decided. It shipped as
a SEAM; #85 landed: the read lives in
`services/merchant-activation/guest-activation.ts`, and `activated` means the
GUEST CONJUNCTION holds — payment readiness plus the twelve facts #85 guest 2–14
name (`docs/merchant-activation.md`). `guest_seller_not_activated` stays separate
from `seller_not_payment_ready` because one seller cannot be PAID and the other
has not been ACTIVATED, and a merchant sent to the wrong screen stays stuck.

`GUEST_SELLER_ACTIVATION_REQUIRED` still decides whether the question is ASKED
and still defaults OFF, ADR 0006 G14's decision: guest eligibility at launch is
the intersection of the gates that already exist, and a separate per-merchant
guest opt-in list would be a second, drifting answer. There is no column anybody
can set to `activated`, and the early return keeps the default path free of a
database read.

#85 additionally added `seller_not_activated` — the AUTHENTICATED path's own
reason code, for an operator hold, a merchant's own pause and an unaccepted fee
schedule. "Guest checkout is off for this store" and "this store is not selling
at all" are different facts.

### What a guest still cannot do

**P2P is refused** at group construction (ADR 0003 D18 / ADR 0006 G18), and
there is deliberately no flag for it — #112 owns any reversal and its evidence.
**A guest is never routed to `/orders/...`** on success: that route is
account-authenticated and would answer 401 to the person who just paid, so until
#108's portal lands the success screen hands over the ORDER NUMBER the buyer
already holds.

---

## Mercaria-retail on the card rail (#123, ADR 0004)

Mercaria sells some items ITSELF and procures them, per order, from a B2B
supplier who ships directly to the buyer. At the payment layer such an order is
indistinguishable from a marketplace charge — `provider: 'peable'`, one intent
per checkout group, immediate capture — because at the payment layer they *are*
the same thing: a card charge Mercaria captured as merchant of record. What
differs is everything around it.

Binding decisions: **ADR 0004** (`docs/adr/0004-mercaria-retail-dropship.md`).
Nothing below re-decides any of them.

### The order

- `orders.commercial_role` is `connected_marketplace | mercaria_retail`, chosen
  before checkout and immutable. `sellerType` gained **`platform`**, and
  `sellerType = 'platform'` ⇔ `commercialRole = 'mercaria_retail'` is a CHECK.
  Both directions matter: a `platform` order marked marketplace would put its
  whole gross into commission arithmetic with no seller to net against, and a
  retail order naming a seller would credit that seller a payable the settlement
  step would then transfer to them.
- A `platform` order carries NEITHER owner column, and that is what makes "no
  connected-seller transfer exists for a retail order" structural: transfer
  creation looks a `provider_accounts` row up by (ownerType, ownerId), and a
  retail order has no owner id to look one up with. Retail is also the one order
  kind the empty `provider_accounts` does not block.
- ONE retail order per checkout group, however many suppliers its lines come
  from — Mercaria is one seller (D5). Multi-supplier splitting happens at the
  PurchaseOrder grain beneath it, which keeps ADR 0001's one-intent-per-group
  invariant intact on a mixed cart.
- Its fee snapshot is `mercaria_retail` / `not_applicable` with a **NULL fee,
  never a zero** — a zero would read as a schedule that calculated nothing.
- Shop currency IS the presentment currency (D5): Mercaria is the seller, so its
  accounting side and the platform side coincide, and the `fxRate` snapshot is
  the identity. A retail order can be placed with no FX provider reachable.

### The ten-way gate, and where it runs

`services/checkout/retail.ts` owns it, and `checkout.service` calls exactly two
functions there — it never learns what a supplier is. Everything answerable from
configuration and already-loaded rows runs before anything that calls a
supplier, so a refused checkout never spends a provider call.

1. the entry flag and both kill switches (configuration only);
2. the binding's own supply side (one indexed read);
3. #121's verdict — `unknown` is NOT a soft yes;
4. #122's live preflight (the first outbound call);
5. #122's `assertPreflightSatisfiesCheckout` revalidation;
6. #120's compose, which fails closed on an unknown cost;
7. #120's lock, idempotent on `(checkoutGroupId, quoteId)`.

A buyer's refusal names NONE of the ten conditions — one reason code
(`retail_line_ineligible`) covers all of them, because distinguishing them would
let a client read out a supplier's live stock position, Mercaria's wholesale cost
coverage and the operator's incident levers. The condition IS recorded, in the
log line and the operator trace.

**Local inventory is not reserved.** Retail lines are partitioned out BEFORE
grouping, so the readiness gate, the reservation loop, the discount engine and
the fee planner never see one — there is no `if (sellerType === 'platform')`
anywhere in `checkout.service` to delete. The residual oversell risk is exactly
the procurement-failure risk ADR 0004 D4 prices at "compensating refund".

### The money

The allocation runs over ALL the group's orders so the split stays exact; the
PARTITION then decides what each share means. A retail share credits
`retail_cost_recovery` — the ONE ledger account #123 adds; the other four ADR
0004 D7 names arrive with #128 — and is SUBTRACTED from the commission residual.

That subtraction is the load-bearing half. Without it the retail share would
still be booked, as `commission_revenue`, because ADR 0001 D3 defines the
residual as everything the sellers were not owed — and the ledger would balance
perfectly while reporting Mercaria margin on a sale whose planned margin is
zero. The commission is now "the charge minus what the sellers are owed minus
what retail recovered", which is D4 concern 8 verbatim.

### Procurement, and the two directions across the wall

- **Payment → procurement.** A retail order reaching `paid` enqueues one
  `procurement_requested` payment-outbox row per supplier, keyed on
  `(orderId, supplierId)` — the same pair `po:<orderId>:<supplierId>` and
  `retail_procurement_intents_order_supplier_key` derive from, so three
  independent mechanisms converge a redelivered success, a reclaimed lease and
  an operator retry on ONE purchase order.
- **Procurement → refund.** A DEFINITIVE failure (rejected, expired, cancelled)
  announces through `procurement-outcome.port.ts` and enqueues one
  `retail_procurement_failed` row, whose handler creates the compensating refund
  through #49's existing domain. A retryable provider error, an ambiguous
  submission and an unanswered poll are none of those: refunding a buyer for a
  timeout that resolves an hour later refunds them for goods on their way.

Both handlers live in **`services/retail-checkout/`**, not in
`services/payments/`, and reach the outbox through `retail-outbox.port.ts`.
`role-separation.test.ts` (#118) fails the build if anything under
`services/payments/` imports the procurement domain; satisfying ADR 0004 D4 step
4 by importing across it would have widened the gate to admit the REVERSE edge
too, which is the one it exists to prevent. `services/retail-checkout/` is
neither domain, may read both, and nothing in either may call it back.

The port defaults differ deliberately: the authorization reader REFUSES (a
missing authorization must fail closed), the outcome consumer is SILENT (a
marketplace-only deployment has nothing to announce), and the outbox consumer
THROWS (a `procurement_requested` row is a paid buyer waiting to be procured
for, and completing it silently would report success on nothing).

### Cost variance

`retail_cost_variance_records` is the durable reconciliation input #128 BOOKS
and #123 only OBSERVES. It carries no account, no ledger pointer and no
threshold verdict. `direction` is a closed three-member set and its sign
agreement with `delta` is a CHECK, so a `customer_owed` row whose actual
EXCEEDED the lock — a surcharge wearing a refund's name (D8.4) — has no row
shape. The repository DERIVES the direction from the same subtraction.
Append-only by trigger against UPDATE *and* DELETE. Two sources today: a
supplier's acceptance and a cancelled purchase order (attributable cost ZERO, so
the whole locked amount is owed back — recorded beside the refund).

### Configuration

```
MERCARIA_RETAIL_ENABLED=false        # ENTRY only; never the outbox, PO, refund or reconciliation
RETAIL_BLOCKED_SUPPLIERS=            # supplier ids withdrawn from sale, every buyer
RETAIL_BLOCKED_MARKETS=              # ISO-3166 alpha-2 destinations withdrawn from sale
GUEST_CHECKOUT_BLOCKED_SUPPLIERS=    # the #107 guest axes, extended by a supplier one
```

`MERCARIA_RETAIL_ENABLED=true` additionally requires `SUPPLIER_PREFLIGHT_ENABLED`
and a named selling entity (`MERCARIA_RETAIL_SELLER_LEGAL_ENTITY` /
`MERCARIA_RETAIL_SELLER_COUNTRY`) — half-configured is OFF. **No lever gates
anything durable**, and `retail-checkout-isolation.test.ts` fails the build if
the authorization reader, the fulfilment service, the payment outbox handlers or
#124's outcome port learn to read `config.retail`.

### What #123 deliberately did NOT build

- **The buyer-facing UX** (#129) — the offer surface, the "we are confirming
  availability with our fulfilment partner" state ADR 0004 D9.1 requires between
  charge and acceptance, and the cost breakdown.
- **The ledger recognition of variance** (#128).
- **Manual capture.** ADR 0004 D4 selected immediate capture on verified rail
  facts and rejected holding an authorization, so there is no authorization
  window to monitor and no capture to schedule.
- **Supplier payment.** ADR 0004 D6's prefunded balance is a treasury operation
  the app records and never executes; the draw books with #128.
- **The operator surface for bindings.** `retail_offer_bindings` is written by
  the repository and has no HTTP route yet.

---

## Marketplace fees (#88)

How Mercaria's commission is DECIDED. ADR 0001 D3 already decided where it
LIVES (the ledger's residual, `gross − Σnets`); this domain is what makes the
nets smaller than the gross. Code: `services/fees/` (pure calculation +
selection + snapshot planning), `db/fees/` (repositories),
`db/schema/fees.ts` (four tables), `services/payments/seller-net-shares.ts`
(the settlement seam). Schema decisions: `db/schema/CONVENTIONS.md` §"The fee
domain". The fee is a COMMERCIAL agreement with Mercaria, not a property of any
rail, so nothing here changed with the rail.

### The commercial-mode boundary, snapshotted

Every checkout order snapshots its commercial mode BEFORE fee calculation, so a
later catalog or link change cannot reclassify it:

| Mode | Marketplace fee |
|---|---|
| `connected_marketplace` | calculated from the fee schedule (every native checkout today) |
| `external_referral` | structurally not applicable — affiliate economics are #67's, never this schedule |
| `mercaria_retail` | structurally not applicable — #116/#120's zero-markup channel; NEVER posts `commission_revenue` |
| `informational` | no transaction, no fee |

"Not applicable" is a NULL fee, never a zero: the snapshot CHECKs make a
`mercaria_retail` row carrying any fee amount unrepresentable. How a
`mercaria_retail` order IS priced is **`docs/retail-pricing.md`** (#120, ADR
0004 D3), a separate domain on purpose: the retail pricing engine cannot import
the fee domain, which makes "no marketplace fee on a retail order" a property of
the code rather than of a table row.

### Versioned, immutable schedules

`fee_schedules` holds one row per VERSION: key + version, name and merchant
summary, effective window, scope (`eligible_seller_type`, `eligible_currency` —
the COMPLETE scope set; buyer authentication state, guest origin, claim status,
payment-method identity and contact data have no column and never will),
percentage in basis points, optional fixed component and min/max clamps (all
three pin `eligible_currency`, so a fee never mixes currencies), tax-treatment
metadata, the refund policy (`proportional` is the only value that exists),
status (`draft → active → superseded | retired`), terms version, and the
creator/approver audit. A version is editable only as a draft — a database
trigger freezes every economic column from `active` on and refuses DELETE
outright — and a partial unique index allows ONE active version per key, so
activation supersedes atomically. Policy changes are new versions, always.

Operators manage schedules at `/internal/payments/fee-schedules*` (same gate as
the repair surface; nothing there moves money). Merchants read, accept and
preview at `/admin/stores/:storeId/fees/*` behind `store:manage`, because
agreeing to what a store pays Mercaria is the owner's decision.

### The calculation, and the snapshot it becomes

At authoritative pricing time checkout loads the active schedules ONCE (one
instant for the whole group), selects per order on the two scope facts, and
refuses an AMBIGUOUS configuration (two matches) before anything is reserved.
No active schedule is a fine answer: the fee is a real zero, recorded as
`no_active_schedule` so it cannot be confused with a schedule that calculated
zero.

The fee base is EXPLICIT: `discounted_item_subtotal` — presentment-side line
totals minus their item-level discount allocations. Tax, delivery and
shipping-targeted discounts have no parameter, so they cannot enter. The
percentage component rounds HALF-UP once at the order level (the 0-or-1 unit
recorded as `rounding_adjustment_minor`); the fee is clamped by the schedule's
min/max and capped at its own basis; line allocations split the rounded fee by
the settlement domain's own largest-remainder rule and reconcile to it exactly.

The result is written to `order_fee_snapshots` (+ `_lines`) IN THE SAME
TRANSACTION as the order, append-only by trigger: mode, result, schedule
key/version, basis, components, fee, rounding adjustment, the seller's accepted
terms version, the scope facts used, and the calculation time. NOT stored, by
construction: buyer contact, guest tokens, provider customer or wallet identity,
payment credentials. Guest and authenticated checkouts with the same commercial
facts produce identical snapshots because no fee signature takes a buyer — and
a later Oxy claim changes nothing, because nothing can change the snapshot.

### Where the fee meets the money

`deriveSellerNetShares` ("One net, three readers" above) subtracts each order's
snapshot fee from its gross share. On a converted charge the fee converts at the
charge's OWN captured ratio (`fee × platformGross ÷ presentmentGross`, floored) —
deterministic in the payment row, no live FX, so a retry, the settlement and a
refund all derive the identical figure. The commission is still never passed
anywhere: `chargeSucceeded` books the residual, which equals the sum of the
snapshot fees exactly. The provider's processing fee stays a separate
`processor_expense` — the two are different facts and never net.

Refunds implement the schedule's `proportional` policy with NO fee-specific
code path: the seller's cumulative liability prorates their NET share, so
Mercaria's commission on the refunded amount comes back through the refund
posting's residual — all of it on a full refund, pro-rata on a partial one.

### What #88 deliberately defers

POS and connector-imported orders carry NO snapshot (no explicitly selected
channel policy exists for them yet — an absent snapshot reads as zero fee).

**#85 landed the checkout-time acceptance GATE**: it runs at step 4f-bis of
`checkout.service`, over the schedule checkout itself selected, refusing under
`seller_not_activated`, and a deployment with no active schedule is unaffected.
Schedule-change NOTIFICATIONS and downloadable breakdowns are still owed: PUSHING
a message needs the outbound transport #108 owns.

**There is still NO P2P fee-schedule acceptance surface.**
`POST /seller/activation/policies` writes `merchant_activation_policy_acceptances`,
a different table from `fee_schedule_acceptances`, which only
`/admin/stores/:storeId/fees/accept` writes. A schedule's `eligible_seller_type`
is `store`, `user`, or ABSENT meaning both, so `planConnectedMarketplaceFee`
selects for an individual seller exactly as for a store; the gate therefore reads
`user:` groups too and refuses on the same `fee_schedule_not_accepted`
requirement, so a `user`-reaching schedule takes P2P sales offline rather than
billing them silently. Building the surface needs a decision this domain cannot
take alone: a store selects its schedule in `stores.default_currency`, and a
person has no default currency to select in.

---

## Refunds, disputes and payouts (#49)

The money coming BACK. ADR 0001 D7 in code, and one deliberate departure from its
sequence diagram, stated below.

```mermaid
sequenceDiagram
    participant M as Merchant (dashboard)
    participant API as Mercaria API
    participant P as Peable
    M->>API: POST …/orders/:id/refunds (refunds:write)
    API->>API: per-line quantities · discounted net · restock ONCE
    API->>API: ONE txn: refund row (provider_state=pending) + payment_refunded outbox row
    API-->>M: 201 — recorded, money not moved yet
    API->>API: drain the outbox row inline (same lease the poller would take)
    API->>P: refunds.create on the GROUP intent (re:<refundId>, presentment amount)
    P-->>API: refund + the payment's remaining refundable amount
    API->>API: needs the PLATFORM figure → today: retry (see below)
    API->>API: CAS provider_refund_id · ledger `refund` · payment → partially_refunded
    API->>P: transfers.reverse (trr:<refundId>:<orderId>)
    API->>API: CAS provider_reversal_id · ledger `transfer_reversal`
    Note over API,P: a reversal the rail refuses → reversal_failed exception;<br/>the buyer's refund is NOT undone (D7)
```

### The commerce decision commits before the money moves

`refund.service.process` decides: per-line quantities against the DISCOUNTED
net, the cumulative over-refund guard, restock exactly once, the order's status
set directly. When the order was paid through a rail that settled its seller,
the refund row and a `payment_refunded` outbox row commit in ONE transaction,
and `services/payments/refund-execution.service.ts` moves the money from that
row. A provider call living in the request that created the refund evaporates
when the task restarts, and the inventory has ALREADY been restocked by then.

- **A rail being slow or unreachable cannot refuse a refund a merchant
  authorised.** The record commits, the stock is back, the order has moved, and
  the money follows with retries behind it.
- **A refund is `refunded` while its money is `pending`.** Two different facts,
  and the DTO carries both.

**Gap on the Peable rail.** `executeRefundAtProvider` books every refund leg in
the platform figure the rail reports for the refund, and never assumes one. The
Peable adapter's refund result carries no `platform`, so after the gateway
accepts the refund the executor throws `refund_settlement_unavailable`
(retryable): the `payment_refunded` row retries until it dead-letters, the
buyer's money has moved at the gateway, and Mercaria books nothing. Until the
adapter reports the refund's settled figure (Peable's contract has
`refunds.settlement`), a Peable refund needs an operator.

### Three states of one refund, and none stands in for the others

| Field | Question it answers | Reaches its end state |
|---|---|---|
| `Refund.status` | what was approved, what came back on the shelf | at commit, before any money moves |
| `Refund.providerState` | has the buyer been paid | when the rail says so |
| `Payment.status` | where the payment aggregate is | when the CHARGE is fully refunded |

**Order status moves on the COMMERCE record, not on the rail's answer** (#49
invariant 3). The payment aggregate's status comes from the charge's cumulative
refunded amount (`remaining_refundable` on Peable), so refunding one seller's
order out of a multi-seller group reports `partially_refunded` rather than
closing the whole payment.

### The three amounts, and why none is derived from another

| Amount | Where it comes from | Currency |
|---|---|---|
| What the buyer gets back | the refund record's own presentment total — authoritative, never recomputed | presentment |
| What the platform balance lost | the rail's own record of the refund movement | platform settlement |
| What the seller bears | `allocateSellerShares`, prorated by how much of the order has now been refunded | platform settlement |

The seller's share reads the SAME split the ledger credited at charge time and
the settlement transferred. It is read from `allocateSellerShares` and NOT from
the transfer row, deliberately: a withheld transfer means the seller was never
paid, their receivable is still open, and the refund must still reduce it.

**The proration is cumulative, not per refund.** Each step reverses the
difference between where the transfer should stand and where it does, so a
sequence of partial refunds sums to exactly the seller's whole share once the
order is fully refunded. Prorating each refund independently floors each one
separately and strands the last units on the seller's balance forever (pinned
with a CONVERTED charge and an odd share: 3,667 refunded in halves → 1,833 then
1,834).

**Mercaria's own residual is the difference between the second and the third.**
It carries the commission returned on the refunded amount (#88's `proportional`
policy) AND the conversion asymmetry Mercaria bears — a refund converts at the
REFUND-time rate and the original conversion fee is not returned (ADR 0001 D7).
Computing it as a residual is what keeps the seller's leg exactly closable by the
reversal, which makes a failed recovery visible as an open payable instead of a
rounding difference nobody can attribute.

### The reversal-failure policy

A reversal can fail where the refund did not: an insufficient seller balance with
no reserve behind it. ADR 0001 D7 is explicit that the buyer's refund is **not**
blocked on it, so:

- the buyer keeps their money and nothing is undone;
- `reversal_state` is `failed` and a `reversal_failed` outbox row names the
  order, the amount and the rail's reason;
- **the gap is BOOKED, not hidden.** The refund posting debited the order's
  `merchant_payable` and no reversal credited it back, so that account sits in
  DEBIT by exactly what the seller owes Mercaria. The book still balances per
  currency.

Recovery is a decision (wait for their next transfer, recover from the seller's
balance, write it off), not a retry. Sibling orders of the same charge are
untouched (ADR 0001 D4's per-order divergence). `not_required` is a real state:
a transfer that was never made leaves the seller's receivable open, and the
refund posting closes it directly.

### A refund made outside Mercaria

A rail refund with no Mercaria record behind it becomes a `refund_unmatched`
operator exception and creates **no local refund** — doing otherwise would
restock goods nobody returned. Correlation must be by Mercaria's own refund id
FIRST (the adapter sends it as `external_ref`) and the provider id second, never
by amount: an amount match picks the wrong one of two identical partial refunds.

On the Peable rail `refund.created|updated|failed` (`peable/marketplace-events.ts`)
re-read the refund and match it by `external_ref`, then by the recorded gateway
id; no match raises `refund_unmatched` (keyed on the gateway's refund id). A match
moves `providerState` through `applyRailRefundState`
(`refund-execution.service.ts`), whose compare-and-swap is the idempotency, and a
refund that fails AFTER Mercaria recorded it (a bank rejecting it days later)
raises `refund_failed` — both halves need a person. Refunds of a payment that is
not a marketplace payment (a merchant-plan invoice) are billing's and ignored
here. `charge.refunded` still only re-reads the payment's status.

### Provider outcomes never touch inventory

#49 invariant 2. Restock happened once, in `refund.service`, from the lines a
merchant approved. A refund event arriving days later moves money and nothing
else.

### Disputes

A buyer's bank reversing a charge through the card network. Mercaria is the
merchant of record (D1), so the PLATFORM balance is debited and Mercaria answers
the network; the seller bears the principal only once the dispute is lost.
`dispute.service.ts` holds the whole domain below; **nothing feeds it on the
Peable rail yet** (no dispute events), and its only live entry point is the
operator's `retry_transfer_reversal`.

**Disputes are not CrowdSource moderation** (#49 scope 7) and the two never
meet. A dispute is decided by a card network on evidence Mercaria submits against
a deadline nobody here sets; wiring one into the other would put a bank's
chargeback rate into a seller's reputation and a jury's verdict into a financial
ledger. Nothing in `dispute.service.ts` imports moderation, and nothing in
moderation imports it.

| Event | Ledger | Seller |
|---|---|---|
| created (real chargeback) | disputes (D) + processor expense (f), against provider clearing | untouched — a dispute is not yet a loss |
| created (INQUIRY) | **nothing** | untouched |
| closed won | provider clearing, against disputes. The FEE is not returned | untouched |
| closed lost | merchant payable, against disputes | transfer reversed (`trr:dispute:<disputeId>:<orderId>`) |

- **An inquiry is distinguished by the rail's balance MOVEMENTS, not by a status
  string**: it moves no money, so nothing may be booked.
- **Every observation reaches ONE entry point.** The row is upserted and the two
  ledger transitions are compare-and-swaps (`opened_booked_at`, `closed_at`), so
  any arrival order converges.
- **`order_id` is nullable and its absence is a real state.** One charge funds a
  whole checkout group and the network gives no line detail, so a dispute on a
  multi-seller charge is attributed to the PAYMENT only and an operator
  attributes it. Guessing would reverse an innocent seller's transfer.

**The one departure from ADR 0001's diagram.** The ADR reverses the seller's
transfer when the dispute OPENS and re-transfers on a win. That is not
implementable: a re-transfer is a NEW transfer for an order that already has one,
and `UNIQUE(transfers.payment_id, order_id)` exists to make that impossible. So
the recovery runs when the outcome is `lost`, which is also when the loss is
real; D7's prose is satisfied either way.

### Payouts

The rail moving a SELLER's own balance to their bank. Mercaria is not a party to
it, and **the absence of ledger postings is the load-bearing part**: ADR 0001 D6
settled the merchant receivable when the TRANSFER was created, so a failed payout
must not reopen it or Mercaria would owe a seller twice for one order.
`payout.service.ts` records an observed payout, attributes it through
`provider_accounts` and emits `payout_changed`. On the Peable rail `payout.*`
(`peable/marketplace-events.ts`) re-reads the payout AS the seller's account
(`Peable-Account`; a payout is the seller's, not the platform's) and records
what the gateway says, never the payload. A payout names the rail that reported
it (`ObservedPayout.provider`, ADR 0009 D19).

`payouts.amount_currency` carries **no CHECK against `ALL_CURRENCY_CODES`** — the
third such exemption, beside `provider_accounts.default_currency` and
`connections.shop_currency`. A payout is denominated in the seller's own
settlement currency, which the rail chooses; several EEA currencies (RON, CZK,
HUF, BGN) are not in Mercaria's set, and the CHECK would reject the RECORD of a
payout that already happened.

`tracePayment` returns the recent payouts to the ACCOUNTS a payment settled to,
bounded — **not "the payouts that paid these orders"**: a payout batches many
transfers and the rail states no link between them.

### The three outbox exceptions

| Type | Condition | Why it is not automatic |
|---|---|---|
| `refund_failed` | the rail refused or failed the BUYER's refund after Mercaria committed and restocked | re-attempting a declined refund loops; undoing the commerce record would un-restock units that may have been sold since |
| `reversal_failed` | the buyer has their money and the seller's share could not be recovered | no number of attempts creates funds on a seller's account |
| `refund_unmatched` | the rail reported a refund Mercaria never made | creating one would restock goods nobody returned |

`payment_refunded` is the one outbox type here that carries WORK rather than an
announcement — its handler is what calls the rail.

### The merchant surface, and what it never carries

`Refund` carries `provider`, `providerState` and `providerFailureCode`, projected
field by field so a column added later cannot ride along. Absent by design:
`providerRefundId`, `providerReversalId`, `reversalState` and the reversal amount
— whether Mercaria has finished clawing the seller's share back is an operator's
question, answered on `GET /internal/payments/trace`. `providerFailureCode` is
shape-checked (`^[a-z][a-z0-9_]*$`) and dropped otherwise. There is no
buyer-facing refund surface; the guest portal (#108/#110) is where one belongs.
The dashboard's Payments & payouts screen is the store's Peable onboarding
(see "Onboarding on Peable").

---

## Reconciliation, discrepancies and operator repair (#50)

Webhooks are the normal event path. They are **not** a substitute for
reconciliation, and the reason is structural: an event that was never delivered
is invisible to everything that waits to be told. The only mechanism that can
notice one is a sweep that does not depend on having been told — ADR 0001's
sequence 6. A reconciliation must also read through the same port that writes
(ADR 0009 D16): one reading a different source cannot detect a disagreement
between them.

### Three tables, and why none of them is financial history

| Table | What it is |
|---|---|
| `payment_discrepancies` | One disagreement Mercaria has noticed about itself. Deduped on `(kind, correlation_key)`. |
| `payment_repairs` | Every operator action, applied or refused. Append-only, one row per ATTEMPT. |
| `reconciliation_cursors` | Where each sweep had got to, and who is running it. One row per job. |

These take ordinary UPDATEs: a cursor MOVES, and a discrepancy still seen on
every sweep has to say so without opening a new row per run. **Nothing in these
tables is ever an input to an amount**: repairing a discrepancy writes to
`ledger_transactions` through the same repository every other posting uses, so
deleting every row in all three would lose Mercaria's knowledge of its own
mistakes and not a cent of its accounts. None is registered in
`db/expiryTargets.ts`; sweeping an audit trail on a timer is the one thing that
registry must not be used for.

### The three jobs

Each is bounded to one page per tick, resumable from its cursor and idempotent on
a replayed page: the cursor advances only after a page is FULLY handled, and
every finding a replay re-derives lands on the `(kind, correlation_key)` upsert,
which bumps `occurrences` and creates nothing. Runs are LEASED per job
(`for update skip locked` on the cursor row), because two tasks advancing one
cursor would each skip the pages the other consumed.

| Job | Question | Needs a rail | Cursor |
|---|---|---|---|
| `open_payments` | What does the rail say about payments in a non-terminal status whose outcome Mercaria never recorded? | `peable` | the last payment id read (uuid v7, so id order IS time order) |
| `ledger_audit` | Is the book complete, balanced, and explained? | no — reads Mercaria's payments and ledger, every booking rail incl. `mock` | the last payment id checked |
| `withheld_transfers` | Which deliberately held transfers have waited long enough? | no — re-enters settlement through the port | the last transfer id read (uuid v7) |

`JOB_REQUIRES_RAIL` in `runner.ts` is total over the job set, so a new sweep
answers "which rail" at compile time; a job whose rail is not configured is
skipped on its own without stopping the others. `retail_reconciliation` shares
the cursor table, not the runner (`docs/retail-reconciliation.md`).

The direct rail's `provider_objects` (balance-transaction paging) and
`account_readiness` (connected-account re-reads) sweeps were deleted with it:
the port reports statuses only, and there is no gateway listing of settled
movements or seller accounts to read. Mercaria therefore has **no automatic
check today** that every money movement at the gateway has a Mercaria row, nor
that amounts agree — only statuses.

### The one thing a sweep may do on its own

`open_payments` CONVERGES a payment onto what the rail currently says, through
`applyPaymentStatus` — the same function a webhook uses, so the compare-and-swap,
the ledger postings, the outbox row and the settlement that follows are the
webhook path exactly. That is not a violation of "never auto-repair": a live
read through the rail's own `getStatus` IS verified provider evidence — the same
fact a webhook would have carried, minus the delivery — and applying it APPENDS
the accounting that should already exist. It compares STATUSES only and books no
processor fee, exactly as the event path does not.

Both-settled pairs are not discrepancies: a payment Mercaria has at
`refunded`/`partially_refunded` that the rail reports another way is "both
report the charge as settled".

**The reverse direction is never automatic.** Mercaria saying paid while the rail
says otherwise means orders have been marked paid, inventory committed and
sellers possibly transferred; un-paying that would be a second wrong on top of
the first. It becomes `payment_local_paid_provider_unpaid`, `critical`, and waits
for a person. The paging query cannot reach that case (it reads only non-terminal
payments); the operator's `refetch`, which serves any payment named, can.

### The five discrepancy kinds

Each names a distinct operator ACTION. Severity is a property of the KIND,
decided once in `discrepancy.service.ts`, so a detector cannot get it wrong.

| Kind | Severity | Condition |
|---|---|---|
| `payment_provider_paid_local_unpaid` | critical | the rail is ahead; converged, and the row records the lost webhook |
| `payment_local_paid_provider_unpaid` | critical | Mercaria is ahead; NOTHING automatic |
| `ledger_transaction_missing` | critical | a succeeded payment with no `charge_succeeded` |
| `ledger_unbalanced` | critical | a currency's entries do not sum to zero globally |
| `merchant_payable_unexplained` | warning | an open payable with no exception accounting for it |

Nine kinds left with the deleted sweeps (migration `0184`): the four
`*_missing_locally`, the three `*_amount_mismatch` incl. `payment_amount_mismatch`,
`account_state_drift` and `account_sync_failed`.

### Operator surface

`/internal/payments/*`, mounted OUTSIDE `/admin`.

| Route | What it does |
|---|---|
| `GET /trace?orderNumber=\|orderId=\|checkoutGroupId=\|paymentId=\|providerObjectId=` | the whole record: payment, attempts, events, transfers, payouts, refunds, disputes, ledger, discrepancies, repairs |
| `GET /exceptions` | open discrepancies + the outbox exception types, filterable |
| `GET /metrics` | the fuller counts `/health` only summarises |
| `POST /events/:id/replay` | `replayPeableEvent` |
| `POST /refetch` | re-read one payment through `resolvePaymentProvider(payment.provider).getStatus` — the sweep's single-item path |
| `POST /repairs` | one of the four named repairs |
| `POST /discrepancies/:id/resolve` | close an investigation with an actor and a reason |

The whole router is metered on the dedicated `payments` rate-limit scope:
`refetch` and every repair make live rail calls.

**Authorization is an Oxy APPLICATION ROLE, `payments.operate`, not a store
permission.** Store permissions are scoped to a STORE by construction
(`requireStorePermission` reads `req.storeAccess`, resolved in the Oxy account
that owns THAT store). This surface reads across every store and every P2P
seller, so no store's owning account could authorize it, and no store permission
could express "may see all stores' money" without becoming one a store owner
could grant themselves. `payments.operate` is declared in Mercaria's entry of
oxy's first-party registry (oxy ADR 0056), held by the owners and admins of the
`oxy` organization, and `requirePaymentOperator` (`middleware/operator-authz.ts`)
asks Oxy with the caller's own bearer. There is no per-person grant.

The router is mounted on every deployment. Anyone without the key — including a
service token — gets 404; a non-holder also leaves a `warn` line naming them. An
Oxy that cannot answer is 503 and is never remembered as a "no". Writes ask Oxy
fresh, and the actor recorded on a repair is the human operator
(`req.oxyAppPermissions.operatorId`).

**A trace can be opened from five handles and no others.** There is no `email`,
no phone, no card fingerprint and no provider customer — none of them can
authenticate a Mercaria buyer or claim a Mercaria order (#45 buyer boundaries),
and a resolver able to reach them is the surface where they would eventually be
used. `tracePayment`'s own signature has that property; the `.strict()` query
schema stops an HTTP caller getting around it.

### The four repairs, and the rule none of them may break

A CLOSED set. Every action is a named path through code that already exists and
is already idempotent, so this surface adds a TRIGGER and no new way to move
money. An endpoint taking a table, a row and a patch would be a second,
unreviewed write path into the financial record.

| Action | What it does | Where its idempotency comes from |
|---|---|---|
| `retry_withheld_transfer` | reads the seller's STORED account (the row `settlePaymentTransfers` consults), then runs the real settlement | `UNIQUE(payment_id, order_id)` + `tr:<paymentId>:<orderId>` |
| `retry_transfer_reversal` | re-attempts the seller-side recovery of a refund or a lost dispute | `trr:<refundId>:<orderId>` / `trr:dispute:<disputeId>:<orderId>` |
| `retry_provider_refund` | re-opens a rail-refused refund and re-issues it | `re:<refundId>` |
| `book_reconciling_entry` | books a balanced `adjustment`, with a mandatory reason and discrepancy | a PARTIAL UNIQUE INDEX on `payment_repairs` |

**No repair may mark a payment successful without verified provider evidence,
and that is structural.** Nothing in `repairs.service.ts` calls
`applyPaymentStatus`. The three retries reach a payment's status only through a
service that calls it after a live provider RESPONSE, and the fourth never
touches a status at all. Two of them additionally refuse outright unless the
payment is already settled.

**Only `book_reconciling_entry` records a claim.** The three retries derive
their provider keys from Mercaria's durable ids (ADR 0001 D11), so a second
attempt converges on the movement the first made — a claim would REFUSE the
legitimate second attempt after a failure, which is exactly when an operator
reaches for a repair. A correcting ledger transaction has no such key, so its
claim lives in the index, taken in the same transaction as the posting.

**Every attempt is recorded, including refusals.** A 409 an operator sees always
has a `payment_repairs` row behind it with the actor and the reason. The reason
is MANDATORY and its minimum length is real.

### Metrics

`GET /internal/payments/metrics`, operator-gated, plus a coarse summary on
`/health` under `payments.discrepancies` and `payments.webhooks` (when
`PEABLE_ENABLED`) — counts and an instant, no personal data by construction.

No metrics infrastructure, deliberately: every number is an aggregate over a
table already indexed for it, so a counter library would be a second in-memory
copy of facts the database holds authoritatively. **Scraping and alerting wiring
belongs to `oxy-infra`**, not here.

The one number that cannot come from a table is **`ledgerImbalanceAttempts`, and
it must stay ZERO.** It counts refusals by `insertLedgerTransaction`, a write
that ROLLS BACK — so a row recording it would be lost exactly when it fired. It
is process-local and per task; a non-zero value is unambiguous anyway.

---

## Retention

Postgres has no TTL index. `db/expiryTargets.ts` is the registry
`sweepAllExpiredRows` reads; a table with an `expires_at` and no entry there grows
forever with no error and no failing test.

| Table | Retention | Measured from | Why that long |
|---|---|---|---|
| `payment_outboxes` | 14 days | Enqueue | A job stuck for a fortnight will not succeed on day fifteen. The payment stays visible in `payments.status`, which is where a stalled dispatcher must be noticed. |
| `payment_provider_events` | 90 days | Receipt | Past the gateway's redelivery schedule and past the dispute windows these events describe. After it, a re-arriving event is genuinely new — and re-processing it is a no-op anyway, because the status CAS finds nothing to change. |

Everything else is permanent. `payments`, `payment_attempts`, `transfers`,
`payouts` and both ledger tables are the financial record: buyer access
revocation never deletes or hides them (#45 invariant 12).

---

## Providers

`PAYMENT_PROVIDER_IDS` in `@mercaria/shared-types` is the closed set, and it is
short on purpose — a provider is added together with its adapter and its
migration widening the CHECK, never in advance. A value the database accepts but
no adapter can produce is an invitation to write a row nothing can reconcile;
that is why `'stripe'` left the ten provider CHECKs with its adapter (`0184`).

| Provider | Adapter | Books ledger entries | Semantics |
|---|---|---|---|
| `external` | none | **No** | Captured on Shopify/WooCommerce. Recorded so the order is explicable; no Mercaria money moved (ADR D12). |
| `manual_pos` | none | **No** | Cash or a card terminal at a register. The money is in the merchant's drawer and never passes through Mercaria. |
| `mock` | `SyntheticPaymentProvider` | Yes | The dev seam and the contract suite's subject. Hard-gated by `config.orders.mockPayEnabled`, off in production. |
| `peable` | `PeablePaymentProvider` (`services/payments/peable/`) | Yes | The card rail (ADR 0009). Mercaria is merchant of record (ADR D1), so money arrives on the platform balance and each seller's share is a payable. Settling and resumable; `authorize` and `capture` reject non-retryably (the buyer authorizes client-side, capture is immediate). |

`external` and `manual_pos` having no adapter is the distinction the set encodes:
they are payments Mercaria RECORDS, not payments Mercaria makes. `PROVIDER_BOOKS_LEDGER`
in `payment.service.ts` is an explicit table rather than a `provider === 'external'`
test, because the question is "did Mercaria receive and owe this money".
`native-rail.ts` holds the other two records total over the set (is the rail
configured; can it serve a native checkout), so a new provider cannot compile
without answering both.

**A store-side cash view for POS is a later product decision.** If it is ever
wanted it is a STORE's ledger, not Mercaria's — booking register cash into
Mercaria's accounts would put money there that Mercaria does not have.

### The contract suite

`services/payments/__tests__/provider-contract.ts` exports
`runPaymentProviderContract`, which every rail runs (`synthetic-provider.test.ts`,
`peable-provider.test.ts`). It pins the properties the service relies on: the
happy path reaching `succeeded` and refunding to `refunded`, a partial refund
landing on `partially_refunded`, idempotency under a repeated key, a failure at
each stage arriving as a `PaymentProviderError` with a `retryable` flag, a bad
signature refused non-retryably, and duplicate/out-of-order events converging.

Failure injection and event signing are OPTIONAL capabilities, so those arms
skip rather than fail. `settle` drives a payment to `succeeded` however that rail
does it, defaulting to `capture`. `unsupported` declares the operations a rail
structurally lacks — and it INVERTS the check rather than skipping it: the suite
asserts each rejects non-retryably with the declared reason. A rail that quietly
returned a plausible result from an operation it never performed would pass a
skipped test and fail a real customer.

**The suite covers `PaymentProvider`, not `SettlingPaymentProvider`** (ADR 0009
D18): there is no contract test for `createTransfer` / `reverseTransfer`, the
half that moves sellers' money; `peable-provider.test.ts` covers the adapter's
settlement calls on their own.

---

## Redaction and logging

`services/payments/redact.ts` reduces a provider payload to the ids, amounts,
currencies, statuses and timestamps Mercaria may keep. It is an **allow-list**,
and it has to be: a deny-list of known-sensitive keys is correct only until the
provider adds a field, which is exactly when a new sensitive field appears. The
allow-list fails the other way — a useful new field is dropped until someone adds
it — which is a missing column in an operator view rather than a disclosure.

`redactProviderMessage` is the second line for error strings, scrubbing email
addresses and long digit runs that a provider quoted back. The first line is not
putting personal data into a provider request at all: metadata carries only
minimal stable Mercaria ids (`PAYMENT_METADATA_KEYS`), never an email, a phone
number or a session token.

Structured logs carry `paymentId`, `eventId` and `ledgerTransactionId`. They
never carry a payload or a secret.

---

## Configuration

Read in `packages/backend/src/config/index.ts` (`config.payments`).

```
PAYMENT_OUTBOX_ENABLED=true            # gates the LOOP, never the durable record
PAYMENT_OUTBOX_BATCH_SIZE=50
PAYMENT_OUTBOX_POLL_INTERVAL_MS=5000
PAYMENT_OUTBOX_LEASE_MS=60000

PEABLE_ENABLED=false                   # the card rail; needs both values below SET
PEABLE_BASE_URL=https://api.peable.to  # the gateway origin (default shown, but must be set for ENABLED)
PEABLE_WEBHOOK_SECRET=                 # mounts /webhooks/peable and runs the drain, rail or not
PEABLE_WEBHOOK_SECRET_PREVIOUS=        # rotation window
PEABLE_EVENT_MAX_ATTEMPTS=8            # then dead_letter, awaiting a replay
PEABLE_EVENT_BATCH_SIZE=50
PEABLE_EVENT_POLL_INTERVAL_MS=5000
PEABLE_EVENT_LEASE_MS=60000
PEABLE_PRESENTMENT_CURRENCIES=EUR,USD  # what a card checkout may be priced in

CHECKOUT_PAYMENT_SURFACE_METHODS=card,apple_pay,google_pay,link  # can only REMOVE; `card` always kept
HIGH_VALUE_HOLD_THRESHOLDS=            # EUR:100000,USD:110000 (minor units); EMPTY = no hold
HIGH_VALUE_HOLD_WINDOW_MS=259200000    # 72 h; 0 disables the hold

PAYMENT_RECONCILIATION_ENABLED=true                     # gates the LOOP, never the findings
PAYMENT_RECONCILIATION_INTERVAL_MS=300000               # 5 minutes
PAYMENT_RECONCILIATION_BATCH_SIZE=100
PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS=600000   # 10 minutes

GUEST_CHECKOUT_BLOCKED_PLATFORMS=      # the four guest kill switches (#107);
GUEST_CHECKOUT_BLOCKED_MARKETS=        # every one EMPTY = nothing blocked
GUEST_CHECKOUT_BLOCKED_SELLER_KEYS=
GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS=
GUEST_SELLER_ACTIVATION_REQUIRED=false # the #85 gate
```

`PEABLE_ENABLED=true` is a CONJUNCTION: it requires `PEABLE_BASE_URL` and
`PEABLE_WEBHOOK_SECRET` to be set; half-configured logs once at boot
(`[Peable] PEABLE_ENABLED is set but the integration is incomplete`) and stays
OFF. The webhook secret is in the required set although nothing is charged
without it: Mercaria reaches `paid` ONLY from a verified event or a live read, so
a rail that can create a payment and cannot verify its settlement takes money and
leaves every order unpaid. There is no Peable credential — the SDK is handed
Mercaria's own Oxy client, authenticated as its workload, and the gateway resolves
the merchant from that token's application. `livemode` is derived from
`NODE_ENV`, never configured.

`PEABLE_PRESENTMENT_CURRENCIES` is validated against Mercaria's own
`ALL_CURRENCY_CODES`: a currency code has to exist in Mercaria's closed set or
nothing downstream can price, convert or store it, so an unknown code is ignored
and logged. `CHECKOUT_PAYMENT_SURFACE_METHODS` and `HIGH_VALUE_HOLD_THRESHOLDS`
likewise drop and log entries they cannot read. There is deliberately no
seller-country, platform-currency or 3-D Secure setting: those are the gateway's
constraints now, and a copy here would refuse what Peable had started supporting.

`PAYMENT_RECONCILIATION_*` values bound WORK rather than correctness, which is
why none joins a required set the way the webhook secret does: a misconfigured
reconciliation job is slow; a missing webhook secret is silent.
`PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS` has one real constraint, a
relationship: it must stay comfortably BELOW `RESERVATION_TTL_MS` (15 minutes),
so the sweep notices a missed success before the reservation sweep cancels the
orders, after which the same condition is the released-reservation case no repair
can fix.

`DATABASE_URL` is **required** to boot. A task serving checkout without it would
take a POS sale, fail to record the payment and answer 500 from inside a
completed transaction; `src/index.ts` fails at boot instead.

---

## Testing

The suite needs a real Postgres server. `vitest.config.ts` lists one global
setup: a throwaway PostgreSQL database created, migrated and dropped per run by
`vitest.pg.globalSetup.ts`. Locally,
`docker compose -f docker-compose.postgres.yml up -d postgres` at the repo root
and `TEST_DATABASE_URL` pointed at it; CI runs a `postgis/postgis:17-3.5` service
pinned to the same image. `TEST_DATABASE_URL` names the SERVER, never the database
the tests use.

**`*.realdb.test.ts` files share ONE throwaway database and run in parallel**, so
none of them may TRUNCATE a table another one uses. The first version of the
ledger tests truncated `payments` and made the POS sale's payment vanish
mid-transaction in another file — a failure that reproduced only under
concurrency. Every assertion is scoped to rows the test itself wrote.

Nothing in the suite reaches a live gateway: the Peable adapter runs against a
fake client, signatures are real, and the API is not.

---

## Operations (#50)

What to do when the rail and Mercaria disagree, who is allowed to do it, and what
to check before any of it is pointed at live money. Every action needs the
operator surface, which needs `payments.operate` on Mercaria's Oxy application.
Nothing below can be done from the merchant dashboard, by design.

### 1. Environment separation: test and live are the SAME code and different deployments

There is no mode variable and there must not be one. `livemode` is DERIVED from
`NODE_ENV === 'production'` (`config.payments.peable.livemode`); a deployment
cannot claim one mode while holding the other's credentials.

- **A deployment may receive the other mode's events**, and drops them with a
  200 and `livemode_mismatch`. That is correct; `payment_provider_events`
  records nothing for them.
- **Test and live must be different DEPLOYMENTS**, because the database is what
  tells the two apart and nothing merges them. A test-mode intent id does not
  exist in live mode, so a payment row copied between environments is an
  unreadable trace on one side.

### 2. Rotating the webhook secret

Create the new secret at Peable, put the OLD one in
`PEABLE_WEBHOOK_SECRET_PREVIOUS` and the new one in `PEABLE_WEBHOOK_SECRET`,
deploy, then remove the previous once the gateway has stopped retrying anything
signed with it (its retries span about three days). Both verify during the
window, so no delivery is lost. There is no API key to rotate: Mercaria reaches
the gateway as its Oxy workload.

**Who holds `payments.operate`** is whoever is an owner or admin of the `oxy`
organization (declared in oxy's first-party registry and applied by the **Seed
Oxy applications** workflow). Adding or removing an operator is a role change in
that organization; a removal reaches every write at once (writes ask Oxy fresh)
and a read within 30 seconds.

### 3. Replaying a failed event

```sql
select id, provider_event_id, type, status, attempts, last_error, processing_note, received_at
from payment_provider_events
where provider = 'peable' and status in ('failed', 'dead_letter')
order by received_at desc limit 50;
```

Then `POST /internal/payments/events/:id/replay` with the row's `id` (Mercaria's,
not the gateway's). Replay is safe during an incident: nothing about the stored
event changes, `attempts` keeps counting, and every effect still runs through the
same compare-and-swap — so replaying an event whose work already landed is a
no-op. `replayed: false` means the row was already processed or is claimed by a
live task. A row `processed` with a `deferred` note is not failed and replay will
not change it: read the note (see §6).

### 4. The rail says paid and Mercaria does not

The commonest real incident, and the one the sweep handles without you.

1. `GET /internal/payments/trace?paymentId=…` (or `?orderNumber=…`, which is what
   a buyer will quote).
2. If `payment.status` is not `succeeded` and the buyer says it is, run
   `POST /internal/payments/refetch` with the payment id. That reads the payment
   live through the port and applies what it says through the ordinary path —
   booking the ledger, marking the orders paid and settling the sellers.
3. `converged: true` ends the incident. The trace shows a
   `payment_provider_paid_local_unpaid` discrepancy already RESOLVED with
   `resolvedBy: system:reconciliation` — the record that a webhook was lost.
4. `converged: false` with a note about a status that cannot be reached is the
   released-reservation case (§6).

**Do not create the missing rows by hand.** A `charge_succeeded` transaction
written at a `psql` prompt gets the commission split wrong the moment the group
has more than one seller, and the append-only trigger means it cannot be
corrected — only offset.

### 5. Mercaria says paid and the rail does not

The dangerous direction, and NOTHING automatic touches it: `refetch` records
`payment_local_paid_provider_unpaid` and stops. Orders have been marked paid,
inventory committed, and sellers may already have been transferred.

1. **Confirm which is wrong.** The trace gives the `payment_attempts` sequence
   and every event received; the gateway's own event history (Peable's
   `GET /v1/events`, kept 30 days) gives the intent's.
2. **If the rail is right** (no money arrived), recover with
   `retry_transfer_reversal` where a transfer exists and `book_reconciling_entry`
   for whatever cannot be recovered. Do NOT un-pay the order.
3. **If Mercaria is right** (money arrived under a different object), fix the
   correlation; the discrepancy resolves on the next refetch.

### 6. A stuck reservation, and money that arrived after it

`RESERVATION_TTL_MS` releases an unpaid order's stock and cancels its intent.
When a capture beat the sweep, the intent cannot be cancelled and the succeeded
event finds a `canceled` payment: the event row is `processed` with
`deferred: the gateway says 'succeeded' but the payment is 'canceled'…` and an
`error` log line (`[Peable] the gateway reports a status this payment cannot
reach`).

```sql
select id, provider_event_id, type, processing_note, received_at
from payment_provider_events
where provider = 'peable' and processing_note like 'deferred: the gateway says%'
order by received_at desc limit 50;
```

Nothing was committed, booked or fulfilled, deliberately: re-committing stock
would oversell whatever has been bought since, and booking the charge would
credit `commission_revenue` with the whole gross. Two decisions, both yours:
**refund the buyer** at the gateway (Mercaria creates no refund record for it), or
**re-create the order** as a new checkout if the stock is still there, and refund
the original charge. There is no repair action for this, deliberately.

### 7. A withheld transfer, a failed refund, a failed reversal

All readable from `GET /internal/payments/exceptions`: a durable outbox row naming
a condition only a person can close — except a `transfer_withheld` raised by a
high-value HOLD, which closes itself when its window passes.

| Condition | Repair | Detail |
|---|---|---|
| `transfer_withheld` | `retry_withheld_transfer`, or nothing | Read `transfers.held_until` FIRST (the trace projects it). Non-null and in the future is a deliberate hold the `withheld_transfers` sweep releases on its own; the repair releases it EARLY, which is what a completed review is. Null means the seller's stored account is not `ready` or the rail refused; the repair decides exactly as the automatic path would. |
| `refund_failed` | `retry_provider_refund` | Read `provider_failure_code` FIRST: a refund already made elsewhere means re-issuing would refund the buyer twice. |
| `reversal_failed` | `retry_transfer_reversal` | The buyer is fine and must not be touched. If the seller's balance still cannot cover it, `book_reconciling_entry` writes the gap off. |
| `payment_refunded` dead-lettered with `refund_settlement_unavailable` | none yet | The Peable gap in "Refunds, disputes and payouts": the gateway accepted the refund and Mercaria booked nothing. Confirm the refund at the gateway, then book it deliberately. |

Start a refund investigation from the row, not the rail:

```sql
select id, order_id, payment_id, status, provider, provider_state,
       provider_refund_id, provider_failure_code, reversal_state,
       provider_reversal_id, created_at
from refunds where order_id = '<order id>' order by created_at desc;

select status, attempts, last_error from payment_outboxes
where id = 'payment:payment_refunded:<refundId>';
```

A repair that answers `no_op` means the condition had already resolved. A 409
means the state refused it, and the message names why; a 500 is a bug.

### 8. Disaster recovery: what to VERIFY after a restore

Postgres point-in-time recovery is `oxy-infra`'s. What belongs here is the
payment domain's post-restore checklist, because a restored database is
CONSISTENT and not necessarily CURRENT — every event between the restore point and
now is one Mercaria has forgotten it received.

1. **The ledger balances.** `GET /internal/payments/metrics` →
   `reconciliation.openByKind.ledger_unbalanced` absent and
   `ledgerImbalanceAttempts` 0. A currency that does not net to zero is a torn
   restore — stop and go back to infra.
2. **A full sweep has run.** Restart a task (`PAYMENT_RECONCILIATION_ENABLED=true`)
   and watch `reconciliation.cursors[].lastCompletedAt` advance for all three
   jobs. `open_payments` converges non-terminal payments; it cannot find a
   movement Mercaria has no row for.
3. **An event-store gap check against the gateway.** List Peable's events for the
   window (`GET /v1/events`, kept 30 days) and compare against
   `select provider_event_id from payment_provider_events where provider = 'peable'
   and received_at >= '<restore point>';`. Anything the gateway has and Mercaria
   does not is a lost delivery; with no `provider_objects` sweep, this step is
   the ONLY check that catches a lost refund or a payment row that was never
   restored.
4. **Outbox backlog.** Undelivered rows from before the restore point deliver
   again; every handler is idempotent. `payment_outboxes` is swept at 14 days, so
   a restore from further back has silently lost work.

### 9. Production-readiness checklist

Every line is a thing to CHECK, not a thing to have intended. **The card rail is
not ready**: "What the Peable rail does not do yet" lists the blockers, and
nothing below has been done against live money.

**Blockers (each a build, not a check)**

- [x] Peable seller onboarding writes `provider_accounts`, so a seller can reach
      `ready`.
- [ ] The storefront card step (web Elements, native hosted page) confirms a
      real test-mode payment end to end.
- [ ] The adapter reports a refund's settled figure, so refunds book.
- [ ] Dispute, payout and account events are routed (or deliberately declared
      out of scope with their tables).
- [ ] ADR 0009 D18: one real onboarding run, one real two-seller test-mode
      charge (one payment, two transfers, ledger zero per currency, commission in
      `commission_revenue`), and a delivery interrupted mid-flight converging by
      retry.

**Configuration**

- [ ] `PEABLE_ENABLED`, `PEABLE_BASE_URL` and `PEABLE_WEBHOOK_SECRET` set from SSM
      `/oxy/mercaria/*`, never a placeholder (`-`, empty, `TODO`).
- [ ] The boot log carries no `[Peable] PEABLE_ENABLED is set but the integration
      is incomplete` line.
- [ ] `payments.operate` is seeded on Mercaria (oxy **Seed Oxy applications**,
      `only_apps` Mercaria), and the intended operators are owners or admins of
      the `oxy` organization — somebody other than whoever ran the seed has read
      its dry run.

**Webhooks**

- [ ] The endpoint is registered at Peable at `https://<api>/webhooks/peable`,
      subscribed to `payment_intent.*` and `charge.refunded` (plus the billing
      types `docs/merchant-plans.md` lists).
- [ ] `POST /webhooks/peable` with no signature answers 400 `missing_signature`,
      not 404. A 404 means the secret is unset and the endpoint is unmounted.

**Monitoring**

- [ ] `GET /health`'s `payments.webhooks.deadLetter` and
      `payments.discrepancies.critical` are ALERTED on, not merely collected.
- [ ] `ledgerImbalanceAttempts` has an alert at **any** non-zero value.
- [ ] Log-based alerts exist at `error` for `[PaymentOutbox] event dead-lettered`,
      `[Peable] event dead-lettered`, `[Peable] the gateway reports a status this
      payment cannot reach` and `[Reconciliation] discrepancy detected`.
- [ ] Scrape/alert WIRING is tracked in `oxy-infra`, which owns it.

**Reconciliation**

- [ ] `PAYMENT_RECONCILIATION_ENABLED` is true and all three cursors show a
      `lastCompletedAt` within the last hour.
- [ ] `PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS` is comfortably below
      `RESERVATION_TTL_MS` (default 10 minutes against 15).
- [ ] A deliberate discrepancy has been created and resolved end to end.

**Fraud posture**

Two protections cover one risk, and each a different part of it:

| Protection | Where it lives | What it removes |
|---|---|---|
| The high-value hold | `services/payments/high-value-hold.ts` | EXPOSURE. The transfer has not left, so a fraud caught in the window costs the goods and not the goods AND the cash |
| Acquirer risk rules and authentication | the acquirer behind Peable; no code here | The TRANSACTION, and the fraud LIABILITY on an authenticated payment |

Mercaria stores no risk verdict and subscribes to no review event, so closing a
review at the acquirer does not release a hold — an operator does, with
`retry_withheld_transfer`. Do not ask for a blanket block on a large amount:
Mercaria has no price cap (`MAX_MONEY_MINOR_UNITS` is a representational bound,
`Number.MAX_SAFE_INTEGER`), and the hold — which delays rather than refuses — is
the right tool for one.

- [ ] A high-value HOLD exercised: set `HIGH_VALUE_HOLD_THRESHOLDS` below a test
      order's seller share, take the payment, confirm the transfer sits `pending`
      with `held_until` set and no transfer call at the rail; then
      `retry_withheld_transfer` on one (releases early) and a short
      `HIGH_VALUE_HOLD_WINDOW_MS` plus a sweep tick on another (releases on
      schedule).
- [ ] A redelivered `payment_intent.succeeded` confirmed a no-op.

### 10. What has NOT been rehearsed

- Anything against a live gateway, in either mode. Every test fakes the Peable
  client; the signatures are real, the API is not.
- Every refund, reversal, dispute and payout path: the state machines and the
  ledger are exercised against a real Postgres and a fake rail, and no real card
  has ever been refunded or disputed here.
- A dispute on a multi-seller charge being attributed by an operator. The
  unattributed state is tested; there is no attribution repair, because "decide
  which seller shipped the disputed goods" is a judgement with no idempotent
  path behind it — attribute deliberately, then `retry_transfer_reversal` and a
  `book_reconciling_entry` for whatever is left.
- A discrepancy queue at production volume. The dedupe index bounds it by
  construction, but nobody has watched it under a real incident.
