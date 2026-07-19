/**
 * Catalog write service — the SINGLE funnel for catalog mutations.
 *
 * Both the P2P seller path and the store-product path create/update `Listing`s
 * and their `ProductVariant`s through here, so the denormalized `Listing` facets
 * (`priceRange`, `hasInventory`, `variantCount`) ALWAYS stay in sync with the
 * variant collection. `syncListingFacets` is the one place those facets are
 * recomputed and persisted; `inventory.service` re-uses it after stock changes
 * (no duplicate facet logic anywhere).
 *
 * P2P listings hide the variant model behind a flat `price`/`quantity` API: a
 * single Shopify-style "Default Title" variant is created. Store products expand
 * `options[].values` into the cartesian product of variants (or take an explicit
 * `variants[]`).
 */

import mongoose from 'mongoose';
import type {
  CreateP2PListingInput,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  Money,
  UpdateListingInput,
} from '@mercaria/shared-types';
import { Listing, type IListing, type IListingImage } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { Store } from '../models/store.js';
import { Location, type ILocation } from '../models/location.js';
import { InventoryLevel } from '../models/inventory-level.js';
import { Category, type ICategory } from '../models/category.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import { getOrCreate as getOrCreateSellerProfile } from './seller-profile.service.js';

/** The default variant title for single-variant (P2P) listings. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * After a STORE product/variant mutation, recompute which AUTOMATED collections of
 * the store the listing belongs to. Best-effort: a membership recompute failure must
 * not fail the write. Uses a DYNAMIC import of `collection.service` to break the
 * import cycle (`collection.service` imports `syncListingFacets`/types from here),
 * mirroring `inventory.service`'s dynamic import of the queue producers.
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
 * Resolve a store's default `Location` id — the `isDefault` location, falling
 * back to ANY active location. Throws NOT_FOUND if the store has no location
 * (every store gets one at creation + via the migration backfill). Owned HERE
 * (not in `inventory.service`) so both the catalog write path and inventory
 * routing share one implementation WITHOUT an import cycle (`inventory.service`
 * already imports this module for `syncListingFacets`).
 */
export async function resolveDefaultLocationId(storeId: string): Promise<string> {
  const def = await Location.findOne({ storeId, isDefault: true })
    .select('_id')
    .lean<Pick<ILocation, '_id'> | null>();
  if (def) {
    return String(def._id);
  }
  const anyActive = await Location.findOne({ storeId, isActive: true })
    .select('_id')
    .lean<Pick<ILocation, '_id'> | null>();
  if (!anyActive) {
    throw notFound('No location for store');
  }
  return String(anyActive._id);
}

/**
 * Recompute and persist a store variant's scalar `inventory.{available,committed}`
 * as the SUM over its `InventoryLevel` rows. This is the ONE place the rollup is
 * computed; `inventory.service.rollupVariant` delegates here (the dependency only
 * flows inventory → catalog-write, never back, so no cycle). When a variant has
 * no level rows (e.g. an untracked or P2P variant), the sums are 0.
 */
export async function recomputeVariantScalarFromLevels(variantId: string): Promise<void> {
  const [agg] = await InventoryLevel.aggregate<{ available: number; committed: number }>([
    { $match: { variantId } },
    { $group: { _id: null, available: { $sum: '$available' }, committed: { $sum: '$committed' } } },
  ]);
  const available = agg?.available ?? 0;
  const committed = agg?.committed ?? 0;
  await ProductVariant.updateOne(
    { _id: variantId },
    { $set: { 'inventory.available': available, 'inventory.committed': committed } },
  );
}

/** Resolve a category slug to its id + denormalized `[ancestor..., slug]` path. */
async function resolveCategory(
  slug: string,
): Promise<{ categoryId: string; categorySlugs: string[] }> {
  const category = await Category.findOne({ slug }).lean<ICategory | null>();
  if (!category) {
    throw notFound(`Category not found: ${slug}`);
  }
  return {
    categoryId: String((category as { _id: mongoose.Types.ObjectId })._id),
    categorySlugs: [...category.ancestorSlugs, category.slug],
  };
}

/** Map input image file ids to the persisted `IListingImage[]` shape. */
function toListingImages(imageFileIds: string[]): IListingImage[] {
  if (imageFileIds.length > config.catalog.maxImagesPerListing) {
    throw validationError(
      `A listing may have at most ${config.catalog.maxImagesPerListing} images`,
    );
  }
  return imageFileIds.map((fileId, position) => ({ fileId, position }));
}

