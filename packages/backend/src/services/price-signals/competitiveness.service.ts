/**
 * A merchant's own competitiveness analysis (#82 §"Merchant competitiveness").
 *
 * ## The security property is what the shape does NOT have
 *
 * `MerchantCompetitivenessRow` has no competitor id, no competitor name and no
 * competitor price. Every reference figure it carries is an AGGREGATE — a median
 * over a sample the policy's `min_distinct_sellers` floor guarantees is a market
 * rather than one rival — and every offer behind that aggregate is one Mercaria
 * already publishes on `/offer-comparison`. So the aggregate discloses nothing
 * that is not already displayed, while naming a competitor would.
 *
 * There is nothing here about a buyer either, and that is not a filter: this
 * domain reads no order, no session, no conversion and no click. #77's
 * suppress-below-ten posture has nothing to apply to for the same reason
 * `demand_without_native_offer` is a refused seam — the one insight that WOULD
 * need buyer-side measurement is the one Mercaria cannot make.
 *
 * ## Authorization is #83's verdict and nothing else
 *
 * `merchants.claim_state = 'verified'` plus `claimed_by_oxy_user_id`. An
 * unclaimed merchant, a pending claim and a revoked one all answer the same 404 —
 * a distinguishable refusal would let anybody enumerate which merchants have been
 * claimed, and the reason a merchant loses this surface on revocation is that the
 * verdict it reads is the same one #83 writes.
 */

import {
  ALL_CURRENCY_CODES,
  conditionGroupFor,
  PRICE_SIGNAL_POLICY_KEY,
  priceDeltaBps,
  priceMarketPositionFor,
  priceSampleShortfall,
  type ConditionGroup,
  type CurrencyCode,
  type ItemConditionKey,
  type MerchantCompetitivenessResponse,
  type MerchantCompetitivenessRow,
  type MerchantEligibilityLossReason,
  type PriceHistoryValue,
  type PriceSignalPolicy,
  type PriceSignalSample,
  type PriceSignalUnmeasuredReason,
} from '@mercaria/shared-types';
import {
  findActivePriceSignalPolicy,
  toPriceSignalPolicy,
} from '../../db/priceSignals/priceSignalPolicyRepository.js';
import {
  findVerifiedMerchantClaimant,
  listMerchantOfferSubjects,
} from '../../db/priceSignals/priceSignalSubjectRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { buildPriceSignalContext, type PriceSignalContext } from './context.service.js';
import { derivePriceSignalRecommendations } from './recommendations.js';
import { buildSample, EMPTY_PRICE_SIGNAL_SAMPLE } from './sample.js';
import { resolveProductDemand } from './seams.js';
import { derivePriceSignals, subjectFor } from './signals.js';
import type { PriceSampleEntry } from './statistics.js';

export interface MerchantCompetitivenessRequest {
  readonly merchantId: string;
  /** The authenticated caller. Must be the merchant's VERIFIED claimant. */
  readonly oxyUserId: string;
  readonly segment: ConditionGroup;
  readonly currency: CurrencyCode;
  readonly market?: string;
  readonly limit: number;
  readonly afterOfferId?: string;
  readonly now?: Date;
}

/**
 * #74's exclusion vocabulary, NARROWED to what a merchant can act on.
 *
 * The narrowing is the point rather than a convenience. `merchant_suppressed`,
 * `listing_restricted` and `source_display_withheld` are moderation and rights
 * decisions with their own notification paths, and repeating them on a
 * competitiveness dashboard would be a second channel for a decision that has
 * one — and a worse one, because a dashboard row cannot carry an appeal.
 *
 * A reason with no entry here is simply not reported, which is why the row's
 * `eligibilityLossReasons` can legitimately be empty for an offer that IS
 * excluded: it is excluded for something this surface does not speak about.
 */
const MERCHANT_ACTIONABLE_LOSS: Readonly<Record<string, MerchantEligibilityLossReason>> = {
  observation_expired: 'observation_stale',
  observation_unavailable: 'observation_stale',
  freshness_unknown: 'observation_stale',
  availability_unsupported: 'availability_unknown',
  destination_missing: 'destination_missing',
  condition_excluded: 'condition_unknown',
};

/**
 * Read one merchant's competitiveness, one page of their own subjects.
 *
 * Bounded and keyset-paged on the merchant's own offer id: a merchant with ten
 * thousand offers gets ten thousand rows over many requests rather than one
 * request that reads the whole catalogue. The subjects are the merchant's OWN
 * offers including the ineligible ones, because "products losing eligibility" is
 * one of the answers.
 */
