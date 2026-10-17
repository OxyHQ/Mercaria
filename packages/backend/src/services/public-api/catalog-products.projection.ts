/**
 * The PUBLIC projection of the comparison catalogue (`/public/v1/catalog/*`) —
 * how the canonical search result and the canonical product page become the
 * shapes `@mercaria/contracts`' `catalog-products.ts` publishes.
 *
 * `projection.ts`'s rules hold here unchanged: field by field and never a
 * spread, every function pure (no database, no config, no clock), and media
 * resolved through the injected `resolveMedia`.
 *
 * ## It composes the product page; it decides nothing
 *
 * The detail read is `readCanonicalProductPage` — the page a shopper sees,
 * ranked by the versioned comparison, with the outbound decision, the seller
 * and the open-data attribution already made. This module COPIES those
 * decisions: the row order is the comparison's, the action is the row's
 * `outbound`, the attribution is the row's `source`. Re-deriving any of them
 * here would be a second answer that can drift from mercaria.co.
 *
 * ## What it declines to publish
 *
 * Offer provenance, the destination URL itself (only the redirect path and its
 * host), affiliate routing, seller SKUs and merchant titles, freshness
 * internals, the ranking trace and its labels, and the count of excluded
 * offers — the last is a seller's question, answered on the seller's surface.
 */

import {
  ALL_CURRENCY_CODES,
  CONDITION_KEY_GROUP,
  type CanonicalImage,
  type CanonicalProductPage,
  type CurrencyCode,
  type OfferFreshnessAssessment,
  type OfferMoney,
  type ProductPageOfferRow,
  type ProductPageOutbound,
  type ProductPageSeller,
  type SearchProductResult,
} from '@mercaria/shared-types';
import type {
  MercariaCatalogProduct,
  MercariaCatalogProductSummary,
  MercariaCatalogVariant,
  MercariaImage,
  MercariaMoney,
  MercariaOffer,
  MercariaOfferAction,
  MercariaOfferSeller,
  MercariaProductCondition,
} from '@mercaria/contracts';
import type { MediaResolver } from './projection.js';
import { catalogProductWebUrl, productWebUrl } from './urls.js';

const MODELLED_CURRENCIES: ReadonlySet<string> = new Set(ALL_CURRENCY_CODES);

/**
 * An offer's price as a contract money, or `null` when it cannot be stated.
 *
 * An offer's currency is shape-checked, not enumerated (a source may publish
 * one Mercaria does not model). A consumer formats a `MercariaMoney` by its
 * currency's precision, so a code nobody can format is `null`, never a number.
 */
export function offerMoney(value: OfferMoney | undefined): MercariaMoney | null {
  if (value === undefined || !MODELLED_CURRENCIES.has(value.currency)) return null;
  return { amount: value.amount, currency: value.currency as CurrencyCode };
}

