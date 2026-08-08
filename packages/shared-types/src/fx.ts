/**
 * Foreign-exchange (FX) rate DTO for Mercaria.
 *
 * Mercaria is multi-currency: the catalog stores every price in its own NATIVE
 * currency and never converts on write. FX rates exist for the conversion
 * boundaries only:
 *  - Display: a presentation-only conversion of a stored native amount into the
 *    viewer's chosen display currency.
 *  - Checkout: converting native line prices into the seller's accounting
 *    (`shop`) currency and then into the buyer's presentment currency, with the
 *    rate snapshotted onto the order (`FxRateSnapshot`).
 *
 * A `FxRates` is quoted against a single `base` currency: each `rates[quote]` is
 * the number of units of `quote` per ONE unit of `base` (`1 base = rates[quote]`
 * of that quote currency). ANY supported currency may be the base — whether the
 * serving provider reaches a pair directly or derives it through a pivot is that
 * provider's implementation detail and is not visible here. The values are
 * decimal rates, NOT integer minor units: they are multipliers applied to a
 * `Money` major value, after which the result is re-quantized to integer minor
 * units by the consuming money helpers.
 *
 * A pair the provider cannot serve is OMITTED from `rates` — never filled with a
 * fabricated or defaulted value.
 */

import type { CurrencyCode } from './money';

export interface FxRates {
  /** The base currency all `rates` are quoted against. */
  base: CurrencyCode;
  /**
   * Quote code → units of the quote currency per 1 unit of `base`.
   * For a FAIR base, `rates.USD = 0.49` means `1 FAIR = 0.49 USD`.
   */
  rates: Record<string, number>;
  /**
   * The source that produced these rates: the configured FX provider's id on a
   * fresh or cached fetch, `'static'` when the configured provider failed and
   * the static fallback served, `'none'` when no rate could be resolved at all
   * (`rates` is then empty). Carried onto every `FxRateSnapshot` formed from
   * these rates, so a persisted conversion always names what quoted it.
   */
  provider: string;
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
