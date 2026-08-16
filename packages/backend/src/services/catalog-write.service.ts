/**
 * Catalog write service — the SINGLE funnel for catalog mutations.
 *
 * Both the P2P seller path and the store-product path create/update listings and
 * their variants through here, so the denormalized listing facets
 * (`priceRange`, `hasInventory`, `variantCount`) ALWAYS stay in sync with the
 * variant rows. `syncListingFacets` is the one place those facets are recomputed
 * and persisted; `inventory.service` re-uses it after stock changes (no duplicate
 * facet logic anywhere).
 *
 * P2P listings hide the variant model behind a flat `price`/`quantity` API: a
 * single Shopify-style "Default Title" variant is created. Store products take an
 * explicit `variants[]`.
 *
 * ## Ported to Postgres
 *
 * One Mongoose document became four tables (`listings` + images + options +
 * variants), so every write goes through the repositories, which own the SQL and
 * the atomicity. Three things genuinely change:
 *
 *  - **The facet recompute is an AGGREGATE, not a read-reduce-write.** The Mongo
 *    version pulled every variant into the process to compute min/max. The rows
 *    never leave the database now, and a listing with NO variants correctly
 *    clears its price range — see `recomputeListingFacets` for the empty-aggregate
 *    trap that makes the obvious single-statement form wrong.
 *  - **A listing, its images, options, VARIANTS and their stock are created in
 *    ONE transaction.** Mongo wrote the document once, so the question did not
 *    arise; six tables make a half-created product possible, and it renders as a
 *    product page with no gallery, no size picker and nothing to buy. The
 *    variants and levels joined that transaction with #221 — see
 *    `createStoreProduct` for the failure that made a listing with no variants
 *    an everyday outcome rather than a theoretical one.
 *  - **An absent SKU or barcode is written NULL, never `''`.** Both carried a
 *    partial unique index until #296 dropped them, and the rule outlived the
 *    constraint: an empty string is a VALUE where NULL is an absence, so `''`
 *    is now a SKU every unlabelled variant shares rather than a collision — see
 *    `insertVariants` for what that breaks.
 */

import type {
  CreateP2PListingInput,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  Money,
  UpdateListingInput,
} from '@mercaria/shared-types';
import {
  MERCHANT_ARCHIVABLE_LISTING_STATUSES,
  SELLER_SETTABLE_LISTING_STATUSES,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  findListingById,
  findListingChildren,
  findListingHandleOwner,
  insertListing,
  recomputeListingFacets,
  replaceListingImages,
  setListingStatusIfIn,
  updateListingColumns,
  type ListingImageInput,
  type ListingRecord,
  type ListingSourceProvenance,
} from '../db/catalog/listingRepository.js';
import { getDb } from '../db/postgres.js';
import {
  assertConditionAllowed,
  conditionColumnsFor,
  writeListingConditionEvidence,
  type ConditionActor,
} from './condition/condition-write.service.js';
import { resolveConditionInput, type ResolvedConditionInput } from './condition/condition-input.js';
import { narrowStoredCondition } from './condition/condition-projection.js';
import {
  countVariants,
  deleteVariant,
  nextVariantPosition,
  findVariantsByListing,
  insertVariants,
  recomputeVariantRollup,
  updateVariant as updateVariantColumns,
  type NewVariant,
  type OptionValueInput,
  type VariantSourceProvenance,
} from '../db/catalog/variantRepository.js';
import { insertLevels, setLevelAvailable } from '../db/catalog/inventoryLevelRepository.js';
import { findCategoryBySlug } from '../db/catalog/categoryRepository.js';
import { findDefaultLocationId } from '../db/stores/locationRepository.js';
import { adjustStoreProductCount } from '../db/stores/storeRepository.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import { getOrCreate as getOrCreateSellerProfile } from './seller-profile.service.js';
import { requestNativeOfferSync } from './offers/native-offer.service.js';
import { requestNativeVariantMatch } from './matching/match.service.js';

/** The default variant title for single-variant (P2P) listings. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * After a STORE product/variant mutation, recompute which AUTOMATED collections
 * of the store the listing belongs to. Best-effort: a membership recompute
 * failure must not fail the write. Uses a DYNAMIC import of `collection.service`
 * to break the import cycle (`collection.service` imports `syncListingFacets`
 * and types from here), mirroring `inventory.service`'s dynamic import of the
 * queue producers.
 */
async function recomputeCollectionMembership(listingId: string): Promise<void> {
  try {
    const { recomputeAutomatedMembershipForListing } = await import('./collection.service.js');
    await recomputeAutomatedMembershipForListing(listingId);
  } catch (err) {
    log.general.warn({ err, listingId }, 'Failed to recompute automated collection membership');
  }
}

/**
 * Resolve a store's default location id — the `isDefault` one, falling back to
 * ANY active one. Throws NOT_FOUND when the store has none (every store gets one
 * at creation and via the migration backfill).
 *
 * Owned HERE rather than in `inventory.service` so the catalogue write path and
 * inventory routing share one implementation WITHOUT an import cycle
 * (`inventory.service` already imports this module for `syncListingFacets`). The
 * repository below it returns `null` rather than throwing, because "this store
 * has no location" is a fact about the data and NOT_FOUND is this service's
 * contract for it.
 */
export async function resolveDefaultLocationId(storeId: string): Promise<string> {
  const locationId = await findDefaultLocationId(storeId);
  if (!locationId) {
    throw notFound('No location for store');
  }
  return locationId;
}

/**
 * Recompute and persist a store variant's scalar `inventory.{available,committed}`
 * as the SUM over its `inventory_levels` rows. This is the ONE place the rollup
 * is computed; `inventory.service.rollupVariant` delegates here (the dependency
 * only flows inventory → catalog-write, never back, so no cycle). A variant with
 * no level rows — an untracked or P2P variant — sums to zero.
 */
