/**
 * Collection service — store merchandising collections + membership materialization.
 *
 * Owns create/list/update/delete/get and manual product assignment for a store's
 * `Collection`s, plus the CORE of this phase: materializing a collection's
 * membership onto each `Listing.collectionIds` (denormalized, like `categorySlugs`)
 * so collection browse reads an indexed listing field. MANUAL collections use their
 * ordered `productIds`; AUTOMATED collections translate their `rules` into a Mongo
 * filter (scoped to the store's active store-owned listings) and reconcile membership
 * with two batched `updateMany`s (`$addToSet` / `$pull`).
 *
 * The reverse hook — recomputing which AUTOMATED collections a single product belongs
 * to after a product save — lives here (`recomputeAutomatedMembershipForListing`) and
 * is imported by `catalog-write.service` via a dynamic import to avoid an import cycle.
 * Every collection is scoped to its `storeId`, so a member only operates on their own
 * store's collections.
 */

import type {
  CreateCollectionInput,
  UpdateCollectionInput,
} from '@mercaria/shared-types';
import { Collection, type ICollection, type ICollectionRule } from '../models/collection.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';

/** A Mongo filter document (Mongoose 9 dropped the `FilterQuery` export). */
type ListingFilter = Record<string, unknown>;

/** Mongo duplicate-key error code (a unique-index violation). */
const MONGO_DUPLICATE_KEY = 11000;

/** True iff `err` is a Mongo duplicate-key (unique-index) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/** Escape regex metacharacters so a user value is matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** List a store's collections, newest first. The public path filters to published. */
export async function listCollections(
  storeId: string,
  opts: { publishedOnly?: boolean } = {},
): Promise<ICollection[]> {
  const filter: ListingFilter = { storeId };
  if (opts.publishedOnly) {
    filter.isPublished = true;
  }
  return Collection.find(filter).sort({ createdAt: -1 }).lean<ICollection[]>();
}

/** Resolve a single collection of a store by handle (optionally only published). */
export async function getCollectionByHandle(
  storeId: string,
  handle: string,
  opts: { publishedOnly?: boolean } = {},
): Promise<ICollection | null> {
  const filter: ListingFilter = { storeId, handle };
  if (opts.publishedOnly) {
    filter.isPublished = true;
  }
  return Collection.findOne(filter).lean<ICollection | null>();
}

/**
 * Create a collection for a store. Handle uniqueness per store is enforced by the
 * unique index; a duplicate handle maps to a CONFLICT. `publishedAt` is stamped
 * when the collection is published. Materializes membership after create.
 */
export async function createCollection(
  storeId: string,
  input: CreateCollectionInput,
): Promise<ICollection> {
  const isPublished = input.isPublished !== false;
  const doc: Partial<ICollection> = {
    storeId,
    title: input.title,
    handle: input.handle,
    type: input.type,
    productIds: input.productIds ?? [],
    sortOrder: input.sortOrder ?? 'manual',
    isPublished,
  };
  if (input.description !== undefined) doc.description = input.description;
  if (input.imageFileId !== undefined) doc.imageFileId = input.imageFileId;
  if (input.rules !== undefined) {
    doc.rules = {
      appliesDisjunctively: input.rules.appliesDisjunctively ?? false,
      conditions: input.rules.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    };
  }
  if (input.seo !== undefined) doc.seo = input.seo;
  if (isPublished) doc.publishedAt = new Date();

  let created: ICollection;
  try {
    const collection = await Collection.create(doc);
    created = collection.toObject();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('A collection with this handle already exists');
    }
    throw err;
  }

  await materializeMembership(created);
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
): Promise<ICollection> {
  const collection = await Collection.findOne({ _id: collectionId, storeId });
  if (!collection) {
    throw notFound('Collection not found');
  }

  if (patch.title !== undefined) collection.title = patch.title;
  if (patch.handle !== undefined) collection.handle = patch.handle;
  if (patch.description !== undefined) collection.description = patch.description;
  if (patch.imageFileId !== undefined) collection.imageFileId = patch.imageFileId;
  if (patch.type !== undefined) collection.type = patch.type;
  if (patch.productIds !== undefined) collection.productIds = [...patch.productIds];
  if (patch.rules !== undefined) {
    collection.rules = {
      appliesDisjunctively: patch.rules.appliesDisjunctively ?? false,
      conditions: patch.rules.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    };
  }
  if (patch.sortOrder !== undefined) collection.sortOrder = patch.sortOrder;
  if (patch.seo !== undefined) collection.seo = patch.seo;
  if (patch.isPublished !== undefined) {
    collection.isPublished = patch.isPublished;
    if (patch.isPublished && !collection.publishedAt) {
      collection.publishedAt = new Date();
    }
  }

  try {
    await collection.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('A collection with this handle already exists');
    }
    throw err;
  }

  const updated = collection.toObject();
  await materializeMembership(updated);
  return updated;
}