export async function readMerchantCompetitiveness(
  request: MerchantCompetitivenessRequest,
): Promise<MerchantCompetitivenessResponse> {
  const claimant = await findVerifiedMerchantClaimant(request.merchantId);
  if (claimant === null || claimant !== request.oxyUserId) {
    throw notFound('Merchant not found');
  }

  const now = request.now ?? new Date();
  const active = await findActivePriceSignalPolicy();
  const policy = active === undefined ? undefined : toPriceSignalPolicy(active);

  const subjects = await listMerchantOfferSubjects({
    merchantId: request.merchantId,
    ...(request.afterOfferId === undefined ? {} : { afterOfferId: request.afterOfferId }),
    limit: request.limit,
  });

  const rows: MerchantCompetitivenessRow[] = [];
  let measured = 0;
  let unmeasured = 0;

  for (const subject of subjects) {
    const context = await buildPriceSignalContext({
      canonicalVariantId: subject.canonicalVariantId,
      segment: request.segment,
      ...(request.market === undefined ? {} : { market: request.market }),
      currency: request.currency,
      focusMerchantId: request.merchantId,
      ...(policy === undefined ? {} : { policy }),
      now,
    });

    const subjectRows = buildSubjectRows(context, policy, request.merchantId);
    rows.push(...subjectRows);
    if (subjectRows.some((row) => row.state === 'measured')) measured += 1;
    else unmeasured += 1;
  }

  return {
    merchantId: request.merchantId,
    ...(policy === undefined
      ? {}
      : {
          semantics: {
            policyKey: PRICE_SIGNAL_POLICY_KEY,
            policyVersion: policy.version,
            outlierMethod: 'modified_z_score_over_median_absolute_deviation',
            outlierThreshold: policy.outlierModifiedZThreshold,
            outlierMinDeviationBps: policy.outlierMinDeviationBps,
            quantileMethod: 'nearest_rank_over_observed_values',
            deduplication: 'one_offer_per_distinct_seller',
            minObservations: policy.minObservations,
            minDistinctSellers: policy.minDistinctSellers,
            minDistinctOffers: policy.minDistinctOffers,
            minCoverageDays: policy.minCoverageDays,
            typicalBandBps: policy.typicalBandBps,
            goodPriceBelowMedianBps: policy.goodPriceBelowMedianBps,
            materialDropBps: policy.materialDropBps,
          },
        }),
    rows,
    recommendations: derivePriceSignalRecommendations(rows),
    coverage: {
      subjectsExamined: subjects.length,
      subjectsMeasured: measured,
      subjectsUnmeasured: unmeasured,
    },
  };
}

/**
 * How many of a merchant's subjects have a price comparison AVAILABLE (#86
 * fact 9) — two counts, no credential, no chosen segment and no chosen currency.
 *
 * ## Why this is not "coverage", and why it is not the same number
 *
 * {@link readMerchantCompetitiveness}'s `coverage` is a rate over ONE condition
 * segment in ONE comparison currency, both named by the caller. It answers "of
 * the subjects I asked about in EUR, in the new-condition segment, how many
 * could you measure". This answers a different question: "of this merchant's
 * subjects, how many could be measured at all, each evaluated in the segment and
 * the currency the MERCHANT priced it in".
 *
 * **The two can legitimately disagree**, and a reader who compares them without
 * knowing why will conclude one is broken. A used-condition offer counts here
 * and is invisible to a `segment: 'new'` read; an offer listed in GBP counts here
 * and may be unmeasurable in a EUR read if its sample loses entries to an
 * unresolvable pair. Neither is wrong — they are answers to two questions, which
 * is why they have two names and why the definition travels with each of them.
 *
 * ## It is an exact AGGREGATION and invents nothing
 *
 * Every input is a `MerchantCompetitivenessRow.state` produced by
 * {@link buildSubjectRows} — the SAME function the merchant surface renders from,
 * called with the same policy. Nothing here decides what "measurable" means; it
 * counts subjects for which #82 already said `measured` at least once. That is
 * the whole reason it lives in this file rather than in the domain that consumes
 * it: a second definition of measurability, in another domain, is exactly the
 * second answer ADR 0002's one-verdict rule forbids.
 *
 * ## No credential
 *
 * Two counts disclose nothing the claim gate protects — it is the ROWS that
 * carry a merchant's own prices and its competitors' aggregates, and this
 * returns none of them. So the merchant is resolved from the id alone, which is
 * what lets a reporting SNAPSHOT be a function of the merchant and the window
 * rather than of whoever asked for it.
 *
 * Bounded by `limit`, exactly as the merchant surface is, and `subjectsExamined`
 * is returned so a caller can state the denominator rather than imply one.
 */
