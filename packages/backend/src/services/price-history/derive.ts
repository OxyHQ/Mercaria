/**
 * The derivation — one pure function from observations to points (#78
 * §"Product-level aggregation", acceptances 1, 2, 3, 5 and 6).
 *
 * There is exactly ONE of these and both readers call it: the background
 * rebuild, which persists what it returns, and the merchant-filtered read,
 * which returns it directly. Two derivations of one answer can disagree; one
 * cannot, and that is the whole reason the filtered read is allowed to skip the
 * stored series at all.
 *
 * ## The three inputs that are LIVE and the one that is HISTORICAL, and why
 *
 * Acceptance 5 asks that a rebuild produce identical output for the same policy
 * and data. That makes every input a decision, so each is stated:
 *
 * - **Freshness is HISTORICAL.** The observation stored #68's verdict at the
 *   moment it was taken, and the derivation reads that column. Re-deriving it
 *   live would make a rebuild produce different points as a source's freshness
 *   policy changed — the same data, a different chart, with nothing saying so.
 *   The stored level answers the right question anyway: "what did the policy say
 *   when this price was read".
 * - **Display rights are LIVE.** A source that withdrew its price-display right
 *   must stop appearing, and #68 is explicit that extending the life of a
 *   withdrawn right is exactly what must never happen. So the rebuild passes the
 *   set of sources that may display a price TODAY, and a withdrawal takes every
 *   old point off the chart at the next rebuild.
 * - **Quarantine is LIVE.** Issue snapshot policy 6 says a quarantined record
 *   does not enter public history UNTIL RELEASED, which is a statement about the
 *   present. The query computes it; this function reports it as a reason.
 * - **The FX rate map is LIVE, and its quote is STORED with every point.** That
 *   is the compromise issue currency rules 4 and 5 name: a rebuild uses today's
 *   rates because there is no historical rate archive to use instead, and it
 *   records exactly which quote it used so the chart it produced is
 *   reproducible and a later rate move can never alter it.
 */

import {
  CONDITION_KEY_GROUP,
  PRICE_MEASURE_INCLUDES_DELIVERY,
  PRICE_SERIES_MEASURES,
  priceHistoryBucketStart,
  type ConditionGroup,
  type CurrencyCode,
  type FxRates,
  type ItemConditionKey,
  type Money,
  type PriceObservationExclusionReason,
  type PricePointAdmittedFreshness,
  type PriceSeriesGranularity,
  type PriceSeriesMeasure,
} from '@mercaria/shared-types';
import { convert, pairRate } from '../fx.service.js';
import type { PriceObservationRow } from '../../db/priceHistory/priceSnapshotRepository.js';

/** One derived point, before it is either persisted or projected. */
export interface DerivedPricePoint {
  readonly bucketStart: Date;
  readonly measure: PriceSeriesMeasure;
  readonly segment: ConditionGroup;
  readonly snapshotId: string;
  readonly offerId: string;
  readonly observedAt: Date;
  readonly admittedFreshness: PricePointAdmittedFreshness;
  readonly contributingObservationCount: number;
  /** The winner's own money, in the currency the source published. */
  readonly native: Money;
  /** The same value in the series' display currency. */
  readonly displayAmount: number;
  /** Present EXACTLY when a conversion happened. */
  readonly fx?: {
    readonly rate: number;
    readonly from: CurrencyCode;
    readonly to: CurrencyCode;
    readonly provider: string;
    readonly asOf: Date;
  };
}

/** Why one observation did not contribute. Returned, never stored. */
export interface DerivedExclusion {
  readonly snapshotId: string;
  readonly offerId: string;
  readonly measure: PriceSeriesMeasure;
  readonly reasons: readonly PriceObservationExclusionReason[];
}

