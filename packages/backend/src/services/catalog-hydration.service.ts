/**
 * Catalog hydration service.
 *
 * Turns raw `listings` rows into fully-hydrated `Listing` DTOs ready for the
 * client, doing ALL Oxy + database lookups in BATCHES (no N+1):
 *   1. batch-load every listing's variants and their option values,
 *   2. batch-load every listing's images, options and collection memberships,
 *   3. batch-load seller profiles (user listings) and stores (store listings),
 *   4. batch-load every owning user's Oxy profile in one `getProfiles` call,
 *   5. (optional) batch-load the viewer's favorites to set `saved`,
 *   6. assemble each DTO with derived price fields + owner identity + media.
 *
 * Media resolution is funneled through ONE chokepoint (`resolveMedia`): absolute
 * URLs pass through unchanged (e.g. seeded Shopify CDN assets), everything else
 * is treated as an Oxy media file id and resolved via `getFileDownloadUrl` — the
 * only sanctioned media resolver.
 *
 * ## Ported to Postgres
 *
 * The input is a {@link ListingRecord}, not a Mongoose document, and the batch
 * count grew from three queries to five — because one document became four
 * tables. That is the whole change in shape: what was `listing.images` is now a
 * `listing_images` batch, `listing.options` a `listing_options` batch, and
 * `listing.collectionIds` a `listing_collections` batch. All three are loaded
 * ONCE for the page by `findListingChildren`, so the per-listing cost is still
 * zero queries.
 *
 * `SellerProfile` is deliberately still Mongoose: the seller-profile domain has
 * not been ported, and reading it from Mongo here is what lets the catalogue
 * move without dragging every neighbouring domain with it.
 */

import mongoose from 'mongoose';
import type { OxyServices } from '@oxyhq/core';
import type {
  Listing,
  ListingImage,
  ListingOption,
  ListingSource,
  Money,
  ProductSummary,
  ProductThumbnail,
  ProductVariantDTO,
  MerchantSummary,
  Seller,
} from '@mercaria/shared-types';
import { SellerProfile, type ISellerProfile } from '../models/seller-profile.js';
import { findStoresByIds, type StoreRow } from '../db/stores/storeRepository.js';
import {
  findListingChildren,
  type ListingChildren,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantOptionValues,
  findVariantsByListingIds,
  type VariantOptionValueRecord,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { oxyClient } from '../middleware/auth.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { getFavoritedListingIds } from './favorite.service.js';

/** Matches an absolute http(s) URL (seeded CDN assets pass through unchanged). */
const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * THE media chokepoint. Absolute URLs are returned as-is; anything else is
 * treated as an Oxy media file id and resolved through the SDK's
 * `getFileDownloadUrl` — the only sanctioned resolver. Do NOT build another.
 * Exported so other services (e.g. the cart) resolve media through this one
 * chokepoint instead of duplicating the rule.
 */
export function resolveMedia(value: string, variant?: string): string {
  if (ABSOLUTE_URL.test(value)) {
    return value;
  }
  return oxyClient.getFileDownloadUrl(value, variant);
}

/**
 * A variant's price as a `Money`, or `null` when it has none.
 *
 * The two columns are absent TOGETHER — `product_variants_price_paired_check`
 * makes "an amount with no currency" unrepresentable — so one check answers for
 * both, and the DTO's non-optional `price` is what forces the caller to decide
 * what a priceless variant renders as.
 */
function variantPrice(variant: VariantRecord): Money | null {
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    return null;
  }
  return { amount: variant.priceAmount, currency: variant.priceCurrency };
}

/** A variant's compare-at price as a `Money`, or `null`. Same pairing rule. */
function variantCompareAtPrice(variant: VariantRecord): Money | null {
  if (variant.compareAtPriceAmount === null || variant.compareAtPriceCurrency === null) {
    return null;
  }
  return { amount: variant.compareAtPriceAmount, currency: variant.compareAtPriceCurrency };
}

/** The zero price a listing with no priced variant renders as. */
const NO_PRICE: Money = { amount: 0, currency: 'FAIR' };

/** Map a variant row to the wire `ProductVariantDTO` (never exposes `committed`). */
function toVariantDTO(
  variant: VariantRecord,
  optionValues: VariantOptionValueRecord[],
): ProductVariantDTO {
  const available = variant.inventoryAvailable;
  const inStock = !variant.inventoryTracked || available > 0;
  const dto: ProductVariantDTO = {
    id: variant.id,
    title: variant.title,
    optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: variantPrice(variant) ?? NO_PRICE,
    available,
    inStock,
  };
  if (variant.sku) {
    dto.sku = variant.sku;
  }
  if (variant.barcode) {
    dto.barcode = variant.barcode;
  }
  const compareAt = variantCompareAtPrice(variant);
  if (compareAt) {
    dto.compareAtPrice = compareAt;
  }
  return dto;
}

