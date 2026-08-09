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
 *  - **A listing and its images and options are created in ONE transaction.**
 *    Mongo wrote the document once, so the question did not arise; four tables
 *    make a half-created product possible, and it renders as a product page with
 *    no gallery and no size picker.
 *  - **An absent SKU or barcode is written NULL, never `''`.** Both carry a
 *    PARTIAL unique index, and an empty string is a VALUE — the second variant
 *    saved without a SKU would collide with the first for real.
 */

import type {
  CreateP2PListingInput,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  Money,
  UpdateListingInput,
} from '@mercaria/shared-types';
import { SELLER_SETTABLE_LISTING_STATUSES } from '@mercaria/shared-types';
import {
  findListingById,
  insertListing,
  recomputeListingFacets,
  replaceListingImages,
  updateListingColumns,
  type ListingImageInput,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
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
 * Two paths deliberately do NOT reach here and call `requestNativeOfferSync`
 * themselves: {@link archiveListing}, which changes a status without touching a
 * variant, and moderation enforcement, which lives in another service entirely.
 * Both are listed here rather than left to be discovered, because a fourth
 * status-only write path that forgot would leave a listing's offers claiming it
 * is on sale.
 */
export async function syncListingFacets(listingId: string): Promise<void> {
  await recomputeListingFacets(listingId);
  await requestNativeOfferSync(listingId);
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
  const { categoryId, categorySlugs } = await resolveCategory(input.category);
  await getOrCreateSellerProfile(oxyUserId);

  const quantity = input.quantity ?? 1;

  // Multi-currency: the price is stored in its NATIVE currency exactly as given
  // (no FAIR conversion). Settlement to FAIR happens later, at the paid boundary.
  const price = input.price;

  const listing = await insertListing(
    {
      ownerType: 'user',
      oxyUserId,
      storeId: null,
      title: input.title,
      description: input.description,
      condition: input.condition,
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
      longitude: null,
      latitude: null,
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
      publishedAt: new Date(),
    },
    toListingImages(input.imageFileIds),
    [],
  );

  await insertVariants(listing.id, [
    {
      title: DEFAULT_VARIANT_TITLE,
      priceAmount: price.amount,
      priceCurrency: price.currency,
      inventoryTracked: true,
      inventoryAvailable: quantity,
      position: 0,
      optionValues: [],
    },
  ]);

  await syncListingFacets(listing.id);
  return listing.id;
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
function resolveStoreVariants(input: CreateStoreProductInput): NewVariant[] {
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
    return variant;
  });
}

/**
 * Create a store product: the listing (`ownerType: 'store'`, with the supplied
 * selectable options) plus its variants, then increments the store's
 * `productCount`. Returns the new listing's id.
 *
 * `opts.locationId` routes the initial stock to a specific location (the
 * connector import path passes the connection's resolved `targetLocationId`);
 * when omitted the stock lands at the store's default location, unchanged for
 * the merchant path.
 */
export async function createStoreProduct(
  storeId: string,
  input: CreateStoreProductInput,
  opts: { locationId?: string } = {},
): Promise<string> {
  const { categoryId, categorySlugs } = await resolveCategory(input.category);
  const variants = resolveStoreVariants(input);

  if (variants.length > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  // Multi-currency: variant prices are stored in their NATIVE currency exactly as
  // given (no FAIR conversion) — the price already carries its `.currency`.
  const first = variants[0];
  const listing = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      title: input.title,
      description: input.description,
      condition: 'new',
      status: 'active',
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
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      publishedAt: new Date(),
    },
    toListingImages(input.imageFileIds),
    input.options.map((o, position) => ({ name: o.name, values: [...o.values], position })),
  );

  const inserted = await insertVariants(listing.id, variants);

  // Stock each store variant at the target location (connector import) or the
  // store's default. The variant scalar `available` already equals the requested
  // value and the single level row matches it, so the rollup is consistent.
  const stockLocationId = opts.locationId ?? (await resolveDefaultLocationId(storeId));
  await insertLevels(
    inserted.map((row, index) => ({
      variantId: row.id,
      listingId: listing.id,
      locationId: stockLocationId,
      available: variants[index].inventoryAvailable,
    })),
  );

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
): Promise<void> {
  const listing = await findListingById(listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }

  const columns: Partial<ListingRecord> = {};

  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.tags !== undefined) columns.tags = [...patch.tags];
  if (patch.condition !== undefined) columns.condition = patch.condition;
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
    if (patch.status === 'active' && !listing.publishedAt) {
      columns.publishedAt = new Date();
    }
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

  if (Object.keys(columns).length > 0) {
    await updateListingColumns(listingId, columns);
  }
  if (patch.imageFileIds !== undefined) {
    await replaceListingImages(listingId, toListingImages(patch.imageFileIds));
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
 */
export async function archiveListing(listingId: string): Promise<void> {
  const updated = await updateListingColumns(listingId, { status: 'archived' });
  if (!updated) {
    throw notFound('Listing not found');
  }
  await requestNativeOfferSync(listingId);
}

/** Add a variant to a store product. Recomputes facets. Returns the variant id. */
export async function addVariant(
  listingId: string,
  input: CreateStoreProductVariantInput,
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
  // `ownerType: 'store'`). Stock the new variant at the store's default location
  // so the level sum matches the scalar `available` just written.
  const defaultLocationId = await resolveDefaultLocationId(String(listing.storeId));
  await insertLevels([
    {
      variantId: created.id,
      listingId,
      locationId: defaultLocationId,
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

/** Update a variant in place. Recomputes facets afterwards. */
export async function updateVariant(
  listingId: string,
  variantId: string,
  patch: UpdateVariantInput,
): Promise<void> {
  const columns: Parameters<typeof updateVariantColumns>[2] = {};

  if (patch.title !== undefined) columns.title = patch.title;
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
    const locationId = await resolveDefaultLocationId(listing.storeId);
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