/**
 * Delete a collection (scoped to `storeId`, else NOT_FOUND) and pull its id from
 * every listing that carried it, so no `Listing.collectionIds` dangles.
 */
export async function deleteCollection(storeId: string, collectionId: string): Promise<void> {
  const result = await Collection.deleteOne({ _id: collectionId, storeId });
  if (result.deletedCount === 0) {
    throw notFound('Collection not found');
  }
  await Listing.updateMany(
    { collectionIds: collectionId },
    { $pull: { collectionIds: collectionId } },
  );
}

/**
 * Manual add/reorder: replace a MANUAL collection's `productIds` with `productIds`
 * (order preserved). Rejects automated collections (CONFLICT) and any id that is
 * not a store-owned listing of THIS store (VALIDATION_ERROR). Re-materializes.
 */
export async function setCollectionProducts(
  storeId: string,
  collectionId: string,
  productIds: string[],
): Promise<ICollection> {
  const collection = await Collection.findOne({ _id: collectionId, storeId });
  if (!collection) {
    throw notFound('Collection not found');
  }
  if (collection.type !== 'manual') {
    throw conflict('Cannot set products on an automated collection');
  }

  if (productIds.length > 0) {
    const known = await Listing.find({
      _id: { $in: productIds },
      ownerType: 'store',
      storeId,
    })
      .select('_id')
      .lean<Pick<IListing, '_id'>[]>();
    const knownIds = new Set(known.map((l) => String(l._id)));
    const unknown = productIds.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      throw validationError(`Unknown product ids for this store: ${unknown.join(', ')}`);
    }
  }

  collection.productIds = [...productIds];
  await collection.save();

  const updated = collection.toObject();
  await materializeMembership(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Collection product listing (browse)
// ---------------------------------------------------------------------------

/** A page of raw listings produced by the collection browse path. */
export interface CollectionProductsResult {
  listings: IListing[];
  total: number;
}

/**
 * Return a page of the ACTIVE listings in a collection (raw docs; the controller
 * hydrates). For a MANUAL collection sorted `manual`, products keep the hand-picked
 * `productIds` order (paged in memory). Otherwise the listings are ordered by the
 * collection's `sortOrder` and paged with `skip`/`limit`.
 */
export async function listCollectionProducts(
  collection: ICollection,
  opts: { page: number; limit: number },
): Promise<CollectionProductsResult> {
  const collectionId = String(collection._id);
  const baseFilter: ListingFilter = { collectionIds: collectionId, status: 'active' };
  const { page, limit } = opts;
  const skip = (page - 1) * limit;

  if (collection.type === 'manual' && collection.sortOrder === 'manual') {
    // Preserve the hand-picked order: fetch the active members, then order them by
    // their index in `productIds` (ids not active are dropped) and page in memory.
    const orderIndex = new Map<string, number>();
    collection.productIds.forEach((id, index) => orderIndex.set(id, index));

    const docs = await Listing.find(baseFilter).lean<IListing[]>();
    const ordered = docs
      .filter((l) => orderIndex.has(String(l._id)))
      .sort((a, b) => {
        const ai = orderIndex.get(String(a._id)) ?? 0;
        const bi = orderIndex.get(String(b._id)) ?? 0;
        return ai - bi;
      });

    return {
      listings: ordered.slice(skip, skip + limit),
      total: ordered.length,
    };
  }

  const sort = collectionSort(collection.sortOrder);
  const [listings, total] = await Promise.all([
    Listing.find(baseFilter).sort(sort).skip(skip).limit(limit).lean<IListing[]>(),
    Listing.countDocuments(baseFilter),
  ]);

  return { listings, total };
}

/**
 * Map a collection `sortOrder` to a Mongo sort. `best_selling` and `manual` (on an
 * automated collection) fall back to newest-first — there is no per-listing sales
 * counter yet, so newest is the current best-effort for `best_selling`.
 */
function collectionSort(sortOrder: ICollection['sortOrder']): Record<string, 1 | -1> {
  switch (sortOrder) {
    case 'price_asc':
      return { 'priceRange.min.amount': 1, _id: -1 };
    case 'price_desc':
      return { 'priceRange.min.amount': -1, _id: -1 };
    case 'created_desc':
      return { createdAt: -1, _id: -1 };
    case 'title_asc':
      return { title: 1, _id: -1 };
    case 'best_selling':
    case 'manual':
    default:
      return { createdAt: -1, _id: -1 };
  }
}

// ---------------------------------------------------------------------------
// Membership materialization (the core)
// ---------------------------------------------------------------------------

/**
 * Translate an automated collection's `rules` into a Mongo filter over the store's
 * active store-owned listings. AND combines conditions into an `$and` array; OR
 * into an `$or` array. A rule that cannot be translated is SKIPPED (automated
 * collections degrade gracefully). If NO condition survives, the collection matches
 * NOTHING (a filter that never matches) so it does not include the whole store.
 *
 * `compareAtPrice` is not denormalized on `Listing`, so its rules are resolved via a
 * `ProductVariant` lookup → the matching listing ids are constrained with `_id $in`.
 * This keeps materialization batched and correct, which is why the function is async.
 */
export async function buildAutomatedFilter(
  storeId: string,
  rules: ICollection['rules'] | undefined,
): Promise<ListingFilter> {
  const base: ListingFilter = { ownerType: 'store', storeId, status: 'active' };

  const conditions = rules?.conditions ?? [];
  const disjunctive = rules?.appliesDisjunctively ?? false;

  const predicates: ListingFilter[] = [];
  for (const rule of conditions) {
    const predicate = await translateRule(rule);
    if (predicate) {
      predicates.push(predicate);
    }
  }

  if (predicates.length === 0) {
    // No usable condition → match nothing (never include the whole store).
    return { ...base, _id: { $exists: false } };
  }

  if (disjunctive) {
    return { ...base, $or: predicates };
  }
  return { ...base, $and: predicates };
}

/** Mongo field a string/array rule field maps to. */
const STRING_FIELD: Record<string, string> = {
  title: 'title',
  productType: 'productType',
  vendor: 'vendor',
};
const ARRAY_FIELD: Record<string, string> = {
  tag: 'tags',
  categorySlug: 'categorySlugs',
};
const NUMERIC_OPERATOR: Record<string, '$gt' | '$lt' | '$gte' | '$lte'> = {
  gt: '$gt',
  lt: '$lt',
  gte: '$gte',
  lte: '$lte',
};

/**
 * Translate a single rule into a Mongo predicate fragment, or `null` when the rule
 * is unsupported for the field/operator combination (the caller skips it).
 */
async function translateRule(rule: ICollectionRule): Promise<ListingFilter | null> {
  const { field, operator, value } = rule;

  // String fields (title, productType, vendor): string operators only.
  const stringField = STRING_FIELD[field];
  if (stringField) {
    return stringPredicate(stringField, operator, value);
  }

  // Array fields (tags, categorySlugs): element equality / negation only.
  const arrayField = ARRAY_FIELD[field];
  if (arrayField) {
    if (operator === 'equals' || operator === 'contains') {
      return { [arrayField]: value };
    }
    if (operator === 'not_equals') {
      return { [arrayField]: { $ne: value } };
    }
    return null; // starts_with/ends_with/numeric on arrays → skip.
  }

  // Numeric price field: denormalized on the listing.
  if (field === 'price') {
    return numericPredicate('priceRange.min.amount', operator, value);
  }

  // Inventory → the listing's `hasInventory` boolean.
  if (field === 'inventory') {
    return inventoryPredicate(operator, value);
  }

  // compareAtPrice is variant-level; resolve listing ids via the variant collection.
  if (field === 'compareAtPrice') {
    return compareAtPricePredicate(operator, value);
  }

  return null;
}

/** Build a string predicate (exact/regex) for a string field, or null if unsupported. */
function stringPredicate(
  mongoField: string,
  operator: ICollectionRule['operator'],
  value: string,
): ListingFilter | null {
  const escaped = escapeRegExp(value);
  switch (operator) {
    case 'equals':
      return { [mongoField]: value };
    case 'not_equals':
      return { [mongoField]: { $ne: value } };
    case 'contains':
      return { [mongoField]: { $regex: escaped, $options: 'i' } };
    case 'starts_with':
      return { [mongoField]: { $regex: `^${escaped}`, $options: 'i' } };
    case 'ends_with':
      return { [mongoField]: { $regex: `${escaped}$`, $options: 'i' } };
    default:
      return null; // numeric operators on a string field → skip.
  }
}

/** Build a numeric predicate for a numeric field, or null if the operator/value is invalid. */
function numericPredicate(
  mongoField: string,
  operator: ICollectionRule['operator'],
  value: string,
): ListingFilter | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (operator === 'equals') {
    return { [mongoField]: num };
  }
  if (operator === 'not_equals') {
    return { [mongoField]: { $ne: num } };
  }
  const mongoOp = NUMERIC_OPERATOR[operator];
  if (!mongoOp) {
    return null; // string operators on a numeric field → skip.
  }
  return { [mongoField]: { [mongoOp]: num } };
}