export async function recomputeVariantScalarFromLevels(variantId: string): Promise<void> {
  await recomputeVariantRollup(variantId);
}

/** Resolve a category slug to its id + denormalized `[ancestor..., slug]` path. */
async function resolveCategory(
  slug: string,
): Promise<{ categoryId: string; categorySlugs: string[] }> {
  const category = await findCategoryBySlug(slug);
  if (!category) {
    throw notFound(`Category not found: ${slug}`);
  }
  return {
    categoryId: category.id,
    categorySlugs: [...category.ancestorSlugs, category.slug],
  };
}

/** Map input image file ids to the `listing_images` rows they expand into. */
function toListingImages(imageFileIds: string[]): ListingImageInput[] {
  if (imageFileIds.length > config.catalog.maxImagesPerListing) {
    throw validationError(
      `A listing may have at most ${config.catalog.maxImagesPerListing} images`,
    );
  }
  return imageFileIds.map((fileId, position) => ({ fileId, position }));
}

/**
 * Recompute and persist a listing's denormalized facets from its variants:
 * `priceRange.min/max`, `hasInventory` (any untracked variant OR any tracked one
 * with stock), and `variantCount`.
 *
 * Shared by this service and `inventory.service`. Returns nothing: the Mongo
 * version handed back the variant docs so a caller could avoid a re-query, and
 * no caller ever did.
 *
 * ## It is also where the native OFFER projection is requested (#57)
 *
 * ADR 0002 D18 binds native offers to "the same `catalog-write` chokepoint that
 * already maintains `syncListingFacets`", and this is that chokepoint: every
 * create, update, variant change and stock movement in this service and in
 * `inventory.service` passes through here. The request is a durable outbox row,
 * not a synchronous rebuild, so a comparison projection can never fail a
 * catalogue write.
 *
 * Four paths deliberately do NOT reach here and call `requestNativeOfferSync`
 * themselves, because each changes a status without touching a variant, so the
 * facets do not move: {@link archiveListing}; moderation enforcement, which
 * lives in another service entirely; `channel-disconnect.service`, which applies
 * a merchant's disconnect policy; and `connector-sync.service`'s
 * `archiveSourcedListing`, behind the `product_delete` webhook, the post-backfill
 * delete reconciliation and #386's unpublish.
 *
 * They are listed here rather than left to be discovered, because a status-only
 * write path that forgot would leave a listing's offers claiming it is on sale.
 * The connector's was exactly that omission and went unnoticed from the start —
 * see #388 and `archiveSourcedListing`'s own header. Anything added to this list
 * is a path a reader should check, not a path that is exempt from converging.
 *
 * ## …and where the canonical MATCH is requested (#58)
 *
 * The two requests are made together and are deliberately not one request. They
 * answer different questions and can be enabled independently: matching decides
 * WHICH canonical variant a native variant is (and writes the
 * `native_listing_links` row that #57 defined and left unwritten), while offer
 * convergence decides what the listing's own offer rows should say. The order is
 * load-bearing only in the sense that an attachment written by the matcher
 * enqueues a SECOND convergence itself — so a listing whose variant is matched
 * for the first time converges again immediately afterwards and materializes the
 * offer it could not have before.
 *
 * Both are durable outbox rows and both swallow their own failures, so a
 * catalogue write cannot fail because a projection or a matcher could not be
 * QUEUED (#58 operations 4).
 */
export async function syncListingFacets(listingId: string): Promise<void> {
  await recomputeListingFacets(listingId);
  await requestNativeOfferSync(listingId);

  // Per VARIANT, because that is the grain a canonical attachment lives at: two
  // variants of one listing are two different trade items and may match two
  // different canonical variants, or one may match and the other may not.
  const variants = await findVariantsByListing(listingId);
  for (const variant of variants) {
    await requestNativeVariantMatch({ productVariantId: variant.id, trigger: 'catalog_write' });
  }
}

/** Where a P2P listing's coarse public location comes from, when the seller opted in. */
export interface P2PListingPlacement {
  longitude: number;
  latitude: number;
}

/**
 * Write a P2P listing, its gallery, its condition evidence and its single
 * variant — all inside the CALLER's transaction.
 *
 * Extracted from {@link createP2PListing} so #91's publication can commit the
 * listing, its native attachment and the draft's own publication stamp together.
 * A publication spread across three transactions has a crash window in which a
 * listing exists that no draft names, and the retry then creates a second one —
 * exactly what #91 acceptance 3 forbids.
 *
 * Two things moved INTO the transaction as part of that extraction and are
 * strictly better there: the variant insert (a listing with no variant is not a
 * sellable state anything should observe) and, for the caller, whatever else
 * belongs with it. `syncListingFacets` deliberately stays OUTSIDE, because it
 * enqueues outbox work whose whole point is that it survives independently.
 */
