# Mercaria

Mercaria is Oxy's buy/sell marketplace: users buy and sell new items (from shops)
and secondhand items (from people), eBay or Wallapop style. The backend is a
Shopify-grade commerce platform serving three Expo apps (storefront, dashboard,
POS) and a shared UI package.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Mercaria specifically. Versions are in `package.json`, never here.

See `HANDOFF.md` for deferred work (infra, Oxy client registration, the domain).

## Monorepo structure

| Package | Path | Role |
|---|---|---|
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront, mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant/store admin, dashboard.mercaria.co |
| `@mercaria/pos` | `packages/pos/` | Expo point of sale, pos.mercaria.co |
| `@mercaria/ui` | `packages/ui/` | Shared component library, consumed FROM SOURCE with no dist |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, PostgreSQL, Socket.IO) |
| `@mercaria/shared-types` | `packages/shared-types/` | TypeScript DTOs shared by all packages |

Stack: Expo, NativeWind (Tailwind v4 plus postcss), Reanimated, Zustand, TanStack
Query and expo-router on all three apps; Express, PostgreSQL (drizzle-orm +
postgres.js via `@oxyhq/db`), optional Redis and Socket.IO on the backend;
`@oxyhq/core` (including `@oxyhq/core/server`) and
`@oxyhq/services` for device-first auth; `@oxyhq/bloom` plus `@mercaria/ui` for
UI. Client ids: storefront `EXPO_PUBLIC_OXY_CLIENT_ID`, dashboard
`EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, POS `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.

### `@mercaria/ui` is consumed from source

`@mercaria/ui` is NOT built to dist. Apps consume it directly through Metro
`watchFolders` pointing at `packages/ui`, the Tailwind preset
`@mercaria/ui/theme/tailwind.preset`, and a `tsconfig.paths` alias.

Do NOT add a build step or dist output. Apps must NOT keep local copies of any
component or utility that lives in `@mercaria/ui`; it is the single source of
truth for `formatMoney`, `formatReviewCount`, `PriceDisplay`, `FxContext` and all
marketplace UI primitives.

### `@mercaria/shared-types`

Domain DTOs (`Listing`, `ListingCondition`, `Seller`, `Money`, `CurrencyCode`,
`CURRENCY_PRECISION`, `CURRENCY_SYMBOLS`, `ApiResponse`, pagination). Build with
`bun run build:shared-types`.

## Currency: multi-currency, provider-neutral, FAIR preferred

Mercaria is **multi-currency**, Shopify-Markets style (presentment plus shop).
**No currency is a settlement invariant.** FairCoin (`FAIR`, symbol) is a
PREFERRED default — the presentment currency a buyer gets when they have chosen
none, and the display default — which is product policy, not architecture. What a
payment actually settles in is a property of the payment provider handling it and
is decided in the payment domain (ADR 0001 D6/D8), never in the money contracts.

The currency set is data driven: `CurrencyCode`, `CURRENCY_PRECISION`,
`CURRENCY_SYMBOLS` and `ALL_CURRENCY_CODES` in `@mercaria/shared-types`. Adding
a code there changes the TypeScript union immediately but changes nothing in
Postgres: every currency column carries a CHECK derived from the same tuple
(`db/schema/CONVENTIONS.md`), so adding a code is a code change plus
`bun run db:generate` plus an additive (`pre`) migration landed in the same PR —
skip the migration and the first write of the new code fails its CHECK in
production even though the build is green.

The six roles the code distinguishes: **catalog** (what a price is stored in),
**display**, **presentment/charge**, **merchant accounting** (`DualMoney.shop`),
**provider settlement** (payment domain only) and **secondary display**.

- **The catalog stores NATIVE currency.** `catalog-write.service` persists a
  variant or listing price in its own `.currency` exactly as given and converts
  nothing.
- **`DualMoney { shop, presentment }`** (shared-types) carries every TRANSACTED
  amount on orders and refunds. `shop` is the seller's own accounting currency
  (`Store.defaultCurrency`, or for a P2P order the seller's listing currency) and
  is the basis for reports and refunds; `presentment` is what the buyer saw and
  paid (their `preferredCurrency`, else FAIR). Order line `unitPrice`,
  `lineTotal` and `discountTotal`, `totals.*`, `shipping.cost`, and refund line
  amounts and `totalRefunded` are all `DualMoney`. The order also snapshots
  `fxRate` for reproducibility.
- **`FxRateSnapshot` identifies a conversion completely**: from, to, rate,
  `provider` and `asOf`. `provider` is an FX provider id, a connector provider id
  when the rate came from an imported order's own amounts, or `'identity'` for a
  same-currency order. A later rate move can never alter a stored amount.
- **`paid` converts NOTHING.** `order.service.transition('paid')` does the CAS,
  the inventory commit, `salesCount` and the customer upsert — no FX call, so a
  native EUR order reaches `paid` with no rate for any other currency obtainable
  (pinned by a test that mocks `fx.service` to throw). The former shop-to-FAIR
  `settlement` snapshot and `convertToFair` are **deleted**, and the drizzle
  `settlement_*` columns went with them in the payment domain's `post` migration.
  A payment's own settlement conversion lives on `payments.platform_*` plus its
  rate snapshot — per payment, not on every order.
- **Pricing engine** (`pricing.service.calculateTotals`) prices in the SHOP
  currency, converting native line prices to it, and returns `DualMoney` for
  every total; it takes a `presentmentCurrency` and `rates` from the caller.
  Discount and tax BREAKDOWN lines (`appliedDiscounts`, `taxLines`) stay
  single-currency SHOP amounts, since those are the accounting and refund basis.
- **Cart is not currency-pinned.** It holds items priced in different native
  currencies and converts each to the buyer's presentment currency at hydration.
- **Reports and customer stats sum the SHOP side**, `$match`ed to the store's
  `defaultCurrency` (`report.service`, `order.storeStats`,
  `customer.stats.totalSpent`), never mixing currencies, and every aggregate they
  emit is a `Money` that names its own currency.
- **FX service** (`fx.service`) is provider-neutral: `getRates(base, quotes)`
  takes ANY base, and `convert`/`pairRate`/`toDualMoney` read both sides against
  the rate map's own base. The configured providers happen to publish "per 1
  FAIR", so the service derives other bases from that — a private implementation
  detail (`PROVIDER_PIVOT_CURRENCY`), not a contract; callers ask for the pairs
  they need. The FX source is the FairCoin Explorer API
  (`explorer.fairco.in/api/price`, 1 FAIR in USD), Redis cached with last-good
  and stale fallback, with `StaticFxProvider` for dev and tests. `getRates` never
  throws and never fabricates a missing pair (it omits it); `convert` then fails
  closed.
- **Amounts are bounded and the bound is ENFORCED.** `MAX_MONEY_MINOR_UNITS`
  (`Number.MAX_SAFE_INTEGER`, about 90.07 million at FAIR's eight decimals) and
  `assertSafeMoneyAmount` live in shared-types and are called at every
  construction boundary: the request schemas (400), the pricing engine outputs,
  `convert`/`toDualMoney`, refund proration and checkout's grand total. Note
  `z.number().int()` alone accepts `1e300` — the ceiling is what makes the
  check real. (Every money column is `bigint({ mode: 'number' })` in Postgres,
  which re-imposes this same JS ceiling at the storage layer — see
  `db/schema/CONVENTIONS.md`.)
- **External connector orders keep the source platform's amounts verbatim** and
  its own rate; Mercaria FX never re-prices an imported order.
- **DISPLAY** goes through `PriceDisplay` and `FxContext` in `@mercaria/ui` (do
  NOT duplicate), converting a native `Money` to the chosen display currency
  (primary is preferred or FAIR, plus an optional secondary fiat).

## Payments: a provider-neutral domain and a balanced ledger

`oxy_pay` is **gone** — a clean cut, not an alias. It named a rail nobody built.
`PAYMENT_PROVIDER_IDS` in `@mercaria/shared-types` is `external | manual_pos |
mock | stripe`. FairCoin is **not** a payment method in this roadmap; if it is
introduced it arrives through OxyPay — the Oxy gateway that accepts FairCoin —
under its own ADR, as an adapter behind `services/payments/provider.ts` adding
its own value with its own migration. Nothing anticipates it today.
Full model, index, retention and boundary reference: **`docs/payments.md`**;
the binding decisions are ADR 0001 (`docs/adr/0001-stripe-connect-architecture.md`).

Stripe is **whole, in both directions**: seller onboarding and the readiness gate
(#46), the event ingress with its verification, durable processing and replay
(#48), the adapter that creates the charge, cancels it and pays each seller
(#47), the money coming BACK — refunds, transfer reversals, disputes and payout
health (#49) — and the reconciliation, observability and operator recovery that
make all of it operable (#50). Every event type ADR 0001 subscribes to is now
APPLIED; nothing in the router is deferred.

**The ledger is load-bearing from day one.** ADR 0001 D3 gives up Stripe's
`application_fee_amount` reporting, so Mercaria's commission — the charge minus
the sum of the sellers' nets — exists NOWHERE except `ledger_transactions` and
`ledger_entries`. It is not accounting hygiene to add once revenue matters.

### The rules that are load-bearing

- **Balance is enforced three ways, and none of them is a convention.**
  `db/payments/ledgerRepository.ts` is the ONLY writer and refuses an unbalanced
  set before issuing SQL; a database TRIGGER raises on UPDATE and DELETE against
  both tables; randomized property tests over mixed currencies pin both. A
  correction is a REVERSING transaction — there is deliberately no
  `reverseTransaction(id)` helper, because one would make a correction a function
  of what is stored rather than of what an operator decided.
- **The sign convention:** positive is a debit, negative is a credit, and every
  transaction sums to zero PER CURRENCY. No `direction` column, because two
  representations of one fact can disagree.
- **`external` and `manual_pos` book NO ledger entries.** They are payments
  Mercaria RECORDS, not payments Mercaria makes: visible and linked to their
  order, with no false Mercaria cash (ADR D12). `PROVIDER_BOOKS_LEDGER` in
  `payment.service.ts` states it as a table, since the question is "did Mercaria
  receive and owe this money", not "is it external". `mock` DOES book, and is
  hard-gated by `config.orders.mockPayEnabled`.
- **One payment per checkout GROUP for native rails** (partial unique index), and
  one per ORDER for `external` — because two connected shops can import orders
  with the same external id, which collides their synthetic `ext:` group ids.
- **A provider id is NEVER a Mercaria primary key.** Every `provider_object_id` is
  a plain indexed column; their key space changes between test and live mode.
- **The payment outbox is the moderation outbox, ported.** Deterministic ids so a
  repeat converges, the row IS the job, claims are leases with an owner check
  (`FOR UPDATE SKIP LOCKED`), capped exponential backoff, visible `dead_letter`.
  Gate the LOOP, never the durable record.
- **Payloads are redacted by an ALLOW-list** (`services/payments/redact.ts`) and
  never stored or logged wholesale. A deny-list is correct only until the provider
  adds a field, which is exactly when a sensitive one appears.

### Stripe webhooks (#48): two endpoints, and the rules around them

`POST /webhooks/stripe` (platform scope) and `POST /webhooks/stripe/connect`
(connect scope) — two Stripe objects with two SECRETS, which is why they cannot
share a path. Env is `STRIPE_ENABLED`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET(_PREVIOUS)`, `STRIPE_CONNECT_WEBHOOK_SECRET(_PREVIOUS)`,
`STRIPE_SELLER_COUNTRIES` and the `STRIPE_EVENT_*` loop tunables. Full behaviour:
`docs/payments.md` §"The Stripe event ingress".

- **They are the THIRD raw-body mount**, beside `/channels/webhooks` and
  `/webhooks/crowdsource`, and must stay before `express.json()`. Asserted
  against the real chain by `routes/__tests__/stripe-webhook.integration.test.ts`
  with a real signature and a json-parsed vacuity guard.
- **The MOUNT is gated by `STRIPE_ENABLED`, so an unconfigured deployment 404s.**
  This is NOT the "gate the loop, never the record" rule above and must not be
  changed to match it: without a secret there is nothing to verify, so accepting
  bytes to process later would be storing a stranger's opinion.
- **`STRIPE_ENABLED=true` requires the key AND BOTH webhook secrets.** One
  endpoint configured means sellers silently stop becoming payment-ready while
  charges keep succeeding. There is no `STRIPE_ACCOUNT_ID` and no API-version
  variable — the version is the code constant `STRIPE_API_VERSION`, and livemode
  is DERIVED from the key's prefix so it cannot disagree with it.
- **The event ROW is the job.** `payment_provider_events` carries the claim
  columns; there is deliberately no outbox row pointing at an event row. Receipt
  and processing are separate, so **a 200 means stored, never processed**.
- **Use `constructEventAsync`, never `constructEvent`** — and the async test
  helper too. Under Bun (which `bun run dev` uses) `stripe` resolves its worker
  build and every SYNCHRONOUS crypto entry point throws, while production on Node
  works fine: the bug would be invisible where it is tested and total where it is
  written.
- **No rate limiter on these paths, deliberately.** Stripe delivers from a small
  IP pool, so a per-IP bucket is one bucket for the whole provider and a
  legitimate retry burst would trip it until Stripe disabled the endpoint. The
  bound is `express.raw`'s size limit plus refusal before any database access.
- **A deferred handler writes `deferred: #NN` into `processing_note`.** Several
  subscribed event types belong to #47/#49 and arrive today; marking them
  `processed` silently would make a seam indistinguishable from real handling in
  the operator trace. The three `account.*` types were in that set until #46.

### Connected accounts and payment readiness (#46)

`provider_accounts` — one row per seller per rail. Env adds
`STRIPE_ONBOARDING_BASE_URL`, `STRIPE_ONBOARDING_RETURN_URL`,
`STRIPE_ONBOARDING_STATE_SECRET` and the `STRIPE_ACCOUNT_SYNC_*` tunables. Full
behaviour, plus the test-mode runbook: `docs/payments.md` §"Connected accounts"
and §"Runbook".

- **Readiness is ONE stored verdict**, `onboarding_state`, derived from ADR 0001
  D9's conjunction at synchronisation. There is deliberately no `ready` boolean
  beside it and nothing re-derives it: two representations of one fact can
  disagree, and the place that must not happen is a checkout gate admitting a
  seller because a flag was stale. `charges_enabled` is recorded and is NOT a
  conjunct — under separate charges and transfers the connected account never
  charges anything.
- **`UNIQUE(provider, owner_type, owner_id)` is the security boundary**, and the
  reason the owner is ONE polymorphic column rather than the pair `orders` uses.
  Its outer half is a Stripe idempotency key derived from the OWNER
  (`acct:<ownerType>:<ownerId>`): a Mercaria row can be deduplicated after the
  fact and a Stripe ACCOUNT cannot be un-created, so a key derived from a
  freshly-minted row id would differ between two racers and defeat itself.
- **No handler ever applies an `account.*` PAYLOAD.** All three types and the
  reconciliation sweep re-read the account from Stripe, because requirements are
  the most volatile thing it reports and deliveries are unordered.
  `account.application.deauthorized` is the one that must NOT re-read — the
  access is gone, and a retryable failure there would dead-letter the event while
  leaving an unpayable seller marked active.
- **Requirements are COUNTS in real columns**, never a jsonb summary. That is a
  security property, not tidiness: an integer column cannot hold
  `individual.verification.document`. Reason codes are shape-checked and replaced
  with `other` if they could be a sentence or a name.
- **The checkout gate runs BEFORE any reservation** and lives in
  `services/payments/provider-account.service.ts`, which knows nothing about
  Stripe — `checkout.service` importing a Stripe module would make the card rail
  structural to placing an order. With `STRIPE_ENABLED` off it returns before
  touching Postgres, and BOTH branches are pinned by tests.
- **A `return_url` redirect proves nothing** (ADR D2). Onboarding round trips are
  authenticated by a signed, expiring state token; `refresh` re-mints but never
  CREATES an account, and a tampered state is answered 400 and never a redirect —
  the only destination available would be one derived from an unverified
  parameter.
- **The status projection names every field explicitly** and never carries the
  connected-account id, in any form. Account ids are redacted to their last four
  characters in logs.

### Checkout on the card rail (#47)

One PaymentIntent per checkout GROUP, one Transfer per seller order. Env adds
`STRIPE_PLATFORM_CURRENCY`, `STRIPE_PRESENTMENT_CURRENCIES` and the optional
public `STRIPE_PUBLISHABLE_KEY`. Full flow, the retry model, the withheld-transfer
exception and the client split: `docs/payments.md` §"Checkout and the Stripe rail".

- **`checkout.service` still imports no Stripe module.** The rail choice, the
  currency gate and the client handoff live in
  `services/payments/checkout-payment.service.ts`, beside the readiness gate and
  for the same reason.
- **The charge is booked in the currency the money LANDED in.** On success the
  event handler reads the charge's balance transaction and passes the platform
  amount, its captured rate and Stripe's fee into the status change, so the
  ledger and the transfers are both denominated in `STRIPE_PLATFORM_CURRENCY`. A
  payable credited in USD and paid in EUR would never net to zero. An unavailable
  balance transaction is RETRYABLE, never guessed.
- **`seller-net-shares.ts` is the ONE definition of a seller's net** — the exact
  gross split (`settlement-shares.ts`, largest remainder; no commission
  arithmetic lives there) minus each order's immutable marketplace-fee snapshot
  (#88). THREE readers: the charge's ledger posting, the transfer, and the
  refund proration. `Σnets + Σfees == gross` exactly, so `commission_revenue` —
  which ADR D3 defines as the residual — receives precisely the snapshot fees;
  converting each order independently would leak rounding residue into it.
- **The cart is emptied AFTER the payment is opened.** A failure then leaves the
  orders, their reservations AND the cart lines, so re-submitting the same
  `Idempotency-Key` converges. Emptying first would answer that retry with "Cart
  is empty".
- **A withheld transfer never blocks its siblings.** A seller who lost readiness
  between funding and settlement keeps a `pending` transfer row, an open payable
  and a `transfer_withheld` outbox row; the buyer's order stays `paid` and the
  other sellers settle. A RETRYABLE rail failure is rethrown instead, so the
  outbox retries the whole settlement.
- **The reservation sweep cancels the PaymentIntent, stock first.** Its failure is
  information: Stripe refusing to cancel a captured intent means the money beat
  the sweep, Mercaria marks the payment `canceled` anyway, and the succeeded event
  raises `payment_succeeded_after_release` rather than overselling.
- **Payment retries never extend a reservation.** The clock is the ORDER's
  creation time. A declined confirmation is retried on the SAME intent; a
  cancelled one is not reusable and its orders are already gone.
- **A client cannot forge paid state.** `POST /checkout` returns only
  `{paymentId, provider, clientSecret, publishableKey?, amount}`; the client then
  POLLS `GET /checkout/:groupId/payment-status`, which answers from the payment
  aggregate. `checkoutSchema` is `.strict()`, so no card-shaped field can even
  reach the server.

### Refunds, disputes and payouts (#49): money coming back

`refund.service` keeps deciding WHAT is refundable and commits that first;
`services/payments/refund-execution.service.ts` moves the money from a
`payment_refunded` outbox row. Full mechanics, the ledger tables and the
runbook: `docs/payments.md` §"Refunds, disputes and payouts".

- **The commerce record commits BEFORE the rail is called** (ADR 0001 D7), so a
  slow rail cannot refuse a refund a merchant authorised. The refund row and its
  outbox row commit in ONE transaction, because a provider call living in the
  request would evaporate on a restart AFTER the inventory had been restocked.
- **Restock happens exactly once, in the commerce path. A provider outcome NEVER
  touches inventory** — not a success, not a failure, not a duplicate delivery.
- **Three states of one refund and none substitutes for another:**
  `Refund.status` is the commerce lifecycle (already `refunded` at commit),
  `providerState` is the money's, and the payment aggregate's comes from the
  CHARGE's cumulative refunds so one seller's refund cannot close a multi-seller
  payment. Order status moves on the COMMERCE record.
- **The seller's share is `allocateSellerShares`, prorated CUMULATIVELY** — each
  refund reverses the difference between where the transfer should stand and
  where it does. Per-refund proration strands units on a seller's balance
  forever, and the two only disagree on a converted or unevenly-split charge.
- **A failed reversal never blocks the buyer's refund** (D7). The gap is BOOKED:
  the order's `merchant_payable` sits in debit by what the seller owes, the book
  still balances per currency, and `reversal_failed` is an operator decision
  rather than a retry.
- **A refund the rail reports that Mercaria did not make is NEVER turned into a
  local refund** — `refund_unmatched`, because creating one would restock goods
  nobody returned.
- **Disputes are NOT CrowdSource moderation** and the two never import each
  other. An INQUIRY is told apart by the rail's empty balance MOVEMENTS, not by
  its status string, and books nothing. The seller-side recovery runs on a LOSS,
  not at creation — the ADR's diagram says otherwise and is unimplementable,
  because "re-transfer on a win" is a second transfer for one order and
  `UNIQUE(transfers.payment_id, order_id)` forbids exactly that.
- **A payout books NOTHING.** The receivable was settled at transfer time (D6),
  so a failed payout must not reopen it. `payouts.amount_currency` carries no
  currency CHECK — a seller settles in their account's own currency.

### Reconciliation and the operator surface (#50)

Webhooks are the normal event path and are NOT a substitute for reconciliation:
an event that was never delivered is invisible to everything that waits to be
told. Four leased, bounded, resumable sweeps
(`services/payments/reconciliation/`) write `payment_discrepancies` rows; the
operator surface at `/internal/payments/*` reads them and runs four named
repairs. Full mechanics, the fourteen discrepancy kinds and the incident runbook:
`docs/payments.md` §"Reconciliation, discrepancies and operator repair" and
§"Operations (#50)".

- **A sweep may CONVERGE and may never repair.** `open_payments` applies what the
  rail currently says through `applyPaymentStatus` — the same function a webhook
  uses, because a live retrieve IS verified provider evidence (acceptance 5) and
  applying it APPENDS accounting rather than removing any. The reverse direction
  (Mercaria paid, rail not) is recorded and left for a person: orders are already
  paid and sellers may already be transferred.
- **Nothing auto-deletes or rewrites financial history to hide a mismatch.**
  Repairs are explicit operator actions, and the ONE that writes the ledger books
  a NEW balanced `adjustment` through the same repository every other posting
  uses.
- **The repair set is CLOSED** — `retry_withheld_transfer`,
  `retry_transfer_reversal`, `retry_provider_refund`, `book_reconciling_entry`.
  Each drives an existing idempotent path, so this surface adds a TRIGGER and no
  new way to move money. Nothing in `repairs.service.ts` calls
  `applyPaymentStatus`.
- **Idempotency lives where each action actually gets it.** The three retries
  inherit their providers' keys (ADR 0001 D11), so recording a claim for them
  would REFUSE the legitimate second attempt after a failure; only
  `book_reconciling_entry` has no such key, and its claim is a partial unique
  index taken in the same transaction as the posting.
- **Every attempt is audited, refusals included** — `payment_repairs` is
  append-only, one row per ATTEMPT, with a mandatory actor and reason.
- **The operator gate is an ALLOW-LIST (`PAYMENT_OPERATOR_OXY_USER_IDS`) and is
  INTERIM.** Store permissions are scoped to a store by construction, so none of
  them can express "may see all stores' money" without becoming one an owner
  could grant themselves — and Mercaria must not invent a second identity system
  beside Oxy's. An empty list does not MOUNT the router (404, not 401). When Oxy
  grows a platform operator role, `resolvePaymentOperatorIds` and
  `requirePaymentOperator` are the two places that change.
- **`ledgerImbalanceAttempts` must stay ZERO**, and it is process-local because
  the write it counts rolls back. Metrics are a JSON endpoint plus structured
  logs — no prometheus dependency; scraping and alerting wiring belongs to
  `oxy-infra`.
- **A trace opens from five handles and no others** (order number, order id,
  checkout group, payment id, provider object id). No email, no phone, no card
  fingerprint — the `.strict()` schema is what stops an HTTP caller getting
  around `tracePayment`'s own signature.

### Marketplace fees (#88): versioned schedules, immutable order snapshots

`services/fees/` + `db/fees/` + `db/schema/fees.ts` (4 tables). Full reference:
`docs/payments.md` §"Marketplace fees"; schema decisions:
`db/schema/CONVENTIONS.md` §"The fee domain". The rules that are load-bearing:

- **Commercial mode is SNAPSHOTTED with the order** before fee calculation:
  `connected_marketplace` (fee from the schedule — every native checkout today)
  | `external_referral` | `mercaria_retail` | `informational` (the last three
  are `not_applicable` with a **NULL fee, never zero** — CHECK-enforced, so
  `mercaria_retail` can never post `commission_revenue` or read as a zero-rate
  schedule).
- **Schedule versions are immutable once active** (DB trigger + one-active-per-
  key partial unique index); policy changes are NEW versions, published from
  `/internal/payments/fee-schedules*` behind the payment-operator gate.
  Scope is `eligible_seller_type` + `eligible_currency` and NOTHING else —
  buyer/guest/claim/payment-method scopes are unrepresentable, which is what
  makes guest and authenticated checkouts fee-equivalent structurally.
- **The fee base is explicit**: presentment `discounted_item_subtotal` (line
  totals minus item-level discounts; tax/delivery cannot enter). Half-up
  rounding ONCE at order level, recorded; largest-remainder line allocations
  reconcile exactly; fixed/min/max components pin `eligible_currency` (a fee
  never mixes currencies). Ambiguous selection refuses checkout BEFORE
  reservation; no active schedule = honest zero (`no_active_schedule`).
- **The snapshot commits IN the order's transaction** (`insertOrder` is the only
  writer; `order_fee_snapshots` is append-only by trigger) and is the ONLY fee
  input the money path reads — a schedule change never touches placed orders.
  Refund policy `proportional` needs no fee-specific refund code: the seller
  bears only their NET share, so the commission returns through the existing
  residual.
- **Ranking isolation is a test, not a convention** —
  `fee-ranking-isolation.test.ts` fails the build if any feed/search/catalogue
  module references the fee domain.
- Merchant surface: `/admin/stores/:storeId/fees/{schedule,accept,preview}`
  behind `store:manage` (the onboarding permission, same reasoning). Deferred to
  #85: the acceptance GATE on checkout, P2P acceptance surface, change
  notifications, downloadable breakdowns. POS/connector orders carry no
  snapshot (no explicit channel policy yet — reads as zero fee).

### Zero-margin retail pricing (#120): `mercaria_retail` is cost recovery

`services/retail-pricing/` + `db/retailPricing/` + `db/schema/retailPricing.ts`
(4 tables). Full reference: **`docs/retail-pricing.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The retail pricing domain"; binding decisions are
ADR 0004 D3/D7/D8. This is NOT the marketplace fee — a `mercaria_retail` order
pays none, and the retail engine cannot import `services/fees/` (a test).

- **Markup is UNREPRESENTABLE, in four independent places**, not a default
  somebody can change: the vocabulary (`RetailCostComponentKind`'s eight direct
  costs and `RetailForbiddenComponentKind`'s fourteen prohibitions are DISJOINT
  unions); the schema (no markup/margin/profit/padding column exists —
  `absorption_cap_bps` is the domain's only bps column and bounds a Mercaria
  LOSS); the API (`.strict()` schema, plus a refusal that names the exact
  forbidden component instead of "unrecognized key"); and the formula
  (`composeRetailCostOnlyTotal` has no parameter that could add anything, and
  returns `markupMinor` re-derived from the components — a property test pins it
  at zero over randomized inputs).
- **The customer total IS the sum of the component rows.** Cross-row, so
  `insertRetailCostQuote` is the SINGLE writer and refuses a mismatch before
  issuing SQL. The eight components are modelled SEPARATELY, each naming its
  source, currency, observation time and confidence (`quoted | guaranteed |
  estimated | final`), never folded into one inflated unit price.
- **An unknown cost is never zero.** `deriveRetailCompleteness` answers three
  distinct questions — what it knows, what may be SHOWN, whether money may
  move — and the completeness ⇔ presentation mapping is a CHECK, so a blocked
  quote cannot be stored claiming an exact price. Expiry is NOT a completeness
  value: it is derived from `expires_at` against the clock.
- **Supplier costs stay in their SOURCE currency**; conversion happens once per
  component, half-even, with the exact `FxRateSnapshot` stored (present EXACTLY
  when the currencies differ, a biconditional CHECK). `fx_basis` distinguishes
  Mercaria's QUOTED rate from the provider's FINAL one; the difference is
  variance, never profit. **The FX base is the SOURCE currency** — no module here
  names FAIR, FairCoin or OxyPay, and a test asserts it.
- **Quantity is applied in the SOURCE currency, before the conversion.** Per-unit
  conversion multiplies the rounding error by the quantity. No third rounding
  scheme was invented: `fx.convert`'s half-even once per component, then an exact
  integer sum, so nothing is split and `apportion` is not needed.
- **The checkout lock is `UNIQUE(checkout_group_id, quote_id)`** — a retry READS
  the locked total rather than re-pricing. A revised total is a NEW quote plus a
  NEW acceptance naming the one it supersedes; nothing mutates an acceptance,
  except `order_id` moving NULL → a value exactly once (the lock is taken before
  the order row exists), enforced by both a CAS and a trigger.
- **Variance is never margin.** Actuals below the locked amount are the
  CUSTOMER's (`customer_adjustment_owed` → #128); above it, Mercaria absorbs —
  there is no surcharge path and none may be built. The delta is recorded
  whatever the tolerance says, and the tolerance is CHECK-bounded to 5 minor
  units so it cannot be widened into a hiding place.
- **A promotion is a Mercaria marketing expense, structurally**:
  `buyer_payable = customer_total − subsidy` is a CHECK, the subsidy is bounded
  to `[0, customer_total]`, every component is non-negative, and
  `RetailSubsidySource` has ONE member.
- **Eight accounting outputs and NO `retail_margin_revenue`** — a positive
  variance has nowhere to be recognized as revenue. Ranking and referral
  isolation are static gates mirroring `fee-ranking-isolation.test.ts`.
- Operator surface: `/internal/payments/retail-pricing-policies*`, behind the
  same payment-operator allow-list. Seams left to their owners: #121 supplies
  `marketSupported` (LANDED — see the section below; pass
  `getRetailEligibility(...).verdict === 'eligible'`), #122 supplies the source
  costs, #123 calls the lock and
  owns the `orders` widening, #128 BOOKS the variance this domain only
  classifies, #129 renders `presentation` + `blockReasons`.

### Retail eligibility (#121): may Mercaria sell this at all

`services/retail-eligibility/` + `db/retailEligibility/` +
`db/schema/retailEligibility.ts` (9 tables), `/internal/retail-eligibility/*`.
Full reference: **`docs/retail-eligibility.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The retail eligibility domain"; binding decisions
are ADR 0004 D2.8–D2.10 and D12.3–D12.4. `getRetailEligibility(...)` is the ONE
authoritative gate publication (#57/#129), search, cart and checkout (#123) read.

- **The verdict is THREE-valued and `unknown` is not a soft yes.**
  `eligible | ineligible | unknown`, and neither of the last two may publish or
  check out. They are kept apart because they route differently — `unknown` to
  the evidence queue, `ineligible` to a report of what Mercaria decided not to
  sell — and `ineligible` beats `unknown` beats `eligible`, the
  `deriveRetailCompleteness` severity rule applied to a verdict.
- **An affiliate feed can never authorize a resale, structurally.**
  `RetailResaleEvidenceKind` (12) and `RetailForbiddenEvidenceKind` (14) are
  DISJOINT unions; the evidence table's `kind` CHECK and a policy version's
  `required_resale_evidence_kinds` both read the allowed tuple, so a forbidden
  kind has no row shape. `forbidden-evidence.ts` adds the ANSWER (it names the
  prohibition over free text too) and is mounted BEFORE the `.strict()` schema,
  which a test pins by MESSAGE.
- **The verdict is DERIVED and never stored** — the `deriveNativeCheckoutEligibility`
  divergence from the one-verdict rule, because the inputs sit on eleven tables
  in three domains. That is what makes an expired document (acceptance 2) and a
  recall (acceptance 5) bite with NO sweep having run, and it is why the
  emergency path is one INSERT and is testable independently of source refresh.
  `retail_eligibility_decisions` is a RECORDING (the `payment_discrepancies`
  relationship); `eligibility.ts` imports no repository at all and a test fails
  the build if it starts to.
- **Expiry is derived from the clock.** The five REVIEWER states are stored;
  `expired` is not storable. Only a VERIFICATION can lapse, so a rejected
  document past its date is still `rejected` — "renew it" is the wrong next
  action for something somebody refused.
- **An empty scope array means NONE on a policy and UNRESTRICTED on evidence** —
  the `supplier_agreements` grant semantics and the
  `commerce_relationships.territories` scoped-down one, in one file for the
  first time. A freshly drafted policy version therefore permits nothing.
- **A decision cites its policy version by a NOT NULL COMPOSITE foreign key**
  (the `match_category_gates` device), which is acceptance 7. A derivation made
  with no active version answers `unknown`/`policy_missing` and is deliberately
  NOT recorded: a record that cannot be reproduced is evidence of nothing.
- **A recall can never be `advisory`** (a CHECK), one live suppression per
  (scope, subject, kind) (a partial unique, so two operators converge), and a
  lift is attributable, dated and explained.
- **No exception can waive a recall, a suppression, a prohibited category, an
  ambiguous match, missing or expired evidence, an unresolved tax treatment or
  an unavailable refund rail** — `waived_reasons` is containment-CHECKed against
  the waivable set, the HTTP enum IS that set, and four eyes is the row's shape
  (two approvers differing from each other and from the requester).
- **`RETAIL_OPERATOR_OXY_USER_IDS` is a FIFTH allow-list** beside payments,
  catalog, guest and analytics. Empty = not mounted (404). Lifting a recall is a
  compliance power and it is the only one of the five whose misuse puts an
  unsafe product back on sale. There is NO flag that turns the gate off, and no
  `RETAIL_ELIGIBILITY_POLICY_KEY` variable — the key is a code constant.
- Seams left to their owners, each NAMED in code and docs rather than stubbed:
  #122 (live stock/shipping/quote preflight, and the traceability provider whose
  default reports NO DATA and therefore blocks), #123 (calling this gate from
  checkout and the `orders` widening), #126 (customer recall notification), #127
  (supplier cancellation, return, disposal), #59 (ambiguous-match review),
  #120 (pricing, which consumes the verdict as `marketSupported`).

### Where it meets the rest of Mercaria

The domain is **Postgres-native** (13 payment tables + 4 fee tables), like everything else the API serves
since the port — `DATABASE_URL` is REQUIRED to boot (`src/index.ts`).
`services/payments/order-linkage.ts` stays the ONE seam onto orders: the payment
domain reads them through a projection it owns rather than reaching into the order
repository from five places. The payment and the order transition still do not
commit together — the transition runs from the outbox handler, a SEPARATE
transaction — so payment state and order state may briefly differ, and the outbox
is the explicit reconciliation path.

The order keeps only `{status, provider?, paidAt?, reference?, paymentId?}` —
a pointer and the coarse state, never a copy of mutable provider detail.

## Verified relationships and evidence (#55, ADR 0002 D10/D11/D17)

`services/commerce-graph/relationship*.ts` + `db/commerce-graph/relationshipRepository.ts`
+ `db/schema/relationships.ts` (3 tables). Schema decisions:
`db/schema/CONVENTIONS.md` §"The relationship layer". A relationship is a typed,
scoped, temporal, evidence-gated CLAIM — never a boolean and never inferable.

- **No public badge from a name, a logo or a domain.** `verification_method` has
  no `name_match` member, so it is unrepresentable; `SUFFICIENT_EVIDENCE_KINDS`
  then decides which evidence kinds can carry which relationship kind, and
  `domain_control` is deliberately NOT sufficient for `official store`,
  `authorized reseller` or brand ownership — it proves control of that hostname.
- **Verification and confidence are different fields, and confidence is
  CHECK-restricted to ingestion rows.** A 0.99 candidate is a candidate; the
  public resolver filters on `verified` and never reads confidence.
- **Three of the issue's nine types are NOT kinds** — *merchant operates
  storefront*, *brand contains product family*, *brand markets product* are
  foreign keys (D17). `STRUCTURAL_GRAPH_FACTS` names them and a test fails the
  build if a kind duplicates one.
- **`Official store` and `Authorized reseller` are separate kinds, separate
  badges and separate LISTS** on a brand page; a merchant with neither has no
  relationship row at all, which is the normal state.
- **Duplicates are impossible, not refused**: a GENERATED `endpoint_key` +
  partial unique `WHERE valid_to IS NULL`. A plain multi-column unique would let
  them through — Postgres treats NULLs as distinct.
- **Four eyes** covers exactly the badge-producing kinds, defaults ON
  (`CATALOG_FOUR_EYES_REQUIRED`), and is held by a partial unique on
  `relationship_reviews`, not by a service comparison. `review_round` advances
  on every decision so an approval cannot be reused.
- **The public read never trusts `status` alone** — it requires the validity
  window too, so a lapsed claim produces no badge whether or not a sweep ran.
  Revocation keeps the row, its verification facts, its evidence and its reviews.
- Operator surface: `/internal/commerce-graph/relationships*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54 uses. Public reads:
  `/brand-relationships/*`. Ranking isolation is a test
  (`relationship-ranking-isolation.test.ts`), the fee-domain precedent.
- Deferred: the fee-style ranking USE of verification (#72/#74), #56's product
  families (`product_family_id` is a DEFERRED foreign key), and #83's claiming —
  claiming a merchant grants no relationship here, and there is no code path
  that could.

## The unified offer model (#57, ADR 0002 D6/D8/D18)

`services/offers/` + `db/offers/` + `db/schema/offers.ts` (3 tables: `offers`,
`native_listing_links`, `offer_outboxes`). One seller/channel offering one exact
canonical variant on specific terms at a point in time — the row a comparison
surface reads, whether the seller is a Mercaria listing or a crawled retailer.
Schema decisions: `db/schema/CONVENTIONS.md` §"The OFFER layer". The rules that
are load-bearing:

- **Native checkout eligibility is a DERIVATION, never a column**, and this is
  the deliberate divergence from the `onboarding_state` one-verdict rule.
  Payment readiness is one stored verdict because its inputs sit on the row
  being verdicted; offer buyability is a conjunction over the LIVE
  `listings.status`, the LIVE variant stock and the seller's readiness — three
  tables this domain does not own. `deriveNativeCheckoutEligibility` reads them
  at PROJECTION time, so a moderation restriction stops a sale in the statement
  that applies it, with no queue in between. A realdb case pins it: the listing
  is restricted, the offer row is left ACTIVE and stale, and the read refuses.
- **An external offer cannot enter the cart, structurally.** Cart and checkout
  operate on `product_variants`, and `offers_kind_shape_check` forces
  `product_variant_id` NULL on every kind but `native` — there is no id a cart
  line could hold. `offer-isolation.test.ts` pins the other direction and four
  more walls (#58's matcher, #37's redirect, #84's linkage, #74's ranking), plus
  the ONE payment import the domain may make: the readiness seam.
- **Marketplace-ness is not storable.** The offer names its seller of record and
  its channel; the channel's operator is `storefronts.merchant_id`, one join
  away, and comparing them IS the fact (ADR D8). No `is_marketplace` column, no
  platform id copied onto the offer.
- **Unknown is stored as absence, never zero.** A nullable delivery money pair
  with a paired CHECK, a nullable `available_quantity`, and a three-member
  `pickup_state`. `deriveOfferDelivery` returns a discriminated union whose
  unknown branch has no `cost` property, so a ranking cannot read silence as
  free delivery without writing the coercion out loud.
- **Retirement is a status transition and the domain issues no DELETE.** The
  observed price history is the append-only `source_records` chain the offer
  points at — ADR D18 assigns a price-history TABLE to #78, and this one holds
  current state. `stale_at` is ONE deadline (the issue's expiry and the ADR's
  staleness are the same fact); the lapse sweep excludes NATIVE offers, whose
  deadline measures how long ago the converger ran.
- **`offer_outboxes` is one row per LISTING** — a convergence queue, not a
  delivery queue, so its enqueue is `ON CONFLICT DO UPDATE` where the moderation
  outbox's is `DO NOTHING`, and it carries no `expires_at`. The
  `requested_revision`/`claimed_revision` pair is what stops a write that lands
  mid-run being swallowed by the completion that follows it, and the enqueue
  must NOT write a flat `'pending'` over a `processing` row (that releases a live
  lease from outside the worker — measured, the realdb case fails on it).
- Three call sites request convergence: `syncListingFacets` (the existing
  catalog-write chokepoint, so every create/update/variant/stock change is
  covered), `archiveListing`, and moderation enforcement's restrict /
  request-changes / restore. A fourth status-only write path that forgot would
  leave a listing's offers claiming it is on sale.
- Public read: `GET /offers` (exactly one of `canonicalVariantId` /
  `canonicalProductId`, keyset-paginated cheapest-first). Operator surface:
  `/internal/offers/*` behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
  #54/#56 use — trace, converge-now, retire (an EXTERNAL offer only; a native one
  follows its listing). Env: `OFFER_MATERIALIZATION_ENABLED` (gates the loop
  only), `OFFER_OUTBOX_BATCH_SIZE`, `OFFER_OUTBOX_POLL_INTERVAL_MS`.
- Load benchmark: `packages/backend/scripts/offer-load-benchmark.ts`, opt-in
  (`OFFER_BENCHMARK=1` plus a database whose name contains `bench`), Zipf-skewed.
  Deliberately NOT in CI.
- Deferred to their owners: the matching pipeline (#58 — `native_listing_links`
  is the seam and this domain never decides a match), the outbound/affiliate
  redirect (#37 — the routing metadata is modelled and `destination_url` stays
  the ORIGINAL), merchant→store linkage (#84), ranking (#74), the price-history
  table (#78), the `mercaria_retail` offer kind (#116).

## Deterministic matching (#58, ADR 0002 D14/D19)

`services/matching/` + `db/matching/` + `db/schema/matching.ts` (9 tables).
Turning a source observation or a native listing variant into a canonical
product and variant. Schema decisions: `db/schema/CONVENTIONS.md` §"The MATCHING
layer". The failure mode that shapes everything here is the FALSE MERGE: it
looks exactly like a correct match, contaminates every product page and price
comparison downstream, and is discovered by a customer. The rules that are
load-bearing:

- **A conflicting valid identifier can never auto-merge, and that is a CHECK.**
  `match_decisions_blockers_auto_check` refuses `automatic_match` with a
  non-empty `blockers`, so brand mismatch, bundle/multipack/accessory confusion,
  a missing required axis, an operator's rejected pair and a closed category
  gate all stop a merge through ONE mechanism no service bug walks around. Two
  companion CHECKs stop the ways around it (a recorded conflict implies its
  blocker; every blocker appears in the explanation).
- **A semantic score is never the sole authority — and neither is a title.** A
  candidate with no positive value among identifier/brand/model/attribute
  agreement carries `no_deterministic_support`, which is a blocker. Semantics
  are off in THREE independent places (no scorer is registered, which is the
  shipped state; `MATCH_SEMANTIC_ENABLED`; the policy version's own flag), and a
  test runs the whole labelled dataset with all three off and asserts the
  decisions are byte-identical.
- **A category with no recorded qualifying benchmark run cannot match
  automatically.** `match_category_gates` cites its measurement by a NOT NULL
  COMPOSITE foreign key carrying the policy version, so an uncited gate and a
  gate citing another policy's run are both unrepresentable. The precision and
  sample floors are the service's, because a CHECK may not contain a subquery.
  **The identifier stages are deliberately NOT gated** — a check digit and a
  single active owner have no error rate a benchmark could measure, and gating
  them would make a fresh deployment unable to attach a single barcode listing.
- **An unknown feature is left out of the confidence DENOMINATOR**, never read
  as zero and never as the mean of the others. That arithmetic IS #58 rule 5:
  reading unknown as zero makes every unbranded P2P listing unmatchable.
- **A blocked pair is keyed on the STABLE subject identity**, not on the
  observation — `source_records` mints a new row per content change, so a
  rejection keyed on the observation would evaporate on the next crawl.
- **`create_new` is a RECOMMENDATION.** The matcher never mints a canonical
  product, never writes an `offers` row and never resolves an identifier
  dispute; a test fails the build if any of those change.
- **This closes #57's seam.** An automatic match on a native variant writes the
  `native_listing_links` row through #57's own repository and calls
  `requestNativeOfferSync`, in ONE transaction — so a native listing becomes a
  native offer end to end. The link's `method` is the STAGE that produced it
  (`barcode_gtin` with NULL confidence for a deterministic match, `matcher` with
  a number for a heuristic one, which is what #59 reviews).
- **The benchmark is a gate, not a fixture dump.**
  `services/matching/benchmark/` holds a versioned, content-addressed labelled
  dataset covering all eight case kinds the issue names; it runs against an
  in-memory catalogue so the whole set runs in CI on every push, sharing scoring
  and the policy with production byte for byte and simplifying only RETRIEVAL.
  A scale pass is opt-in behind `MATCH_BENCHMARK_SCALE`.
- Operator surface: `/internal/matching/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57 use — metrics (queue
  AGE and ambiguity rate), traces, the review inbox, policy versions, category
  gates, blocked pairs, and triggers for one evaluation / one drain / one sweep
  page. Env: `MATCH_PIPELINE_ENABLED` (gates the LOOP only — the queue always
  accepts), `MATCH_QUEUE_BATCH_SIZE`, `MATCH_QUEUE_POLL_INTERVAL_MS`,
  `MATCH_SWEEP_BATCH_SIZE`, `MATCH_SEMANTIC_ENABLED`.
- Deferred to their owners: the correction/merge workflow (#59 — it consumes
  `match_decisions.review_state`, the candidate rows and `match_blocked_pairs`),
  bulk external ingestion (#37), the canonical minting a `create_new` recommends
  (#60), ranking (#74). Source observations are matched by the same pipeline but
  their ATTACHMENT (`canonical_*_source_links`) belongs to the ingestion path
  that owns the observation, not to the matcher.

## Catalogue curation (#59, ADR 0002 D12/D16): review, merge, split, correct

`services/curation/` + `db/curation/` + `db/schema/curation.ts` (8 tables) + the
curation half of `routes/internal-commerce-graph.ts`. Full reference:
**`docs/curation.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Catalogue curation". #58 decides what a matcher may do WITHOUT a person; this
is everything it refused, plus the corrections no automatic rule may make.

The failure mode that shapes it: a merge is the only operation in the graph that
ENDS an identity, and its damage is invisible — every page still renders, and
the two things quietly made one are found months later by a seller whose sales
landed on somebody else's product page. A HALF-finished merge is worse than
either state.

- **The rehoming plan is checked against the SCHEMA, not read out of the code.**
  `merge-plan.ts` declares every column referencing each of the seven mergeable
  entities and what a merge does with it; `merge-plan-census.test.ts` walks the
  drizzle tables for every foreign key targeting one and asserts the plan covers
  EXACTLY that set. **A new table referencing a mergeable entity fails the build
  until somebody decides what a merge does with it** — which is the point,
  because finding fewer referencing tables looks identical to there BEING fewer.
  `untouched` WITH A REASON is a decision the census accepts; silence is not.
  It fired on its first rebase: #60 and #121 added EIGHT references between
  them and the build refused until each had a disposition. The one to read is
  `retail_suppressions` — a recall stores its id TWICE (a typed FK plus the
  polymorphic `scope_ref` the derivation matches on, forced equal by CHECK), so
  the plan moves both together, and the absence guard is narrowed to the partial
  unique's own `WHERE lifted_at IS NULL` predicate. **A guard wider than the
  index it guards is a bug in the safe-looking direction**: a LIFTED suppression
  on the winner would block a LIVE one from following its entity, silently
  un-suppressing a recalled product.
- **Nothing moves until every collision has an explicit decision** (#59 merge
  invariant 4). The `plan` phase probes six conflict kinds, each naming a REAL
  unique index; the job BLOCKS while any is undecided. `blocked` is a separate
  status from `failed` and is NOT claimable: retrying a judgement only a person
  can make spins the dispatcher and buries real faults.
- **Resumability is the PHASE RECORDS, not the phase column.**
  `catalog_merge_job_phases` is `UNIQUE(job_id, phase)` + append-only: a phase
  already stamped is skipped, one claimed but never stamped is RE-RUN. Every
  rehoming statement is idempotent, so `verify` is literally a re-run of every
  plan target asserting nothing moves — the verification and the idempotency
  proof in one, with no second description of the plan to drift.
- **Each phase runs in its OWN transaction**, and #76's aggregate rebuild runs
  AFTER the phase commits. Calling it inside deadlocks the merge against itself:
  `rebuildScopedAggregate` opens its own connection and writes the row the
  transaction locked. Presents as a hang until the runner's timeout, no error.
- **The tombstone is stamped LAST of the mutating phases.** Until then the loser
  is a live entity and a crash leaves a resumable job; stamping first leaves a
  dead identity with live children and nothing saying which phase was owed.
- **A split may REVIVE a tombstone**, and that is what makes "a mistaken merge
  can be split without losing source mappings" work: every mapping is keyed on
  the entity's ID, so minting a fresh row satisfies the word and destroys the
  thing. `new_entity` is CHECK-restricted to a canonical PRODUCT — a variant's
  identity is its option assignments, and minting one would invent them.
- **The assignment list IS the split.** Anything not named stays; a trigger
  freezes the list once the job leaves `plan`, so the set an operator approved
  with an impact estimate beside it is the set that executes.
- **The timeline is append-only against UPDATE *and* DELETE** — the inverse of
  `analytics_events`, deliberately. A compensating correction NAMES the revision
  it undoes (backwards in time, so it always resolves) and RECORDS the undo
  rather than performing it: replaying a `before` snapshot would write columns
  whose meaning has since moved.
- **Four eyes is two CHECKs** (`approved_by <> requested_by`, and "cannot leave
  planning unapproved"), reading ONE flag `CATALOG_FOUR_EYES_REQUIRED` that #55
  also reads — a merge and a badge are the same kind of decision. The impact and
  the approval requirement are SNAPSHOTTED, so a threshold change cannot
  retroactively unapprove a job somebody ran.
- **A `BEFORE UPDATE` trigger must not compare a STORED GENERATED column** — it
  is computed AFTER the trigger, so `NEW.<col>` is NULL and the comparison
  raises on every update. Cost a real bug here; caught only by the realdb suite.
- Env: `CURATION_JOBS_ENABLED` (gates the LOOP, never the request),
  `CURATION_JOB_BATCH_SIZE`, `CURATION_JOB_POLL_INTERVAL_MS`. Operator surface
  is `/internal/commerce-graph/*` behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
  allow-list #54/#55/#56/#57/#83 use.
- **Known gap, stated in `docs/curation.md`:** the pre-#59 direct merge
  endpoints on `/internal/canonical-catalog` (#53/#56's `mergeCanonicalProducts`
  and siblings) still merge in one transaction WITHOUT the conflict gate, the
  census-complete plan, the impact estimate or the timeline. The merge an
  operator should use is `POST /internal/commerce-graph/merge-jobs`.

## Shipping: Moovo, not ready

Shipping UI is HIDDEN everywhere. The backend retains only a seam (the
`order.shipping` snapshot, cost zero). Do NOT build shipping zones or rates;
Moovo owns that entirely.

## Backend domain model

One unified API (`packages/backend`) serves storefront, dashboard and POS.

- `Listing`, with ownerType `user | store`, including `ProductVariant` child
  rows.
- **`listings.published_at` is the FIRST activation, never the row's birthday**
  (#261). NULL until a listing is `active`, stamped by the first transition to
  it, never restamped and never cleared — `created_at` is where "when was the row
  written" lives. `db/catalog/listingRepository.ts` is the only author: the three
  statements that can write `listings.status` (`insertListing`,
  `updateListingColumns`, `setListingStatusIfIn`) each derive it, the stamp is a
  SQL `coalesce` rather than a read-then-write, and
  `listing-publication-chokepoint.test.ts` fails the build on a fourth production
  writer of that table. **No backfill, deliberately**: nothing distinguishes a
  draft that was never published from one that was `active` and was returned to
  `draft` by moderation's `request_changes`, so a pre-#261 draft may carry a
  stamp. The feed-ordering change was accepted — every read ordering by the
  column filters `status='active'`, and the two draft-showing screens order by
  `created_at`.
- **`product_variants.sku` and `.barcode` are unique at NO grain** (#296).
  Both carried a table-wide partial unique from the genesis migration, ported
  from Mongo's `sparse: true, unique: true`, and both were an AMBIGUITY CHECK
  wearing a constraint's clothes. A `barcode` is one seller's OBSERVATION of a
  trade item, and two merchants selling one trade item share a GTIN by
  definition — so the unique made the premise `offers` and every price
  comparison rest on unreachable; GTIN identity is `product_identifiers`'
  collision gate, which answers `disputed` plus a review item rather than a raw
  23505. A `sku` is a merchant's own code: Shopify enforces no uniqueness at all
  and WooCommerce enforces it site-wide, so it is NOT narrowed to
  `(listing_id, sku)` either — the `product_identifiers` MPN ruling, that a
  constraint which has to be wrong sometimes is worse than none. The check they
  were standing in for now lives where it can NAME what it found:
  `matchIncomingVariant` (pull) and `resolveInventoryVariant` (push) each refuse
  to pick between candidates, and the push rail reports its own `ambiguous`
  action rather than `skipped` — "we could not find it" and "we found several
  and will not guess" send a merchant to opposite places.
- `Location` plus `InventoryLevel` for multi-location inventory; the `$inc` guard
  is race-safe at the location grain.
- `Collection`, manual plus automated rules, materialized into
  `Listing.collectionIds`.
- `Discount`: code or automatic, percentage/fixed/BOGO, scopes, usage limits,
  combinability.
- `TaxRate` per jurisdiction.
- `Customer`, including POS walk-ins, upserted on paid with running stats.
- `DraftOrder` for a POS sale; `complete` converts it to a paid Order,
  idempotently.
- `Refund`: partial or full, per-line restock at location,
  `partially_refunded` status, no double restock.
- Store settings (policies, notifications, tax config) and reports
  (`/reports/summary`, `/reports/sales`, `/reports/top-products`).

**Pricing engine** (`pricing.service.calculateTotals`): subtotal, then discounts,
then taxes, then shipping, then grand total, with exact half-even reconciliation.

**Store permissions:** 17 perms (`STORE_PERMISSIONS` in
`db/schema/stores.ts`, includes `channels:write`). Role matrix: `owner` gets
17/17, `admin` gets 16/17 (no `store:manage`), `staff` gets 9/17 operational.
**`store:manage` is the one permission an `admin` does not hold**, which is why
the payment-onboarding routes use it rather than `settings:write`. Every buyer
id, seller id and `oxy_user_id` is a foreign SERVICE's primary key (Oxy owns
identity) and carries no foreign key; see `CONVENTIONS.md` below.

**Admin API prefix:** `/admin/stores/:storeId/*`, consumed by dashboard and POS.

## PostgreSQL

The backend is Postgres-native: `DATABASE_URL` is **required to boot**
(`src/index.ts`). Every route, the moderation outbox and the payment domain run
against it; there is no second store. Database `mercaria` on the shared RDS
instance `oxy-postgres` (`postgres.internal.oxy.so:5432`), owned by role
`mercaria`, with PostGIS installed once by a privileged role (it is not a
trusted extension — see `docs/runbooks/30-postgres-database-provisioning.md`
in `oxy-infra`).

- **Driver/ORM:** drizzle-orm + postgres.js, via `@oxyhq/db` — it owns the
  column builders, the casing authority (`DATABASE_CASING`), the migration
  ledger/deploy-phase enforcement, and the throwaway-database test harness. Do
  not hand-roll something `@oxyhq/db` already provides.
- **Schema:** `packages/backend/src/db/schema/` (drizzle table defs, one file
  per domain). `packages/backend/src/db/schema/CONVENTIONS.md` is the
  canonical, binding ledger for this port — naming, primary keys, the
  `DualMoney` four-column expansion, closed value sets (`text` + CHECK, never a
  pg `enum`), timestamps, foreign keys/`ON DELETE` decisions, the `jsonb`
  register (which columns earned it and why), generated columns, and the full
  Mongoose-model → Postgres-table map. Read it before touching the schema.
- **Migrations:** `bun run db:generate` (drizzle-kit) writes the SQL;
  `packages/backend/src/db/migrate.ts` (invoked as `bun run db:migrate --
  --target-database=<name> --phase=pre|post|all`, and in production as the
  compiled `dist/db/migrate.js` run as a one-shot ECS task) is the **only**
  thing that applies it — never `drizzle-kit migrate` (devDependency only,
  cannot reach the production image). Every generated `.sql` file needs exactly
  one `-- oxy:deploy-phase=pre` (additive) or `-- oxy:deploy-phase=post`
  (drops/renames/narrows) marker; there is no default. `deploy-aws.yml`'s
  `workflow_dispatch` input `migration_phase=all` applies the whole chain in
  one run before the rollout — for a from-zero/cutover batch only, never a
  normal release.
- **Tests:** `docker-compose.postgres.yml` runs a local `postgis/postgis:17-3.5`
  on port 5435 for `bun run --cwd packages/backend test`; CI/deploy pin the
  same image via a service container. Each suite run gets its own throwaway,
  fully-migrated database (name pattern `oxydb_test_<16 hex>`, from
  `@oxyhq/db/testing`), created and dropped by
  `packages/backend/src/db/testDatabase.ts`, which shells out to the real
  `migrate.ts` entrypoint rather than composing `runMigrations` a second time.
- **A test that widens a global bound widens it for every parallel file.**
  `reconciliation.realdb.test.ts` sets
  `PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS='0'` so a payable it just
  booked is sweepable; that buffer is the ONLY thing bounding `auditOpenPayables`,
  an aggregate over the whole of `ledger_entries`, so one
  `auditLedgerPage({cursor:null})` reports `merchant_payable_unexplained` for
  every unexplained open payable in the database — and `recordDiscrepancy`'s
  upsert REOPENS the row `repairs.realdb.test.ts` had resolved, failing in the
  victim as `expected 'open' to be 'resolved'` while naming nothing about the
  cause. **The zeroed config value IS the missing scope, so no census over query
  text sees anything wrong.** Aim with a cursor floor computed as
  `max(id) where id < <fixture id>` — never a pre-taken `max(id)`, since
  `@oxyhq/db`'s uuid v7 is not monotonic within a millisecond — else hold
  `reconciliation-sweep-slot.ts` file-wide. Scoping the ASSERTIONS is not enough
  when the call WRITES.
- **A trigger-toggle window may name exactly ONE table, and the mutex is not
  what makes that safe.** `ALTER TABLE … DISABLE TRIGGER` takes
  **ShareRowExclusive** (measured off `pg_locks` and off CI's `40P01` detail —
  NOT the `ACCESS EXCLUSIVE` this file claimed until #301). It does NOT conflict
  with `AccessShare`, so a reader is never the counterparty; it DOES conflict
  with `RowExclusive`, so **an ordinary INSERT is** — and `withTriggerToggleLock`
  serialises window against window, so it cannot see that party at all. A window
  holding one table's lock while acquiring a second's deadlocks against any
  writer taking the pair the other way round: measured, `ledger_entries` →
  `ledger_transactions` against `insertLedgerTransaction`, which killed a
  `Deploy to AWS` on `main` (9c1d430) and re-ran green. **Fix by splitting, never
  by matching the writer's order** — both orders already exist here
  (`insertLedgerTransaction` parent-then-child because the FK forces it,
  `applyRewardAdjustment` child-then-parent), so an ordering rule is a bet, while
  one disable per window leaves exactly one STRONG lock and every other lock
  `RowExclusive`, which never conflicts with another `RowExclusive`. Gated with
  no exemption by `advisory-lock-census.test.ts` rule 4. **The unforced suite
  cannot measure this**: 0 failures in 30 runs at base, 8/10 once a load
  generator holds the writer between its two INSERTs — a green A/B here means
  the window never opened.
- **A correctly-scoped teardown can still be blocked by a row a SIBLING minted.**
  The matcher's retrieval is a trigram scan over every `canonical_products` row,
  so a sibling's `runMatch` records a `match_decisions` row citing another file's
  fixture, and both citing columns are `ON DELETE restrict` — measured once in
  four full baseline runs. The owner DECLINES exactly the pinned ids
  (`planCanonicalTeardown`) rather than deleting a sibling's row, which would
  convert a loud teardown failure into a silent wrong answer and would
  additionally have to clear `catalog_source_objects.last_match_decision_id` in a
  third domain. **Never `catch` the `23503`** — that also hides a genuine
  children-first mistake. The discriminator for this whole class is not which
  column a teardown is scoped by, but whether a sibling has since referenced the
  rows it owns.
- **Legacy Mongo/Mongoose is GONE** (code removed post-cutover in PR #136; the
  `mercaria-production` database itself DROPPED on 2026-08-08): no `src/models/`,
  no `src/lib/db.ts`, no `mongoose` in `package.json`, no `MONGODB_URI` secret or
  SSM parameter. There is no rollback target and no re-running the backfill — the
  only copy left is a final dump archived offline. Postgres is the sole authority
  for every byte this service owns.

### Rebasing a migration behind another branch's

Two branches that each generate a migration collide on the SAME index, and the
resolution is mechanical — but every part of it that gets done by hand is a way
to corrupt the chain silently. Measured across four branches rebased in one
batch (#94, #105, #58, #77), each of which hit at least one of these:

- **Never hand-rename a migration, hand-edit `meta/_journal.json`, or hand-write
  a snapshot.** Delete your `.sql` AND your `meta/<idx>_snapshot.json`, restore
  `_journal.json` to main's version, then re-run `db:generate` so drizzle emits
  against the post-merge snapshot chain. A renamed file keeps a snapshot that
  diffs against the wrong parent, and the damage appears in whoever generates
  next, not in you.
- **Regeneration DROPS every hand-written statement** — trigger and function
  bodies, backfill `UPDATE`s, anything drizzle-kit cannot model. Re-apply them
  and verify by grepping the regenerated file for each trigger/function pair and
  for exactly one `-- oxy:deploy-phase=` line. Three of the four branches lost
  their triggers here; all three would have applied cleanly and enforced nothing.
- **A rebase can stage the deletion of an UPSTREAM snapshot** (`git status`
  showing `D meta/00NN_snapshot.json` for a file that is not yours), which
  breaks the NEXT `db:generate` rather than anything in your own PR. Before
  pushing, assert the journal's idx set equals the set of `meta/*_snapshot.json`
  files — a green suite does not catch this, because the migrator reads the
  `.sql` files and never looks at a snapshot.
- **A two-phase branch repeats the two-pass generation**: apply the additive
  schema state, generate (`pre`), apply the clean-cut state, generate (`post`).
  Never split one generated file in half by hand.
- **`SCHEMA_TABLE_COUNT` in `db/__tests__/schema-conventions.test.ts` conflicts
  on every such rebase and NEITHER side is right** — it is main's count plus
  your net delta. Count it empirically from the barrel's `PgTable` exports;
  arithmetic over the PR descriptions misses tables that MOVED between files.

## Auth: there is no Mercaria service principal (#164)

`middleware/auth.ts` is three exports — `oxyClient`, `authenticateToken`,
`optionalAuth` — all composed from `@oxyhq/core/server`, with nothing locally
implemented. #164 deleted the whole legacy surface as a clean cut:
`SERVICE_SECRET` and its `authenticateTokenOrApiKey` (a shared-secret bearer
compare that set `req.userId = 'system'` and an `appId: 'internal'` no Oxy
Console grant describes), `authenticateTelegramBot` (a second shared secret that
took the acting user's id from the `x-oxy-user-id` HEADER, so one env var
impersonated any account), the local `requireScope` over an `req.apiKey` bag
nothing populated, and the `apiKey`/`serviceApp`/`workspace` Express
augmentations.

- **All of it was UNMOUNTED, and that is the point rather than a reprieve.**
  Every `/internal/*` router runs `authenticateToken` plus one of the
  `*_OPERATOR_OXY_USER_IDS` allow-lists (measured 2026-08-16: EIGHT of them, not
  the six the #122-era prose above still says — count them, never quote a
  number), so no route reached any of it — which is exactly why no
  behavioural test could defend the removal and why it had to go: each was one
  `router.use(...)` from authorizing everything, outside grant audit, with
  rotation and revocation local to a deployment.
- **A real Oxy-to-Oxy caller (#156/#158) mounts `oxyClient.serviceAuth(...)` on
  the route that needs it**, against a credential issued to a registered
  Application, reading the principal off the SDK's own `OxyAuthRequest`. There
  is deliberately NO pre-exported unmounted service-auth middleware to reach
  for. Never build a second verifier.
- **A provider webhook is a different principal.** Stripe, Shopify, WooCommerce,
  CrowdSource and supplier callbacks verify their own signatures on their own
  raw-body mounts; none may be satisfied by an Oxy credential, or the reverse,
  because it arrives as a bearer-shaped string.
- **`ANALYTICS_INTERNAL_TRAFFIC_TOKEN` is NOT auth** and was deliberately kept:
  it classifies a request as internal so it leaves the quality metrics (#77) and
  authorizes nothing.
- **`middleware/__tests__/service-auth-retirement.test.ts`** fails the build on
  any of it returning — four scans over comment-stripped tracked source plus the
  env template and the deploy workflow, with a vacuity floor and a mutation
  self-test. `auth.ts` and the gate are excluded BY PATH, since both explain the
  prohibition in the vocabulary the detectors match.
- **The infra half is OWED and the ORDER is load-bearing.** `oxy-mercaria:3`
  still names `SERVICE_SECRET` (measured 2026-08-16) and
  `/oxy/mercaria/SERVICE_SECRET` still exists; the repo no longer reads or syncs
  it. oxy-infra must drop the entry from the task definition and roll out BEFORE
  the SSM parameter or the GitHub secret is deleted — a task definition naming a
  parameter that is gone fails at task START with `ResourceInitializationError`,
  on the next scale-up rather than immediately.

## CORS: critical origins

The Mercaria backend's `PRODUCTION_ORIGINS` lives in
`packages/backend/src/lib/allowed-origins.ts` (imported by `app.ts` for CORS
and by the guest CSRF gate — ONE origin authority, ADR 0003 D10) and must
include `https://mercaria.co`, `https://dashboard.mercaria.co` and
`https://pos.mercaria.co`.

The central Oxy API
(`OxyHQServices/packages/api/src/config/allowedOrigins.ts`) must include
`https://mercaria.co` and the pattern
`/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`. Without these,
`api.oxy.so/auth/refresh-all` fails with CORS errors from every Mercaria app.

## Guest sessions and the CommerceActor resolver (#103, ADR 0003)

ADR 0003 (`docs/adr/0003-commerce-actor-guest-identity.md`) binds the whole
guest-commerce epic (#101); #103 shipped its foundation. **No synthetic Oxy
users, ever** — a guest is Mercaria's own credential, structurally incapable of
appearing where an Oxy id is expected.

- **`CommerceActor`** (`services/commerce-actor.ts`) is the ONE actor union —
  `oxy | guest | anonymous`, deliberately with NO common `id` field so every
  consumer must switch on `kind` (I1). Resolved once per request by
  `middleware/commerce-actor.ts` (`resolveCommerceActor`), which COMPOSES the
  existing `createOptionalOxyAuth` — never a second Oxy verifier. Cart/checkout
  adopt it in #104 (M6/M7); until then only `/guest/session` consumes it.
- **Precedence (D2): Oxy wins; a failed Bearer is a 401, never a downgrade to
  the guest cookie; an invalid guest credential resolves as ABSENT** (marked
  `req.guestCredential='invalid'`). A valid guest credential beside Oxy auth is
  surfaced ONLY as `presentedGuestSessionId`, whose only legitimate consumers
  are cart merge (#104) and claim (#109).
- **Token:** `mgs_` + 32 CSPRNG bytes base64url; server stores hex SHA-256 only
  (`guest_sessions.token_hash`, unique). NO pepper — see `CONVENTIONS.md`
  §guest domain. Plaintext exists in exactly two response carriages:
  `Set-Cookie` (web) or the `X-Mercaria-Guest-Token` response header (native,
  declared with `X-Mercaria-Guest-Transport: header` on the issuing write) —
  NEVER a response body, log line, URL or analytics event.
- **Web cookie (D9):** `__Host-mercaria_guest` — HttpOnly, Secure,
  SameSite=Lax, Path=/, no Domain. Dev uses `mercaria_guest_dev` WITHOUT
  Secure under a different name, logged at first use — an explicit downgrade,
  never a silent one.
- **CSRF (D10):** strict Origin (else Referer) verification for every
  cookie-authenticated state-changing request AND cookie-transport issuance,
  against `lib/allowed-origins.ts` — the SAME list CORS reads; do not create a
  second origin authority or a double-submit token. Header transport is exempt
  (custom header ⇒ CORS preflight).
- **Issuance is LAZY and a WRITE** (`issueGuestActor`): the ensure endpoint
  today, cart writes in #104 — a page view never creates a row (T10).
  Rate-limited on the dedicated `rl:guest-issue:` bucket. Rejection of
  expired/revoked/malformed/unknown is UNIFORM (`null`/401); reasons exist only
  in the `log.guest` security events, which carry row ids and never tokens.
- **Expiry (D3/D11):** `expires_at` (90 d absolute) is the only stored
  deadline; idle expiry (30 d from `last_seen_at`, written at ≥60 s
  granularity) lives in the resolver. Rotation swaps `token_hash` in place with
  a 60 s `previous_token_hash` grace; the 7-day activity rotation answers in
  kind from the resolver. Purge = two expiry-sweep targets (7 d past
  expiry/revocation), hard DELETE.
- **Flags (M8):** `GUEST_COMMERCE_ENABLED` (default false) gates the MOUNT and
  requires BOTH `GUEST_PII_ENCRYPTION_KEY` and `GUEST_EMAIL_HASH_KEY` (the
  half-configuration rule; keys are consumed by #105+/#108 but demanded now).
  `GUEST_SESSION_ISSUANCE_ENABLED` (default true) is the incident kill switch:
  stops NEW sessions only — existing ones keep resolving/rotating/revoking.
  `GUEST_SESSION_IDLE_DAYS=30`, `GUEST_SESSION_ABSOLUTE_DAYS=90`. Production
  stays OFF until the M8 security + privacy review clears.
- **Conversion is a SEAM here:** `converted_at`/`converted_to_oxy_user_id` are
  written only by #104/#109; there is deliberately no generic "reassign
  session" endpoint, and `/guest/session` is the WHOLE public surface
  (ensure/inspect/rotate/revoke).

## Merchant claiming (#83): proving you operate a merchant

`services/merchant-claims/` + `db/merchant-claims/` + `db/schema/merchantClaims.ts`
(5 tables), plus `/merchant-claims/*` (claimant) and
`/internal/commerce-graph/claims/*` (operator review, the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` gate #54 uses). Schema decisions:
`db/schema/CONVENTIONS.md` §"Merchant claiming". The rules that are
load-bearing:

- **`merchants.claim_state` stays ADR 0002 D9's ONE stored verdict** and this
  domain is its only writer. No second boolean, and `assurance` is DERIVED from
  the method (`claim-methods.ts`), never a column.
- **The verification contract is a TABLE, not a switch.** `claim-methods.ts`
  holds every per-method property; the state machine reads it and never asks
  "is the method dns_txt". `autoVerifies: false` on a `low` method is what
  makes "a matching email domain alone cannot complete a claim" structural —
  such a claim reaches `review_pending` and nothing else.
- **`role_email` is in the closed set and NOT AVAILABLE.** Mercaria has no
  outbound email transport, so the token cannot reach the role address. The
  value stays in the tuple (state machine, review path, CHECK all exist for it)
  and the registry refuses to offer it — the issue's "safe subset at launch",
  made explicit rather than dropped. Adding a transport is the only change
  needed to turn it on.
- **`platform_oauth` consumes the connector's EXISTING OAuth round trip** —
  a `connections` row that flow already authorized — rather than registering a
  second redirect URI and a second callback with every platform. Two places
  establishing one shop's identity could disagree. `channel_key` is the same
  proof one rail over, and BOTH additionally require `store:manage` on the
  store that owns the connection (the payment-onboarding permission, same
  reasoning): a leaked key alone must not move a merchant's identity.
- **Scope is a set of proven facts, in a pure function** (`claim-scope.ts`).
  Domain containment is LABEL-wise (`endsWith('.' + proven)`), so `notapple.com`
  is not covered by `apple.com`; a platform proof matches `(provider,
  externalShopId)` or the shop's own host and reaches nothing else; a storefront
  belonging to another merchant is always out of scope. Requested and verified
  scope are two STATES of one row, so a channel a proof missed is visible.
- **Two partial unique indexes carry the security properties.**
  `(merchant_id) WHERE state='verified'` is acceptance 4 — a second claimant is
  refused by the database and lands in DISPUTE rather than replacing the
  incumbent, who keeps management access until an operator revokes it as a
  separate audited act. `(claim_id) WHERE closed_at IS NULL` is what
  "single-use" means; consuming is a CAS whose predicate carries the expiry.
- **The token is minted once, returned once, and stored as a SHA-256** — the
  `guest_sessions` decision, no pepper. Verification presents it back and the
  accept decision is `verifySecret`; for the site methods that adds no secrecy
  (a published token is public) and exists so the server never stores a live
  credential.
- **Four rate-limit axes, three of them durable.** `rl:merchant-claims:` is the
  network axis; per user, per merchant and per domain are counted in Postgres,
  because "how often may this DOMAIN be challenged, across every claimant and
  every ECS task" is not a question a per-IP bucket can answer. One message for
  all three, so a refusal never reports somebody else's activity.
- **SSRF is `safeFetch` and nothing hand-rolled**, HTTPS-only, with a bounded
  read the caller owns. DNS TXT is resolved with its own `Resolver` timeout and
  is outside the SSRF surface entirely.
- **Revocation removes management access and preserves public history**: the
  merchant returns to `unclaimed` with no claimant (native-checkout eligibility
  is derived from that verdict, so it turns false with it) and NOTHING else
  moves — no storefront, no verified domain, no rollup. The former operator is
  notified, as is the incumbent of a contest (`merchant_claim_revoked` /
  `merchant_claim_contested`), and neither message names the other party.
- **Claiming grants no relationship and nothing operational.**
  `relationship-isolation.test.ts` fails the build if any module in the domain
  references the brand/relationship layer (#55) or native-store linkage (#84).
- Deferred and NOT implemented here: the native-store flow (#84) — the claim
  records an `native_store_id` INTENT and writes no link; relationship
  verification (#55); the dashboard/storefront UI (#84/#85). `role_email`
  delivery, per the transport rule above.

## Category attributes, units and hard constraints (#94)

`services/attributes/` + `db/attributes/` + `db/schema/attributeRegistry.ts`
(6 new tables; `attribute_definitions` and its category scope MOVED here from
`canonicalCatalog.ts` and reshaped) + `@mercaria/shared-types`
`attribute-registry.ts` and `constraint.ts`. Full reference:
**`docs/attributes.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"The versioned attribute registry". This EXTENDS #56's registry — there is one
registry, not two.

- **A definition is a VERSION and its meaning is frozen once published** (DB
  trigger + one-active-per-key partial unique, the `fee_schedules` mechanism).
  Every stored value cites the version and the normalization ruleset it was read
  under, so changing an attribute's meaning schedules a re-normalization instead
  of silently reinterpreting facts. Labels are deliberately NOT frozen: stored
  KEYS are what stays stable.
- **`RESERVED_OFFER_FACT_KEYS` is a CHECK.** `price`, `availability`,
  `condition`, `shipping_cost` and sixteen more cannot be defined as product
  attributes at all — they belong to current eligible OFFERS and are answered
  through `services/attributes/offer-facts.port.ts`, the narrow seam #57 fills.
  Until a port is registered the default answers NO data, so a hard commerce
  constraint EXCLUDES rather than being satisfied from a stale feed. `msrp` is
  deliberately not reserved.
- **Hard vs preference is structural, four ways** (#94 rule 4): `strength` is a
  readonly literal set at construction; validation partitions into two genuinely
  different TYPES; `TextPreference` has no wire or type representation of
  `'hard'`; and the verdict is derived from the hard outcomes inside the
  evaluator. `hard-constraint-isolation.test.ts` fails the build otherwise, with
  a mutation self-test on every pattern.
- **Missing data is `unknown`, never a quiet yes.** A preference is never
  reported satisfied on absence; a hard constraint resolves it by a NAMED policy
  (`exclude_when_unknown` | `admit_and_report_unknown`) and the reason says
  which. An OR group with one unknown member and no success is `unknown`, not
  `failed`.
- **A refusal is a first-class normalization outcome** — `unparsed`,
  `unknown_unit`, `out_of_range`, `implausible`, `marketing_claim` — and only
  `normalized` may carry a value. A unit comes from the source's own token or a
  RECORDED per-source mapping, never from the attribute's base unit or the
  magnitude's size.
- **`conflicting` is a SELECTION state, not a parse state.** Two disagreeing
  sources keep both parses and select neither; an operator must be able to see
  what they are choosing between. Corroboration (two independent sources
  agreeing) is a different field from confidence (one source's estimate of
  itself).
- **Percentages, ratios and ratings are distinct UNIT FAMILIES**, so no
  constraint can compare a screen-to-body percentage against a review score.
  Structured values name their AXES explicitly and refuse a component count that
  does not match the declaration.
- Public surface `/catalog-attributes/*` (definitions, facets, constraint
  validate/evaluate, selected values). Operator surface
  `/internal/catalog-attributes/*` behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
  allow-list #54/#55/#56/#83 use. Provenance never reaches a public DTO.
- **Two migrations, and the split is the deploy-phase rule working**: `0024`
  (`pre`, additive plus widenings) and `0025` (`post`, the value-type clean cut
  `quantity`→`measurement` / `number`→`integer`|`decimal` / `text`→`string`, and
  three column drops). Each `post` statement breaks a write the previous image
  performs.
- Deferred with seams, not built: the offer model (#57), NL intent parsing
  (#95), grounded comparison (#96), ranking (#74), the correction UI (#59), and
  the consumer that drains `attribute_reindex_requests` (#61).

## Guest cart ownership and the merge (#104, ADR 0003 D8)

The cart is owned by a `CartOwner` — `{kind:'oxy_user'} | {kind:'guest_session'}`
— and `/cart` runs on `resolveCommerceActor` instead of `authenticateToken`.
ONE cart service, one hydration path, one grouping path for both kinds (I9):
there is nothing guest-shaped to fork, and no `GuestCart` model.

- **Two owner columns plus a CHECK, never a polymorphic pair.** An Oxy id must
  not carry an FK (Oxy owns identity) while `carts.guest_session_id` MUST —
  `ON DELETE CASCADE` is what makes retention correct by construction. Both
  uniques are PARTIAL, so every `ON CONFLICT` on them must repeat the
  predicate or Postgres refuses to infer the arbiter and `ensureCart` 500s.
- **`cartOwnerForActor` is the ONE actor→owner translation.** Neither union has
  a common `id` field, so the compiler forces a `switch` and a guest id can
  never reach `oxy_user_id` (I1).
- **Issuance is lazy and only on a write that CREATES state** — `POST /cart/items`
  and `PATCH /cart/items/:variantId`. A GET never mints (T10), and neither does
  a DELETE: removing a line from a cart that does not exist creates nothing.
- **Idempotency is explicit.** POST increments and is the one non-idempotent
  mutation; PATCH sets an ABSOLUTE quantity and CREATES the line, so it is what
  a retrying native client uses; DELETE converges on an empty cart rather than
  404ing the second time.
- **`makeActorRateLimiter`** keys on `actorRateKey` (`rl:cart:`, `rl:cart-merge:`),
  so guests are bucketed per SESSION — a per-IP bucket would make one NAT one
  guest. Its anonymous branch runs the address through `ipKeyGenerator` (a v6
  client otherwise walks its own /64 around the limit).
- **A guest's presentment currency rides the request** (`?currency=`, validated
  against `ALL_CURRENCY_CODES`) because they have no preferences row; an Oxy
  buyer's STORED preference stays authoritative and the parameter is ignored for
  them. Display only either way.
- **The merge is ONE transaction**, entered only from `POST /cart/merge`, which
  is the only consumer of `presentedGuestSessionId` besides #109. Nothing merges
  implicitly. Exactly-once rests on three mechanisms — `FOR UPDATE` on the
  session row, `FOR UPDATE` on the guest cart, and
  `UNIQUE(cart_merges.guest_session_id)`. Mutation-tested: the two locks are
  INDEPENDENTLY sufficient (removing either alone leaves the suite green);
  removing both doubles a quantity and fails the race test.
- **Quantities are summed and clamped IN SQL** (`LEAST(existing + incoming,
  ceiling)`), so a concurrent add from another authenticated device is summed
  with rather than overwritten, and the review flag is written by the SAME
  expression that applies the clamp — the caller counts clamps off the returned
  flag rather than re-deriving them.
- **No item disappears.** An out-of-stock line survives as ONE unit flagged
  `listing_unavailable` (a zero quantity is unrepresentable), which hydration
  marks `stale` and checkout refuses — so keeping it oversells nothing.
  `cart_items.merge_review_reason` is a STORED fact, unlike `stale`, which is
  re-derived live; the buyer clears it by setting that line's quantity.
- **Conversion is stamped LAST** and rolls back with everything else, which is
  how "converted only after the merge commits" and "a failed merge leaves both
  carts recoverable and the session active" are the same property.
- **What the merge cannot reach** is a test, not a promise —
  `services/__tests__/cart-merge-isolation.test.ts` scans the whole cart path
  for the payment domain, the referral domain, inventory writers, discount
  redemption and any OxyPay/FairCoin reference. Guest CHECKOUT (#105–#107),
  referral attribution (#141/#143) and a "discard instead of merge" mode (which
  ADR 0003 does not grant — not calling the endpoint IS the choice) are all
  deliberately absent.
- **Flags are three independent levers**, and #105–#107 adds a fourth:
  `GUEST_COMMERCE_ENABLED` (the domain), `GUEST_SESSION_ISSUANCE_ENABLED` (the
  incident kill switch for NEW credentials), `GUEST_CART_ENABLED` (may a
  credential own commerce state). With the cart lever off, reads answer empty
  and writes get `GUEST_CART_DISABLED` (403) — but the MERGE stays available,
  because gating it would strand every cart created while it was on.
- **`GUEST_OPERATOR_OXY_USER_IDS`** gates `/internal/guest-commerce/*`
  (cart-merge trace by correlation id + a consistency check), a THIRD
  allow-list beside payments and catalog for the reason those two are separate.
  Empty = not mounted (404). Read-only: every repair is already an idempotent
  path a buyer drives.
- **Frontend:** `lib/stores/guest-credential-store.ts` holds the NATIVE token
  (`expo-secure-store`, hydrated at module import so it is on the first
  request); web holds nothing because the credential is an `HttpOnly` cookie
  and `apiClient` sets `withCredentials`. `useGuestCartMerge` is a React Query
  QUERY, not an effect — `enabled` flipping true is the once-per-sign-in
  trigger. There is no analytics module in this app and #104 adds none;
  ADR 0003 I12's dimensions belong to #111's rollout work.

## Inline checkout contact and destination (#105, ADR 0003 D4/D6, ADR 0006 G6/G12)

`POST /checkout` takes a discriminated `CheckoutDestination` plus an explicit
`CheckoutContactInput`, for BOTH actor kinds, and runs on
`resolveCommerceActor` instead of `authenticateToken`. Code:
`services/checkout/` (4 modules), `db/guests/guestCheckoutRepository.ts`,
`lib/guest-pii.ts`, `db/schema/guests.ts` (`guest_checkouts`) and the buyer
widening on `db/schema/orders.ts`. Schema decisions:
`db/schema/CONVENTIONS.md` §"`guest_checkouts` and the buyer origin".

- **The contract is `{destination, contact, marketingOptIn}`**, and `addressId`
  is still accepted as the v1 spelling of `{type:'saved_address', addressId}`.
  That is a VERSIONED CONTRACT, not a compat shim — a shipped mobile build
  cannot be recalled. Sending BOTH is a 400 rather than a precedence rule
  nobody would remember. It retires when supported client versions have
  migrated.
- **"A guest cannot use a saved address" is STRUCTURAL, not a check.**
  `addressBookOwnerForActor` (`services/checkout/destination.ts`) is the only
  source of an `oxyUserId` for `findAddress`, and it is a `switch` over a union
  with no common `id` field — the `cartOwnerForActor` mechanism, one domain
  over. The refusal arrives BEFORE any lookup, so an invented id leaks nothing.
- **An inline authenticated address is saved only on an explicit, separate
  opt-in**, and the write happens AFTER the order and best-effort: a failed
  address-book write must never fail a purchase that already took stock, and a
  failed checkout must never grow the address book.
- **Contact is required for a guest and optional for an Oxy buyer**, and is
  NEVER read off an Oxy profile. A guest's email is encrypted onto
  `guest_checkouts`; an Oxy buyer's is validated and stored NOWHERE — their
  transactional channel is Oxy's own notifications, and copying an Oxy account's
  email into Mercaria would create the profile mirror ADR 0003 D15 says does not
  exist. Accepting it for both is what makes ONE shared inline form possible.
- **Pickup is representable and fails CLOSED.** `assertPickupLocationEligible`
  refuses every pickup, naming the sellers, because #93 supplies no publication,
  freshness or collectable-inventory state to validate against. #93 fills in the
  body of that ONE function; the contract, the snapshot and the refusal shape
  are already around it. Nothing fabricates a street for a collection — the
  pickup branch produces no address at all.
- **Unknown shipping is never free.** `resolveShippingCostMinor` refuses a
  method this deployment cannot price instead of letting `undefined` become 0.
- **Eligibility refusals name the SELLER**, because a mixed cart's remedy is to
  deselect one, and they mention nothing about the cart's contents — a rejection
  leaks no inventory. Guest P2P stays refused (ADR 0003 D18 / ADR 0006 G18)
  until #112; there is deliberately no flag for it.
- **Validation lives in ONE place** (`services/checkout/contact.ts`), is pure,
  and makes zero outbound calls — no geocoding, no address-correction provider
  (a static test asserts it). ISO-3166 alpha-2 is a real membership test, not a
  length check. Postal patterns exist only for countries whose rule is
  unambiguous; the long tail is length-checked, because an overfitted regex
  refuses a real buyer with no remedy. Email normalization is ADR 0003 D12
  verbatim — trim, NFC, lowercase the WHOLE address, no plus-tag stripping and
  no dot folding — and the DISPLAY form (what mail is sent to) is a different
  value from the LOOKUP form (what is hashed). Phone canonicalization never
  invents a country code.
- **`guest_checkouts` is ONE contact per checkout GROUP**, created inside the
  orders' transaction, immutable by trigger except D15's anonymization and
  #108's verification stage. `ensureGuestCheckout` is `ON CONFLICT DO NOTHING`
  plus a read: a retry carrying a different email must not replace the contact a
  placed order was made with. Repeated attempts converge through the existing
  layers; nothing new was added.
- **The transaction boundary is the ONLY place the two actor paths differ in
  shape**, and it is a row rather than a policy: a guest checkout writes a
  contact the orders reference by FK and it must commit with them, or an
  idempotency converge would strand one. `placeOrders` is the same body either
  way (ADR 0003 I9).
- **Flags are FOUR independent levers**, and the interaction matters:
  `GUEST_COMMERCE_ENABLED` off = no credential resolves at all (decommission);
  `GUEST_CART_ENABLED` off = a session resolves but owns no cart, so there is
  nothing to check out; `GUEST_INLINE_DESTINATION_ENABLED` off (the #105 lever,
  default true) = the cart survives and checkout is refused with
  "temporarily unavailable"; placed guest orders and their payments are never
  gated (ADR 0006 G17). `CHECKOUT_DESTINATION_COUNTRIES` is empty by default,
  which means unrestricted — today's behaviour exactly.
- **Privacy:** three encrypted/hashed columns are in `PROTECTED_COLUMNS` (the
  hash too — it is an exact-match ORACLE, not merely irreversible); no refusal
  or log line ever carries an address, an email or a hash, only field names,
  seller keys and row ids; the seller-visible set is stated on the checkout page
  itself. Marketing consent is its own column defaulting to false, so a
  transactional send can never be mistaken for consent to market.
- **Isolation is a test:** `services/__tests__/checkout-contact-isolation.test.ts`
  fails the build on any OxyPay/FairCoin spelling (COPY included, so it scans
  raw source), any referral reference, any geocoding client, any address-book
  write from a guest module, and any contact-based buyer lookup. The
  reachability detectors scan COMMENT-STRIPPED source, because the modules
  document what they refuse to do in the same vocabulary.
- Deferred and NOT built here: #106 (landed — see below), #107 (the guest
  Stripe client surfaces and the portal), #108 (verification, magic links,
  transactional mail), #109 (claiming), #93 (pickup), #112 (guest P2P).

## Guest buyers and immutable contact snapshots on orders (#106, ADR 0003 D6/D7/D13/D14/D16)

`orders.claimed_by_oxy_user_id`/`claimed_at`, `order_status_history.actor_kind`/
`actor_guest_session_id`, `guest_checkouts.contact_verified_at`/
`contact_policy_version`, `services/orders/` (3 modules),
`@mercaria/shared-types` `order-buyer.ts`. Full reference:
**`docs/orders-buyers.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"`guest_checkouts` and the buyer origin". #105 made a guest order STORABLE;
#106 makes it readable, ownable and auditable.

- **`OrderBuyer` is the one union and has NO common id field** — `CommerceActor`'s
  rule one layer down. `services/orders/order-buyer.ts` is its ONLY derivation
  from a row; a shared `buyer.oxyUserId` would let a guest's later CLAIMANT be
  read as the account that placed the purchase, which is a silent attribution
  error rather than a crash.
- **A claim is a SECOND owner and `origin` stays `guest` forever** (I7). #106
  WIDENED `orders_buyer_identity_check` and `CREATE OR REPLACE`d the origin
  trigger rather than adding second ones. The trigger permits NULL→value (a
  claim, #109) and value→NULL (an audited unclaim) and **REFUSES value→value** —
  which is what makes D14's 409 real: a service bug cannot answer a contested
  claim any other way.
- **Buyer access is stated TWICE and a realdb test drives both.** The list path
  needs an indexable predicate (`buyerOrClaimantSql`) and the detail path needs
  a pure decision (`authorizeOrderAccess`); two spellings of one rule can
  disagree, so `order-buyer-claim.realdb.test.ts` runs one order matrix through
  both. Mutation-tested — narrowing the SQL to the origin column fails exactly
  that case. `OrderListFilter` keeps `buyerOxyUserId` BESIDE
  `buyerOrClaimantOxyUserId`: "which orders did this account PLACE" and "which
  may it SEE" are different questions and collapsing them widens the first.
- **A cart token can never become order access, structurally** (I3):
  `orderAccessSubjectForCommerceActor` maps a `guest` actor to `null`. The
  service also takes no email, phone or order number — reject rules 1, 2 and 5
  are held by the SIGNATURE, not by a branch. It deliberately does NOT check
  store permissions; `requireStorePermission` still owns that.
- **The seller projection is a different TYPE, not a filtered one.**
  `MerchantOrder` `Omit`s the three buyer fields, so a merchant serializer that
  reaches for a contact fails `tsc`. The label is the Oxy handle or the literal
  `Guest` — never `Guest #4821` or a masked email, because any per-guest label
  is a correlation key wearing a display name (I11), and never a buyer-origin
  discriminant (DTO rule 5).
- **`order_status_history.actor_guest_session_id` is in `PROTECTED_COLUMNS`**
  and the repository selects `PUBLIC_STATUS_EVENT_COLUMNS` — the trail is
  attached to EVERY order and serialized whole, so a plain `select()` would put
  a guest's cross-order correlation key in a merchant response. `actor_kind` is
  NOT protected: it says a guest acted without saying which.
  `NewOrderStatusEvent.actorKind` is REQUIRED, so every writer states one.
- **ONE contact snapshot, separately erasable, never copied onto the order.**
  Contact rule 5 (never re-read a live source) and rule 10 (retention separable
  from order financial data) pull opposite ways, and rule 10 wins: D15 erases the
  contact while the orders are retained, and a copy on the immutable order is
  exactly what erasure could not reach. `loadBuyerContacts` reads the FK'd
  snapshot in one batched statement and makes NO profile call — rule 5
  mechanically. An Oxy buyer's contact is stored NOWHERE and the projection says
  `source: 'oxy_account'`.
- **`Order.buyerOxyUserId` is the v1 spelling, and a claimed guest order carries
  NONE** — filling it with the claimant would tell an old client that an Oxy
  account made a purchase it did not make. Retires when supported clients read
  `buyer`; the COLUMN is never dropped.
- **The migration (`0030`, `pre`) has load-bearing ORDER**: the two backfills
  (`actor_kind` from `by_oxy_user_id`, connector orders to `'external'` keyed on
  `source_connection_id` and NOT on the `ext:` prefix) must run BEFORE the
  CHECKs, or the actor CHECK fails on every historical row with a real actor.
  The identity CHECK is added VALIDATED, not `NOT VALID` — the widening only
  constrains columns the serving image leaves NULL.
- **Four consistency probes no CHECK can express** (`readBuyerIdentityConsistency`,
  on `/internal/guest-commerce/consistency`): a misclassified connector origin, a
  mixed-origin group, a PARTIALLY claimed group, an orphaned guest contact. Read
  only — each is a decision about a commercial record.
- **#77's `#106` analytics seam is CLOSED.** The six event types emit now, and
  what supplied them was not an event but a vocabulary: `CheckoutRefusalReason`
  (`services/checkout/refusal.ts`, five members) thrown as a typed
  `CheckoutRefusal`, mapped to `ANALYTICS_REASON_CODES` by one exhaustive
  `Record` in `checkout.controller.ts` that fails `tsc` on an unclassified
  addition. A refusal that is NOT one of the five is counted in NEITHER half —
  there is no `other` bucket.
- Seams left, none of them a stub that lies: #108 (`GuestOrderPortalGrant`'s
  contract and `GuestOrderPortalView` exist; `resolveGuestPortalSubject` returns
  `null`, so the whole portal path fails closed), #109 (the columns, the CHECK
  and the trigger exist; `grantEligibilitiesForClaimedGuestOrder` still refuses
  and names the one line #109 replaces), #110, #93, #112.
## Review scopes (#76): a rating answers ONE question

`services/reviews/` + `db/reviews/` + `db/schema/reviews.ts` (5 tables). Full
reference: **`docs/reviews.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Review scopes (#76)".

- **`ReviewScope` is the QUESTION, `ReviewTargetType` is the COLUMN**, and they
  are not two representations of one fact: `target_type='listing'` cannot say
  whether a review is about the product or the condition of one used copy. A
  CHECK pair ties them, rendered from the one `REVIEW_SCOPE_TARGET_TYPE` map. A
  NULL scope means the classification job has not decided (or refused).
- **`reviews` moved from `schema/buyers.ts` to `schema/reviews.ts`; its ID did
  NOT move.** CrowdSource holds review ids and `moderation_enforcements` is
  keyed on them, so a new table would have orphaned every open case.
- **A BRAND rating is unrepresentable in four places** — the disjoint
  `REVIEW_FORBIDDEN_SCOPES`/`REVIEW_SCOPES` unions, no brand-shaped column in any
  of the five tables, a refusal that names `brand` instead of saying
  "unrecognized value", and a scanned gate proving no module in the domain can
  reach the brand layer. The retail-pricing markup device, reused.
- **Eligibility's evidence is an ORDER LINE and nothing else.** No email, phone,
  payment-method, card-fingerprint, session or referral column exists, and
  `REVIEW_FORBIDDEN_EVIDENCE_SOURCES` names fourteen signals that may never
  create one — disjoint from the two evidence types, each refused BY NAME.
  `UNIQUE(order_item_id, oxy_user_id, scope)` makes a claim retry, a replay and
  two concurrent grants converge on one row.
- **The #109 guest path FAILS CLOSED.** `grantEligibilitiesForClaimedGuestOrder`
  publishes the exact contract #109 will call and then refuses unconditionally,
  because `orders` has no `buyer_origin` (#106) or `claimed_by_oxy_user_id`
  (#109) to verify against — and a CHECK makes a claimed-guest row without a
  claim id unrepresentable, so nothing can invent one.
- **`review_aggregates` is the authority; the entity `rating` columns are
  PROJECTIONS** written by one function from one derivation. Everything derives
  and nothing increments, which is what makes the rebuild idempotent — and what
  lets moderation call it after hiding a review. Verified and unverified never
  blend: two column pairs, no combined total anywhere to reach for.
- **A native store's public rating comes from ONE function.**
  `resolveStoreRatingSource` returns the merchant aggregate OR the legacy store
  aggregate, never both, so a review cannot reach two public aggregates.
- **The classification job never guesses.** A legacy listing review becomes
  `p2p_listing` and NEVER `product` (reading it as one would put "arrived
  scratched" on the model's quality rating); a store review with no merchant
  link stays where it is with the missing fact recorded. `unclassified` and
  `ambiguous` are different states on purpose. Every decision appends to
  `review_target_migrations`, append-only by trigger.
- **Moderation is unchanged** — the plan table, its mapping and its tests are
  untouched. What #76 adds is a re-derive of the scoped aggregate on each side
  of the status CAS, best-effort because the enforcement has already committed.
- **Self-review detection is two independent layers** (the order's seller, and
  ownership of the target), and the refusal is UNIFORM: naming the relation
  would disclose somebody's store membership. What it cannot see — a second
  personal account, a friend, an agency — is documented rather than guessed at,
  because detecting it would mean reading the data this domain excludes.
- Deferred: #106/#109 (the seam above), #57/#71's `native_listing_links` (a
  listing resolves to a canonical product only through the identifier collision
  gate until then), merchant responses, and an HTTP operator surface.
## Discovery analytics (#77): measurement that cannot build a person

`services/analytics/` + `db/analytics/` + `db/schema/analytics.ts` (8 tables),
`/analytics/events` (client ingest) and `/internal/analytics/*` (operator).
Full reference: **`docs/analytics.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The discovery-analytics domain". Production
collection is **OFF** (`ANALYTICS_COLLECTION_MODE=off`) until the privacy and
retention review in `docs/analytics.md` is recorded.

- **The whole domain is an ALLOW-LIST of typed COLUMNS. There is no `jsonb`
  property bag and none may be added.** `services/payments/redact.ts` is the
  precedent and the reasoning is stronger: a provider payload arrives shaped by
  somebody else, while an analytics property is composed by our own code — so an
  open bag is not a defence, it is the one mechanism by which an address, an
  order note or a page payload reaches production. The ABSENT columns are the
  enforcement: no email, hash, phone, card fingerprint, provider customer,
  wallet, IP, user agent, device fingerprint or token, gated by a scan with a
  vacuity floor and a mutation self-test.
- **Two identity columns, mutually exclusive by CHECK, and neither is a person.**
  `oxy_user_id` only for an `oxy` actor whose consent is not `denied`;
  `pseudonymous_session_id` is a truncated sha-256 under a salt that ROTATES
  every 24 h and is then DELETED at 45 days — deliberately SHORTER than the
  events derived under it, which is what makes two epochs unlinkable rather than
  merely inconvenient to link. The cost is stated: guest experiment and
  return-rate continuity ends at each rotation.
- **`analytics_events` is APPEND-ONLY by trigger and DELETE is deliberately
  PERMITTED.** Append-only is identity rule 5 (a #109 claim cannot retroactively
  absorb unrelated guest activity) surviving whoever adds an `update`; the delete
  exception is because erasure on schedule is the policy and a trigger refusing
  it would make retention fail silently. This inverts the ledger's posture on
  purpose.
- **Financial truth is never a client event.** No event type asserts a payment,
  `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES` contains no session, merge, claim,
  eligibility or checkout event, and every money metric names `payments` /
  `orders` / `refunds` / `affiliate_reports` as its source through the ONE seam,
  `services/analytics/verified-conversion.ts` (the `order-linkage.ts` shape). A
  REFUNDED payment still counts as a conversion, and **a successful guest
  purchase with no claim is a COMPLETE conversion, never abandonment**.
- **Analytics can never block commerce, and the SIGNATURE is the guarantee**:
  `recordAnalyticsEvent`/`emitAnalyticsEvent` return `void`, so there is nothing
  to await — a caller who tried gets a `tsc` error. The queue is bounded and
  drops the OLDEST; a failed flush logs, counts and does NOT re-queue. Loss is
  acceptable only because no metric that counts money reads these rows; a future
  metric needing at-least-once delivery gets a durable outbox row in the commerce
  transaction, never a "reliable" version of this queue.
- **Raw query text is never retained.** Only the redacted form, only 30 days,
  then nulled in place while the normalized tokens survive — a REDACTION the
  shared expiry sweep cannot perform, so it lives in `retention.ts`. Tokens are
  derived from the redacted text, never the original. Rule ORDER is load-bearing
  (cards and IBANs before the digit run; credentialled URLs before emails), and
  the phone rule's separators are MANDATORY or `iphone 15 128 256` reads as a
  phone number and the best queries in the dataset are destroyed.
- **`readTopQueries` is the ONLY query reader and its floor has no bypass** — 25
  occurrences, applied on the row AND after the range SUM, for operators and
  merchants alike, because a rare query is a near-identifier whoever is reading
  it. `analytics_search_queries` has NO actor column at all.
- **Metrics are DATA, not prose.** Twenty-two definitions naming numerator,
  denominator, window, source, freshness and ATTRIBUTION LIMIT;
  `analytics_rollups.metric_key` CHECKs against the same tuple, so a number
  whose definition is unstated cannot be stored, and the read surface 404s a key
  with no definition, so it cannot be served either.
- **Coercive experiments are UNREPRESENTABLE.** No treatment kind could mean
  "hide Continue as guest", "auto-create an account", "preselect marketing
  consent" or "sell organic rank", and a negative list is scanned against the
  positive one so a plausible future addition fails the build. An active
  version's salt and allocation are frozen by trigger — editing the salt
  re-buckets every unit mid-flight and nothing in the data says so.
- **Ranking isolation is a test, both ways** — a discovery module may import the
  emitter seam and nothing else in the domain, and no measurement module may
  reference the fee or referral domain. `fee-ranking-isolation.test.ts` is the
  precedent; this one adds the second direction because measured popularity is
  one join from a plan-weighted ordering.
- **`ANALYTICS_OPERATOR_OXY_USER_IDS` is a FOURTH allow-list** beside payments,
  catalog and guest. Empty = not mounted (404). The operator trace opens from a
  query event id or a checkout group and returns NEITHER identity column: "show
  me everything this session did" is not a question the surface can be asked.
- Merchant analytics: `/admin/stores/:storeId/analytics/summary` behind
  `stats:read`, aggregate-only, suppressed below 10 (not rounded — "under 10"
  plus a timestamp is a person on a small store), with the metric definitions
  shipped beside the figures. No buyer-origin breakdown at all.
- Seams, defined and emitted by NOTHING (a gate fails the build on an emission):
  #106 eligibility + contact/destination validation, #107 payment detail, #108
  portal/recovery, #109 claim, #110 cancellations and support, #111 rollout
  gates, #74 ranking policy versions, #37 affiliate reports.
  `services/analytics/seams.ts` carries each contract. **#106's is the one to
  read**: those gates already RUN (#105's P2P and destination refusals), and
  they are deferred only because each raises a generic `conflict()` with a
  sentence — classifying one would mean matching message text, and emitting
  only the ACCEPTED half would make `guest_eligibility_coverage` read a
  confident permanent 100%. The refusals owe an error CODE, not a new event.
  Contrast `guest_feature_gate_blocked`, which IS emitted today at
  `GUEST_CART_DISABLED`/`GUEST_ISSUANCE_DISABLED` precisely because both are
  bounded `ErrorCode`s.

## Public P2P seller profiles (#92): a seller is an Oxy account

`services/sellers/` (4 modules) + `routes/public-sellers.ts` +
`@mercaria/shared-types` `seller-profile.ts`, plus the storefront's
`app/(app)/sellers/[oxyUserId].tsx` and `components/seller/`. Full reference:
**`docs/seller-profiles.md`**. NO new tables and NO migration — the whole
domain is a projection over `listings`, `seller_profiles`, `review_aggregates`
and Oxy.

- **A person is followed as `oxy.user`, never a `mercaria.*` kind**, at
  `https://oxy.so/users/<oxyUserId>` and never a `mercaria.co` URI. A
  `follow_targets` row carries ONE kind and `ensureFollowTarget` is idempotent
  on the URI, so whoever registers a URI FIRST fixes that human being's kind
  permanently and splits their followers from every other Oxy app, with no
  repair short of a data migration. Mercaria neither claims the `oxy` namespace
  nor `registerFollowKind`s it (the registry refuses); `mercaria.store` stays
  Mercaria's because a store has no Oxy account behind it.
  `seller-identity-isolation.test.ts` scans BOTH packages — the one file that
  could make this mistake is a storefront file, and the storefront has no test
  runner — and is mutation-tested.
- **`ensureFollowTarget` passes `uri` AND `localUserId`, and no `metadata`.**
  The server derives the id from the URI and refuses a mismatch, so passing both
  is a consistency assertion; metadata is refreshed only for the app that
  PROVIDES a target, and Oxy provides this one — pushing Mercaria's idea of a
  person's name would overwrite their identity for every Oxy surface.
- **Mercaria stores NO follow state**: no table, no endpoint, no DTO field, no
  follower list. `FollowTargetButton` reading Oxy's graph is why the profile and
  the product-page seller card always agree.
- **Visibility is DERIVED per request, never stored** (the #57
  `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict rule)
  — `visible | private | restricted`, with deleted/unresolvable/blocked all
  answered by ONE indistinguishable 404, because a distinguishable response is
  an oracle. Privacy is checked BEFORE trust: reporting `trust_restricted` for a
  private account leaks Oxy Trust's opinion of somebody who asked to be hidden.
- **An absent Oxy Trust signal withholds nothing.** `null` covers both "never
  scored" and "read failed"; restricting on absence turns an outage into a
  marketplace-wide delisting. The policy itself is ONE named constant
  (`SELLER_TRUST_RESTRICTED_TIERS = ['restricted']`) — #92's "explicit policy,
  not a client guess". Mercaria computes no trust score and manufactures none
  from listing/follow/sales counts.
- **Viewer-scoped questions use the VIEWER's own bearer**, via a short-lived
  `OxyServices` per signed-in request — never `oxyClient.setTokens(...)` on the
  module-level singleton, which would leak one caller's session into another's
  concurrent read. Block check is `getViewerGraph()` (ids only, keep the
  boolean); it fails OPEN, the profile read fails CLOSED.
- **The projection names every field** (the `provider_accounts` #46 precedent)
  and `SELLER_PROFILE_FORBIDDEN_FIELDS` names the prohibition as a VALUE —
  contact/location, payment onboarding, follower identities. Two gates: the
  scanned static one and a RUNTIME walk of a real emitted profile.
- **`owner_type = 'user'` is stated explicitly in the listings predicate**, not
  left to `listings_owner_exclusivity_check` — a store's stock must never read
  as a person's inventory (acceptance 4), and this is the one query where a
  future widening of that CHECK would disclose it. `status = 'active'` excludes
  `restricted`, which is what a takedown writes.
- **Keyset paging on the EXISTING
  `listings_owner_user_status_published_at_id_idx`**; both NULL branches of the
  cursor comparison are written out, because SQL row comparison with a NULL
  member yields NULL rather than true and would drop every undated row. The
  LISTINGS route runs the same access gate as the profile route — otherwise a
  client that skips the profile call pages through a private seller's inventory.
- **Only the `p2p_seller` #76 aggregate appears**, under its own scope label;
  product and item-condition ratings answer different questions about different
  targets. Display name is the sanctioned coalesce, now applied in ONE place
  (`toOxyProfile` in `oxy-user.service.ts`) that every seller card, review
  author, order seller and cart line already flows through.
- Surface: `GET /sellers/:oxyUserId` and `/sellers/:oxyUserId/listings`, both
  `optionalAuth`, both on the dedicated `rl:sellers:` bucket (the route is keyed
  on an Oxy ACCOUNT ID, so enumeration is the risk). `/sellers` (plural) is
  public; `/seller` (singular) is the seller's own management surface. Report
  goes to `POST /reports` with `reportedType: 'seller'` — stored locally by
  design, and the UI never says whether it will be reviewed.
- Deferred: seller-authored profile content, ranking use of any signal here
  (#74), coarse local-discovery hints (they belong to a LISTING), and blocking
  from inside Mercaria (Oxy owns that graph).
## The flag-gated catalogue backfill (#60, ADR 0002 D23/D24)

`services/backfill/` + `db/backfill/` + `db/schema/backfill.ts` (3 tables) +
`/internal/backfill/*`. The staged, reversible, resumable migration of the
listing-first catalogue into the canonical graph. Full reference:
**`docs/backfill.md`**; schema decisions: `db/schema/CONVENTIONS.md` §"The
catalogue backfill". The failure mode that shapes everything here is a REPORT
THAT SAYS IT WENT FINE — a traversal that read nothing, a page that swallowed its
errors and a cohort that matched no rows all produce the output of a clean run.

- **The vacuity floor is a CHECK, not a comment.**
  `catalog_backfill_runs_counters_total_check` forces the outcome counters to SUM
  to `scanned` (equality, never `<=`), so a page that swallowed a record cannot
  write a row. Two more layers back it: `assertCohortIsNotEmpty` refuses a cohort
  selecting no listings when the run is OPENED, and the metrics surface reports
  `scannedFromRecords` counted from the evidence beside the runner's own counter,
  plus `countsAgree`.
- **A dry run cannot write, as a SHAPE.** Stages hold a `CanonicalGraphWriter`
  and no repositories; `createGraphWriter` is the ONE place the choice is made,
  and `backfill-isolation.test.ts` fails the build if a stage calls a canonical
  write service directly. So the guarantee holds for stages nobody has written
  yet. `CANONICAL_WRITE_PUBLICATION_ENABLED=false` downgrades an `apply` run to
  the same writer, so the run still reports and changes nothing.
- **A dry-run row may carry `created`/`matched`/`enqueued`** — in that mode an
  outcome is a PREDICTION, and refusing to store one would make the mode unable
  to report the counts it exists for. It never carries a canonical id.
- **Idempotency is `(mapping_version, mode, stage, subject_key)`**, with `mode`
  INSIDE the key so a dry run can never overwrite the apply it predicted.
  `CATALOG_BACKFILL_MAPPING_VERSION` is a code CONSTANT and not a table: the
  mapping is a procedure, and a table would let somebody publish a version whose
  rules nobody shipped. `provisional_products` additionally reads its own prior
  record, because a mint spans three services' transactions and a crash must not
  leave a re-run failing forever on a slug.
- **`provisional_products` is the stage #58 stopped short of**, and it WAITS for
  a matcher verdict (`awaiting_match_decision`) rather than minting first —
  minting first guarantees a duplicate for every listing whose barcode would have
  resolved. A P2P listing is `unmatched`/`p2p_left_unattached`, which is a
  SUCCESS. Its attachments record `method: 'backfill'` (its own member, added by
  this issue: no connector declared them) with NULL confidence.
- **Per-record error isolation is one helper.** `examineSubject` catches, logs,
  records `record_error`/`failed` and continues; nothing rethrows, because a page
  that aborted on its worst listing would leave the cursor stuck there forever. A
  PAGE-level failure is different: the cursor is not moved and the run is
  released `failed`, so it retries from where it started.
- **The consistency sweep is THREE passes and repairs nothing.** Forward
  (attachment → offer), reverse (offer → attachment → listing, which is
  acceptance 6 verbatim), and a RETIREMENT pass that resolves findings whose
  offer is no longer active — without it the ordinary fix (a convergence that
  retires the offer) would leave `orphanedNativeOffers` reporting a problem that
  had been solved. It repairs nothing because every kind has an idempotent remedy
  a person can drive, and three of the four can mean a jury restricted the
  listing.
- **Six rollout levers, and the WRITE ones default OFF while the READ ones
  default to today's behaviour.** `CANONICAL_GRAPH_ENABLED` (the dispatcher
  LOOP) and `CANONICAL_WRITE_PUBLICATION_ENABLED` are the write levers;
  `CANONICAL_READS`, `CANONICAL_OFFER_COMPARISON` (both `off|shadow|on`),
  `CANONICAL_PUBLIC_ROUTES_ENABLED` and `CANONICAL_READ_COHORTS` are the read
  ones. D24's `CANONICAL_READS=off` was written in phase 0, before #53–#57
  SHIPPED the routes it gates; introducing it `off` would withdraw four live
  public surfaces on the deploy that added it, which D24 forbids. Acceptance 5
  asks that turning reads OFF restores listing-first, which says nothing about
  the default.
- **Nothing in a rollback deletes evidence** — no repository offers a delete, the
  operator surface has no route that could call one, and `/internal/backfill`
  stays mounted while every read lever is off, because the evidence has to be
  readable during the incident that turned them off.
- Operator surface: `/internal/backfill/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58 use. A trace opens
  from a SUBJECT KEY and nothing else — no seller, no person.
- Deferred to their owners: #61 (the `attribute_reindex_requests` drain, and
  every index/projection decision with numbers attached), #39 (favorites), #76 (a
  product-level review projection), #59 (promoting a `draft` product, merges,
  identifier disputes), #70/#71 (the `shadow` mode's both-answers comparison), and
  product-level collections (a separate migration). All six are scanned gates or
  named seams, not stubs.
## Item condition (#90): a taxonomy with evidence behind it

`services/condition/` + `db/condition/` + `db/schema/condition.ts` (6 tables),
plus columns on `listings`, `offers` and `order_items`. Full reference:
**`docs/condition.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"The condition taxonomy (#90)". The binary `new | used` it replaces is GONE —
a clean cut in the internal contract, with ONE versioned wire exception noted
below.

- **Nine stable KEYS, five SEGMENTS, and the copy is not frozen.**
  `ITEM_CONDITION_KEYS` types both columns and renders both CHECKs (the
  `ALL_CURRENCY_CODES` device); labels and plain-language explanations live in
  `@mercaria/ui` `lib/condition.ts` precisely so they can change without
  touching a stored value. Filters, price history and price alerts operate on
  `ConditionGroup`, never on a key.
- **An unrefined assertion can never carry a claim, and that is a CHECK.**
  `listings_unrefined_condition_check` restricts `migrated_binary` and
  `legacy_client_binary` to `UNREFINED_CONDITION_KEYS` = `{new, used_good}`, so
  the legacy `used` can never become `used_like_new` — whether the writer is the
  migration, a v1 client, a service bug or `psql`.
- **A low-confidence source mapping can never carry a key.** Five
  `offers_condition_*_shape_check` constraints; only `declared` and `mapped` may
  sit beside a known condition, and `mapped` needs a confidence at or above
  `CONDITION_MAPPING_CONFIDENCE_FLOOR` — rendered into the CHECK from the SAME
  constant the mapper reads. Sub-floor rules are RECORDED and unappliable, never
  discarded: deleting them would make the review queue impossible to build.
- **A catalogue image can never be condition evidence** (acceptance 4), in two
  independent places. The provenance vocabulary has only seller-owned members
  (and `FORBIDDEN_CONDITION_PHOTO_PROVENANCES` names six that may never join it,
  disjointness gated by a test); and
  `mercaria_reject_canonical_condition_photo` refuses a `file_id` any
  `canonical_images` row already claims — the attack the vocabulary cannot see.
  Evidence is drawn from the listing's OWN gallery; there is deliberately no
  second upload channel, because two places establishing a photograph's
  ownership could disagree.
- **The order snapshot is never rewritten.** All three `order_items` condition
  columns refuse UPDATE outright — not "immutable once set", which would still
  admit a backfill writing NULL → a value. Pre-#90 orders answer
  `{recorded: false}` through `deriveOrderItemCondition`'s discriminated union,
  so a refund or dispute surface cannot reach for a key that was never captured.
- **The revision trail is append-only with a PRECISE delete exception**: UPDATE
  refused always, DELETE refused only while the listing still exists, so the
  `cascade` the foreign key already declares still works and an operator cannot
  remove one correction to hide it.
- **The v1 binary field is a VERSIONED CONTRACT, the one #90 adds.** `condition`
  is still accepted on writes (sending it beside `itemCondition` is a 400, never
  a precedence rule) and still SERVED, derived from `itemCondition.key` on every
  read so the two cannot disagree. `LEGACY_CONDITION_CONTRACT.retiresWhen` states
  the condition. Nothing is marked `@deprecated`; the `checkout` `addressId`
  precedent, for the same reason — a shipped mobile build cannot be recalled.
- **Category-specific facts belong to #94's registry.** Battery health,
  activation lock and garment alterations are named in
  `CONDITION_REGISTRY_DELEGATED_FACT_KEYS` and a gate fails the build if this
  domain grows a column for one.
- **Two migrations**: `0030` (`pre` — CHECKs widened to a superset including the
  legacy `'used'`, every row backfilled, four trigger pairs, one `migration`
  revision per listing) and `0031` (`post` — CHECKs narrowed, transitional
  defaults dropped). `0030`'s hand-written statements sit in two anchored blocks
  and its header states where each goes on a regeneration.
- Operator surface: `/internal/catalog-condition/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56/#57/#58/#83/#94 use —
  ruleset versions, category restrictions, and one listing's history. There is
  deliberately no "set this listing's condition" and no bulk photo approval.
- Deferred with named seams: ranking by condition (#74 — a gate fails the build
  if a feed/search/collection module reaches this domain), the price-history
  table and alerts (#78 — `ConditionGroup` is the segment they must not mix),
  moderation reason codes for misleading condition or stock imagery (the
  CrowdSource plan owns the vocabulary; #90 supplies the provenance a reviewer
  needs), the seller-facing refinement UI, and bulk re-mapping of
  already-observed offers (#37).

## Canonical product saves (#80): the save a buyer actually meant

`services/product-saves/` + `db/productSaves/` + `db/schema/productSaves.ts`
(3 tables) + `favorites.save_intent`, plus `/product-saves`, `/saved-items` and
`/internal/product-saves/*`. Full reference: **`docs/product-saves.md`**; schema
decisions: `db/schema/CONVENTIONS.md` §"Canonical product saves (#80)".

`favorites` is NOT replaced and NOT forked. It stays one account's interest in
one exact native LISTING — right for a handmade piece, an unmatched P2P item, a
used copy whose seller photographs are the reason. What #80 adds is the save of
a canonical PRODUCT, which survives the merchant who happened to be cheapest
today delisting.

- **`UNIQUE(oxy_user_id, canonical_product_id)` is acceptance 1**, and every
  write is `ON CONFLICT DO NOTHING` — so a repeated tap creates nothing AND
  changes nothing, `created_at` included, which is the saved list's ordering key.
  A read-then-write would satisfy the words of acceptance 5 and fail the two
  cases that happen: a double tap and a retry after a timeout the client never
  saw.
- **`save_intent` (`listing_save | listing_pin`) is the buyer answering "did you
  mean this exact one".** A PIN is checked BEFORE the canonical mapping is even
  looked at, so the strongest signal a buyer can give never loses to an automatic
  match; an ABSENT intent on a write leaves an existing row's alone, so a v1
  client cannot downgrade a pin.
- **`matcher` is not confident enough to create a save.** #58 routes a heuristic
  attachment to #59's queue precisely because nobody has agreed it yet, and a
  save built on an unreviewed guess is a false merge with a person's intent
  attached. `CONFIDENT_LINK_METHODS` is derived by SUBTRACTION from #57's tuple,
  so a method added later is never confident by omission.
- **No preferred variant is written by the migration.** The favorited listing
  attaches to one configuration and recording it would narrow the save to it —
  arbitrary for a buyer who favorited two colours, and permanent.
- **Un-saving is PERMANENT against a replay.** `product_save_sources.save_id` is
  `ON DELETE SET NULL` while `favorite_id` CASCADES: the record survives the save
  and blocks a re-migration, where a cascade would let a replay resurrect a save
  somebody removed. That is worse than a duplicate — a duplicate is visible and a
  resurrection looks like the buyer's own doing.
- **A merge rehomes saves; a colliding one STAYS on the tombstone.**
  `repoint_if_absent` guarded on `oxy_user_id`, so a save is left behind only
  when the same buyer already has one on the winner — which is the ONLY reading
  under which the saved-items read excluding a merged product is safe, and a
  realdb case pins exactly that.
- **A split MARKS and never picks** (`saves` phase, new in both
  `CATALOG_MERGE_PHASES` and `CATALOG_SPLIT_PHASES`). Deterministic migration was
  refused: "keep it where it is" is silently wrong for whoever moved, with no
  signal anywhere. The marking touches only `resolved` rows, so a resumed phase
  is a no-op and an EARLIER unanswered ambiguity keeps naming its own job.
- **The counter DERIVES and nothing increments** — no delta parameter exists in
  the domain — and there is deliberately no `canonical_products.save_count`
  projection beside `product_save_aggregates`. Reviews have their entity columns
  only because those predated the aggregate. `listings.favorite_count` stays
  incremental in the hot path and is now REPAIRABLE from `favorites`; the two
  figures are never summed, because a total would double-count every migrated
  favorite.
- **Detection and repair are separate acts** (`payment_discrepancies` posture),
  and the rebuild page visits BOTH the aggregates and the products that have
  saves — the second creates a row that was never written, which a probe over
  the aggregate table alone can never see.
- **The count cannot name anybody**: no actor column on the aggregate, a
  disclosure floor of 10 applied by ONE function (withheld as a STATE, never
  rounded), and an operator trace that opens from a canonical product id and
  returns only counts. `oxy_user_id` is the whole of what this domain stores
  about a person, which is why erasure is one scoped DELETE.
- **Saving subscribes to NOTHING** and **a save is not a ranking input** — both
  scanned gates in `product-save-isolation.test.ts`, with a vacuity floor and a
  mutation self-test. The `priceAlert` DTO field has ONE branch and it is the
  unsupported one (#78), so the client renders nothing rather than a control
  claiming an unbuilt feature exists.
- **`on` read mode still returns listing saves** — the pinned ones and the ones
  no product save represents. Dropping the second set would break acceptance 3
  on the deploy that finishes the rollout. Representation is DERIVED at read time
  from the migration record joined to a save that still exists, never stored.
- Flags: `PRODUCT_SAVES_ENABLED` (the MOUNT; never the rows —
  a rollback that cost buyers their list is not one anybody would pull),
  `PRODUCT_SAVE_READS` (`off|dual|on`, default `off`),
  `PRODUCT_SAVE_MIGRATION_ENABLED` (default false ⇒ every migration request is a
  DRY RUN that reports what it would do). `/internal/product-saves/*` is on the
  SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list and is deliberately NOT gated
  on `PRODUCT_SAVES_ENABLED` — the evidence has to be readable during the
  incident that turned the buyer surface off.
- Deferred with named seams: #78 (price alerts and the price-history table), #74
  (whether saves rank), #71 (the canonical product page), #59 (reviewing an
  ambiguous listing→product mapping, which this domain refuses rather than
  guessing).

## External ingestion (#62, ADR 0002 D19/D22): adapters, rights, staged pipeline

`services/ingestion/` + `db/ingestion/` + `db/schema/ingestion.ts` (5 tables) +
`/internal/ingestion/*`. The provider-neutral framework through which APIs,
affiliate feeds, merchant feeds and controlled extraction become source
observations, canonical matches and fresh external offers. Full reference:
**`docs/ingestion.md`**; schema decisions: `db/schema/CONVENTIONS.md` §"The
external ingestion framework". It EXTENDS what exists — `catalog_sources` and
`source_records` stay the registry and the observation store, #58 stays the
matcher, #57 stays the offer — and adds the machinery nobody owned.

The failure mode that shapes it is an INGESTION THAT LOOKED FINE: a refresh that
failed authentication and retired a healthy catalogue, a re-delivery that
overwrote today's price with last week's, a payload bag that carried a
provider's access token into production, and an adapter that minted a canonical
product from a title.

- **The write boundary is the adapter's SIGNATURE.** A `CatalogSourceAdapter`
  gets no database, no transaction, no repository and no service, and returns a
  `NormalizedSourceRecord` that has no canonical id, no merchant id and no offer
  id to put one in. `ingestion-isolation.test.ts` scans the `adapters/`
  DIRECTORY, so the wall holds for adapters nobody has written yet. Failure
  kinds are a closed set NARROWER than the framework's health vocabulary — an
  adapter cannot classify a rights suspension, a matching ambiguity or an
  anomalous change, because it cannot observe any of them.
- **Only a COMPLETE enumeration may retire anything**, and that needs the
  ADAPTER's `complete` flag AND an outcome in `CATALOG_SOURCE_RETIRING_OUTCOMES`
  (one member). `catalog_source_runs_retirement_check` is rendered from the same
  tuple `health.ts` reads, so a rate limit or a parse failure cannot mass-expire
  a catalogue through the service, a replay or `psql`. `partial_feed` is
  excluded deliberately: "the half I read did not mention it" is not evidence
  about the half I did not read.
- **The nine rights are a versioned, reviewed POLICY, and withdrawing one is a
  NEW version** — frozen once active by trigger, one active per source by
  partial unique. That is acceptance 6 as a shape: no UPDATE could delete the
  history and the domain issues no DELETE. `catalog_sources`' three coarse
  columns are a PROJECTION of `resolveSourceRights(status, policy)`, and
  `mercaria_catalog_source_rights_agree` is a DEFERRABLE constraint trigger
  refusing any COMMIT where they disagree — deferred because a rights change
  touches three tables and no statement order makes every intermediate state
  consistent. A source with no config is left alone, which is what keeps #60's
  backfill and the operator source working unchanged.
- **`paused` and `failed` are different on purpose.** `paused` stops refresh and
  extraction and leaves display; `failed` stays fully refreshable, because a
  source that answered 500 once must retry without a person re-enabling it. A
  run marks a source `failed` only when the FETCH failed — a pass that read the
  feed and refused half of it is degraded and stays `active`.
- **An older observation can never overwrite a newer current fact**, twice: the
  upsert's `ON CONFLICT … WHERE` makes an out-of-order delivery a silent no-op
  (the empty `RETURNING` IS the answer) and
  `mercaria_catalog_source_object_monotonic` states it at the row. The ordering
  key is `source_updated_at` when both sides publish one — two workers reading
  two pages concurrently produce `observed_at` values whose order says nothing.
- **The RAW payload is digested and discarded.** What is stored is the
  normalized projection built from `CATALOG_SOURCE_PAYLOAD_FIELDS`, an
  ALLOW-list (`services/payments/redact.ts`'s precedent), and **its key names
  are the MATCHER's read contract** — a second vocabulary would leave every
  ingested record matching on a title and nothing else, silently. An oversized
  projection is REFUSED rather than truncated: truncation hashes differently
  every delivery, so the convergence key would stop converging.
- **`may_store` decides whether the PAYLOAD is kept, not whether the observation
  is** — and the consequence is stated rather than hidden: the matcher's subject
  loader returns `null` for a payload-less record, so such a source produces
  provenance and freshness and never an offer.
- **The offer is shaped by the rights rather than checked after.** No
  `display_price` ⇒ no price on the offer (the observation keeps it); no
  `outbound_link` ⇒ the kind is `informational` and the CHECK refuses a
  destination; no `affiliate_params` ⇒ no routing metadata for #37 to compose
  from. The merchant comes from the source's own BINDING, never from a payload
  hint — a source with no merchant produces no offers, which is a state an
  operator can fix rather than a merchant nobody authorised.
- **This closes #58's OTHER seam.** An automatic match writes
  `canonical_product_source_links` and `canonical_variant_source_links` in one
  transaction with the object's state — the attachment `match.service`
  deliberately left to "the ingestion path that owns the observation". Anything
  that is not an `automatic_match` writes no link and no offer and cites the
  decision #59 reads; a CHECK makes `review_required` unwritable without one.
- **`catalog_source_rejections` is the RESIDUAL and the only table here with a
  retention deadline.** A `rejected` counter says a page dropped eleven records;
  only these rows say all eleven were the same field a provider renamed. The
  metrics report rejections from the runs' counter AND from the evidence, with
  `countsAgree` beside them (#60's `scannedFromRecords` device).
- **A reusable CONTRACT SUITE, not a fixture dump.**
  `services/ingestion/__tests__/adapter-contract-suite.ts` covers all thirteen
  cases against a REAL Postgres server; #63/#65/#66 each pass a harness that
  materialises a SCENARIO in their own transport and get every case for free.
  The fixture provider is a real adapter over an in-memory feed and is
  registered by NOTHING — a test-only provider auto-registered in production is
  how a live catalogue gets ingested into.
- **`match_policy_versions_active_key` is GLOBAL** (one active policy in the
  whole database), which makes it a shared resource between parallel realdb test
  files. Both claimants wait for the slot with a bounded retry rather than
  weakening the constraint; do not "fix" a collision there by scoping the index.
- Env: `CATALOG_INGESTION_ENABLED` (gates the LOOP only),
  `CATALOG_INGESTION_BATCH_SIZE`, `_POLL_INTERVAL_MS`, `_LEASE_MS`,
  `_MAX_BACKOFF_MS`, `_RETIREMENT_BATCH_SIZE`, `_ANOMALY_PRICE_FACTOR`.
  Operator surface `/internal/ingestion/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60 use, and it
  stays mounted while the loop is off — bringing a feed up by hand is the
  supported path, and the evidence has to be readable during the incident that
  turned the loop off.
- Deferred, each a named contract that fails closed: #63/#65/#66 (the adapters —
  NONE is registered, so every run refuses and says why), #37 (the
  outbound/affiliate redirect), #59 (review and corrections), #60 (minting what
  a `create_new` recommends), #74/#61 (ranking, indexes with numbers attached),
  #116/#121 (supplier-backed `mercaria_retail` eligibility, which this framework
  cannot reach), and the re-normalization drain a `NORMALIZATION_VERSION` bump
  schedules.

## CrowdSource moderation: reports, cases, decisions, enforcement

Abuse reports leave Mercaria durably, CrowdSource decides them with a randomly
drawn jury, and decisions come back signed. **CrowdSource owns cases, reviews and
decisions; Oxy Trust owns reputation; Mercaria owns only its own catalogue
enforcement.** Mercaria never computes reputation and never suspends an Oxy
account.

Code lives in `packages/backend/src/services/moderation/`, over four Postgres
tables/repositories (`abuse_reports`, `moderation_outboxes`,
`moderation_events`, `moderation_enforcements` — schema in
`db/schema/moderation.ts`, repositories in `db/moderation/`) and two routes
(`routes/reports.ts`, `routes/crowdsource-webhook.ts`).

### "Report" is two unrelated things in this repo

`report.service.ts`, `shared-types/src/report.ts` and
`/admin/stores/:storeId/reports/*` are the store **SALES ANALYTICS** surface and
have nothing to do with moderation. Abuse reports are `AbuseReport`,
`services/moderation/` and `POST /reports`. Never merge them.

### The four rules that are load-bearing

- **A 201 from `POST /reports` means stored, never "CrowdSource accepted it."**
  `report-intake.service` commits the `abuse_reports` row and its
  `moderation_outboxes` row in ONE `db.transaction(...)`; no outbound request is
  made in the handler. **`enqueueModerationOutboxEvent` refuses the ROOT
  connection** — `db/moderation/transactionGuard.ts`'s `requireTransaction`
  discriminates a real transaction handle from `getDb()` by whether `.rollback`
  is a function (a type alone is not enough: the root `Database` and a
  transaction share the same `DatabaseOrTransaction` type, so a caller that
  forgets to pass the transaction handle would otherwise compile, commit the row
  alone, and pass any test that only asserts the row exists). It is also the
  ONLY writer of that table, so the row IS the job.
- **`routes/crowdsource-webhook.ts` MUST stay mounted before `express.json()`**
  in `app.ts`, beside `/channels/webhooks`, which is there for the same reason.
  The SDK reads the stream itself and REFUSES if a parser got there first, so a
  wrong order breaks every delivery rather than weakening the check.
- **Enforcement is idempotent on `UNIQUE(decision_id, revision, action)`** on
  `moderation_enforcements`. Each action CLAIMS its row with
  `.onConflictDoNothing()` before acting. `revision` is in the key so a
  correction's `restore` is a *different* action from the removal it supersedes;
  drop it and an accepted appeal can never relist the item.
- **Evidence carries bare Oxy `fileId`s, never a `mercaria.co` URL.** A
  reviewer's browser fetching such a URL would tell this host when its content is
  under review.

### Mercaria's enforcement levers

`CROWDSOURCE_ENFORCEMENT_MODE` is `observe`, `manual` or `automatic`, defaulting
to **`observe`**, which computes and RECORDS the identical plan and changes
nothing. The mapping lives in `enforcement-plan.ts` (pure, table tested).
Mercaria maps `recommendedActions`, not findings, with severity as a fallback
only.

- `restrict` sets `Listing.status = 'restricted'` (or `Review.status = 'hidden'`).
  Every catalogue read filters `status: 'active'`, the cart marks a non-active
  line stale, and checkout refuses stale lines, so ONE field delists AND unsells
  with **no query to edit**. The seller's real status survives in the enforcement
  row for the restore.
- `freeze_transaction` sets `Order.moderationHold`, refused by
  `order.service.transition`. **This is distinct from `restrict`**, which only
  stops NEW sales; the two survive collapse together, because a delisted
  counterfeit whose in-flight orders still ship is the bug that pairing prevents.
  `cancelled` stays reachable so a buyer is never trapped.
- `request_changes` returns the listing to `draft` and notifies the seller
  (`listing_changes_requested`). It is the commerce-only middle ground: the
  seller can fix and republish it themselves.
- `label`, `age_gate` and `reduce_distribution` become `manual_review`. Mercaria
  has no middle setting between listed and unlisted, and recording an effect that
  did not happen is worse than mapping honestly.

**Two enforcement ESCAPES are closed in pre-existing commerce code**, and a
reviewer reading `services/moderation/` would never see them, so do not remove
them: `catalog-write.service.updateListing` refuses to set `restricted` or to
move a listing out of it (a seller could otherwise PATCH `status:'active'` and
undo a jury silently), and `order.service.transition` refuses to advance a held
order.

### Subject providers: what Mercaria sends, and what it deliberately does not

`subjects/registry.ts` decides DELIVERY and nothing else. **A reported type with
no provider is stored locally, NOT refused**: gating the route on the registry
would make adopting CrowdSource a breaking change for every report surface not
yet wired to it.

- Delivered: `listing` to `commerce.listing`, `review` to `commerce.review`.
  Pinned by a test.
- Stored only: `seller`, `store`. `SellerProfile` stores no user-authored
  identity to pin (display name and avatar are read live from Oxy) and
  `applicationId` comes off the credential, so a case would open in Mercaria's
  tenant naming an object only Oxy can act on. That is a missing provider, not a
  refused report.

**Evidence is declared, not attached.** `AssetRef` requires a `sha256`; Mercaria
stores `{fileId, alt, position}` and never calls `configureServiceAuth`, so
`getServiceAssetMetadataByIds` would throw. Closing it needs Oxy service
credentials and nothing else, and then the digest MUST also enter the snapshot
hash.

**Nothing the envelope builder composes may vary between two deliveries of one
report.** Ingress fingerprints it, so an invented timestamp or an unsorted list
turns a legitimate outbox retry into a permanent 409, silently, days later. Hence
`submittedAt` is the report's own `createdAt`, and allegation codes are sorted
and deduped.

### Environment

Names come from the packages, not from a plan table:

```
CROWDSOURCE_ENABLED=false
CROWDSOURCE_SERVICE_KEY=            # applicationId:credentialId:secret, ONE opaque value
CROWDSOURCE_BASE_URL=               # optional
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

**There is no `CROWDSOURCE_APP_ID`, and never add one.** `applicationId` is read
off the credential; a variable holding it could only ever disagree, and a surface
able to carry one independently is a cross-tenant IDOR. `CROWDSOURCE_ENABLED=true`
requires BOTH the service key and the webhook secret (enforced in
`config/index.ts`), because a half-configured integration sends reports that can
never come back.

### Lifecycle

`startModerationOutboxDispatcher` runs on EVERY task. Claims are
`SELECT ... FOR UPDATE SKIP LOCKED` against `moderation_outboxes` with an
owner check, so N dispatchers drain the queue without handing each other the
same row, and a dead task's expired lease is reclaimable. It no-ops when
CrowdSource is off: the LOOP is gated, never the durable record, so reports
taken while disabled deliver once it is switched on. The webhook dedupe store
is **Postgres backed** (`moderation-event.store.ts`, an
`INSERT ... ON CONFLICT (id) DO NOTHING ... RETURNING` claim on
`moderation_events`) because Mercaria runs several ECS tasks, and the SDK's
in-process default would dedupe only the task that received both copies. The
conflict is not an error to catch — the empty vs. one-row `RETURNING` set IS
the "already claimed" answer, so a real failure (a dropped connection, pool
exhaustion) still propagates instead of being read as a duplicate.

`app.ts` exists so the app can be built without listening, which is what lets the
raw-body invariant be asserted against the REAL middleware chain.

### Testing: the moderation writes run against a REAL Postgres server

`packages/backend/vitest.pg.globalSetup.ts` creates one throwaway,
fully-migrated Postgres database per suite run (see "PostgreSQL" above);
`services/__tests__/moderation-writes.realdb.test.ts` runs against it. **Do not
convert those tests to mocks.**

The rest of this backend's tests mock their drizzle repositories, which is fine
for logic and has one blind spot that matters here: **a mocked `insert`/`update`
accepts any statement, including one the server rejects outright** — a real
CHECK, unique index, or the `requireTransaction` guard has no mocked
counterpart. This is where `enqueueModerationOutboxEvent`'s no-op guarantee is
actually pinned: `ON CONFLICT (id) DO NOTHING` writes nothing at all on a
repeat — no tuple version, no timestamp, no lock — for a STRUCTURAL reason
rather than by matching a spelling. Mutating the enqueue to
`.onConflictDoUpdate(...)` with the SAME values still moved `updated_at` by the
duration the test waits (drizzle applies the column's `$onUpdate` to a conflict
branch's `set`, so "write the same data back" is not even a quiet write) and
moved the row's `xmin`; both are asserted, and the `xmin` check is what would
still catch a `DO UPDATE` careful enough to leave every column alone. What that
buys is worth stating plainly: a repeat is a genuine no-op by construction, not
by a flag someone has to remember to pass — and a repeat is ordinary (a
transaction retry, two concurrent duplicate submissions, a reconciliation sweep
re-deriving an event), running while the dispatcher holds leases on those same
rows.

A real server, not a mock: `db.transaction(...)`/`requireTransaction`, unique
indexes and `FOR UPDATE SKIP LOCKED` are the properties under test and none of
them exist without one.

**CI typechecks all three Expo apps**, not just the API and UI. A build is not a
substitute: Babel strips types, so `expo export` happily bundles code `tsc`
rejects, and a `shared-types` change that broke the dashboard passed every build
job.

## Stripe guest checkout (#107, ADR 0006)

`services/payments/guest-correlation.ts` + `services/checkout/guest-rollout.ts`
+ the `guestCheckoutId` metadata key and payment-surface set in
`checkout-payment.service.ts` + the `guest_portal_initialization` outbox type,
plus `packages/frontend/components/payment/CardPaymentStep{,.native}.tsx` and
`app/(app)/checkout/return.tsx`. Full reference: `docs/payments.md` §"Guest
checkout on the card rail". NO new tables — one `pre` migration widening two
CHECKs. The load-bearing rules:

- **After actor resolution there is nothing guest-shaped.** ADR 0006 G1: the
  same PaymentIntent per group, capture, `seller-net-shares.ts` split,
  transfers, ledger, refunds. `openCheckoutPayment` derives its amount from the
  ORDERS and its key from the payment row — neither mentions a buyer, and the
  adapter's `CreatePaymentRequest` has no buyer parameter to widen. A
  `guest-*.service.ts` under `services/payments/` is wrong by construction.
- **`guestCheckoutId` is READ from the group, never passed in.** It must be
  byte-identical on a converging replay or Stripe rejects the reused
  `pi:<paymentId>` key — and the converge path reaches `openCheckoutPayment`
  with a group it did not create and no contact record in hand. It is the right
  value to carry because it is INERT: authorizes nothing, outlives the purgeable
  session, `UNIQUE` per group. `guest_correlation.ts` selects ONE column, and
  that select list IS the boundary — the table also holds the ciphertext and the
  routing HMAC.
- **Metadata has TWO gates that fail differently.** The `PAYMENT_METADATA_KEYS`
  allow-list catches a key nobody thought about; the forbidden-substring scan
  catches one added on purpose under a plausible name (`buyerEmail`,
  `guestSessionId`). Both THROW rather than filtering — a key that should not
  exist is a defect in the composition, and dropping it silently ships it.
- **A guest's presentment currency rides `?currency=`, never the body.**
  `checkoutSchema` refuses `amount`, `paid`, `paymentStatus` and `currency`
  alike (pinned by `checkout-schema.test.ts`), because a body able to carry a
  money word is where one would eventually be trusted. Without the parameter a
  guest prices in FAIR, which ADR 0001 D8 makes unroutable — they could reach
  checkout and never be able to pay. It selects among currencies the server
  already permits, and is IGNORED for an Oxy buyer.
- **Verified success enqueues ONE `guest_portal_initialization` row and creates
  NO credential.** Keyed on the checkout GROUP (one portal grant covers every
  sibling), BEFORE settlement (a rail refusing transfers must not be why a buyer
  cannot find their purchase). The division is mechanical: a grant token minted
  inside payment processing would exist while metadata is being composed, so
  minting after verification makes "it cannot be in metadata" a fact about the
  call graph. #108 replaces one handler body.
- **Method eligibility is server-authoritative and the DEVICE narrows it.**
  `checkoutPaymentSurfaces()` takes NO arguments — the version of "buyer origin
  cannot change it" (B11) a reviewer can check. A client cannot ADD a surface
  the server withheld; the server cannot force one the device cannot show.
- **No Stripe Customer, therefore no saving** (G4/G5). The save surfaces exist
  only when a Customer plus a CustomerSession is configured, so configuring none
  makes them ABSENT rather than hidden. Consent, not thrift: a `GuestSession` is
  a purgeable device credential and storage outliving it is consentless
  retention.
- **Five kill switches, all BLOCK lists, all empty by default** — platform (from
  the credential's CARRIAGE, not a client's claim), market, merchant, fulfilment
  (`services/checkout/guest-rollout.ts`) and payment method
  (`STRIPE_PAYMENT_SURFACE_METHODS`, deployment-wide because ONE client
  component serves both actor kinds). Block lists rather than the house
  allow-list convention because these are incident levers: turning a market off
  at 3am must be adding one value, and an allow-list typo silently switches
  everything else off. A refusal names NO lever — one reason code for four
  dimensions, so a client cannot map the switchboard one input at a time.
- **No lever gates anything durable** (G17). `guest-stripe-checkout-isolation.test.ts`
  fails the build if the ingress, outbox, settlement, refund or reconciliation
  paths learn to read `config.guest`. `STRIPE_ENABLED=false` is NOT a guest
  rollback lever — it unmounts the webhooks and strands verified events.
- **The #85 seam cannot be satisfied by accident.** `GuestSellerActivation` has
  no `activated` member, so `GUEST_SELLER_ACTIVATION_REQUIRED=true` refuses
  EVERY guest checkout under its own reason code until #85 supplies the state.
  Default OFF is ADR 0006 G14's decision, not an omission: guest eligibility is
  the intersection of the gates that already exist, and a per-merchant opt-in
  list would be a second answer to what `onboarding_state` already answers.
- **A guest is never routed to `/orders/...`.** That route is
  account-authenticated and would 401 the person who just paid, so the success
  screen hands over the ORDER NUMBER and promises no email or link #108 has not
  built.
- Deferred with named seams: #85 (the activation state), #108 (the grant, the
  magic link, transactional mail), #109 (claiming), #111 (rollout review, and
  the five `guest_payment_*` analytics event types #107 reassigned there — four
  are client facts and the storefront has no analytics client, and emitting
  `guest_payment_verified` from the payment domain would invert
  `verified-conversion.ts`'s one-way seam for a number the metric already reads
  from `payments`), #112 (guest P2P — refused at group construction with no flag,
  deliberately).

## Mercaria-retail on native checkout (#123, ADR 0004 D1/D4/D5/D7/D8)

`services/checkout/retail.ts` + `services/retail-checkout/` (3 modules) +
`db/retailCheckout/` + `db/schema/retailCheckout.ts` (4 tables) + the
`commercial_role` / `platform` widening on `orders`. Mercaria selling items
ITSELF and procuring them per order from a B2B supplier. Full reference:
`docs/payments.md` §"Mercaria-retail on the card rail". The rules that are
load-bearing:

- **`sellerType = 'platform'` ⇔ `commercialRole = 'mercaria_retail'` is ONE
  CHECK**, and a `platform` order carries NEITHER owner column — which is what
  makes "no connected-seller transfer exists for a retail order" structural:
  transfer creation looks a `provider_accounts` row up by (ownerType, ownerId)
  and a retail order has no owner id to look one up with. Widening that
  exclusivity CHECK is the single edit that could put Mercaria's own retail
  share into a Connect transfer.
- **The retail share is SUBTRACTED from the commission residual**, and the
  subtraction is the load-bearing half. `chargeSucceeded` defines commission as
  `gross − Σ(seller nets)`; without the subtraction the retail share would
  still be booked — as `commission_revenue` — and the ledger would balance
  perfectly while reporting margin on a zero-markup sale (D7 proof 1). ONE
  allocation over ALL orders, then a PARTITION in `seller-net-shares.ts`:
  allocating the two kinds separately rounds twice and leaks the difference into
  the residual.
- **`retail_cost_recovery` is the ONE ledger account #123 adds.** ADR 0004 D7
  names five and assigns them to #128 "together with the code that writes
  them"; #123 IS that code for exactly one, because a retail order's share has
  to be credited somewhere the moment the charge is booked.
- **Retail lines are partitioned out BEFORE grouping**, so the readiness gate,
  the reservation loop, the discount engine and the fee planner never see one.
  ADR 0004 D5's "local inventory is not reserved" is that absence, not a branch
  — there is no `if (sellerType === 'platform')` in `checkout.service` to
  delete.
- **The buyer's refusal names none of the ten conditions.** ONE code
  (`retail_line_ineligible`), the `guest_rollout_blocked` decision with a
  sharper case: distinguishing `supplier_stock_unknown` from `cost_incomplete`
  from `retail_disabled` would let a client vary one input at a time and read
  out a supplier's live stock position and Mercaria's wholesale cost coverage.
- **The join lives in `services/retail-checkout/`, NOT in
  `services/payments/`.** `role-separation.test.ts` (#118) forbids anything
  under `services/payments/` importing the procurement domain, and that gate is
  correct — satisfying D4 step 4 by importing across it would widen it to admit
  the REVERSE edge, which is the one it exists to prevent. The outbox reaches
  the handlers through `retail-outbox.port.ts`.
- **Three ports, three DIFFERENT defaults, and getting one backwards breaks
  something.** The #124 authorization reader REFUSES (a missing authorization
  must fail closed or a deployment procures against whatever is `paid`); the
  outcome consumer is SILENT (a marketplace-only deployment has nothing to
  announce, and throwing would dead-letter every purchase order it ever
  placed); the outbox consumer THROWS (a `procurement_requested` row is a paid
  buyer waiting, and completing it silently reports success on nothing).
- **Everything a purchase order is composed from is FROZEN at checkout.**
  `retail_procurement_intents` + `retail_procurement_intent_lines`, written in
  the order's transaction, append-only by trigger. Nothing on the trigger path
  re-reads a procurement offer, a policy version or an agreement — the buyer's
  amount is frozen, so procuring against anything else is how a locked amount
  and an actual cost stop describing one purchase.
- **`retail_cost_variance_records` BOOKS NOTHING** — no account column, no
  ledger pointer, no threshold verdict. #123 observes, #128 recognizes. The
  direction is DERIVED from the same subtraction the CHECK re-computes, so no
  caller can store a `customer_owed` row with a negative delta (a surcharge
  wearing a refund's name, D8.4).
- **Manual capture is NOT implemented and must not be added.** ADR 0004 D4
  selected immediate capture on verified Stripe facts (2–7 day windows Mercaria
  does not control, one capture per authorization, gated delayed-capture
  programs) and rejected holding an authorization. #123's issue text lists both
  branches; only the selected one exists.
- Env: `MERCARIA_RETAIL_ENABLED` (ENTRY only, default false, half-configured is
  OFF — requires `SUPPLIER_PREFLIGHT_ENABLED` and a non-empty
  `RETAIL_OPERATOR_OXY_USER_IDS`), `RETAIL_BLOCKED_SUPPLIERS`,
  `RETAIL_BLOCKED_MARKETS`, `GUEST_CHECKOUT_BLOCKED_SUPPLIERS`. The pricing
  policy KEY is a code constant.
- Deferred with named seams: #129 (the offer and checkout UX, and D9.1's
  "confirming availability" state), #128 (the variance recognition and the
  other four accounts), #125 (the pilot and the binding operator surface),
  #126/#127 (customer communication, returns and RMAs).

## Gotchas

**Dockerfile node-gyp pin.** The API Dockerfile lives at the **repo root**, not
under `packages/backend/`, and pins `node-gyp` explicitly in the builder stage.
`ws`'s optional native accelerators have no musl-arm64 prebuild, and an on-demand
`bunx node-gyp@latest` races and fails intermittently on ARM. Do NOT remove this
pin.

## Deploy

- **API** is live on AWS ECS Fargate (service `mercaria`, cluster
  `oxy-cluster`), `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR
  `oxy/mercaria`). The ECS service, task definition, ALB rule, ECR repo and SSM
  params are provisioned in `oxy-infra`. The workflow's `test` job runs on
  `ubuntu-latest` (x86), deliberately NOT the `ubuntu-24.04-arm` the `deploy`
  job uses — GitHub-hosted ARM runners don't support service containers at all,
  AND `postgis/postgis` publishes `linux/amd64` only, so the job needs a real
  PostGIS service container either way. Don't "fix" the runner mismatch.
- **Web apps go to Cloudflare Workers (Static Assets), NOT Pages.** Each app
  deploys a Worker (`mercaria`, `mercaria-dashboard`, `mercaria-pos`) via
  `bunx wrangler deploy` using the per-package `wrangler.jsonc`. Workflows:
  `deploy-cloudflare.yml` (storefront, `mercaria.co`), `deploy-dashboard.yml`
  (`dashboard.mercaria.co`), `deploy-pos.yml` (`pos.mercaria.co`). Pages was
  abandoned because its `*.pages.dev` production URL cannot be removed; Workers
  with `workers_dev:false` and `preview_urls:false` serve ONLY the custom domain.
- **Each `wrangler.jsonc` is advanced-mode static assets:** `main: ./dist/_worker.js`
  (the repo's SPA and MIME-fix worker), `assets.binding: ASSETS`,
  `run_worker_first: true`, `not_found_handling: single-page-application`.
  `public/.assetsignore` (containing `_worker.js`) stops the script being
  re-uploaded as an asset. **Do NOT use `cloudflare/wrangler-action`**: its
  `npm i wrangler` chokes on the monorepo's `workspace:*` deps. Run `bunx
  wrangler` directly.
- Custom domains are Worker Custom Domains (managed DNS plus cert), bound on the
  `mercaria.co` zone. No `*.pages.dev` or `*.workers.dev` is exposed anywhere.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  build on every push and PR.

### Deploy handoff

- Register 2 Oxy RP client ids (dashboard, POS):
  `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- The ECS service, task definition, ALB rule, ECR repo and SSM params are
  provisioned in `oxy-infra` (role `mercaria` owns database `mercaria` on the
  shared `oxy-postgres` RDS instance; `DATABASE_URL` is live via GitHub secret →
  SSM `/oxy/mercaria/DATABASE_URL` → the task definition, and the task will not
  boot without it — see "PostgreSQL" above).
- Set `RETAIL_OPERATOR_OXY_USER_IDS` to the Oxy compliance accounts that may
  reach `/internal/retail-eligibility/*` — a FIFTH list, deliberately distinct
  from the payments and catalog ones. EMPTY is a working configuration and means
  the surface is not mounted at all, which also means nobody can publish an
  eligibility policy version, verify a document or raise a recall. The full
  pre-launch list is `docs/retail-eligibility.md`
  §"Production-readiness checklist".
- Set `PAYMENT_OPERATOR_OXY_USER_IDS` to the Oxy accounts that may reach
  `/internal/payments/*`. EMPTY is a working configuration and means the surface
  is not mounted at all — but it also means nobody can trace a payment, replay an
  event or run a repair, so it must be populated before the rail carries live
  money. Alerting and scraping for the metrics this exposes belong to
  `oxy-infra`; the full pre-launch list is `docs/payments.md`
  §"Production-readiness checklist".

## Graph query benchmarks and the indexes they justified (#61, ADR 0002 D21)

`services/graph-benchmark/` (5 modules) + `scripts/graph-query-benchmark.ts` +
`db/__tests__/graph-plan-regression.realdb.test.ts`. Full reference:
**`docs/performance/`** — `README.md` is how it is run and what it cannot tell
you, `canonical-graph-benchmarks.md` is the decisions, and the `plans-*.md` are
generated. The failure mode that shapes all of it: **a measurement of NOTHING
looks exactly like a fast one** — an empty seed, a predicate that matched no
rows and a plan taken against an empty table all produce a small number and a
tidy plan.

- **The SQL measured is the SQL the reader SENT, and there is no second
  spelling anywhere.** Each shape in `workload.ts` CALLS the repository function
  the API calls, against a drizzle handle carrying postgres.js's `debug` hook;
  the recorded statement and its bound parameters are what get EXPLAINed. A
  pasted query would drift silently and in the direction that flatters whoever
  pasted it. A shape therefore cannot outlive its reader — delete the function
  and the file stops compiling.
- **Every number clears a floor before it may be printed.** Row counts are
  floored against the SCALE (never against what the generator wrote — that is
  circular), every shape declares `minRowsReturned`, and the load-bearing ones
  declare `requireIndexes`/`forbidNodeTypes`. An unmet floor renders the report
  as `## THIS RUN MEASURED NOTHING` and exits non-zero; it never prints a
  smaller table. Both floors caught real faults during #61 — one harness bug
  (mutating shapes sharing a transaction, so the sweep's later runs measured a
  predicate the earlier ones had emptied) and one dataset bug (near-identical
  product names, which would have published "the trigram index does not work" as
  a fact about the schema rather than about the seed).
- **`EXPLAIN ANALYZE` really EXECUTES, so a mutating shape runs in its OWN
  rolled-back transaction — one per execution, not one around the measurement.**
  Twenty-two executions sharing a transaction still see each other. The CAPTURE
  is rolled back too, or the sweep permanently changes the dataset every later
  shape is measured on.
- **Two clocks, never averaged.** Plan facts come from one instrumented run;
  p50/p95/p99 come from N uninstrumented ones. Quoting `EXPLAIN ANALYZE`'s
  `Execution Time` as "the latency" reports the cost of measuring.
- **`ORDER BY similarity(x, $1) DESC` cannot be served by ANY index; `ORDER BY
  x <-> $1` can, by GiST.** They are the same ordering (`<->` is
  `1 - similarity`). That respelling plus a GiST index took the candidate search
  from 81.6 ms scanning 31,094 rows to 16.6 ms scanning 25. Do not "tidy" the
  distance operator back into a `similarity` call — it compiles, returns the
  same rows, and costs 6.6× more. A realdb test asserts the reader still spells
  it `<->`.
- **An expression index must render its constant with `sql.raw` AND read it from
  the same constant the reader does.** `offers_variant_price_sort_idx` indexes
  `coalesce(price_amount, MAX_MONEY_MINOR_UNITS)` because that is what
  `listOffersForComparison` sorts by; a constant off by one is not a worse
  index, it is one the planner silently cannot use. Interpolating it normally
  writes a bound-parameter placeholder into the migration, which generates
  cleanly and fails at APPLY time.
- **NO projection, materialized view or denormalized read model was adopted, and
  that is the finding** — at 1 M offers every measured read is an indexed
  single-digit-millisecond query. `docs/performance/canonical-graph-benchmarks.md`
  carries the explicit list of reads that stay normalized, the two whose
  amplification is recorded but accepted (product-level offer comparison, 124×;
  backfill evidence, 125×), and the six things a projection would have to carry
  if one is ever adopted.
- **Write cost is part of the decision and is stated, not waved past**: the
  offer sort index costs +19% on `upsertExternalOffer` and +70% on a price
  update. Accepted because the write cost is constant per row while the read
  cost it removes grows with a variant's offer count.
- **Findings recorded and deliberately NOT acted on** (each with its reason in
  the doc): `offers_variant_comparison_idx` (103 MB) is chosen by no measured
  shape but is not dropped, because these shapes do not enumerate every filter
  branch the comparison read admits; `offers_merchant_browse_idx` has no reader
  (#84 owns the page); `source_records.stale_at` has no index and no reader
  (#68). #61 did NOT build the `attribute_reindex_requests` drain #60/#94 hand
  to it — it is a consumer for a queue whose refresh semantics belong to a
  projection, and #61 adopted none.
- **`bun run build:shared-types` BEFORE `db:generate`, always — a stale `dist/`
  makes a regeneration silently REVERT a sibling branch's CHECK widening.**
  drizzle-kit renders every closed-value-set CHECK from the BUILT
  `@mercaria/shared-types`, not from its source, so a `dist/` predating the
  branch you just rebased onto emits `DROP CONSTRAINT … ADD CONSTRAINT …` pairs
  narrowing the tuple back. Measured on #61's own rebase behind #107: the first
  regeneration dropped `guest_portal_initialization` and two analytics reason
  codes out of their CHECKs, in a migration whose diff looked entirely
  plausible — three `CREATE INDEX` lines with two constraint statements above
  them. It would have applied cleanly and broken the write #107 exists to
  perform. This extends the rebase protocol above: after restoring the journal
  and before regenerating, rebuild shared-types, and READ the regenerated file
  for statements you did not intend rather than only checking that yours are
  present.
- **The benchmark is opt-in (`GRAPH_BENCHMARK=1` plus a `bench` database name,
  plus a third `current_database()` check inside the generator, which
  TRUNCATES); the plan-regression suite is what runs in CI.** It drives the SAME
  workload table against a `ci` scale, has its OWN throwaway database (the
  generator truncates, and the shared one carries every other realdb test's
  fixtures), and mutation-tests itself by dropping an index inside a transaction
  and confirming the gate goes red naming the shape. The `ci` scale is not
  smaller than it is because the property under test is a PLANNER decision — a
  gate that fires because a table is too small for an index to win is a gate
  whoever hits it next disables.

## Live supplier preflight (#122, ADR 0004 D4 step 1 / D5 / D9.3)

`services/supplier-preflight/` (14 modules) + `db/supplierPreflight/`
(7 repositories) + `db/schema/supplierPreflight.ts` (8 tables) +
`/internal/supplier-preflight/*`. What a supplier says NOW, immediately before
Mercaria charges anybody. Full reference: **`docs/supplier-preflight.md`**;
schema decisions: `db/schema/CONVENTIONS.md` §"The supplier preflight domain".
#118 records what a catalogue FEED last claimed; this records what a supplier
ANSWERED to one exact question, and the two are separate vocabularies precisely
so the first can never be mistaken for the second.

- **A capability the adapter did not declare has NO representable success**, in
  four independent places — the `SupplierReservationOutcome` union (its only
  `reserved` branch carries a non-optional provider id AND expiry),
  `applyDeclaredCapabilities` (runs on EVERY answer, in the one place answers
  enter, and REPORTS each removal as a `SupplierEmulatedCommitment` rather than
  dropping it silently), `recordSupplierReservation`'s signature (it takes
  `Extract<…, { state: 'reserved' }>`, so an unsupported outcome cannot call
  it), and the table (`provider_reservation_id` + `provider_expires_at` NOT
  NULL, plus a CHECK requiring `inventory_reservation` in
  `declared_capabilities`). There is no `reserved` column on `supplier_quotes`
  at all: a hold is a ROW, and its absence IS the absence of the commitment.
  `SUPPLIER_EMULATED_COMMITMENTS` (6) is disjoint from
  `SUPPLIER_ADAPTER_CAPABILITIES` (12) — the `RETAIL_FORBIDDEN_COMPONENT_KINDS`
  device, applied to commitments.
- **Every downgrade lands on the value that BLOCKS, not the one that refuses.**
  `orderable` becomes `unknown` and never `unavailable`; `guaranteed` becomes
  `advisory`; a window becomes absent and never zero. The supplier may well have
  the stock — what is missing is Mercaria's right to claim it does.
- **A timeout is `unknown`.** `unknownAnswer()` is the ONE function every failed
  call produces and has no parameter that could make it answer otherwise.
  `deriveSupplierPreflightCompleteness` is pure and three-valued (`complete |
  partial | invalid`); only `complete` may check out, `block_reasons` is
  non-empty exactly when the status is not `complete`, `exception_kind` present
  exactly when `invalid`, and the same rule is a CHECK on the row. **Only the
  three facts #122 names block a `complete` answer** — unknown availability, a
  missing shipping cost, an ambiguous SKU; a delivery window and a tax treatment
  block only when the active POLICY requires the capability, or a made-to-order
  supplier could never sell anything. An `ambiguous` identity is an exception; a
  `mismatched` one is a `partial` and a catalogue correction (#59) — different
  facts. A `maxOrderableQuantity` of ZERO beside a minimum order quantity is NOT
  a contradiction: it is how a supplier says out-of-stock.
- **A quote stores NO address**, not even encrypted: `destination_country` and
  `destination_region` are the whole of it, and `request_fingerprint` (an HMAC
  under its own key) is what ties a quote to the destination it was taken for —
  the `purchase_orders` redaction-by-shape device, one step further, because a
  parcel needs a street and a QUOTE does not. The fingerprint, the idempotency
  key, `source_record_ref` and `provider_reservation_id` are all PROTECTED (a
  keyed digest is still an exact-match ORACLE — the `guest_checkouts.email_hash`
  reasoning).
- **Usage state is DERIVED**, never a column — `consumed_at`, `released_at`,
  `superseded_by_quote_id` and `expires_at` state it completely. #122 lists it
  as a stored field; this domain answers it with `deriveSupplierQuoteUsage` for
  the reason every Oxy domain does.
- **The idempotency policy is explicit**: a still-usable quote under the key is
  RETURNED with no supplier call; an expired/consumed/released one is REFRESHED
  under `<callerKey>#<supersededQuoteId>` (deterministic, so two racers collide
  on the unique and the loser reads the winner back and releases any hold it
  took). **A rotated session cannot duplicate a request** because the
  fingerprint's input type has no session, actor or checkout-group member —
  structural, not tested.
- **Selection is a total order over eight criteria and cannot read a
  commission.** `SourcingCandidateFacts` has no member for any of the eight
  `SUPPLIER_FORBIDDEN_SOURCING_SIGNALS`, which are disjoint from the rankable
  set by a test, and a policy version's `ranking_criteria` CHECK reads the
  allowed tuple. An unknown cost sorts LAST; an ABSENT health measurement is
  neutral (the `SELLER_TRUST_RESTRICTED_TIERS` rule); suppression, inactivity,
  ineligibility, a missing capability and over-concentration are FILTERS rather
  than penalties. Substitution checks product identity ALWAYS and commercial
  terms only once terms are LOCKED; a failover supplier's own SKU is fine for a
  mapped variant, and two unmapped SKUs are refused because they cannot be
  PROVEN to be the same product.
- **Summing per-item shipping when the supplier priced the basket is
  unrepresentable** — `SupplierShippingQuote`'s `basket` branch has no per-line
  member, its `unknown` branch has no cost, and `composeDeliveredTotal`'s
  incomplete branch has no `total`. A mixed-currency group is reported unquoted,
  never converted: this domain does no FX (a test).
- **The provider lease is exact in both dimensions with ONE table** — a slot is
  a row (concurrency, a row lock) carrying its own share of the per-minute
  allowance (rate, the same lock). It can UNDER-admit on uneven arrivals, which
  errs toward not exceeding the provider's published limit. The refusal
  discriminator asks whether EVERY slot is exhausted, so a concurrent claim read
  through MVCC lands on the transient `all_slots_busy` rather than the alarming
  `rate_limited` — the reverse phrasing gets that backwards, measured.
- **The health loop may raise and lift a `health_degraded` stop and NOTHING
  else** — a CHECK restricts `automatic_health` to that kind with a NULL raiser,
  so it cannot file a kill switch, and it never lifts an operator's stop.
  `attempts = successes + failures` is a CHECK (equality), the
  `catalog_backfill_runs` vacuity floor applied to a provider.
- **`PROCUREMENT_OPERATOR_OXY_USER_IDS` is a SIXTH allow-list**, for a power
  none of the other five holds: reading what Mercaria PAYS its suppliers and
  flipping the supplier and market kill switches. Empty = not mounted (404). The
  surface is READ plus two write kinds and NO third — there is no "set this
  quote complete", no "extend this reservation", no "override this answer", and
  a route test asserts those paths 404.
- **The fake adapter is double-gated**, and the second gate is the load-bearing
  one: `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` to be registrable, AND a
  refusal of any `live` supplier account at call time whatever the flag says.
- Env: `SUPPLIER_PREFLIGHT_ENABLED` (default false; requires
  `SUPPLIER_PREFLIGHT_FINGERPRINT_KEY` — an unkeyed digest is an offline oracle
  over buyers' postal codes), `SUPPLIER_PREFLIGHT_SWEEP_ENABLED` and its
  tunables, `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED`,
  `PROCUREMENT_OPERATOR_OXY_USER_IDS`. With preflight OFF every preflight still
  runs, records its attempt and writes a quote answering `unknown` — nothing is
  silently permitted. The sourcing policy KEY is a code constant.
- Seams, each a named contract that fails closed: **#124** (the registry is
  EMPTY and an unregistered provider answers `provider_unconfigured`, which
  blocks; `authorizeSupplierFulfilment` refuses unconditionally because
  `authorized: true` needs a purchase-order id the isolation gate forbids this
  domain from importing — that `return` is the one line #124 replaces), **#123**
  (`assertPreflightSatisfiesCheckout` is COMPLETE and waits on nothing), **#117**
  (the capture sequence reads the quote and reservation deadlines), **#128**
  (variance BOOKING), **#93/#37/#74**.

## The guest order portal (#108, ADR 0003 D5/D9/D10/D11/D17)

`services/guest-portal/` (10 modules) + `db/guestPortal/` (6 repositories) +
`db/schema/guestPortal.ts` (5 tables) + `middleware/guest-portal.ts` +
`routes/guest-orders.ts` + the portal half of
`routes/internal-guest-commerce.ts`, plus the storefront's
`app/(app)/guest-orders/`. How somebody who bought without an Oxy account comes
back to that purchase from a device holding no cart credential. Full reference:
**`docs/guest-portal.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"The guest order portal (#108)".

- **A credential authorizes exactly ONE checkout group** — not an email's
  orders, not an inbox, not a person. An address that placed three checkouts
  gets three independent messages with three single-use tokens; no
  authorization context, response or message ever holds two checkouts at once,
  which is email-verification rule 8 made structural. There is no shape in the
  domain that could describe "every order for this address", so such a request
  is unrepresentable rather than refused (ADR 0003 T7/T11, I4).
- **ONE table for both credentials** (D5): the `mgx_` exchange token and the
  `mgp_` portal credential are the same five facts differing only in lifetime
  and carriage. Scope is STRUCTURAL — two anchored readers and a SECOND resolver
  beside `commerce-actor.ts`, so a `mgs_` cart token fails its shape gate before
  any hashing (I3 as a property of the call graph).
- **Two CHECKs carry the verification model.**
  `…_verification_origin_check` refuses a verification instant on a
  `post_checkout` row, so paying — card, wallet, Stripe Link — cannot prove an
  inbox in any code path. `…_unverified_scope_check` holds an unproven PORTAL
  credential to `tracking:read`. It EXEMPTS `exchange` rows: their scopes are a
  PROMISE of what they mint, and an exchange token reads nothing.
  `email_verified_at` is ONE column and the boolean is derived (the
  `contact_verified_at` correction, again).
- **`cardinality(scopes) >= 1`, never `array_length(scopes, 1) >= 1`** — on an
  empty array the latter is NULL and a CHECK reads NULL as SATISFIED, so the
  obvious spelling admits exactly the row it refuses. Both this and the exchange
  exemption were found by `guest-portal.realdb.test.ts` on its first run; a
  constraint without a real server behind it is a comment.
- **The confirmation grant is PULLED, not pushed.** D5 says checkout completion
  mints it; completion runs in the payment outbox with nobody there to receive a
  bearer token, and a token minted into a handler is a token minted into a log.
  `POST /guest/orders/confirmation` mints exactly D5's row, with D5's origin and
  scope, at the first moment there is a client to hand it to — which also makes
  the confirmation view work before the webhook arrives.
- **`contact_change:request` is DEFINED and NOT GRANTABLE** — the `role_email`
  decision from #83. The CHECK, the projection and the switch all exist for it;
  `resolveGrantScopes` declines to offer it, so the gap is documented rather
  than invisible and enabling it is not a schema change.
- **Recovery ALWAYS answers 202 with one fixed sentence**, and the work runs
  AFTER the response so timing cannot distinguish either (T5).
  `requestGuestOrderRecovery` resolves `void` — there is no value to branch on.
  The order number is a HINT (T6): it narrows a search already scoped by the
  email hash and a number naming somebody else's order narrows to NOTHING,
  because ignoring a non-matching hint would leak that it belongs elsewhere.
- **Three throttle axes, two of them durable in Postgres** — "how often has THIS
  INBOX been asked for, across every ECS task" is not a per-process question
  (the #83 device). Every subject is an HMAC with the AXIS in the preimage; the
  network axis is a COARSE /24 or /64, so it bounds a flood and identifies
  nobody. No user agent, screen metric or client identifier exists anywhere in
  it — the absence IS "without fingerprinting".
- **The transport is a NAMED, FAIL-CLOSED seam and NOTHING SENDS TODAY.**
  Mercaria has no outbound email; the registry in
  `services/guest-portal/transport.ts` is EMPTY and every attempt fails
  `transport_unconfigured`, visibly, with the row intact. A `console.log`
  transport looks like a working feature in every test and sends nothing in
  production; an SES client against unprovisioned credentials looks like one in
  production and fails like an outage. Closing it is one module plus one
  `registerGuestMessageTransport` call — nothing else in #108 changes.
- **The message queue is the moderation outbox, ported**: deterministic
  caller-supplied id (so duplicate webhooks converge on ONE confirmation, down
  to the row's `xmin`), `FOR UPDATE SKIP LOCKED` leases, capped backoff, visible
  `dead_letter`. The row holds NO recipient, no subject and no body — the send
  path decrypts at the moment of sending and the TEMPLATE is code, so a copy fix
  applies to queued messages. A link-bearing message mints its `mgx_` INSIDE the
  send transaction, so no plaintext token rests in a queue row.
  `GUEST_PORTAL_MESSAGE_TRIGGERS` names the enqueuer for each of the seventeen
  kinds or the issue that owes it, and a test fails the build on a kind that is
  neither — the `deferred: #NN` device.
- **Suppression is a fact about an ADDRESS, keyed on the HMAC**, so a leak of
  the whole list discloses no addresses. Nothing expires — a hard bounce does
  not heal on a schedule — and a suppressed address makes future messages
  terminal while the ORDER stays fully readable in the portal.
- **NO lever gates a portal READ.** The router mounts unconditionally and
  `guest-portal-isolation.test.ts` fails the build if a read path reads one of
  the four guest levers; the integration suite runs entirely on a deployment
  with `GUEST_COMMERCE_ENABLED` off and ASSERTS that premise. The fifth lever,
  `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED`, gates the dispatcher LOOP and never
  the row. The one real interaction: `POST /guest/orders/confirmation` needs a
  live guest SESSION, so with guest commerce off a paid buyer reaches their
  orders through the emailed link instead of the tab they paid in.
- **Two views, two TYPES.** `GuestOrderStatusView` (what an unverified
  confirmation credential sees) carries order number, coarse status, seller and
  an item COUNT — and no money, address, item title or contact. A different type
  rather than a filtered one, the `MerchantOrder` device: a serializer reaching
  for a total on it fails `tsc`. A scope mismatch is 403; a group mismatch is
  404.
- **Sensitive actions need a FRESH inbox proof** (`GUEST_PORTAL_STEP_UP_MINUTES`
  over `email_verified_at`), so a thief holding a stolen credential cannot lock
  the owner out with it. "Secure my access" spares the PRESENTING credential —
  without that, securing your access logs you out, and a control people avoid
  pressing protects nobody.
- **The client owes three things the server cannot do**, because the token is in
  the FRAGMENT precisely so the server never sees it: strip it with
  `history.replaceState` before the exchange resolves (capture first — replacing
  the URL is what makes it unreadable), `<meta name="referrer" content="no-referrer">`,
  and exchange ONCE (a `useRef` guard plus `retry: false`, because a retry burns
  a second grant).
- Operator surface: `/internal/guest-commerce/portal/*` on the SAME
  `GUEST_OPERATOR_OXY_USER_IDS` allow-list #104 uses — deliberately not a
  seventh list. TWO actions and no third, both of which the buyer can already
  drive: **no Mercaria employee is ever in possession of a portal credential**,
  because the only function that mints one from an operator's request puts it in
  the buyer's inbox (T15). The re-send has no destination field in the service
  signature or the HTTP schema; the trace opens from a CHECKOUT GROUP and
  nothing else. Every attempt is audited, refusals included.
- **#77's `#108` analytics seam is CLOSED.** What supplied the three event types
  was the GRANT ROW: an id that authorizes nothing and is not reusable, so the
  funnel is countable without a token, an address or a hash reaching a column.
  `guest_recovery_requested` deliberately carries NO checkout group and is
  emitted on every request whether or not anything matched.
- Deferred with named contracts: #109 (`claim:write` is already granted and the
  columns exist; the endpoint is missing), #110 (`cancellations:request`,
  `returns:request`, `support:write` granted and unconsumed; `contact_change`),
  #111 (the three payment-notification thresholds), #93 (`order_ready_for_pickup`
  cannot fire while pickup fails closed at checkout).
## Idempotent supplier adapters and PurchaseOrder orchestration (#124, ADR 0004 D4 steps 4–5 / D6.6 / D9.2 / D10)

`services/supplier-orders/` (17 modules) + `db/supplierOrders/` (5
repositories) + `db/schema/supplierOrders.ts` (7 tables) +
`/webhooks/suppliers/:supplierAccountId` + `/internal/procurement/*`. How
Mercaria actually BUYS from a supplier. Full reference:
**`docs/purchase-orders.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"The supplier order orchestration". #122 records what a supplier says before
Mercaria charges anybody; this places the order, watches it and cancels it.

The failure mode that shapes all of it: **a supplier order placed TWICE for one
customer order, because an HTTP response was lost.** Real money, invisible until
a statement is reconciled weeks later, and every naive recovery makes it likelier.

- **It EXTENDS #122's capability contract; it does not fork it.**
  `SUPPLIER_ORDER_CAPABILITIES` (12) joins `SUPPLIER_PREFLIGHT_CAPABILITIES`
  (12) into the one `SUPPLIER_ADAPTER_CAPABILITIES` tuple every
  `declared_capabilities` CHECK reads, and `SUPPLIER_ORDER_EMULATED_COMMITMENTS`
  (7) joins the six. Two lists describing one adapter can disagree, and the
  direction they disagree in is always the permissive one. `SupplierOrderAdapter`
  EXTENDS `SupplierPreflightAdapter` — one object, one slug, one registry entry
  — and ten of the twelve capabilities name a METHOD `registerSupplierAdapter`
  refuses an adapter for declaring without implementing.
- **Every downgrade lands on the value that BLOCKS**, #122's rule applied to
  orders: `partially_accepted`→`unknown` (never `accepted`), `delivered`→
  `unknown`, shipments→`[]`, `duplicateOfExistingOrder`→`false`. Each removal is
  REPORTED as the emulation it prevented and becomes a `capability_not_declared`
  exception.
- **`afterWrite` is what makes an outcome ambiguous, and the ADAPTER states it.**
  Only the code holding the socket knows which side of the write a failure fell
  on. An unclassified error reads as `afterWrite: 'unknown'`, treated exactly as
  `yes` — reading it as "definitely nothing was written" is the assumption that
  costs money. The error CLASS is deliberately not part of the answer: a
  `validation` failure AFTER the write is still ambiguous, because some
  providers validate asynchronously on an order they already created.
  `supplier_order_attempts_ambiguity_shape_check` makes `ambiguous` unreachable
  without it, so it is not a value a service could choose.
- **There is NO plain retry path in `submission.service.ts` at all.** If the
  last submission attempt is `ambiguous` or still `in_flight`, the provider is
  ASKED whether it holds an order under Mercaria's client reference; a second
  submission is reachable only after that answers "no". A provider that did not
  declare `order_reference_lookup` cannot be asked, and that is where an
  ambiguity becomes an operator's row (`unconverged_submission`) rather than
  another attempt.
- **Four mechanisms make a duplicate impossible, none a convention**: #118's
  UNIQUE `idempotency_key`; the outbox row's DERIVED id (so an operator retry
  claims the same row — idempotency item 6 held by a primary key); the attempt
  row committed `in_flight` BEFORE the call; and #118's UNIQUE
  `supplier_external_order_id` per account, whose refusal becomes a HALTING
  `duplicate_external_order`.
- **ONE chokepoint calls providers** (`provider-call.ts`, a scanned gate on the
  registry import). Account state → suppression → capability → fetch lever →
  credential → #122's provider lease → attempt row → call → outcome. **A refusal
  is an OUTCOME**, written as an attempt row with a named reason: "we never
  asked" and "we asked and it failed" lead an operator to opposite conclusions.
  A SUBMISSION and a CANCELLATION are deliberately NOT gated by the fetch lever
  — they are consequences of money that already moved.
- **The mapping is a PROCEDURE the adapter ships, versioned, never a table**
  (`CATALOG_BACKFILL_MAPPING_VERSION`'s reasoning). An unrecognized provider
  status answers `unknown`, records `unmapped_provider_state` and moves nothing.
  #124's sixteen states are all representable and only NINE are statuses (ADR
  D9.2): `submitting` is an `in_flight` attempt, `partially accepted` is the
  line-outcome trail, `credited` is a document, `exception` is a case. A status
  for any of them would give the machine two ways to say one thing.
- **One observation path, four callers**, and `decideProviderObservation`'s
  check ORDER is load-bearing: staleness first (a late delivery is not a
  regression — an at-least-once stream produces them constantly), then
  `unknown`, then **a TERMINAL order receiving anything further** (before the
  rank check, so a shipment on a cancelled order reaches the caller as
  `shipment_after_cancellation` instead of being buried in the generic
  regression bucket), then the rank regression. The ordering key is the
  PROVIDER's `observed_at`; two racing deliveries produce receipt times whose
  order says nothing.
- **The webhook is the FOURTH raw-body mount** and its account is in the PATH,
  never the body. An unverifiable delivery is REFUSED and COUNTED, never stored —
  `SupplierEventVerification` has no `unverified` member, so it has no row shape.
  An unknown account gets the SAME 401, because a distinguishable answer
  enumerates account ids. **The mount is NOT flag-gated**, unlike Stripe's: what
  makes a delivery verifiable here is the account and its credential, so an
  unconfigured deployment already 401s — and a flag could strand a supplier's
  events during the incident where their configuration is being fixed.
- **Dedupe is TWO partial uniques, not one `NULLS NOT DISTINCT` constraint.** A
  poll has no provider event id, so its identity is a content digest; making
  NULLs collide would collapse every polled event for an account into one row.
- **Polling is ONE self-rescheduling row per purchase order**, whose reschedule
  RESETS the attempt counter (a poll that answered is a success). A terminal
  order is confirmed for a bounded grace measured from its OWN terminal
  timestamp, then polling stops. Webhook/poll disagreement is RECORDED
  (`webhook_poll_disagreement`), never resolved by a rule about which source
  wins.
- **Cancellation keeps four answers apart** — requested / accepted / rejected /
  ambiguous — and **nothing here refunds, restocks or deletes**. A supplier's
  refusal returns the order to `accepted` and the recovery is #127's RMA;
  calling it a cancellation would tell a buyer their money is coming back while
  a parcel is on its way to them.
- **Four exception kinds HALT fulfilment** (`PROCUREMENT_HALTING_EXCEPTION_KINDS`)
  and raising one also sets `operator_intervention_required`, in ONE place, so
  the flag and an open case cannot disagree. One OPEN case per condition by
  partial unique — and a RESOLVED one is re-raisable, which a plain unique would
  forbid forever.
- **Credentials are a PORT whose default REFUSES.** Mercaria stores an SSM PATH
  (#118); `credential.port.ts` resolves the value per call and answers `null`
  until a deployment registers a reader, which the chokepoint turns into
  `credential_not_valid`. The secret is passed TO the adapter, so an adapter
  holds none between calls and cannot cache one across a rotation.
- **Privacy is absence first**: no address, recipient, phone, email or document
  URL column exists in the domain. Then the ALLOW-LIST
  (`SUPPLIER_EVENT_PAYLOAD_FIELDS`, nested objects NOT walked — a nested object
  is where a provider puts the address). Then the scrub, whose digit rule is
  FIVE or more where #122's is six: five digits is the commonest postal length
  there is, and this domain's requests carry a street where the preflight's do
  not. `request_hash` and both event handles are PROTECTED.
- **Three independent loop levers, none gating a durable record** (a scanned
  gate): `PROCUREMENT_ORCHESTRATION_ENABLED` (submit/cancel, default false),
  `PROCUREMENT_PROVIDER_FETCH_ENABLED` (outbound reads),
  `PROCUREMENT_EVENT_PROCESSING_ENABLED` (applying stored events). The
  per-supplier kill switch is a DIFFERENT mechanism —
  `supplier_accounts.state = 'killed'` — and stops new submissions while status,
  cancellation, return and reconciliation carry on (acceptance 5).
- **The conformance suite is a SUITE, not a fixture dump.**
  `services/supplier-orders/__tests__/adapter-conformance-suite.ts` covers all
  fourteen cases against a REAL Postgres server through the REAL orchestration;
  #125 passes a harness and gets every case for free. It builds the supplier,
  account, agreement, order and purchase order itself, so two adapters are
  measured against one commercial setup. "Successful QUOTE" stays #122's.
- **`supplier_accounts` identity is now frozen by trigger** (`provider`,
  `environment`, `provider_account_id`) — #124 security 8. Purchase orders,
  quotes and events NAME an account rather than snapshotting its environment,
  so freezing the account is what stops a flip reinterpreting every historical
  row that points at it.
- **`authorizeSupplierFulfilment` MOVED** from
  `services/supplier-preflight/checkout-contract.ts` to
  `services/supplier-orders/fulfilment-authorization.ts`. #122's isolation gate
  forbids the preflight domain from importing the purchase-order repository, and
  that wall was not relaxed — the function went where it can read the row that
  DOES authorize. A clean cut: the old module exports it no longer and carries a
  note saying where it went.
- Operator surface `/internal/procurement/*` on the SAME sixth allow-list
  (`PROCUREMENT_OPERATOR_OXY_USER_IDS`), NOT a seventh. Every write DRIVES an
  existing idempotent path; there is deliberately no "set this purchase order
  accepted", no "attach this external order id", no "clear this attempt" and no
  "delete this event". The one mutation of a stored fact is closing an
  EXCEPTION, attributably.
- Seams, each a named contract that fails closed: **#123**
  (`registerProcurementPaymentAuthorizationReader` — one function; the default
  refuses every order under its own reason `authorization_reader_not_registered`,
  so a deployment without retail checkout places no supplier orders and says
  why), **#125** (no adapter is registered; the fake one is double-gated and
  refuses any `live` account whatever the flag says), **#126** (the accepted /
  rejected announcements), **#127** (returns — the adapter contract exists, the
  RMA table is #127's), **#128** (`purchase_order_documents` records what a
  supplier billed; nothing here books anything), and the buyer RELAY EMAIL,
  which needs an outbound mail transport Mercaria does not have — so
  `SupplierRecipient` has no email member at all.

## Source-aware offer freshness, refresh and catalogue health (#68)

`services/offer-freshness/` (9 modules) + `db/offerFreshness/` (5 repositories)
+ `db/schema/offerFreshness.ts` (5 tables) + `/internal/offer-freshness/*`, plus
four columns on tables #57 and #62 own. Full reference:
**`docs/offer-freshness.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Offer freshness and catalogue health (#68)". #62 turns a record into an offer;
this decides how long that offer is worth showing, when it is re-read, how hard
Mercaria may knock while re-reading it, and what happens when a feed publishes
something that cannot be true.

The failure mode that shapes it is a REFRESH THAT LOOKED FINE: a source down for
an hour whose whole catalogue was retired on the deadline, a feed publishing
majors where minors were, an offer republished after a gap and minted as a
SECOND row, and a price alert firing on a price nobody could buy.

- **There is no global TTL and four independent things make one
  unrepresentable.** `SourceFreshnessPolicy` carries the id of the source it was
  resolved for and `assessOfferFreshness` REFUSES a policy naming a different
  one (`unknown`/`policy_source_mismatch`), so one shared object cannot serve
  two sources; every duration lives on a row keyed to one source, with no
  deployment-scoped row and no nullable `source_id`; `policy.ts` imports no
  configuration, because the way a global TTL would actually arrive is somebody
  reaching for `config.offerFreshness.defaultTtlSeconds` when a source has no
  policy row; and `freshness-isolation.test.ts` fails the build on either. A
  FRACTION or a MULTIPLE is deliberately permitted — `SOURCE_WARNING_FRACTION`
  is two thirds of a different number for every source. The prohibition is on a
  LIFETIME, not on every duration: a poll interval and a rate window are
  Mercaria's own politeness and are legitimately deployment-wide.
- **Four layers, each of which can only SHORTEN**: a published freshness
  version, else the source's own config, capped by the rights policy's
  contractual `cache_ttl_seconds` (`effectiveOfferLifetimeSeconds` is a `min`
  with no parameter that could lengthen one), and — for an offer whose source is
  a bare provenance registry row with no ingestion config — the OFFER's own
  stored `stale_at`, per offer. That last layer exists so adopting #68 does not
  withdraw #60's and the operator source's offers from comparison on the deploy
  that adds it (ADR 0002 D24).
- **The clock is the last CHECK (`lastSeenAt`), not the last CHANGE.** Running
  the deadlines from `observedAt` expires every stable price on a feed that
  republishes the same number daily, which is most of a catalogue. Both ages are
  reported.
- **`stale_at` is a PRE-FILTER and the derivation is the AUTHORITY.** The SQL
  narrows a million rows on the indexed stored deadline; the projection
  re-derives live and DROPS what it refuses. The two can only disagree after a
  policy change and the intersection is a SUBSET of what the derivation admits —
  so a cache cap that shortens a lifetime bites at the next read with no sweep
  having run, and the disagreement can never SHOW an expired offer. A page may
  return fewer than `limit`; the keyset cursor is unaffected.
- **Grace delays the RETIREMENT, never the display.** An offer past its deadline
  leaves comparison immediately, derived; the durable retirement waits while the
  source is in a FETCH failure. `rights_suspended` earns NO grace — a withdrawn
  right is a decision to stop showing the data, so extending its life is exactly
  what the grace must never do — and neither does `schema_drift`, where Mercaria
  read the feed fine and did not like what was in it.
- **Absence and a statement are different evidence** (acceptance 2 versus 3).
  `AdapterFetchPage.removals` carries positive statements and an OMISSION is not
  expressible there at all; `catalog_source_objects.retirement_kind` records
  which of the three paths retired an object; and
  `catalog_source_runs_complete_mode_check` refuses a complete enumeration from
  any mode but `full_snapshot`. Removals are counted in `offers_removed`, NOT in
  `offers_retired`, which `catalog_source_runs_retirement_check` reserves for
  inferences from silence.
- **A returning offer revives the SAME row.** `offers_active_source_key` was
  narrowed to `offers_source_identity_key` by dropping `status = 'active'` from
  the predicate — with it, a retired offer did not occupy its source key and the
  next observation minted a rival, splitting the observed history across two
  ids. `superseded` is excluded from the new predicate, which is what lets the
  `post` migration collapse a pre-existing duplicate without deleting a row.
- **The refresh budget binds the FLEET.** `catalog_source_refresh_leases` is
  `supplier_call_leases` (#122) pointed at an inbound source: "how many calls a
  minute may this source receive across every ECS task" is not a question an
  in-process bucket can answer. It does NOT replace #62's source lease, which is
  about ownership.
- **Capability first, and a refusal is recorded rather than downgraded.**
  `chooseRefreshMode` reads the ADAPTER's declared `refreshModes` (now a
  REQUIRED field, so no adapter claims everything by silence), narrowed by the
  source's policy and never widened by it. A task asking for a mode the adapter
  cannot do DEAD-LETTERS with `unsupported_mode`; a targeted refresh quietly
  served as a full snapshot is a quota bill nobody asked for.
- **A page is judged BEFORE any of it is published.** #62's loop was
  persist-then-advance per record; #68 splits it, because by the time the last
  row shows the distribution to be wrong the first ninety-nine have replaced
  ninety-nine live prices. A quarantined page advances nothing —
  `advanceObject` is unreachable, a property of the call graph. **A legitimate
  half-price sale does not trip the scale detector** (2× against a factor of 10,
  a real test) and **`mass_disappearance` is measured FIRST and is NOT gated by
  the price-sample floor**: the pass that fails to mention everything is the one
  that returns zero records, so gating it there made the worst case the one case
  the detector was silent about. It gates RETIREMENT rather than publication.
- **A quarantine ends by an operator RELEASE (actor mandatory) or a CORRECTED
  run (actor forbidden)** — one CHECK, because a note is not a way to tell them
  apart. The baseline is written only by a run that was not quarantined, or a
  broken feed re-bases its own normal in two passes.
- **`array_length` of an EMPTY array is NULL and a CHECK rejects only FALSE**, so
  `array_length(col,1) >= 1` ADMITS the empty array it exists to refuse.
  Measured twice here; both constraints read `coalesce(array_length(col,1),0)`.
  Any future array-non-emptiness CHECK in this schema must do the same.
- **Discriminated unions in this domain use STRING discriminants**
  (`outcome: 'granted' | 'refused'`), because the backend compiles with
  `strict: false` and without `strictNullChecks` TypeScript does not narrow a
  union on the TRUTHINESS of a boolean-literal discriminant — `if (!x.granted)`
  leaves the caller holding the whole union. #122 sidestepped it by discarding
  one of its two refusal reasons; here the caller must act on the difference.
- **No product availability/price PROJECTION was adopted**, and that is the
  answer to "rebuild the summaries after eligible-offer changes": #61 measured
  the alternative at one million offers and adopted no materialized view, so
  `readProductOfferSummary` derives it live and there is nothing to fall out of
  date. It goes through the SAME `listOffersForComparison` plus `projectOffer`
  the public read uses, so the summary and the list cannot disagree.
- Env: `OFFER_REFRESH_ENABLED` and `OFFER_EXPIRY_SWEEP_ENABLED` (both gate the
  LOOP only; turning the sweep off cannot make a stale offer visible, because
  the verdict is derived at read time) plus the loop tunables and the default
  concurrency and per-minute allowance for a source that states none. Operator
  surface `/internal/offer-freshness/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62 use, and it
  stays mounted while the loops are off.
- **Two migrations**: `0043` (`pre` — five tables, four nullable columns, two
  backfills, the widened retirement-reason CHECK, and the mode CHECKs written to
  tolerate the NULL the serving image leaves) and `0044` (`post` —
  `refresh_mode` NOT NULL, the duplicate collapse, the identity index swap, and
  the retirement-evidence biconditional). Each `post` statement breaks a write
  the previous image performs.
- Deferred with named seams, none of them a stub that lies: **#37** (the
  outbound redirect — this domain supplies `assertOfferOutboundEligible` and
  composes no tracked URL), **#78/#79** (price history and alerts — `alerted` is
  a priority class and `requestPriorityRefresh` is the entry point; "an old
  price cannot fire a new alert" is already true of anything obtained through
  `mayAppearInComparison`), **#77** (popularity), **#74** (ranking — a scanned
  gate both ways), **#63/#66** (still no adapter, so
  every task for those providers dead-letters and says why; **#65** SHIPPED
  one, and its two-phase pass is what a refresh task drives for an eBay
  source), **#86** (dashboards read
  `readSourceCatalogHealth`; scraping belongs to `oxy-infra`).
## The universal product-feed importer (#63)

`services/feed-import/` (19 modules + `parse/`) + `db/feedImport/` +
`db/schema/feedImport.ts` (7 tables) + `services/ingestion/adapters/product-feed.ts`,
plus `/admin/stores/:storeId/feeds/*` and `/internal/feed-imports/*`. Full
reference: **`docs/feed-importer.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The universal feed importer (#63)". This is NOT a
second ingestion pipeline — #62 stays the framework, #58 the matcher, #57 the
offer. What #63 owns is the step nobody did: how a file of somebody else's rows
becomes a `NormalizedSourceRecord`.

- **A delta feed can never claim a completed enumeration, and that is the
  TYPE.** `FeedCompletionVerdict`'s `delta` branch has no `enumeratedFully`
  member, so there is no `if` to get wrong; #62's retirement rule
  (`CATALOG_SOURCE_RETIRING_OUTCOMES`) is fed rather than reimplemented. Three
  things must hold before a completed enumeration is reported — `snapshot` mode,
  the read reached the END, and this is the last page. **A conditional `304 Not
  Modified` is NOT an enumeration**: it is the trap conditional requests
  introduce, and a complete enumeration of zero records retires everything the
  source has. There is deliberately no DEFAULT delivery mode: the wrong answer
  either retires a healthy catalogue or leaves delisted products on sale forever.
- **An object's IDENTITY is frozen, by trigger.**
  `feed_configurations.identity_key_fields` names the merchant's own key columns
  and cannot be UPDATEd — re-keying re-mints every object, retires the catalogue
  behind the old ids, and looks exactly like a seller who replaced their
  catalogue overnight. Re-keying is a NEW configuration. The join is INJECTIVE
  (parts escaped before joining), because a collision there is two of a
  merchant's products sharing one source object.
- **The importer executes NOTHING a feed or a mapping supplies**, four ways: the
  disjoint `FEED_FIELD_TRANSFORMS`/`FEED_FORBIDDEN_TRANSFORM_KINDS` unions
  (`regex_replace` is prohibited — a source-supplied pattern is a small language
  and a DoS primitive); `feed_field_mappings` has `source_field` XOR
  `constant_value` plus a closed `transform` and NO fourth column (a fallback
  chain is a conditional language and is excluded too); `.strict()` schemas
  refuse an undeclared field rather than stripping it; and a scanned gate with a
  mutation self-test covers `eval`, `new Function`, `node:vm` and four template
  engines.
- **Every cap REFUSES rather than truncating.** A truncated feed is a
  complete-LOOKING enumeration over half a catalogue, which retires the other
  half. Decompression bombs are bounded in BOTH dimensions (absolute output AND
  ratio) because either alone is defeatable.
- **Path traversal is unrepresentable.** Only a plain file and a single-member
  gzip are accepted — a gzip member has no entry NAME — and every multi-entry
  container is refused BY NAME from its magic bytes, so renaming `feed.zip`
  changes nothing. The merchant's filename is a LABEL; `storage_key` is CSPRNG
  and is the only thing that reaches the filesystem.
- **A feed URL is a CREDENTIAL** (Awin's download carries the key in the path),
  so `feed_url` sits in `protectedColumns.ts` beside `auth_ciphertext`, every
  projection emits `redactFeedUrl`'s host-only form — including for the store
  that typed it — and `readFeedVersionSecrets` is the ONE reader, with its caller
  list pinned at three by a gate. SSRF is `safeFetch` and nothing hand-rolled,
  HTTPS-only, streamed and bounded.
- **An error report carries no VALUES.** A record INDEX, an issue code, a
  severity, a role and the merchant's own column NAME — they have the file, so
  the index is what they need. The ONE exception is `observed_token`, CHECK-bound
  to the three issue codes whose values come from a closed external vocabulary
  AND to sixteen characters of a restricted alphabet.
- **Validation happens BEFORE normalization and produces a VALUE, never a
  throw.** Only the mapping layer knows which COLUMN a value came from. This is a
  documented divergence from #62 contract case 5 — a file importer refuses an
  invalid row upstream, so the framework has nothing to reject — and the shared
  suite carries `isolatesInvalidRecordsUpstream` for it.
- **One pass, staged once, paged afterwards.** #62's page contract fits an API;
  a file has no page tokens and the dispatcher drives one page per tick, so a
  million-row feed would be eight hours of held HTTP or a thousand
  re-downloads. The first page reads the feed ONCE into a local JSONL stage keyed
  by the feed's own CONTENT DIGEST; a reclaiming task rebuilds it once and
  resumes only if the digest matches, restarting from zero otherwise (safe —
  everything downstream converges on a content hash).
- **Money is read once, in STRING arithmetic** (`Math.round(1.0050 * 100)` is
  100 and 101 is correct), with the both-separators-present / three-trailing-
  digits rules stated and their cost admitted. A currency outside
  `CURRENCY_PRECISION` cannot be converted from major units and is refused BY
  NAME; the escape hatch is `money_minor_units`.
- **Suggestions are DATA**: `suggestFeedFieldMappings` has no writer, so "do not
  apply mappings silently" is the absence of a function. Google Merchant column
  names are ALIASES, never a claim of protocol compatibility.
- Merchant surface behind `channels:write` (a feed is a sales channel's
  inventory arriving by file); the tenant gate is ONE function and answers 404,
  never 403. Operator surface on the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
  allow-list and READ-ONLY — every write belongs to the store that owns the feed,
  and pausing a source already exists on `/internal/ingestion`. Two rate-limit
  buckets, the smaller one for the four routes that fetch. The upload route has
  NO body parser (`express.raw` buffers) and refuses a JSON content type, because
  the global parser would have consumed the stream and left an empty feed.
- Env: `FEED_IMPORT_ENABLED` (gates the adapter registration and the merchant
  MOUNT, never a durable record; requires `FEED_IMPORT_AUTH_ENCRYPTION_KEY` — its
  own key, separate from the connector and guest ones) plus nine refusal
  thresholds. Raise `CATALOG_INGESTION_LEASE_MS` above the largest feed's stage
  build: the stage is built inside one page.
- **#63 surfaced and fixed TWO #62 bugs the fixture adapter could not show**,
  both because its records carry a fixed date in the past. (1) The pipeline
  stamped "seen at" from the dispatcher TICK's clock while `observedAt` comes
  from the adapter's own read — so `observedAt > now` for every real adapter, and
  `catalog_source_objects_seen_order_check` / `offers_confirmed_order_check`
  failed on the FIRST observation of every object, silently, as a per-record
  `parse_failure`: a feed would ingest NOTHING and report a clean run. Fixed with
  `max(now, observedAt)` — and it has to be stated in **TWO** places, which is
  the part worth remembering: #68 split the page loop so the OBJECT is persisted
  per record (`persistOneRecord`) and the OFFER is materialised per PAGE
  (`advanceObject` → `recordExternalOffer`), so the two writes no longer share a
  clock. Fixing only the record half leaves every external offer failing
  `offers_confirmed_order_check`, which is exactly how the second site was found
  — on the rebase behind #68, with the first fix already in. (2)
  `match_policy_versions_active_key` is GLOBAL, so a THIRD claimant made the slot
  contention fatal — a file inserting a decision whose policy another file had
  just deleted, and a wait outliving vitest's per-test timeout, both landing on a
  file that did nothing wrong. Fixed with a real mutex
  (`services/ingestion/__tests__/active-policy-slot.ts`): a session-level
  Postgres ADVISORY LOCK on a RESERVED connection, held for the file's whole run
  — session-level because a file holds the slot across many tests, reserved
  because a pooled connection returned between statements carries the lock away.
  BORROWING whichever policy was active was tried first and is wrong: the
  borrower's decisions reference a row the owner deletes at its own teardown.
- **What a feed TRANSPORT can do is not what one configured feed MEANS**, and
  #68's `refreshModes` is where the two meet. The adapter declares
  `['full_snapshot', 'incremental']` — one static declaration serving both a
  snapshot and a delta feed, narrowed per source by the policy's
  `permitted_refresh_modes`, because "this URL publishes deltas" is a fact about
  that publisher rather than about reading a CSV. Declaring `full_snapshot` is
  NOT what authorises retiring an omitted record: `complete` is, and it comes
  from the version's own `FeedCompletionVerdict`, so a delta feed handed a
  `full_snapshot` run by a misconfigured policy still reports an incomplete pass.
  Neither `targeted` nor `query_driven` is declared — a feed is one file at one
  URL, with no call that re-reads a named list of ids. A MANUAL sync reads the
  active version's delivery mode to name its mode (`manualRefreshModeFor`) and
  REFUSES when there is no active version, rather than defaulting to the one
  mode that can retire a catalogue.
- **The reusable contract another adapter calls is written down**, module by
  module, in `docs/feed-importer.md` §"The reusable contract another adapter
  calls" — there is no barrel, because the house rule is to import from the
  owning module. `bytes.ts` (`boundedBytes` / `decompressBytes` / `decodeText`),
  `parse/index.ts` (`streamFeedRecords`) and `mapping.ts` (`mapFeedRecord`) are
  PURE: an `AsyncIterable`, a plain options object, a plain mapping, no
  database. `ResolvedFeedMapping` holds no row id, so #66 builds one IN MEMORY
  from an advertiser's declared columns and never touches #63's tables — while
  `resolve.ts`, `configuration.service.ts`, `report.service.ts` and
  `preview.service.ts` are the parts it must NOT reuse, because they read a
  merchant-facing configuration an Awin advertiser has no row in.
- Deferred with named seams: **#66** (Awin — the contract above), **#65** (eBay,
  an API), **#37** (the outbound redirect — `affiliate_url` is mapped and
  stored, nothing composes a
  tracked URL), **#59**, **#68**, durable upload storage (an upload lives on one
  task's disk and `feed_uploads.status='missing'` is a real state), and the
  dashboard mapping screens (every endpoint they need exists).
## The eBay Browse catalog source (#65, selected by #64)

`services/ebay/` (11 modules) + `services/ingestion/adapters/ebay.ts` +
`db/ebay/` (4 repositories) + `db/schema/ebay.ts` (3 tables), plus
`marketplace_seller_identities` and `catalog_source_configs.seller_identity` in
the ingestion framework, and `/internal/ebay/*`. Full reference:
**`docs/catalog-sources/ebay-browse.md`**; the provider facts are #64's
(`docs/catalog-sources/2026-08-09-launch-sources.md`, binding); schema decisions:
`db/schema/CONVENTIONS.md` §"The eBay Browse source". It implements #62's
adapter contract, matches through #58 and offers through #57, and adds no schema
fork to any of them.

The failure mode that shapes it: **a search API is not a catalogue, and treating
one as the other retires a healthy catalogue.**

- **A DISCOVERY sweep may never claim a complete enumeration, and that is the
  whole design.** eBay grants search-driven discovery and refuses an `offset`
  past 10,000 — so a sweep of a 40,000-item category has provably not seen
  30,000 of them, and an item can be public and simply not in this week's
  results. Reporting `complete` from one would mass-expire everything below the
  depth cut on the first sweep after a category grew. A pass is therefore
  DISCOVERY then VERIFICATION, and only verification — which asks eBay about
  every tracked item BY ID, and is the only thing that establishes the API
  License Agreement's "no longer publicly available" deletion trigger — may
  complete. `mayClaimCompleteEnumeration` states the conjunction once (verify
  phase, cohort exhausted, nothing truncated, not incremental) so no caller can
  assemble a weaker one, and every failure mode lands on `false`.
- **THREE identities, mapped as three things** (acceptance 2). The marketplace
  OPERATOR is the merchant bound to the source, the STOREFRONT is the bound
  channel it operates, and the SELLER is `seller.username` per item.
  ADR 0002 D8 derives marketplace-ness by comparing the offer's merchant against
  the storefront's operator, so twenty sellers of one product produce twenty
  offers under one canonical variant (`offers.commercial_key`). Binding one
  merchant to an eBay source instead is not a coarser truth, it is a false one.
- **`catalog_source_configs.seller_identity` is the opt-in, and it is what keeps
  #62's write boundary intact.** `source_bound` is the default and every
  pre-#65 source behaves exactly as before; `per_record` is an OPERATOR
  asserting that this provider publishes a stable per-item seller identity. An
  adapter still cannot name a merchant — it supplies `merchantHint`, which #62
  already defines as a hint that resolves nothing — and the merchant lands in
  `marketplace_seller_identities`, keyed `(provider, external_seller_id)` so one
  eBay username is one merchant across every marketplace. A minted seller is
  `unclaimed`, provider-namespaced, and grants no relationship, no store link
  and no native checkout (a scanned gate). An item naming NO seller produces no
  offer — falling back to the bound merchant would attribute the sale to eBay.
- **Mercaria never composes or mutates an EPN link.** The outbound destination
  is a two-branch union and BOTH branches carry a URL out of a response body;
  `EBAY_FORBIDDEN_LINK_OPERATIONS` states the prohibition as a value, disjoint
  from the destination kinds by a gate, and `ebay-isolation.test.ts` scans for
  item-host URL construction, campaign parameters and parameter surgery with a
  mutation self-test. The reason is commercial: attribution lives entirely in
  eBay's own parameters, and a rebuilt link is indistinguishable from a working
  one until a month of revenue is missing. **Approval loss has exactly one
  detector** — a page that requested attribution and got none on EVERY item —
  because an unattributed link is a perfectly good link and fails nowhere else.
  It reports rather than throws.
- **The condition carried to #90 is the `conditionId`, never the display name**,
  which is localized ("Used" on GB, "Usado" on ES for the identical `3000`). A
  ruleset keyed on display text needs one rule per language and answers
  `unmapped` for every market nobody wrote rules for. `#65` WIDENED
  `condition_mapping_rulesets.provider` from `CONNECTOR_PROVIDER_IDS` to
  `CONDITION_MAPPING_PROVIDER_IDS`, a strict superset, so every existing
  ruleset, rule and offer keeps its provider. The eBay ruleset is a
  RECOMMENDATION an operator publishes (`EBAY_RECOMMENDED_CONDITION_RULES`), not
  a migration: a ruleset written by a migration is a policy nobody signed. Until
  it is published every eBay offer is `unmapped` with its id preserved.
- **The call budget is keyed on the CREDENTIAL and the UTC day, never on the
  source.** eBay meters 5,000 calls/day against the KEYSET and Mercaria runs one
  source per marketplace, so a per-source budget would draw 25,000 against a
  5,000-call agreement. The reservation is one conditional `UPDATE` whose empty
  `RETURNING` set IS the refusal, with a CHECK stating the same bound at the row;
  refusals are counted beside grants, because `calls_used` alone cannot tell a
  quiet day from a day spent refusing everything. A budget refusal TRUNCATES the
  pass rather than failing it — eBay is fine, Mercaria spent its allowance — and
  truncation is what makes the completeness claim refuse.
- **The access token is never written down.** Minted per process, held in memory,
  dies with the task; a scanned gate fails the build if any module learns to
  persist one. A two-hour bearer credential in a table is a row that grants API
  access on eBay's side, in something with backups and replicas, to save one call
  every two hours.
- **Two switches, deliberately not the same lever.** `EBAY_FETCH_ENABLED` is the
  hard fetch kill switch — deployment-wide, answered as a RETRYABLE outage so the
  run is RELEASED with its cursor intact, no health moved and nothing retired,
  resuming from the same page when flipped back. The DISPLAY switch is
  `may_display` on the source's own #62 rights policy: versioned, per source,
  reviewed. An env var for display would be a second answer to what
  `catalog_source_policies` already answers. `EBAY_MARKETS` is an ALLOW-list
  defaulting to `EBAY_ES` alone, unlike ADR 0006's block lists, because it is a
  ROLLOUT cohort and the default has to be the smallest set.
- **The error taxonomy reads the STATUS first and the `errorId` second**, for two
  distinctions the status cannot make: a quota refusal wearing a 403 is a
  `rate_limit` (reading it as auth would page somebody about a working
  credential), and an expired token wearing a 400 is a RETRYABLE `auth_failure`
  (the next attempt mints a fresh one). A real 401/403 is NOT retryable — that is
  "stop safely": a revoked keyset answers identically every time, and #62 marks
  the source `failed` and retires nothing.
- **Reconciliation detects and repairs nothing** (`payment_discrepancies`
  posture), samples RANDOMLY (taking the first N re-checks one corner forever and
  reports it as a fact about all of it), and spends the same budget everything
  else does.
- **#65 does NOT call `describeCatalogSourceAdapterContract`**, and the reason is
  a property of eBay: the shared suite asserts exact `fetch_count`/`fetched`
  counters, which assume one framework page is one provider call (an eBay pass is
  two phases by design), and asserts a provider-published `sourceUpdatedAt`,
  which the Browse API does not publish for an item. Satisfying the second would
  mean INVENTING a provider timestamp. `services/ebay/__tests__/ebay-ingestion.realdb.test.ts`
  covers all thirteen concerns case by case under the same headings, against the
  same tables, through the REAL adapter over a fake transport.
- Env: `EBAY_ENABLED` (default false — registers the adapter at all),
  `EBAY_FETCH_ENABLED`, `EBAY_ENVIRONMENT` (anything unrecognised is `sandbox`,
  never `production` — a production keyset pointed at sandbox would quietly
  ingest eBay's TEST catalogue), `EBAY_MARKETS`, `EPN_CAMPAIGN_ID`,
  `EBAY_DAILY_CALL_LIMIT`, `EBAY_RECONCILIATION_SAMPLE_SIZE`. Operator surface
  `/internal/ebay/*` behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list,
  mounted while both switches are off — reading the budget is what somebody does
  after flipping the kill switch.
- **Two framework bugs #65's realdb suite caught, both fixed in `ingest.service.ts`
  and neither visible to a mocked test.** (1) A page's `now` is captured BEFORE
  the adapter runs, so any adapter stamping the REAL read instant produced
  `observed_at > now` and violated `catalog_source_objects_seen_order_check` and
  `offers_confirmed_order_check` on EVERY record — the fixture adapter never
  exposed it because it stamps a fixed instant in the past. The record's
  `observedAt` is now clamped to the page clock, in one place, so an earlier
  observation is preserved exactly and only the physically impossible direction
  is capped. (2) A record counted as `stored` that then failed while matching was
  ALSO counted as `rejected`, which `catalog_source_runs_intake_total_check`
  refuses — taking the whole page's bookkeeping with it. A post-intake failure is
  now isolated and logged; the object stays `observed` and the next pass retries.
- **`ebay-ingestion.realdb.test.ts` was a FOURTH claimant of the global
  active-matching-policy slot that did not take the lock — FIXED by #66 (#215),
  and the lesson is that the slot is about who may MATCH, not who may INSERT a
  policy row.** `match_policy_versions_active_key` is a partial unique with no
  scoping column (ONE active policy in the whole database, correct for
  production), so every realdb file needing one queues on #63's
  `acquireActivePolicySlot` advisory lock. #65 shipped before that mutex existed
  and kept a bounded retry loop instead; a retry loop is not a smaller lock,
  because each retry is a failing INSERT — an aborted transaction — against the
  small pool the holder needs in order to finish and release. The hold must
  cover the whole FILE, not just the matching `describe`: every ingesting test
  calls `runMatch`, which reads whichever policy is globally ACTIVE, so outside
  the window this file's `match_decisions` cite a SIBLING's policy and that
  sibling deletes it in its own teardown. Still REJECTED, for the original
  reason: borrowing whichever policy is already active, which makes a file's
  outcomes depend on which sibling ran first. Also measured and worse than
  either: `ALTER TABLE … DISABLE TRIGGER` to free the slot takes a
  **ShareRowExclusive** lock (NOT `ACCESS EXCLUSIVE` — corrected under #301,
  measured off a real `pg_locks` wait and off CI's own `40P01` detail) on a
  table every match writes, so it queues behind writers. `ShareRowExclusive`
  does **not** conflict with `AccessShare`, so a plain `runMatch` READ is not
  what it blocks and never was; **the counterparty is an ordinary
  INSERT/UPDATE/DELETE**, which is why the mutex — which serialises window
  against window — cannot prevent it. **The failures are harness-dependent** —
  reproducible locally on several worker counts, and NOT reproduced on GitHub's
  runner, whose scheduling differs; the defect is a fixture skipping a queue its
  three siblings use, which is worth fixing whether or not CI happens to expose
  it. A latent hazard remains and is nobody's bug today:
  `adapter-contract-suite.ts` deletes its policy only when no decision cites it
  and otherwise releases the lock with an `active` row still standing. It is
  unreachable while every claimant holds the slot file-wide, so it was
  deliberately NOT patched — a fix for a state nobody can trigger, in a file
  three adapters share, is how a later reader loses track of which guard is
  load-bearing.
- **#68 LANDED while this was in review; the division of labour holds and #65
  CONSUMES its removal channel rather than growing an eBay-specific one.** #68
  owns WHEN a source is re-read and how long an offer is worth showing; #65 owns
  what an eBay pass DOES and what it may conclude. A refresh task drives the
  same discovery-then-verification pass and the freshness verdict is derived at
  read time against the source's own policy, so the completeness rule does not
  move. Refresh SCHEDULING is no longer owed.
- **The deletion obligation has TWO channels and `ebayGetItems` splits them at
  the point they are read.** `removedIds` is eBay NAMING an item in a not-found
  warning (`errorId` 11006) inside an otherwise successful 200 — a POSITIVE
  STATEMENT, emitted as a #68 `AdapterRemoval`, which `applyExplicitRemovals`
  retires from ANY run including a targeted refresh of one id
  (`retirement_kind = 'explicit_removal'`, offer reason `source_unavailable`).
  `unansweredIds` is mere ABSENCE from `items` — a truncated response, a
  marketplace restriction, a bad minute — which retires NOTHING and waits for
  the ordinary completeness rule (`snapshot_omission` / `source_disappeared`).
  So the obligation is dischargeable for an item somebody re-read today instead
  of at the end of the next full sweep. Collapsing the two is the mass-expiry
  failure this source is shaped around, and it is mutation-tested: feeding the
  unanswered set into the removals turns TWO realdb cases red, one of them the
  pre-existing complete-pass retirement test. The narrow read is also the
  SAFE-failing one — `readNotFoundIds` degrades to "no positive statement" on
  any warning shape it does not recognise, which delays a retirement and can
  never cause one, which is what makes shipping it against an envelope shape no
  approved keyset has confirmed acceptable. Both sets still feed the
  reconciliation sample as `vanished`, because that report repairs nothing and
  the distinction only matters where it decides a retirement.
- **This domain defines no TTL, no staleness rule, no outage grace and no
  retirement decision, and that is a scanned gate** (the sixth wall in
  `ebay-isolation.test.ts`, with a vacuity floor and a mutation self-test).
  #68's per-source policy and #62's `CATALOG_SOURCE_RETIRING_OUTCOMES` are the
  single authorities. The gate exists because the tempting bug is a LOCAL one:
  this domain knows eBay prices move hourly, so a private `EBAY_OFFER_TTL_SECONDS`
  or an `isStale(offer)` helper reads as diligence rather than as a second
  authority — and a second TTL does not announce itself, it silently wins
  wherever it is consulted. The ONE lifetime #65 legitimately owns is the OAuth
  access token's in `token.ts`, a CREDENTIAL's expiry rather than content
  freshness, and the gate's allowance is narrowed to that file rather than to a
  pattern anyone could reuse.
- Deferred with named seams: #37 (the outbound redirect — routing metadata is
  modelled and `destination_url` stays the ORIGINAL), #74
  (ranking, a scanned gate), #59 (review of an ambiguous match), #60 (minting
  what a `create_new` recommends), per-seller eBay STOREFRONTS, and #94's
  attribute registry (eBay's aspects are localized in both name and value, so
  they are carried as option assignments for #58 to score and are not claimed as
  registry values, which need a stable key and a unit).

## The Awin retailer-network source (#66, source selected by #64)

`services/awin/` (13 modules) + `db/awin/` (6 repositories) +
`db/schema/awin.ts` (6 tables) + `services/ingestion/adapters/awin-feed.ts` +
`/internal/awin/*`. Per-advertiser product feeds from the Awin affiliate
network. Full reference: **`docs/catalog-sources/awin.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The Awin retailer-network source"; the source
selection is `docs/catalog-sources/2026-08-09-launch-sources.md`, which is
binding. #62 stays the framework, #63 stays the parser, #57 the offer, #58 the
matcher, #68 freshness — nothing here is a second copy of any of them.

- **ONE Awin advertiser is ONE `catalog_sources` row.** Not one source called
  "Awin", and every other decision follows from it: a malformed advertiser feed
  fails ITS run with no shared enumeration to make incomplete; each retailer is
  a distinct merchant AND storefront because the binding is per source; the
  kill switch, rights withdrawal, freshness TTL, cadence and territories are all
  things #62/#68 already do PER SOURCE; and advertiser health and NETWORK health
  become separately observable, which they could not be otherwise. The cost is
  fifty registry rows and fifty rights policies for fifty advertisers — which is
  the correct amount of work, because each IS a separate commercial
  relationship.
- **The tracking link is ADMITTED by a closed host set, never sanitised.**
  `AWIN_TRACKING_HOSTS` is a code constant (a configurable set would make "which
  hosts may Mercaria redirect to" answerable per deployment and per row, which
  is the shape an open redirect takes), compared EXACTLY against a parsed
  `hostname` — a suffix test admits `awin1.com.evil.example`. Mercaria never
  CONSTRUCTS a tracked URL: attribution belongs to the link (#64 §6), and
  composing one would assert a contract nobody read.
- **There is NO second derivation of the offer's kind.** #62's `offerKindFor`
  already derives `affiliate | external | informational` from the rights and the
  source kind. #66 answers only the narrower question #62 cannot see — may
  Mercaria hand the tracking URL over at all — and applies the answer by
  WITHHOLDING it, so #62's `affiliate_params`-absent branch produces the right
  offer with no new mechanism and nothing that could disagree. The assessment is
  taken twice and stored NEITHER time (once for the measurement, once as each
  record leaves the adapter): a verdict carried across a staged pass can outlive
  a rights withdrawal, and the function is pure so the two cannot disagree.
- **A feed can never establish a brand relationship** (adapter rule 7). The
  adapter emits `brandHint`, which resolves nothing; #55's
  `SUFFICIENT_EVIDENCE_KINDS` excludes everything a feed can supply; and
  `awin-isolation.test.ts` fails the build if any module here reaches the
  relationship layer, with `AWIN_FORBIDDEN_ADVERTISER_CLAIMS` naming the five
  claims as VALUES disjoint from every vocabulary this domain records.
- **The network budget binds the FLEET and is keyed on the ACCOUNT.**
  `awin_network_leases` duplicates #68's `catalog_source_refresh_leases` on
  purpose: #68's is keyed on `source_id`, so with one source per advertiser it
  bounds each advertiser separately and the network not at all — fifty
  advertisers at twenty calls a minute each is a thousand at one host under one
  key. Both are claimed; they answer different questions. Awin's published
  Publisher API limit (20/min) is a NETWORK limit, so this is what enforces it
  and #67's transaction poll joins the same budget.
- **What Awin SAYS and what Mercaria DECIDED are different columns, with
  different writers.** `membership_status` (`not_joined | pending | joined |
  declined | suspended | left`) versus `activation` (`candidate → sampling →
  active`, plus `paused` and `closed`). Collapsing them makes "Awin suspended
  us" indistinguishable from "we paused them". Only `joined` is commissionable.
- **An unreadable feed-list row is SEEN, not skipped**, and the alternative is
  silently destructive: closure is inferred from ABSENCE, so dropping a row
  whose membership word Awin added last week would close a live programme and
  retire its catalogue. `AwinFeedListEntry` has two branches and both carry the
  ids; only the understood one applies a membership. Defaulting to `not_joined`
  would be worse — it is a real state Awin also reports.
- **An advertiser cannot reach `active` without a PASSED sample** (quality
  control 4) — a CHECK, plus a service that reads the NEWEST sample, so a
  regression cannot be activated over stale evidence. Resuming a `paused`
  advertiser goes back to `sampling`, never straight to `active`. There is no
  "activate anyway" parameter.
- **The mapping is built over the columns Mercaria REQUESTS, not the ones a
  header row carried** — the mapping is needed before the first record is read
  and reading a record to discover the header is circular. What varies per
  advertiser is MEASURED (`declaredColumns`, `awin_advertiser_quality`) rather
  than configured, which is #64 §6's "never fabricate absent identifiers".
  Identity is `aw_product_id`, a code CONSTANT: a per-feed column would be a
  configuration surface for the one decision that re-mints and retires an entire
  catalogue.
- **A pass that scanned rows and mapped NONE of them is refused**
  (`no_records_mapped`, added to #63's closed refusal set, classified
  `schema_drift`). An EMPTY feed is deliberately different — `scanned = 0` is a
  catalogue with nothing in it, which a complete enumeration may report and
  which legitimately retires everything.
- **#63 was EXTENDED, never forked**, in exactly two places, both generic:
  `BuildStageInput.observe` (watch each record as it is mapped, in the ONE pass
  that reads the feed — returns `void`, the `recordAnalyticsEvent` device, so a
  slow observer cannot join the critical path) and the `no_records_mapped`
  refusal reason. Everything else is CALLED: `buildFeedStage`,
  `readFeedStagePage`, `feedCompletionVerdict`, `mayReportCompleteEnumeration`,
  `openFeedStream`, `FeedImportRefusal`. #63's CONFIGURATION surface
  (`resolve.ts`, `configuration.service.ts`, `report.service.ts`,
  `preview.service.ts`) is NOT reused — a scanned gate — because it reads a
  merchant-facing table an Awin advertiser has no row in.
- **A circular foreign key is silently dropped by `drizzle-kit generate`.**
  Measured here: `awin_advertisers.activating_sample_id` written as
  `references((): AnyPgColumn => awinLinkSamples.id)` produced NO
  `ADD CONSTRAINT` in the migration AND no entry in the snapshot, so the
  declaration type-checked, enforced nothing, and left a later generation free
  to emit it out of nowhere. Reverted to a plain column with the reason recorded
  in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. **Verify any circular FK against the
  GENERATED SQL, never against the declaration.**
- Env: `AWIN_ENABLED` (gates the adapter registration only; accounts,
  advertisers, feeds, quality snapshots, samples and every #62 row are stored
  either way and turning it on drains the backlog), `AWIN_FEED_LIST_BASE_URL`,
  `AWIN_PUBLISHER_API_BASE_URL`, `AWIN_NETWORK_CONCURRENCY`,
  `AWIN_NETWORK_CALLS_PER_MINUTE`, `AWIN_NETWORK_LEASE_MS`,
  `AWIN_LIST_TIMEOUT_MS`, `AWIN_SAMPLE_SIZE`. It demands NO credential up front,
  unlike `FEED_IMPORT_ENABLED`: Awin's key is a LOCATOR on a row, so a
  configuration is storable and reviewable with none present and an unconfigured
  deployment gets an honest `auth_failure` naming the missing secret. Operator
  surface `/internal/awin/*` on the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
  allow-list, mounted while `AWIN_ENABLED` is off.
- Deferred, each a named contract that fails closed: **#67** (the outbound
  redirect and commission reconciliation — the deep link is validated, stored
  unmodified and never composed into a Mercaria URL; the ≤31-day window chunker
  and the network budget are supplied and NOTHING calls the transactions
  endpoint, so the seam fails closed by ABSENCE), **#59** (duplicate GTINs,
  `create_new` and ambiguous matches all route to #58's queue), **#74**
  (ranking — a scanned gate), **#65** (independent; convergence between the two
  is exercised generically rather than waiting for it), **#84** (native-store
  linkage), and the re-import sweep an `AWIN_MAPPING_VERSION` bump schedules.

## Connector verification: the contract suite, and what it deliberately cannot prove (#69)

`connectors/__tests__/connector-contract-suite.ts` + `contract-world.ts`, run by
`shopify/__tests__/shopify-contract.test.ts` and
`woocommerce/__tests__/woocommerce-contract.test.ts`, plus
`services/__tests__/channel-push-contract.realdb.test.ts` and
`connector-queue-boundary.test.ts`. Full procedure for the part that stays
manual: **`docs/runbooks/connector-real-store-verification.md`**.

The failure mode that shapes it: **the nine pre-existing connector suites mock
the PROVIDER**, so between `connector-sync.service` and the wire there was
nothing under test at all — a URL never built, a `Link` header never followed, a
429 never retried, a zod schema that rejects the platform's real shape and a
CHECK the database would have refused all looked identical to a green suite.

- **Only the SOCKET is faked, and the boundary is stated rather than implied.**
  The provider is built by its own real factory (`createShopifyProvider`,
  `createWooCommerceProvider`) over a transport serving a `ContractWorld`; for
  Shopify the SHIPPED rate-limit wrapper sits in between with its clock and sleep
  stubbed, so the retry under test is the production one. Everything else —
  service, catalog-write funnels, inventory, Postgres with every CHECK and unique
  index — is real. **A `ContractWorld` is not a store and cannot testify about
  one**; the runbook carries what only a real platform can settle.
- **Capabilities are DECLARED and a missing one is MEASURED, never skipped.**
  WooCommerce has no product push, no fulfillment push and no 429 handling; each
  gated case asserts the REFUSAL on that branch, so a provider that silently lost
  a feature cannot report the same green as one that never had it.
- **`getConnectorProvider` is the ONE thing mocked, and the registry deliberately
  stays a module-level constant.** Connectors are static, unlike ingestion
  adapters (which a flag registers at boot), so adding a mutable
  `registerConnectorProvider` would put a production seam in place purely for a
  test's convenience.
- **The catalogue is NAMESPACED per world, and SKUs are not part of it.**
  `contractCatalogue(namespace)` is the only way to build one, and it namespaces
  the PLATFORM-SIDE ids — product, variant, inventory item, order — because those
  are what a row is looked up by. SKUs were namespaced too until #296, purely
  because `product_variants_sku_key` was table-wide; with that index gone nothing
  reads a variant by SKU except a listing-scoped query, so the namespacing was
  removed rather than left as a rule with no reason. The evidence it tracked the
  INDEX and not a cross-case read is `barcode`, which was never namespaced at all
  under an equally table-wide unique and went unnoticed because WooCommerce
  publishes none.
- **The fault schedule is mutation-tested by the suite itself.** Every "archives
  nothing" case rests on a fault actually reaching the provider; a fault matching
  no URL would make each of them pass by measuring a healthy run. The Shopify
  runner asserts a fault fires exactly N times, is consumed, and stops.
- **Cleanup order is load-bearing**: `listings.store_id`, `orders.store_id` and
  both `source_connection_id` columns are `ON DELETE RESTRICT` — deliberately, so
  a live connection cannot be dropped out from under the provenance pointing at
  it — so a fixture deletes orders, then listings, then the connection, then the
  store.
- **The plugin-push suite scans response BYTES for the minted key**, not the DTO
  shape: a shape assertion covers the fields somebody remembered, and the
  positive control (the public prefix IS present) is what stops the scan passing
  against an endpoint returning nothing.
- **Acceptance 4 is split honestly.** `connector-queue-boundary.test.ts` pins the
  half Mercaria owns — every `request*` entry point validates synchronously and
  then ENQUEUES, while `runBackfill`/`syncOrders`/`syncInventory` are the worker
  bodies beside them. The producers are mocked because their INLINE FALLBACK is
  the thing under test: with the real producer and no Redis, "enqueued" and "ran
  inline" are indistinguishable.
- **Acceptance criterion 7 is NOT met and `HANDOFF.md` still says so.** No
  Shopify store, no WooCommerce site and no WordPress plugin install has been
  exercised; nothing here may be read as evidence that one has.
- Four defects found while building it were filed (#218, #219, #220, #221)
  rather than fixed there, and fixing #218 turned up a FIFTH (#262). All five
  are now fixed. **#218 is FIXED:** `registerWebhooks` returns a
  structured result (every subscription that exists, every topic REFUSED with its
  status and a classified reason), reconciles against the platform's OWN
  subscription list before creating anything — ADOPTING on Shopify, RECREATING on
  WooCommerce, where the secret is fixed at creation and never disclosed again —
  and `registerConnectionWebhooks` persists the ids, the secret and the refusals
  in ONE transaction. So a partial registration is disconnectable, retryable
  without duplicating anything, converges a shop already carrying orphans, and
  NAMES the events that will not arrive (`Connection.webhookFailures`, plus a
  `degraded` catalogue axis on `ChannelReadiness`). `SHOPIFY_SCOPES` now defaults
  to the full runbook §3.2 string, gated by `shopify-scopes.test.ts` against both
  the registered topics and the endpoints each declared capability calls — the
  old `['read_products']` default WAS the configuration that triggered it.
  **#262 supplied the trigger the "retryable" above assumes.**
  `registerConnectionWebhooks` had two call sites, both on connect, so
  "retryable" meant a person re-authorizing. There is now a 15-minute sweep over
  a DERIVED population — refused topics whose reason a retry could fix, or an
  empty `webhook_ids`, which is the only trace a registration that THREW leaves —
  plus `POST /admin/stores/:storeId/channels/:connectionId/webhooks/reregister`
  behind `channels:write`, which stays available while the sweep is off.
  `CONNECTOR_WEBHOOK_REREGISTRATION_ENABLED` defaults ON: it gates the LOOP, and
  the catalogue reconcile beside it calls the same platforms every six hours with
  no lever at all. A re-registration REUSES the stored secret — Mercaria has no
  previous-secret grace for a connection, so minting would 401 every delivery
  already queued. `permission_denied` and `topic_not_supported` dead-letter on
  the FIRST attempt; everything else backs off, capped, over twelve. **The sweep
  does NOT make #218's shared-address disconnect guard redundant** — a sibling
  whose live subscriptions were deleted has complete stored ids and no refusal,
  so the derived population is blind to it by construction. The merchant surface
  is `WebhookHealth` on the channel screen, and it renders even when nothing is
  refused, deliberately: that same invisible state shows no symptom, so a control
  appearing only on a recorded failure could never be pressed for it.
  **`webhookRegistration` is the authority on whether Mercaria is still trying
  and `webhookFailures` is a separate fact about which topics were refused — a
  surface keying on the refusal list FIRST renders a dead-lettered channel as
  healthy**, because a registration that throws is caught before
  `recordConnectionWebhookRegistration` and writes no per-topic row at all. That
  is pinned by a test, so teaching the throw path to record fails the build.
  **#219 is FIXED:** `createWooCommerceTransport` retries a 429 (`Retry-After`
  capped at 30s per wait, else an equal-jitter backoff, bounded by a 60s total
  budget and five retries) on every method including the registration POST, and
  the 429 still surfaces afterwards so a rate-limited run fails as before and
  archives nothing. Shopify's proactive self-throttle was deliberately NOT
  ported — WordPress publishes no leaky-bucket header, and `no_rate_limit_retry`
  became a CAPABILITY-derived channel limitation rather than a hardcoded defect.
  **#220 is FIXED:** the webhook path COMPLETES a delivery before normalizing
  (`expandWebhookProduct` — a no-op on Shopify, a `GET /products/{id}/variations`
  on WooCommerce, so `normalizeProduct` stays pure and synchronous), the pure
  normalizer REFUSES a payload declaring variations it does not carry rather than
  collapsing it, and `convergeVariants` CREATES a variant the platform added — so
  an earlier collapse self-heals on the next sync instead of being permanent. A
  variant the platform REMOVED is unsold (stock zero, tracking on) and never
  deleted, because a variant id cascades into carts, saves, offers and the
  canonical links. **#221 is FIXED**, and the fix is four things rather than
  one. (1) An imported listing's four `source_*` columns, its `draft`/`active`
  status and its VARIANTS' four `source_*` columns are all arguments to
  `createStoreProduct`, written by `insertStoreProductWithin` — the store-product
  mirror of `insertP2PListingWithin`, carrying the same two rulings: the variant
  insert belongs INSIDE (a listing with no variant is not a state anything should
  observe, and `convergeVariants` returns early on one, so nothing repairs it)
  and `syncListingFacets` stays OUTSIDE (its outbox work must survive
  independently). `stampVariantSources` is GONE; `stampVariantSource` stays for
  #220's convergence. (2) `listings_store_id_source_key_idx` is UNIQUE
  (migration `0070`, `post`), because the read-then-create the service performs
  was a real race two deliveries could both win; the loser converges by
  RE-READING and taking the update branch, matched by CONSTRAINT NAME so a
  `listings_store_id_handle_key` collision still surfaces as the merchant
  conflict it is — NAMED since #292, carrying the incumbent listing and the
  connection holding the handle. (3) `connectors/timestamps.ts` appends `Z` only to a value
  carrying NO zone, then omits what is still unreadable — omitting a
  legitimately-zoned value would ERASE the stored freshness, because
  `buildSource` writes `?? null` on every sync. (4) Shopify's `fx_rate_as_of` is
  VALIDATED and kept verbatim rather than rewritten.
- **A per-record sync failure has a DURABLE reason (#303), and the summary is
  not the reason.** A run is `failed` only when NOTHING succeeded, so the
  commonest shape — mostly successful, a handful refused — records `completed`.
  #294 gave that run a summary in `sync_runs.error`, elided at three reasons with
  three ids each; `sync_run_record_failures` is the per-record residual behind it
  (`catalog_source_rejections`' argument one domain over), carrying the subject
  KIND, the external id, a classified reason code and a bounded detail. Both are
  composed from ONE input by ONE classifier (`classifyMerchantFacingFailure`,
  which `merchantFacingFailureMessage` now delegates to) inside ONE transaction
  with the close, so the at-a-glance line and the full list cannot disagree, and
  a raw driver statement can no more reach a row than it can reach that column
  (#292). **`sync_runs.error` is NOT widened further** — one column for a whole
  run. **`subject_type` is stored, not derived from `sync_runs.kind`**: that
  column says `inventory_sync` for both the pull (an inventory ITEM) and the push
  (a PRODUCT), so a derivation is silently wrong on one of them. **`ordinal` is
  stored because both halves of `(created_at, id)` are degenerate here** — one
  multi-row insert shares an instant and uuid v7 is not monotonic within a
  millisecond, so the read came back SHUFFLED and paging was unstable; the
  `(run_id, ordinal)` unique then forces the writer to REPLACE a run's rows,
  which is what makes closing a run twice converge instead of throwing 23505.
  Retention is 30 days — the only `connectors.ts` table bounded by TRAFFIC — and
  expiry costs the DETAIL, never the tally or the summary. `syncOrders` and
  `syncInventory` were still recording nothing per record until #303.
- **A change of DELIVERY BASE URL is what #262's derived population cannot see,
  and #295 closes it with a READ rather than a wider query.** `webhook_ids` is
  full and nothing was refused, so no derivation over Mercaria's own rows can
  find a shop whose subscriptions the platform disabled — WooCommerce disables
  one itself past five failed deliveries (`class-wc-webhook.php`
  `failed_delivery()`), and they stay disabled once the address is fixed. It is
  quiet in BOTH directions: the REGISTRATION succeeded, so `webhookFailures` is
  empty, and what failed was DELIVERY, days later, on the platform's side.
  - **ADOPTION: `reconcileWebhookSubscriptions` takes `ownedSubscriptionIds` —
    the already-stored `webhook_ids` — as a second, disjoint ownership channel
    used for REMOVAL only.** The delivery URL answers "is this live at the
    address we serve" and cannot answer "did we create it", and after the base
    moves those stop being the same question. A displaced subscription is
    deleted BEFORE any topic is created (so "no second set" is true at every
    instant) and NEVER adopted on either reconcile mode — adopting one satisfies
    a topic with something that delivers nowhere and reports a healthy channel
    forever. Its removal is BEST-EFFORT, unlike the delete before a recreate: it
    cannot double-deliver, so a platform that will not remove it must not also
    stop the topic being registered, and its id is RETAINED. **An in-place `PUT`
    that re-pointed the row is the tempting repair and is the SAME bet
    `adoptExisting: false` already refuses** — the stored envelope is not
    PROVABLY the secret that subscription carries.
  - **DETECTION is `auditConnectionWebhooks`, and NO new schedule.** One bounded
    job per connection enqueued by the EXISTING six-hourly
    `connection.reconcile` sweep, beside the per-connection backfill it already
    enqueues (`queue/scheduler.ts` is untouched). Its population is
    `findConnectionsToAuditWebhooks` — deliberately NOT
    `findPullConnectionsToReconcile` (that one requires product pull, and an
    orders-only connection has webhooks) and deliberately carrying NONE of
    `findConnectionsNeedingWebhookRegistration`'s state predicates, since a
    registration Mercaria believes finished is exactly the case.
  - **Only a stored id the platform CONTRADICTS triggers a repair**, which is
    what makes running it on every connection every six hours affordable rather
    than a re-registration schedule wearing a detector's name. An EMPTY
    `webhook_ids` is not a finding (that is #262's own population — one state,
    one owner); an UNREADABLE list is not a finding (a re-registration fails at
    the same call and spends an attempt saying so); and a `dead_letter`
    connection is REPORTED and never restarted, because a detector must not undo
    a deliberate stop from outside.
  - **`status` is the trigger and `failure_count` is EVIDENCE.** Both are
    optional on `PlatformWebhookSubscription` and ABSENT means "this platform
    does not say", never "disabled" — Shopify's REST webhook object publishes
    neither, and reading silence as unhealthy would put every Shopify connection
    through a delete-and-recreate every six hours. `failure_count` decides
    nothing on purpose: re-registering does not fix whatever is refusing the
    deliveries, and a recreate over a transient blip churns a merchant's
    subscriptions and their secret. WooCommerce serves it as a STRING, so the
    schema coerces.
  - **CLEANUP is bounded by the ID, and the bound is the point.** Orphans
    Mercaria holds an id for are deleted by the repair; one it never recorded is
    LEFT ALONE, deliberately and visibly — a URL under a base nobody here serves
    says only that some Mercaria is at that hostname (a staging deployment, a
    sibling environment), and deleting on that evidence is the cross-deployment
    form of the prefix bug the exact-URL comparison exists to prevent.
- **A fixed defect leaves `WOOCOMMERCE_OPEN_DEFECTS` and, unless something still
  produces it, leaves `CHANNEL_LIMITATION_CODES` too** — `channel-catalog.test.ts`
  asserts the EXACT open-issue set rather than containment, because a list that
  only ever grows is a wizard warning about problems somebody solved.
  `no_rate_limit_retry` is the one that stayed: #219 made it capability-DERIVED
  rather than unproduceable.
- **A connect may not rewrite a connection's MODE, and the refusal is a
  CONDITIONAL WRITE rather than a guard (#302).** `UNIQUE(store_id, provider)`
  means a "second connection" in the other mode is a mode change on the existing
  row, and `mode` sat in `upsertConnection`'s `onConflictDoUpdate` `set` — so an
  OAuth pull connect silently flipped a merchant's `push_in` row, invisibly: the
  id does not move, `listings.source_connection_id` still resolves, and the only
  symptom is the plugin's next push 400ing on `requirePushInConnection` with no
  run recorded. Two of the three connect paths read the row first; **all three
  read outside a transaction, so two concurrent connects both see "no row" and
  the loser's upsert flips it anyway** — which is why the rule is `setWhere:
  eq(connections.mode, values.mode)` on the conflict branch, whose empty
  `RETURNING` set IS the refusal and which a FOURTH connect path inherits without
  knowing it exists. The pre-reads are kept as EARLY refusals only (before
  `exchangeCode` burns a one-time code, before `verifyConnection` calls the
  merchant's site) and can never admit what the write refuses. **There is
  deliberately NO supported mode SWITCH**: `disconnectConnection` keeps the row
  and never touches `mode`, nothing in `src/` deletes a connection, and a
  merchant moving from the plugin to the pull connector has no self-service path
  — stated so, because the channel keys, webhook secret and `source_*`
  provenance bound to a `push_in` row each need a decision that is its own issue.

## Supplier-fulfilled retail fulfilment and the Moovo boundary (#126, ADR 0004 D2.6/D2.7/D2.8/D9.4/D9.6/D9.9)

`services/retail-fulfilment/` (7 modules) + `db/retailFulfilment/` +
`db/schema/retailFulfilment.ts` (4 tables) + one nullable defaulted column on
`supplier_agreements`. Full reference: **`docs/retail-fulfilment.md`**; schema
decisions: `db/schema/CONVENTIONS.md` §"Supplier-fulfilled retail fulfilment
(#126)". One coherent Mercaria order while an approved supplier prepares the
goods and **Moovo owns the physical logistics**.

**Four of its dependencies are OPEN and unbuilt** — #156 (the canonical Oxy
service client for Moovo), #157 (the fulfilment aggregate and read projection),
#158 (the durable logistics-event inbox) and #159 (quotes, bookings, labels,
return transport). Those four ARE the Moovo half, so this issue shipped the
Mercaria half and left every Moovo-facing call as a seam that refuses
unconditionally and names the issue that owes it.

- **Six of the ten snapshot facts already have immutable homes and are NOT
  copied.** `order_items`, `orders.totals` and #123's append-only procurement
  intent already hold the product, price, tax, agreement, offer, quote and
  purchase-order citations. A second immutable record of one fact is the failure
  the snapshot exists to prevent, and the copy nobody reconciles is the one a
  customer finds on a receipt. `retail_order_role_snapshots` holds the remainder:
  the seller of record, the #117 disclosure, and the four consumer-rights
  windows. The buyer CONTACT PATH is DERIVED from `orders.buyer_origin`, never
  stored.
- **The four windows are stored as NUMBERS beside their version, and the terms
  are a CODE CONSTANT, not a table.** A version pointer is only as durable as the
  code that can still resolve it; a table would let somebody publish a withdrawal
  window no shipped terms document contains, and it would be snapshotted onto
  real orders as what those buyers agreed to.
- **Permitted is not chosen — two mode columns, two clocks.**
  `permitted_fulfilment_mode` is contractual and frozen at purchase;
  `fulfilment_mode` is operational and unknowable until a supplier accepts and
  confirms package readiness. One column would freeze a mode nobody could know or
  leave the grant rewritable after the sale. Two make the containment a real
  INTRA-ROW CHECK, and a trigger makes the operational one write-once.
  `chooseFulfilmentMode`'s `undecided` branch has NO `mode` property, so "we do
  not know yet" cannot be read as `supplier_controlled`.
- **Mode A needs its own contractual grant.**
  `supplier_agreements.moovo_label_dispatch_permitted` (default FALSE) is
  separate from `dropship_rights_granted`: one says the supplier may ship under
  Mercaria's name, the other says a third party may execute against Mercaria's
  carrier account. Deriving one from the other puts Mercaria's logistics
  documents into a warehouse that never agreed to handle them. Today Mode A is
  UNREACHABLE — no adapter reports verified package facts and no Moovo port is
  registered — and that is stated rather than hidden.
- **`moovo_source_reference` is GENERATED from the row's id.** Deterministic
  because a booking's idempotency and an inbound event's convergence both key on
  it; a per-attempt value would differ between two racers and defeat the property
  it exists for. `findRetailFulfilmentIntentBySourceReference` takes a reference
  and NOTHING else and returns one row or none — #126 privacy 9 held by the
  shape of the lookup rather than by a filter.
- **The over-allocation invariant is cross-row and the repository is its single
  writer**, locking `order_items` `FOR UPDATE` first. A REPLACEMENT is excluded in
  BOTH directions — from the committed sum AND from the incoming request — because
  it re-ships units already allocated; the first implementation had only one half
  and refused every replacement. A CANCELLED intent releases its claim. The
  reconciliation reader LEFT-joins, so a line with NO allocation shows as zero —
  the "lost" half of #126 mapping 8, which an inner join cannot report.
- **The promise trail is APPEND-ONLY and a failed refresh is a ROW.** A mutable
  "current estimate" column is precisely the mechanism by which a past promise is
  silently rewritten. A supplier's SLA arrives `advisory` and no code path
  upgrades it; only `mercaria_checkout` may author the `guaranteed`
  accepted-at-checkout promise, by CHECK. The accepted promise is the SLOWEST
  line — an order arrives when its last parcel does.
- **`retail_delivery_promises_observed_shape_check` is TWO biconditionals, not
  one over their conjunction.** The obvious spelling is SATISFIED by
  `outcome='unknown'` with a window and no basis, because both sides evaluate
  false — admitting exactly the row rule 10 exists to forbid. Caught by the
  real-server suite; any future multi-column "present exactly when" CHECK in this
  schema must be written the same way.
- **The seven state axes derive from seven different inputs and none from
  another's.** `RetailFulfilmentStateInputs` has no member that feeds two, and
  `RetailFulfilmentAxisState`'s `known: false` branch has no `state` property, so
  an unknown axis cannot be rendered at all. An UNPARSEABLE Moovo observation time
  answers `unknown`, never fresh. All six of #126's examples are tests.
- **Acceptance 2 is a scanned gate plus a WALK of the real tables** —
  `services/__tests__/retail-logistics-isolation.test.ts`: no carrier client, no
  outbound HTTP, no scheduler, no carrier-state mapping, no guest-portal or
  service credential, no payment import, and no carrier/package/label/scan/
  weight/dimension/manifest/poll column in any of the four tables. Vacuity floors
  on both the file count and the column count, plus a mutation self-test on every
  detector.
- Env: `MERCARIA_RETAIL_SELLER_LEGAL_ENTITY` and `MERCARIA_RETAIL_SELLER_COUNTRY`,
  both demanded by `MERCARIA_RETAIL_ENABLED`'s half-configuration rule and neither
  defaulted — defaulting the country would print `ES` on every receipt of a
  deployment that never configured one. **#126 adds NO flag of its own**: a
  rollback must leave placed orders' fulfilment intact, and
  `retail-checkout-isolation.test.ts` already fails the build if a post-entry
  module reads `config.retail`.
- Seams, each a named contract that fails closed: **#156/#157/#158/#159** (the
  whole Moovo half; `MoovoTransportProjection` is published as a TYPE and NO table
  holds a shipment count, package, event id, checkpoint or freshness, because a
  column nothing could populate is a second source of truth for a fact Mercaria
  does not hold), **#127** (return authorization), **#162/#129** (the buyer and
  support tracking experience), **#124/#125** (verified package facts), the
  TRANSACTIONAL NOTIFICATIONS (six of nine are Moovo milestones; the procurement
  half needs `procurement-outcome.port.ts` to become a fan-out AND an outbound
  mail transport Mercaria still does not have), and the OPERATOR SURFACE (nine of
  its twelve exception cases are questions about Moovo state; when the other three
  get a route it belongs on `/internal/procurement/*` behind the existing
  `PROCUREMENT_OPERATOR_OXY_USER_IDS` list, not a seventh).

## The Printful supplier adapter and the bounded retail pilot (#125, provider selected by #119)

`services/supplier-orders/adapters/printful.ts` +
`services/ingestion/adapters/printful-catalog.ts` + `services/printful/`
(transport, registration) + `services/retail-pilot/` + `db/retailPilot/` +
`db/schema/retailPilot.ts` (5 tables) + `/internal/retail-pilot/*`. Full
references: **`docs/suppliers/printful.md`** (the twenty-section provider
document) and **`docs/retail-pilot.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"The bounded retail pilot". #124 said how Mercaria
buys from *a* supplier; this is the first real one, plus the bounds on how much
of it Mercaria is willing to do.

**There is no Printful account, nothing is contractual, and `live` is refused in
code.** `docs/suppliers/2026-08-09-first-dropship-supplier.md` §11's eight-item
entry checklist is entirely OPEN, so #125 acceptance 3 (live preflight and order
creation) and 6 (packaging and customer documents) are NOT satisfiable here and
are not claimed. Everything that does not depend on an account is built.

- **The adapter declares thirteen of twenty-four capabilities, and every absence
  is load-bearing.** Printful is PRINT-ON-DEMAND: nothing is picked off a shelf,
  so `inventory_reservation` is undeclared and a reservation is unrepresentable;
  nothing published states how long a price is good for, so `price_guarantee`
  and `quote_expiry` are undeclared; returns are a CLAIM process rather than an
  API RMA. `tax_duty_estimate` is the one worth reading — Printful DOES publish
  `POST /tax/rates` and declaring it would look like diligence, but it answers
  about the DESTINATION's sales tax while a preflight needs the tax on the
  supply TO MERCARIA, which is input-deductible and never a customer cost
  (#119 §4.5). Every undeclared claim is stripped at #122's and #124's boundary
  and lands on the value that BLOCKS.
- **`findOrderByClientReference` returns `null` only when absence is PROVEN, and
  THROWS otherwise.** #124 treats `null` as proof the provider holds no order,
  and it is the one path on which a second submission is reachable. Printful
  documents `@external_id` addressing for Sync Products and Variants and **not
  for the Orders API**, so the lookup enumerates recent orders and requires TWO
  things before answering `null`: the scan was exhaustive (a page bound reached
  is not an enumeration finished), and at least one order carried an
  `external_id` PROPERTY — or there were no orders at all. Orders existing with
  none exposing the field is a check that cannot tell success from failure, and
  its failure direction is a duplicate supplier order.
- **`live` is refused by a CODE branch, not a flag.** `LIVE_REFUSED_UNTIL_GATED`
  in the adapter throws for every `live` account; lifting it is a deliberate
  change that records §11's gates as done, because a setting is what gets
  flipped at 3am by somebody who has not read the checklist. The credential
  check underneath it (empty, `-`, `TODO` refused) is the layer that remains
  afterwards. There is **no `PRINTFUL_ENVIRONMENT` variable and none may be
  added** — the account row carries its environment, frozen by trigger.
- **`afterWrite` is OBSERVED by the transport, never guessed.** The request is
  flushed explicitly and a flag flips when `end()` completes: a failure before
  that wrote nothing, and everything after it — a read timeout, an aborted
  response — is `true`. An unparseable 2xx is `afterWrite: true` too: the call
  succeeded and nobody can read what it did.
- **Both adapters are PURE and both directories are WALLS.** The transport is a
  port (`services/printful/transport-contract.ts`) and the credential arrives
  per call, so the existing `supplier-order-isolation` and `ingestion-isolation`
  scans cover them. It also makes the conformance suites meaningful: a fake WIRE
  measures the real adapter, the real orchestration and the real attempt log,
  where a mocked adapter would measure the mock.
- **The EU bound is ENFORCED at quote time, not assumed.** #119 §3 records that
  Printful publishes no per-order guarantee of an EU fulfilment origin, so
  `resolveAvailability` answers `orderable` only for a variant available in an
  EU-dispatchable selling region. `PRINTFUL_EU_FULFILMENT_COUNTRIES` is a code
  constant: which countries are in the customs union is a fact about the union,
  and a configurable list is one typo from admitting a dispatch D2.9 forbids.
- **A supplier catalogue cannot publish a wholesale cost, structurally.** A
  Printful `catalog_sources` row is bound to NO MERCHANT, and #62's rule is that
  a merchant-less source produces no offers at all — so the cost has nowhere
  public to land whatever a rights policy says. That is also #125 rule 2's
  separation from affiliate source records, which ARE merchant-bound.
- **`incremental` is NOT declared by the catalogue adapter.** Printful publishes
  no verifiable changed-since filter, and an adapter claiming one would return
  everything and call it a delta. `complete` needs the last page AND no
  truncation — a bound reached is not an enumeration finished.
- **The pilot's bounds are ROWS, not environment variables**, and that
  divergence from every other rollout lever here is deliberate: those are
  incident levers (flip one value at 3am), these are a published policy somebody
  signed and orders were placed under. A cohort version is frozen once active,
  its SKU allow-list and thresholds may not GROW afterwards (narrowing is still
  permitted), and a widening is a NEW version with its own author, date and
  rationale — acceptance 8 as a schema property.
- **No active cohort ⇒ every retail line is refused.** An empty pilot IS the off
  position, which is why this domain adds NO environment variable of its own.
- **A stop pauses ENTRY and nothing else**, and it is a property of the CALL
  GRAPH: the gate is called from `planRetailCheckout` and nowhere else, so
  placed purchase orders keep being submitted, polled, cancelled, refunded and
  reconciled. `retail-pilot-isolation.test.ts` fails the build if a procurement,
  payment or ranking module starts calling it — and its mutation self-test
  caught a real gap in its own detector (a relative `../payments/` import would
  have slipped past the first pattern).
- **The gate runs LAST, after #120's lock, and the cost is stated.** The value
  ceilings bound the amount a buyer would be charged, which does not exist until
  it is locked; every earlier position would need a partial second copy of the
  rule or a "provisional" verdict, and a bound with a soft state is not a bound.
  A retail line outside the pilot has therefore spent one preflight when it is
  refused — acceptable because a retail line exists only where an operator made
  a binding, and because nothing is charged or ordered at that point.
- **A threshold nobody measured is `unmeasured`, never `within`** — the vacuity
  floor, applied to a safety bound. A rate is additionally refused off a sample
  below twenty; a COUNT has no such floor. The UNIT is stored beside the value
  and a mismatch is refused rather than compared. A breach is strictly `>`, so a
  one-occurrence stop is written with a threshold of ZERO.
- **Absent funding REFUSES**, inverting the `SELLER_TRUST_RESTRICTED_TIERS` rule
  on purpose: an absent trust signal withholds nothing because restricting on
  absence turns an outage into a delisting, but an absent balance is Mercaria
  not knowing whether it can pay. The floor is compared against the balance
  MINUS this order's draw, or the check would admit the order that empties the
  wallet. **No payment credential is stored anywhere** — a top-up is a treasury
  act and Mercaria records only the result.
- Env: `PRINTFUL_ENABLED` (default false — registers both adapters, never gates
  a durable record; demands NO credential up front, for `AWIN_ENABLED`'s reason)
  and `PRINTFUL_BASE_URL`. The pilot adds none. Operator surface
  `/internal/retail-pilot/*` on the SAME sixth allow-list
  (`PROCUREMENT_OPERATOR_OXY_USER_IDS`) #122/#124 use — not a seventh.
- Seams left, each failing closed and none a stub that lies: **the
  procurement-offer projection** (Printful source records do not yet become
  `procurement_offers`, so no Printful item is sellable at all — `retail_pilot_skus.procurement_offer_id`
  is nullable precisely so a SKU can be allow-listed before it exists),
  **#128** (variance recognition, and the measurement producers for eight of the
  thirteen thresholds — a sweep computing only the five it can reach would
  report "no breaches" for the rest, which is the vacuous monitor `unmeasured`
  exists to expose), **#116** (the `mercaria_retail` offer KIND — `OfferKind`
  has no such member, which is why the publication bound is a checkout gate
  rather than an offer filter), **#126/#127** (dispatch, tracking, returns), and
  Printful's real webhook SIGNATURE scheme (account-gated; `verifyWebhook` is
  one synchronous function to replace).
## Claiming a guest checkout into an Oxy account (#109, ADR 0003 D14)

`services/guest-claims/` (5 modules) + `db/guestClaims/` (3 repositories) +
`db/schema/guestClaims.ts` (3 tables) + the claim pair on
`routes/guest-orders.ts` and the claim half of
`routes/internal-guest-commerce.ts`, plus the storefront's
`app/(app)/guest-orders/claim.tsx`. Moving ACCESS to a guest's placed orders
into an Oxy account — and, much more of the work, everything that makes sure
nothing else can. Full reference: **`docs/guest-claims.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"Claiming a guest checkout (#109)".

The failure mode that shapes it: an account acquiring somebody else's purchase
because two email addresses matched. It is silent, it looks exactly like a
feature working, and the person it happens to finds out when a stranger cancels
their order.

- **The proof is a CONJUNCTION held by the SIGNATURE.**
  `claimGuestCheckoutGroup` takes a resolved portal grant, an Oxy user id, an
  optional presented cart session and a clock — and #109's nine "insufficient by
  themselves" rules fall out of that parameter list rather than out of branches.
  A matching email, an order number, a card, a wallet, a merchant's message,
  being a seller on a sibling order, an operator typing an account id and every
  referral handle are all UNREPRESENTABLE, not refused. `claim:write` is
  grantable only to a credential whose inbox was proven, so **paying cannot
  produce a claimable credential in any code path** — a CHECK, not a rule.
- **The GRANT is revalidated in the transaction; the OXY SESSION is not, and
  that is a decision.** A second device can press "secure my access" mid-flight
  (conflict case 4), so the credential is re-read. Re-verifying the bearer would
  mean an HTTP round trip to Oxy while a row lock is held — a lock whose
  duration becomes a function of somebody else's availability — and a token that
  expires four milliseconds after the request was authorized does not
  retroactively unauthorize it. Conflict case 5 is answered by the request's own
  verification.
- **The already-claimed check runs BEFORE that revalidation, and the ordering
  was measured.** A winning claim revokes every outstanding credential for its
  group including the LOSER's, so revalidating first answers a genuine contest
  with a credential error and never writes the `conflicted` row an operator
  needs. The consequence worth stating rather than hiding: a client retrying on
  the SAME credential is answered 401 by the MIDDLEWARE, because the claim it is
  retrying revoked it — rule 12 is about what the SERVICE answers, and it
  converges for every request that reaches it.
- **The lock is load-bearing for the AUDIT, not for the ownership** — measured,
  not assumed. Removing `FOR UPDATE` on `guest_checkouts` leaves the outcome
  correct (the partial unique refuses the second `completed` row and the loser
  stamps nothing) and LOSES the `conflicted` row: both racers read "unclaimed",
  so the loser never sees a claim to contest and fails at the insert instead.
  The realdb race test asserts the contested row, which is the only thing that
  notices.
- **A claim covers every sibling or none.** The stamp is a CAS on
  `claimed_by_oxy_user_id IS NULL` and the returned count is compared against
  the group's; a partial stamp RAISES. `buyer_origin` stays `guest` forever
  (I7), and `Order.buyerOxyUserId` stays EMPTY on a claimed guest order —
  filling it would tell an old client an account placed a purchase it did not.
- **A claim REVOKES every outstanding portal credential for the group,
  including the one that authorized it** (D14). No `exceptGrantId`: sparing the
  presenting credential is right for "secure my access", where the point is to
  keep the person who pressed it signed in, and wrong here, where the point is
  that emailed access has been superseded.
- **The cart merge runs AFTER the commit and only on the session the request
  PRESENTED.** After, because `mergeGuestCart` opens its own transaction and
  taking it inside is #59's merge-runner deadlock. Only the presented session,
  because a portal grant proves an INBOX and not a browser — draining the
  checkout's original session by fiat would move a cart the caller has not
  proved they hold, which on a shared device may be somebody else's basket.
- **A pending payment does NOT block a claim** (conflict case 7), and neither
  does a cancelled or refunded sibling (case 6). Claiming is about ACCESS;
  refusing would strand a buyer whose bank redirect is slow at the moment they
  most want to track it. **Mercaria computes no second account-eligibility
  verdict** either (case 9) — Oxy owns identity, the authenticated session IS
  the test, and a second verdict could only disagree with it.
- **A claimant cannot detach their own orders, and that is the answer to
  revocation rule 2.** Detaching is the value → NULL half of an ownership MOVE:
  self-service, somebody who briefly held a claim can erase the trail and let
  the group be re-claimed with no operator seeing that ownership changed hands.
  The correction is TWO operators and TWO requests (one person can type two
  ids — #55's reasoning), with `four_eyes_required` snapshotted per request.
- **The follow-up work is an OUTBOX, not a call.** Conflict case 11 is "claim
  event emitted but downstream projection failed"; granting eligibility inline
  has exactly that failure mode with no record of it. Two types so a missing
  mail transport cannot stop a verified-purchase grant. `bothSidesProven: true`
  is asserted in the handler and #76 does NOT take it on trust — it compares the
  named claimant against `orders.claimed_by_oxy_user_id` as STORED, which is
  what closes that seam and what makes a revoked claim stop granting with no
  sweep having run.
- **The referral boundary is a scanned gate covering BOTH packages.** A claim
  changes order access, not acquisition history — and "the path cannot reach the
  referral domain in either direction" is strictly stronger than "these rows did
  not move this time". The scan includes the STOREFRONT screens, so UX rule 12
  is a build failure rather than a copy review. The commercial half (one order,
  at most one conversion, a claim replays and creates nothing) is #142's and its
  own realdb file already drives it; the claim's realdb file deliberately does
  not rebuild that fixture stack against a GLOBAL program namespace.
- Env: `GUEST_CLAIM_ENABLED` (the WRITE, default true — an incident lever whose
  alternative would be switching guest commerce off underneath people who have
  already paid), `GUEST_CLAIM_FOUR_EYES_REQUIRED` (default true),
  `GUEST_CLAIM_PROJECTION_ENABLED` (the LOOP) and its tunables. **Not one gates
  a stored claim**, and `guest-claim-isolation.test.ts` fails the build if the
  read paths, the projection or the operator surface starts reading one.
- Operator surface `/internal/guest-commerce/claims*` on the SAME
  `GUEST_OPERATOR_OXY_USER_IDS` allow-list #104/#108 use, not a seventh. Two
  reads and three writes that are three STEPS of one capability; there is no
  "claim this group for account X" and no "move it to another account", because
  reject rule 7 and revocation rule 1 forbid exactly that in one step.
- **#77's `#109` seam is HALF closed, and the split is the point.**
  `guest_claim_started`, `guest_claim_completed` and `guest_claim_conflicted`
  emit from the claim path — the CLAIM ROW supplied them, an id that authorizes
  nothing. `guest_claim_offered` and `guest_claim_declined` moved to #111: an
  offer is a screen having been shown and a decline is somebody navigating away,
  the server observes neither, and the nearest substitutes (a preview read, a
  claim that never arrived) are different facts. `oxy_claim_funnel` therefore
  has a live numerator and no denominator, which its `seam` field says on the
  dashboard rather than reading as a rate.
- Seams left, none of them a stub that lies: **#108** (the transactional
  transport — the `claim_completed` message is composed, queued and retried and
  nothing SENDS), **#110** (cancellations, returns and support for a claimed
  order, which a claimant reaches through the account path that already exists),
  **#111** (the two client analytics types), **#141-#143** (every referral
  consequence, which this domain records none of and can reach none of).
## Transparent offer eligibility, ranking and comparison labels (#74)

`services/ranking/` (10 modules) + `db/ranking/` + `db/schema/ranking.ts`
(1 table) + `GET /offer-comparison` (public) + `/internal/ranking/*` (operator),
plus `@mercaria/shared-types` `offer-ranking.ts` and `@mercaria/ui`
`lib/offer-labels.ts`. Full reference: **`docs/offer-ranking.md`**; schema
decisions: `db/schema/CONVENTIONS.md` §"The ranking policy register (#74)".
Choosing and EXPLAINING the offers a shopper sees, over #44's money, #55's
verified relationships, #57's offers, #68's freshness, #76's ratings and #90's
conditions.

- **ELIGIBILITY and RANKING are two modules, two vocabularies and two verdict
  types**, because the natural single-pass version ("score everything, drop what
  scores zero") makes a weight change able to reveal an expired, restricted or
  suppressed offer. `OfferRankingFacts` — the whole of what a scorer sees —
  carries no listing status, no moderation state, no freshness level and no
  suppression set, so a weight has nowhere to reach. `rankOffers` additionally
  THROWS on a candidate whose `OfferAdmission` does not cover
  `OFFER_ELIGIBILITY_RULES`: a rule added to the tuple and not wired into the
  derivation fails the first comparison instead of quietly widening what is shown.
- **Eligibility CONSUMES #57's `deriveNativeCheckoutEligibility` and re-derives
  nothing.** Rules 7 and 9 read `offer.checkout`, computed at projection time
  from the LIVE listing, variant stock and seller readiness. Nothing in this
  domain reads a listing, a variant or a provider account.
- **`cheapest_known_total` is UNREACHABLE for an offer with unknown shipping, not
  guarded against it.** `selectCheapestKnownTotal` takes a type whose `total` is
  a required `Money`, and the unknown branch of `OfferComparisonTotal` has no
  amount to build one from. The same device runs through the domain: the unknown
  branch of `RankingSignalOutcome` carries no `normalized` and no `weight`, so an
  unknown cannot enter a weighted sum at all — #58's denominator rule held by the
  type rather than by whoever writes the loop.
- **An unknown is left out of BOTH halves of the mean, and a PENALTY would be
  wrong** — a penalty asserts something about the offer, when the only thing
  known is a gap in Mercaria's information. **`merchant_rating` is the one place
  that bit back and it is worth reading**: on the absolute 0–5 scale a genuine
  4.5★ normalized to 0.9, below the ~1.0 an unknown is imputed at, so a merchant
  with NO rating outscored one with a good rating. A scenario test caught it; the
  fix was set-relative normalization like every other set-relative signal, and
  the cost (two merchants at 4.4 and 4.5 put the first at 0) is the property
  `item_price` already has for a one-cent difference.
- **The prohibited inputs are stopped in FOUR independent places**: disjoint
  `OFFER_RANKING_SIGNALS` / `OFFER_FORBIDDEN_RANKING_SIGNALS` tuples; no field on
  the facts type; ONE weight COLUMN per allowed signal and none for anything else
  (a gate asserts the counts are equal); and `offer-ranking-isolation.test.ts`,
  which fails the build if any module here reaches fees, referrals, retail
  pricing, the ledger, a plan or a commission.
- **`native_offer_preference` is the subtle one.** `native_mercaria_checkout` IS
  a label — "you can buy this here" is information — and must never be a term in
  the SCORE. A test pins a native and an external candidate with identical facts
  scoring identically. **FAIR gets no advantage because the domain names no
  currency at all**: the caller supplies the comparison currency, and a scanned
  gate fails the build on any FAIR/FairCoin/OxyPay spelling under
  `services/ranking/`.
- **The tie-break is `sha256(policyVersion + ':' + offerId)`, deliberately NOT an
  id.** `generatedId()` is a uuid v7 whose leading bits are a timestamp, so
  ordering ties by id is ordering by INGESTION TIME — what policy rule 7 forbids
  by name, and a permanent advantage to whichever source crawled first. The
  comparator is TOTAL, so `sort`'s stability cannot leak the input order; a
  property test shuffles the input and asserts the output is unchanged.
- **An INTENT selects a documented primary sort key and never a weight.** An
  unknown fact sorts LAST under an intent keyed on it and can never carry that
  intent's label. `cheapest` is THREE tiers — known total, then known item price,
  then neither — because an offer whose postage nobody published may not be
  called cheaper OR buried beneath one whose full price is known.
- **Policy versions are the `fee_schedules` device with ONE exception**:
  immutable from `canary` onward (trigger), one `active` and one `canary` per key
  (two partial uniques), and `canary_share_bps` is the single column a serving
  version may still move — a ramp is a rollout control, is monotone over subjects,
  and a version per ramp step would make the impression log unreadable.
- **There IS a built-in policy, and that is a deliberate divergence from #58 and
  #121's "no active version ⇒ refuse".** The asymmetry is the consequence:
  refusing a compliance verdict withholds a sale nobody proved may happen, while
  refusing to rank would withhold the comparison surface on every fresh
  deployment. `BUILTIN_RANKING_POLICY` is a real named version every impression
  records; changing its weights means a NEW version string in the same change.
- **The canary is keyed on the comparison SUBJECT, never on a person** — no
  actor, session or device is in the bucket preimage. #77 owns experiments over
  people; this is a rollout over the catalogue, which is why
  `analytics_experiments.ranking_policy_version` stays #111's.
- **The guardrail metric list may not be EMPTY** (`cardinality(...) >= 1`, never
  `array_length`, which is NULL on `{}` and would admit the row it refuses).
  "Evaluate click and conversion outcomes alongside trust guardrails, not as the
  only objective" is a CHECK. Naming a metric is all this domain does with one —
  it reads no measurement.
- **Dominance is DETECTED and never repaired.** A shuffle applied to satisfy a
  threshold would be an undocumented ranking input. A comparison shorter than the
  policy's window produces no findings at all.
- **The operator route set is CLOSED and has no boost, pin, hide or set-rank** —
  the four shapes a sponsored-placement surface takes. A gate enumerates the
  registered routes EXACTLY. Withdrawing an offer is `/internal/offers/:id/retire`
  (#57); suppressing a merchant is the canonical graph's.
- **#55's ranking gate became a SEAM rather than being deleted.** That gate said
  it was "not a permanent wall … the first ranking module to read a verification
  does so in a diff that changes this list", and #74 is that diff: exactly one
  module (`services/ranking/facts.ts`) may reach the relationship domain, through
  the READ repository only, and the other twelve discovery modules still may not.
- Env: `RANKING_CANARY_ENABLED` (default true) and nothing else. It gates neither
  a durable record nor the surface — rollback is activating an earlier version,
  and what an incident needs is a way to stop routing to a canary WITHOUT editing
  the row. There is no `RANKING_ENABLED` and the policy KEY is a code constant.
  Operator surface is on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list and
  is mounted while nothing is published.
- **#77's `#74` seam is CLOSED on the impression half**: every
  `offer_impression` from `/offer-comparison` carries `rankingPolicyVersion`.
  `/offers` (#57) deliberately passes none — it serves a plain cheapest-first SQL
  order under no policy, and stamping a version on it would attribute that
  ordering to weights it never consulted.
- Seams left, each failing closed: **#93** (`resolvePickupProximity` refuses, so
  `best_nearby_pickup` is never awarded), **a tax-inclusion column**
  (`resolveOfferTaxInclusion` answers `unknown` — guessing from the market is how
  a 21% error enters a total), **#70** (canonical search does NOT consume
  `rankOfferComparison` and `registerSearchOfferSelector` has no call site —
  #230: a search selector is sync and is handed its offers, `rankOfferComparison`
  is async, fetches its own and resolves its policy per subject, so filling the
  seam is a port-SHAPE change plus an undecided intent; nothing here reaches into
  search either way), **#84** (a native
  offer names no merchant, so its seller rating is unknown — neutral, which
  prevents a hidden native preference AND a hidden native penalty), **#111** (the
  experiment arm).


## Canonical multi-entity product discovery (#70, ADR 0002 D21/D24)

`services/search/` (8 modules) + `db/search/` (2 repositories) + `GET /search`
+ `/internal/search/*`, plus `@mercaria/shared-types` `search.ts`. Full
reference: **`docs/search.md`**; the measured numbers are
`docs/performance/plans-search-small.md` (#61's harness, #61's workload table,
nine new shapes Q16–Q24).

**NO new tables, NO new indexes, NO migration** — that is the finding. Every
read the pipeline issues is a bounded scan over an index #56/#57/#61 already
built, and the two places it deliberately uses none are dimension tables with a
measurement beside them.

- **A commercial payment cannot influence organic relevance, three ways.** The
  vocabulary (`SEARCH_RELEVANCE_SIGNALS` and
  `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS` are DISJOINT); the SIGNATURE
  (`EntityRelevanceInput` has a field for every permitted signal and none for
  any forbidden one — the `SourcingCandidateFacts` device); and
  `search-relevance-isolation.test.ts`, which scans `services/search/` and
  `db/search/` WHOLE so the wall holds for modules nobody has written yet, with
  a file-count floor, comment stripping, and a mutation self-test per detector.
  `SEARCH_RELEVANCE_SIGNALS` has NO popularity member: #70 admits one "only when
  explicitly defined and resistant to manipulation" and nothing here defines
  such a measure, so adding it is a decision with a mechanism rather than an
  omission to fill in.
- **There is no `variant` result kind.** #70 lists `CanonicalVariant` as a
  search ENTITY, not a result kind; variant-level intent is reported as
  `matchedVariant` on the PRODUCT. Giving it a kind puts forty rows of one phone
  on one page, which is the duplication acceptance 1 exists to remove.
- **The stage bands do not OVERLAP** — `floor(n) + headroom(n) < floor(n-1)`
  for every adjacent pair, asserted over the tuple rather than a hand-written
  list. That is what makes #70 acceptance 2 arithmetic (an exact identifier can
  never be overtaken by a perfect fuzzy match), what reduces the signals to
  tiebreakers WITHIN a stage — the only honest role for a `ts_rank` and a
  trigram distance that are not calibrated against each other — and what makes
  the ordering explicable.
- **Relevance is computed BEFORE any offer is read**, which is the mechanism and
  not an optimisation: it bounds the offer read (sort first, examine the top
  slice) and it makes the separation from #74 structural, since the ordering
  exists before any price does.
- **A bare identifier answers ALONE** — no fuzzy stage, no other entity kind.
  `mpn` and `brand_model` are excluded from identifier recognition (both accept
  any string, so including them would make every one-word query
  "identifier-only" and switch fuzzy retrieval off for prose). A MISTYPED
  barcode is not an identifier and falls through to the lexical stages.
- **#70 adds ONE freshness predicate #68 does not have, and it caught a real
  bug.** `nativeOfferFreshness` measures how long ago the CONVERGER ran, so a
  native offer whose listing was restricted five minutes ago is still `current`
  — correct for `GET /offers`, which shows an ineligible row with its reasons,
  and wrong for a summary claiming "from 100 €". `contributesToSummary` also
  excludes `listing_restricted` / `listing_not_active`, and deliberately NOT
  `out_of_stock` or `seller_not_payment_ready`: those block checkout and are not
  removals. The `stale_at` pre-filter is genuinely only a narrowing —
  mutation-testing it away leaves the lapsed-offer case GREEN.
- **The N+1 is unrepresentable, in two statements per PAGE.**
  `rankProductOfferIds` (`row_number() over (partition by product_id …)`, a
  two-column projection) then one typed hydration of exactly those ids, then ONE
  `buildOfferProjectionContext`. A plan test asserts twenty products produce ONE
  statement. `summariseProjectedOffers` was EXTRACTED from #68's
  `readProductOfferSummary` so both fetch paths share one derivation at the SAME
  depth — two depths would make `currentOfferCount` differ between a search page
  and a product page with nothing saying why.
- **The keyset cursor carries the last candidate CONSIDERED, not the last
  SERVED.** An offer filter can drop a candidate after it is scored, and a
  cursor on the last served row re-considers and re-drops everything between the
  two on every later page. The score travels as an INTEGER of micro-units (a
  float round-tripped through a decimal string repeats or drops exactly one row
  per page), and the cursor is bound to a FINGERPRINT of the query, filters and
  kinds — a foreign cursor is UNREADABLE, never misapplied.
- **A price bound names its currency, and `unconvertible` is a third answer.**
  Not `false`: an unpriced offer, a currency outside the presentment set and an
  unservable pair all mean "Mercaria cannot say" and none may read as "too
  expensive". Those currencies are named in `SearchFxContext`. ONE `getRates`
  per request.
- **#74's seam FAILS CLOSED.** `registerSearchOfferSelector` has no default:
  until #74 registers one, no result carries `selectedOffer` — not the cheapest
  under another name. The summary still reports the LOWEST PRICE, which is a
  fact about the offers and names no seller.
- **`CANONICAL_SEARCH` is a SEVENTH canonical read lever and the ONE that
  defaults `off`** — the read levers' rule, not an exception: they default to
  today's behaviour, and today's behaviour for `GET /search` is that it does not
  exist. `off` and `shadow` are both a 404; `shadow` computes BOTH answers and
  records the comparison (ADR 0002 D24 phase 3, the first surface where it does
  more than count). The lever lives in the HANDLER, not in
  `requireCanonicalReads`, because a middleware that returns before the handler
  can never compute anything — which would make `shadow` and `off` the same.
  `GET /listings?q=` is untouched, so acceptance 8's rollback is one variable.
- **The shadow comparison measures COUNTS and zero-result agreement and NOT
  overlap**, for the reason `analytics/search-instrumentation.ts` already gives
  about the same join: a listing reaches a canonical product by two unbatched
  routes that are not the same set, and a title-matched number would be worse
  than none because a rollout decision would rest on it.
- Operator surface `/internal/search/*` on the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, mounted while the public lever is
  off. READ plus one EXPLAIN and no third: there is no "boost this product", no
  "pin this result" and no "set the weights" — every one would be a ranking
  control outside the versioned policy. The explain emits NO analytics event: a
  diagnostic query is not a search somebody performed, and counting it would put
  staff traffic into `zero_result_rate`.
- Two plan facts recorded because the gate went red on them first: **exact name
  is served by the GiST trigram index** at the `ci` scale, not the plain btree
  (pg_trgm supports `=` on PG17, so two indexes serve it and the choice is
  statistics — the gate forbids `Seq Scan` and pins no name), and the
  **identifier read is a BitmapOr** over two plain indexes rather than the
  collision gate's partial unique, because it is a disjunction over several
  schemes at once.
- **The narrow candidate projection is NOT faster at `small`** (1.981 ms against
  the wide reader's 2.007 ms). #61 attributed Q10's cost to heap width at
  `medium`; at 10,000 products that is not the cost. It is kept because it is
  strictly less work, and the honest statement is that its benefit is
  unmeasured at this scale rather than demonstrated.
- Deferred with named seams, each failing closed: **#74** (offer selection),
  **#71** (the product page), **#93** (nearby/pickup — no parameter exists to
  accept, so it is unrepresentable rather than ignored), **#77** (filter-USE
  measurement needs a typed column in a domain #70 does not own; category filter
  use IS measured through the existing column), **#37**, **#95** (no LLM is the
  primary retrieval system, per the issue), and autocomplete (a different
  latency budget and a per-KEYSTROKE privacy posture, its own issue).
## Currency-safe offer price history (#78, ADR 0002 D18)

`services/price-history/` (7 modules) + `db/priceHistory/` (4 repositories) +
`db/schema/priceHistory.ts` (4 tables) + `/price-history` (public) and
`/internal/price-history/*` (operator). Full reference:
**`docs/price-history.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Price history (#78)". #57 holds an offer's CURRENT terms and states outright
that the price-history TABLE belongs here; this is that table, plus the derived
series a chart reads.

The failure mode that shapes it is a CHART THAT LOOKS CONTINUOUS, CONFIDENT AND
CHEAP while being a lie: a line drawn through three months nobody offered the
thing, a "lowest ever" that is the used one on a page about the new one, an old
price silently reconverted at today's rate, and a "known total" computed by
treating an unpublished delivery cost as free.

- **An OBSERVATION and a POINT are different kinds of fact, and the types keep
  them apart.** An observation is what one source said at one instant —
  immutable, in the source's own currency. A point is a derived answer that
  NAMES the observation it came from. `mercaria_offer_price_snapshot_immutable`
  raises on UPDATE, so a correction is a SUPERSEDING record and no stored price
  is ever rewritten.
- **DELETE is deliberately PERMITTED, inverting the ledger's posture and
  matching `analytics_events`.** Erasure on a schedule is the policy:
  `retention_expires_at` is stamped at write time from the SOURCE's own
  `catalog_source_policies.cache_ttl_seconds`, and a trigger refusing DELETE
  would make the shared expiry sweep fail SILENTLY on every row it was
  contractually obliged to remove. `snapshot_id` CASCADEs, so acceptance 6 —
  every point traces to an immutable observation — is true at EVERY instant
  rather than true until a sweep runs.
- **`offer_id` CASCADEs too, and that is the one direction this domain gives
  ground on.** #57 chose CASCADE from `listings` onto `offers` because a seller
  deleting their listing must not be blocked; a RESTRICT here put this table in
  front of that flow and failed `offers.realdb.test.ts` on `23503` the moment
  one observation existed. Nothing meaningful is lost: an observation explains
  an OFFER's terms, and retirement — how an offer normally leaves — is a status
  transition that touches nothing here.
- **A SNAPSHOT carries no canonical, merchant or storefront id**, and that
  omission is how issue operations 4 (preserve history through merges) holds
  with NO write and NO rehoming: the offer names all four, #59's `offers` phase
  repoints the offer, one rebuild picks up the loser's whole history under the
  winner. `merge-plan.ts` therefore retains `offer_price_series` with the
  TOMBSTONE — two series cannot be concatenated, because each of their points
  names the ONE cheapest observation in its bucket and the cheapest across both
  is neither list — and `rebuildEntityAggregates` re-arms both sides.
- **Only an OBSERVATION writes an observation.** A retirement writes NOTHING,
  which is snapshot policy 5: a point at the last known price on a day nobody
  could buy the thing is the most misleading shape a chart takes. An offer with
  no price produces no row at all (`item_price_amount` is NOT NULL) and the
  refusal is COUNTED. The write runs in the caller's transaction with NO
  `try`/`catch`: in PostgreSQL one failed statement aborts the whole
  transaction, so catching it would leave a page reporting success having
  committed nothing.
- **Dedup and anchors are ONE interval**, and it is NOT the global TTL #68
  forbids: that prohibition is on a source's FRESHNESS LIFETIME, and this is
  Mercaria's own STORAGE cadence, which can never extend how long anything is
  shown. A suppressed observation leaves no row, which is why
  `offer_price_write_metrics` exists — counting rows answers "how much did we
  keep" and never "how much did we suppress".
- **Every conversion carries its quote, and `PriceHistoryValue` is a
  discriminated union on `basis`.** A consumer cannot render a figure without
  seeing whether it is `source_native`, `historical_quote` or
  `current_rate_reinterpretation`; the last carries BOTH quotes and is OPT-IN,
  because the honest answer to "I cannot price that in your currency" is silence
  rather than a number with a footnote. Five FX columns are present EXACTLY when
  a conversion happened (a biconditional CHECK) and `fx_from` must equal the
  point's own `native_currency`.
- **A point's `native_currency` carries the presentment tuple's CHECK while an
  observation's carries #57's OPEN one.** An observation records what a platform
  SAID; only a convertible currency can become a POINT, so a value outside the
  tuple would mean raw minor units had been compared across currencies. An
  unconvertible observation is stored faithfully and excluded under
  `currency_not_convertible`.
- **A GAP and an UNBUILT range are different answers**, which is what
  `covered_from`/`covered_through` exist for: "no point in this bucket" means
  both "nobody was offering this" and "the rebuild has not reached here", and
  only one of those is a fact about prices. Both are returned as explicit
  RANGES, beside a plain-language summary and a data table — API rule 7 is part
  of the payload, not a client concern, because a summary composed on three
  clients is three summaries.
- **The rebuild is DELETE-then-INSERT in one transaction, never an upsert**, and
  its tiebreak is `(observedAt, snapshotId)` and never the primary key: a uuid
  v7 key is NOT monotonic within a millisecond, so a rebuild that tie-broke on
  the id would produce a different chart on every run for the same data.
- **A stored aggregate at all is the deliberate divergence from #61 and #68**,
  and the reason is the FX map rather than scale: choosing the lowest price
  across four currencies needs rates that live in a service, so the comparison
  cannot be pushed into SQL. Which is exactly why a MERCHANT-scoped read —
  bounded by one seller's own offers — is still derived LIVE from the same pure
  function, with no series row at all.
- **`mercaria_retail_item_price` is representable and produces NOTHING** —
  `OfferKind` has no `mercaria_retail` member until #116 — and a test pins the
  emptiness so closing the seam is a change to the OFFER vocabulary rather than
  to this domain. `official_store_item_price` is empty until #55 verifies a
  `merchant_official_channel_for_brand` relationship inside its window.
- **Five scanned walls**, each with a vacuity floor and a mutation self-test
  (`price-history-isolation.test.ts`): no referral reference, no FairCoin or
  OxyPay spelling (RAW source, copy included), no price alert (#79's, and #80's
  `ProductSavePriceAlert` seam stays unsupported), no ranking (#74's, both
  directions) and no payment rail. `PRICE_HISTORY_FORBIDDEN_DTO_FIELDS` names
  the referral prohibition as a VALUE, gated statically AND by a realdb walk of
  a REAL emitted response.
- Env: `PRICE_HISTORY_ENABLED` (the rebuild LOOP, default false),
  `PRICE_HISTORY_PUBLIC_READS_ENABLED` (the buyer MOUNT, default false),
  `PRICE_HISTORY_SERIES_CURRENCIES` (**EMPTY by default** — a default would put
  ONE currency into the contract, which currency rules 8 and 9 keep out; with it
  empty every observation is still written and NO series is enqueued),
  `PRICE_HISTORY_ANCHOR_INTERVAL_SECONDS` and the rebuild tunables. Operator
  surface on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
  #54/#56/#57/#58/#60/#62/#68 use, mounted while the loop is off.
- Operator surface is TWO reads and ONE write, and the omissions are the design:
  there is no "set this point", no "hide this observation", no "correct this
  price" and no delete — every one would be a way to make a price history say
  something nobody observed. The trace opens from an OFFER id and nothing else.
- **Shard and archival strategy is RECORDED and not adopted** (operations 5):
  `offer_price_snapshots` is the only table here whose size is a function of
  traffic, the natural partition key is `observed_at` by month because every
  read is time-bounded, and nothing is partitioned today because drizzle-kit
  models no partitioning and the prerequisite is a measurement on #61's shape
  rather than a guess.
- Deferred with named seams: **#79** (alerts — nothing here reads or writes one
  and a gate says so), **#116** (the `mercaria_retail` offer kind), **#74**
  (ranking), **#59** (the correction WORKFLOW; the superseding record is the
  shape it takes and the column exists), **#71** (the product page that renders
  these charts), and `taxInclusion`, which is modelled and is `unknown` for
  every row because `offers` records no tax-inclusion fact — closing it is an
  offer-side column and belongs to #57.
## Buyer post-purchase requests (#110): cancellations, returns and support

`services/buyer-requests/` (13 modules) + `db/buyerRequests/` (4 repositories) +
`db/schema/buyerRequests.ts` (8 tables) + `controllers/buyer-requests.controller.ts`
+ `routes/buyer-requests.ts`, mounted TWICE — under `/orders/:id` for an
authenticated buyer and under `/guest/orders/:groupId/orders/:id` for a portal
credential. Full reference: **`docs/buyer-requests.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"Buyer post-purchase requests (#110)".

- **A buyer never sets order status; a buyer files a REQUEST**, and the
  enforcement is the IMPORT GRAPH. The two buyer-side services import no order
  writer, no refund service, no inventory function and nothing from
  `services/payments/`; the two DECISION services import all of them and are the
  only ones that may. `buyer-request-isolation.test.ts` asserts both directions
  — the absences AND that the decision services genuinely reach `transition` and
  `refund.service`, so the gate cannot pass by those having been renamed away.
  That is acceptance 2, checkable by reading a list of imports.
- **A read-only credential cannot reach a mutation, as a SHAPE.** Every mutating
  function takes a `BuyerRequestActor`, which only `authorizeBuyerRequest` can
  mint, because the type carries a MODULE-PRIVATE `unique symbol` no other file
  can supply. "Did this path check the scope?" is answered by the path existing
  at all rather than by reading it. `authorizeBuyerRequest` COMPOSES #106's
  `authorizeOrderAccess` and re-decides nothing, which makes rules 4 and 5 free.
- **Step-up is required for the two SUBMIT actions and nothing else.** The line
  is whether the action moves MONEY OR GOODS. The attack it closes is vandalism,
  not theft — a refund always returns to the original instrument, so a stolen
  30-day credential gains nobody money. Requiring it on WITHDRAW would put an
  email round trip between a buyer and the undo of their own mistake.
- **`accepted` is not `completed`, and there is no `failed`.** A completion that
  did not complete leaves the request `accepted` with a bounded
  `completion_failure`, and the retry is the SAME idempotent call — the
  `payment_repairs` posture. The completion MODE is re-derived from the order's
  live payment state rather than read off the request: a buyer can ask while a
  payment is still verifying, and completing in `release` mode then would
  release a reservation on money already taken.
- **Convergence needs BOTH indexes and neither covers the other.** The partial
  unique on the OPEN states converges two racers on one row; the idempotency
  unique converges one client's retry AFTER the first was decided. Pinned by a
  realdb case that runs the two submissions CONCURRENTLY — a sequential pair
  passes under a read-then-write that a real race defeats.
- **Restock waits for `received`, and that is why `received` is a state.** A
  cancellation refunds and restocks immediately (the goods never left); a return
  cannot, because refunding at approval would put units back on the shelf that
  are still in a parcel. The refund's idempotency key is derived from the
  REQUEST, and `refund.service` short-circuits on it BEFORE touching inventory —
  which is what makes "cannot double-restock" true rather than likely.
- **A cancellation refunds delivery; a return does not.** A cancelled order was
  never shipped; a returned one was carried. A discretionary gesture belongs on
  the merchant's own refund surface.
- **The dependency onto #49 points ONE way.** This domain reads
  `refunds.provider_state`; nothing in the payment domain knows it exists. A
  hook from `refund-execution.service` into here would invert the seam that
  keeps the money path free of everything built on top of it. `reconciler.ts` is
  the bounded, leased sweep that catches a rail answering late.
- **`support_messages` and `buyer_request_events` are APPEND-ONLY against UPDATE
  *and* DELETE**, and both foreign keys are `RESTRICT` rather than `CASCADE` so
  the declaration and the trigger agree — a cascade would be a way to delete
  rows by deleting a parent. A request LINE's variant and requested quantity are
  frozen by trigger; only `approved_quantity` moves, and it is the only quantity
  the refund reads.
- **The merchant allow-list is a VALUE walked at RUNTIME.** The first spelling
  was `Omit<T, never>`, which compiles, looks like #106's `MerchantOrder` device
  and can NEVER fail — there is no buyer-identifying field on a request today,
  so subtracting the empty set enforces nothing and would go on enforcing
  nothing after somebody added one. `requesterLabel` is the literal `Buyer`,
  with no buyer-origin discriminant anywhere in either merchant shape.
- **Eligibility is DERIVED, never stored** (the `deriveNativeCheckoutEligibility`
  divergence): the inputs are the live order status, the live payment status,
  the status HISTORY, any open request and the clock. `order_already_dispatched`
  reads the HISTORY, because an order that shipped and was then partially
  refunded reads `partially_refunded` today.
- **`replacement` is representable and REFUSED at submit** (`role_email`
  device), and **contact/address correction is EXCLUDED ENTIRELY** — rule 10's
  own escape, taken because revalidating shipping, tax and fraud needs systems
  Mercaria does not have and verifying a NEW inbox needs a flow that does not
  exist. #108's `contact_change:request` stays defined and ungrantable.
- **Support attachments are EXCLUDED**, because rule 5 asks for malware scanning
  Mercaria has none of and metadata it holds no credential to read. Return
  EVIDENCE is a bare Oxy `file_id`, the `abuse_reports` posture, with the digest
  gap stated rather than faked — one provenance channel, the #90 reasoning.
- **`strict: false` means STRING discriminants**, not `eligible: true|false`.
  Every union in the domain (`CancellationEligibility`, `ReturnEligibility`,
  `BuyerRequestAuthorization`) uses one, because without `strictNullChecks`
  TypeScript does not narrow on a boolean-literal discriminant — the #68 finding,
  hit again here on the first typecheck.
- Env: `BUYER_REQUESTS_ENABLED` (the buyer WRITE mount; a 503 under its own
  `BUYER_REQUESTS_DISABLED` code, because the capability exists and is paused),
  `BUYER_REQUEST_RECONCILER_ENABLED` and its three tunables. NEITHER gates a
  durable record. Operator surface `/internal/guest-commerce/buyer-requests/*`
  on the SAME `GUEST_OPERATOR_OXY_USER_IDS` allow-list #104/#108 use — NOT the
  payment one, because a support agent tracing a stuck return should not thereby
  see every store's money. A trace opens from an ORDER; the ONE write drives an
  existing idempotent path.
- **#77's `#110` seam is CLOSED** — the three event types emit from the
  controller AFTER the write succeeded, so `guest_post_purchase_demand` counts
  requests FILED rather than attempted. They carry the order and the actor kind
  and nothing else; the reason code, the buyer's note and every support message
  body have no column and must not acquire one.
- **The one gap this issue NAMES rather than closes:** `refund.service.process`
  is store-scoped and `/admin/stores/:storeId/orders/:id/refunds` is its only
  route, so a P2P order has no refund path in this repository and never had one.
  Unreachable for a guest (guest P2P checkout is refused until #112), reachable
  for an authenticated buyer of a P2P order, and recorded as
  `refund_path_unavailable` rather than silently never happening.
- Seams: #93 (pickup — `pickup_not_supported` is a real unreachable branch),
  #112 (guest P2P, and the P2P refund path that must land with it), #111
  (retention), #102 (the privacy review that could enable contact correction),
  Oxy service credentials (evidence digests), Moovo (return shipping).

## The canonical product page (#71, ADR 0002 D6/D8/D18/D24)

`services/product-page/` (5 modules) + `db/productPage/productPageRepository.ts`
+ `routes/product-page.ts` + `controllers/product-page.controller.ts` +
`middleware/product-page-schemas.ts` + `@mercaria/shared-types`
`product-page.ts`, plus the storefront's `app/(app)/p/[handle].tsx` and
`components/product/`, and `@mercaria/ui`'s `OfferConditionBadge`,
`OfferLabelBadge` and `formatSourceMoney`. Full reference:
**`docs/product-page.md`**. **NO new tables and NO migration** — #61 measured
the graph at a million offers and adopted no projection, so the page is composed
at request time from the reads that measurement covers.

- **It COMPOSES and does not decide.** Identity is #56's, the order and the
  labels are #74's, an offer's terms are #57's, freshness #68's, condition
  #90's, badges #55's. What #71 adds is three decisions — the partition, the
  withheld-offers branch and the outbound seam — and
  `product-page-isolation.test.ts` fails the build if a module here starts to
  rank, order, write, name a currency or reach commercial standing. It scans the
  STOREFRONT files too (#92's precedent: the storefront has no test runner).
- **The composition is server-side because the JOIN is what goes wrong.**
  `/offers` is a keyset page in a DIFFERENT order, so a client joining it to
  `/offer-comparison` drops whichever ranked offer fell outside its window —
  silently, as a hole in the comparison. `rankOfferComparison` already returns
  both halves; serving them together is the only place the join cannot be wrong,
  and it is where the seller identity each row needs is batched.
- **One offer, ONE group, and a highlight is a POINTER.** The partition is by
  CONDITION first (#90 never blends segments), with verified official standing
  splitting the `new` segment. An official store's REFURBISHED offer therefore
  lands under refurbished with its badge intact, an `authorized_reseller` is not
  `official_direct` (#55 keeps them separate), and `condition_unknown` is its
  own group — folding it into `new_retail` tells a shopper an unlabelled feed
  item is factory-sealed.
- **`cheapest_new` is a #74 LABEL this issue added**, awarded exactly as
  `cheapest_used` is (lowest known item price in one condition segment, from the
  tie-broken order). A page picking one itself would be a second comparison
  outside the versioned policy, unattributable to any impression.
  `OFFER_LABEL_KIND` landed with it: #74 documented the comparison/standing
  distinction and no code could read it, and deriving it from a label's spelling
  is a string rule that rots on the first rename.
- **Withheld is not empty.** `ProductPageOffers`'s withheld branch has no rows,
  no policy and no currency to read, so a deployment with
  `CANONICAL_OFFER_COMPARISON` off cannot render as a product nobody sells.
  `excludedCount` is the COUNT and never the list — "why is my offer missing" is
  a seller's question `/offer-comparison` answers, and a shopper's page carrying
  it would publish one seller's refusal to every other seller's customers.
- **The outbound handoff FAILS CLOSED, and #67 is closed-but-unbuilt.** Issue
  #67 (the `/out/:token` redirect) was auto-closed by a keyword in #66's PR body
  (commit `7e22da6`) and the code does not exist. The page discloses the
  destination HOST — a hostname is not a link and carries no parameters — and
  refuses the handoff, because a raw link asserts at RENDER time what only a
  click can establish (#68's `assertOfferOutboundEligible` exists for exactly
  that) and discards the relationship an `affiliate` offer exists under.
  Building the redirect here would be #37's route without the token, the click
  record, the bot handling or the open-redirect defence.
- **An external row carries no variant id and no listing id**, so #71 acceptance
  3 is a shape rather than a check; the native branch carries both and is
  switched on the DERIVED checkout verdict, so a native offer never gets an
  outbound branch either.
- **A variant-scoped page is a different READ, not a filtered one** — the
  comparison cannot contain another configuration's offer (acceptance 4) — and a
  configuration belonging to another product is REFUSED rather than ignored,
  because ignoring it silently widens the page to everything.
- **The MOUNT is behind `CANONICAL_PUBLIC_ROUTES_ENABLED`** (the blunt lever
  `/canonical-products` uses — this page serves canonical identity) and the MODE
  gate lives in the HANDLER (#70's reason: `shadow` must compute both
  answers), with the COHORT check there too — the first handler to call
  `canonicalReadPermitted`, which `read-mode.ts` always intended. The shadow
  comparison counts eligible OFFERS against ACTIVE NATIVE LISTINGS read through
  `native_listing_links`: a DIFFERENT route, because measuring one table twice
  is a check that cannot fail. #71 adds NO lever of its own.
- **A brand and a family are NAMED and not linked; a MERCHANT is LINKED** to
  `/merchants/[idOrSlug]` as of #252, in both places the page names one (the
  offer row's seller and a brand's verified channels), by its `slug` — `not
  null`, unique forever, and kept by a merged tombstone (D12). Everything here
  was named rather than linked for ONE reason, that the storefront route did not
  exist, and #73 shipped the merchant page, so that reason expired for merchants
  and not for the other two: `/brands/[handle]` now resolves but the page's
  `brand` is a vendor LABEL rather than the canonical entity, so linking it needs
  a canonical handle on the projection. `typedRoutes` is ON
  and INERT here — a dead `router.push` compiles, ships and fails under a
  shopper's thumb. This issue proved it by shipping one (`/settings/support`),
  so WALL 6 of the isolation test now walks the real `app/` tree and fails the
  build on any literal navigation target that does not resolve. Reporting
  PRODUCT DATA goes to feedback, not abuse reporting: `ABUSE_REPORTED_TYPES` has
  no `product` member, because a canonical product is Mercaria's own catalogue
  record and a wrong specification is #59's correction rather than moderation.
- Analytics: `product_page_view` and one `offer_impression` per served offer
  (carrying `rankingPolicyVersion`), both server-side. `variant_selected`,
  `offer_expanded`, `offer_selected`, `external_outbound_click`, `save_action`,
  `alert_action` and `sell_yours_entry` are NOT emitted — every one is a fact
  only a browser knows and the storefront has no analytics client; deriving them
  server-side would be fabrication (a variant-scoped READ is a deep link as
  often as a selection). They are #111's, with #107's and #109's client facts.
- Seams, each named rather than stubbed: **#37/#67** (the redirect;
  `ProductPageOutbound`'s `outbound` branch is a MERCARIA path by type, so
  nothing here can become a tracked URL), **#41** ("Sell yours" and nearby
  pickup — `best_nearby_pickup` is never awarded while #93 publishes no
  collection point, so the control is ABSENT rather than dead), **#79/#39**
  (price alerts), **#80** (a per-product save READ — until one exists the save
  control is a one-way idempotent SAVE, because a toggle over an unknown state
  un-saves on the first press), **#75** (public routes, the HTTP 301,
  `rel=canonical`, structured data; `/products/:id` is untouched, which is
  acceptance 7), **#111** (the storefront analytics client), **#72** (the BRAND
  page — it has shipped and this page still does not link it, for the vendor-label
  reason above; #73's merchant page is no longer a seam, it is linked, see #252).
## Product and variant price alerts (#79)

`services/price-alerts/` (10 modules) + `db/priceAlerts/` (5 repositories) +
`db/schema/priceAlerts.ts` (5 tables) + `/price-alerts` (buyer) and
`/internal/price-alerts/*` (operator), plus the storefront's
`app/(app)/price-alerts.tsx` and `@mercaria/ui`'s `PriceAlertCard`. Full
reference: **`docs/price-alerts.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"Price alerts (#79)". #78 records what a source
said; #74 decides which offers may be shown; this is one buyer saying "tell me
when it goes under this" and the machinery that makes telling them happen
EXACTLY once.

- **The trigger key names FOUR facts and no clock** — alert, offer,
  OBSERVED-PRICE VERSION (`offer_price_snapshots.id`) and alert policy version —
  and `price_alert_triggers_identity_key` is rendered from exactly those
  columns. A key without the observation fires once and never again; a key with
  a TIMESTAMP fires on every sweep. A qualifying price with NO observation
  BLOCKS (`no_observed_price_version`) rather than triggering with a NULL, which
  Postgres treats as distinct in a unique index. The convergence is the
  DATABASE's: `ON CONFLICT DO NOTHING … RETURNING`, whose empty result IS the
  "already notified" answer, because a read-then-write lets two workers both see
  "no".
- **The comparison is a RE-RUN of #74 immediately before triggering**, through
  #57's and #74's own functions — so a restricted listing, a lapsed source
  contract, a suppressed merchant and an unquotable currency are all refused by
  the domains that own them. **This domain defines no TTL, no staleness rule and
  no freshness lifetime**, and a scanned gate says so: "an old price cannot fire
  a new alert" is already true of anything obtained through
  `mayAppearInComparison`.
- **Unknown never satisfies anything**, three ways: a `known_total` is answered
  from #74's `OfferComparisonTotal`, whose unknown branch has NO amount; an
  `in_stock` requirement needs a POSITIVE statement (most feeds publish none);
  and a minimum quantity needs a published one. A `known_total` alert and an
  `item_price` alert therefore behave differently on exactly the offers whose
  postage nobody published — acceptance 2, held by the type.
- **Evaluation is driven by durable OFFER-CHANGE events and the enqueue is
  free.** The two offer-write chokepoints enqueue in the SAME transaction, and
  the first statement is a GATE: one indexed `exists` for the offer's product,
  so a catalogue nobody watches writes no row. The queue is ONE row per PRODUCT
  with `offer_outboxes`' revision pair — a convergence queue, which is issue
  abuse rule 2's batch fan-out expressed as an enqueue.
- **Four repeat policies, and the armed question is TWO TIMESTAMPS.**
  `once | reset_threshold | cooldown_better_low | always`; a `reset_threshold`
  alert is armed when `rearmed_at > last_triggered_at`, and the re-arm runs on
  EVERY evaluation because an alert re-arms on a price that did NOT qualify.
  `cooldown_better_low` needs BOTH halves — elapsed AND materially better (1%,
  floored at one minor unit) — and either alone is what the rule prevents.
- **Evaluation and DELIVERY are separate durable jobs, and the direction that
  matters is the reverse of the usual one**: a delivery retried a hundred times
  re-reads the delivery row and never the price, so acceptance 6 is a property
  of the IMPORT GRAPH (a scanned gate). The delivery id is
  `sha256(trigger + ':' + channel)`, deterministic, so a repeat converges.
- **A withheld notification leaves a ROW.** Before sending, the offer is re-read
  through #74's OWN `evaluateOfferEligibility`; a failure is `suppressed` with
  `destination_no_longer_eligible`, terminal, counted — because "how many did we
  withhold" is issue operations 3's stale-link measurement and a table of
  messages that were SENT cannot answer it. Quiet hours DEFER (evaluated in the
  buyer's IANA zone with `Intl`, never an offset) and never drop.
- **The notification carries NO URL of any kind** — the canonical product, the
  qualifying variant and the offer id, and nothing that could be a
  now-unvalidated destination (notification 3). The payload is an allow-list
  walked at RUNTIME against `PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS`. The
  product NAME is absent too: the composition is pure and a stale name in a push
  payload is the field that goes wrong silently.
- **`email` is representable and UNSENDABLE.** Mercaria has no outbound mail
  transport and stores no address for an Oxy buyer; the registry in
  `services/price-alerts/transport.ts` is EMPTY and every attempt fails
  `transport_unconfigured` visibly with the row intact (#108's decision, quoted
  there). The opt-in column, the queue row, the retry, the failure code and the
  operator metric all exist and all work.
- **Nobody can ask who is watching a product.** No route, no operator handle and
  no repository function takes a product, a merchant or an account; the one read
  by product exists because the evaluator must have it. Issue abuse rule 6 is
  held by the question being unrepresentable, and `price_alerts_subject_idx` is
  composite-and-partial so it cannot serve one either.
- **A MERGE rehomes and a SPLIT pauses.** `merge-plan.ts` gains an `alerts`
  phase (a new member of `CatalogMergePhase` AND `CatalogSplitPhase`); every
  scope column `repoint`s (a scope on a tombstone matches no offer and the alert
  silently stops firing) and triggers are `retained_by_tombstone`. The
  provenance stamp runs BEFORE the generic rehomer, scoped to the LOSER, because
  afterwards "the alerts that just moved" is indistinguishable from "the ones
  always there"; the phase then enqueues an evaluation for the WINNER. A split
  MARKS and PAUSES — #80's decision plus one thing more, because an alert on the
  wrong side of a split would actively notify.
- **#80's `ProductSavePriceAlert` seam is CLOSED**, and the supported branch
  carries no alert id, no target and no subscription state: reading one would
  mean the saved-list domain importing this one, which
  `product-save-isolation.test.ts` still refuses. The saved list says the
  capability exists and the client asks `/price-alerts` what the buyer has set.
- Env: `PRICE_ALERTS_ENABLED` (the buyer MOUNT, default false),
  `PRICE_ALERT_EVALUATION_ENABLED` (the evaluation LOOP, default false),
  **`PRICE_ALERT_NOTIFICATIONS_ENABLED`** (issue operations 5's GLOBAL kill
  switch independent of alert storage — default TRUE, unlike the two rollout
  levers, because an incident lever that ships off is a feature nobody notices
  is missing), plus the two abuse caps and the loop tunables. **NOT ONE of the
  three gates a durable record**, and a scanned gate says so. Operator surface
  is on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list — two reads and one
  write, and the write drives the existing idempotent evaluation.
- Seams, each a named contract that fails closed: **an outbound mail transport**
  (one `registerPriceAlertEmailTransport` call plus a decision about where the
  address comes from), **#93** (`nearby_pickup` is in the tuple, the column and
  the CHECK; the write schema refuses it BY NAME and the evaluator blocks with
  `proximity_scope_unsupported`), **#68's `requestPriorityRefresh('alerted')`**
  (published and deliberately not called — the queue is fed by offer WRITES, so
  an alert never needs a re-read to be CORRECT; what it would buy is latency on
  a slow-cadence source, which nobody has measured), **#77** (no analytics event
  is emitted), **#71** (the product page's own "watch this price" control), and
  **#81** (a watchlist is a different thing and this domain has no field for
  one).
## Trustworthy price signals and merchant competitiveness (#82)

`services/price-signals/` (11 modules) + `db/priceSignals/` (4 repositories) +
`db/schema/priceSignals.ts` (4 tables) + `/price-signals` (public),
`/merchant-competitiveness/*` (merchant) and `/internal/price-signals/*`
(operator), plus `@mercaria/ui` `lib/price-signal-labels.ts` (the copy). Turning
#78's immutable observations and #74's eligible offers into CLAIMS about a price.
Full reference: **`docs/price-signals.md`**; schema decisions:
`db/schema/CONVENTIONS.md` §"Price signals (#82)".

The failure mode that shapes it is a CONFIDENT LABEL COMPUTED OFF NOTHING: a
"historic low" that is one retailer's decimal-point error, a "good price" from two
observations rendered exactly like one from two hundred, a "lowest ever" that
blends the used copy into the new one, and a syndicator republishing one
merchant's offer five times so a market of one reads as a market of five.

- **THREE states, and the middle one is the one people collapse.** `measured`
  carries a value AND its evidence; `unmeasured` carries a reason and NEITHER
  (#74's `RankingSignalOutcome` device); between them is `not_present`, which
  means the derivation RAN over a sample that cleared every floor and the
  condition does not hold. Reporting that as `unmeasured` tells a merchant their
  data is too thin when it is fine; reporting it as `measured` with a zero tells a
  shopper there was a drop of nothing.
- **Every published figure is a #78 `PriceHistoryValue`, never a bare `Money`.**
  #78 made the FX basis a discriminant so a consumer cannot render a converted
  figure without seeing that it was converted; flattening it at the last hop would
  undo that at the hop a shopper actually reads.
- **The outlier rule is a CONJUNCTION — a modified z-score AND a relative
  floor — and each half alone is wrong.** The z-score alone deletes every real
  discount on a TIGHT market: measured here, twelve retailers within 2% give a MAD
  of ten minor units and a genuine half-price sale scores a modified z of 33, so
  "recent low" would report everything except the sale it exists to report. The
  relative floor alone deletes a legitimate low on a VOLATILE market. Together
  they are statistical policy 6's distinction between a sale price and a scale
  error — #78 reached the same place with `PRICE_SCALE_SHIFT_FACTOR`. **When MAD
  is ZERO nothing is an outlier**, or the naive implementation excludes every
  price that is not the mode, which fires exactly where a catalogue is healthiest.
  An outlier is NAMED in the evidence, never deleted.
- **Deduplication runs BEFORE outlier detection, and it is keyed on the SELLER.**
  Reversed, five syndicated copies of one wrong price form their own cluster, pull
  the median to themselves and make the CORRECT prices the outliers — the failure
  deduplication exists to prevent, arriving through the door marked "robust
  statistics". An offer whose seller cannot be identified is EXCLUDED rather than
  given a key of its own: a per-offer fallback inflates the distinct-seller count
  in the one direction that makes a weak sample look strong.
- **Nothing interpolates.** The median of an even sample is the LOWER middle value
  and a quartile is nearest-rank, so every published figure is a price somebody
  actually charged and traceable to one immutable row.
- **No built-in policy, which is the deliberate divergence from #74.** No active
  version ⇒ every signal is `unmeasured`/`no_active_policy`. A ranking must
  produce SOME order or the comparison surface has none; a claim about a price
  need not be made at all. **And no `canary`**: a ranking canary shows two
  shoppers two ORDERS, a signal canary would show them two contradictory CLAIMS
  about one price. Version comparison is a `candidate_comparison` RUN — every
  number, no shopper.
- **`PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR` is a CHECK and the reason is NOT
  disclosure.** Every offer read here is one `/offer-comparison` already publishes,
  so an aggregate over them discloses nothing new. The floor exists because the
  WORD has to mean something: a "market median" over two sellers is one rival's
  price wearing a statistical name. `goodPriceBelowMedianBps >= typicalBandBps` is
  a CHECK for a sharper reason — overlapping thresholds make one price satisfy
  both verdicts, decided by comparison ORDER in the code rather than by the row.
- **The merchant surface is gated by #83's verified claim and is NOT a seventh
  allow-list.** An unclaimed merchant, a pending claim, a revoked one and a caller
  who is somebody else all answer the SAME 404. `MerchantCompetitivenessRow` has
  no competitor id, name or price — gated statically AND by a realdb walk of a
  REAL emitted response (#92's two-gate rule) — and this domain reads NO
  buyer-side data at all, which is why #77's suppress-below-ten posture has
  nothing here to apply to.
- **`price_signal_evaluations` is a RECORDING, never a cache**, and a scanned
  gate fails the build if a read path selects from it: the inputs live on tables
  in four other domains, and a cached "good price" survives the moderation
  restriction and the rights withdrawal that should have withdrawn it. Its counter
  CHECKs SUM by EQUALITY (#60's vacuity floor) and the metrics report
  `signalsFromRecords` beside the run's own counter with `countsAgree`.
- **Isolation is a test, in BOTH directions.** No module under
  `services/ranking/` may reference this domain (acceptance 6 — a measured
  position is one join from "merchants who price aggressively rank higher"), and
  this domain may reach #74 only through the ADMISSION half (`eligibility.ts`,
  `facts.ts`, `money.ts`) and never the policy, the score, the labels or the
  dominance detector — #74's own narrowing of #55's gate, reused.
- **The CSV export renders exactly the rows the JSON carries**, and every cell
  guards a leading `=`/`+`/`-`/`@`: a spreadsheet reads those as a FORMULA and
  every value here comes from a catalogue somebody else writes.
- Env: `PRICE_SIGNALS_ENABLED` (the measurement LOOP),
  `PRICE_SIGNALS_PUBLIC_READS_ENABLED` (the buyer MOUNT) and seven bounds. **Not
  one threshold that decides what a signal MEANS is in the environment** — every
  one is a `price_signal_policy_versions` column, versioned and frozen once it
  serves, because acceptance 4 asks that a signal be reproducible from immutable
  observations and a POLICY VERSION and a number read out of the environment is
  reproducible from neither. Operator surface on the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, mounted while the sweep is off and
  while nothing is published.
- **One real bug the realdb suite caught on its first run:**
  `activatePriceSignalPolicyVersion` superseded the incumbent of whatever
  `PRICE_SIGNAL_POLICY_KEY` names rather than of the target row's OWN key. The
  partial unique is per key, so the supersede left the real incumbent standing and
  the activation failed on the index. The two spellings agree today; the column
  exists because a second comparison surface with its own policy is foreseeable.
- **The one thing #82 asks for that Mercaria cannot measure, stated rather than
  stubbed:** product-level DEMAND (competitiveness item 4). `resolveProductDemand`
  answers no data and the insight is `unmeasured`/`demand_measurement_unavailable`.
  #77 defines no product-level demand metric — its twenty-two definitions are
  search, funnel, conversion and coverage rates, none keyed on a canonical
  product, and `analytics_rollups` has no product dimension. The two substitutes a
  later reader reaches for are both wrong: `product_save_aggregates` (#80) counts
  an intent to return rather than demand and carries its own disclosure floor and
  ranking wall, and `analytics_search_queries` (#77) is a phrase rather than a
  product with a hard floor of twenty-five.
- Other seams, each named rather than stubbed: **#71** (the canonical product page
  that renders these — the API, the copy and the accessible summary are complete
  and nothing in the storefront consumes them), **#40** (the merchant dashboard
  screens — every endpoint they need exists, including the export, the filters and
  the keyset paging), **source/category label distributions** (properties of the
  OFFERS behind a signal, not of the signal, so copying them onto every evaluation
  row would be a denormalized second representation), **`taxInclusion`** (an
  offer-side column belonging to #57, which #74 waits on too) and **#79** (alerts).
## Private watchlists and currency-safe basket tracking (#81)

`services/watchlists/` (8 modules) + `db/watchlists/` (3 repositories) +
`db/schema/watchlists.ts` (4 tables) + `/watchlists/*`, plus the storefront's
`app/(app)/watchlists/` and `components/watchlist/`. Full reference:
**`docs/watchlists.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Private watchlists (#81)". A GROUPING with a purpose — a PC build, a nursery —
plus the bounded, reproducible record of what that group cost at the moments it
was evaluated.

`product_saves` (#80) is NOT forked and NOT extended. A save answers "did this
buyer save this product"; a watchlist answers "what would this SET cost me right
now". They share no row, no counter and no aggregate, and a scanned gate fails
the build if a module here reaches the save domain.

- **A total names ONE currency and ONE basis, or it is not a total.** Every
  amount is converted by #74's comparison before this domain sees it, each
  carrying its own `FxRateSnapshot`; `composeWatchlistTotal` REFUSES a line in
  another currency rather than skipping it — skipping is the quiet exclusion the
  issue exists to prevent, wearing a defensive check's clothing. The basis
  belongs to the WHOLE total: `delivered_total` only when EVERY contributing line
  knows its delivery, else `item_price` for all of them. "Delivered where known,
  bare price where not" is a figure that is neither, and it is the one a buyer
  would mistake for what they will actually pay.
- **The selection intent is `cheapest`, and that is a decision.** A watchlist
  tracks COST, so the selection key has to be cost; `balanced` would put a number
  on the page that no ordering of the offers explains.
- **An item that could not be priced is REPORTED, never dropped.** Nine reasons,
  each a fact the evaluation read, and `no_eligible_offer` (the buyer's own
  filters) is never collapsed with `price_not_convertible` (nothing they can do)
  — reporting the second as the first sends somebody to loosen a filter that was
  never the problem.
- **Three of the item states are DERIVED and one is stored.**
  `product_unavailable`, `product_merged_into_existing_item` and
  `preferred_variant_retired` are computed at evaluation time from
  `canonical_products`/`canonical_variants` — the
  `deriveNativeCheckoutEligibility` divergence — so a merge or a suppression
  bites with no sweep having run. Only `ambiguous_after_split` is stored, because
  a split is a decision a job took at a moment and the two candidates exist as a
  pair only in that job.
- **Nothing claims a multi-store optimum.** `WatchlistBasketOptimization` has ONE
  branch and it is the unperformed one; `WATCHLIST_FORBIDDEN_CLAIMS` names six
  sentences a surface may never render, and the gate scans the backend AND the
  storefront screens in RAW source — comments included, because a claim in a
  comment is a sentence somebody pastes into a screen next week. #42 owns the
  optimization.
- **The LIST is the concurrency unit.** `watchlists.version` is a
  compare-and-swap carrying `oxy_user_id` in the same predicate, on every
  mutation including item ones; a mismatch is `WATCHLIST_VERSION_CONFLICT` (409),
  whose remedy is mechanical. A per-item token would let a reorder computed
  against one membership be applied to another.
- **A reorder is TOTAL or refused.** "These three go first" is ambiguous the
  moment two of the rest share a position, and the ambiguity is invisible.
- **Evaluating is a READ and recording is a WRITE.** `GET .../basket` stores
  nothing; `POST .../snapshots` records one, deduplicated on a `content_digest`
  compared against the LATEST snapshot under a `FOR UPDATE` lock. The digest
  covers the LINES, not only the total: two items moving by equal and opposite
  amounts leave the total exactly where it was, and a history that deduplicated
  that would show a flat line through the week both prices moved. A dedupe is a
  SUCCESS.
- **`material_changes` is never empty** (`cardinality(...) >= 1`, never
  `array_length`, which is NULL on `{}`) and `policy_version_changed` is the kind
  to read: a different #74 policy can select a different offer at unchanged
  prices, so a total that moved across one is NOT attributable to the items — and
  the DIFF refuses to attribute it, by name, as it does across a currency or
  basis change.
- **The snapshot line shape needed THREE CHECKs and the third was found by the
  realdb suite**: a `priced` biconditional and an `unresolved` biconditional both
  read false for an unresolved line carrying a price, so the obvious pair admits
  exactly the row item rule 7 forbids.
  `watchlist_snapshot_items_unresolved_empty_check` closes it with
  `num_nonnulls` over all fifteen columns.
- **A snapshot is APPEND-ONLY against UPDATE and DELETE is PERMITTED** — the
  `analytics_events` posture, because erasure on a schedule IS the retention
  policy and a trigger refusing DELETE would make the sweep fail silently.
  `selected_offer_id` carries NO foreign key: `offers` CASCADEs from `listings`,
  so one would delete the history correction rule 5 exists to keep.
- **Privacy is absence.** One member on `WatchlistVisibility`; no share token, no
  follower, no demand aggregate (counting how many private lists hold a product
  is `product_save_aggregates`' question at a different grain, with a floor
  already); no analytics emission at all; `note` in `PROTECTED_COLUMNS` so it
  cannot reach a snapshot row; only `watchlists` carries an account id, so an
  erasure is one scoped DELETE. **No operator surface and no seventh allow-list**
  — none of the six should read a private list, and every repair is a path the
  owner already drives.
- Env: `WATCHLISTS_ENABLED` (default false; gates the MOUNT and never the rows),
  `WATCHLIST_SNAPSHOT_PAGE_SIZE`, `WATCHLIST_EVALUATION_CONCURRENCY`.
- Deferred with named seams, none of them a stub that lies: **#42** (the
  multi-store optimization), **#79** (price alerts — `WatchlistItemPriceAlert`
  has one branch and it is the unsupported one, and no schema carries a field to
  ask for one; the TARGET amount is the half that is representable today),
  **#94** (item-level template semantics — a template supplies a name, an icon
  and a description and names no products), **#78** (the price CHART; this domain
  compares against its own basis-matched snapshots, which answer a different
  question about a different subject), **#71** (the product page each row links
  to).

## Natural-language shopping intent (#95)

`services/search-intent/` (13 modules incl. the benchmark) + `db/searchIntent/`
(2 repositories) + `db/schema/searchIntent.ts` (4 tables) + `POST /search-intent`
+ `/internal/search-intent/*`, plus `@mercaria/ui`'s `SearchInterpretation` and
the storefront's `app/(app)/search.tsx`. Turning ordinary language into #94's
validated constraint set and #70's deterministic retrieval. Full reference:
**`docs/search-intent.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Natural-language shopping intent (#95)".

- **The deterministic interpreter is the FLOOR, not a degraded mode**, and that
  is a fact about the call graph: `plan.service.ts` builds the deterministic
  draft FIRST, unconditionally, and a model may only produce a SECOND draft that
  is merged into it — filling gaps, never replacing, widening or removing (every
  merge branch is an "if the deterministic pass produced nothing here"). So a
  provider regression costs coverage and can never cost correctness, and a
  deployment with no provider — which is every deployment, since nothing
  registers one — has a working natural-language search box.
- **A model produces a CANDIDATE and four independent mechanisms bound it**: the
  type has NO id field of any kind (so a product, variant, offer, merchant or
  brand id is unrepresentable rather than refused); it carries no price,
  availability or specification VALUE; the schema is `.strict()` so an
  undeclared key is refused rather than stripped; and every key, unit, enum
  value and currency must resolve against #94's live registry.
  `INTENT_FORBIDDEN_MODEL_OUTPUTS` (10) is DISJOINT from
  `INTENT_CANDIDATE_ELEMENTS` (10) by a test. **Only four of the ten are
  SCANNED for** — the other six have no field capable of expressing one, so a
  check for them would be one that can never fail, which reads as coverage.
- **Hard constraints are never silently weakened, and the translation is TOTAL.**
  #94 can express `ne`, `not_in`, an exclusive bound and an "any of" group;
  #70's `SearchFilters` can express none of them. Every hard constraint is
  assigned an `IntentEnforcementSite` — `retrieval_filter`,
  `constraint_evaluation` or `unenforceable` — and an `unenforceable` one
  REFUSES the plan naming itself. `constraint_evaluation` is not a downgrade
  (identical three-valued outcome, same `missingDataPolicy`); it costs retrieval
  efficiency. `known_total` lands there because #70's price filter compares the
  OFFER price, and answering it with that filter would answer a different
  question.
- **The paraphrase is COMPOSED and has THREE voices.** No field on the result
  could hold model prose. `IntentElementOrigin` (`user_explicit` /
  `deterministic_rule` / `model_inferred`) travels on every element so the
  renderer can say "you asked for", "we read" and "we guessed" — clarification
  rule 6 made structural rather than reviewed.
- **An unresolvable term is REPORTED, never dropped or approximated.**
  `unsupported_by_retrieval` is the one to read: understood COMPLETELY and
  unenforceable, which is a different failure from not having understood it. A
  nearby request is exactly that (#93 supplies no pickup state and #70 has no
  proximity parameter), so it is reported rather than accepted-and-ignored.
- **A numeric BOUND is hard; a bare magnitude is a preference.** "At least 16 GB"
  excludes; "16 GB laptop" is descriptive and reading it as hard removes every
  32 GB machine. The asymmetry has a direction — promoting a leaning excludes
  products the shopper would have bought. A hard requirement on an attribute
  #94 marks `hardConstraintCapable: false` is degraded AND reported.
- **The interpreter REFUSES rather than guessing in four places**: a magnitude
  whose unit fits several attributes and whose words name none (`14 inches`), an
  ambiguous grouped number in a language with no decimal convention on file
  (`1,299`), an ambiguous currency symbol (`$`, `¥`, `kr` — `€ £ ₹ zł R$ ⊜` each
  name one and resolve), and a brand or merchant name (resolution is an EXACT
  normalized-name lookup returning exactly ONE row; two is an ambiguity).
- **Attribute names come from the REGISTRY's own localized labels**, and the
  NEAREST match wins with length as the tie-break. Nearness is load-bearing and
  was measured: `16 GB de memoria y almacenamiento de al menos 512 GB` puts both
  words inside the first magnitude's window, and a longest-match rule reads
  `16 GB` as STORAGE — so the query asks for storage twice and never mentions
  memory.
- **A preference's importance is an ORDINAL RANK, never a weight.** A weight
  would be a second, unversioned ranking authority arriving through the search
  box; #74's policy versions are the only place one may live, and a scanned gate
  fails the build if this domain reaches `services/ranking/`.
- **Clarification is bounded three ways** — a KIND at most once per session
  (which is why the vocabulary is closed: two phrasings of one question are one
  kind), at most 2 ROUNDS per SESSION (a per-request bound is no bound), at most
  2 questions at once. "Search anyway" is the client not sending an answer;
  there is no endpoint for it, which is what guarantees a clarification can
  never block a search. An answer is applied as an INPUT to the interpretation
  rather than as an edit to its output.
- **No raw query text is stored anywhere in this domain and no column could hold
  one.** Rule 3 ("preserve the original query") and safety rule 7 (#77's
  redaction and retention) pull opposite ways; rule 7 wins and rule 3 is
  satisfied client-side, where the original already lives — the shopper typed
  it, the share-safe URL carries it, and a clarification answer re-submits it.
  The URL carries the QUERY and never the session id or the answers.
- **Acceptance 8 needed NO change to #77's domain.** `search_intent_turns`
  carries the mode, the reason, the counts and `query_event_id` — #77's own
  correlation handle, which authorizes nothing — so the two halves are joinable
  and each is swept on its own clock.
- **Two tables, four CHECKs worth knowing**: the session's owner biconditional
  per actor kind; the turn's `(mode = 'deterministic') = (fallback_reason is not
  null)`; the enablement's NOT NULL COMPOSITE foreign key onto the run's
  `(id, dataset_digest)` (acceptance 7 as a constraint — the
  `match_category_gates` device); and TWO partial uniques on the enablement,
  because Postgres treats NULLs as DISTINCT and a NULL `category_id` IS the
  language-wide row.
- **The benchmark is a GATE, content-addressed.** Twelve case classes, five
  languages, an in-memory registry so the whole set runs in CI on every push.
  The DIGEST is what makes acceptance 7 real: editing a case invalidates every
  recorded threshold until somebody re-measures.
  `INTENT_BENCHMARK_FLOOR_MEASURES` states each measure's DIRECTION as data —
  reading `false_hard_constraint_rate` as a floor would enable the parser
  precisely when it is inventing requirements — and CI asserts that rate at
  exactly ZERO for the deterministic interpreter.
- Env: `NL_INTENT_ENABLED` (default false — the MODEL half only),
  `NL_INTENT_BLOCKED_COHORTS` (a BLOCK list, `<MARKET>:<language>`, naming
  NOBODY — there is no per-person bucket anywhere in this domain),
  `NL_INTENT_PARSE_TIMEOUT_MS`, `NL_INTENT_SESSION_TTL_SECONDS`. **There is
  deliberately NO lever that turns the surface off** — the deterministic path is
  the floor, so one would withdraw a working feature for no benefit. Its own
  rate-limit bucket (`rl:search-intent:`, keyed on the ACTOR), because a parse
  may call a provider and a search does not.
- Operator surface `/internal/search-intent/*` on the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62/#68/#70/#78
  use, mounted while the model half is off. The route set is CLOSED: no
  "interpret this query as X", no "pin this attribute", no "add a synonym", no
  "set the weights" — every one would be an interpretation rule outside the
  versioned rules and the benchmarked model.
- **The model provider is a NAMED, FAIL-CLOSED seam.** Nothing registers one, no
  API key lives here and no provider dependency is installed; closing it is one
  module implementing `ShoppingIntentParser` plus one
  `registerShoppingIntentParser` call, and nothing else in #95 changes. A
  provider never throws its way to a fallback (`refused`/`failed` members), and
  the DEADLINE is the caller's — a provider that hangs is exactly the case a
  provider-supplied timeout does not cover.
- Seams left, each failing closed: **#93** (proximity is `unenforceable`;
  nearby is reported), **#74** (ranking, a scanned gate), **#96** (it reads the
  same `ConstraintSet`), **#71** (an interpretation names no product), and FOUR
  clarification kinds that are DEFINED and not produced today
  (`missing_unit`, `requirement_strength`, `entity_disambiguation`,
  `condition`) — none arises from a reading the deterministic interpreter makes,
  a model may name them, and `selectClarifications` drops a question with fewer
  than two options so a half-built one is silently invisible rather than
  visibly missing.
## Guest checkout from an individual seller (#112): the gate and its decision

`services/guest-p2p/` (5 modules) + `controllers/guest-p2p-operator.controller.ts`
+ `@mercaria/shared-types` `guest-p2p.ts`, plus the `guestCheckout` annotation on
`CartGroup` and the two call sites in `checkout.service`. **NO new tables and NO
migration.** The dated decision is
**`docs/guest-p2p/2026-08-10-guest-p2p-checkout-decision.md`** and its outcome is
**no-go**: ADR 0003 D18 and ADR 0006 G18 excluded guest P2P at launch, #112
evaluated the reversal, and the exclusion stands.

- **There is no feature flag, and that is the decision rather than an omission.**
  `GuestP2PAuthorization` has no member meaning yes (the `GuestSellerActivation`
  and `LIVE_REFUSED_UNTIL_GATED` device), so no configuration, operator action or
  service bug can enable it. D18 anticipated "a config flag whose flip is a
  decision recorded on #112"; this IS that record, its answer is no, and a switch
  whose flip would enable an unapproved scope is the dormant switch #105 refused.
  The flag arrives WITH the approval, in the change that adds the second member.
- **The gate runs TWICE and the second call is the load-bearing one.** At group
  construction (before any reservation) and again immediately before
  `openCheckoutPayment`, over the CREATED ORDERS rather than the planned groups —
  so acceptance 6 ("a mixed cart cannot accidentally charge an ineligible P2P
  group") is a property of the charge, not of the plan. Refusing there needs no
  new failure handling: a `CheckoutRefusal` is a `MercariaError`, the orders stay
  `pending_payment` holding their reservations, and the sweep releases them.
- **`openGatedCheckoutPayment` is the ONE place `checkout.service` opens a
  payment, and that is structural rather than remembered.** The service reaches
  `openCheckoutPayment` from exactly one line;
  `checkout-payment-gate.test.ts` counts it and fails the build on a second.
  Review caught the reason it matters: the payment-stage gate first sat INLINE
  beside the fresh-path call, while the Redis idempotency fast-path and the
  unique-violation converge both reach the rail through `summarizePriorGroup` —
  which opens the same payment for a group it did not create, and skipped the
  gate. Harmless only while the authorization is a build-time constant, and
  precisely what a `go` decision would turn into a real hole.
- **ONE reason code (`p2p_seller_excluded`) and it names only the `user`
  groups** — the mixed cart's remedy is the existing `sellerKeys` deselection,
  and a refusal that named a criterion would be a switchboard a client could read
  out one input at a time.
- **`assertGuestSellerTypesAllowed` is GONE from `fulfilment-eligibility.ts`** (a
  clean cut, #105's one-clause version), and that module no longer takes an actor
  at all — the seller TYPE is decided in exactly one place.
- **Twenty published criteria, and two of the three outcomes BLOCK.**
  `satisfied | refused | unevaluable`; `unevaluable` names who would supply the
  input and is never a soft yes. A census test fails the build if a criterion is
  published and never evaluated, or evaluated and never published.
  `eligibility.ts` imports no repository (the `getRetailEligibility` rule, a
  scanned gate); `facts.ts` is the module that reads, and it defaults nothing.
- **The bounded scope is a CODE CONSTANT** (`GUEST_P2P_BOUNDED_SCOPE`), not a
  table and not an environment variable: a pilot's bounds are a published policy
  somebody signs, so widening them is a commit with an author and a date. Its
  category allow-list is EMPTY, which permits nothing (grant semantics, not the
  unrestricted-when-empty kind).
- **Two findings are facts about this repository, not risks**, and they are why
  the answer is no rather than "insufficient data": a P2P order has NO refund
  path for any actor (`orderHasRefundPath`, named by #110), and a P2P seller has
  no surface to answer a cancellation, return or support thread on (every
  merchant route is behind `requireStorePermission`). Do not remove either
  citation without re-running the decision.
- **`GUEST_P2P_FORBIDDEN_CRITERIA` names ten inputs that may never decide
  eligibility**, disjoint from the criterion vocabulary by a test: a public buyer
  identity, a reusable handle, a Trust score Mercaria computed about a guest, a
  card fingerprint, an email domain, paid placement, a ranking penalty for guest
  status, an auto-created Oxy account, off-platform contact and seller
  self-attestation.
- **Visible before checkout:** `CartGroup.guestCheckout` carries the same verdict
  checkout enforces, ABSENT for an Oxy owner (never `available`), and the
  storefront replaces that group's checkout button with a sign-in path. The
  whole-cart button then places only the checkout-able groups —
  `/checkout?seller=` accepts a comma-separated list for exactly that.
- Operator surface: `/internal/guest-commerce/p2p/*` on the SAME
  `GUEST_OPERATOR_OXY_USER_IDS` allow-list #104/#108/#109/#110 use, READ ONLY and
  two routes. There is deliberately no "authorize this seller", no "waive this
  criterion" and no "enable the pilot": approving a bounded scope is a dated
  decision, and a route that could grant one would be a way around the record.
  The trace opens from a LISTING id, so "what did this guest try to buy" is
  unaskable.
- Seams, each named in the decision document with what would close it: **#43**
  (CLOSED — ADR 0001 already assigns an individual payee's unrecoverable
  chargeback to Mercaria and bounds it with nothing; what is owed is an
  amendment adding a reserve, a payout delay or an exposure limit), **#85**
  (the P2P policy-acceptance surface — the one `unevaluable` criterion), **#93**
  (every pickup and meetup fact; the fulfilment criterion answers `unevaluable`
  for a pickup destination and BLOCKS), **#110** (the P2P refund path and the P2P
  seller surface), **#111** (the guest cohort this decision would have measured),
  **#91** (condition refinement, so evidence measures sellers rather than a
  missing feature).


## Merchant and storefront pages (#73, ADR 0002 D3/D4/D8/D9/D10)

`services/merchant-pages/` (7 modules) + `db/merchantPages/` (1 repository) +
`controllers/merchant-pages.controller.ts` + `middleware/merchant-page-schemas.ts`
+ three routes on `routes/merchants.ts`, plus the storefront's
`app/(app)/merchants/[idOrSlug].tsx` and `components/merchant/`. Full reference:
**`docs/merchant-pages.md`**. **NO new tables and NO migration** — the whole
domain is a projection, the #92 shape taken for the #57 reason.

- **Two channel lists, because marketplace-ness is a COMPARISON.**
  `operatedChannels` is `storefronts.merchant_id`; `sellingChannels` is the
  channels this merchant's own offers sit on, each naming its operator, with
  `operatedByThisMerchant` carrying ADR D8's comparison already made. A page
  with ONE list has to pick a side and is wrong for half the merchants — a
  retailer's country sites are channels it OPERATES, a marketplace seller's are
  somebody else's.
- **Three catalogue scopes, and `channel_all_sellers` is acceptance 2.** It
  shows every seller's offers on one channel, each keeping its own
  `merchantId` and `sellerRole`, and it is permitted ONLY for a channel this
  merchant operates: somebody else's channel is somebody else's page.
- **The native store is a LINK, and the alternatives are DISJOINT VALUES.**
  `MERCHANT_NATIVE_STORE_PRESENTATIONS` has one member;
  `MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS` names `redirect` and `embed`.
  A redirect would make the merchant route unreachable and the merchant would BE
  the store; an embed would be a second rendering of what the store APIs own.
  **The ONE follow identity is protected by ABSENCE** — no module in the domain,
  in EITHER package, may name `ensureFollowTarget`, `registerFollowKind`, a
  follow hook or button, or the `mercaria.store`/`oxy.user` kinds, which covers
  native-store rules 3 and 6 with one gate.
- **The page WRITES NOTHING**, which is why native-store rule 5 needs no merge
  policy. No INSERT, UPDATE or DELETE and no write service, asserted.
  `findLinkedStoreIdentity` selects THREE columns rather than calling
  `findStoreById`, which attaches the store's MEMBERS — reading and dropping
  them would leave the guarantee resting on a serializer.
- **Three brand states, not a badge and its absence.**
  `no_verified_relationship` is a first-class answer with its own copy, because
  an ordinary retailer holds no relationship row at all (D10) and rendering
  silence leaves a reader unable to tell "we checked" from "we have not looked".
  Built from the union of #55's verified badges and the brands the merchant's
  current offers actually cover — neither set alone can produce all three.
- **Safe public language is a CLOSED four-member vocabulary** derived from two
  already-public facts. No member can mean "a claim was rejected", "an operator
  is reviewing evidence" or "N people are claiming this". A verified claim
  outranks a squatter's live one, or a claimed merchant would read as
  "claim in progress" and get a claim button.
- **ONE rating, scope-labelled, and NONE on a card.**
  `MerchantCatalogEntry` has no rating field and
  `MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS` names five as values a gate scans
  for. The storefront renders `MerchantProductCard` rather than `ProductCard`
  precisely because the latter's `ProductSummary` REQUIRES `rating`.
- **The order is a FACT and the dedup is a `group by`.**
  `max(last_seen_at) desc` — the order `offers_merchant_browse_idx` was built to
  serve — with the product id as tiebreak, which is not optional because one
  ingestion page stamps one `last_seen_at` across every offer it writes.
- **The keyset timestamp is EXACT epoch microseconds, never a JS `Date`.**
  postgres.js truncates `timestamptz` to milliseconds, and in a DESCENDING
  keyset a truncated boundary SKIPS every row between the truncated and the true
  value. Nothing writes sub-millisecond `last_seen_at` today, which is exactly
  what would make it arrive later as "page two is missing products".
- **`stale_at` narrows and the live derivation decides** (#68), so a page may
  return fewer rows than its limit. The offer MIX is the one place counted on
  the stored deadline — projecting a merchant's whole offer set to count it is
  not affordable — which makes it an upper bound, stated in the DTO.
  `staleOfferCount` is the difference, and it is a fact about Mercaria's
  information rather than about the shop.
- **Three empty reasons**: `no_offers` | `stale_sources` | `filtered_out`. SQL
  having found products the live derivation then refused is `stale_sources`,
  because the filters demonstrably admitted them. A card with no current offer
  is DROPPED rather than rendered priceless.
- **#61's two unread indexes now have a reader, and it is PROVEN.** X01 was
  promoted from `EXPLORATORY_SHAPES` to Q25 (a shape whose reader arrives stops
  being exploratory), Q26 measures the channel scope so
  `offers_storefront_browse_idx` is proven rather than assumed, and Q27 measures
  the dedup browse with no required index on purpose (a `group by` ordered by an
  aggregate keeps its Sort). `graph-plan-regression.realdb.test.ts`
  mutation-tests Q25 by dropping the index in a rolled-back transaction. The
  exploratory floor in `workload.test.ts` came DOWN from 5 to 4 with the
  promotion named — a floor that could never drop would forbid the improvement.
- **Known gap, stated rather than quietly narrowed: `MerchantSummary` is still
  un-rehomed.** ADR 0002's glossary assigns re-homing that home-feed card DTO
  for a native STORE to #70–#73; #70 did not and #73 did not, because it is a
  twenty-file cross-package rename in a batch of fourteen parallel branches with
  no numbered requirement behind it. What #73 holds instead is the half that
  matters: the isolation gate fails the build if any merchant-page surface, in
  either package, imports it. The rename remains owed.
- Seams: **#67/#37** (`resolveChannelOutbound` refuses unconditionally and its
  refusal branch has no `url` property), **#74** (ranking — a scanned gate both
  ways), **#84** (the linkage flow; this page only READS `native_store_links`),
  **#71** (the product page a card links to).

## Location publication, nearby discovery and collection (#93)

`services/pickup/` (9 modules) + `db/pickup/` (5 repositories) +
`db/schema/pickup.ts` (8 tables) + `/nearby`, the publication and desk halves of
`/admin/stores/:storeId/{locations,orders}`, `/seller/listings/:id/local-discovery`
and `/internal/pickup/*`. Full reference: **`docs/pickup.md`**; schema
decisions: `db/schema/CONVENTIONS.md` §"Location publication and collection
(#93)". It REUSES the existing `Location`, `InventoryLevel` and POS domains and
adds no column to either — this is the PUBLIC face of a place plus everything a
handover needs.

It CLOSES four named seams and each was a fail-closed refusal: #105's
`assertPickupLocationEligible` (a clean cut — the function is GONE, not aliased),
#74's `resolvePickupProximity`, #108's `order_ready_for_pickup` message kind, and
#70's nearby filter, which was UNREPRESENTABLE and is now a contract change to
`SearchFilters`.

**Closing a seam means sweeping the COMMENTS that cited it, and that is where
the work was.** Six modules stated as fact that pickup was refused at checkout;
after #93 every one of those sentences was false, and a false sentence in a
comment is the one thing no gate catches. Three needed a real re-decision rather
than a re-word: #110's `pickup_not_supported` is no longer an unreachable branch
but its refusal STANDS (a buyer-driven cancellation would release a reservation
while a collection hold nobody has modelled stayed behind — #110's call, not
#93's); #91's sell-yours `offered` stays refused because #93 published a STORE's
shop front and a person has no publication to acquire; and **#112's
`fulfilment_method_permitted` moved from `unevaluable`/owner-#93 to `refused`** —
both block, so no checkout changes, but an operator trace no longer reports a
missing capability that has since arrived. Two seams that LOOK closable are not,
and their reasons changed rather than expiring: #95's proximity intent has no
ORIGIN (a request carries text and deliberately no coordinate) and #79's
`nearby_pickup` has nowhere to STORE one (`price_alerts` has no cell column, on
purpose — a durable alert holding a position is the standing record of where
somebody lives that request-local coarsening exists to avoid).

- **A separate publication row, with every address field OPTIONAL.**
  `locations` holds the address a pallet is delivered to; a publication holds
  what a merchant will have a stranger read, and "the city and nothing else" is a
  complete answer. Widening `locations` would have made the first naive
  `select().from(locations)` on a public route disclose a stockroom's street. It
  also makes the default right: a store with no publication row is not
  discoverable, which is the state every existing store is in.
- **The verdict is DERIVED and never stored** — the
  `deriveNativeCheckoutEligibility` divergence, over six tables in four domains
  this one does not own, so a moderation restriction stops a collection in the
  statement that applies it. `eligibility.ts` imports no repository and no
  configuration (#121's posture). The buyer never sees a REASON: given three
  published shop fronts, a per-reason answer lets a client read out a merchant's
  stock position one request at a time (`guest_rollout_blocked`'s reasoning).
- **Mercaria calls NO geocoding provider.** All three
  `LOCATION_GEOCODE_PROVENANCES` are merchant or operator acts;
  `LOCATION_FORBIDDEN_GEOCODE_PROVENANCES` names six prohibitions as VALUES,
  disjoint by a test, and the two worth reading are a position inferred from
  where BUYERS were or where parcels went. The consequence is stated: a merchant
  with no map pin cannot be discovered at all, and publishing without one is
  REFUSED rather than silently useless.
- **The coordinate CHECK refuses the NULL ISLAND.** `(0, 0)` is a real point in
  the Gulf of Guinea and is what every failed import writes, so a range check
  admits the commonest bad value there is and sorts it first for everybody in
  West Africa. Greenwich and Quito still pass — the refusal is the PAIR, and the
  realdb suite carries that fixture because a CHECK refusing either half alone
  would be refusing a merchant.
- **Freshness is the LOCATION's own declared interval, NOT NULL with no
  default** — #68's prohibition on a deployment-wide TTL, at the grain that
  varies. Pinned by a fixture pair with ONE age, TWO intervals and opposite
  verdicts; a shared TTL passes any single-interval fixture set.
- **A shopper's coordinate lives inside one function call.** It reaches PostGIS
  and is gone; what leaves is a COARSE CELL (0.1° ≈ 11 km) and distances rounded
  OUTWARD. Coarsening is not politeness — three exact distances to three public
  shop fronts solve for the shopper's position. The cell function is SHARED with
  P2P discovery, so a change to the cell size cannot apply to one and miss the
  other.
- **The manual fallback needs no gazetteer.** `GET /nearby/places` answers with
  the cities among published locations that actually hold the item, composed from
  the SAME `where` as the results — so a city offered there always yields
  something, and selecting one hands back a CELL CENTRE, so that path never sees
  a precise coordinate at all.
- **A collection reserves at the EXACT branch, through the EXISTING
  `reserve(variantId, qty, locationId)`** — race-safe at the location grain since
  the Mongo port, so the whole change was passing an id that was already a
  parameter. Three companions and none optional: `order_items.location_id`
  carries the branch (so `transition('paid')` commits and a refund restocks
  there), the rollback RELEASES at the same location (`release` with none routes
  to the DEFAULT, which would move stock between branches silently), and the
  snapshot commits in the orders' transaction.
- **The order's address snapshot comes from the PUBLICATION**, and the recipient
  is the literal word `Collection` — never a person. #105's invariant is
  unchanged: `destination.ts` still produces no address, and nothing fabricates a
  street from anything a buyer typed. The POS path has snapshotted the location
  this way since the Mongo port.
- **The collection code is DERIVED and never stored** —
  `HMAC(PICKUP_COLLECTION_CODE_KEY, orderId:version)` in a ten-character alphabet
  with `I`, `L`, `O` and `U` removed. A buyer can be shown it again, a rotation
  is `version + 1` and invalidates every copy at once with no grace window, and a
  dump discloses nothing. It is not the portal token (no `mg*` prefix, no
  resolver) and nothing looks an order up BY code — validation takes the order id
  the route already authorized.
- **The desk moves NO money and NO stock, and that is a scanned gate.** The units
  were committed when the order was PAID. Cancelling a collection does not cancel
  the order or refund anything; the order's STATUS is not moved either (#93
  pickup rule 12), and `shipped` was not reused because a parcel handed across a
  counter was never shipped. Every transition is a CAS — mutation-tested, and
  removing the predicate turns exactly the three acceptance-14 cases red.
- **Guest readiness reuses #107's `GUEST_SELLER_ACTIVATION_REQUIRED` rather than
  a parallel lever** — "is this merchant activated for guest checkout" already
  has one answer. `GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT` defaults OFF, and
  that is the honest default rather than the lax one: #108 ships with an EMPTY
  transport registry, a buyer reaches their order through the PULLED confirmation
  grant, and demanding a transport unconditionally would make guest collection
  unreachable on every deployment that exists.
- **A P2P seller's precise position is UNREPRESENTABLE** —
  `listing_local_discovery` stores cell INDICES and has no coordinate column, so
  the rule holds for serializers nobody has written and for `psql`. The write
  accepts a precise pair because a client that rounds badly would otherwise be
  the only thing between a seller's home and a public response; the server rounds
  and has nowhere to put the original.
- **Store guest pickup can never become P2P guest pickup** (acceptance 13).
  `derivePickupEligibility` refuses a `user` seller for EVERY actor, and
  `assertGuestSellerTypesAllowed` refuses a guest at group construction. #93 asks
  for four rollout flags; the fourth is deliberately ABSENT, which is stronger
  than one defaulting off — a dormant switch reads as a decision already taken,
  and #112 owns the reversal.
- Env: `NEARBY_DISCOVERY_ENABLED`, `STORE_PICKUP_ENABLED` (requires
  `PICKUP_COLLECTION_CODE_KEY` — the half-configuration rule),
  `GUEST_STORE_PICKUP_ENABLED` (additionally requires store pickup, one-way),
  `P2P_LOCAL_DISCOVERY_ENABLED`, `GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT`.
  **No lever gates a durable record** — a scanned gate. Operator surface on the
  SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, mounted while the nearby lever
  is off: the evidence has to be readable during the incident that turned
  discovery off. READ plus ONE write, and there is no "set this position", no
  "publish this location" and no route returning a code.
- **The GiST index over `geo_point` is asserted to EXIST, because no functional
  test could ever miss its absence.** Every `ST_DWithin` case returns the same
  rows against a sequential scan — just slower, which is invisible at fixture
  scale and catastrophic at catalogue scale. `pickup.realdb.test.ts` reads
  `pg_indexes` for that ONE index name, asserts the row count FIRST (so "I found
  no index" cannot be what a pass looks like) and asserts `USING gist`
  specifically — a btree over a `geography` column is created without complaint
  and cannot serve the operator at all. Mutation-tested by renaming the index in
  the migration: exactly that test goes red and all 39 functional cases stay
  GREEN, which is the whole argument for having it.
- **The realdb suite caught a real driver bug on its first run.**
  `coalesce(${column}, ${date})` in a `sql` template throws in postgres.js before
  the server sees the statement — the documented bare-`Date` trap — and `tsc`
  accepts it while a mocked update binds nothing. Fixed with
  `${iso}::timestamptz`.
- **A new realdb file owes four house fixtures, and all four fired here.** Two
  append-only trails and a shared server make this file the shape every one of
  them is aimed at.
  - **ONE TABLE PER `withTriggerToggleLock` WINDOW**, with every statement on
    `tx`. The transaction is what makes a throw safe (on the pool the DDL
    autocommits, so a throw before the re-enable leaves the trigger off for the
    rest of the run and every later file asserting it refuses a write passes
    vacuously) — but the one-table rule is a SEPARATE property the mutex cannot
    provide: `DISABLE TRIGGER` takes ShareRowExclusive, whose counterparty is an
    ordinary writer holding RowExclusive, and the mutex only serialises window
    against window. This file's first version held both tables in one window and
    `cd6e8fd`'s census caught it. Split, never reorder to match a writer.
  - **Stores go through `deleteTestStores`, canonical rows through
    `deleteTestCanonicalRows`**, which DECLINE exactly the ids a sibling's
    `match_decisions` pins rather than deleting somebody else's row.
  - **No fixture may carry a date the real clock is still travelling toward** —
    the subtle one, because a closure has to span the 7-day open horizon, so the
    fix was moving the injected CLOCK back a week rather than extending the
    closure forward.
- **The CLIENT half is built** (`docs/pickup.md` §16): `@mercaria/ui`'s
  `lib/pickup-labels.ts` + `NearbyLocationCard` + `PickupCollectionPanel`, the
  storefront's `components/nearby/` + `app/(app)/nearby.tsx` + the pickup
  branches of checkout, the order detail and the guest portal, and the
  dashboard's `PickupDeskCard`. Twelve of the fourteen client rules are met
  outright; rule 6 gets two of its three sorts and rule 7 gets the shared
  component without the two list surfaces (both below).
  - **BROWSE and BUY are two modes of ONE component** (#93 client rule 7). The
    product page mounts `NearbyAvailability` WITHOUT `withCheckoutEligibility` —
    nearby rule 12, a page view must not spend per-location eligibility work —
    and `/nearby` mounts the same component with it, which is why only that
    screen offers "Collect here". A browse surface offering one would be a
    promise made without the answer.
  - **`describeBuyerPickupBlock` is where §2's "the buyer never sees a reason"
    is actually held.** `checkoutEligibility` is the one place block reasons
    reach a client, so the collapse to ONE sentence is a pure function in
    `@mercaria/ui` rather than each screen's discretion; the per-reason copy is
    exported beside it and is MERCHANT-facing. Sign-in is offered only when
    EVERY reason is guest-specific, or client rule 10's "optional benefit"
    becomes an account prompt in front of a shop that would refuse an account
    holder too.
  - **The city picker sits BESIDE the device control, and a refusal REMOVES that
    control rather than leaving one that re-prompts.** Both halves are the
    anti-dark-pattern decision; offering the manual path only after a denial
    makes a shopper decline a prompt to discover it exists.
  - **The buyer's coordinate never leaves the screen** — no param, no store, no
    analytics, and `queryKeys.nearby.availability` is keyed on the COARSE CELL
    because a React Query key is read out by every devtools panel. `?pickup=`
    and `?pickupName=` carry a merchant's own PUBLISHED shop front, which client
    rule 14 does not cover and which has to survive a reload and a bank redirect
    (rule 11).
  - **Client rule 6's "best overall" is NOT met, deliberately.** Nearest (the
    server's own order, rendered untouched) and lowest price are both FACTS; a
    blend of the two composed on a client is a second, unversioned ranking
    authority. The nearby endpoint applies no #74 policy at all, and
    `best_nearby_pickup` is still never awarded on the product page because
    `/p/:handle` accepts no viewer coordinate — closing #74's seam gave the
    ranking a distance it can use and no surface that passes one.
  - **Rule 7's component is SHARED but `/search` and the watchlists do not mount
    it.** Both are LISTS, and a nearby section per row is one request per row
    against an endpoint keyed on a position. The request shape is what stopped
    it, not the component.
  - **The native permission prompt is unexercised.** `useNearbyOrigin` answers
    `unsupported` on native (no location dependency is installed) and the manual
    picker is a complete path without it, so the feature works — but nothing has
    been verified against a real iOS or Android dialog.
- **WALL 6 could not see a route built in a HELPER, and now can.** It read the
  argument of `router.push`/`router.replace`, so a screen composing its href in
  a `buildHref` function handed it a variable and the gate skipped it silently —
  which is how `/p/...`, the most-linked route in the storefront, was never
  gated. `returnedRouteTargets` closes it, scoped to the `app/`/`components/`
  entries because the `lib/` ones are API clients whose template literals are
  SERVER paths. Mutation-tested by renaming `app/(app)/nearby.tsx`: four
  assertions go red, and the restore is byte-identical.
- **A new storefront screen owes the SEO route map a decision.**
  `seo-routes.test.ts` fails the build on a screen in neither the public
  registry nor `NON_PUBLIC_SCREENS`, and `seo-robots.test.ts` then requires the
  static `packages/frontend/public/robots.txt` to agree with
  `SEO_ROBOTS_DISALLOWED_PATHS` EXACTLY, order included — two artefacts, one
  list. `/nearby` is not public: its whole content depends on an origin a
  crawler does not have, so it is one page per canonical entity per POSITION.
- Deferred with named seams, none of them a stub that lies: **#85** (the
  activation state, reusing #107's lever), **#110** (buyer cancellation of a
  collection order stays `pickup_not_supported`, which is #110's own decision and
  still fails closed), **#116** (a `mercaria_retail` collection — `OfferKind` has
  no such member), **#111** (the guest rollout review), **#112** (guest P2P), the
  storefront screens above, and a place-name gazetteer, which
  `GET /nearby/places` answers around rather than with.
## Merchant activation readiness and native-checkout onboarding (#85)

`services/merchant-activation/` (9 modules) + `db/merchantActivation/`
(3 repositories) + `db/schema/merchantActivation.ts` (3 tables), plus
`/admin/stores/:storeId/activation*` (merchant, `store:manage`),
`/seller/activation/policies` (individual seller) and
`/internal/commerce-graph/activation/*` (operator). Full reference:
**`docs/merchant-activation.md`**; schema decisions: `db/schema/CONVENTIONS.md`
§"Merchant activation (#85)".

- **The verdict is DERIVED and never stored** — the `deriveNativeCheckoutEligibility`
  (#57) divergence, for `deriveChannelReadiness` (#87)'s reason: the inputs sit
  on ELEVEN tables in eight domains, and a stored verdict would be a twelfth
  representation going stale the instant Stripe restricts a seller. What IS
  stored is what somebody DECIDED (a policy accepted, a checkout paused, an
  operator's hold) plus what the derivation was OBSERVED to say.
- **Two DISJOINT registries, because guest is not a stronger native.** #85 says
  it twice, and the guest registry's first member is `native_checkout_ready` —
  so guest is narrower by CONTAINMENT rather than by an extra threshold on
  somebody else's verdict. `requirements.ts` is a `Record` over the key union, so
  a requirement published and never evaluated fails `tsc`.
- **`unevaluable` is Mercaria's gap and NAMES its owner** (#112's vocabulary);
  `unsatisfied` is the merchant's. Both withhold, and they route to different
  places — one is a build somebody owes, the other a form to fill in. Exactly one
  is `unevaluable` today: `guest_transactional_contact_operational`, owner #108,
  which is why guest checkout reads **`ineligible`** rather than `disabled` on
  every deployment. `ineligible` beats `disabled` beats `paused`.
- **`paused` means the merchant's own switch is the WHOLE of what is wrong.**
  Otherwise a merchant reads "paused" while a Stripe restriction is the real
  cause and un-pausing changes nothing.
- **Ten capabilities, each naming its dependencies, and TWO carry `null`.** A
  store is not an individual seller, so the P2P pair is `not_applicable` — an
  empty list would grant them, a full list would withhold them forever with no
  remedy. `refund_and_return_operations` deliberately does NOT depend on the
  checkout requirements (readiness-change rule 3: yesterday's order stays
  refundable), and `deriveCapabilities` THROWS on an unevaluated dependency
  (#74's `rankOffers` rule).
- **The onboarding flow has NO progress record**, which is what makes "resume on
  another client" true: progress IS the authoritative state, so there is nothing
  to reconcile — and acceptance 5's three no-duplicate guarantees are already
  indexes in #84, #87 and #46. A census asserts every requirement is covered by
  exactly one step OR named in `STEPLESS_REQUIREMENTS` **with a reason**.
- **The checkout gate is NARROW and runs at 4f-bis.** Three things — an operator
  hold, the merchant's own pause, and #88's deferred fee ACCEPTANCE gate — and
  nothing else: refusing on a connector's bad night would take a working store
  off sale. It sits immediately after checkout's own `selectFeeSchedule` because
  the acceptance that matters is of the schedule THIS order will snapshot;
  selecting again would be a second selection that could answer differently. It
  reads two rows per store and calls the SAME pure predicates the full registry
  calls. A deployment with no active schedule is unaffected (#88's honest zero).
- **ONE new refusal reason, `seller_not_activated`**, for all three levers — the
  `guest_rollout_blocked` decision on the authenticated path, because a client
  varying one input at a time could otherwise read out whether a merchant is
  under an operator HOLD, which is a moderation fact about somebody else.
  Deliberately not `seller_not_payment_ready` (cannot be PAID vs has not been
  ACTIVATED) and not `guest_seller_not_activated` (the same word about the GUEST
  conjunction).
- **#107's `#85` seam is CLOSED.** `GuestSellerActivation` gains `activated`, and
  it means the guest CONJUNCTION holds — there is still no column anybody can set
  to it, which is ADR 0006 G14's "no per-merchant opt-in list" surviving intact.
  `GUEST_SELLER_ACTIVATION_REQUIRED` still decides whether the question is asked
  and still defaults OFF; the early return keeps the default path free of a
  database read. A `user:` seller answers `not_activated`, always.
- **#112's `policies_accepted` criterion is CLOSED** by
  `POST /seller/activation/policies`, whose row carries `owner_type = 'user'` —
  the polymorphic owner is what lets somebody with no store and no `store:manage`
  accept. Accepting it does NOT make guest P2P available: #112's decision is a
  recorded no-go and `GuestP2PAuthorization` still has no member meaning yes.
- **Policies are a CODE CONSTANT** (`MERCHANT_ACTIVATION_POLICIES`), the #126
  terms decision. Bumping a version schedules a re-acceptance; withdrawing
  consent is a NEW version, never an UPDATE — the table is append-only against
  UPDATE *and* DELETE.
- **Transitions are OBSERVED, not hooked.** Stripe restricting an account, a
  connector failing and a jury restricting a catalogue are all activation
  transitions with no actor, and none of those domains knows this one exists —
  eight callers that must all remember is seven ways to have an unaudited
  transition. Every merchant/operator write observes in the same request; the
  rest is the sweep (`system`, actor NULL, a biconditional CHECK). The
  observation runs AFTER the write commits: calling it inside deadlocks against
  the settings row the write already locked (#59's merge-runner failure), and a
  crash between the two loses an AUDIT ROW and never a decision.
- **The operator surface is the SAME `CATALOG_OPERATOR_OXY_USER_IDS` list**
  #54/#55/#83/#84 use — deciding whether a merchant may operate is that gate's
  power one step later. The route set is CLOSED: no "activate this store", no
  "set this capability", no "mark this requirement satisfied". A trace opens from
  a STORE ID and nothing else. The merchant sees THAT a hold exists and never its
  REASON, which is an operator's note about a moderation finding.
- Env: `MERCHANT_ACTIVATION_TEST_ORDER_REQUIRED` (default false — there is no
  launch plan requiring a test order, and blocking by default would make the
  requirement refuse the very order that satisfies it; it is always DERIVED and
  always reported), `MERCHANT_ACTIVATION_OBSERVATION_ENABLED` (the sweep LOOP)
  and its tunables. **Neither gates a durable record and neither gates a
  surface**, and there is deliberately no `MERCHANT_ACTIVATION_ENABLED`:
  activation is a derivation over state eight other domains own, so a flag would
  not stop those facts being true, only stop anybody being told.
- Migration `0076` (`pre`): three tables, two append-only trigger pairs, and one
  WIDENING of `analytics_events_reason_code_check`.
- Seams, each failing closed: **#108** (the transport — the one `unevaluable`),
  **#111** (a positive rollout cohort, the storefront affordance, the guest
  analytics events; `guest_cohort_enabled` reads the block list ADR 0006 G14
  already decided on rather than claiming a cohort model that does not exist),
  **#93** (pickup is excluded from the guest fulfilment set at the SOURCE, so it
  cannot satisfy a requirement with a path that refuses at checkout), the TEN
  test-order scenarios (eight need an external account or an unbuilt capability;
  `test_order_completed` is the derivable half), and #88's schedule-change
  NOTIFICATIONS and downloadable breakdowns.
- **Acceptance 1 is NOT met and `docs/merchant-activation.md` says so**: no
  Stripe account, no connected store and no real connector install has been
  exercised — #69's own acceptance 7, still open. Nothing here may be read as
  evidence that one has.
## The referral attribution edge (#143, ADR 0005 D3–D6 / A1–A4)

`services/referrals/{traffic,referral-state,redirect.service,binding.service,controls.service}.ts`
+ `db/referrals/programControlRepository.ts` + `db/schema/referrals.ts`
(`referral_program_controls`) + `GET /r/:token`, `/referrals/*` and
`/internal/referrals/*`. Full reference: **`docs/referral-attribution.md`**.
#142 shipped the MODEL with **no HTTP surface at all**; this is the edge a
stranger reaches.

- **The design turns on two rules that together forbid both shortcuts.**
  ADR 0005 D6 stores a guest touch against #103's checkout scope; ADR 0003 T10
  says a page view never mints one. A link click by a stranger IS a page view,
  so the click's EVIDENCE travels with the browser and the TOUCH is written at
  the first moment there is a subject. An anonymous click writes no row, a
  crawler writes no row, and a real shopper's touch lands on the very session
  D6 names. Deferring is not a workaround for the conflict — it is the only
  reading under which both rules hold.
- **The destination cannot come from the request, as a SHAPE.** Nothing on the
  path accepts a URL: the target is a configured origin that must be in
  `lib/allowed-origins.ts` plus a relative path from #142's closed four-member
  template. The route reads NO query parameter, so "arbitrary campaign
  injector" is inexpressible rather than filtered, and `campaignRef`/
  `contentKey` go on the TOUCH and never into the URL. Hostnames compare
  EXACTLY (a suffix test admits `mercaria.co.evil.example`) and the URL is
  built with `new URL`, because concatenation admits `//evil.example`.
- **302 + `no-store` + `Referrer-Policy: no-referrer`, and the alternatives are
  wrong.** A `301`/`308` is permanently cacheable, so a browser that stopped
  asking would keep following a REVOKED link, stop spending the click ceiling,
  and make the operator lever inert.
- **Every refusal is the same 404** — unknown token, forged signature, expired,
  revoked, ceiling spent, redirect lever down. A distinguishable answer
  enumerates which programs exist and which are paused.
- **The classifier reads three self-declared headers and CANNOT become a
  fingerprint**: `User-Agent`, the fetch-metadata purpose headers, and #77's
  existing `ANALYTICS_INTERNAL_TRAFFIC_TOKEN` (reused — two ways to say "this
  is us" would disagree about staff traffic). No IP, no TLS fingerprint, no
  `Accept-Language`, no stored state; the signature takes headers and returns a
  value. A crawler that LIES is classified `organic`, which is the safe
  direction — the answer to it is D17's velocity thresholds (#148), not
  behavioural inference. A classification NEVER changes the destination, or the
  redirect would be cloaking; it decides only whether a click is claimed and
  evidence produced. A non-organic click spends NO click against the partner's
  ceiling.
- **The carrier is `mrf_`, stateless, and authorizes nothing.** Its payload is
  `{linkId, codeId, clickedAt, exp, nonce}` — no user id, session id, order id
  or scope list, so there is nothing an authorization check could read (ADR
  0005 A1 as a property of the type). Its key is `REFERRAL_STATE_SECRET`, a
  SECOND key: the link token is published by a partner and public by design,
  and one key for both would make a leak of the public half a mint for the
  private one. The window anchor is INSIDE the signature, so presenting it
  again cannot extend the window. `clickedAt` is epoch SECONDS and truncation
  rounds DOWN — a carried click can only look older, never jump ahead of a code
  typed in the same second.
- **`touchActorFor` is the one subject translation**, a `switch` over
  `CommerceActor`, which has no common `id` field — so `pending` is an ordinary
  answer and an anonymous visitor cannot acquire a subject.
- **A click that ALREADY has a subject is resolved completely at click time**,
  through the same `attributeRecordedTouch` every bind uses — two places
  deciding whether a recorded touch becomes a winner would be two answers to
  the attribution lever. The first shape of that branch recorded the touch and
  STOPPED, which is silently wrong: no carrier is issued when a subject is
  present, so `/referrals/bind` would have nothing to present and a signed-in
  buyer's click would sit unattributed forever with every gate green. Found by
  re-reading the branch, not by a failing test; now mutation-verified.
- **Session rotation is structural, not a merge rule**: #103 swaps `token_hash`
  IN PLACE, so the `guest_sessions` ROW id an attribution names never moves.
- **Two operator levers, independent, on a table keyed by the STABLE
  `program_id`** — never on the version row, whose terms an attribution has
  pinned (D19). Absence means BOTH ENABLED. `redirect_enabled=false` stops the
  link while a typed code still attributes; `attribution_enabled=false` stops
  new winners and **still records the touch** (D18: gate loops, never records).
- **`REFERRAL_OPERATOR_OXY_USER_IDS` is its own allow-list**, distinct from the
  payments, catalog, guest, analytics, retail and procurement ones, because the
  power is: pausing attribution stops partners EARNING. #147 and #148 inherit
  it rather than adding another. THREE routes and the set is CLOSED — no
  "attribute this subject to that partner", no "create a touch", no "extend
  this window", no delete; the trace opens from an attribution id and nothing
  else. Mounted while the levers are down and `REFERRALS_ENABLED` is off.
- **Mercaria operates NO consent framework** — no CMP, no stored record, no
  jurisdiction table. `consentMode` is a client DECLARATION, recorded verbatim
  and acted on in exactly one way: `denied` writes no carrier. Web declares at
  BIND time because a top-level navigation can set no header and the route
  takes no query; native may declare at click time.
- **Six scanned walls** (`referral-attribution-isolation.test.ts`, vacuity floor
  + mutation self-test both directions): no payment rail, no ranking, none of
  the fourteen `REFERRAL_FORBIDDEN_IDENTITY_SIGNALS`, no guest-session
  issuance, no commerce write path, no analytics emission — plus "only
  `redirect.service.ts` may construct a `URL`". It caught a REAL false positive
  on its first run: `body.redirectEnabled` (the lever, a boolean) tripped the
  request-derived-destination detector, so the pattern gained a `\b` and both
  directions are pinned.
- **A merge does NOT rehome a standing attribution**, and that is stated rather
  than quietly narrowed. #142's `recordSubjectMerge` keeps history on its own
  reference and resolves only NEW touches through the redirect, which its own
  realdb file pins. WITH a post-merge touch — the normal course for a merchant
  referral, which converts at activation (D11) — the partner keeps credit on
  the survivor; WITHOUT one the pre-merge row stays `active` on the retired
  reference and is unreachable by resolution. `correctAttribution` is the
  existing audited repair; changing the merge to supersede would redefine
  semantics #142 ships and tests.
- Env: `REFERRALS_ENABLED` (the MOUNT of `/r` and `/referrals`, never a record)
  requires BOTH `REFERRAL_LINK_TOKEN_SECRET` and `REFERRAL_STATE_SECRET`, plus
  `REFERRAL_REDIRECT_BASE_URL` and `REFERRAL_OPERATOR_OXY_USER_IDS`.
- Seams, each failing closed: **verified universal links / App Links** (the
  frontend declares no `associatedDomains`, no `intentFilters` and no Apple
  Team ID, and none exists without a signed app-store build — so Mercaria
  serves NO association file and a link opens in the browser, which is native
  rule 7's fallback; a fabricated one would claim a verification that is not
  real and a custom scheme is what native rule 9 excludes),
  **deferred deep linking** (`ReferralDeferredDeepLinkSupport` has ONE member,
  the `GuestP2PAuthorization` device — `GuestSellerActivation` was the same
  device until #324 supplied #85's capability and added `activated` in the same
  change, which is how this one should end too), **a consent
  framework**, and **the client surfaces** (#147 — every endpoint they need
  exists and nothing consumes them yet).
## Saved shopping agents (#97): a standing instruction that can only ever LOOK

`services/shopping-agents/` (14 modules) + `db/shoppingAgents/` (6
repositories) + `db/schema/shoppingAgents.ts` (8 tables) + `/shopping-agents`
(shopper) and `/internal/shopping-agents/metrics` (operator), plus the
storefront's `app/(app)/shopping-agents.tsx` and `@mercaria/ui`'s
`ShoppingAgentCard`. A shopper saves a structured OBJECTIVE, Mercaria
re-evaluates it when the catalogue moves, and tells them once. Schema
decisions: `db/schema/CONVENTIONS.md` §"Saved shopping agents (#97)".

- **The whole domain rests on ONE `solveBasketRequest` call, and that is what
  keeps it from becoming a second comparison engine.** All six launch jobs are
  questions about the same object — the best plan for these lines under these
  constraints, right now — and #96 already answers each as a NAMED RESULT
  (`cheapest_known_total`, `used_or_refurbished_value`,
  `official_channel_plan`). So #97's deterministic half is a TRANSLATION of an
  agent into a `BasketRequest` plus a read of the result its kind names.
  Ranking is #74's, eligibility is #57's, constraints are #94's; nothing here
  ranks, prices, converts a currency or judges an offer.
- **The evaluation key is FOUR facts and NO CLOCK** — agent, agent REVISION,
  #96's `BasketInputSnapshot.digest` and the policy version. That digest is a
  hash over the request, every candidate offer with its price and delivery
  terms and every FX rate, which makes it #79's `observed_price_version` one
  layer up: an unchanged catalogue reproduces it and the finding converges on
  `ON CONFLICT DO NOTHING … RETURNING`; a moved price mints a new one.
  Mutation-tested — adding `Date.now()` to the key turns exactly the
  idempotency case red.
- **An agent cannot buy anything, and that is FIVE independent things.** The
  six job kinds are DISJOINT from sixteen forbidden ACTIONS; no column in the
  eight tables names an order, a cart, a checkout object, a payment method, a
  card or a merchant's terms (a gate walks the real drizzle tables);
  `.strict()` schemas refuse an undeclared key; `refuseForbiddenAgentAction`
  is mounted BEFORE the schema and answers with the exact prohibition it found
  rather than "Unrecognized key"; and `shopping-agent-isolation.test.ts` scans
  the whole domain directory — plus the storefront, #92's reason — with a
  vacuity floor and a mutation self-test per detector. **The gate found four
  real things on its first run**, two of them in its own detectors: a pattern
  anchored on `services/` never sees the RELATIVE `'../payments/x.js'` every
  module here would actually write (#125's finding, repeated), and a bare
  `checkout` column pattern forbids `native_checkout_eligible`, which is the
  information #97 notification 4 asks a shopper to be given.
- **`terms_version` is MERCARIA's own agent terms and can never be a
  merchant's** — accepting a merchant's or a supplier's terms is a forbidden
  action, so the column detector was narrowed to `merchant_terms` rather than
  `terms`. A wall that forbids the word forbids the fact.
- **A model may only summarise a finding that is ALREADY STORED, and that is
  the SIGNATURE.** `summarizeStoredFinding` takes a finding id, so a provider
  cannot be consulted before a verdict exists; the package it is shown carries
  no owner, no agent name, no description and no location; the draft it returns
  has no field for a price, a product or a verdict; and the validator refuses a
  citation the finding never minted, a numeral the finding does not contain and
  any purchase language. Nothing registers a provider — the deterministic
  TEMPLATE is the summary, not a fallback (#97 acceptance 7).
- **Three-valued outcome, and only `qualified` may notify.** `incomplete`
  carries at least one reason and NO objective value (a CHECK), and
  `mercaria_shopping_agent_notification_requires_qualified` — a TRIGGER,
  because the invariant is CROSS-ROW — refuses a notification for anything
  else. Mutation-tested: with the trigger dropped, the identical insert is
  ADMITTED.
- **`cardinality`, never `array_length`.** Measured again here: with
  `array_length(trigger_sources, 1) >= 1` the empty array is ADMITTED
  (`array_length` is NULL on `{}` and a CHECK rejects only FALSE). Any future
  array-non-emptiness CHECK in this schema must be written the same way.
- **Findings, their lines and the audit trail are APPEND-ONLY against UPDATE
  and DELETE is PERMITTED** — the `analytics_events` posture, because erasure
  is one scoped DELETE that cascades and a trigger refusing it would make that
  fail silently. The ONE update a finding admits is `lifecycle` moving off
  `current`, checked by comparing the WHOLE TUPLE with the lifecycle
  normalised, so a "correction" cannot rewrite an amount under cover of setting
  a flag.
- **A split BLOCKS and a merge REHOMES.** `agents` is a new member of BOTH
  `CATALOG_MERGE_PHASES` and `CATALOG_SPLIT_PHASES` (the #79/#80 precedent),
  and `shopping_agents_ambiguity_blocked_check` refuses an
  `ambiguous_after_split` agent that is not `blocked` — the strongest form of
  the refusal to pick a side, because a save on the wrong side shows the wrong
  page once and an AGENT on the wrong side goes on notifying on its own
  schedule. `resolve-split` is the only way out of `blocked`; a client cannot
  write `enabled` over one.
- **Triggers and evaluations are TWO durable jobs.** The trigger queue is one
  row per canonical PRODUCT (the fan-out, bounded by
  `triggerFanOutLimit` — a popular product cannot starve every other job, and
  the row converges so nobody it did not reach is dropped); the evaluation
  queue is one row per AGENT. Both are `offer_outboxes`' convergence shape with
  `FOR UPDATE SKIP LOCKED` leases, an owner check, capped backoff and a visible
  `dead_letter`. The enqueue's first statement is one indexed `exists`, so a
  catalogue nobody watches writes no rows.
- **A withheld notification leaves a ROW** with a coded reason, which is what
  makes #97 cost rule 6's duplicate suppression countable — a table of messages
  that were SENT can never answer how many were not. Quiet hours DEFER rather
  than drop (a release with `failure: null`).
- **The operator surface is ONE route and returns only AGGREGATES.** There is
  no trace and none may be added: a saved agent is a person's intent in their
  own words, so "who is watching this product" is unrepresentable rather than
  refused. It is on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list and is
  deliberately NOT gated on `SHOPPING_AGENTS_ENABLED` — the queue lag has to be
  readable during the incident that turned the shopper surface off.
- **Explicit authorization is a COMPARISON, not a checkbox.** The client echoes
  back `shoppingAgentConstraintDigest` of exactly what it RENDERED and a
  mismatch is refused, on create AND on a constraint edit — so no search, save
  or watchlist path can mint an agent by accident (#97 privacy 2). A material
  edit bumps `revision`, which is in the evaluation key, so the answer to the
  old question can never silence the new one.
- Env: `SHOPPING_AGENTS_ENABLED` (the shopper MOUNT),
  `SHOPPING_AGENT_TRIGGER_ENABLED` and `SHOPPING_AGENT_EVALUATION_ENABLED` (the
  two LOOPS), all default false, plus **`SHOPPING_AGENT_NOTIFICATIONS_ENABLED`**
  (#97 evaluation 10's independent kill switch — default TRUE, because an
  incident lever that ships off is a feature nobody notices is missing), the two
  abuse caps and the loop tunables. **NOT ONE gates a durable record**, and a
  scanned gate says so.
- Seams, each a named contract that fails closed: **an outbound mail transport**
  (`registerShoppingAgentEmailTransport` is called by nothing; an `email`
  channel is storable and fails `transport_unconfigured` visibly with the row
  intact), **a summary provider**
  (`registerShoppingAgentSummaryProvider`, likewise — closing it is one module
  plus one call, and `summary.ts`'s validator is what makes that safe), **#70**
  (catalogue-wide DISCOVERY: an agent must name at least one canonical product
  today, because `CANONICAL_SEARCH` defaults `off` and a category-only agent
  would evaluate to `incomplete` forever), **#93** (proximity — no field exists
  to accept one), **#77** (no analytics event is emitted), **#86** (merchant
  demand), and the CREATE/EDIT screen (#97 UX 1 and 6 — every endpoint it needs
  exists, including the digest the confirmation rests on).
