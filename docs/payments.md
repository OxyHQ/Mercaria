# Payments and the internal ledger

The provider-neutral payment domain: what the models are, what holds each
invariant, what is retained and for how long, and where the boundaries between
this domain and the rest of Mercaria fall.

Binding context lives in [ADR 0001](./adr/0001-stripe-connect-architecture.md) —
separate charges and transfers, Mercaria as merchant of record, one charge per
checkout group. This document describes what was BUILT for it (issue #45); the
ADR describes why, and where the two disagree the ADR wins and this file is
wrong.

Faircoin (#51) does not exist yet, and Stripe exists from the webhook inwards
plus its connected accounts: #48 built the event ingress described below, #46
built onboarding and the readiness gate, and the adapter that CREATES payments
(`createPayment`/`capture`/`refund`) is #47's. Nothing here is a placeholder: the
domain is complete on its own terms and each rail arrives as an adapter behind one
interface.

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

Nine tables, all Postgres-native — none has a Mongoose ancestor.

| Table | What it is |
|---|---|
| `provider_accounts` | One seller's standing with one rail: their connected account, its capabilities, and the single readiness verdict checkout gates on. |
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
| `account.*` | applied — the account is re-read from Stripe and readiness recomputed | — |
| `payout.*` | correlated only. The account→seller mapping #46 added means a payout row WOULD now be attributable; what is still missing is the rest of the payout lifecycle and its domain event | #49 |

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

## Connected accounts and payment readiness (#46)

`provider_accounts` is the record ADR 0001 D9 calls for: one row per seller per
rail, carrying the connected account and the verdict that decides whether their
listings can be bought.

### One account per owner, and the index that enforces it

`UNIQUE(provider, owner_type, owner_id)`. That constraint is the whole reason the
owner is ONE polymorphic column rather than the mutually-exclusive pair `orders`
uses — the pair cannot express this uniqueness in a single index at all, and this
is the constraint that stops a seller attaching a second connected account, or
somebody else's.

Creation is idempotent on both sides of the boundary, and the two halves protect
different things:

- **In Mercaria**, an existing row short-circuits before any Stripe call, and a
  concurrent second caller converges through `on conflict do nothing` plus a
  re-read.
- **At Stripe**, the idempotency key is derived from the OWNER
  (`acct:<ownerType>:<ownerId>`), so two racing callers send the same key and
  Stripe answers both with one account. This is the half that matters: a Mercaria
  row can be deduplicated after the fact, and a Stripe account cannot be
  un-created. A key derived from a freshly-minted row id would differ between the
  two racers and defeat itself.

### Readiness is ONE stored verdict

ADR 0001 D9's conjunction — payouts enabled, `transfers` active, nothing
currently due or past due, no disabling reason — is evaluated at synchronisation
and collapsed into `onboarding_state`. There is deliberately no `ready` boolean
beside it: two representations of one fact can disagree, and the one place that
must not happen is a checkout gate admitting a seller because a flag was stale.

`charges_enabled` is recorded and NOT a conjunct. Under separate charges and
transfers the connected account never charges a card, so a seller whose account
cannot charge is not thereby unable to sell.

The state derivation is ordered, and the order is the decision:

| Order | Condition | State |
|---|---|---|
| 1 | the platform's authorisation was revoked | `disabled` |
| 2 | a `rejected.*` reason, or `listed` / `platform_paused` / `other` | `disabled` |
| 3 | anything `past_due` | `restricted` |
| 4 | the D9 conjunction holds | `ready` |
| 5 | `under_review` / `pending_verification`, or nothing due and `transfers` pending | `under_review` |
| 6 | otherwise | `action_required` |

`restricted` and `disabled` are distinct because one is recoverable by the seller
and one is not; collapsing them either tells someone their business is over when
it is not, or sends them round a hosted flow that cannot help them.
`rejected.*` is matched by PREFIX so a rejection Stripe adds later lands on the
safe side.

### Requirements are COUNTS, and that is structural

`requirement_collection = stripe` (D2) means Stripe holds the identity data.
Mercaria stores four integers, a deadline and a filtered reason code — as REAL
COLUMNS, not a summary object, precisely so the safe subset cannot be violated by
a careless write: an integer column cannot hold `individual.verification.document`.
Reason codes are additionally shape-checked (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`)
and replaced with `other` if they are anything a sentence or a name could fit in.

### Three writers, one path

`account.updated`, `account.external_account.updated` and the reconciliation
sweep all end at `syncAccountState`, which RE-READS the account from Stripe and
applies what it finds. No handler applies a webhook payload: an account's
requirements are the most volatile thing Stripe reports, deliveries are
unordered, and a retry hours later would otherwise restore requirements the
seller has since satisfied.

`account.application.deauthorized` is the one exception and must not re-read —
the platform's access is gone, so the retrieve would fail, and a retryable
failure would dead-letter the event while leaving a seller Mercaria cannot pay
marked as active.

Ordering between the three is a compare-and-swap on `last_synced_at`: the
freshest observation wins whichever write lands first, so no caller needs to know
another exists. Revocation deliberately bypasses that guard — it is not an
observation a later read supersedes.

### The reconciliation sweep

`startStripeAccountReconciler` re-reads accounts whose `last_synced_at` is older
than `STRIPE_ACCOUNT_SYNC_STALE_AFTER_MS` (6 hours), oldest first, never-synced
ahead of everything, revoked accounts excluded. A missed `account.updated` is
silent by construction — nothing here knows about an event it never received — so
a sweep that does not depend on having been told is the only thing that can
notice.

It needs no lease, unlike the outbox dispatcher: an outbox row is WORK and doing
it twice does the thing twice, while a sync is an OBSERVATION and the
compare-and-swap keeps the freshest one whichever task wrote it. The full
reconciliation framework — drift reports, dead-letter replay, ledger-versus-Stripe
comparison — is #50's, and building a fraction of it here would leave two
half-frameworks to merge.

### The checkout gate

`assertSellerGroupsPaymentReady` runs in `checkout.service` after the seller
groups are built and BEFORE any inventory is reserved (ADR 0001 D4). Refusing
after a reservation would hold somebody else's stock for the length of a rollback
on a question that needed no stock to answer. The refusal names the seller keys,
so a buyer can deselect that group through the existing partial-checkout
mechanism without a second round trip.

It lives in `services/payments/provider-account.service.ts`, which knows what a
seller key is and what `ready` means and NOTHING about Stripe — because
`checkout.service` importing a Stripe module would make the card rail structural
to placing an order.

**When `STRIPE_ENABLED` is off the gate returns before touching Postgres**, so a
deployment without Stripe behaves exactly as it did before #46. Both branches are
pinned: the off branch in `checkout.service.test.ts`
(`expect(findProviderAccountByOwner).not.toHaveBeenCalled()`), the on branch in
`checkout.payment-gate.test.ts`, which also asserts `reserve` was never called.

### Hosted onboarding, and what a redirect proves

Account Links are single-use and expire in minutes, so they are minted on demand
and never stored. Both URLs point back at this API, not at an app: the round trip
is authenticated by a signed, expiring `state` token (HMAC-SHA256, constant-time
comparison, 30 minutes) because the seller arrives from stripe.com with no
session and no credential.

`refresh` re-mints and bounces the seller straight back to Stripe. It will not
CREATE an account, ever — creation stays behind the authenticated,
permission-checked routes, so the worst a captured state can reach is an
onboarding flow for an account that already exists, never a new account attached
to someone else's store. The token is not single-use (that needs server-side
state, the same limitation the connector OAuth state carries) and this is what
bounds it instead.

`return` re-READS the account from Stripe before redirecting — an authoritative
call, not a belief in the redirect — purely so the dashboard the seller lands on
is current. Readiness still comes only from `account.updated` and the sweep; if
the read fails the redirect happens anyway.

A tampered or expired state is answered **400, never a redirect**: the only
destination available at that point would be one derived from an unverified
parameter, which is how a signed-state check becomes an open redirect.

### Routes and permissions

| Route | Who |
|---|---|
| `GET /admin/stores/:storeId/payments/account` | store member with `store:manage` |
| `POST /admin/stores/:storeId/payments/account/onboarding-link` | store member with `store:manage` |
| `GET /seller/payments/account` | the P2P seller themself |
| `POST /seller/payments/account/onboarding-link` | the P2P seller themself |
| `GET /stripe/onboarding/refresh?state=…` | nobody — signed state only |
| `GET /stripe/onboarding/return?state=…` | nobody — signed state only |

`store:manage` and not `settings:write`: the latter belongs to `admin` and
`staff` and opens the return policy, while this decides where a store's money is
settled and starts an identity flow in the store's name. `store:manage` is the
one permission `admin` does not hold.

The P2P routes have no permission check and none is missing — the owner is
derived from `getRequiredOxyUserId`, so the surface can only ever reach the
caller's own account. Neither surface reads an identifier a client could choose,
which closes "one owner attaches another owner's connected account" at the route
rather than at the service.

Link minting is metered on a dedicated `payments` rate-limit scope, because every
mint is a Stripe API call and the create path behind it can bring an account into
existence.

### What the API returns, and what it never returns

`SellerPaymentSettings` = the account status, `onboardingAvailable` (can this
deployment onboard anyone at all), and `supportedCountries`. The status carries
the state, the readiness boolean, the capability flags, the requirement COUNTS,
the payout currency and schedule, and the filtered reason codes.

It never carries the connected-account id, the raw requirements, any part of the
provider payload, or any credential. The projection names every field explicitly
rather than spreading the row, so a column added later cannot ride along; a test
asserts both the absent key and the absent VALUE, since the second is what a
spread would produce.

Account ids are redacted to their last four characters in logs
(`acct_…IjK`). Not a secret, and still redacted: a full id in an aggregated log
store is a durable, greppable link between that store and one merchant's
finances, and nothing an operator does needs more than enough to tell two
accounts apart.

### The audit trail

Account creation, every state transition and every revocation write a
`provider_account_changed` row to `payment_outboxes` — the same durable
at-least-once delivery every other payment consequence gets, rather than a second
audit table with a second retention policy. The payload is ids and the two states
it moved between; the handler logs at a level that reflects the transition
(losing readiness is a `warn`, because it stops that seller selling). #50 owns
the operator surface that reads these, #108 the seller notification; both attach
here rather than to the Stripe webhook, so neither ever receives provider detail.

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

STRIPE_ONBOARDING_BASE_URL=            # THIS API's public origin (#46)
STRIPE_ONBOARDING_RETURN_URL=          # where the seller lands afterwards — the dashboard
STRIPE_ONBOARDING_STATE_SECRET=        # HMAC key for the signed round-trip state
STRIPE_ACCOUNT_SYNC_STALE_AFTER_MS=21600000   # 6 hours
STRIPE_ACCOUNT_SYNC_BATCH_SIZE=25
STRIPE_ACCOUNT_SYNC_INTERVAL_MS=900000        # 15 minutes
```

`STRIPE_ENABLED=true` requires the key AND BOTH webhook secrets; half-configured
logs once at boot and stays OFF, the `CROWDSOURCE_ENABLED` rule. There is no
`STRIPE_ACCOUNT_ID` (the platform account is implied by the key) and no API
version variable — that is a code constant, `STRIPE_API_VERSION`, so an event
payload's shape stays a property of the code that parses it.

**The three onboarding values do NOT join that check**, and the difference is the
failure mode rather than the importance. The webhook-secret rule exists for a
SILENT failure: a deployment missing the Connect secret verifies charges and
drops every `account.updated`, so sellers stop becoming ready with nothing to
see. Missing onboarding configuration is the opposite — the onboarding route
fails immediately, naming the variable, while the already-shipped webhook ingress
keeps working. Turning the whole rail off for it would take payments down to fix
an onboarding typo. `stripeOnboardingConfig()` is the single reader and names
every missing variable at once; `isStripeOnboardingConfigured()` is the predicate
the dashboard reads so it can disable its connect action rather than offer a
button that answers with an error.

`STRIPE_ONBOARDING_BASE_URL` is this API's public origin, configured rather than
derived from the request: a `Host` header behind an ALB is attacker-controlled,
and a redirect built from one is an open redirect with a Stripe-branded first hop.

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

---

## Runbook: Stripe test mode, webhooks, and account troubleshooting

Everything below is TEST MODE. Nothing here has been exercised against a live
Stripe account — the platform legal entity is still an open item in ADR 0001, and
the live key must not be issued before it is settled.

### 1. Bring up a test-mode deployment

1. In the Stripe dashboard, switch to **test mode** and copy the secret key
   (`sk_test_…`). Its prefix is what sets `livemode` — there is no variable for
   that, so a test key can only ever see test objects.
2. Create the **two webhook endpoints**, both with the API version pinned in
   `STRIPE_API_VERSION` (`2026-07-29.dahlia`). Selecting "latest" instead is the
   drift ADR 0001 forbids: an event whose shape changed would arrive against
   fixtures nobody re-verified.

   | Endpoint | Scope | URL | Events |
   |---|---|---|---|
   | Platform | `connect = false` | `https://<api>/webhooks/stripe` | the `payment_intent.*`, `charge.*`, `transfer.*` list in ADR 0001 |
   | Connect | `connect = true` | `https://<api>/webhooks/stripe/connect` | `account.updated`, `account.application.deauthorized`, `account.external_account.updated`, `payout.paid`, `payout.failed` |

3. Set the environment (see Configuration above). `STRIPE_ENABLED=true` needs the
   key and BOTH signing secrets, or the rail stays off and says so once at boot.
   Set the three `STRIPE_ONBOARDING_*` values too — the rail will come up without
   them and no seller will be able to onboard.
4. Confirm the mount: `GET /` lists `/stripe/onboarding`, and
   `POST /webhooks/stripe` answers 400 (bad signature) rather than 404. A 404
   means `STRIPE_ENABLED` did not resolve true — check the boot log for the
   `[Stripe] STRIPE_ENABLED is set but the integration is incomplete` line, which
   names the missing variables.

### 2. Take a test store from not connected to payment ready

1. Sign in to the dashboard as a store **owner** (`store:manage`; an `admin` is
   deliberately refused) and open **Settings → Payments & payouts**.
2. Press *Set up payouts*. That creates the connected account and opens Stripe's
   hosted onboarding **in the system browser**. It will not work in an embedded
   webview.
3. Complete the flow with Stripe's test values — `000 000 000` for a Spanish tax
   id, `SSN 000-00-0000`, and the test IBAN for the account's country from
   Stripe's testing docs. Use the "skip this step" affordances Stripe offers in
   test mode to jump straight to a fully-verified account.
4. On return, the screen refetches. It may still say *A few details are still
   needed* for a few seconds: readiness comes from `account.updated`, not from
   the browser coming back. When Stripe has finished, the row flips to `ready`
   and the screen says *Ready to be paid*.
5. Verify from the API rather than the UI:
   `GET /admin/stores/:storeId/payments/account` →
   `data.account.onboardingState === 'ready'` and `data.account.paymentReady === true`.

**Reopening the flow never creates a second account.** Pressing the button again
mints a fresh Account Link against the same connected account — that is what the
owner-derived Stripe idempotency key and `UNIQUE(provider, owner_type, owner_id)`
between them guarantee. If you ever see two accounts for one owner, both of those
have failed and it is a bug, not a configuration problem.

### 3. Local development without a public URL

Stripe cannot reach `localhost`, and hosted onboarding cannot redirect to it
either.

```
stripe listen --forward-to localhost:4160/webhooks/stripe
stripe listen --forward-connect-to localhost:4160/webhooks/stripe/connect
```

Each prints its own `whsec_…`; they are DIFFERENT secrets and must go in
`STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` respectively.
Swapping them makes every delivery fail signature verification, which looks
exactly like a compromised endpoint.

For the onboarding round trip, `STRIPE_ONBOARDING_BASE_URL` must be a URL Stripe
can redirect a browser to — a tunnel (`stripe listen` does not provide one). The
redirect is a browser hop, not a server call, so the tunnel only has to be
reachable from the machine running the browser.

### 4. Troubleshooting an account

Start from the row, not from Stripe:

```sql
select id, owner_type, owner_id, onboarding_state, payouts_enabled,
       transfers_capability, requirements_currently_due, requirements_past_due,
       requirements_deadline_at, disabled_reason_codes, last_synced_at,
       activated_at, revoked_at
from provider_accounts
where provider = 'stripe' and owner_id = '<store id or oxy user id>';
```

| Symptom | Most likely cause | What to do |
|---|---|---|
| Seller says they finished onboarding, row still `action_required` | `account.updated` was never delivered, or the Connect endpoint's secret is wrong | Check the Stripe dashboard's webhook delivery log for that endpoint. Then wait for the sweep (≤ 6 hours) or restart a task to run it sooner — it converges on the same answer either way. |
| Row `restricted`, seller says nothing is outstanding | Stripe's own state moved and Mercaria has not re-read it | Compare `last_synced_at` against the change; the sweep will pick it up. |
| Checkout refuses a seller who looks fine in the dashboard | The dashboard is reading a stale query cache, or the gate is reading a different owner | Confirm `onboardingState` from the API, and confirm the checkout error names the same seller key. |
| No `provider_accounts` row at all, but Stripe shows an account | The account was created and the insert did not land, or the row was created in another environment | Do NOT insert a row by hand. The account id is in Stripe's metadata (`ownerType`, `ownerId`); decide deliberately whether to adopt or abandon it. |
| Every onboarding request 400s naming a variable | `STRIPE_ONBOARDING_*` is unset | Set the three values. The rail itself is unaffected and charges keep working. |
| `account.updated` events sit `failed` in `payment_provider_events` | The account row is missing, or Stripe is refusing the retrieve | Read `last_error` on the row. An account Mercaria has no row for is marked `processed` with a note, never `failed` — a `failed` one is a real error. |

Useful correlations:

- inbound deliveries for one account —
  `select type, status, processing_note, received_at from payment_provider_events
   where provider_account_id = '<acct_…>' order by received_at desc limit 20;`
- the audit trail of one seller's transitions —
  `select id, payload, created_at from payment_outboxes
   where event_type = 'provider_account_changed' order by created_at desc limit 20;`

### 5. Rotating the webhook secrets

Set the new secret in Stripe, put the OLD one in `STRIPE_WEBHOOK_SECRET_PREVIOUS`
(or `STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS`) and the new one in the primary
variable, deploy, then remove the previous after Stripe has stopped retrying
anything signed with it. Both are accepted during the window, so no delivery is
lost.

### 6. What has NOT been rehearsed

- Anything in live mode, including the `debit_negative_balances` default that ADR
  0001 lists and this implementation deliberately does not send (with
  `losses.payments = application` it is not an independent setting; sending a
  redundant field on a path that cannot be exercised without a live account is a
  deploy-time failure for no gain — verify it once a live account exists).
- A seller in a country other than the configured one, since
  `STRIPE_SELLER_COUNTRIES` defaults to `ES` alone.
- Recovery from `disabled`, which needs Stripe support rather than a runbook step.