export async function insertP2PListingWithin(
  tx: Parameters<typeof insertListing>[3],
  oxyUserId: string,
  input: CreateP2PListingInput,
  placement: P2PListingPlacement | null,
  now: Date,
): Promise<string> {
  const { categoryId, categorySlugs } = await resolveCategory(input.category);

  const quantity = input.quantity ?? 1;

  // #90: exactly one of the two spellings, and a P2P listing must state one.
  // A create with neither is a client that has not been updated for the
  // taxonomy AND is not speaking v1 either — there is nothing to infer from.
  const resolvedCondition = resolveConditionInput(input);
  if (!resolvedCondition) {
    throw validationError('A listing must state its condition');
  }
  const conditionColumns = conditionColumnsFor(resolvedCondition, now);

  // Multi-currency: the price is stored in its NATIVE currency exactly as given
  // (no FAIR conversion). Settlement to FAIR happens later, at the paid boundary.
  const price = input.price;

  await assertConditionAllowed(tx, {
    resolved: resolvedCondition,
    categoryId,
    categorySlugs,
  });

  const listing = await insertListing(
    {
      ownerType: 'user',
      oxyUserId,
      storeId: null,
      title: input.title,
      description: input.description,
      ...conditionColumns,
      conditionSourceLabel: null,
      status: 'active',
      categoryId,
      categorySlugs,
      tags: input.tags ?? [],
      priceRangeMinAmount: price.amount,
      priceRangeMinCurrency: price.currency,
      priceRangeMaxAmount: price.amount,
      priceRangeMaxCurrency: price.currency,
      hasInventory: quantity > 0,
      variantCount: 1,
      longitude: placement?.longitude ?? null,
      latitude: placement?.latitude ?? null,
      vendor: null,
      productType: null,
      handle: null,
      seoTitle: null,
      seoDescription: null,
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      // `published_at` is deliberately NOT stated: `insertListing` derives it from
      // the status, which is the one authority for what that column means (#261).
      // A P2P listing is born `active`, so it is stamped here as it always was.
    },
    toListingImages(input.imageFileIds),
    [],
    tx,
  );

  // Inside the SAME transaction as the listing row: the disclosures and the
  // evidence gate are part of what makes the listing publishable, so a listing
  // that commits without them is the failure this ordering removes.
  await writeListingConditionEvidence(tx, {
    listingId: listing.id,
    actor: { kind: 'seller', oxyUserId },
    galleryFileIds: input.imageFileIds,
    resolved: resolvedCondition,
    categoryId,
    categorySlugs,
    now,
  });

  await insertVariants(
    listing.id,
    [
      {
        title: DEFAULT_VARIANT_TITLE,
        priceAmount: price.amount,
        priceCurrency: price.currency,
        inventoryTracked: true,
        inventoryAvailable: quantity,
        position: 0,
        optionValues: [],
      },
    ],
    tx,
  );

  return listing.id;
}

/**
 * Create a P2P (secondhand) listing owned by an individual user. Creates the
 * listing (`ownerType: 'user'`) plus a single Default-Title variant carrying the
 * price and `available = quantity ?? 1`. Lazily ensures the seller's profile
 * exists. Returns the new listing's id.
 */
export async function createP2PListing(
  oxyUserId: string,
  input: CreateP2PListingInput,
): Promise<string> {
  await getOrCreateSellerProfile(oxyUserId);
  const now = new Date();

  const listingId = await getDb().transaction((tx) =>
    insertP2PListingWithin(tx, oxyUserId, input, null, now),
  );

  await syncListingFacets(listingId);
  return listingId;
}

/** Human-readable variant title from its option-value tuple (e.g. `M / Black`). */
function variantTitleFromOptions(optionValues: OptionValueInput[]): string {
  if (optionValues.length === 0) {
    return DEFAULT_VARIANT_TITLE;
  }
  return optionValues.map((o) => o.value).join(' / ');
}

/**
 * Resolve the variants for a store product from the explicit `input.variants`.
 * Each variant carries its own option assignments, price, and inventory; the
 * `CreateStoreProductInput` contract requires at least one. (A future
 * option-only payload would expand `options[].values` into the cartesian product
 * here — that path is not part of the current contract.)
 */
function resolveStoreVariants(
  input: CreateStoreProductInput,
  variantSources: readonly VariantSourceProvenance[] | undefined,
): NewVariant[] {
  if (input.variants.length === 0) {
    throw validationError('A store product must include at least one variant');
  }

  return input.variants.map((v: CreateStoreProductVariantInput, position) => {
    const variant: NewVariant = {
      title: variantTitleFromOptions(v.optionValues),
      optionValues: v.optionValues.map((o) => ({ name: o.name, value: o.value })),
      priceAmount: v.price.amount,
      priceCurrency: v.price.currency,
      inventoryTracked: v.inventory.tracked ?? true,
      inventoryAvailable: v.inventory.available,
      position,
    };
    if (v.sku) {
      variant.sku = v.sku;
    }
    if (v.barcode) {
      variant.barcode = v.barcode;
    }
    if (v.compareAtPrice) {
      variant.compareAtPriceAmount = v.compareAtPrice.amount;
      variant.compareAtPriceCurrency = v.compareAtPrice.currency;
    }
    // #221: an imported variant's four `source_*` columns ride the SAME insert
    // as the variant, aligned by POSITION with `input.variants` — which is the
    // alignment the create path already guarantees, since this map IS what
    // numbers them. The post-create `stampVariantSources` this replaces read
    // the variants back and matched them by position anyway, so nothing is
    // less certain and one write disappears.
    const source = variantSources?.[position];
    if (source) {
      variant.sourceConnectionId = source.sourceConnectionId;
      variant.sourceProvider = source.sourceProvider;
      variant.sourceExternalVariantId = source.sourceExternalVariantId;
      variant.sourceExternalInventoryItemId = source.sourceExternalInventoryItemId;
    }
    return variant;
  });
}

/** Everything {@link insertStoreProductWithin} needs, resolved by its caller. */
interface StoreProductInsert {
  readonly storeId: string;
  readonly input: CreateStoreProductInput;
  /** Already numbered and already carrying their provenance. */
  readonly variants: readonly NewVariant[];
  readonly source: ListingSourceProvenance;
  readonly status: 'active' | 'draft';
  readonly stockLocationId: string;
  readonly categoryId: string;
  readonly categorySlugs: string[];
  readonly resolvedCondition: ResolvedConditionInput;
  readonly conditionColumns: ReturnType<typeof conditionColumnsFor>;
  readonly conditionActor: ConditionActor;
  readonly now: Date;
}