/**
 * Pick the variant with the lowest price (stable on ties by array order).
 *
 * A variant with NO price is skipped rather than treated as free: the column is
 * nullable, and a `null` compared as zero would make an unpriced variant the
 * cheapest one on every listing that has one.
 */
function cheapestVariant(variants: VariantRecord[]): VariantRecord | undefined {
  return variants.reduce<VariantRecord | undefined>((min, v) => {
    if (v.priceAmount === null) {
      return min;
    }
    if (!min || min.priceAmount === null || v.priceAmount < min.priceAmount) {
      return v;
    }
    return min;
  }, undefined);
}

/** Map listing image rows through the media chokepoint into `ListingImage` DTOs. */
function toListingImages(images: ListingImageRecord[]): ListingImage[] {
  return images.map((img) => {
    const dto: ListingImage = { fileId: resolveMedia(img.fileId), position: img.position };
    if (img.alt) {
      dto.alt = img.alt;
    }
    return dto;
  });
}

/**
 * Map a listing's flattened connector provenance to the `ListingSource` DTO, or
 * `undefined` when the listing was authored here.
 *
 * Only emitted on the ADMIN hydration path (see `HydrateOptions.includeSource`):
 * `connectionId`/`externalId` are internal integration plumbing meant for the
 * store owner, not anonymous storefront buyers.
 */
function toListingSource(listing: ListingRecord): ListingSource | undefined {
  if (!listing.sourceConnectionId || !listing.sourceProvider || !listing.sourceExternalId) {
    return undefined;
  }
  const dto: ListingSource = {
    connectionId: listing.sourceConnectionId,
    provider: listing.sourceProvider,
    externalId: listing.sourceExternalId,
  };
  if (listing.sourceExternalUpdatedAt) {
    dto.externalUpdatedAt = listing.sourceExternalUpdatedAt.toISOString();
  }
  return dto;
}

/**
 * Build a `Seller` DTO from the seller profile aggregates + the Oxy identity.
 * If the Oxy profile is missing (failed to load), falls back to a minimal seller
 * (displayName = username = oxyUserId) so the request never breaks.
 */
function toSeller(
  oxyUserId: string,
  profile: ISellerProfile | undefined,
  oxyProfile: OxyProfile | undefined,
): Seller {
  const seller: Seller = {
    id: profile ? String((profile as { _id: mongoose.Types.ObjectId })._id) : oxyUserId,
    oxyUserId,
    displayName: oxyProfile?.displayName ?? oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    avatar: oxyProfile?.avatar ? resolveMedia(oxyProfile.avatar) : oxyProfile?.avatar ?? null,
    isVerified: profile?.isVerified ?? false,
  };
  if (profile && profile.reviewCount > 0) {
    seller.rating = profile.rating;
    seller.reviewCount = profile.reviewCount;
  }
  return seller;
}

/**
 * Build the PUBLIC `MerchantSummary` projection of a store. `products` are a few
 * `ProductThumbnail`s drawn from the store's listings' images. Exported for the
 * feed's "Worth the hype" shelf.
 *
 * `imagesByListing` carries the already-batched gallery for the listings in
 * play; a thumbnail is the FIRST image, and a listing with none renders an empty
 * URL exactly as it did before.
 */
export function toMerchantSummary(
  store: StoreRow,
  featuredListings: ListingRecord[],
  imagesByListing: Map<string, ListingImageRecord[]> = new Map(),
): MerchantSummary {
  const products: ProductThumbnail[] = featuredListings
    .slice(0, config.feed.storeCardThumbnails)
    .map((listing) => {
      const [firstImage] = imagesByListing.get(listing.id) ?? [];
      return {
        id: listing.id,
        title: listing.title,
        imageUrl: firstImage ? resolveMedia(firstImage.fileId, 'thumb') : '',
      };
    });

  const summary: MerchantSummary = {
    id: store.id,
    handle: store.handle,
    name: store.name,
    coverImageUrl: store.coverFileId ? resolveMedia(store.coverFileId) : '',
    brandColor: store.brandColor,
    rating: store.rating,
    reviewCount: store.reviewCount,
    textTone: store.textTone,
    products,
  };
  if (store.logoFileId) {
    summary.logoUrl = resolveMedia(store.logoFileId);
  }
  return summary;
}

/**
 * Build a `ProductSummary` (browse/shelf card) from a listing + its variants.
 * `brand` is supplied by the caller (store name or seller display name).
 */