export interface PriceDerivationInput {
  readonly observations: readonly PriceObservationRow[];
  readonly displayCurrency: CurrencyCode;
  readonly granularity: PriceSeriesGranularity;
  readonly rates: FxRates;
  /**
   * Sources whose ACTIVE rights policy permits displaying a price today.
   *
   * A native observation carries no source and is never in this set; the
   * derivation admits it by checking for the absence of a source rather than by
   * membership, so a deployment with no configured sources still charts its own
   * catalogue.
   */
  readonly priceDisplayPermittedSourceIds: ReadonlySet<string>;
  /**
   * Merchants #55 has VERIFIED as an official channel for this scope's brand,
   * inside the claim's validity window.
   *
   * Empty is the ordinary state and produces an empty
   * `official_store_item_price` series, which is correct: a merchant with no
   * verified relationship has no relationship row at all (#55), and a domain
   * match or a name match cannot create one.
   */
  readonly officialStoreMerchantIds: ReadonlySet<string>;
  readonly measures?: readonly PriceSeriesMeasure[];
}

export interface PriceDerivationOutput {
  readonly points: readonly DerivedPricePoint[];
  readonly exclusions: readonly DerivedExclusion[];
}

/** Whether `rates` can price this currency at all — `convert` THROWS when it cannot. */
function canConvert(currency: string, rates: FxRates): currency is CurrencyCode {
  if (currency === rates.base) return true;
  const rate = rates.rates[currency];
  return typeof rate === 'number' && rate > 0;
}

/**
 * The condition segment, or `undefined` for an unknown key.
 *
 * `undefined` and never a default: `CONDITION_KEY_GROUP` is total over the
 * taxonomy but `unknown` is not in it, and a `?? 'new'` would tell a shopper an
 * unlabelled feed item is factory-sealed — #90's own reasoning for making
 * `deriveOfferCondition`'s group biconditional.
 */
function segmentOf(conditionKey: string): ConditionGroup | undefined {
  if (conditionKey === 'unknown') return undefined;
  return CONDITION_KEY_GROUP[conditionKey as ItemConditionKey];
}

/** #68's `mayAppearInComparison`, read off the stored verdict. */
function admittedFreshnessOf(level: string): PricePointAdmittedFreshness | undefined {
  if (level === 'current') return 'current';
  if (level === 'warning') return 'warning';
  return undefined;
}

/**
 * The candidate an observation offers to one measure, or the reasons it offers
 * none.
 *
 * Every measure passes through here, so the checks that apply to all of them
 * are written once and the per-measure ones are a single `switch` whose
 * exhaustiveness `tsc` enforces — a measure added without a branch fails the
 * build rather than silently selecting everything.
 */