/**
 * Turn a `listings_store_id_handle_key` violation into a refusal that NAMES the
 * incumbent, or hand the original error back untouched (#292).
 *
 * A handle collision is reachable by three routes nobody had covered, and every
 * one of them surfaced as a bare `23505` — or, through the connector rails, as the
 * drizzle statement dump `lib/errors/merchant-facing.ts` documents:
 *
 *  1. A re-sync or re-push that MOVES a handle onto one another listing of the
 *     same store already holds. One store, one connection, no second rail needed:
 *     both rails' `toUpdatePatch` set `patch.handle`, which reaches
 *     `updateListingColumns` — a plain `UPDATE … RETURNING` with no `onConflict`
 *     and, until now, no `catch` anywhere on that path.
 *  2. A merchant-created product colliding with an incoming slug.
 *     `createStoreProductSchema` accepts `handle` and the create writes all four
 *     `source_*` columns NULL, so there is no provenance row for a later sync to
 *     converge onto and the collision is PERMANENT rather than self-healing.
 *  3. Two connections of DIFFERENT providers on one store.
 *     `connections_store_id_provider_key` bars a second connection of the SAME
 *     provider and nothing else.
 *
 * The refusal is composed here rather than in either rail because
 * {@link createStoreProduct} and {@link updateListing} are the only two writers of
 * `listings.handle` in the repository — the P2P create writes it `null` and no
 * other statement sets the column — so these two cover the merchant path, the pull
 * rail and the push rail from one place.
 *
 * **The isolation posture is unchanged, deliberately.** The push rail refuses to
 * catch this constraint at CREATE so that two genuinely different external
 * products claiming one handle surface as a per-product failure rather than being
 * silently suffixed, and that reasoning stands. What changes is that the
 * per-product failure now says what it found: classify, rethrow, and the existing
 * per-product `catch` isolates it exactly as before.
 *
 * It names the connection WITHOUT calling it "another" one. `updateListing` is not
 * told which connection is syncing, so a message asserting the incumbent belongs
 * to a DIFFERENT channel would be a guess — and on route 1, where the incumbent is
 * a sibling of the same connection, it would be a false one. Naming it is true
 * either way.
 */
async function asNamedHandleCollision(
  err: unknown,
  storeId: string,
  handle: string | null | undefined,
): Promise<unknown> {
  if (handle == null || !isUniqueViolation(err, 'listings_store_id_handle_key')) {
    return err;
  }
  const incumbent = await findListingHandleOwner(storeId, handle);
  if (!incumbent) {
    // The index fired and the holder is not there — it was deleted, or its handle
    // moved, between the refusal and this read. Say only what was observed:
    // inventing an incumbent would be worse than the raw error, because it would
    // send somebody looking for a product that does not exist.
    return conflict(
      `The URL handle “${handle}” is already used by another product in this store. ` +
        'That product could not be read back — it may have just changed. Retrying will ' +
        'say which.',
    );
  }
  const owner = incumbent.sourceConnectionId
    ? `imported as “${incumbent.sourceExternalId}” from the ${incumbent.sourceProvider} ` +
      `channel ${incumbent.sourceShopDomain ?? '(no shop domain recorded)'} ` +
      `(connection ${incumbent.sourceConnectionId})`
    : 'created directly in Mercaria, with no channel provenance — so no sync will ever ' +
      'reconcile the two';
  return conflict(
    `The URL handle “${handle}” is already held by listing ${incumbent.listingId} ` +
      `(${incumbent.status}), ${owner}. Change the handle on one of the two products; ` +
      'Mercaria will not pick between them.',
  );
}

/**
 * Write a store listing, its gallery, its options, its condition evidence, its
 * VARIANTS and their stock — all inside the CALLER's transaction.
 *
 * The store-product mirror of {@link insertP2PListingWithin}, extracted for the
 * same reason and recording the same two rulings.
 *
 * **The variant insert belongs INSIDE.** A listing with no variant is not a
 * sellable state anything should observe, and until #221 it was an everyday
 * outcome rather than a theoretical one: `insertVariants` ran after the
 * transaction committed, so ANY refusal of the variant statement left a listing
 * with nothing to sell. That was invisible while the provenance was also written
 * afterwards, because the leftover row carried no `source_connection_id` and
 * every provenance-scoped read stepped over it. With the provenance now on the
 * insert, the same leftover would be a fully-sourced product with nothing to
 * sell, and `convergeVariants` returns early on a listing with zero variants —
 * so nothing would ever grow one.
 *
 * The refusal that made it an EVERYDAY outcome was
 * `product_variants_sku_key`, a table-wide unique on `sku` — dropped by #296,
 * because a SKU is unique at no grain Mercaria can enforce. What remains is
 * rarer and none of it is theoretical: the currency and paired-money CHECKs, the
 * money ceiling, `product_variants_source_external_variant_key`, and the
 * condition gate `assertConditionAllowed` runs below. Each is a statement that
 * can refuse AFTER the listing row exists, which is the whole property.
 *
 * **`syncListingFacets` deliberately stays OUTSIDE**, because it enqueues outbox
 * work (#57's offer convergence, #58's match) whose whole point is that it
 * survives independently — and `recomputeCollectionMembership` opens its own
 * connection, so calling it inside would have the transaction wait on a writer
 * waiting on it.
 */
