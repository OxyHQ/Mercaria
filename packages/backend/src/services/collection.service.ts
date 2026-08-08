/**
 * Collection service — store merchandising collections + membership
 * materialization.
 *
 * Owns create/list/update/delete/get and manual product assignment for a store's
 * collections, plus the CORE of this phase: materializing a collection's
 * membership into `listing_collections`. MANUAL collections use their ordered
 * hand-picked list; AUTOMATED collections translate their rules into SQL (scoped
 * to the store's active store-owned listings) and reconcile membership with a
 * set-diff.
 *
 * The reverse hook — recomputing which AUTOMATED collections a single product
 * belongs to after a product save — lives here
 * (`recomputeAutomatedMembershipForListing`) and is imported by
 * `catalog-write.service` via a dynamic import to avoid an import cycle. Every
 * collection is scoped to its `storeId`, so a member only operates on their own
 * store's collections.
 *
 * ## Ported to Postgres — one relation replaced two denormalized arrays
 *
 * Mongo carried the membership TWICE: `Collection.productIds` (the hand-picked,
 * ordered input) and `Listing.collectionIds` (the materialized result of both
 * kinds). They are one `listing_collections` relation now, with `position`
 * carrying the manual order and NULL meaning "derived from rules".
 *
 * Three things follow, and each is a real behaviour change:
 *
 *  - **A manual collection's order is applied IN SQL.** Mongo carried no
 *    position, so paging a manual collection loaded EVERY member into the
 *    process, sorted it against an in-memory index and sliced the page out. A
 *    collection with ten thousand products read ten thousand documents to render
 *    twenty.
 *  - **A hand-picked id must name a real listing of this store.**
 *    `listing_collections.listing_id` is a real foreign key, so an unchecked id
 *    is SQLSTATE 23503 rather than the silent no-match Mongo produced. `create`
 *    and `update` therefore validate the list the same way `setProducts` always
 *    did — which also means a collection can no longer be created holding a
 *    product that does not exist.
 *  - **Deleting a collection cleans up atomically.** `deleteCollection` used to
 *    delete the document and then `$pull` its id out of every listing in a
 *    SECOND statement; `ON DELETE CASCADE` is that statement as a constraint, so
 *    it cannot half-happen if the process dies in between.
 */