/**
 * Build an inventory predicate against the listing's `hasInventory` boolean.
 * `> 0` / `>= 1` (and `equals` a positive value) → in stock; `equals 0` → out of
 * stock. Other combinations are unsupported and skipped.
 */
function inventoryPredicate(
  operator: ICollectionRule['operator'],
  value: string,
): ListingFilter | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (operator === 'equals') {
    return { hasInventory: num > 0 };
  }
  if (operator === 'not_equals') {
    return { hasInventory: !(num > 0) };
  }
  if ((operator === 'gt' && num >= 0) || (operator === 'gte' && num >= 1)) {
    return { hasInventory: true };
  }
  if ((operator === 'lt' && num <= 1) || (operator === 'lte' && num <= 0)) {
    return { hasInventory: false };
  }
  return null;
}

/**
 * Build a `compareAtPrice` predicate by resolving the variant-level
 * `compareAtPrice.amount` to its listing ids, then constraining `_id $in`.
 */
async function compareAtPricePredicate(
  operator: ICollectionRule['operator'],
  value: string,
): Promise<ListingFilter | null> {
  const variantFilter = numericPredicate('compareAtPrice.amount', operator, value);
  if (!variantFilter) {
    return null;
  }
  const variants = await ProductVariant.find(variantFilter)
    .select('listingId')
    .lean<Pick<IProductVariant, 'listingId'>[]>();
  const listingIds = [...new Set(variants.map((v) => String(v.listingId)))];
  return { _id: { $in: listingIds } };
}