function candidateFor(
  observation: PriceObservationRow,
  measure: PriceSeriesMeasure,
  input: PriceDerivationInput,
):
  | { readonly outcome: 'admitted'; readonly native: Money; readonly segment: ConditionGroup }
  | { readonly outcome: 'refused'; readonly reasons: PriceObservationExclusionReason[] } {
  const reasons: PriceObservationExclusionReason[] = [];

  if (observation.supersededByCorrection) reasons.push('superseded_observation');
  if (observation.quarantined) reasons.push('source_run_quarantined');
  if (observation.anomalies.length > 0) reasons.push('anomalous_observation');
  if (!admittedFreshnessOf(observation.freshnessLevel)) reasons.push('offer_not_comparable');
  if (
    observation.offerSourceId !== null &&
    !input.priceDisplayPermittedSourceIds.has(observation.offerSourceId)
  ) {
    reasons.push('price_display_not_permitted');
  }

  const segment = segmentOf(observation.conditionKey);
  if (!segment) reasons.push('condition_unknown');

  // Per-measure admission. Exhaustive by construction; a new measure with no
  // branch is a `tsc` error rather than a series that quietly admits every
  // offer.
  switch (measure) {
    case 'lowest_item_price':
      break;
    case 'lowest_known_total':
      if (observation.shippingCostAmount === null || observation.shippingCostCurrency === null) {
        reasons.push('delivery_cost_unknown');
      }
      break;
    case 'official_store_item_price':
      if (
        !observation.offerMerchantId ||
        !input.officialStoreMerchantIds.has(observation.offerMerchantId)
      ) {
        reasons.push('not_official_store');
      }
      break;
    case 'native_item_price':
      if (observation.offerKind !== 'native') reasons.push('not_native_offer');
      break;
    case 'mercaria_retail_item_price':
      // A NAMED SEAM that fails closed. `OfferKind` has no `mercaria_retail`
      // member — ADR 0002 D18 binds it to epic #116's own migration — so no
      // observation can satisfy this and the series stays empty until #116
      // adds the kind. The branch exists so that closing the seam is a change
      // to the offer vocabulary rather than to this file.
      reasons.push('not_mercaria_retail_offer');
      break;
  }

  if (!canConvert(observation.itemPriceCurrency, input.rates)) {
    reasons.push('currency_not_convertible');
  }

  if (reasons.length > 0 || !segment) {
    return { outcome: 'refused', reasons: reasons.length > 0 ? reasons : ['condition_unknown'] };
  }

  // Both currencies were checked above; the guard is re-read here because the
  // compiler cannot see through the reason array, and a non-null assertion is
  // forbidden.
  if (!canConvert(observation.itemPriceCurrency, input.rates)) {
    return { outcome: 'refused', reasons: ['currency_not_convertible'] };
  }

  const itemPrice: Money = {
    amount: observation.itemPriceAmount,
    currency: observation.itemPriceCurrency,
  };

  if (!PRICE_MEASURE_INCLUDES_DELIVERY[measure]) {
    return { outcome: 'admitted', native: itemPrice, segment };
  }

  const shippingAmount = observation.shippingCostAmount;
  const shippingCurrency = observation.shippingCostCurrency;
  if (shippingAmount === null || shippingCurrency === null) {
    return { outcome: 'refused', reasons: ['delivery_cost_unknown'] };
  }
  if (!canConvert(shippingCurrency, input.rates)) {
    return { outcome: 'refused', reasons: ['currency_not_convertible'] };
  }

  // The delivery cost is brought into the ITEM's currency first, so the point
  // has one native amount to record. Converting each half straight to the
  // display currency would leave a total whose `native` half does not exist in
  // any currency, and the FX shape CHECK would have nothing true to say about
  // it.
  const shippingInItemCurrency = convert(
    { amount: shippingAmount, currency: shippingCurrency },
    itemPrice.currency,
    input.rates,
  );
  return {
    outcome: 'admitted',
    native: {
      amount: itemPrice.amount + shippingInItemCurrency.amount,
      currency: itemPrice.currency,
    },
    segment,
  };
}

/** A bucket's winner, before it is turned into a point. */
interface BucketCandidate {
  readonly observation: PriceObservationRow;
  readonly native: Money;
  readonly displayAmount: number;
  readonly admittedFreshness: PricePointAdmittedFreshness;
}

/**
 * Derive every point of one series from one set of observations.
 *
 * ## Determinism, which is acceptance 5
 *
 * The winner of a bucket is the lowest DISPLAY amount, and ties are broken by
 * `observedAt` and then by snapshot id — never by array order and never by the
 * primary key alone. A uuid v7 key is NOT monotonic within a millisecond, so
 * two observations taken in the same tick order arbitrarily, and a rebuild that
 * tie-broke on the id would produce a different chart on every run for the same
 * data. The pair is total: `(observedAt, id)` is unique because the id is.
 *
 * ## The comparison is made in the DISPLAY currency, and that is safe
 *
 * Conversion under one rate map is monotone, so the WINNER is the same whatever
 * target currency is chosen — only the displayed figure differs. What the
 * display currency decides is therefore the number, not the ranking, which is
 * why one series per currency is a storage choice rather than a semantic one.
 * Comparing raw minor units across currencies, which issue currency rule 6
 * forbids, is not reachable from here: an unconvertible observation is excluded
 * before any comparison happens.
 */
