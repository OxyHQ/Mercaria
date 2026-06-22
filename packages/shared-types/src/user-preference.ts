/**
 * Consumer currency-preference DTOs.
 *
 * These describe a SHOPPER's dual-currency DISPLAY preference and are strictly
 * presentation-only: they never affect the amounts Mercaria stores. Every price
 * is persisted in the canonical currency (FAIR); a consumer may additionally see
 * a secondary fiat figure rendered alongside it. Changing these values changes
 * only what the client shows, never the stored Money.
 */

import type { CurrencyCode } from './money';

export interface CurrencyPreference {
  /**
   * The fiat currency to display ALONGSIDE the canonical FAIR amount.
   * `null` means the consumer has not chosen one and the client should pick a
   * sensible locale default.
   */
  secondaryCurrency: CurrencyCode | null;
  /** Whether to render the dual (FAIR + secondary) figure at all. Defaults to `true`. */
  dualDisplayEnabled: boolean;
}

export interface UpdateCurrencyPreferenceInput {
  /** Set the secondary display currency, or `null` to clear it. */
  secondaryCurrency?: CurrencyCode | null;
  /** Toggle the dual-currency display on/off. */
  dualDisplayEnabled?: boolean;
}