export function toProductSummary(
  listing: ListingRecord,
  variants: VariantRecord[],
  brand: string,
  images: ListingImageRecord[] = [],
): ProductSummary {
  const cheapest = cheapestVariant(variants);
  const [firstImage] = images;
  const price =
    (cheapest ? variantPrice(cheapest) : null) ??
    (listing.priceRangeMinAmount !== null && listing.priceRangeMinCurrency !== null
      ? { amount: listing.priceRangeMinAmount, currency: listing.priceRangeMinCurrency }
      : NO_PRICE);

  const summary: ProductSummary = {
    id: listing.id,
    title: listing.title,
    brand,
    imageUrl: firstImage ? resolveMedia(firstImage.fileId) : '',
    rating: listing.rating,
    reviewCount: listing.reviewCount,
    price,
  };
  const compareAt = cheapest ? variantCompareAtPrice(cheapest) : null;
  if (compareAt) {
    summary.compareAtPrice = compareAt;
  }
  return summary;
}

/** Options for hydrating listings. */
export interface HydrateOptions {
  /** When set, drives the `saved` flag from the viewer's favorites. */
  viewerId?: string;
  /** Reserved for future linked-client injection; defaults to the shared client. */
  oxyClient?: OxyServices;
  /**
   * Emit connector provenance (`Listing.source`) into the DTO. ADMIN paths only
   * (dashboard/POS): the store owner sees where a listing was synced from, while
   * public storefront reads keep this internal integration detail hidden.
   */
  includeSource?: boolean;
}

/**
 * Batch-load the set of listing ids the viewer has favorited (one query for the
 * whole batch — no per-listing lookups), delegating to `favorite.service`. With
 * no viewer or no ids this short-circuits to an empty set (`saved: false`).
 */
async function loadSavedSet(
  viewerId: string | undefined,
  listingIds: string[],
): Promise<Set<string>> {
  if (!viewerId || listingIds.length === 0) {
    return new Set();
  }
  try {
    return await getFavoritedListingIds(viewerId, listingIds);
  } catch (err) {
    log.general.warn({ err }, 'Failed to load viewer favorites (treating all as unsaved)');
    return new Set();
  }
}

/** Group variant rows by their listing id, preserving the query's position order. */
function groupVariants(variants: VariantRecord[]): Map<string, VariantRecord[]> {
  const byListing = new Map<string, VariantRecord[]>();
  for (const variant of variants) {
    const bucket = byListing.get(variant.listingId);
    if (bucket) bucket.push(variant);
    else byListing.set(variant.listingId, [variant]);
  }
  return byListing;
}

/**
 * Load every batch a page of listings needs, so a caller that already has the
 * children (the feed builds shelves from one query) does not pay for them twice.
 */
async function loadBatches(
  listingIds: string[],
): Promise<{
  variantsByListing: Map<string, VariantRecord[]>;
  optionValuesByVariant: Map<string, VariantOptionValueRecord[]>;
  children: ListingChildren;
}> {
  const [variants, children] = await Promise.all([
    findVariantsByListingIds(listingIds),
    findListingChildren(listingIds),
  ]);
  const optionValuesByVariant = await findVariantOptionValues(variants.map((v) => v.id));
  return { variantsByListing: groupVariants(variants), optionValuesByVariant, children };
}

/**
 * Hydrate raw listing rows into client-ready `Listing` DTOs with batched
 * Oxy/database lookups. Preserves input order.
 */
