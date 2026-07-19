/**
 * Money DTO for the Mercaria.
 *
 * Amounts are represented as integer minor units (e.g. cents) to avoid floating
 * point rounding errors. `currency` is one of the codes supported by Mercaria.
 */

/**
 * Currency codes supported by Mercaria (FAIR is the canonical settlement
 * currency). FAIR (FairCoin, symbol ⊜) is NOT an ISO-4217 code; USD/EUR/GBP are.
 * FAIR is listed first so it is the canonical default everywhere it is implied.
 */
export type CurrencyCode = 'FAIR' | 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD';

/**
 * Decimal precision per currency — the number of fraction digits in the major
 * unit, i.e. `log10(minor units per major unit)`. FAIR uses 8 decimals
 * (1 ⊜ = 100_000_000 minor units); the fiat codes use 2 (cents). Formatting and
 * rounding are precision-aware via this single source of truth.
 */
export const CURRENCY_PRECISION: Record<CurrencyCode, number> = {
  FAIR: 8,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
};

/**
 * Display symbol per currency. Single source of truth — the frontend formatter
 * imports these instead of redeclaring its own map.
 */
export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  FAIR: '⊜',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
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
 * A monetary value. `amount` is always an integer count of the currency's
 * smallest unit — never a decimal. For FAIR that smallest unit is
 * 1e-8 ⊜ (1 ⊜ = 100_000_000 minor units, i.e. 8 decimals); for USD/EUR/GBP it
 * is a cent (2 decimals).
 *
 * NOTE: very large FAIR totals (whole-coin amounts above ~90 million ⊜) push the
 * integer minor-unit count toward `Number.MAX_SAFE_INTEGER` (2^53 − 1). A
 * precision/BigInt confirmation for high-value FAIR settlement is pending — see
 * the B0 handoff item.
 */
export interface Money {
  /** Integer amount in minor units (e.g. 1999 = $19.99; 100_000_000 = 1 ⊜). */
  amount: number;
  /** Currency code (FAIR is canonical). */
  currency: CurrencyCode;
}

/**
 * A transacted amount carried in BOTH the shop's settlement currency and the
 * buyer's presentment currency (Shopify-Markets style).
 *
 *  - `shop`: the store's (or P2P seller's) settlement currency. This is the basis
 *    for reports, payouts and the shop→FAIR settlement — it never mixes currencies
 *    across a single store's orders, so aggregations sum `shop` amounts safely.
 *  - `presentment`: the currency the buyer actually SAW and PAID in (their
 *    preferred currency, or FAIR). Presentation/charge side; a buyer's presentment
 *    currency may vary between orders, so `presentment` amounts are NOT aggregated
 *    across orders.
 *
 * The two amounts describe the SAME economic value at the order's captured
 * `fxRate` (see `FxRateSnapshot`). When the shop and presentment currencies are
 * equal (e.g. a POS sale) both sides are byte-identical.
 */
export interface DualMoney {
  /** Settlement/report currency amount (the store's / seller's currency). */
  shop: Money;
  /** Display/charge currency amount (what the buyer saw and paid). */
  presentment: Money;
}

/**
 * An immutable snapshot of the shop→presentment exchange rate captured at the
 * moment a `DualMoney` was formed (checkout/draft-complete). Persisting it makes
 * the presentment side of an order reproducible after the fact, independent of
 * later rate moves.
 */
export interface FxRateSnapshot {
  /** Source currency of the conversion — the order's shop (settlement) currency. */
  from: CurrencyCode;
  /** Target currency — the buyer's presentment (display/charge) currency. */
  to: CurrencyCode;
  /** Units of `to` per ONE unit of `from` (a decimal multiplier, not minor units). */
  rate: number;
  /** ISO-8601 time the rate was captured. */
  asOf: string;
}