import type { CreateCollectionInput, UpdateCollectionInput } from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  deleteCollection as deleteCollectionRow,
  findAutomatedCollections,
  findCollectionByHandle as findCollectionByHandleRow,
  findCollectionById,
  findCollectionProductsPage,
  findCollectionsByStore,
  findManualMemberIds,
  findManualMemberIdsByCollection,
  insertCollection,
  reconcileAutomatedMembership,
  replaceManualMembership,
  setListingAutomatedMemberships,
  updateCollection as updateCollectionRow,
  type CollectionRecord,
  type NewCollectionRule,
} from '../db/merchandising/collectionRepository.js';
import { translateRules } from '../db/merchandising/collectionRules.js';
import {
  findListingById,
  findStoreListingIdsMatching,
  findUnknownStoreListingIds,
  listingMatchesRules,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';

/** A collection as this service hands it out — the row plus its rules. */
export type Collection = CollectionRecord;

/** Map the request's rule conditions onto the child-table rows. */
function toRuleRows(
  conditions: { field: string; operator: string; value: string }[],
): NewCollectionRule[] {
  return conditions.map((c) => ({
    field: c.field as NewCollectionRule['field'],
    operator: c.operator as NewCollectionRule['operator'],
    value: c.value,
  }));
}

/** List a store's collections, newest first. The public path filters to published. */
export async function listCollections(
  storeId: string,
  opts: { publishedOnly?: boolean } = {},
): Promise<Collection[]> {
  return findCollectionsByStore(storeId, opts);
}

/** Resolve a single collection of a store by handle (optionally only published). */
export async function getCollectionByHandle(
  storeId: string,
  handle: string,
  opts: { publishedOnly?: boolean } = {},
): Promise<Collection | null> {
  return findCollectionByHandleRow(storeId, handle, opts);
}

/**
 * Reject any id that is not an ACTIVE store-owned listing of this store.
 *
 * Called before every write that stores a hand-picked list. Under Mongo this
 * check existed only on `setCollectionProducts`, and an unknown id elsewhere was
 * silently ignored; here the foreign key would turn it into a 23503, so the
 * check moved to every path that can write one.
 */
async function assertKnownProducts(storeId: string, productIds: readonly string[]): Promise<void> {
  const unknown = await findUnknownStoreListingIds(storeId, productIds);
  if (unknown.length > 0) {
    throw validationError(`Unknown product ids for this store: ${unknown.join(', ')}`);
  }
}

/**
 * Create a collection for a store. Handle uniqueness per store is enforced by the
 * unique index; a duplicate handle maps to a CONFLICT. `publishedAt` is stamped
 * when the collection is published. Materializes membership after create.
 */
export async function createCollection(
  storeId: string,
  input: CreateCollectionInput,
): Promise<Collection> {
  const isPublished = input.isPublished !== false;
  const productIds = input.productIds ?? [];
  if (productIds.length > 0) {
    await assertKnownProducts(storeId, productIds);
  }

  let created: Collection;
  try {
    created = await insertCollection(
      storeId,
      {
        title: input.title,
        handle: input.handle,
        type: input.type,
        description: input.description ?? null,
        imageFileId: input.imageFileId ?? null,
        rulesAppliesDisjunctively: input.rules?.appliesDisjunctively ?? false,
        sortOrder: input.sortOrder ?? 'manual',
        seoTitle: input.seo?.title ?? null,
        seoDescription: input.seo?.description ?? null,
        isPublished,
        publishedAt: isPublished ? new Date() : null,
      },
      toRuleRows(input.rules?.conditions ?? []),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A collection with this handle already exists');
    }
    throw err;
  }

  await materializeMembership(created, productIds);
  return created;
}

/**
 * Update a collection in place (scoped to `storeId`, else NOT_FOUND). A handle
 * change is guarded by the unique index → CONFLICT on collision. Publishing for
 * the first time stamps `publishedAt`. Re-materializes membership after save.
 */
export async function updateCollection(
  storeId: string,
  collectionId: string,
  patch: UpdateCollectionInput,
): Promise<Collection> {
  const existing = await findCollectionById(storeId, collectionId);
  if (!existing) {
    throw notFound('Collection not found');
  }
  if (patch.productIds !== undefined && patch.productIds.length > 0) {
    await assertKnownProducts(storeId, patch.productIds);
  }

  const columns: Parameters<typeof updateCollectionRow>[2] = {};
  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.handle !== undefined) columns.handle = patch.handle;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.imageFileId !== undefined) columns.imageFileId = patch.imageFileId;
  if (patch.type !== undefined) columns.type = patch.type;
  if (patch.rules !== undefined) {
    columns.rulesAppliesDisjunctively = patch.rules.appliesDisjunctively ?? false;
  }
  if (patch.sortOrder !== undefined) columns.sortOrder = patch.sortOrder;
  if (patch.seo !== undefined) {
    columns.seoTitle = patch.seo.title ?? null;
    columns.seoDescription = patch.seo.description ?? null;
  }
  if (patch.isPublished !== undefined) {
    columns.isPublished = patch.isPublished;
    if (patch.isPublished && !existing.publishedAt) {
      columns.publishedAt = new Date();
    }
  }

  let updated: Collection | null;
  try {
    updated = await updateCollectionRow(
      storeId,
      collectionId,
      columns,
      // `undefined` leaves the rules alone; an empty array clears them. Two
      // different requests, and collapsing them would make a title-only patch
      // silently delete every rule.
      patch.rules !== undefined ? toRuleRows(patch.rules.conditions) : undefined,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A collection with this handle already exists');
    }
    throw err;
  }
  if (!updated) {
    throw notFound('Collection not found');
  }

  await materializeMembership(updated, patch.productIds);
  return updated;
}

/**
 * Delete a collection (scoped to `storeId`, else NOT_FOUND). Its memberships go
 * with it through `ON DELETE CASCADE` — see the module docblock.
 */
export async function deleteCollection(storeId: string, collectionId: string): Promise<void> {
  if (!(await deleteCollectionRow(storeId, collectionId))) {
    throw notFound('Collection not found');
  }
}

