/**
 * Price-history summaries in a comparison, and the policy that gates them
 * (#96 grounded input item 6: "price-history or price-signal summaries only
 * when policy permits").
 *
 * ## The policy is #78's own lever, read by the CALLER
 *
 * `PRICE_HISTORY_PUBLIC_READS_ENABLED` gates whether a deployment publishes
 * price history to buyers at all, and this module honours it rather than
 * reaching past it — the controller resolves it and passes
 * `priceSignalsPermitted`, so there is exactly one place the rollout is
 * decided. With it off, a comparison carries NO price signals and the
 * explanation package therefore has none to summarize, instead of a paragraph
 * quietly claiming a price is unusually low on evidence the deployment decided
 * not to serve.
 *
 * ## Only a POINT-BACKED low is carried, and it names its window
 *
 * #78's `PriceHistorySummary.lowest` is a {@link PriceHistoryExtreme} that
 * names its own segment, measure, window and contributing offer, and it is
 * absent when nothing was observed. What this module adds is the COVERAGE:
 * `coveredFrom`/`coveredThrough` travel with the signal so a "lowest in 90
 * days" over a series that only covers 12 of them cannot read as a 90-day
 * claim. A gap and an unbuilt range are different facts in #78 and they stay
 * different here.
 *
 * A `current_rate_reinterpretation` value is REFUSED. #78 makes it opt-in
 * because the honest answer to "I cannot price that in your currency" is
 * silence rather than a number with a footnote, and a comparison — where the
 * figure sits beside prices somebody can actually pay — is the last place that
 * footnote would survive.
 */

import type {
  ComparisonPriceSignal,
  CurrencyCode,
  PriceHistoryResponse,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { readPriceHistory } from '../price-history/read.service.js';
import { renderMoney } from './render.js';
import type { ComparisonRecordIndex } from './record-refs.js';

/**
 * The window a comparison asks about.
 *
 * Ninety days: long enough that a seasonal promotion is visible against it and
 * short enough that a discontinued model's launch price does not read as the
 * current market. A code constant rather than a parameter, because a caller
 * able to choose the window could choose the one that makes a price look best.
 */
export const COMPARISON_PRICE_SIGNAL_WINDOW_DAYS = 90;

export interface PriceSignalInput {
  readonly index: ComparisonRecordIndex;
  readonly subjectRef: string;
  readonly canonicalProductId: string;
  readonly comparisonCurrency: CurrencyCode;
  readonly market?: string;
}

/**
 * The lowest observed item price for one subject over the window, or nothing.
 *
 * Never throws. A price-history read is decoration on a comparison whose
 * deterministic half is already composed, so a failure answers ABSENCE — the
 * `getViewerGraph` posture #92 states for a signal that must not be able to
 * take a page down.
 */
export async function readSubjectPriceSignal(
  input: PriceSignalInput,
): Promise<ComparisonPriceSignal | undefined> {
  const now = new Date();
  const from = new Date(
    now.getTime() - COMPARISON_PRICE_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  let response: PriceHistoryResponse;
  try {
    response = await readPriceHistory(
      {
        scope: {
          kind: 'canonical_product',
          canonicalProductId: input.canonicalProductId,
          ...(input.market === undefined ? {} : { market: input.market.toUpperCase() }),
          displayCurrency: input.comparisonCurrency,
          granularity: 'day',
        },
        measure: 'lowest_item_price',
        segment: 'new',
        from: from.toISOString(),
        to: now.toISOString(),
      },
      now,
    );
  } catch {
    // Absence, deliberately. See the function docblock: a comparison must not
    // fail because a chart could not be built, and an absent signal is exactly
    // what "we have nothing to say about this price's history" means.
    return undefined;
  }

  const lowest = response.summary.lowest;
  if (lowest === undefined) return undefined;
  if (lowest.value.basis === 'current_rate_reinterpretation') return undefined;

  const covered = coverageOf(response, from, now);
  const ref = input.index.register({
    kind: 'price_signal',
    recordId: `${input.canonicalProductId}:lowest_item_price:new`,
  });

  return {
    ref,
    subjectRef: input.subjectRef,
    currency: input.comparisonCurrency,
    lowest: lowest.value.money,
    rendered: renderMoney(lowest.value.money),
    windowDays: COMPARISON_PRICE_SIGNAL_WINDOW_DAYS,
    coveredFrom: covered.from,
    coveredThrough: covered.through,
  };
}

/**
 * The range the series actually covers.
 *
 * The requested window MINUS whatever #78 reported as not yet built. A signal
 * that reported the requested window regardless would let an unbuilt series
 * masquerade as ninety days of evidence, which is the one way a "lowest in 90
 * days" can be false without any number being wrong.
 */
function coverageOf(
  response: PriceHistoryResponse,
  from: Date,
  to: Date,
): { from: string; through: string } {
  let start = from.getTime();
  let end = to.getTime();
  for (const uncovered of response.uncovered) {
    const uncoveredFrom = new Date(uncovered.from).getTime();
    const uncoveredTo = new Date(uncovered.to).getTime();
    if (uncoveredFrom <= start) start = Math.max(start, uncoveredTo);
    if (uncoveredTo >= end) end = Math.min(end, uncoveredFrom);
  }
  if (end < start) end = start;
  return { from: new Date(start).toISOString(), through: new Date(end).toISOString() };
}

/** Whether this deployment publishes price history to buyers at all (#78's lever). */
export function priceSignalsPermitted(): boolean {
  return config.priceHistory.publicReadsEnabled;
}
