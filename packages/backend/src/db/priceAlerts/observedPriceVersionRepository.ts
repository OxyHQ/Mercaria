/**
 * The ONE read this domain makes of #78's observation log, and it reads IDS.
 *
 * A trigger's identity names the observed-price VERSION — the immutable
 * `offer_price_snapshots` row that recorded the price being triggered on — and
 * this is where that id comes from. Nothing here reads an amount, a currency, an
 * anomaly or a change reason: the price a comparison used came from #74 and #57,
 * and reading it a second time out of the observation log would be a second
 * authority over one number.
 *
 * ## The direction of the dependency is deliberate and one-way
 *
 * #78's `price-history-isolation.test.ts` fails the build if any price-history
 * module reaches an alert, and that stays true — this reads THEM. The
 * observation log is append-only and immutable, so a reader cannot disturb it,
 * and it is written unconditionally on every offer write regardless of any
 * price-history flag (`recordOfferPriceObservation` is called from #57's two
 * write chokepoints and is gated by nothing).
 *
 * ## Why the LATEST rather than one matching the price
 *
 * An observation is written when the terms CHANGE, plus an anchor once per
 * interval — so an offer whose price has held for a week has one observation
 * from a week ago, and that row IS the version of the price being compared. A
 * lookup keyed on the amount would find nothing for a price that moved and back,
 * and would find the wrong row for two offers that happen to agree.
 */

import { desc, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { offerPriceSnapshots } from '../schema/priceHistory.js';

/**
 * The newest observation id per offer, for a whole page in ONE statement.
 *
 * `DISTINCT ON`, ordered by `observed_at` and then by id: a uuid v7 key is NOT
 * monotonic within a millisecond, so two observations taken in the same tick
 * would otherwise order arbitrarily and two evaluations of one unchanged offer
 * could pick different versions — which is a duplicate notification, not a
 * cosmetic difference.
 *
 * An offer with no observation is simply ABSENT from the map. The caller blocks
 * on it (`no_observed_price_version`) rather than inventing a version.
 */
export async function readLatestObservedPriceVersions(
  offerIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, string>> {
  if (offerIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([offerPriceSnapshots.offerId], {
      offerId: offerPriceSnapshots.offerId,
      id: offerPriceSnapshots.id,
    })
    .from(offerPriceSnapshots)
    .where(inArray(offerPriceSnapshots.offerId, [...offerIds]))
    .orderBy(
      offerPriceSnapshots.offerId,
      desc(offerPriceSnapshots.observedAt),
      desc(offerPriceSnapshots.id),
    );

  return new Map(rows.map((row) => [row.offerId, row.id]));
}
