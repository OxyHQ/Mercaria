/**
 * Money DTO for the Marketplace.
 *
 * Amounts are represented as integer minor units (e.g. cents) to avoid floating
 * point rounding errors. `currency` is an ISO-4217 alphabetic code.
 */

/** ISO-4217 alphabetic currency codes supported by the Marketplace. */
export type CurrencyCode = 'USD' | 'EUR' | 'GBP';

/**
 * A monetary value. `amount` is always an integer count of the currency's
 * smallest unit (cents for USD/EUR/GBP) — never a decimal.
 */
export interface Money {
  /** Integer amount in minor units (e.g. 1999 = $19.99). */
  amount: number;
  /** ISO-4217 currency code. */
  currency: CurrencyCode;
}
