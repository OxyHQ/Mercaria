/**
 * The canonical product page read (#71) — identity, configurations, every
 * eligible way to acquire the thing, and the verified channels behind it, from
 * ONE read at ONE instant.
 *
 * ## This composes; it does not decide
 *
 * Identity comes from #56, the order and the labels from #74's published entry
 * point, an offer's terms from #57, freshness from #68, condition from #90 and
 * the badges from #55. Nothing here re-ranks, re-derives an eligibility verdict
 * or re-reads a fact another domain already answered — `product-page-isolation.test.ts`
 * fails the build if it starts to.
 *
 * ## Why the composition is server-side at all
 *
 * A client could fetch the ranked ids from `/offer-comparison` and the offer
 * rows from `/offers` and join them. It would be joining two different moments,
 * and the failure is silent: `/offers` is a keyset page in a different order, so
 * a ranked offer outside its window has no row and simply does not render. The
 * shopper then sees a comparison with holes in it and nothing anywhere says so.
 * `rankOfferComparison` already returns both halves; serving them together is
 * the only place the join cannot be wrong.
 *
 * ## The two levers are read INDEPENDENTLY
 *
 * `CANONICAL_READS` decides whether this page answers at all (the controller
 * checks it, so `shadow` can still compute). `CANONICAL_OFFER_COMPARISON`
 * decides whether the OFFERS half answers, and the withheld branch is why
 * turning price comparison off during an incident does not take product
 * identity down with it (#60 feature flags 2 and 3) and does not make a product
 * read as one nobody sells.
 */