export async function countMerchantComparableSubjects(input: {
  readonly merchantId: string;
  readonly limit: number;
  readonly market?: string;
  readonly now?: Date;
}): Promise<{ readonly subjectsExamined: number; readonly subjectsComparable: number }> {
  const now = input.now ?? new Date();
  const active = await findActivePriceSignalPolicy();
  const policy = active === undefined ? undefined : toPriceSignalPolicy(active);

  const subjects = await listMerchantOfferSubjects({
    merchantId: input.merchantId,
    limit: input.limit,
  });

  let comparable = 0;
  let examined = 0;

  for (const subject of subjects) {
    const currency = asComparisonCurrency(subject.priceCurrency);
    // An offer whose listed currency Mercaria cannot compare in is EXAMINED and
    // not comparable, rather than skipped. Skipping it would shrink the
    // denominator and turn "we cannot compare this one" into a silently better
    // rate — the direction a merchant-facing figure must never round.
    examined += 1;
    if (currency === undefined) continue;

    const context = await buildPriceSignalContext({
      canonicalVariantId: subject.canonicalVariantId,
      segment: conditionGroupFor(subject.condition as ItemConditionKey),
      ...(input.market === undefined ? {} : { market: input.market }),
      currency,
      focusMerchantId: input.merchantId,
      ...(policy === undefined ? {} : { policy }),
      now,
    });

    if (buildSubjectRows(context, policy, input.merchantId).some((row) => row.state === 'measured')) {
      comparable += 1;
    }
  }

  return { subjectsExamined: examined, subjectsComparable: comparable };
}

/** The offer's listed currency, when it is one Mercaria can compare in. */
function asComparisonCurrency(currency: string | null): CurrencyCode | undefined {
  if (currency === null) return undefined;
  return (ALL_CURRENCY_CODES as readonly string[]).includes(currency)
    ? (currency as CurrencyCode)
    : undefined;
}

