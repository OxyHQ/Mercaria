/**
 * Catalog hydration service.
 *
 * Turns raw `IListing` documents into fully-hydrated `Listing` DTOs ready for
 * the client, doing ALL Oxy + DB lookups in BATCHES (no N+1):
 *   1. batch-load every listing's variants,
 *   2. batch-load seller profiles (user listings) and stores (store listings),
 *   3. batch-load every owning user's Oxy profile in one `getProfiles` call,
 *   4. (optional) batch-load the viewer's favorites to set `saved`,
 *   5. assemble each DTO with derived price fields + owner identity + media.
 *
 * Media resolution is funneled through ONE chokepoint (`resolveMedia`): absolute
 * URLs pass through unchanged (e.g. seeded Shopify CDN assets), everything else
 * is treated as an Oxy media file id and resolved via `getFileDownloadUrl` — the
 * only sanctioned media resolver.
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
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
import { SellerProfile, type ISellerProfile } from '../models/seller-profile.js';
import { Store, type IStore } from '../models/store.js';
import type { IListing, IListingSource } from '../models/listing.js';
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

/** Map a persisted `Money` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/** Map an internal variant doc to the wire `ProductVariantDTO` (never exposes `committed`). */
function toVariantDTO(variant: IProductVariant): ProductVariantDTO {
  const available = variant.inventory.available;
  const inStock = !variant.inventory.tracked || available > 0;
  const dto: ProductVariantDTO = {
    id: String((variant as { _id: mongoose.Types.ObjectId })._id),
    title: variant.title,
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: toMoney(variant.price),
    available,
    inStock,
  };
  if (variant.sku) {
    dto.sku = variant.sku;
  }
  if (variant.barcode) {
    dto.barcode = variant.barcode;
  }
  if (variant.compareAtPrice) {
    dto.compareAtPrice = toMoney(variant.compareAtPrice);
  }
  return dto;
}

/** Pick the variant with the lowest price (stable on ties by array order). */
function cheapestVariant(variants: IProductVariant[]): IProductVariant | undefined {
  return variants.reduce<IProductVariant | undefined>((min, v) => {
    if (!min || v.price.amount < min.price.amount) {
      return v;
    }
    return min;
  }, undefined);
}

/** Map listing images through the media chokepoint into `ListingImage` DTOs. */
function toListingImages(images: IListing['images']): ListingImage[] {
  return [...images]
    .sort((a, b) => a.position - b.position)
    .map((img) => {
      const dto: ListingImage = { fileId: resolveMedia(img.fileId), position: img.position };
      if (img.alt) {
        dto.alt = img.alt;
      }
      return dto;
    });
}

/**
 * Map a persisted connector-provenance sub-document to the `ListingSource` DTO.
 * Only emitted on the ADMIN hydration path (see `HydrateOptions.includeSource`):
 * `connectionId`/`externalId` are internal integration plumbing meant for the
 * store owner, not anonymous storefront buyers.
 */