/**
 * Recompute and persist a listing's denormalized facets from its variants:
 *  - `priceRange.min/max` from variant prices (single currency assumed),
 *  - `hasInventory` = any untracked variant OR any tracked variant with available>0,
 *  - `variantCount` = number of variants.
 *
 * Returns the up-to-date variant docs so callers avoid a re-query. Shared by the
 * write service and `inventory.service`.
 */
export async function syncListingFacets(listingId: string): Promise<IProductVariant[]> {
  const variants = await ProductVariant.find({ listingId })
    .sort({ position: 1 })
    .lean<IProductVariant[]>();

  if (variants.length === 0) {
    await Listing.updateOne(
      { _id: listingId },
      { $set: { hasInventory: false, variantCount: 0 } },
    );
    return variants;
  }

  const amounts = variants.map((v) => v.price.amount);
  const currency = variants[0].price.currency;
  const hasInventory = variants.some(
    (v) => !v.inventory.tracked || v.inventory.available > 0,
  );

  await Listing.updateOne(
    { _id: listingId },
    {
      $set: {
        priceRange: {
          min: { amount: Math.min(...amounts), currency },
          max: { amount: Math.max(...amounts), currency },
        },
        hasInventory,
        variantCount: variants.length,
      },
    },
  );

  return variants;
}

/**
 * Create a P2P (secondhand) listing owned by an individual user. Creates the
 * `Listing` (`ownerType: 'user'`) plus a single Default-Title variant carrying
 * the price and `inventory.available = quantity ?? 1`. Lazily ensures the
 * seller's profile exists. Returns the new listing's id.
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

  const listing = await Listing.create({
    ownerType: 'user',
    oxyUserId,
    title: input.title,
    description: input.description,
    condition: input.condition,
    status: 'active',
    categoryId,
    categorySlugs,
    images: toListingImages(input.imageFileIds),
    tags: input.tags ?? [],
    options: [],
    priceRange: {
      min: { amount: price.amount, currency: price.currency },
      max: { amount: price.amount, currency: price.currency },
    },
    hasInventory: quantity > 0,
    variantCount: 1,
    publishedAt: new Date(),
  });

  const listingId = String(listing._id);

  await ProductVariant.create({
    listingId,
    title: DEFAULT_VARIANT_TITLE,
    optionValues: [],
    price: { amount: price.amount, currency: price.currency },
    inventory: { tracked: true, available: quantity, committed: 0, levels: [] },
    position: 0,
  });

  await syncListingFacets(listingId);
  return listingId;
}

/** Human-readable variant title from its option-value tuple (e.g. `M / Black`). */
function variantTitleFromOptions(optionValues: { name: string; value: string }[]): string {
  if (optionValues.length === 0) {
    return DEFAULT_VARIANT_TITLE;
  }
  return optionValues.map((o) => o.value).join(' / ');
}

/** A normalized variant ready to persist. */
interface NormalizedVariant {
  title: string;
  optionValues: { name: string; value: string }[];
  sku?: string;
  barcode?: string;
  price: Money;
  compareAtPrice?: Money;
  inventory: { tracked: boolean; available: number; committed: number; levels: [] };
  position: number;
}

/**
 * Resolve the variants for a store product from the explicit `input.variants`.
 * Each variant carries its own option assignments, price, and inventory; the
 * `CreateStoreProductInput` contract requires at least one. (A future
 * option-only payload would expand `options[].values` into the cartesian product
 * here — that path is not part of the current contract.)
 */
function resolveStoreVariants(input: CreateStoreProductInput): NormalizedVariant[] {
  if (input.variants.length > 0) {
    return input.variants.map((v: CreateStoreProductVariantInput, position) => {
      const variant: NormalizedVariant = {
        title: variantTitleFromOptions(v.optionValues),
        optionValues: v.optionValues.map((o) => ({ name: o.name, value: o.value })),
        price: { amount: v.price.amount, currency: v.price.currency },
        inventory: {
          tracked: v.inventory.tracked ?? true,
          available: v.inventory.available,
          committed: 0,
          levels: [],
        },
        position,
      };
      if (v.sku) {
        variant.sku = v.sku;
      }
      if (v.barcode) {
        variant.barcode = v.barcode;
      }
      if (v.compareAtPrice) {
        variant.compareAtPrice = { amount: v.compareAtPrice.amount, currency: v.compareAtPrice.currency };
      }
      return variant;
    });
  }

  // No explicit variants: a store product MUST still produce at least one variant.
  throw validationError('A store product must include at least one variant');
}

/**
 * Create a store product. Creates the `Listing` (`ownerType: 'store'`, with the
 * supplied selectable `options[]`) plus its variants, then increments the store's
 * `productCount`. Returns the new listing's id.
 */
