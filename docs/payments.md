# Payments and the internal ledger

The provider-neutral payment domain: what the models are, what holds each
invariant, what is retained and for how long, and where the boundaries between
this domain and the rest of Mercaria fall.

Binding context lives in [ADR 0001](./adr/0001-stripe-connect-architecture.md) —
separate charges and transfers, Mercaria as merchant of record, one charge per
checkout group. This document describes what was BUILT for it (issue #45); the
ADR describes why, and where the two disagree the ADR wins and this file is
wrong.

Faircoin (#51) does not exist yet, and Stripe exists only from the webhook
inwards: #48 built the event ingress described below, while the adapter that
CREATES payments (`createPayment`/`capture`/`refund`) is #47's and onboarding is
#46's. Nothing here is a placeholder: the domain is complete on its own terms and
each rail arrives as an adapter behind one interface.

---

## Why the ledger is load-bearing on day one

ADR 0001 D3 chooses separate charges and transfers, which means Mercaria's
commission is **not** an `application_fee_amount` — that mechanism does not exist
for this charge model. The commission is the difference between what the buyer
paid and the sum of what the sellers were paid, and that quantity exists in
exactly one place: `ledger_transactions` and `ledger_entries` in this database.
Stripe's fee reporting is deliberately given up.

So the ledger is not accounting hygiene to be added once revenue matters. It is
the only record of revenue there will ever be, which is why it landed before a
single real charge could be created.

---

## Models

Eight tables, all Postgres-native — none has a Mongoose ancestor.

| Table | What it is |
|---|---|
| `payments` | The durable payment aggregate. One per funded checkout group for native rails; one per imported order for `external`. |
| `payment_attempts` | One row per provider authorization or confirmation Mercaria asked for. Append-mostly evidence. |
| `payment_provider_events` | The immutable envelope of everything a provider has told Mercaria. Receipt is separate from processing. |
| `transfers` | Mercaria paying ONE seller order out of a settled charge (ADR D3). |
| `payouts` | The provider moving a seller's own balance to their bank. Recorded for health and support; books nothing. |
| `payment_outboxes` | The durable promise that a payment's consequences will happen. |
| `ledger_transactions` | One balanced set of entries, and what caused it. |
| `ledger_entries` | One signed movement against one account in one currency. |

They replace the four `orders.payment_*` fields, which had to be a state machine,
an audit trail, an idempotency key and a provider reference at once, and the four
`settlement_*` columns retired with them (a shop→FAIR snapshot from the model in
which FAIR was the mandatory settlement currency).

The order keeps only a POINTER and the coarse state:
`{status, provider?, paidAt?, reference?, paymentId?}`. Nothing mutable is copied
onto it, so a payment moving through its lifecycle can never leave an order
holding a stale figure.

### The chart of accounts

Seven accounts. `LedgerAccount` in `@mercaria/shared-types` carries the same
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
missing trigger; with them restored, all ten pass.

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
platform-scope events, and Postgres treats NULLs as DISTINCT by default — so the
plain constraint would dedupe connect-scope events and silently accept every
redelivery of a platform-scope one, which is the majority of them. Coalescing to
`''` would also work and is worse: an empty string is a VALUE, so it collides for
real the day a provider reports an empty account.

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
from a verified provider EVENT (`applyProviderEvent`, whose envelope came from an
adapter's `verifyEvent`) or from a synchronous provider response over an
authenticated server-to-server channel. A client callback is UX; a `return_url`
proves nothing.

---

## Service boundaries

```
routes / #48 webhook ingress
        │  verified envelope
        ▼
services/payments/payment.service.ts   ← the ONLY status transitions
        │                                 the ONLY caller of an adapter
        ├── ledger-postings.ts          ← pure; ADR's representability table
        ├── payment-outbox.service.ts   ← deterministic ids, claim/lease/backoff
        │      └── outbox-handlers.ts   ← what each domain event DOES
        ├── order-linkage.ts            ← the ONE seam onto orders
        └── provider.ts                 ← the seam every rail plugs into
                └── synthetic-provider.ts (id: `mock`)
```

- **`provider.ts`** names no provider's vocabulary. No `PaymentIntent`, no
  `transfer_group`. The day one appears, the seam has failed.
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
- **`tracePayment`** is service-level. The operator HTTP surface that exposes it,
  with its own authorization, is #50's — everything it returns is merchant and
  operator financial detail.

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
  A `do update` would reintroduce the exact bug the Mongo version needed
  `timestamps: false` to avoid: a write nobody needed, contending with the
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
`payment_refunded`, `payment_disputed`, `transfer_changed` and `payout_changed`
are in that category today: nothing emits them yet, and #49 lands their producers
and handlers together.

---

## The Stripe event ingress (#48)

Two endpoints, mounted in `app.ts` BEFORE `express.json()` beside the CrowdSource
and connector webhooks, because Stripe signs the exact bytes it sent:

| Path | Scope | Secret | Subscribes to |
|---|---|---|---|
| `POST /webhooks/stripe` | platform (`connect=false`) | `STRIPE_WEBHOOK_SECRET` | `payment_intent.*`, `charge.*`, `charge.dispute.*`, `transfer.*` |
| `POST /webhooks/stripe/connect` | connect (`connect=true`) | `STRIPE_CONNECT_WEBHOOK_SECRET` | `account.*`, `payout.paid`, `payout.failed` |

The exact lists are ADR 0001's and are pinned by
`services/payments/stripe/__tests__/event-scopes.test.ts`, which transcribes them
from the ADR by hand so changing the source alone breaks the test. Both endpoints
answer **404 when `STRIPE_ENABLED` is off** — the MOUNT is gated, not just the
handler, because a deployment with no secret cannot tell a real delivery from a
forged one, so there is nothing to park.

### The order of the ingress, and what each step may leave behind

1. **Verify** over the raw bytes, trying the current secret then the previous one
   (the rotation window). Failure → **400, nothing persisted**. Storing an
   unverified body would put an attacker's chosen `(provider, account, event id)`
   into the dedupe key, after which the real event carrying that id is silently
   swallowed as a duplicate.
2. **Filter on `livemode`.** A production URL receives test events too. Mismatch
   → **200 `livemode_mismatch`, nothing persisted**; 200 because Stripe must stop
   retrying something that will never be accepted.
3. **Refuse the other endpoint's scope** → **400 `wrong_scope`**. A type in
   NEITHER list is accepted and stored, following #45's rule that an
   uninterpretable event is evidence rather than a dropped request.
4. **Store the envelope**, redacted through `redactProviderPayload`. The insert
   IS the dedupe claim; a redelivery loses to the unique index, answers 200 and
   has no side effects.
5. **Process**, inline, through the same durable claim the poller uses.

**A 200 means STORED, never PROCESSED.** Processing failing never changes the
answer: the row is durable, so it is retried with backoff and eventually
dead-lettered, whereas a 500 would ask Stripe to redeliver an event Mercaria
already has.

### The event row is the job — there is no second queue

`payment_provider_events` gained `next_attempt_at`, `lease_owner`, `lease_until`
and `processing_note`, so claiming one is the same `FOR UPDATE SKIP LOCKED` claim
`payment_outboxes` uses. Writing an outbox row that says "please interpret the
event row I just wrote" was rejected: it makes one delivery into two durable
records that can disagree, it puts inbound ingress into a table whose event types
are Mercaria's own domain CONSEQUENCES, and the retentions differ on purpose —
outbox rows are swept at 14 days, events at 90, and a dead-lettered event must
stay replayable across a dispute window.

`replayProviderEvent(eventId)` reopens a `failed` or `dead_letter` row and runs it
again. It resets only WHEN the row may be claimed — never `attempts`, never the
envelope — so the trace still shows how often it had been tried. The operator
HTTP surface that calls it is #50's; `stripeWebhookStats()` is on
`GET /health` under `payments.webhooks`.

### Convergence needs no new mechanism, and one new rule

Duplicates and reordering converge on `applyPaymentStatus`'s compare-and-swap,
exactly as #45 designed. The one addition is the **stale-delivery rule**: before
applying, the router asks `canTransitionPaymentStatus(current, mapped)`, and if
the answer is no it re-reads the PaymentIntent from Stripe and applies THAT.
"Is this delivery stale" and "can this be applied" turn out to be the same
question, and only the second has an answer that does not require knowing which
other events exist.

One case survives the re-read: Stripe says `succeeded`, Mercaria says `canceled`
— a capture for a payment whose reservation timed out and whose orders were
released. Nothing is committed, booked or fulfilled (re-committing stock would
oversell it; booking with no orders left would credit `commission_revenue` with
the whole gross), and the condition becomes one deterministic
`payment_succeeded_after_release` outbox row whose handler logs at `error` and
changes nothing. #50 picks it up.

### Seams are visible in the trace, never fake handling

Most subscribed types belong to later issues, and they arrive TODAY because an
endpoint must be registered with its full list before any of them ships. Those
handlers mark the event `processed` **and write `deferred: #NN` into
`processing_note`** — a deferral that said nothing would be indistinguishable
from real handling, and the first person to notice would be a seller asking why
their account never went live.

| Events | Today | Lands in |
|---|---|---|
| `payment_intent.*` | applied through `applyPaymentStatus` | — |
| `charge.*` | correlated; Stripe's fee needs a ledger CORRECTION, not a reopened transaction | #49 |
| `charge.refunded`, `charge.refund.updated`, `charge.dispute.*` | correlated | #49 |
| `transfer.*` | the transfer row's status and reversed amount ARE refreshed, if a row exists | create path #47, `transfer_changed` event #49 |
| `account.*` | correlated | #46 |
| `payout.*` | correlated only — a payout row needs #46's account→seller mapping to be attributable | #49 |

### No rate limiter, deliberately

The webhook paths are mounted before the global limiter and add none of their
own. `makeRateLimiter` keys anonymous callers by IP, and every Stripe delivery
arrives from a small pool of Stripe's own addresses — so a per-IP bucket is ONE
bucket for the whole provider, and a legitimate burst would trip it and be
retried into the same bucket until Stripe disabled the endpoint. What bounds the
work instead is real: `express.raw`'s 1 MB limit, refusal before any database
access, and a duplicate costing one conflicting indexed insert. A test fires 60
deliveries and asserts none is answered 429.

### `constructEventAsync`, never `constructEvent`

`stripe`'s package exports declare a `bun` condition pointing at the WORKER
build, whose crypto provider throws from every SYNCHRONOUS entry point
(`CryptoProviderOnlySupportsAsyncError`). Production runs Node and `bun run dev`
runs Bun, so a synchronous `constructEvent` verifies every delivery in production
and throws on every delivery in development — the worst possible split. Measured
on stripe@22.4.0; it applies to `generateTestHeaderString` in tests too.

---

## Retention

Postgres has no TTL index. `db/expiryTargets.ts` is the registry
`sweepAllExpiredRows` reads; a table with an `expires_at` and no entry there grows
forever with no error and no failing test.

| Table | Retention | Measured from | Why that long |
|---|---|---|---|
| `payment_outboxes` | 14 days | Enqueue | A job stuck for a fortnight will not succeed on day fifteen. The payment stays visible in `payments.status`, which is where a stalled dispatcher must be noticed. |
| `payment_provider_events` | 90 days | Receipt | Past every provider's redelivery schedule and past the dispute windows these events describe. After it, a re-arriving event is genuinely new — and re-processing it is a no-op anyway, because the status CAS finds nothing to change. |

Everything else is permanent. `payments`, `payment_attempts`, `transfers`,
`payouts` and both ledger tables are the financial record: buyer access
revocation never deletes or hides them (#45 invariant 12).

---

## Providers

`PAYMENT_PROVIDER_IDS` in `@mercaria/shared-types` is the closed set, and it is
short on purpose — a provider is added together with its adapter and its
migration widening the CHECK, never in advance. A value the database accepts but
no adapter can produce is an invitation to write a row nothing can reconcile.

| Provider | Adapter | Books ledger entries | Semantics |
|---|---|---|---|
| `external` | none | **No** | Captured on Shopify/WooCommerce. Recorded so the order is explicable; no Mercaria money moved (ADR D12). |
| `manual_pos` | none | **No** | Cash or a card terminal at a register. The money is in the merchant's drawer and never passes through Mercaria. |
| `mock` | `SyntheticPaymentProvider` | Yes | The dev seam and the contract suite's subject. Hard-gated by `config.orders.mockPayEnabled`, off in production. |
| `stripe` | event side only (#48); `createPayment`/`capture`/`refund` in #47 | Yes | The card rail. Mercaria is merchant of record (ADR D1), so money arrives on the platform balance and each seller's share is a payable. |

`external` and `manual_pos` having no adapter is the distinction the set encodes:
they are payments Mercaria RECORDS, not payments Mercaria makes. Nothing is
authorized, captured or refunded through them. `PROVIDER_BOOKS_LEDGER` in
`payment.service.ts` is an explicit table rather than a `provider === 'external'`
test, because the question is not "is it external" but "did Mercaria receive and
owe this money", and those come apart the moment a third non-booking rail
appears.

**A store-side cash view for POS is a later product decision.** If it is ever
wanted it is a STORE's ledger, not Mercaria's — booking register cash into
Mercaria's accounts would put money there that Mercaria does not have, and the
ledger's whole value is that it contains no figures like that.

### The contract suite

`services/payments/__tests__/provider-contract.ts` exports
`runPaymentProviderContract`, which every rail runs. It pins the properties the
service relies on and therefore cannot verify for itself, because it has one code
path for all of them: the authorize → capture → refund happy path, a partial
refund landing on `partially_refunded`, idempotency under a repeated key, a
failure at each stage arriving as a `PaymentProviderError` with a `retryable`
flag, a bad signature refused non-retryably, and duplicate/out-of-order events
converging.

Failure injection and event signing are OPTIONAL capabilities — a live Stripe
sandbox can do neither on demand, so those arms skip rather than fail.

---

## Redaction and logging

`services/payments/redact.ts` reduces a provider payload to the ids, amounts,
currencies, statuses and timestamps Mercaria may keep. It is an **allow-list**,
and it has to be: a deny-list of known-sensitive keys is correct only until the
provider adds a field, which they do without telling anyone and which is exactly
when a new sensitive field appears. The allow-list fails the other way — a useful
new field is dropped until someone adds it — which is a missing column in an
operator view rather than a disclosure.

`redactProviderMessage` is the second line for error strings, scrubbing email
addresses and long digit runs that a provider quoted back. The first line is not
putting personal data into a provider request at all: metadata carries only
minimal stable Mercaria ids (#45 buyer boundaries 7), never an email, a phone
number or a session token.

Structured logs carry `paymentId`, `eventId` and `ledgerTransactionId`. They
never carry a payload or a secret.

---

## Configuration

```
PAYMENT_OUTBOX_ENABLED=true            # gates the LOOP, never the durable record
PAYMENT_OUTBOX_BATCH_SIZE=50
PAYMENT_OUTBOX_POLL_INTERVAL_MS=5000
PAYMENT_OUTBOX_LEASE_MS=60000

STRIPE_ENABLED=false                   # gates the MOUNT — 404 when off, not 401
STRIPE_SECRET_KEY=                     # sk_test_… or sk_live_…; its prefix decides livemode
STRIPE_WEBHOOK_SECRET=                 # platform-scope endpoint
STRIPE_WEBHOOK_SECRET_PREVIOUS=        # rotation window
STRIPE_CONNECT_WEBHOOK_SECRET=         # connect-scope endpoint
STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS=
STRIPE_SELLER_COUNTRIES=ES             # onboarding allow-list (#46)
STRIPE_EVENT_MAX_ATTEMPTS=8            # then dead_letter, awaiting a replay
STRIPE_EVENT_BATCH_SIZE=50
STRIPE_EVENT_POLL_INTERVAL_MS=5000
STRIPE_EVENT_LEASE_MS=60000
```

`STRIPE_ENABLED=true` requires the key AND BOTH webhook secrets; half-configured
logs once at boot and stays OFF, the `CROWDSOURCE_ENABLED` rule. There is no
`STRIPE_ACCOUNT_ID` (the platform account is implied by the key) and no API
version variable — that is a code constant, `STRIPE_API_VERSION`, so an event
payload's shape stays a property of the code that parses it.

`STRIPE_EVENT_MAX_ATTEMPTS` is 8 against the outbox's 25, on purpose: an outbox
row is Mercaria's own consequence and the only way it will ever happen, while an
event Mercaria cannot interpret is one Stripe is also retrying and whose object
can be re-read at any time.

`DATABASE_URL` is now **required** to boot. The payment domain is Postgres-native,
and a task serving checkout without it would take a POS sale, fail to record the
payment and answer 500 from inside a completed transaction — which reads as an
outage of the register rather than as the misconfiguration it is. `src/index.ts`
fails at boot instead, where an operator can act on it.

---

## Testing

The suite needs a real Postgres server. `vitest.config.ts` lists one global
setup: a throwaway PostgreSQL database created, migrated and dropped per run by
`vitest.pg.globalSetup.ts`. Locally,
`docker compose -f docker-compose.postgres.yml up -d postgres` at the repo root
and `TEST_DATABASE_URL` pointed at it; CI runs a `postgis/postgis:17-3.5` service
pinned to the same image.

`TEST_DATABASE_URL` names the SERVER, never the database the tests use — the
harness creates its own and never writes to the one in the URL.

**`*.realdb.test.ts` files share ONE throwaway database and run in parallel**, so
none of them may TRUNCATE a table another one uses. That is not hypothetical: the
first version of the ledger tests truncated `payments` and made the POS sale's
payment vanish mid-transaction in another file, a failure that reproduced only
under concurrency and looked exactly like a bug in whichever file lost the race.
Every assertion is scoped to rows the test itself wrote — which is the stronger
form anyway, since a count over a whole table passes for the wrong reason as soon
as a fixture is added elsewhere.
