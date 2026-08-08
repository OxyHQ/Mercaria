/**
 * Money DTO for the Mercaria.
 *
 * Amounts are represented as integer minor units (e.g. cents) to avoid floating
 * point rounding errors. `currency` is one of the codes supported by Mercaria.
 *
 * The six currency ROLES Mercaria distinguishes — no single code owns more than
 * the role it is configured for:
 *  - **Catalog currency**: the currency a price is entered and STORED in. The
 *    catalog never converts on write; a listing keeps the seller's own currency.
 *  - **Display currency**: what a viewer chose to see a catalog price rendered
 *    in. Presentation only — it never changes a stored amount.
 *  - **Presentment (charge) currency**: what the buyer saw and paid at checkout
 *    (`DualMoney.presentment`).
 *  - **Merchant accounting currency**: the seller's own reporting/refund basis
 *    (`DualMoney.shop` — a store's `defaultCurrency`, or a P2P seller's listing
 *    currency). Reports and lifetime totals aggregate on this side only.
 *  - **Provider settlement currency**: what a payment rail actually settles and
 *    pays out in. It belongs to the PAYMENT domain, not to this DTO — Mercaria's
 *    money types deliberately name no settlement currency at all.
 *  - **Secondary display currency**: an optional second figure shown beside the
 *    primary one (`CurrencyPreference.secondaryCurrency`).
 */

/**
 * Currency codes supported by Mercaria. FAIR (FairCoin, symbol ⊜) is NOT an
 * ISO-4217 code; the rest are. FAIR is listed first because it is Mercaria's
 * PREFERRED default — the presentment currency a buyer gets when they have
 * chosen none, and the display default outside a provider — which is a PRODUCT
 * policy, not an architectural invariant.
 *
 * Every code here, FAIR included, is a full CATALOG / DISPLAY / PRESENTMENT
 * currency: a seller may price in it, a buyer may be charged in it, and reports
 * may aggregate in it. Nothing in these contracts settles in a fixed currency —
 * which currency a payment actually settles in is a property of the payment
 * provider handling it, decided in the payment domain. The set is broad so
 * catalogs imported from WooCommerce/Shopify shops in these countries ingest
 * without rejection.
 */
export type CurrencyCode =
  | 'FAIR'
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'CAD'
  | 'AUD'
  | 'JPY'
  | 'CHF'
  | 'CNY'
  | 'SEK'
  | 'NOK'
  | 'DKK'
  | 'PLN'
  | 'MXN'
  | 'BRL'
  | 'INR'
  | 'NZD'
  | 'ZAR'
  | 'SGD'
  | 'HKD'
  | 'AED';

/**
 * Decimal precision per currency — the number of fraction digits in the major
 * unit, i.e. `log10(minor units per major unit)`. FAIR uses 8 decimals
 * (1 ⊜ = 100_000_000 minor units); most fiat codes use 2 (cents). The value is
 * the currency's ISO-4217 minor unit, so zero-decimal currencies (e.g. JPY) use
 * 0 — `¥100` is 100 minor units, not 10_000. Formatting and rounding are
 * precision-aware via this single source of truth.
 */
export const CURRENCY_PRECISION: Record<CurrencyCode, number> = {
  FAIR: 8,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  // JPY has NO minor unit (ISO-4217 exponent 0): 1 ¥ = 1 minor unit.
  JPY: 0,
  CHF: 2,
  CNY: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  MXN: 2,
  BRL: 2,
  INR: 2,
  NZD: 2,
  ZAR: 2,
  SGD: 2,
  HKD: 2,
  AED: 2,
};

/**
 * Display symbol per currency. Single source of truth — the frontend formatter
 * imports these instead of redeclaring its own map. Where a bare glyph is shared
 * by several currencies (the `$` and `¥` families) the symbol is disambiguated
 * with a country prefix (`CA$`, `MX$`, `CN¥`, …) so a marketplace showing a
 * secondary currency never renders two different currencies identically. The
 * Scandinavian krona/krone codes genuinely share `kr` in real-world usage and
 * are left as `kr`.
 */
export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  FAIR: '⊜',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
  JPY: '¥',
  CHF: 'Fr',
  CNY: 'CN¥',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  MXN: 'MX$',
  BRL: 'R$',
  INR: '₹',
  NZD: 'NZ$',
  ZAR: 'R',
  SGD: 'S$',
  HKD: 'HK$',
  AED: 'د.إ',
};

