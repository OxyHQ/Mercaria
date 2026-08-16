/**
 * `listing_pin_releases` — the append-only record of which connector-pinned
 * keys stopped being held, by whom (#427).
 *
 * The schema note on the table says why the release is written down when the
 * pin is not: removing the key destroys the only evidence the pin existed, so
 * the erasing act is the one that has to leave a trace.
 *
 * WRITE ONLY, deliberately. There is no reader here and no merchant or operator
 * surface renders the trail, because #427 asks for a release rather than a
 * history screen — and a `findPinReleases` nobody calls is the shape that gets
 * mistaken for a feature somebody shipped. Whoever answers a support case reads
 * these rows out of the database; the day a surface wants them, the read arrives
 * with the surface that uses it.
 */

import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingPinReleases } from '../schema/connectorPins.js';

/** One row of `listing_pin_releases`. */
export type ListingPinReleaseRecord = InferSelectModel<typeof listingPinReleases>;

/**
 * Record one row per key that was ACTUALLY removed.
 *
 * The caller passes the difference the UPDATE returned rather than what the
 * request asked for, so a converging repeat — a retry, a double tap, a second
 * dashboard — writes nothing and the trail stays a list of decisions rather
 * than a list of attempts. An empty set therefore issues no statement at all.
 */
export async function recordPinReleases(
  listingId: string,
  fields: readonly string[],
  releasedByOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (fields.length === 0) {
    return;
  }
  await db
    .insert(listingPinReleases)
    .values(fields.map((field) => ({ listingId, field, releasedByOxyUserId })));
}