async function insertStoreProductWithin(
  tx: Parameters<typeof insertListing>[3],
  spec: StoreProductInsert,
): Promise<ListingRecord> {
  const { input, variants, categoryId, categorySlugs, now } = spec;
  // Multi-currency: variant prices are stored in their NATIVE currency exactly as
  // given (no FAIR conversion) — the price already carries its `.currency`.
  const first = variants[0];

  await assertConditionAllowed(tx, {
    resolved: spec.resolvedCondition,
    categoryId,
    categorySlugs,
  });

  const row = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId: spec.storeId,
      title: input.title,
      description: input.description,
      ...spec.conditionColumns,
      conditionSourceLabel: null,
      status: spec.status,
      categoryId,
      categorySlugs,
      tags: input.tags ?? [],
      priceRangeMinAmount: first.priceAmount,
      priceRangeMinCurrency: first.priceCurrency,
      priceRangeMaxAmount: first.priceAmount,
      priceRangeMaxCurrency: first.priceCurrency,
      hasInventory: false,
      variantCount: variants.length,
      longitude: null,
      latitude: null,
      vendor: input.vendor ?? null,
      productType: input.productType ?? null,
      handle: input.handle ?? null,
      seoTitle: input.seo?.title ?? null,
      seoDescription: input.seo?.description ?? null,
      ...spec.source,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      // NOT stated, for the reason `insertP2PListingWithin` gives — and here it is
      // the whole of #261: `spec.status` is `draft` for a connection that does not
      // auto-publish, and stamping this alongside it made `published_at` mean "when
      // the row was written". The derivation leaves it NULL until the listing is
      // first activated.
    },
    toListingImages(input.imageFileIds),
    input.options.map((o, position) => ({ name: o.name, values: [...o.values], position })),
    tx,
  );

  await writeListingConditionEvidence(tx, {
    listingId: row.id,
    actor: spec.conditionActor,
    galleryFileIds: input.imageFileIds,
    resolved: spec.resolvedCondition,
    categoryId,
    categorySlugs,
    now,
  });

  const inserted = await insertVariants(row.id, variants, tx);

  // Stock each store variant at the target location (connector import) or the
  // store's default. The variant scalar `available` already equals the requested
  // value and the single level row matches it, so the rollup is consistent.
  await insertLevels(
    inserted.map((variantRow, index) => ({
      variantId: variantRow.id,
      listingId: row.id,
      locationId: spec.stockLocationId,
      available: variants[index].inventoryAvailable,
    })),
    tx,
  );

  return row;
}

/**
 * Create a store product: the listing (`ownerType: 'store'`, with the supplied
 * selectable options) plus its variants and their stock, in ONE transaction,
 * then increments the store's `productCount`. Returns the new listing's id.
 *
 * `opts.locationId` routes the initial stock to a specific location (the
 * connector import path passes the connection's resolved `targetLocationId`);
 * when omitted the stock lands at the store's default location, unchanged for
 * the merchant path.
 *
 * `opts.source` and `opts.status` exist so an IMPORTED listing is never
 * observable without its provenance (#221). Both are written by the same
 * `insertListing` call as everything else, inside the same transaction, so a
 * failure produces NO listing rather than one that cannot be matched again: an
 * unstamped listing is invisible to `findListingBySourceExternalId` AND still
 * occupies `listings_store_id_handle_key`, so every later sync of that product
 * fails on the handle unique, permanently. The connector paths used to create
 * the listing and then patch both in a second statement, which is the window.
 */