export function derivePriceSeries(input: PriceDerivationInput): PriceDerivationOutput {
  const measures = input.measures ?? PRICE_SERIES_MEASURES;
  const points: DerivedPricePoint[] = [];
  const exclusions: DerivedExclusion[] = [];
  /** `<bucket epoch>|<measure>|<segment>` → every candidate in it. */
  const buckets = new Map<string, BucketCandidate[]>();

  for (const observation of input.observations) {
    for (const measure of measures) {
      const candidate = candidateFor(observation, measure, input);
      if (candidate.outcome === 'refused') {
        exclusions.push({
          snapshotId: observation.snapshotId,
          offerId: observation.offerId,
          measure,
          reasons: candidate.reasons,
        });
        continue;
      }

      const admittedFreshness = admittedFreshnessOf(observation.freshnessLevel);
      if (!admittedFreshness) {
        // Unreachable — `candidateFor` already refused it — and written out
        // rather than asserted, because a non-null assertion is forbidden and a
        // silent `'current'` default here would admit an expired offer.
        exclusions.push({
          snapshotId: observation.snapshotId,
          offerId: observation.offerId,
          measure,
          reasons: ['offer_not_comparable'],
        });
        continue;
      }

      const display = convert(candidate.native, input.displayCurrency, input.rates);
      const bucket = priceHistoryBucketStart(observation.observedAt, input.granularity);
      const key = `${bucket.getTime()}|${measure}|${candidate.segment}`;
      const existing = buckets.get(key);
      const entry: BucketCandidate = {
        observation,
        native: candidate.native,
        displayAmount: display.amount,
        admittedFreshness,
      };
      if (existing) existing.push(entry);
      else buckets.set(key, [entry]);
    }
  }

  for (const [key, candidates] of buckets) {
    const [bucketEpoch, measure, segment] = key.split('|');
    if (!bucketEpoch || !measure || !segment) continue;

    const winner = candidates.reduce((best, candidate) => {
      if (candidate.displayAmount !== best.displayAmount) {
        return candidate.displayAmount < best.displayAmount ? candidate : best;
      }
      const byTime =
        candidate.observation.observedAt.getTime() - best.observation.observedAt.getTime();
      if (byTime !== 0) return byTime < 0 ? candidate : best;
      return candidate.observation.snapshotId < best.observation.snapshotId ? candidate : best;
    });

    const nativeCurrency = winner.native.currency;
    const converted = nativeCurrency !== input.displayCurrency;
    points.push({
      bucketStart: new Date(Number(bucketEpoch)),
      measure: measure as PriceSeriesMeasure,
      segment: segment as ConditionGroup,
      snapshotId: winner.observation.snapshotId,
      offerId: winner.observation.offerId,
      observedAt: winner.observation.observedAt,
      admittedFreshness: winner.admittedFreshness,
      contributingObservationCount: candidates.length,
      native: winner.native,
      displayAmount: winner.displayAmount,
      ...(converted
        ? {
            fx: {
              rate: pairRate(nativeCurrency as CurrencyCode, input.displayCurrency, input.rates),
              from: nativeCurrency as CurrencyCode,
              to: input.displayCurrency,
              provider: input.rates.provider,
              asOf: new Date(input.rates.asOf),
            },
          }
        : {}),
    });
  }

  // A stable order, so two rebuilds of the same data write the same rows in the
  // same sequence — which is what makes "byte-identical output" checkable by
  // comparing the arrays rather than by sorting them first and hoping.
  points.sort((left, right) => {
    const byBucket = left.bucketStart.getTime() - right.bucketStart.getTime();
    if (byBucket !== 0) return byBucket;
    if (left.measure !== right.measure) return left.measure < right.measure ? -1 : 1;
    if (left.segment !== right.segment) return left.segment < right.segment ? -1 : 1;
    return 0;
  });

  return { points, exclusions };
}