import type {
  CanonicalProductPage,
  CurrencyCode,
  Offer,
  OfferComparisonExperience,
  OfferComparisonIntent,
  ProductPageBrandChannel,
  ProductPageOfferRow,
  ProductPageOffers,
  ProductPageVariant,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { validationError } from '../../lib/errors/error-codes.js';
import {
  getPublicCanonicalProduct,
  getVariantOptionAssignments,
} from '../canonical/canonical-product.service.js';
import { listVariants } from '../canonical/canonical-variant.service.js';
import { listBrandChannels } from '../commerce-graph/relationship-resolution.js';
import { findProductPageMerchants } from '../../db/productPage/productPageRepository.js';
import { findStorefrontsByIds } from '../../db/commerce-graph/storefrontRepository.js';
import { rankOfferComparison } from '../ranking/comparison.service.js';
import { assignOfferGroups, collectHighlights, type GroupableOffer } from './groups.js';
import { resolveProductPageOutbound } from './outbound.js';
import { resolveOfferSellers } from './sellers.js';

/** What a caller asks a product page for. */
export interface ProductPageRequest {
  /** The product's id or its slug. A merged tombstone's handle resolves to the winner. */
  readonly handle: string;
  /** Narrow the offers to ONE configuration (#71 acceptance 4). */
  readonly canonicalVariantId?: string;
  /** ISO 3166-1 alpha-2. Absent = unrestricted, which is today's behaviour. */
  readonly market?: string;
  /** The one currency this page's comparison is expressed in. */
  readonly comparisonCurrency: CurrencyCode;
  readonly intent?: OfferComparisonIntent;
  readonly experience?: OfferComparisonExperience;
  readonly limit: number;
  /**
   * Whether the offers half may be served at all.
   *
   * Passed IN rather than read here, because the lever is a rollout decision
   * the controller resolves along with the cohort — and a service that read
   * `config` directly would be a second place the rollout is decided.
   */
  readonly offerComparisonPermitted: boolean;
}

/** The page, plus the offers behind it for a caller that needs the DTOs. */
export interface ProductPageResult {
  readonly page: CanonicalProductPage;
  /**
   * Every SERVED offer, by id — what the controller emits impressions from.
   *
   * Returned beside the page rather than re-read from it, the
   * `rankOfferComparison` shape: an analytics emitter needs the offer's
   * merchant and storefront ids, and digging them back out of the assembled
   * rows would be a second traversal that can disagree with the first.
   */
  readonly servedOffers: ReadonlyMap<string, Offer>;
}

/**
 * Read one canonical product page.
 *
 * Returns `undefined` when no product resolves — the caller answers 404. A
 * product that exists but has no eligible offer is NOT this case: it is a page
 * with an empty row list, which is #71 requirement 5 ("render a useful product
 * page even when no current offer is eligible").
 */
export async function readCanonicalProductPage(
  request: ProductPageRequest,
): Promise<ProductPageResult | undefined> {
  const product = await getPublicCanonicalProduct(request.handle);
  if (!product) return undefined;

  const variants = await readPageVariants(product.id);

  /**
   * A configuration that is not this product's is REFUSED, never ignored.
   *
   * Ignoring it would silently widen the page to the whole product, which is
   * #71 acceptance 4 failing in the one direction nobody notices: the shopper
   * asked about one configuration and is shown another's price.
   */
  if (request.canonicalVariantId !== undefined) {
    const known = variants.some((variant) => variant.id === request.canonicalVariantId);
    if (!known) throw validationError('That configuration does not belong to this product');
  }

  const { offers, servedOffers } = await readOffers(request, product.id, variants);

  const page: CanonicalProductPage = {
    product,
    ...(product.id === request.handle || product.slug === request.handle
      ? {}
      : {
          redirect: {
            requestedHandle: request.handle,
            canonicalHandle: product.slug,
            canonicalProductId: product.id,
          },
        }),
    variants: withOfferCounts(variants, servedOffers),
    ...(request.canonicalVariantId === undefined
      ? {}
      : { selectedVariantId: request.canonicalVariantId }),
    ...(request.market === undefined ? {} : { market: request.market.toUpperCase() }),
    offers,
    ...(await readBrandChannels(product.brandId, request.market)),
  };

  return { page, servedOffers };
}

/**
 * The configurations, projected for the selector.
 *
 * Merge tombstones are excluded — the same rule
 * `GET /canonical-products/:idOrSlug/variants` follows, and for its reason: a
 * merged configuration is still resolvable by id for an old link and must not
 * appear twice in a picker.
 */
async function readPageVariants(
  productId: string,
): Promise<{ id: string; name?: string; isDefault: boolean; options: ProductPageVariant['options'] }[]> {
  const rows = await listVariants(productId);
  const projected: {
    id: string;
    name?: string;
    isDefault: boolean;
    options: ProductPageVariant['options'];
  }[] = [];
  for (const variant of rows) {
    if (variant.status === 'merged') continue;
    projected.push({
      id: variant.id,
      ...(variant.name === undefined || variant.name === null ? {} : { name: variant.name }),
      isDefault: variant.isDefault,
      options: await getVariantOptionAssignments(variant.id),
    });
  }
  return projected;
}

/**
 * How many SERVED offers price each configuration.
 *
 * Counted from the rows this page is actually showing, so the number beside a
 * configuration means "offers on this page" and can never claim inventory the
 * comparison did not admit. On a variant-scoped page every other configuration
 * counts zero, which is correct rather than misleading: the page IS scoped, and
 * the selector says so.
 */
function withOfferCounts(
  variants: readonly {
    id: string;
    name?: string;
    isDefault: boolean;
    options: ProductPageVariant['options'];
  }[],
  servedOffers: ReadonlyMap<string, Offer>,
): readonly ProductPageVariant[] {
  const counts = new Map<string, number>();
  for (const offer of servedOffers.values()) {
    counts.set(offer.canonicalVariantId, (counts.get(offer.canonicalVariantId) ?? 0) + 1);
  }
  return variants.map((variant) => ({ ...variant, offerCount: counts.get(variant.id) ?? 0 }));
}

/** The offers half, or the honest statement that it is not being served. */
async function readOffers(
  request: ProductPageRequest,
  productId: string,
  variants: readonly { id: string; name?: string }[],
): Promise<{ offers: ProductPageOffers; servedOffers: ReadonlyMap<string, Offer> }> {
  if (!request.offerComparisonPermitted) {
    return {
      offers: { available: false, reason: 'comparison_withheld' },
      servedOffers: new Map(),
    };
  }

  const { comparison, offers } = await rankOfferComparison({
    ...(request.canonicalVariantId === undefined
      ? { canonicalProductId: productId }
      : { canonicalVariantId: request.canonicalVariantId }),
    comparisonCurrency: request.comparisonCurrency,
    ...(request.intent === undefined ? {} : { intent: request.intent }),
    ...(request.experience === undefined ? {} : { experience: request.experience }),
    ...(request.market === undefined ? {} : { market: request.market }),
    limit: request.limit,
  });

  // The SERVED set, in ranked order. `offers` also holds what eligibility
  // refused — that is what `excluded` is about — and a row is built only for
  // what the comparison actually ordered.
  const served: Offer[] = [];
  for (const ranked of comparison.offers) {
    const offer = offers.get(ranked.offerId);
    if (offer === undefined) continue;
    served.push(offer);
  }

  const sellers = await resolveOfferSellers(served, getDb());
  const variantNames = new Map(variants.map((variant) => [variant.id, variant.name]));

  const rows: ProductPageOfferRow[] = [];
  const groupable: GroupableOffer[] = [];
  for (const ranked of comparison.offers) {
    const offer = offers.get(ranked.offerId);
    if (offer === undefined) continue;
    const variantName =
      request.canonicalVariantId === undefined
        ? variantNames.get(offer.canonicalVariantId)
        : undefined;
    rows.push({
      offer,
      ranked,
      seller: sellers.get(offer.id) ?? { kind: 'unknown' },
      outbound: resolveProductPageOutbound(offer),
      ...(variantName === undefined ? {} : { variantName }),
    });
    groupable.push({
      offerId: offer.id,
      ...(offer.condition.group === undefined ? {} : { conditionGroup: offer.condition.group }),
      labels: ranked.labels,
    });
  }

  return {
    offers: {
      available: true,
      policy: comparison.policy,
      intent: comparison.intent,
      experience: comparison.experience,
      comparisonCurrency: comparison.comparisonCurrency,
      rates: comparison.rates,
      rows,
      groups: assignOfferGroups(groupable),
      highlights: collectHighlights(groupable),
      excludedCount: comparison.excluded.length,
    },
    servedOffers: new Map(served.map((offer) => [offer.id, offer])),
  };
}

/**
 * The brand's verified channels, in the two separate lists #55 keeps them in.
 *
 * A product with no brand has neither, and that is not a missing record: most
 * of the catalogue holds no relationship row at all (ADR 0002 D10), and an
 * ordinary retailer appearing in neither list is the normal state rather than a
 * gap in the data.
 *
 * The merchant and storefront NAMES are resolved here because a list of ids is
 * not a link a shopper can follow — #71 relationships 6 — and the resolution is
 * batched over both lists at once.
 */
async function readBrandChannels(
  brandId: string | undefined,
  market: string | undefined,
): Promise<{
  officialChannels: readonly ProductPageBrandChannel[];
  authorizedResellers: readonly ProductPageBrandChannel[];
}> {
  if (brandId === undefined) return { officialChannels: [], authorizedResellers: [] };

  const directory = await listBrandChannels({
    brandId,
    ...(market === undefined ? {} : { market }),
  });
  const rows = [...directory.officialChannels, ...directory.authorizedResellers];
  if (rows.length === 0) return { officialChannels: [], authorizedResellers: [] };

  const db = getDb();
  const [merchantRows, storefrontRows] = await Promise.all([
    findProductPageMerchants(db, [...new Set(rows.map((row) => row.subjectId))]),
    findStorefrontsByIds(
      db,
      [...new Set(rows.map((row) => row.storefrontId).filter((id): id is string => !!id))],
    ),
  ]);
  const merchantsById = new Map(merchantRows.map((row) => [row.id, row]));
  const storefrontsById = new Map(storefrontRows.map((row) => [row.id, row]));

  const project = (
    relationships: readonly (typeof rows)[number][],
  ): ProductPageBrandChannel[] => {
    const channels: ProductPageBrandChannel[] = [];
    for (const relationship of relationships) {
      const merchant = merchantsById.get(relationship.subjectId);
      // A relationship whose merchant this read could not resolve produces NO
      // entry. An unnamed badge is a claim with nobody behind it, which is the
      // one thing #55's whole evidence model exists to prevent.
      if (merchant === undefined) continue;
      const storefront =
        relationship.storefrontId === null
          ? undefined
          : storefrontsById.get(relationship.storefrontId);
      channels.push({
        merchantId: merchant.id,
        merchantName: merchant.name,
        merchantSlug: merchant.slug,
        ...(storefront === undefined
          ? {}
          : {
              storefrontId: storefront.id,
              storefrontName: storefront.name,
              storefrontSlug: storefront.slug,
            }),
        ...(relationship.validTo === null ? {} : { validTo: relationship.validTo }),
      });
    }
    return channels;
  };

  return {
    officialChannels: project(directory.officialChannels),
    authorizedResellers: project(directory.authorizedResellers),
  };
}