export async function createStoreProduct(
  storeId: string,
  input: CreateStoreProductInput,
  opts: {
    locationId?: string;
    actorOxyUserId?: string;
    /**
     * The four connector-provenance columns, all four or none — see
     * {@link ListingSourceProvenance} for why a half-set is worse than nothing.
     */
    source?: ListingSourceProvenance;
    /**
     * The status the listing is CREATED with; `active` when unstated, which is
     * every merchant path. A connector connection that does not auto-publish
     * passes `draft` HERE rather than patching it afterwards. The set is the two
     * a create may legitimately produce: `restricted` is a jury's to write and
     * `archived` is a delisting, neither of which a create can mean.
     */
    status?: 'active' | 'draft';
    /**
     * Per-variant provenance, POSITIONALLY aligned with `input.variants`.
     *
     * `NewVariant` already carries the four columns and `insertVariants` already
     * writes them, so this costs no schema change and removes the post-create
     * stamping pass entirely (#221) — an imported variant is never observable
     * unstamped either. A variant the platform gave no ids for is the all-NULL
     * value; a SHORTER array leaves the remaining variants unstamped, which is
     * what a caller supplying nothing already means.
     */
    variantSources?: readonly VariantSourceProvenance[];
  } = {},
): Promise<string> {
  const { categoryId, categorySlugs } = await resolveCategory(input.category);
  const variants = resolveStoreVariants(input, opts.variantSources);

  if (variants.length > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  // #90: a store product defaults to `new` — which is what every store product
  // was before the taxonomy existed — and may state anything else explicitly.
  // The default is a real declaration by the merchant creating it, not an
  // unrefined migration guess, so it records `seller_declared`.
  const resolvedCondition = resolveConditionInput(input) ?? {
    key: 'new' as const,
    assertion: 'seller_declared' as const,
    details: [],
    photoAnnotations: [],
    defectsAcknowledged: false,
  };
  const now = new Date();
  const conditionColumns = conditionColumnsFor(resolvedCondition, now);

  // The connector import path supplies no acting account. It never states a
  // non-`new` condition, and `writeListingConditionEvidence` refuses one that
  // needs photographs without an owner rather than attributing them to a store
  // id — so this is a `source` assertion, honestly labelled.
  const conditionActor: ConditionActor = opts.actorOxyUserId
    ? { kind: 'seller', oxyUserId: opts.actorOxyUserId }
    : { kind: 'source' };

  // A merchant-created product has no source, and the four columns are written
  // explicitly NULL rather than left out: `insertListing` takes the whole column
  // set, and stating the absence keeps this the one place the default lives.
  const source: ListingSourceProvenance = opts.source ?? {
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
  };
  // Resolved BEFORE the transaction, deliberately: it is a READ, and a store with
  // no location now fails before anything is written rather than after the
  // listing and its variants have been committed without stock.
  const stockLocationId = opts.locationId ?? (await resolveDefaultLocationId(storeId));

  let listing: ListingRecord;
  try {
    listing = await getDb().transaction((tx) =>
      insertStoreProductWithin(tx, {
        storeId,
        input,
        variants,
        source,
        status: opts.status ?? 'active',
        stockLocationId,
        categoryId,
        categorySlugs,
        resolvedCondition,
        conditionColumns,
        conditionActor,
        now,
      }),
    );
  } catch (err) {
    // The incumbent is read AFTER the transaction has rolled back, on a fresh
    // connection: one failed statement aborts the whole transaction (`25P02`), so
    // a lookup issued from inside the callback would fail with THAT instead of
    // reporting the real cause. Everything else is rethrown untouched (#292).
    throw await asNamedHandleCollision(err, storeId, input.handle);
  }

  // Everything below is a RECOMPUTE over what the transaction committed, and each
  // is idempotent, so none of it belongs inside: `syncListingFacets` requests the
  // #57 offer convergence and #58's match, and `recomputeCollectionMembership`
  // opens its own connection — calling either inside would have the transaction
  // wait on a writer that is waiting on it.
  await syncListingFacets(listing.id);
  await adjustStoreProductCount(storeId, 1);
  await recomputeCollectionMembership(listing.id);

  return listing.id;
}

/**
 * Update a listing's mutable fields (title, description, tags, status, images,
 * category). Price/quantity for P2P listings flow through the listing's single
 * variant. Recomputes facets afterwards. Returns nothing; callers re-hydrate the
 * listing for the response.
 */
export async function updateListing(
  listingId: string,
  patch: UpdateListingInput,
  actor: ConditionActor,
): Promise<void> {
  const listing = await findListingById(listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }

  const columns: Partial<ListingRecord> = {};

  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.tags !== undefined) columns.tags = [...patch.tags];
  /**
   * A moderation restriction is not the seller's to lift.
   *
   * Without this guard the assignment below is an enforcement ESCAPE, and a quiet
   * one: `restricted` is just another `ListingStatus` to this code, so a seller
   * whose counterfeit listing was delisted by a jury could PATCH
   * `{status: 'active'}` and put it straight back on sale. Nothing would error and
   * nothing would log — the audit trail would still show the restriction being
   * applied, because it was.
   *
   * The narrowed `UpdateListingInput['status']` type keeps `restricted` out of the
   * payload, but a type is erased at runtime and this service is exported to
   * callers that never saw the route's validation, so the runtime check is what
   * actually holds. Both directions are refused: a client can neither impose a
   * restriction nor escape one.
   */
  if (patch.status !== undefined) {
    if (listing.status === 'restricted') {
      throw conflict(
        'This listing is restricted pending a moderation decision and cannot be ' +
          'republished. Its status will change if the decision is overturned.',
      );
    }
    if (!SELLER_SETTABLE_LISTING_STATUSES.includes(patch.status)) {
      throw validationError(`Listing status '${patch.status}' cannot be set directly.`);
    }
    columns.status = patch.status;
    // `published_at` is NOT set here. `updateListingColumns` derives it from the
    // status in SQL, which is both the one authority for the column (#261) and
    // race-free: the read-then-write this replaced let two concurrent activations
    // each see an empty column and the later one win.
  }
  if (patch.category !== undefined) {
    const { categoryId, categorySlugs } = await resolveCategory(patch.category);
    columns.categoryId = categoryId;
    columns.categorySlugs = categorySlugs;
  }

  // Store-product merchandising fields (no-op for P2P listings, which never set them).
  if (patch.vendor !== undefined) columns.vendor = patch.vendor;
  if (patch.productType !== undefined) columns.productType = patch.productType;
  if (patch.handle !== undefined) columns.handle = patch.handle;
  if (patch.seo !== undefined) {
    columns.seoTitle = patch.seo.title ?? null;
    columns.seoDescription = patch.seo.description ?? null;
  }

  /**
   * #90: a condition change is a correction with an audit row, and it is
   * refused once the item has sold.
   *
   * "Before sale" (#90 evidence rule 8) is about the LISTING, not about the
   * orders: an order line already snapshotted what the buyer was shown and
   * refuses UPDATE outright, so a later correction cannot reach it. What this
   * guard stops is a seller quietly upgrading a sold item's page so that the
   * listing a dispute is read against no longer says what was bought from it.
   */
  const resolvedCondition = resolveConditionInput(patch);
  if (resolvedCondition && listing.status === 'sold') {
    throw conflict('A sold listing’s condition can no longer be corrected');
  }

  const now = new Date();
  const conditionColumns = resolvedCondition
    ? conditionColumnsFor(resolvedCondition, now)
    : undefined;

  // The gallery the evidence is drawn from: whatever this request supplies, or
  // whatever the listing already has. A condition change that did not resend the
  // images must still be gated against the images that are actually there —
  // reading only the patch would let a seller move to `used_poor` with no
  // photographs by simply omitting them.
  const galleryFileIds =
    patch.imageFileIds ??
    ((await findListingChildren([listingId])).images.get(listingId) ?? []).map(
      (image) => image.fileId,
    );

  try {
    await getDb().transaction(async (tx) => {
      if (resolvedCondition && conditionColumns) {
        await assertConditionAllowed(tx, {
          resolved: resolvedCondition,
          categoryId: columns.categoryId ?? listing.categoryId,
          categorySlugs: columns.categorySlugs ?? listing.categorySlugs,
        });
        Object.assign(columns, conditionColumns);
        // A seller-declared correction clears any source wording: the label
        // belonged to a claim the source made, and the CHECK forbids one beside a
        // `seller_declared` row.
        if (resolvedCondition.assertion !== 'source_declared') {
          columns.conditionSourceLabel = null;
        }
      }

      if (Object.keys(columns).length > 0) {
        await updateListingColumns(listingId, columns, tx);
      }
      if (patch.imageFileIds !== undefined) {
        await replaceListingImages(listingId, toListingImages(patch.imageFileIds), tx);
      }

      if (resolvedCondition) {
        await writeListingConditionEvidence(tx, {
          listingId,
          actor,
          galleryFileIds,
          resolved: resolvedCondition,
          categoryId: columns.categoryId ?? listing.categoryId,
          categorySlugs: columns.categorySlugs ?? listing.categorySlugs,
          previous: {
            key: narrowStoredCondition(listing.condition),
            assertion: listing.conditionAssertion,
          },
          now,
        });
      }
    });
  } catch (err) {
    // Route 1 of the three `asNamedHandleCollision` enumerates, and the one that
    // had no `catch` on it at all: `columns.handle` reaches `updateListingColumns`
    // as a plain `UPDATE … RETURNING`. The incumbent lookup runs outside the
    // rolled-back transaction, for the reason `createStoreProduct` states (#292).
    throw await asNamedHandleCollision(err, listing.storeId, columns.handle);
  }

  // P2P price/quantity updates flow through the single variant, stored in its
  // NATIVE currency. Both target the FIRST variant by position, which is the one
  // `createP2PListing` made.
  if (
    listing.ownerType === 'user' &&
    (patch.price !== undefined || patch.quantity !== undefined)
  ) {
    const [variant] = await findVariantsByListing(listingId);
    if (variant) {
      await updateVariantColumns(
        listingId,
        variant.id,
        {
          ...(patch.price !== undefined
            ? { priceAmount: patch.price.amount, priceCurrency: patch.price.currency }
            : {}),
          ...(patch.quantity !== undefined ? { inventoryAvailable: patch.quantity } : {}),
        },
        undefined,
      );
    }
  }

  await syncListingFacets(listingId);
  if (listing.ownerType === 'store') {
    await recomputeCollectionMembership(listingId);
  }
}

