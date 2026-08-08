/**
 * `collections`, `collection_rules` and the `listing_collections` membership.
 *
 * ## One table now holds what Mongo stored twice
 *
 * `Collection.productIds` (the hand-picked, ORDERED input of a manual
 * collection) and `Listing.collectionIds` (the MATERIALIZED membership of both
 * kinds) were two fields carrying the same set for a manual collection, and
 * `materialize` computed one from the other. They are ONE relation here, with
 * `position` carrying the only thing the two did not share: the hand-picked
 * order. **`position` is NULL exactly when the membership was derived from
 * rules.**
 *
 * That collapse is why there are two write paths and not one:
 * {@link replaceManualMembership} rewrites a small hand-picked list wholesale,
 * and {@link reconcileAutomatedMembership} set-diffs a potentially large derived
 * one. Using the wholesale form for a rules-derived membership would delete and
 * re-insert every row of a merchant's catalogue on every product save.
 */

import { and, asc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CollectionSortOrder } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { collectionRules, collections, listingCollections } from '../schema/merchandising.js';
import type { ListingRecord } from '../catalog/listingRepository.js';

/** One row of `collections`, with no rules attached. */
export type CollectionRow = InferSelectModel<typeof collections>;

/** One row of `collection_rules`. */
export type CollectionRuleRecord = InferSelectModel<typeof collectionRules>;

/** A collection with its rule set — the shape every caller above this layer wants. */
export interface CollectionRecord extends CollectionRow {
  readonly rules: CollectionRuleRecord[];
}

/** A rule as a caller supplies it. */
export interface NewCollectionRule {
  field: CollectionRuleRecord['field'];
  operator: CollectionRuleRecord['operator'];
  value: string;
}

/** The columns a caller may set when creating a collection. */
export interface NewCollection {
  title: string;
  handle: string;
  type: CollectionRow['type'];
  description?: string | null;
  imageFileId?: string | null;
  rulesAppliesDisjunctively?: boolean;
  sortOrder?: CollectionSortOrder;
  seoTitle?: string | null;
  seoDescription?: string | null;
  isPublished: boolean;
  publishedAt?: Date | null;
}

/**
 * Attach each collection's rules, in ONE query for the whole batch.
 *
 * A batched second query rather than a join, for the same reason
 * `storeRepository` attaches members that way: a join multiplies the collection
 * row by its rule count and every scalar column has to be de-duplicated back out.
 */
async function withRules(
  rows: CollectionRow[],
  db: DatabaseOrTransaction,
): Promise<CollectionRecord[]> {
  if (rows.length === 0) return [];

  const ruleRows = await db
    .select()
    .from(collectionRules)
    .where(
      inArray(
        collectionRules.collectionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(collectionRules.position));

  const byCollection = new Map<string, CollectionRuleRecord[]>();
  for (const rule of ruleRows) {
    const bucket = byCollection.get(rule.collectionId);
    if (bucket) bucket.push(rule);
    else byCollection.set(rule.collectionId, [rule]);
  }

  return rows.map((row) => ({ ...row, rules: byCollection.get(row.id) ?? [] }));
}

/** A store's collections, newest first. The public path filters to published. */
export async function findCollectionsByStore(
  storeId: string,
  opts: { publishedOnly?: boolean } = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord[]> {
  const rows = await db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.storeId, storeId),
        ...(opts.publishedOnly ? [eq(collections.isPublished, true)] : []),
      ),
    )
    .orderBy(sql`${collections.createdAt} desc`, sql`${collections.id} desc`);
  return withRules(rows, db);
}

/** One collection of a store by id, or `null` — the scoping IS the authorization. */
export async function findCollectionById(
  storeId: string,
  collectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord | null> {
  const rows = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.storeId, storeId)))
    .limit(1);
  const [record] = await withRules(rows, db);
  return record ?? null;
}

/** One collection of a store by handle, or `null`. */
export async function findCollectionByHandle(
  storeId: string,
  handle: string,
  opts: { publishedOnly?: boolean } = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord | null> {
  const rows = await db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.storeId, storeId),
        eq(collections.handle, handle),
        ...(opts.publishedOnly ? [eq(collections.isPublished, true)] : []),
      ),
    )
    .limit(1);
  const [record] = await withRules(rows, db);
  return record ?? null;
}

