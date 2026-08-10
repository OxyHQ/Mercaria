/**
 * Deterministic, informational merchant recommendations (#82
 * §"Recommendations") — PURE, and derived from rows that have ALREADY been
 * computed.
 *
 * That derivation order is the safety property. A recommendation cannot assert
 * anything the competitiveness rows do not, cannot reach a sample the rows
 * refused, and cannot exist for a subject whose row is `unmeasured` — so
 * "insufficient samples return no certainty label" (acceptance 3) holds here for
 * free rather than being re-implemented and got subtly wrong.
 *
 * ## The two prohibitions, and where each actually lives
 *
 * **"Do not automatically change merchant prices."** No function here returns a
 * price, no module in this domain imports a catalogue write, and
 * `price-signal-isolation.test.ts` fails the build if one starts to. A
 * recommendation is a `kind` plus a subject plus a distance.
 *
 * **"Do not promise a sales outcome."** No `kind` could express one —
 * `PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS` names the four shapes such a promise
 * takes, disjoint from the allowed set — and the COPY lives in `@mercaria/ui`
 * rather than here, so a sentence that promised something would be a change to a
 * file this domain does not own and a test does scan.
 */

import type {
  MerchantCompetitivenessRow,
  PriceSignalRecommendation,
} from '@mercaria/shared-types';

/**
 * Turn a merchant's competitiveness rows into the recommendations they support.
 *
 * Deliberately NOT ranked, scored or capped: an ordering would be a judgement
 * about which gap matters most to a business this domain knows nothing about,
 * and the four kinds are few enough to show whole.
 */
export function derivePriceSignalRecommendations(
  rows: readonly MerchantCompetitivenessRow[],
): PriceSignalRecommendation[] {
  const recommendations: PriceSignalRecommendation[] = [];

  for (const row of rows) {
    if (row.state !== 'measured') continue;

    // 1 — "Your current price is 8% above the eligible median." The delta
    // travels as basis points and the sentence is `@mercaria/ui`'s, so the
    // figure a merchant reads and the figure a shopper's badge was computed from
    // are the same integer.
    if (
      row.kind === 'position_vs_eligible_median' &&
      row.value?.measure === 'relative' &&
      row.value.position === 'above'
    ) {
      recommendations.push({
        kind: 'above_eligible_median',
        subject: row.subject,
        deltaBps: row.value.deltaBps,
        derivedFrom: row.kind,
      });
    }

    // 2 — "Shipping is unknown, so Mercaria cannot calculate known total." The
    // only recommendation that names a CAUSE rather than a distance, and the one
    // a merchant can act on without touching a price at all.
    if (
      row.kind === 'losing_eligibility' &&
      row.eligibilityLossReasons?.includes('delivery_cost_unknown') === true
    ) {
      recommendations.push({
        kind: 'delivery_unknown_blocks_known_total',
        subject: row.subject,
        derivedFrom: row.kind,
      });
    }

    // 3 — "Refreshing inventory would make this offer eligible again." Emitted
    // for staleness and for unknown availability, which are the two losses a
    // refresh actually repairs; a `condition_unknown` or a missing destination
    // needs a catalogue correction and would not be fixed by re-reading the feed.
    if (
      row.kind === 'losing_eligibility' &&
      (row.eligibilityLossReasons?.includes('observation_stale') === true ||
        row.eligibilityLossReasons?.includes('availability_unknown') === true)
    ) {
      recommendations.push({
        kind: 'refresh_would_restore_eligibility',
        subject: row.subject,
        derivedFrom: row.kind,
      });
    }

    // 4 — "At this observed price, your offer would be the cheapest item price."
    //
    // WOULD, not IS, and the conditional is the whole point: it is emitted for a
    // merchant whose price is below every other seller's while their own offer is
    // not currently eligible. Saying "is" there would be false — the offer is not
    // in the comparison — and saying nothing would withhold the one fact that
    // makes fixing the eligibility worth their time.
    if (
      row.kind === 'cheapest_item_price' &&
      row.value?.measure === 'relative' &&
      row.value.position === 'below'
    ) {
      const losing = rows.find(
        (other) =>
          other.kind === 'losing_eligibility' &&
          other.state === 'measured' &&
          other.subject.canonicalProductId === row.subject.canonicalProductId &&
          other.subject.canonicalVariantId === row.subject.canonicalVariantId &&
          other.subject.segment === row.subject.segment,
      );
      if (losing !== undefined) {
        recommendations.push({
          kind: 'would_be_cheapest_item_price',
          subject: row.subject,
          deltaBps: row.value.deltaBps,
          derivedFrom: row.kind,
        });
      }
    }
  }

  return recommendations;
}
