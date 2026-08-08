/**
 * `listing_external_refs` — where a Mercaria-owned listing has been PUSHED.
 *
 * Distinct from `listings.source_*`, which is the single PULL origin: a listing
 * can be pushed to several connections, so this is many rows. It drives re-push
 * targeting and inbound-echo detection — recognising our own push coming back as
 * a webhook, so it is skipped rather than re-imported as a duplicate product.
 *
 * ## `UNIQUE(connection_id, external_id)` is a constraint Mongo could not state
 *
 * The embedded `externalRefs` array had no uniqueness at all, so two Mercaria
 * listings could both claim the same external product and the echo lookup would
 * resolve to whichever the array scan reached first. The unique index makes that
 * unrepresentable, which means {@link upsertExternalRef} can now RAISE where the
 * `$pull`-then-`$push` pair silently succeeded.
 *
 * That is deliberate and the error is not swallowed here. A collision means two
 * of this store's listings were pushed to one external product — a real
 * integration fault. Taking the mapping over would leave the losing listing
 * believing it is still mirrored, and every subsequent echo of that product would
 * be attributed to the wrong one.
 */

import { and, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingExternalRefs, listings } from '../schema/catalog.js';

/** One row of `listing_external_refs`. */
export type ListingExternalRefRecord = InferSelectModel<typeof listingExternalRefs>;

/** A push mirror as the connector records it. */
export interface NewExternalRef {
  listingId: string;
  connectionId: string;
  provider: ListingExternalRefRecord['provider'];
  externalId: string;
  pushedAt?: Date;
}

/**
 * Whether a listing of `storeId` was pushed to `connectionId` under `externalId`
 * — the inbound-echo check.
 *
 * The store scope is a JOIN rather than a denormalized column: the mirror row
 * belongs to the listing, and asking "is this OUR push coming back" is exactly a
 * question about whose listing it is.
 */
export async function listingPushedToConnection(
  storeId: string,
  connectionId: string,
  externalId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: listingExternalRefs.id })
    .from(listingExternalRefs)
    .innerJoin(listings, eq(listings.id, listingExternalRefs.listingId))
    .where(
      and(
        eq(listings.storeId, storeId),
        eq(listingExternalRefs.connectionId, connectionId),
        eq(listingExternalRefs.externalId, externalId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The external product id a listing was last pushed to one connection under, or
 * `null` when it has never been pushed there — the re-push target.
 */
export async function findExternalRefByListingAndConnection(
  listingId: string,
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingExternalRefRecord | null> {
  const [row] = await db
    .select()
    .from(listingExternalRefs)
    .where(
      and(
        eq(listingExternalRefs.listingId, listingId),
        eq(listingExternalRefs.connectionId, connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Record where a listing now lives on one connection, replacing any previous
 * mapping for that (listing, connection) pair.
 *
 * @throws A unique violation (SQLSTATE 23505) when a DIFFERENT listing already
 *   claims `(connectionId, externalId)`. See the module docblock: that is an
 *   integration fault worth surfacing, not a mapping to take over.
 */
export async function upsertExternalRef(
  ref: NewExternalRef,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx
      .delete(listingExternalRefs)
      .where(
        and(
          eq(listingExternalRefs.listingId, ref.listingId),
          eq(listingExternalRefs.connectionId, ref.connectionId),
        ),
      );
    await tx.insert(listingExternalRefs).values({
      listingId: ref.listingId,
      connectionId: ref.connectionId,
      provider: ref.provider,
      externalId: ref.externalId,
      pushedAt: ref.pushedAt ?? new Date(),
    });
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Drop every mapping a listing has to one connection — disconnecting a channel. */
export async function deleteExternalRefsForConnection(
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(listingExternalRefs)
    .where(eq(listingExternalRefs.connectionId, connectionId));
}
