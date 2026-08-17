/**
 * Which currencies a price surface could not price, and WHY (#450).
 *
 * Three surfaces exclude offers they cannot convert — `services/search`'s price
 * filter, `services/catalog-pages`' price range and `services/facets`' price
 * facet — and every one of them owes the shopper a list of what it left out.
 * This module is the ONE place that decides what goes on that list, because the
 * three of them producing it separately is exactly how they came apart: search
 * and catalog-pages named an unmodelled currency, facets dropped it, and the
 * facet DTO typed the field `CurrencyCode[]` so it could not have named one even
 * deliberately.
 *
 * ## Two reasons, and they need OPPOSITE remedies
 *
 * An offer is excluded from a price comparison for one of two reasons, and a
 * surface that reports only "we could not price these" collapses them:
 *
 * - **`no_rate`** — the currency IS modelled and the rate map could not serve it
 *   this minute. TRANSIENT. It heals on the next successful `getRates`, and the
 *   remedy is to wait or retry.
 * - **`not_modelled`** — the currency is outside `ALL_CURRENCY_CODES`, so
 *   Mercaria has no `CURRENCY_PRECISION` entry for it and never asks for a rate
 *   in the first place. PERMANENT until somebody adds the code (a change to the
 *   shared-types tuple PLUS a migration, per the money rules), and until then
 *   every offer priced in it is invisible under every price filter. The remedy
 *   is a code change, and nobody can make it if no surface names the currency.
 *
 * `~/AGENTS.md`'s rule is that unknown is a third answer and never a soft yes or
 * a quiet no; #74's `RankingSignalOutcome` and #449's `SearchOfferMatch` keep
 * their unknown branches as distinct discriminants for the same reason. The
 * distinction is preserved here, and the shape it takes is deliberate.
 *
 * ## A SUBSET, not a second disjoint list
 *
 * `unconvertibleCurrencies` stays the COMPLETE set of currencies whose offers
 * were excluded — that is what its documented contract says ("named, never
 * silent") and an unmodelled currency genuinely was excluded, so narrowing the
 * field would make it lie. `unmodelledCurrencies` names the PERMANENT subset.
 *
 * Splitting them into two disjoint lists was rejected on a measured fact: the
 * storefront's family page renders `unconvertibleCurrencies` directly, so a
 * disjoint split would stop that live surface naming the unmodelled currency —
 * reinstating the silent exclusion on the one screen a shopper actually reads.
 * A subset leaves every existing reader correct and complete while giving a
 * reader that wants the distinction somewhere to get it.
 *
 * ## The two fields cannot disagree
 *
 * They are not two accumulators kept in step. The reason is a pure function of
 * the currency string, so BOTH fields are projected from the SAME set by
 * {@link projectCurrencyExclusions}, and `unmodelled ⊆ unconvertible` holds by
 * construction rather than by a rule somebody has to remember.
 */

import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import type { CurrencyCode } from '@mercaria/shared-types';

/**
 * Narrow a stored currency string to Mercaria's presentment set, or `null`.
 *
 * The offer tables constrain their currency columns by SHAPE only
 * (`~ '^[A-Z]{3,4}$'`, ADR 0002 D18's documented CHECK exception), so a code
 * outside the tuple is storable and `services/feed-import` can write one. Every
 * surface that converts money therefore has to narrow, and the narrowing lives
 * beside the reporting so the two cannot disagree about which codes are which.
 */
export function asCurrencyCode(value: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value) ? (value as CurrencyCode) : null;
}

/** Whether Mercaria models this currency at all — the permanent/transient split. */
export function isUnmodelledCurrency(value: string): boolean {
  return asCurrencyCode(value) === null;
}

/** The two lists a price surface reports, projected from one set of exclusions. */
export interface CurrencyExclusionReport {
  /**
   * Every currency whose offers were excluded, sorted. COMPLETE — a currency
   * left out for either reason appears here.
   */
  readonly unconvertibleCurrencies: readonly string[];
  /**
   * The subset of {@link unconvertibleCurrencies} that Mercaria does not model,
   * sorted. Permanent until the code is added, so a surface can say so.
   */
  readonly unmodelledCurrencies: readonly string[];
}

/**
 * Project the two reported lists from the set of currencies actually excluded.
 *
 * Takes the WHOLE set — callers accumulate exclusions without classifying them,
 * so a producer cannot record an exclusion into the wrong bucket. The reason is
 * re-derived here from the code itself, which is the only input it depends on.
 */
export function projectCurrencyExclusions(excluded: Iterable<string>): CurrencyExclusionReport {
  const all = [...new Set(excluded)].sort();
  return {
    unconvertibleCurrencies: all,
    unmodelledCurrencies: all.filter(isUnmodelledCurrency),
  };
}
