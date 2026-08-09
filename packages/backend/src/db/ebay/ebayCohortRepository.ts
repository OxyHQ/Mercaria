/**
 * The items Mercaria currently believes one eBay source publishes — the cohort a
 * VERIFICATION pass re-reads.
 *
 * ## Why this read exists, and why it is only a list of provider ids
 *
 * eBay's API License Agreement obliges Mercaria to delete content once the
 * listing is no longer publicly available. Absence from a SEARCH does not
 * establish that (eBay refuses an `offset` past 10,000, and an item can be
 * public and simply not in this week's results), so the only way to establish it
 * is to ask eBay about the items Mercaria holds, by id.
 *
 * The adapter therefore needs the id list, and this is the narrowest possible
 * way to give it one: `listTrackedItemIds` returns a `string[]` of the
 * PROVIDER's own ids — information the adapter is about to send back to the
 * provider. No offer, no merchant, no price, no canonical anything, and no row.
 *
 * ## Keyset on the external id, and why the ORDER matters more than usual
 *
 * A verification pass resumes exactly where a lease expired. If the cohort
 * reordered between pages, an item could be skipped — and a skipped item in a
 * verification pass is an item that gets RETIRED for having been missed, which
 * is the failure this whole domain is arranged to prevent. `external_id` is the
 * provider's own stable key and its ascending order does not change; a
 * creation-ordered cursor over a uuid v7 primary key would (the finding in
 * `~/Oxy/AGENTS.md`: uuid v7 is not monotonic within a millisecond).
 *
 * ## `retired` objects are excluded and quarantined ones are NOT
 *
 * A retired object has already left; re-verifying it would spend budget to learn
 * nothing. A QUARANTINED one is being held out of the pipeline over a content
 * decision an operator has not answered, and it is still an item Mercaria
 * tracks — excluding it would let it silently expire while somebody was deciding
 * about it.
 */

import { and, asc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { catalogSourceObjects } from '../schema/ingestion.js';

/**
 * The tracked external ids of one source, in ascending id order, after a cursor.
 *
 * @param afterExternalId Exclusive. `null` starts from the beginning.
 */
export async function listTrackedEbayItemIds(
  db: DatabaseOrTransaction = getDb(),
  input: {
    sourceId: string;
    afterExternalId: string | null;
    limit: number;
    notSeenSince?: Date | null;
  },
): Promise<string[]> {
  const scope = and(
    eq(catalogSourceObjects.sourceId, input.sourceId),
    ne(catalogSourceObjects.state, 'retired'),
    ...(input.afterExternalId === null
      ? []
      : [gt(catalogSourceObjects.externalId, input.afterExternalId)]),
    // Items DISCOVERY already re-observed in this pass need no second question.
    // Served by `catalog_source_objects_source_seen_idx`, which leads on
    // `(source_id, last_seen_at)`.
    ...(input.notSeenSince === undefined || input.notSeenSince === null
      ? []
      : [lt(catalogSourceObjects.lastSeenAt, input.notSeenSince)]),
  );

  const rows = await db
    .select({ externalId: catalogSourceObjects.externalId })
    .from(catalogSourceObjects)
    .where(scope)
    .orderBy(asc(catalogSourceObjects.externalId))
    .limit(input.limit);
  return rows.map((row) => row.externalId);
}

/**
 * How many items one source tracks — the denominator of the reconciliation
 * sample and the input to the budget an operator plans a verification pass with.
 */
export async function countTrackedEbayItems(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogSourceObjects)
    .where(
      and(eq(catalogSourceObjects.sourceId, sourceId), ne(catalogSourceObjects.state, 'retired')),
    );
  return row?.total ?? 0;
}
