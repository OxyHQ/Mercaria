/**
 * The public read — one product's or one variant's signals (#82 §"UI" 1–3).
 *
 * ## The explanation is part of the PAYLOAD, not a client concern
 *
 * #78's rule, for its reason: a summary composed on three clients is three
 * summaries, and the one that forgets to say which segment it used is the one
 * nobody is looking at. What the API states is what was MEASURED — the segment,
 * the market, the currency, the window, whether delivery is included, how many
 * sellers and observations were behind it, and what was set aside. What a signal
 * is CALLED ("Good price") is copy and lives in `@mercaria/ui`
 * `lib/price-signal-labels.ts`, keyed on the label and the reason, so two
 * surfaces cannot drift and a wording change is not a contract change.
 *
 * That split is issue UI 2 — "show history context rather than one unexplained
 * badge" — as a shape: a client CANNOT render the badge without the sentences,
 * because the sentences are the thing the server sends and the badge is a
 * lookup.
 */

import {
  PRICE_SIGNAL_POLICY_KEY,
  type ConditionGroup,
  type CurrencyCode,
  type PriceSignal,
  type PriceSignalSemantics,
  type PriceSignalsResponse,
} from '@mercaria/shared-types';
import {
  findActivePriceSignalPolicy,
  toPriceSignalPolicy,
} from '../../db/priceSignals/priceSignalPolicyRepository.js';
import { buildPriceSignalContext } from './context.service.js';
import { derivePriceSignals, subjectFor } from './signals.js';

export interface PriceSignalsReadRequest {
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly segment: ConditionGroup;
  readonly market?: string;
  readonly currency: CurrencyCode;
  readonly now?: Date;
}

/**
 * Read one subject's signals.
 *
 * With no active policy version this answers in ONE query: every signal is
 * `unmeasured`/`no_active_policy`, no semantics block is returned, and the
 * explanation says so. That is the deliberate divergence from #74's built-in
 * policy — a ranking must produce some order, a claim about a price need not be
 * made at all — and the honest rendering of it is a product page with no badge.
 */
export async function readPriceSignals(
  request: PriceSignalsReadRequest,
): Promise<PriceSignalsResponse> {
  const now = request.now ?? new Date();
  const active = await findActivePriceSignalPolicy();
  const policy = active === undefined ? undefined : toPriceSignalPolicy(active);

  const context = await buildPriceSignalContext({
    ...(request.canonicalProductId === undefined
      ? {}
      : { canonicalProductId: request.canonicalProductId }),
    ...(request.canonicalVariantId === undefined
      ? {}
      : { canonicalVariantId: request.canonicalVariantId }),
    segment: request.segment,
    ...(request.market === undefined ? {} : { market: request.market }),
    currency: request.currency,
    ...(policy === undefined ? {} : { policy }),
    now,
  });

  const signals = derivePriceSignals(context.input);

  return {
    subject: subjectFor(context.input.scope, 'price_quality_label'),
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
          } satisfies PriceSignalSemantics,
        }),
    signals,
    explanation: explainPriceSignals(signals),
  };
}

/**
 * The plain sentences a screen reader can read in order (issue UI 5).
 *
 * Every sentence names its segment, its market, its currency and its window,
 * because a "lowest price" with none of those is a number that cannot be wrong —
 * it does not say what it is about. `unmeasured` gets a sentence too, and that is
 * the point of the whole issue: "we do not have enough comparable data to say" is
 * information, and the alternative to saying it is a page that looks like the
 * feature is broken.
 */
export function explainPriceSignals(signals: readonly PriceSignal[]): string[] {
  const sentences: string[] = [];
  const first = signals[0];
  if (first === undefined) return sentences;

  const subject = first.subject;
  const scopeWords = [
    `Condition segment: ${subject.segment}.`,
    `Market: ${subject.market ?? 'all markets this item is offered in'}.`,
    `Prices shown in ${subject.currency}.`,
    `Observation window: ${subject.from} to ${subject.to}.`,
    subject.deliveryIncluded
      ? 'Totals include a delivery cost the seller published; offers that published none are excluded rather than treated as free.'
      : 'Figures are item prices and do not include delivery.',
    'Whether these prices include tax is not published by the sources they come from.',
  ];
  sentences.push(...scopeWords);

  for (const signal of signals) {
    if (signal.state === 'unmeasured') {
      sentences.push(
        `${signal.kind}: not enough comparable data (${signal.reason}); ` +
          `${signal.sample.observations} observations across ${signal.sample.distinctSellers} sellers.`,
      );
      continue;
    }
    if (signal.state === 'not_present') {
      sentences.push(
        `${signal.kind}: measured over ${signal.sample.observations} observations across ` +
          `${signal.sample.distinctSellers} sellers, and the condition does not hold.`,
      );
      continue;
    }
    sentences.push(
      `${signal.kind}: measured over ${signal.sample.observations} observations across ` +
        `${signal.sample.distinctSellers} sellers spanning ${signal.sample.coverageDays} days, ` +
        `with ${signal.sample.outliersExcluded} observation(s) set aside as outliers and ` +
        `${signal.sample.deduplicated} folded as duplicate seller listings.`,
    );
  }

  return sentences;
}