function nonBlank(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function canonicalImage(entry: CanonicalImage, resolveMedia: MediaResolver): MercariaImage | null {
  // Only a copy Mercaria holds: a source URL is an import input and never leaves.
  const url = entry.fileId === undefined ? undefined : resolveMedia(entry.fileId);
  return url ? { url, alt: nonBlank(entry.alt) } : null;
}

/** One search result as a catalog card. */
export function projectCatalogProductSummary(
  result: SearchProductResult,
  resolveMedia: MediaResolver,
  webOrigin: string,
): MercariaCatalogProductSummary {
  const fileId = result.image?.fileId;
  const url = fileId === undefined ? undefined : resolveMedia(fileId);
  const summary = result.offerSummary;
  return {
    ref: { kind: 'catalog_product', id: result.canonicalProductId },
    name: result.name,
    image: url ? { url, alt: nonBlank(result.image?.alt) } : null,
    url: catalogProductWebUrl(webOrigin, result.slug),
    offers:
      summary === undefined
        ? null
        : {
            count: summary.currentOfferCount,
            availability: summary.availability,
            lowestPrice: offerMoney(summary.lowestPrice),
          },
  };
}

function offerSeller(seller: ProductPageSeller): MercariaOfferSeller {
  switch (seller.kind) {
    case 'merchant':
      return { kind: 'merchant', name: seller.name, domain: seller.storefront?.domain ?? null };
    case 'native_store':
      return {
        kind: 'store',
        store: { kind: 'store', id: seller.storeId },
        handle: seller.handle,
        name: seller.name,
      };
    case 'native_person':
      return { kind: 'person', oxyUserId: seller.oxyUserId, displayName: seller.displayName };
    default:
      return { kind: 'unknown' };
  }
}

function offerAction(outbound: ProductPageOutbound, webOrigin: string): MercariaOfferAction {
  switch (outbound.kind) {
    case 'native_checkout':
      return {
        kind: 'mercaria_checkout',
        purchaseOption: {
          kind: 'variant',
          productId: outbound.listingId,
          variantId: outbound.productVariantId,
        },
        url: productWebUrl(webOrigin, outbound.listingId),
      };
    case 'outbound':
      return {
        kind: 'outbound',
        path: outbound.redirectPath,
        destinationHost: outbound.destinationHost,
        rel: outbound.rel,
      };
    default:
      return { kind: 'none', destinationHost: outbound.destinationHost ?? null };
  }
}

function offerCondition(row: ProductPageOfferRow): MercariaProductCondition | null {
  const key = row.offer.condition.key;
  if (key === 'unknown') return null;
  return { key, group: CONDITION_KEY_GROUP[key] };
}

function observedAt(freshness: OfferFreshnessAssessment): string | null {
  return 'observedAt' in freshness && typeof freshness.observedAt === 'string'
    ? freshness.observedAt
    : null;
}

/** One ranked row of the product page as a contract offer. */
export function projectOffer(row: ProductPageOfferRow, webOrigin: string): MercariaOffer {
  return {
    id: row.offer.id,
    kind: row.offer.kind,
    variantId: row.offer.canonicalVariantId,
    seller: offerSeller(row.seller),
    price: offerMoney(row.offer.price),
    availability: row.offer.availability,
    condition: offerCondition(row),
    observedAt: observedAt(row.offer.freshness),
    action: offerAction(row.outbound, webOrigin),
    source:
      row.source === undefined
        ? null
        : {
            name: row.source.name,
            homepage: row.source.homepage,
            licenceLabel: row.source.licenceLabel,
          },
  };
}

/**
 * The product page as a catalog product.
 *
 * `gtinsByVariant` holds each served configuration's active, public GTINs.
 * An offer whose configuration is not among the page's variants (a suppressed
 * one) is dropped rather than published against a variant the consumer cannot
 * see — the contract refuses that pairing, and so does the page's own picker.
 */
export function projectCatalogProduct(
  page: CanonicalProductPage,
  gtinsByVariant: ReadonlyMap<string, readonly string[]>,
  resolveMedia: MediaResolver,
  webOrigin: string,
): MercariaCatalogProduct {
  const product = page.product;
  const images = [...product.images]
    .sort((left, right) => left.position - right.position)
    .map((entry) => canonicalImage(entry, resolveMedia))
    .filter((entry): entry is MercariaImage => entry !== null);
  const variants: MercariaCatalogVariant[] = page.variants.map((variant) => ({
    id: variant.id,
    name: nonBlank(variant.name),
    gtins: [...(gtinsByVariant.get(variant.id) ?? [])],
  }));
  const variantIds = new Set(variants.map((variant) => variant.id));
  return {
    ref: { kind: 'catalog_product', id: product.id },
    name: product.name,
    image: images[0] ?? null,
    url: catalogProductWebUrl(webOrigin, product.slug),
    description: nonBlank(product.description),
    images,
    variants,
    offers:
      page.offers.available === true
        ? page.offers.rows
            .filter((row) => variantIds.has(row.offer.canonicalVariantId))
            .map((row) => projectOffer(row, webOrigin))
        : null,
  };
}
