/**
 * Foreign-exchange (FX) rate DTO for Mercaria.
 *
 * FairCoin (`FAIR`, ⊜) is the CANONICAL currency — EVERYTHING is STORED in FAIR.
 * FX rates exist solely for the two conversion boundaries:
 *  - Write-side: a store/seller MAY enter a price in a fiat currency; the backend
 *    converts it to FAIR and stores FAIR (the fiat amount is NEVER persisted).
 *  - Display-side (consumer only): a presentation-only conversion of the stored
 *    FAIR amount into the viewer's preferred fiat for dual-currency display.
 *
 * A `FxRates` is always expressed relative to a single `base` currency (FAIR in
 * B1): each `rates[quote]` is the number of units of `quote` per ONE unit of
 * `base` (i.e. `1 FAIR = rates[quote]` of that quote currency). The amounts here
 * are decimal rates, NOT integer minor units — they are multipliers applied to a
 * `Money` major value, after which the result is re-quantized to integer minor
 * units by the consuming money helpers.
 */

import type { CurrencyCode } from './money';

export interface FxRates {
  /** The base currency all `rates` are quoted against (FAIR in B1). */
  base: CurrencyCode;
  /**
   * Quote code → units of the quote currency per 1 unit of `base`.
   * For a FAIR base, `rates.USD = 0.49` means `1 FAIR = 0.49 USD`.
   */
  rates: Record<string, number>;
  /**
   * ISO-8601 timestamp the rates were valid as of. On a fresh provider fetch
   * this is the time the rates were retrieved; on a cached/static fallback it is
   * the cache write time (or the fallback time).
   */
  asOf: string;
  /**
   * `true` when the rates were served from a last-good cache or the static
   * fallback after the live provider failed; `false` for a fresh provider fetch.
   */
  stale: boolean;
  /** TTL (seconds) the freshest cached copy of these rates is held for. */
  ttlSeconds: number;
}