export async function createStoreProduct(
  storeId: string,
  input: CreateStoreProductInput,
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
  const listing = await Listing.create({
    ownerType: 'store',
    storeId,
    title: input.title,
    description: input.description,
    condition: 'new',
    status: 'active',
    categoryId,
    categorySlugs,
    images: toListingImages(input.imageFileIds),
    tags: input.tags ?? [],
    options: input.options.map((o) => ({ name: o.name, values: [...o.values] })),
    priceRange: { min: first.price, max: first.price },
    hasInventory: false,
    variantCount: variants.length,
    ...(input.vendor ? { vendor: input.vendor } : {}),
    ...(input.productType ? { productType: input.productType } : {}),
    ...(input.handle ? { handle: input.handle } : {}),
    ...(input.seo ? { seo: input.seo } : {}),
    publishedAt: new Date(),
  });

  const listingId = String(listing._id);

  const inserted = await ProductVariant.insertMany(
    variants.map((v) => ({ ...v, listingId })),
  );

  // Stock each store variant at the store's default location. The variant scalar
  // `available` (set from `insertMany`) already equals the requested value, and
  // the single level row's `available` matches it, so the rollup is consistent.
  const defaultLocationId = await resolveDefaultLocationId(storeId);
  await InventoryLevel.insertMany(
    inserted.map((doc, index) => ({
      variantId: String(doc._id),
      listingId,
      locationId: defaultLocationId,
      available: variants[index].inventory.available,
      committed: 0,
    })),
  );

  await syncListingFacets(listingId);
  await Store.updateOne({ _id: storeId }, { $inc: { productCount: 1 } });
  await recomputeCollectionMembership(listingId);

  return listingId;
}

/**
 * Update a listing's mutable fields (title, description, tags, status, images,
 * category). Price/quantity for P2P listings flow through the listing's single
 * variant via `updateVariant`. Recomputes facets afterwards. Returns nothing;
 * callers re-hydrate the listing for the response.
 */
export async function updateListing(
  listingId: string,
  patch: UpdateListingInput,
): Promise<void> {
  const listing = await Listing.findById(listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }

  if (patch.title !== undefined) listing.title = patch.title;
  if (patch.description !== undefined) listing.description = patch.description;
  if (patch.tags !== undefined) listing.tags = [...patch.tags];
  if (patch.condition !== undefined) listing.condition = patch.condition;
  if (patch.status !== undefined) {
    listing.status = patch.status;
    if (patch.status === 'active' && !listing.publishedAt) {
      listing.publishedAt = new Date();
    }
  }
  if (patch.category !== undefined) {
    const { categoryId, categorySlugs } = await resolveCategory(patch.category);
    listing.categoryId = categoryId;
    listing.categorySlugs = categorySlugs;
  }
  if (patch.imageFileIds !== undefined) {
    listing.images = toListingImages(patch.imageFileIds);
  }

  // Store-product merchandising fields (no-op for P2P listings, which never set them).
  if (patch.vendor !== undefined) listing.vendor = patch.vendor;
  if (patch.productType !== undefined) listing.productType = patch.productType;
  if (patch.handle !== undefined) listing.handle = patch.handle;
  if (patch.seo !== undefined) listing.seo = patch.seo;

  // P2P price update flows through the single variant, stored in its NATIVE currency.
  if (patch.price !== undefined && listing.ownerType === 'user') {
    const variant = await ProductVariant.findOne({ listingId }).sort({ position: 1 });
    if (variant) {
      variant.price = { amount: patch.price.amount, currency: patch.price.currency };
      await variant.save();
    }
  }
  // P2P quantity update flows through the single variant's available stock.
  if (patch.quantity !== undefined && listing.ownerType === 'user') {
    const variant = await ProductVariant.findOne({ listingId }).sort({ position: 1 });
    if (variant) {
      variant.inventory.available = patch.quantity;
      await variant.save();
    }
  }

  await listing.save();
  await syncListingFacets(listingId);
  if (listing.ownerType === 'store') {
    await recomputeCollectionMembership(listingId);
  }
}

/** Archive a listing (soft-delete). Used by P2P DELETE and store DELETE. */
export async function archiveListing(listingId: string): Promise<void> {
  const result = await Listing.updateOne({ _id: listingId }, { $set: { status: 'archived' } });
  if (result.matchedCount === 0) {
    throw notFound('Listing not found');
  }
}