/**
 * Archive a listing (soft-delete). Used by P2P DELETE and store DELETE.
 *
 * The offer sync is requested EXPLICITLY here rather than through
 * `syncListingFacets`, because archiving changes no variant and the facets do
 * not move — but the listing has stopped being offerable, and an archived
 * listing that kept a live offer is exactly what issue #57's native rule 5
 * forbids.
 *
 * ## A restricted listing is not archivable here, and this is the THIRD
 * ## moderation escape closed in commerce code (#402)
 *
 * `updateListing` above refuses to move a listing out of `restricted`, and that
 * guard reads the listing's CURRENT status. This function used to write
 * `archived` through `updateListingColumns` — an unconditional `UPDATE … WHERE
 * id = ?` with no status predicate at all — so `DELETE /seller/listings/:id`
 * walked straight around it. The result was not merely a stronger delisting:
 *
 *  1. `restoreSubject` restores only from `['restricted', 'draft', 'archived']`,
 *     and `archived` is in that set only since #402 — so before it, an accepted
 *     appeal could never relist the listing and reported that it had never been
 *     restricted.
 *  2. Once the status was `archived`, `updateListing`'s guard no longer fired,
 *     because there was no longer a restriction in the column it reads. So the
 *     accused seller could `DELETE` and then `PATCH {status:'active'}` and put a
 *     jury-restricted listing back on sale in two ordinary calls.
 *
 * The CAS is the authority and the read below only CLASSIFIES its refusal: a
 * read-then-write would leave the window in which a jury restricts between the
 * two, which is exactly the delivery this has to survive.
 *
 * A repeat DELETE still converges rather than failing — `setListingStatusIfIn`'s
 * `status <> next` clause refuses an already-archived listing, and that is a
 * success here, not a 404.
 */
export async function archiveListing(listingId: string): Promise<void> {
  const archived = await setListingStatusIfIn(
    listingId,
    'archived',
    MERCHANT_ARCHIVABLE_LISTING_STATUSES,
  );

  if (!archived) {
    const listing = await findListingById(listingId);
    if (!listing) {
      throw notFound('Listing not found');
    }
    if (listing.status === 'restricted') {
      throw conflict(
        'This listing is restricted pending a moderation decision and cannot be ' +
          'deleted. Its status will change if the decision is overturned.',
      );
    }
    // Already `archived`: the CAS refused a write that would have changed
    // nothing. A second DELETE of the same listing is not an error.
  }

  await requestNativeOfferSync(listingId);
}

/**
 * Add a variant to a store product. Recomputes facets. Returns the variant id.
 *
 * `opts.locationId` is where the new variant's stock is placed, and it exists for
 * the same reason `createStoreProduct` takes one: a connector stocks at the
 * connection's TARGET location, and putting one variant of a listing at the store
 * DEFAULT instead does not merely misfile it — `recomputeVariantScalarFromLevels`
 * SUMS the levels, so the next inventory sync writing the target's level leaves
 * the variant carrying both numbers at once. Absent → the store default, which is
 * the merchant surface's behaviour and was the only behaviour before.
 */