/** Every AUTOMATED collection of a store — the per-product membership recompute. */
export async function findAutomatedCollections(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord[]> {
  const rows = await db
    .select()
    .from(collections)
    .where(and(eq(collections.storeId, storeId), eq(collections.type, 'automated')));
  return withRules(rows, db);
}

/** Replace a collection's whole rule set. */
async function replaceRules(
  collectionId: string,
  rules: readonly NewCollectionRule[],
  db: DatabaseOrTransaction,
): Promise<void> {
  await db.delete(collectionRules).where(eq(collectionRules.collectionId, collectionId));
  if (rules.length === 0) return;
  await db.insert(collectionRules).values(
    rules.map((rule, position) => ({
      collectionId,
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      position,
    })),
  );
}

/**
 * Create a collection with its rules, atomically.
 *
 * The `collections_store_id_handle_key` unique index refuses a duplicate handle;
 * the service maps that to CONFLICT.
 */
export async function insertCollection(
  storeId: string,
  values: NewCollection,
  rules: readonly NewCollectionRule[],
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<CollectionRecord> => {
    const [row] = await tx
      .insert(collections)
      .values({ storeId, ...values })
      .returning();
    await replaceRules(row.id, rules, tx);
    const [record] = await withRules([row], tx);
    return record;
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Patch a collection scoped to its store, optionally replacing its rules.
 *
 * `rules === undefined` leaves the existing set alone; an empty array clears it.
 * The two are different requests and collapsing them would make a patch that
 * touches only the title silently delete every rule.
 */
export async function updateCollection(
  storeId: string,
  collectionId: string,
  patch: Partial<CollectionRow>,
  rules: readonly NewCollectionRule[] | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<CollectionRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<CollectionRecord | null> => {
    const [row] = await tx
      .update(collections)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(collections.id, collectionId), eq(collections.storeId, storeId)))
      .returning();
    if (!row) return null;
    if (rules !== undefined) {
      await replaceRules(collectionId, rules, tx);
    }
    const [record] = await withRules([row], tx);
    return record;
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Delete a collection scoped to its store. `false` when it was not that store's.
 *
 * The membership rows go with it: `listing_collections.collection_id` is
 * `ON DELETE CASCADE`, which is the second `$pull` statement the Mongo path ran
 * — as a constraint, so it cannot half-happen if the process dies between the two.
 */
export async function deleteCollection(
  storeId: string,
  collectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.storeId, storeId)))
    .returning({ id: collections.id });
  return rows.length > 0;
}

/** A manual collection's hand-picked listing ids, in their hand-picked order. */
export async function findManualMemberIds(
  collectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ listingId: listingCollections.listingId })
    .from(listingCollections)
    .where(eq(listingCollections.collectionId, collectionId))
    .orderBy(asc(listingCollections.position));
  return rows.map((row) => row.listingId);
}

/**
 * The hand-picked member ids of a BATCH of collections, each in its own order.
 *
 * One query for the whole page. The DTO carries `productIds`, which under Mongo
 * was a field ON the collection document and came back for free; here it is a
 * relation, so a per-collection read would be an N+1 on every admin list.
 */
