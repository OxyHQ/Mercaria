# Money and the ledger

Moved from the root `AGENTS.md`. Applies to anything that stores, converts or moves an amount.

- **The catalog stores NATIVE currency** and converts nothing; **`paid` converts
  NOTHING** — no FX call in `order.service.transition('paid')`.
- **`DualMoney { shop, presentment }`** carries every TRANSACTED amount, with an
  `FxRateSnapshot` that identifies the conversion completely; a later rate move
  can never alter a stored amount.
- **Every money column is `bigint({ mode: 'number' })`**, and `assertSafeMoneyAmount`
  is called at every construction boundary — `z.number().int()` alone accepts
  `1e300`.
- **Adding a `CurrencyCode` is a code change PLUS `bun run db:generate` PLUS an
  additive (`pre`) migration in the same PR.** Every currency column carries a CHECK
  rendered from the shared-types tuple, so skipping the migration makes the first
  write of the new code fail in production with a green build. It, or a condition
  key, also breaks every installed `@mercaria.co/sdk` — release that first.
- **The ledger is the ONLY record of Mercaria's commission** (ADR 0001 D3).
  `db/payments/ledgerRepository.ts` is its only writer and refuses an unbalanced set; a trigger raises on UPDATE and
  DELETE. A correction is a REVERSING transaction (no `reverseTransaction(id)`).
  Positive is a debit; every transaction sums to zero PER CURRENCY.
- **Nothing auto-deletes or rewrites financial history**; repairs are audited
  operator actions from a CLOSED set.
- **Peable is the only rail** (ADR 0009 D13): no provider SDK beside
  `PaymentProvider`; sellers are connected accounts, synced by READING one.
  A cart is ONE Peable Checkout Session offering FairCoin (ADR 0020).