/**
 * Manual add/reorder: replace a MANUAL collection's hand-picked products with
 * `productIds` (order preserved). Rejects automated collections (CONFLICT) and
 * any id that is not a store-owned listing of THIS store (VALIDATION_ERROR).
 */
export async function setCollectionProducts(
  storeId: string,
  collectionId: string,
  productIds: string[],
): Promise<Collection> {
  const collection = await findCollectionById(storeId, collectionId);
  if (!collection) {
    throw notFound('Collection not found');
  }
  if (collection.type !== 'manual') {
    throw conflict('Cannot set products on an automated collection');
  }

  await assertKnownProducts(storeId, productIds);
  await replaceManualMembership(collectionId, productIds);
  return collection;
}

/** A page of raw listings produced by the collection browse path. */
export interface CollectionProductsResult {
  listings: ListingRecord[];
  total: number;
}

/**
 * Return a page of the ACTIVE listings in a collection (raw rows; the caller
 * hydrates), in the collection's own sort order.
 *
 * The manual order is a real `ORDER BY` on `listing_collections.position` now —
 * see the module docblock for what that replaces.
 */
export async function listCollectionProducts(
  collection: Collection,
  opts: { page: number; limit: number },
): Promise<CollectionProductsResult> {
  const { rows, total } = await findCollectionProductsPage(
    collection.id,
    collection.sortOrder,
    collection.type === 'manual',
    opts.page,
    opts.limit,
  );
  return { listings: rows, total };
}

/**
 * Materialize a collection's membership.
 *
 * MANUAL: the hand-picked list IS the membership, so it is written wholesale
 * with its positions. `productIds === undefined` means the caller did not touch
 * the list, and the existing rows are left exactly as they are — rewriting them
 * from a re-read would be a no-op that churns `created_at` for nothing.
 *
 * AUTOMATED: the rules are translated to SQL, matched against the store's active
 * store-owned listings, and reconciled with a set-diff.
 */
export async function materializeMembership(
  collection: Collection,
  productIds?: readonly string[],
): Promise<void> {
  if (collection.type === 'manual') {
    if (productIds !== undefined) {
      await replaceManualMembership(collection.id, productIds);
    }
    return;
  }

  const predicate = translateRules(collection.rules, collection.rulesAppliesDisjunctively);
  const shouldHave = await findStoreListingIdsMatching(collection.storeId, predicate);
  await reconcileAutomatedMembership(collection.id, shouldHave);
}

/**
 * Recompute which AUTOMATED collections of a listing's store the listing belongs
 * to, after a product save. Manual memberships are untouched — the reconcile is
 * bounded to the store's automated collection ids, so a hand-picked row is not
 * reachable by it. Called by `catalog-write.service` after a store product or
 * variant mutation.
 */
export async function recomputeAutomatedMembershipForListing(listingId: string): Promise<void> {
  const listing = await findListingById(listingId);
  if (!listing || listing.ownerType !== 'store' || !listing.storeId) {
    return;
  }
  const storeId = listing.storeId;

  const automated = await findAutomatedCollections(storeId);
  if (automated.length === 0) {
    return;
  }

  const matched: string[] = [];
  for (const collection of automated) {
    const predicate = translateRules(collection.rules, collection.rulesAppliesDisjunctively);
    if (await listingMatchesRules(listingId, storeId, predicate)) {
      matched.push(collection.id);
    }
  }

  await setListingAutomatedMemberships(
    listingId,
    automated.map((c) => c.id),
    matched,
  );
}

/** A manual collection's hand-picked product ids, in order — the admin read. */
export async function getCollectionProductIds(collectionId: string): Promise<string[]> {
  return findManualMemberIds(collectionId);
}

/**
 * The hand-picked product ids of SEVERAL collections, in one query.
 *
 * The `Collection` DTO carries `productIds`, which was a field on the Mongo
 * document and came back for free with the collection. It is a relation now, so
 * every list endpoint batches it here rather than reading per collection.
 */
export async function getProductIdsByCollection(
  collections: readonly Collection[],
): Promise<Map<string, string[]>> {
  return findManualMemberIdsByCollection(collections.map((c) => c.id));
}
