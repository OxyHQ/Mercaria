# Currency: multi-currency, provider-neutral, FAIR preferred

> Moved out of `AGENTS.md` unchanged. The hard rules a contributor must not
> violate stay there; this is the full model.


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