/** The seven insights for ONE of the merchant's subjects. */
function buildSubjectRows(
  context: PriceSignalContext,
  policy: PriceSignalPolicy | undefined,
  merchantId: string,
): MerchantCompetitivenessRow[] {
  const scope = context.input.scope;
  const sellerKey = `merchant:${merchantId}`;

  if (policy === undefined) {
    return [
      'position_vs_eligible_median',
      'cheapest_item_price',
      'cheapest_known_total',
      'losing_eligibility',
      'demand_without_native_offer',
      'own_price_movement',
      'official_channel_position',
    ].map((kind) => ({
      kind: kind as MerchantCompetitivenessRow['kind'],
      subject: subjectFor(scope, 'price_quality_label'),
      sample: EMPTY_PRICE_SIGNAL_SAMPLE,
      state: 'unmeasured' as const,
      reason: 'no_active_policy' as const,
    }));
  }

  const signals = derivePriceSignals(context.input);
  const rows: MerchantCompetitivenessRow[] = [];

  // 1 — position against the eligible market median. Mapped from the SAME
  // cross-sectional derivation `price_quality_label` uses, so a merchant's
  // dashboard and a shopper's badge cannot disagree about where a price sits.
  const label = signals.find((signal) => signal.kind === 'price_quality_label');
  if (label !== undefined && label.state === 'measured' && label.value.measure === 'label') {
    rows.push({
      kind: 'position_vs_eligible_median',
      subject: subjectFor(scope, 'price_quality_label'),
      sample: label.sample,
      state: 'measured',
      value: {
        measure: 'relative',
        current: label.value.current,
        reference: label.value.reference,
        deltaBps: label.value.deltaBps,
        position: priceMarketPositionFor(label.value.deltaBps, policy.typicalBandBps),
      },
    });
  } else {
    rows.push({
      kind: 'position_vs_eligible_median',
      subject: subjectFor(scope, 'price_quality_label'),
      sample: label?.sample ?? EMPTY_PRICE_SIGNAL_SAMPLE,
      state: 'unmeasured',
      reason:
        label !== undefined && label.state === 'unmeasured'
          ? label.reason
          : 'no_eligible_current_offer',
    });
  }

  // 2 and 3 — cheapest on item price and on known total.
  rows.push(
    cheapestRow(
      context,
      policy,
      'cheapest_item_price',
      sellerKey,
      context.input.currentItemPrice,
      context.focusObservedItemPrice,
      context.focusObservedItemValue,
    ),
  );
  rows.push(
    cheapestRow(
      context,
      policy,
      'cheapest_known_total',
      sellerKey,
      context.input.currentKnownTotal,
      context.input.focusKnownTotal,
      context.input.focusKnownTotal === undefined
        ? undefined
        : context.input.values.get(context.input.focusKnownTotal.id),
    ),
  );

  // 4 — offers losing eligibility, and why, in the merchant's own vocabulary.
  const lossReasons = new Set<MerchantEligibilityLossReason>();
  let ownOfferSeen = false;
  for (const [offerId, reasons] of context.exclusions) {
    const offer = context.offers.get(offerId);
    if (offer === undefined || offer.merchantId !== merchantId) continue;
    ownOfferSeen = true;
    for (const reason of reasons) {
      const mapped = MERCHANT_ACTIONABLE_LOSS[reason];
      if (mapped !== undefined) lossReasons.add(mapped);
    }
    // Delivery is not an #74 exclusion — an offer with unpublished postage is
    // perfectly eligible and simply cannot carry a known total. It is reported
    // here because it IS the reason that offer is missing from one of the two
    // comparisons a merchant reads, which is the question this row answers.
  }
  for (const offer of context.offers.values()) {
    if (offer.merchantId !== merchantId) continue;
    if (!offer.delivery.known) lossReasons.add('delivery_cost_unknown');
    if (offer.price === undefined) lossReasons.add('price_missing');
  }

  rows.push(
    lossReasons.size > 0
      ? {
          kind: 'losing_eligibility',
          subject: subjectFor(scope, 'price_quality_label'),
          sample: EMPTY_PRICE_SIGNAL_SAMPLE,
          state: 'measured',
          eligibilityLossReasons: [...lossReasons],
        }
      : {
          kind: 'losing_eligibility',
          subject: subjectFor(scope, 'price_quality_label'),
          sample: EMPTY_PRICE_SIGNAL_SAMPLE,
          state: ownOfferSeen || context.offers.size > 0 ? 'not_present' : 'unmeasured',
          ...(ownOfferSeen || context.offers.size > 0
            ? {}
            : { reason: 'no_eligible_current_offer' as const }),
        },
  );

  // 5 — demand without a native offer. A NAMED SEAM that fails closed: #77
  // defines no product-level demand metric, so this is `unmeasured` and says so
  // rather than reading a save count or a query volume that mean something else.
  const demand = resolveProductDemand();
  rows.push({
    kind: 'demand_without_native_offer',
    subject: subjectFor(scope, 'price_quality_label'),
    sample: EMPTY_PRICE_SIGNAL_SAMPLE,
    state: 'unmeasured',
    reason:
      demand.outcome === 'measured'
        ? 'no_eligible_current_offer'
        : 'demand_measurement_unavailable',
  });

  // 6 — movement against the merchant's OWN prior observation. The history in a
  // merchant context is merchant-scoped (the context passes `merchantId` to #78's
  // derivation), so this compares a seller with themselves and never with a rival.
  rows.push(ownPriceMovementRow(context, policy));

  // 7 — the official-channel comparison, only where #55 has VERIFIED it.
  const official = signals.find((signal) => signal.kind === 'official_store_position');
  const isOfficial = context.input.officialSellerKeys.has(sellerKey);
  if (!isOfficial) {
    rows.push({
      kind: 'official_channel_position',
      subject: subjectFor(scope, 'official_store_position'),
      sample: official?.sample ?? EMPTY_PRICE_SIGNAL_SAMPLE,
      state: 'not_present',
    });
  } else if (official !== undefined && official.state === 'measured') {
    rows.push({
      kind: 'official_channel_position',
      subject: official.subject,
      sample: official.sample,
      state: 'measured',
      value: official.value,
    });
  } else {
    rows.push({
      kind: 'official_channel_position',
      subject: subjectFor(scope, 'official_store_position'),
      sample: official?.sample ?? EMPTY_PRICE_SIGNAL_SAMPLE,
      state: 'unmeasured',
      reason:
        official !== undefined && official.state === 'unmeasured'
          ? official.reason
          : 'no_eligible_current_offer',
    });
  }

  return rows;
}