function toListingSource(source: IListingSource): ListingSource {
  const dto: ListingSource = {
    connectionId: source.connectionId,
    provider: source.provider,
    externalId: source.externalId,
  };
  if (source.externalUpdatedAt) {
    dto.externalUpdatedAt = source.externalUpdatedAt.toISOString();
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
 */
export function toMerchantSummary(
  store: IStore,
  featuredListings: IListing[],
): MerchantSummary {
  const id = String((store as { _id: mongoose.Types.ObjectId })._id);
  const products: ProductThumbnail[] = featuredListings
    .slice(0, config.feed.storeCardThumbnails)
    .map((listing) => {
      const firstImage = [...listing.images].sort((a, b) => a.position - b.position)[0];
      return {
        id: String((listing as { _id: mongoose.Types.ObjectId })._id),
        title: listing.title,
        imageUrl: firstImage ? resolveMedia(firstImage.fileId, 'thumb') : '',
      };
    });

  const summary: MerchantSummary = {
    id,
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
  listing: IListing,
  variants: IProductVariant[],
  brand: string,
): ProductSummary {
  const cheapest = cheapestVariant(variants);
  const firstImage = [...listing.images].sort((a, b) => a.position - b.position)[0];
  const price = cheapest
    ? toMoney(cheapest.price)
    : listing.priceRange?.min
      ? toMoney(listing.priceRange.min)
      : { amount: 0, currency: 'FAIR' as Money['currency'] };

  const summary: ProductSummary = {
    id: String((listing as { _id: mongoose.Types.ObjectId })._id),
    title: listing.title,
    brand,
    imageUrl: firstImage ? resolveMedia(firstImage.fileId) : '',
    rating: listing.rating,
    reviewCount: listing.reviewCount,
    price,
  };
  if (cheapest?.compareAtPrice) {
    summary.compareAtPrice = toMoney(cheapest.compareAtPrice);
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
async function loadSavedSet(viewerId: string | undefined, listingIds: string[]): Promise<Set<string>> {
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

/**
 * Hydrate raw listing docs into client-ready `Listing` DTOs with batched Oxy/DB
 * lookups. Preserves input order.
 */
export async function hydrateListings(
  rawListings: IListing[],
  opts: HydrateOptions = {},
): Promise<Listing[]> {
  if (rawListings.length === 0) {
    return [];
  }

  const listingIds = rawListings.map((l) => String((l as { _id: mongoose.Types.ObjectId })._id));

  // 1. Batch-load every variant for every listing, grouped by listingId.
  const variantDocs = await ProductVariant.find({ listingId: { $in: listingIds } })
    .sort({ listingId: 1, position: 1 })
    .lean<IProductVariant[]>();
  const variantsByListing = new Map<string, IProductVariant[]>();
  for (const v of variantDocs) {
    const key = String(v.listingId);
    const bucket = variantsByListing.get(key);
    if (bucket) {
      bucket.push(v);
    } else {
      variantsByListing.set(key, [v]);
    }
  }

  // 2. Split by ownerType; batch-load seller profiles and stores.
  const userOwnerIds = [
    ...new Set(rawListings.filter((l) => l.ownerType === 'user' && l.oxyUserId).map((l) => String(l.oxyUserId))),
  ];
  const storeIds = [
    ...new Set(rawListings.filter((l) => l.ownerType === 'store' && l.storeId).map((l) => String(l.storeId))),
  ];

  const [sellerProfileDocs, storeDocs] = await Promise.all([
    userOwnerIds.length > 0
      ? SellerProfile.find({ oxyUserId: { $in: userOwnerIds } }).lean<ISellerProfile[]>()
      : Promise.resolve([] as ISellerProfile[]),
    storeIds.length > 0
      ? Store.find({ _id: { $in: storeIds } }).lean<IStore[]>()
      : Promise.resolve([] as IStore[]),
  ]);

  const sellerProfileByUser = new Map<string, ISellerProfile>();
  for (const p of sellerProfileDocs) {
    sellerProfileByUser.set(String(p.oxyUserId), p);
  }
  const storeById = new Map<string, IStore>();
  for (const s of storeDocs) {
    storeById.set(String((s as { _id: mongoose.Types.ObjectId })._id), s);
  }

  // 3. Batch-load all owning users' Oxy profiles in one call.
  const oxyProfiles = await getProfiles(userOwnerIds);

  // 4. (optional) Batch-load the viewer's favorites.
  const savedSet = await loadSavedSet(opts.viewerId, listingIds);

  // For each store, the listings it owns within THIS batch (for thumbnails).
  const listingsByStore = new Map<string, IListing[]>();
  for (const l of rawListings) {
    if (l.ownerType === 'store' && l.storeId) {
      const key = String(l.storeId);
      const bucket = listingsByStore.get(key);
      if (bucket) {
        bucket.push(l);
      } else {
        listingsByStore.set(key, [l]);
      }
    }
  }

  // 5. Assemble each DTO.
  return rawListings.map((listing) => {
    const id = String((listing as { _id: mongoose.Types.ObjectId })._id);
    const variants = variantsByListing.get(id) ?? [];
    const variantDTOs = variants.map(toVariantDTO);
    const cheapest = cheapestVariant(variants);

    const priceFallback: Money = listing.priceRange?.min
      ? toMoney(listing.priceRange.min)
      : { amount: 0, currency: 'FAIR' };
    const price = cheapest ? toMoney(cheapest.price) : priceFallback;
    const quantity = variants.reduce((sum, v) => sum + Math.max(0, v.inventory.available), 0);

    const options: ListingOption[] = listing.options.map((o) => ({ name: o.name, values: [...o.values] }));

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
      images: toListingImages(listing.images),
      tags: [...listing.tags],
      quantity,
      saved: savedSet.has(id),
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    };

    if (options.length > 0) {
      dto.options = options;
    }
    if (cheapest?.compareAtPrice) {
      dto.compareAtPrice = toMoney(cheapest.compareAtPrice);
    }
    if (variants.length > 0) {
      const amounts = variants.map((v) => v.price.amount);
      const currency = (cheapest ?? variants[0]).price.currency as Money['currency'];
      dto.priceRange = {
        min: { amount: Math.min(...amounts), currency },
        max: { amount: Math.max(...amounts), currency },
      };
    } else if (listing.priceRange?.min && listing.priceRange?.max) {
      dto.priceRange = { min: toMoney(listing.priceRange.min), max: toMoney(listing.priceRange.max) };
    }

    if (listing.ownerType === 'user' && listing.oxyUserId) {
      const oxyUserId = String(listing.oxyUserId);
      dto.seller = toSeller(oxyUserId, sellerProfileByUser.get(oxyUserId), oxyProfiles.get(oxyUserId));
    } else if (listing.ownerType === 'store' && listing.storeId) {
      const store = storeById.get(String(listing.storeId));
      if (store) {
        dto.store = toMerchantSummary(store, listingsByStore.get(String(listing.storeId)) ?? [listing]);
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
    if (listing.seo && (listing.seo.title || listing.seo.description)) {
      const seo: { title?: string; description?: string } = {};
      if (listing.seo.title) seo.title = listing.seo.title;
      if (listing.seo.description) seo.description = listing.seo.description;
      dto.seo = seo;
    }
    if (listing.collectionIds && listing.collectionIds.length > 0) {
      dto.collectionIds = [...listing.collectionIds];
    }
    if (opts.includeSource && listing.source) {
      dto.source = toListingSource(listing.source);
    }

    return dto;
  });
}
