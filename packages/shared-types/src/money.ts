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
export type CurrencyCode = 'FAIR' | 'USD' | 'EUR' | 'GBP';

/**
 * Decimal precision per currency — the number of fraction digits in the major
 * unit, i.e. `log10(minor units per major unit)`. FAIR uses 8 decimals
 * (1 ⊜ = 100_000_000 minor units); USD/EUR/GBP use 2 (cents). Formatting and
 * rounding are precision-aware via this single source of truth.
 */
export const CURRENCY_PRECISION: Record<CurrencyCode, number> = {
  FAIR: 8,
  USD: 2,
  EUR: 2,
  GBP: 2,
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
};

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