/**
 * Materialize a collection's membership onto `Listing.collectionIds`: compute the
 * set of listing ids that SHOULD carry this collection, then reconcile the whole
 * store with two batched `updateMany`s — `$addToSet` for new members,
 * `$pull` for ex-members. `$addToSet` keeps the ADD idempotent.
 */
export async function materializeMembership(collection: ICollection): Promise<void> {
  const collectionId = String(collection._id);
  const shouldHave = await computeMembership(collection);

  await Listing.updateMany(
    { _id: { $in: shouldHave }, collectionIds: { $ne: collectionId } },
    { $addToSet: { collectionIds: collectionId } },
  );
  await Listing.updateMany(
    { storeId: collection.storeId, collectionIds: collectionId, _id: { $nin: shouldHave } },
    { $pull: { collectionIds: collectionId } },
  );
}

/** Compute the listing ids that should belong to a collection (manual or automated). */
async function computeMembership(collection: ICollection): Promise<string[]> {
  if (collection.type === 'manual') {
    return [...collection.productIds];
  }
  const filter = await buildAutomatedFilter(collection.storeId, collection.rules);
  const matched = await Listing.find(filter).select('_id').lean<Pick<IListing, '_id'>[]>();
  return matched.map((l) => String(l._id));
}

/**
 * Recompute which AUTOMATED collections of a listing's store the listing belongs to,
 * after a product save. Loads the listing (store-owned only; otherwise no-op), then
 * for each automated collection evaluates whether this single listing matches its
 * filter, and writes the reconciled `collectionIds` in one update — preserving
 * MANUAL collection ids (only automated ids are reconciled). Called by
 * `catalog-write.service` after a store product/variant mutation.
 */
export async function recomputeAutomatedMembershipForListing(listingId: string): Promise<void> {
  const listing = await Listing.findById(listingId)
    .select('ownerType storeId collectionIds')
    .lean<Pick<IListing, 'ownerType' | 'storeId' | 'collectionIds'> | null>();
  if (!listing || listing.ownerType !== 'store' || !listing.storeId) {
    return;
  }
  const storeId = String(listing.storeId);

  const automated = await Collection.find({ storeId, type: 'automated' }).lean<ICollection[]>();
  const automatedIds = automated.map((c) => String(c._id));

  const matchedAutomated: string[] = [];
  for (const collection of automated) {
    const filter = await buildAutomatedFilter(storeId, collection.rules);
    const matches = await Listing.exists({ _id: listingId, ...filter });
    if (matches) {
      matchedAutomated.push(String(collection._id));
    }
  }

  // Preserve manual (non-automated) ids; reconcile only automated ones.
  const current = listing.collectionIds ?? [];
  const preserved = current.filter((id) => !automatedIds.includes(id));
  const next = [...new Set([...preserved, ...matchedAutomated])];

  await Listing.updateOne({ _id: listingId }, { $set: { collectionIds: next } });
}
