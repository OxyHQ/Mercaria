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
  `marketSupported`, #122 supplies the source costs, #123 calls the lock and
  owns the `orders` widening, #128 BOOKS the variance this domain only
  classifies, #129 renders `presentation` + `blockReasons`.

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

## Shipping: Moovo, not ready

Shipping UI is HIDDEN everywhere. The backend retains only a seam (the
`order.shipping` snapshot, cost zero). Do NOT build shipping zones or rates;
Moovo owns that entirely.

## Backend domain model

One unified API (`packages/backend`) serves storefront, dashboard and POS.

- `Listing`, with ownerType `user | store`, including `ProductVariant` child
  rows.
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
- Deferred and NOT built here: #106 (the claim columns, `order_status_history`
  actor dimensions, and the widening of `orders_buyer_identity_check` — it
  WIDENS that constraint and the origin trigger rather than adding second
  ones), #107 (the guest Stripe client surfaces and the portal), #108
  (verification, magic links, transactional mail), #109 (claiming), #93
  (pickup), #112 (guest P2P).
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
- Set `PAYMENT_OPERATOR_OXY_USER_IDS` to the Oxy accounts that may reach
  `/internal/payments/*`. EMPTY is a working configuration and means the surface
  is not mounted at all — but it also means nobody can trace a payment, replay an
  event or run a repair, so it must be populated before the rail carries live
  money. Alerting and scraping for the metrics this exposes belong to
  `oxy-infra`; the full pre-launch list is `docs/payments.md`
  §"Production-readiness checklist".