/**
 * The full set of supported currency codes, derived at runtime from the
 * (compiler-enforced exhaustive) `CURRENCY_PRECISION` map. This is the SINGLE
 * runtime source of the currency set — other packages import it instead of
 * re-declaring their own literal array, so adding a currency here propagates
 * everywhere. Keys of a `Record<CurrencyCode, …>` are exactly `CurrencyCode`.
 */
export const ALL_CURRENCY_CODES: readonly CurrencyCode[] =
  Object.keys(CURRENCY_PRECISION) as CurrencyCode[];

/**
 * The largest `Money.amount` (in absolute value) Mercaria represents, and the
 * ceiling `assertSafeMoneyAmount` enforces. `Money.amount` is a JavaScript
 * `number`, so integers above 2^53 − 1 stop being exactly representable and
 * arithmetic silently loses minor units.
 *
 * At FAIR's eight decimals this ceiling is about 90.07 million ⊜; at two-decimal
 * fiat precision it is about 90.07 trillion units. Both are far above any real
 * order, which is why the limit is ENFORCED at every construction boundary
 * rather than traded for a `bigint` wire type that would change every arithmetic
 * site and every client. If a real amount ever approaches it, the DTO and the
 * database columns move to `bigint` together — but silently exceeding it is the
 * failure this constant exists to make impossible.
 */
export const MAX_MONEY_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

/**
 * Assert that `amount` is a valid `Money.amount`: a finite INTEGER count of
 * minor units whose magnitude is within `MAX_MONEY_MINOR_UNITS`. Throws a
 * `RangeError` naming `context` (the construction site, e.g.
 * `'pricing.grandTotal'`) so a breach is traceable to the code that produced it.
 *
 * Negative amounts are permitted — a subtraction may legitimately go negative
 * and the caller decides whether that is valid — so the ceiling is on MAGNITUDE.
 * Call this wherever an amount is CONSTRUCTED (converted, prorated, summed into
 * a total, parsed off the wire), not on every read.
 */
export function assertSafeMoneyAmount(amount: number, context: string): void {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`${context}: money amount must be a finite number, received ${amount}`);
  }
  if (!Number.isInteger(amount)) {
    throw new RangeError(
      `${context}: money amount must be an integer count of minor units, received ${amount}`,
    );
  }
  if (Math.abs(amount) > MAX_MONEY_MINOR_UNITS) {
    throw new RangeError(
      `${context}: money amount ${amount} exceeds the maximum representable ` +
        `${MAX_MONEY_MINOR_UNITS} minor units`,
    );
  }
}

/**
 * The largest LEDGER amount (in absolute value) Mercaria represents.
 *
 * The ledger is the one place money is NOT a `Money`: its entries are `bigint`,
 * not `number`, so `MAX_MONEY_MINOR_UNITS` (JavaScript's 2^53 − 1) is not the
 * binding limit there. What binds instead is the storage: the column is a
 * Postgres `bigint`, whose signed 64-bit range is ±(2^63 − 1), and a value
 * outside it is not a rounding error but a failed INSERT.
 *
 * A `Money` amount converted into a ledger entry is still bounded by
 * `MAX_MONEY_MINOR_UNITS` at the boundary it was constructed at — this ceiling
 * is nine orders of magnitude above that and exists to catch the OTHER producer:
 * a sum, a proration or a reversal computed in `bigint` arithmetic, which has no
 * silent-overflow mode and will simply keep growing until the database refuses
 * it with a message naming neither the amount nor the code that made it.
 */
export const MAX_LEDGER_MINOR_UNITS = 2n ** 63n - 1n;

/**
 * Assert that `amount` is a ledger amount the `bigint` column can hold. Throws a
 * `RangeError` naming `context` (the posting that produced it, e.g.
 * `'chargeSucceeded.merchantPayable'`) so a breach is traceable to the builder
 * rather than to the INSERT that rejected it.
 *
 * Negative amounts are not merely permitted, they are half the design: a ledger
 * entry is signed, positive for a debit and negative for a credit, and a
 * balanced transaction needs both. The bound is therefore on MAGNITUDE.
 *
 * There is no integer check and no finiteness check, because `bigint` has no
 * non-integer and no infinite values — the type has already made those
 * unrepresentable, which is most of why the ledger uses it.
 */