/**
 * Whether the merchant's own price beats every OTHER seller's.
 *
 * The reference is the cheapest OTHER seller, not the cheapest overall: comparing
 * a price against a minimum it is itself in answers "am I me", and on a thin
 * market the merchant would always be reported as exactly at the minimum.
 *
 * It is computed against the merchant's OBSERVED price rather than their eligible
 * one, which is what lets the `would_be_cheapest_item_price` recommendation exist
 * at all — a merchant whose offer went stale still needs to know their price
 * would win if they refreshed it.
 */
function cheapestRow(
  context: PriceSignalContext,
  policy: PriceSignalPolicy,
  kind: 'cheapest_item_price' | 'cheapest_known_total',
  sellerKey: string,
  entries: readonly PriceSampleEntry[],
  focus: PriceSampleEntry | undefined,
  focusValue: PriceHistoryValue | undefined,
): MerchantCompetitivenessRow {
  const scope = context.input.scope;
  const subject = subjectFor(
    scope,
    kind === 'cheapest_item_price' ? 'lowest_observed_item_price' : 'lowest_observed_known_total',
  );

  const others = entries.filter((entry) => entry.sellerKey !== sellerKey);
  const built = buildSample(others, {
    deduplicate: true,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });

  if (focus === undefined || focusValue === undefined) {
    return unmeasuredRow(kind, subject, built.sample, 'no_eligible_current_offer');
  }
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasuredRow(kind, subject, built.sample, shortfall);

  const cheapestOther = built.kept[0];
  const reference = cheapestOther === undefined ? undefined : context.input.values.get(cheapestOther.id);
  if (cheapestOther === undefined || reference === undefined) {
    return unmeasuredRow(kind, subject, built.sample, 'no_comparable_history');
  }

  const deltaBps = priceDeltaBps(focus.amount, cheapestOther.amount);
  return {
    kind,
    subject,
    sample: built.sample,
    state: 'measured',
    value: {
      measure: 'relative',
      current: focusValue,
      reference,
      deltaBps,
      position: priceMarketPositionFor(deltaBps, policy.typicalBandBps),
    },
    offerId: focus.offerId,
  };
}

/** The merchant's current price against their own most recent prior observation. */
function ownPriceMovementRow(
  context: PriceSignalContext,
  policy: PriceSignalPolicy,
): MerchantCompetitivenessRow {
  const scope = context.input.scope;
  const subject = subjectFor(scope, 'current_vs_recent_median');
  const focus = context.focusObservedItemPrice ?? context.input.focusItemPrice;
  const focusValue =
    context.focusObservedItemValue ??
    (context.input.focusItemPrice === undefined
      ? undefined
      : context.input.values.get(context.input.focusItemPrice.id));

  if (focus === undefined || focusValue === undefined) {
    return unmeasuredRow(
      'own_price_movement',
      subject,
      EMPTY_PRICE_SIGNAL_SAMPLE,
      'no_eligible_current_offer',
    );
  }

  const history = [...context.input.historyItemPrice].sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
  );
  const previous = history.find((entry) => entry.amount !== focus.amount);
  const sample: PriceSignalSample = {
    observations: history.length,
    distinctSellers: new Set(history.map((entry) => entry.sellerKey)).size,
    distinctOffers: new Set(history.map((entry) => entry.offerId)).size,
    coverageDays: 0,
    outliersExcluded: 0,
    deduplicated: 0,
  };

  if (history.length === 0) {
    return unmeasuredRow('own_price_movement', subject, sample, 'no_comparable_history');
  }
  if (previous === undefined) {
    // MEASURED and absent: the merchant has a price history and has not moved.
    return { kind: 'own_price_movement', subject, sample, state: 'not_present' };
  }

  const reference = context.input.values.get(previous.id);
  if (reference === undefined) {
    return unmeasuredRow('own_price_movement', subject, sample, 'no_comparable_history');
  }
  const deltaBps = priceDeltaBps(focus.amount, previous.amount);
  return {
    kind: 'own_price_movement',
    subject,
    sample,
    state: 'measured',
    value: {
      measure: 'relative',
      current: focusValue,
      reference,
      deltaBps,
      position: priceMarketPositionFor(deltaBps, policy.typicalBandBps),
    },
    offerId: focus.offerId,
  };
}

function unmeasuredRow(
  kind: MerchantCompetitivenessRow['kind'],
  subject: MerchantCompetitivenessRow['subject'],
  sample: PriceSignalSample,
  reason: PriceSignalUnmeasuredReason,
): MerchantCompetitivenessRow {
  return { kind, subject, sample, state: 'unmeasured', reason };
}