export async function findManualMemberIdsByCollection(
  collectionIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, string[]>> {
  const byCollection = new Map<string, string[]>();
  if (collectionIds.length === 0) return byCollection;

  const rows = await db
    .select({
      collectionId: listingCollections.collectionId,
      listingId: listingCollections.listingId,
    })
    .from(listingCollections)
    .where(inArray(listingCollections.collectionId, [...collectionIds]))
    .orderBy(asc(listingCollections.position));

  for (const row of rows) {
    const bucket = byCollection.get(row.collectionId);
    if (bucket) bucket.push(row.listingId);
    else byCollection.set(row.collectionId, [row.listingId]);
  }
  return byCollection;
}

/**
 * Replace a MANUAL collection's membership wholesale, positions included.
 *
 * Wholesale rather than a set-diff because the ORDER is the payload: a diff that
 * left surviving rows untouched would keep their old positions, so reordering a
 * hand-picked list would appear to do nothing. The list is hand-picked and
 * therefore small.
 */
export async function replaceManualMembership(
  collectionId: string,
  orderedListingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx.delete(listingCollections).where(eq(listingCollections.collectionId, collectionId));
    if (orderedListingIds.length === 0) return;
    await tx.insert(listingCollections).values(
      orderedListingIds.map((listingId, position) => ({
        collectionId,
        listingId,
        position,
      })),
    );
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Reconcile an AUTOMATED collection's membership to exactly `shouldHave`.
 *
 * A set-diff in SQL — insert what is missing, delete what no longer matches —
 * rather than the two `updateMany`s Mongo used. `onConflictDoNothing` makes the
 * insert idempotent, which is what `$addToSet` bought.
 *
 * The third statement clears any `position` left over from a collection that
 * used to be MANUAL: a derived membership carrying a hand-picked order
 * contradicts what NULL means in this table. It matches no row in the ordinary
 * case.
 */
export async function reconcileAutomatedMembership(
  collectionId: string,
  shouldHave: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    if (shouldHave.length > 0) {
      await tx
        .insert(listingCollections)
        .values(shouldHave.map((listingId) => ({ collectionId, listingId, position: null })))
        .onConflictDoNothing({
          target: [listingCollections.listingId, listingCollections.collectionId],
        });
    }

    await tx
      .delete(listingCollections)
      .where(
        and(
          eq(listingCollections.collectionId, collectionId),
          // `notInArray` and not `<> all(array)`: the latter binds a TUPLE and
          // Postgres raises `op ANY/ALL (array) requires array on right side`.
          ...(shouldHave.length > 0
            ? [notInArray(listingCollections.listingId, [...shouldHave])]
            : []),
        ),
      );

    await tx
      .update(listingCollections)
      .set({ position: null })
      .where(
        and(
          eq(listingCollections.collectionId, collectionId),
          sql`${listingCollections.position} is not null`,
        ),
      );
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Reconcile ONE listing's membership across a DERIVED set of collections,
 * leaving every hand-picked membership untouched.
 *
 * ## `position IS NULL` on the delete is what makes that true, not the scope
 *
 * The obvious reading is that bounding the delete to `managedIds` is enough,
 * because a caller passes "the automated collections of this store" and a manual
 * membership cannot live in one. That holds for `collection.service`'s
 * per-product recompute and is FALSE for the other caller:
 * `connector-sync.applyCollectionMapping` passes the codomain of the merchant's
 * own `collectionMapping`, an arbitrary set that may well name a MANUAL
 * collection. A re-sync that stopped seeing an external collection ref would then
 * delete the row a merchant hand-picked, and its `position` with it.
 *
 * Mongo could not lose that row: hand-picked membership lived in
 * `Collection.productIds`, a different field from the `Listing.collectionIds`
 * array this path rewrote, so the two could not collide. They are ONE relation
 * now — which is the point of the port — so the guard has to be explicit.
 * `position IS NULL` is exactly "this membership was derived", so the delete
 * cannot reach a hand-picked row however the caller scopes it.
 *
 * The insert is `ON CONFLICT DO NOTHING`, so a derived membership that lands on a
 * row a merchant already hand-picked leaves that row — and its position —
 * untouched rather than demoting it to derived.
 */
export async function setListingAutomatedMemberships(
  listingId: string,
  managedIds: readonly string[],
  matchedIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (managedIds.length === 0) return;

  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    if (matchedIds.length > 0) {
      await tx
        .insert(listingCollections)
        .values(matchedIds.map((collectionId) => ({ collectionId, listingId, position: null })))
        .onConflictDoNothing({
          target: [listingCollections.listingId, listingCollections.collectionId],
        });
    }

    const stale = managedIds.filter((id) => !matchedIds.includes(id));
    if (stale.length > 0) {
      await tx
        .delete(listingCollections)
        .where(
          and(
            eq(listingCollections.listingId, listingId),
            inArray(listingCollections.collectionId, stale),
            sql`${listingCollections.position} is null`,
          ),
        );
    }
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * The ORDER BY for a collection browse.
 *
 * `best_selling` falls back to newest-first: there is no per-listing sales
 * counter yet, and the Mongo path made the same substitution. `manual` on an
 * AUTOMATED collection also falls back, because every one of its positions is
 * NULL by construction.
 */
function collectionOrder(sortOrder: CollectionSortOrder, manual: boolean): SQL[] {
  switch (sortOrder) {
    case 'price_asc':
      return [
        sql`${listings.priceRangeMinAmount} asc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    case 'price_desc':
      return [
        sql`${listings.priceRangeMinAmount} desc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    case 'title_asc':
      return [sql`${listings.title} asc`, sql`${listings.id} desc nulls last`];
    case 'manual':
      if (manual) {
        return [
          sql`${listingCollections.position} asc nulls last`,
          sql`${listings.id} desc nulls last`,
        ];
      }
      return [sql`${listings.createdAt} desc`, sql`${listings.id} desc nulls last`];
    default:
      return [sql`${listings.createdAt} desc`, sql`${listings.id} desc nulls last`];
  }
}

/**
 * A page of a collection's ACTIVE listings, in the collection's own sort order.
 *
 * The manual order is applied IN SQL. Mongo could not — `Listing.collectionIds`
 * carried no position, so `listCollectionProducts` loaded every member of the
 * collection into the process, sorted them against an in-memory index of
 * `productIds` and sliced the page out. A collection with ten thousand products
 * read ten thousand documents to render twenty.
 */
export async function findCollectionProductsPage(
  collectionId: string,
  sortOrder: CollectionSortOrder,
  manual: boolean,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listingCollections.collectionId, collectionId),
    eq(listings.status, 'active'),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select({ listing: listings })
      .from(listingCollections)
      .innerJoin(listings, eq(listings.id, listingCollections.listingId))
      .where(where)
      .orderBy(...collectionOrder(sortOrder, manual))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(listingCollections)
      .innerJoin(listings, eq(listings.id, listingCollections.listingId))
      .where(where),
  ]);

  return { rows: rows.map((row) => row.listing), total: totals?.count ?? 0 };
}