export async function addVariant(
  listingId: string,
  input: CreateStoreProductVariantInput,
  opts: { locationId?: string } = {},
): Promise<string> {
  const listing = await findListingById(listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }

  const existingCount = await countVariants(listingId);
  if (existingCount + 1 > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  // Multi-currency: the submitted price/compareAtPrice are stored NATIVE as given.
  const variant: NewVariant = {
    title: variantTitleFromOptions(input.optionValues),
    optionValues: input.optionValues.map((o) => ({ name: o.name, value: o.value })),
    priceAmount: input.price.amount,
    priceCurrency: input.price.currency,
    inventoryTracked: input.inventory.tracked ?? true,
    inventoryAvailable: input.inventory.available,
    // `max(position) + 1`, not the variant COUNT: after any deletion the count
    // collides with a position a surviving variant already holds, and two
    // variants sharing one position make the listing's order non-deterministic.
    position: await nextVariantPosition(listingId),
  };
  if (input.sku) {
    variant.sku = input.sku;
  }
  if (input.barcode) {
    variant.barcode = input.barcode;
  }
  if (input.compareAtPrice) {
    variant.compareAtPriceAmount = input.compareAtPrice.amount;
    variant.compareAtPriceCurrency = input.compareAtPrice.currency;
  }

  const [created] = await insertVariants(listingId, [variant]);

  // Store variants are added only through this path (the listing is
  // `ownerType: 'store'`). Stock the new variant at the caller's location, else
  // the store's default, so the level sum matches the scalar `available` just
  // written.
  const stockLocationId = opts.locationId ?? (await resolveDefaultLocationId(String(listing.storeId)));
  await insertLevels([
    {
      variantId: created.id,
      listingId,
      locationId: stockLocationId,
      available: input.inventory.available,
    },
  ]);

  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
  return created.id;
}

/** Fields accepted when updating a variant. */
export interface UpdateVariantInput {
  title?: string;
  sku?: string;
  barcode?: string;
  price?: Money;
  compareAtPrice?: Money | null;
  optionValues?: { name: string; value: string }[];
  inventory?: { tracked?: boolean; available?: number };
}

/**
 * Update a variant in place. Recomputes facets afterwards.
 *
 * `opts.locationId` is where an absolute `inventory.available` is written. It is
 * the fix for a silent no-op rather than a convenience: a connector's stock lives
 * at the connection's TARGET location, and this used to route every set to the
 * store DEFAULT, so a connector zeroing a removed variant inserted a 0 beside the
 * target's surviving stock — `recomputeVariantScalarFromLevels` summed them and
 * the variant stayed on sale. Absent → the store default, which is the merchant
 * surface's behaviour and was the only behaviour before.
 */
export async function updateVariant(
  listingId: string,
  variantId: string,
  patch: UpdateVariantInput,
  opts: { locationId?: string } = {},
): Promise<void> {
  const columns: Parameters<typeof updateVariantColumns>[2] = {};

  if (patch.title !== undefined) {
    columns.title = patch.title;
  } else if (patch.optionValues !== undefined) {
    // A variant's title is a RENDERING of its option assignments — that is how
    // both create paths build it — so moving the assignments and leaving the
    // title behind labels a variant `S` while it sits on `Small`. A caller that
    // states a title of its own keeps it.
    columns.title = variantTitleFromOptions(patch.optionValues);
  }
  if (patch.sku !== undefined) columns.sku = patch.sku;
  if (patch.barcode !== undefined) columns.barcode = patch.barcode;
  // Multi-currency: any submitted price/compareAtPrice is stored NATIVE as given.
  if (patch.price !== undefined) {
    columns.priceAmount = patch.price.amount;
    columns.priceCurrency = patch.price.currency;
  }
  if (patch.compareAtPrice !== undefined) {
    // Both halves of a `Money` move together — the
    // `product_variants_compare_at_price_paired_check` constraint refuses an
    // amount with no currency, which is what clearing only one would produce.
    columns.compareAtPriceAmount = patch.compareAtPrice?.amount ?? null;
    columns.compareAtPriceCurrency = patch.compareAtPrice?.currency ?? null;
  }
  if (patch.inventory?.tracked !== undefined) {
    columns.inventoryTracked = patch.inventory.tracked;
  }

  // `inventory.available` routing differs by ownership: a STORE variant's stock
  // lives in `inventory_levels` (the scalar is a rollup), so the absolute set goes
  // to the store's default location's level and the scalar is recomputed. A P2P
  // variant keeps the scalar as the single source of truth.
  const listing = await findListingById(listingId);
  const routeToLevel =
    patch.inventory?.available !== undefined &&
    listing?.ownerType === 'store' &&
    listing.storeId !== null;

  if (patch.inventory?.available !== undefined && !routeToLevel) {
    columns.inventoryAvailable = patch.inventory.available;
  }

  const updated = await updateVariantColumns(
    listingId,
    variantId,
    columns,
    patch.optionValues?.map((o) => ({ name: o.name, value: o.value })),
  );
  if (!updated) {
    throw notFound('Variant not found');
  }

  if (routeToLevel && patch.inventory?.available !== undefined && listing?.storeId) {
    const locationId = opts.locationId ?? (await resolveDefaultLocationId(listing.storeId));
    await setLevelAvailable({
      variantId,
      listingId,
      locationId,
      available: patch.inventory.available,
    });
    // The scalar written above (if any) would be stale; the levels are
    // authoritative for a store variant, so recompute from them.
    await recomputeVariantScalarFromLevels(variantId);
  }

  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
}

/**
 * Remove a variant from a store product. A listing must always keep ≥1 variant,
 * so removing the last variant is rejected. Recomputes facets afterwards.
 *
 * The variant's `inventory_levels` rows go with it — `ON DELETE CASCADE`, which
 * closes a leak Mongo had no way to express: the level rows survived the variant
 * and kept counting stock for something that no longer existed.
 */
export async function removeVariant(listingId: string, variantId: string): Promise<void> {
  const count = await countVariants(listingId);
  if (count <= 1) {
    throw conflict('A listing must keep at least one variant');
  }
  const deleted = await deleteVariant(listingId, variantId);
  if (!deleted) {
    throw notFound('Variant not found');
  }
  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
}