/** Add a variant to a store product. Recomputes facets. Returns the variant id. */
export async function addVariant(
  listingId: string,
  input: CreateStoreProductVariantInput,
): Promise<string> {
  const listing = await Listing.findById(listingId).lean<IListing | null>();
  if (!listing) {
    throw notFound('Listing not found');
  }

  const existingCount = await ProductVariant.countDocuments({ listingId });
  if (existingCount + 1 > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  // Multi-currency: the submitted price/compareAtPrice are stored NATIVE as given.
  const price = input.price;
  const compareAtPrice = input.compareAtPrice;

  const created = await ProductVariant.create({
    listingId,
    title: variantTitleFromOptions(input.optionValues),
    optionValues: input.optionValues.map((o) => ({ name: o.name, value: o.value })),
    ...(input.sku ? { sku: input.sku } : {}),
    ...(input.barcode ? { barcode: input.barcode } : {}),
    price: { amount: price.amount, currency: price.currency },
    ...(compareAtPrice
      ? { compareAtPrice: { amount: compareAtPrice.amount, currency: compareAtPrice.currency } }
      : {}),
    inventory: {
      tracked: input.inventory.tracked ?? true,
      available: input.inventory.available,
      committed: 0,
      levels: [],
    },
    position: existingCount,
  });

  // Store variants are added only through this path (the listing is `ownerType:
  // 'store'`). Stock the new variant at the store's default location so the level
  // sum matches the scalar `available` just written.
  const defaultLocationId = await resolveDefaultLocationId(String(listing.storeId));
  await InventoryLevel.create({
    variantId: String(created._id),
    listingId,
    locationId: defaultLocationId,
    available: input.inventory.available,
    committed: 0,
  });

  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
  return String(created._id);
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
  const variant = await ProductVariant.findOne({ _id: variantId, listingId });
  if (!variant) {
    throw notFound('Variant not found');
  }

  if (patch.title !== undefined) variant.title = patch.title;
  if (patch.sku !== undefined) variant.sku = patch.sku;
  if (patch.barcode !== undefined) variant.barcode = patch.barcode;
  // Multi-currency: any submitted price/compareAtPrice is stored NATIVE as given.
  if (patch.price !== undefined) {
    variant.price = { amount: patch.price.amount, currency: patch.price.currency };
  }
  if (patch.compareAtPrice !== undefined) {
    if (patch.compareAtPrice === null) {
      variant.compareAtPrice = undefined;
    } else {
      variant.compareAtPrice = {
        amount: patch.compareAtPrice.amount,
        currency: patch.compareAtPrice.currency,
      };
    }
  }
  if (patch.optionValues !== undefined) {
    variant.optionValues = patch.optionValues.map((o) => ({ name: o.name, value: o.value }));
  }
  if (patch.inventory?.tracked !== undefined) {
    variant.inventory.tracked = patch.inventory.tracked;
  }

  // `inventory.available` routing differs by ownership: a STORE variant's stock
  // lives in `InventoryLevel` (the scalar is a rollup), so the absolute set goes
  // to the store's default location's level and the scalar is recomputed. A P2P
  // variant keeps the scalar as the single source of truth.
  if (patch.inventory?.available !== undefined) {
    const owner = await Listing.findById(listingId)
      .select('ownerType storeId')
      .lean<Pick<IListing, 'ownerType' | 'storeId'> | null>();
    if (owner?.ownerType === 'store' && owner.storeId) {
      const locationId = await resolveDefaultLocationId(String(owner.storeId));
      await InventoryLevel.updateOne(
        { variantId, locationId },
        {
          $set: { available: patch.inventory.available },
          $setOnInsert: { listingId, committed: 0 },
        },
        { upsert: true },
      );
      // `variant.save()` below would persist a stale in-memory scalar; recompute
      // from the levels AFTER it so the rollup is authoritative.
      await variant.save();
      await recomputeVariantScalarFromLevels(variantId);
      await syncListingFacets(listingId);
      await recomputeCollectionMembership(listingId);
      return;
    }
    variant.inventory.available = patch.inventory.available;
  }

  await variant.save();
  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
}

/**
 * Remove a variant from a store product. A listing must always keep ≥1 variant,
 * so removing the last variant is rejected. Recomputes facets afterwards.
 */
export async function removeVariant(listingId: string, variantId: string): Promise<void> {
  const count = await ProductVariant.countDocuments({ listingId });
  if (count <= 1) {
    throw conflict('A listing must keep at least one variant');
  }
  const result = await ProductVariant.deleteOne({ _id: variantId, listingId });
  if (result.deletedCount === 0) {
    throw notFound('Variant not found');
  }
  await syncListingFacets(listingId);
  await recomputeCollectionMembership(listingId);
}