export function assertSafeLedgerAmount(amount: bigint, context: string): void {
  const magnitude = amount < 0n ? -amount : amount;
  if (magnitude > MAX_LEDGER_MINOR_UNITS) {
    throw new RangeError(
      `${context}: ledger amount ${amount.toString()} exceeds the maximum representable ` +
        `${MAX_LEDGER_MINOR_UNITS.toString()} minor units`,
    );
  }
}

/**
 * A monetary value. `amount` is always an integer count of the currency's
 * smallest unit — never a decimal. For FAIR that smallest unit is
 * 1e-8 ⊜ (1 ⊜ = 100_000_000 minor units, i.e. 8 decimals); for USD/EUR/GBP it
 * is a cent (2 decimals); for a zero-decimal currency like JPY the minor unit IS
 * the major unit (¥100 is 100, not 10_000).
 *
 * The representable range is bounded by `MAX_MONEY_MINOR_UNITS` and enforced by
 * `assertSafeMoneyAmount` at every construction boundary — the API input
 * schemas, the persistence layer, the pricing engine, FX conversion and refund
 * proration all assert, so an amount that cannot be represented exactly is
 * rejected where it is formed instead of drifting silently.
 */
export interface Money {
  /** Integer amount in minor units (e.g. 1999 = $19.99; 100_000_000 = 1 ⊜). */
  amount: number;
  /** The currency this amount is denominated in. */
  currency: CurrencyCode;
}

/**
 * A transacted amount carried in BOTH the seller's accounting currency and the
 * buyer's presentment currency (Shopify-Markets style).
 *
 *  - `shop`: the seller's MERCHANT ACCOUNTING currency — a store's
 *    `defaultCurrency`, or for a P2P order the seller's listing currency. It is
 *    the basis for reports, lifetime totals and refunds, and never mixes
 *    currencies across one seller's orders, so aggregations sum `shop` safely.
 *    It is NOT a settlement currency: what a payment rail settles and pays out
 *    in is decided by the payment provider and recorded in the payment domain.
 *  - `presentment`: the currency the buyer actually SAW and PAID in — their
 *    `preferredCurrency`, falling back to FAIR when they have chosen none.
 *    A buyer's presentment currency may vary between orders, so `presentment`
 *    amounts are NEVER aggregated across orders.
 *
 * The two amounts describe the SAME economic value at the order's captured
 * `fxRate` (see `FxRateSnapshot`). When the shop and presentment currencies are
 * equal (e.g. a POS sale) both sides are byte-identical.
 */
export interface DualMoney {
  /** Merchant accounting / report currency amount (the store's or seller's own). */
  shop: Money;
  /** Charge currency amount (what the buyer saw and paid). */
  presentment: Money;
}

/**
 * An immutable snapshot of ONE currency conversion, captured at the moment the
 * converted amount was formed. Persisting it makes the conversion reproducible
 * after the fact: a later FX movement can never change an amount that already
 * carries its own rate.
 *
 * It identifies the conversion completely — source, target, rate, the PROVIDER
 * that quoted it and the observation time — so two snapshots taken from
 * different sources are never confused for one another. Orders carry the
 * shop→presentment conversion here; the payment domain captures its own
 * snapshots for provider-side conversions, using this same shape.
 */
export interface FxRateSnapshot {
  /** Source currency of the conversion. */
  from: CurrencyCode;
  /** Target currency of the conversion. */
  to: CurrencyCode;
  /** Units of `to` per ONE unit of `from` (a decimal multiplier, not minor units). */
  rate: number;
  /**
   * The source that quoted this rate. An FX provider id for a live conversion
   * (`'faircoin_explorer'`, `'static'`), the external platform's connector id
   * when the rate was derived from amounts that platform reported, or
   * `'identity'` when `from` and `to` are the same currency and nothing was
   * converted. Free-form on purpose: the set of sources is deployment
   * configuration, not a fixed union every client would have to be redeployed to
   * widen.
   */
  provider: string;
  /** ISO-8601 time the rate was captured. */
  asOf: string;
}