export async function hydrateListings(
  rawListings: ListingRecord[],
  opts: HydrateOptions = {},
): Promise<Listing[]> {
  if (rawListings.length === 0) {
    return [];
  }

  const listingIds = rawListings.map((l) => l.id);

  // 1-2. Every variant, option value, image, selectable option and collection
  // membership for the whole page.
  const { variantsByListing, optionValuesByVariant, children } = await loadBatches(listingIds);

  // 3. Split by ownerType; batch-load seller profiles and stores.
  const userOwnerIds = [
    ...new Set(
      rawListings.flatMap((l) => (l.ownerType === 'user' && l.oxyUserId ? [l.oxyUserId] : [])),
    ),
  ];
  const storeIds = [
    ...new Set(
      rawListings.flatMap((l) => (l.ownerType === 'store' && l.storeId ? [l.storeId] : [])),
    ),
  ];

  const [sellerProfileDocs, storeDocs] = await Promise.all([
    userOwnerIds.length > 0
      ? SellerProfile.find({ oxyUserId: { $in: userOwnerIds } }).lean<ISellerProfile[]>()
      : Promise.resolve([] as ISellerProfile[]),
    storeIds.length > 0 ? findStoresByIds(storeIds) : Promise.resolve([] as StoreRow[]),
  ]);

  const sellerProfileByUser = new Map<string, ISellerProfile>();
  for (const p of sellerProfileDocs) {
    sellerProfileByUser.set(String(p.oxyUserId), p);
  }
  const storeById = new Map(storeDocs.map((s) => [s.id, s]));

  // 4. Batch-load all owning users' Oxy profiles in one call.
  const oxyProfiles = await getProfiles(userOwnerIds);

  // 5. (optional) Batch-load the viewer's favorites.
  const savedSet = await loadSavedSet(opts.viewerId, listingIds);

  // For each store, the listings it owns within THIS batch (for thumbnails).
  const listingsByStore = new Map<string, ListingRecord[]>();
  for (const l of rawListings) {
    if (l.ownerType === 'store' && l.storeId) {
      const bucket = listingsByStore.get(l.storeId);
      if (bucket) bucket.push(l);
      else listingsByStore.set(l.storeId, [l]);
    }
  }

  // 6. Assemble each DTO.
  return rawListings.map((listing) => {
    const id = listing.id;
    const variants = variantsByListing.get(id) ?? [];
    const variantDTOs = variants.map((v) =>
      toVariantDTO(v, optionValuesByVariant.get(v.id) ?? []),
    );
    const cheapest = cheapestVariant(variants);

    const priceFallback: Money =
      listing.priceRangeMinAmount !== null && listing.priceRangeMinCurrency !== null
        ? { amount: listing.priceRangeMinAmount, currency: listing.priceRangeMinCurrency }
        : NO_PRICE;
    const price = (cheapest ? variantPrice(cheapest) : null) ?? priceFallback;
    const quantity = variants.reduce((sum, v) => sum + Math.max(0, v.inventoryAvailable), 0);

    const options: ListingOption[] = (children.options.get(id) ?? []).map((o) => ({
      name: o.name,
      values: [...o.values],
    }));

    const dto: Listing = {
      id,
      ownerType: listing.ownerType,
      title: listing.title,
      description: listing.description,
      price,
      variants: variantDTOs,
      condition: listing.condition,
      status: listing.status,
      category: listing.categorySlugs[listing.categorySlugs.length - 1] ?? '',
      images: toListingImages(children.images.get(id) ?? []),
      tags: [...listing.tags],
      quantity,
      saved: savedSet.has(id),
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    };

    if (options.length > 0) {
      dto.options = options;
    }
    const compareAt = cheapest ? variantCompareAtPrice(cheapest) : null;
    if (compareAt) {
      dto.compareAtPrice = compareAt;
    }

    // The range is derived from the PRICED variants only; a listing whose
    // variants are all unpriced falls back to its denormalized facet, which the
    // facet recompute leaves NULL in exactly that case.
    const pricedAmounts = variants.flatMap((v) => (v.priceAmount !== null ? [v.priceAmount] : []));
    if (pricedAmounts.length > 0) {
      const currency = (cheapest ?? variants[0]).priceCurrency ?? NO_PRICE.currency;
      dto.priceRange = {
        min: { amount: Math.min(...pricedAmounts), currency },
        max: { amount: Math.max(...pricedAmounts), currency },
      };
    } else if (
      listing.priceRangeMinAmount !== null &&
      listing.priceRangeMinCurrency !== null &&
      listing.priceRangeMaxAmount !== null &&
      listing.priceRangeMaxCurrency !== null
    ) {
      dto.priceRange = {
        min: { amount: listing.priceRangeMinAmount, currency: listing.priceRangeMinCurrency },
        max: { amount: listing.priceRangeMaxAmount, currency: listing.priceRangeMaxCurrency },
      };
    }

    if (listing.ownerType === 'user' && listing.oxyUserId) {
      const oxyUserId = listing.oxyUserId;
      dto.seller = toSeller(
        oxyUserId,
        sellerProfileByUser.get(oxyUserId),
        oxyProfiles.get(oxyUserId),
      );
    } else if (listing.ownerType === 'store' && listing.storeId) {
      const store = storeById.get(listing.storeId);
      if (store) {
        dto.store = toMerchantSummary(
          store,
          listingsByStore.get(listing.storeId) ?? [listing],
          children.images,
        );
      }
    }

    if (listing.vendor) {
      dto.vendor = listing.vendor;
    }
    if (listing.productType) {
      dto.productType = listing.productType;
    }
    if (listing.handle) {
      dto.handle = listing.handle;
    }
    if (listing.seoTitle || listing.seoDescription) {
      const seo: { title?: string; description?: string } = {};
      if (listing.seoTitle) seo.title = listing.seoTitle;
      if (listing.seoDescription) seo.description = listing.seoDescription;
      dto.seo = seo;
    }
    const collectionIds = children.collectionIds.get(id);
    if (collectionIds && collectionIds.length > 0) {
      dto.collectionIds = [...collectionIds];
    }
    if (opts.includeSource) {
      const source = toListingSource(listing);
      if (source) {
        dto.source = source;
      }
    }

    return dto;
  });
}
